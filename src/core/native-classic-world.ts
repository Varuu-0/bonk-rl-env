/**
 * Unified native Classic discs and dynamic-map physics.
 *
 * Every live disc and map body is constructed in the single NativeWorld world.
 * Capture contacts, force/movement controls, one shared Step, capture progress,
 * extraction, OOB and death/respawn handling retain the original native order.
 * Match lifecycle, spawn dealing, scoring and presentation are intentionally
 * outside this renderer-free physics boundary.
 */
import {
  createNativeWorld,
  type NativeWorld,
  type NativeWorldBuildContext,
  type NativeWorldStepOptions,
} from './native-world';
import type { NativeMapPhysics, NativeSlot } from './native-map-state';
import type { PhysicsDisc } from './classic-physics';
import { safeCos, safeSin } from './safe-trig';

export interface NativeClassicCapZone {
  ty: number;
  p: number;
  l: number;
  i: number;
  o: number;
  ot: number;
  f: number;
}

export interface NativeClassicAuthoredCapZone {
  ty: number;
  /** Authored capture seconds; normalized state stores ticks (l * 30). */
  l: number;
  i: number;
  n?: string;
}

export interface NativeClassicFrame {
  /** Previously returned live cap state. Mutually exclusive with authoredCapZones. */
  capZones?: readonly NativeClassicCapZone[];
  /** Initial map cap definitions; invalid fixture references and duplicate i are skipped natively. */
  authoredCapZones?: readonly NativeClassicAuthoredCapZone[];
  /** Classic has no projectiles. A present nonempty table is rejected, never ignored. */
  projectiles?: readonly never[];
}

export interface NativeClassicWorldOptions extends NativeWorldStepOptions {
  fly?: boolean;
  noCollision?: boolean;
  balances?: readonly number[];
  teams?: readonly number[];
  /** Native gameSettings.tea: team contact filtering and team capture scoring. */
  teamCollision?: boolean;
  mode?: 'b' | 'sp' | 'bs';
  respawn?: boolean;
  /** Native non-testing radial OOB gate (the original bal == false branch). */
  radialBounds?: boolean;
  /** Native players known at round entry, including already eliminated IDs.
   * Survivors may retain a recent-contact reference to an eliminated player. */
  knownPlayerIds?: readonly number[];
}

export interface NativeClassicContact {
  readonly zone: number;
  readonly fixtureId: number;
  readonly disc: number;
}

export interface NativeClassicTeamGoal {
  readonly zone: number;
  readonly team: number;
}

export type NativeClassicDeathCause = 'lethal-contact' | 'out-of-world' | 'capture';

export interface NativeClassicDeath {
  readonly id: number;
  readonly cause: NativeClassicDeathCause;
  /** Raw pre-respawn body state, before presentation clamping. */
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
}

export interface NativeClassicWorldResult {
  readonly physics: NativeMapPhysics;
  /** A hole keeps its index; an explicitly dead entry is returned as undefined like native. */
  readonly discs: (PhysicsDisc | undefined)[];
  readonly capZones: NativeClassicCapZone[];
  readonly capZoneContacts: readonly NativeClassicContact[];
  readonly capZoneTeamGoals: readonly NativeClassicTeamGoal[];
  readonly hits: readonly { readonly player: number; readonly other: number }[];
  readonly deaths: readonly NativeClassicDeath[];
}

export interface NativeClassicWorld {
  step(
    physics: NativeMapPhysics,
    discs: readonly (PhysicsDisc | undefined)[],
    inputs: Readonly<Record<number, number>>,
    options?: NativeClassicWorldOptions,
    frame?: NativeClassicFrame,
  ): NativeClassicWorldResult;
  dispose(): void;
}

const DISC_FIELDS = new Set([
  'id',
  'x',
  'y',
  'xv',
  'yv',
  'angle',
  'angularVelocity',
  'radius',
  'energy',
  'heavy',
  'alive',
  'lhid',
  'lht',
  'sx',
  'sy',
  'sxv',
  'syv',
  'ni',
  'ds',
  'da',
  'vt',
  'swing',
]);
const OPTION_FIELDS = new Set([
  'simulate',
  'quality',
  'deltaMs',
  'stepScale',
  'fly',
  'noCollision',
  'balances',
  'teams',
  'teamCollision',
  'mode',
  'respawn',
  'radialBounds',
  'knownPlayerIds',
]);
const CANONICAL_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const INPUT_SECONDARY = 32;

function invalid(reason: string): never {
  throw new Error(`Invalid native Classic world input: ${reason}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${label} must not contain symbol fields`);
  return value as Record<string, unknown>;
}

function own(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) invalid(`${label}.${key} must be an own data property`);
  return descriptor.value;
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fields(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) invalid(`${label} has unsupported field ${String(key)}`);
  }
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) invalid(`${label} must be nonnegative`);
  return result;
}

function optionalNumber(raw: Record<string, unknown>, key: string, fallback: number, label: string): number {
  return has(raw, key) ? finite(own(raw, key, label), `${label}.${key}`) : fallback;
}

function readDiscs(value: unknown, knownPlayerIds: readonly number[] = []): (RuntimeDisc | undefined)[] {
  if (!Array.isArray(value)) invalid('discs must be an array');
  const seen = new Set<number>();
  const discs: (RuntimeDisc | undefined)[] = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const entryDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (entryDescriptor === undefined) continue;
    if (!('value' in entryDescriptor)) invalid(`discs[${index}] must be an own data property`);
    const entry = entryDescriptor.value;
    if (entry === undefined || entry === null) continue;
    const label = `discs[${index}]`;
    const raw = record(entry, label);
    fields(raw, DISC_FIELDS, label);
    const id = nonNegativeInteger(own(raw, 'id', label), `${label}.id`);
    if (id !== index) invalid(`${label}.id must equal its native sparse disc-table index ${index}`);
    if (seen.has(id)) invalid(`duplicate disc id ${id}`);
    seen.add(id);
    const radius = finite(own(raw, 'radius', label), `${label}.radius`);
    if (radius <= 0) invalid(`${label}.radius must be positive`);
    const alive = boolean(own(raw, 'alive', label), `${label}.alive`);
    if (!alive) invalid(`${label}.alive=false must be represented by an omitted native disc-table entry`);
    const lht = integer(own(raw, 'lht', label), `${label}.lht`);
    if (lht < 0 || lht > 120) invalid(`${label}.lht must be in [0, 120]`);
    const ds = has(raw, 'ds') ? integer(own(raw, 'ds', label), `${label}.ds`) : 0;
    const da = optionalNumber(raw, 'da', 270, label);
    const vt = has(raw, 'vt') ? integer(own(raw, 'vt', label), `${label}.vt`) : 0;
    if (ds < 0 || ds > 100 || da < 0 || da >= 360 || vt < 0 || vt > 6)
      invalid(`${label} has invalid native mode state`);
    if (ds !== 0 || vt !== 0) invalid(`${label} has non-Classic draw/VTOL state`);
    const rawSwing = has(raw, 'swing') ? own(raw, 'swing', label) : undefined;
    let swing: { b: number; p: [number, number]; l: number } | undefined;
    if (rawSwing !== undefined) {
      const swingRecord = record(rawSwing, `${label}.swing`);
      fields(swingRecord, new Set(['b', 'p', 'l']), `${label}.swing`);
      const swingB = nonNegativeInteger(own(swingRecord, 'b', `${label}.swing`), `${label}.swing.b`);
      const swingP = own(swingRecord, 'p', `${label}.swing`);
      if (!Array.isArray(swingP) || swingP.length !== 2) invalid(`${label}.swing.p must contain two numbers`);
      const swingL = finite(own(swingRecord, 'l', `${label}.swing`), `${label}.swing.l`);
      if (swingL < 0) invalid(`${label}.swing.l must be nonnegative`);
      swing = {
        b: swingB,
        p: [finite(swingP[0], `${label}.swing.p[0]`), finite(swingP[1], `${label}.swing.p[1]`)],
        l: swingL,
      };
    }
    const x = finite(own(raw, 'x', label), `${label}.x`);
    const y = finite(own(raw, 'y', label), `${label}.y`);
    const xv = finite(own(raw, 'xv', label), `${label}.xv`);
    const yv = finite(own(raw, 'yv', label), `${label}.yv`);
    const ni = has(raw, 'ni') ? boolean(own(raw, 'ni', label), `${label}.ni`) : false;
    discs[index] = {
      id,
      x,
      y,
      xv,
      yv,
      angle: finite(own(raw, 'angle', label), `${label}.angle`),
      angularVelocity: finite(own(raw, 'angularVelocity', label), `${label}.angularVelocity`),
      radius,
      energy: finite(own(raw, 'energy', label), `${label}.energy`),
      heavy: boolean(own(raw, 'heavy', label), `${label}.heavy`),
      alive,
      lhid: integer(own(raw, 'lhid', label), `${label}.lhid`),
      lht,
      sx: optionalNumber(raw, 'sx', x, label),
      sy: optionalNumber(raw, 'sy', y, label),
      sxv: optionalNumber(raw, 'sxv', xv, label),
      syv: optionalNumber(raw, 'syv', yv, label),
      ni,
      ds,
      da,
      vt,
      ...(swing === undefined ? {} : { swing }),
    };
  }
  for (const disc of discs) {
    if (!disc) continue;
    if (disc.lhid !== -1 && ((!seen.has(disc.lhid) && !knownPlayerIds.includes(disc.lhid)) || disc.lhid === disc.id)) {
      invalid(`disc ${disc.id}.lhid must be -1 or another player known at round entry`);
    }
  }
  return discs;
}

function readNumericArray(value: unknown, label: string, balances: boolean): number[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const output: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      if (balances) output[index] = 0;
      continue;
    }
    if (!('value' in descriptor)) invalid(`${label}[${index}] must be an own data property`);
    const entry = integer(descriptor.value, `${label}[${index}]`);
    if (balances && (entry < -100 || entry > 100)) invalid(`${label}[${index}] must be in [-100, 100]`);
    output[index] = entry;
  }
  return output;
}

interface ResolvedOptions extends NativeWorldStepOptions {
  fly: boolean;
  noCollision: boolean;
  balances: readonly number[];
  teams: readonly number[];
  teamCollision: boolean;
  respawn: boolean;
  radialBounds: boolean;
  knownPlayerIds: readonly number[];
  mode: 'b' | 'sp' | 'bs';
}

function readOptions(value: unknown): ResolvedOptions {
  const raw = value === undefined ? {} : record(value, 'options');
  fields(raw, OPTION_FIELDS, 'options');
  if (
    has(raw, 'mode') &&
    own(raw, 'mode', 'options') !== 'b' &&
    own(raw, 'mode', 'options') !== 'sp' &&
    own(raw, 'mode', 'options') !== 'bs'
  )
    invalid('only Classic mode b, Grapple mode sp and Simple mode bs are supported');
  const quality = has(raw, 'quality') ? own(raw, 'quality', 'options') : 1;
  if (quality !== 1 && quality !== 2) invalid('options.quality must be 1 or 2');
  const deltaMs = optionalNumber(raw, 'deltaMs', 30, 'options');
  if (deltaMs === 0) invalid('options.deltaMs must be nonzero');
  const stepScale = has(raw, 'stepScale') ? integer(own(raw, 'stepScale', 'options'), 'options.stepScale') : 1;
  if (stepScale < 1 || stepScale > 120) invalid('options.stepScale must be in [1, 120]');
  return {
    simulate: has(raw, 'simulate') ? boolean(own(raw, 'simulate', 'options'), 'options.simulate') : undefined,
    quality,
    deltaMs,
    stepScale,
    fly: has(raw, 'fly') ? boolean(own(raw, 'fly', 'options'), 'options.fly') : false,
    noCollision: has(raw, 'noCollision') ? boolean(own(raw, 'noCollision', 'options'), 'options.noCollision') : false,
    balances: has(raw, 'balances') ? readNumericArray(own(raw, 'balances', 'options'), 'options.balances', true) : [],
    teams: has(raw, 'teams') ? readNumericArray(own(raw, 'teams', 'options'), 'options.teams', false) : [],
    teamCollision: has(raw, 'teamCollision')
      ? boolean(own(raw, 'teamCollision', 'options'), 'options.teamCollision')
      : false,
    respawn: has(raw, 'respawn') ? boolean(own(raw, 'respawn', 'options'), 'options.respawn') : false,
    radialBounds: has(raw, 'radialBounds')
      ? boolean(own(raw, 'radialBounds', 'options'), 'options.radialBounds')
      : true,
    knownPlayerIds: has(raw, 'knownPlayerIds')
      ? readNumericArray(own(raw, 'knownPlayerIds', 'options'), 'options.knownPlayerIds', false)
      : [],
    mode: has(raw, 'mode') ? (own(raw, 'mode', 'options') as 'b' | 'sp' | 'bs') : 'b',
  };
}

function readInputs(
  value: unknown,
  discs: readonly (PhysicsDisc | undefined)[],
  mode: 'b' | 'sp' | 'bs',
): Map<number, number> {
  const raw = record(value, 'inputs');
  const known = new Set(discs.filter((disc): disc is PhysicsDisc => disc !== undefined).map((disc) => disc.id));
  const inputs = new Map<number, number>();
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!CANONICAL_DECIMAL_ID.test(key)) invalid(`input key ${JSON.stringify(key)} is not a canonical decimal disc id`);
    const id = Number(key);
    if (!known.has(id)) invalid(`input for unknown disc ${key}`);
    const bits = integer(own(raw, key, 'inputs'), `inputs.${key}`);
    if (bits < 0 || bits > 63) invalid(`inputs.${key} must be in [0, 63]`);
    if ((bits & INPUT_SECONDARY) !== 0 && mode !== 'sp')
      invalid(`inputs.${key} uses secondary input, which modes b and bs do not support`);
    inputs.set(id, bits);
  }
  for (const disc of discs) if (disc && !inputs.has(disc.id)) invalid(`missing input for disc ${disc.id}`);
  return inputs;
}

function readAuthoredZone(value: unknown, index: number): NativeClassicAuthoredCapZone {
  const label = `frame.authoredCapZones[${index}]`;
  const raw = record(value, label);
  fields(raw, new Set(['ty', 'l', 'i', 'n']), label);
  const ty = integer(own(raw, 'ty', label), `${label}.ty`);
  if (ty < 1 || ty > 5) invalid(`${label}.ty must be in [1, 5]`);
  const l = finite(own(raw, 'l', label), `${label}.l`);
  if (l < 0) invalid(`${label}.l must be nonnegative`);
  if (has(raw, 'n') && typeof own(raw, 'n', label) !== 'string') invalid(`${label}.n must be a string`);
  return { ty, l, i: integer(own(raw, 'i', label), `${label}.i`), ...(has(raw, 'n') ? { n: raw.n as string } : {}) };
}

/** Reproduce createNewState's cap-state creation, including duplicate/missing fixture handling. */
export function createNativeClassicCapZones(
  authored: readonly NativeClassicAuthoredCapZone[],
  physics: Pick<NativeMapPhysics, 'fixtures'>,
): NativeClassicCapZone[] {
  if (!Array.isArray(authored)) invalid('authored cap zones must be an array');
  const output: NativeClassicCapZone[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < authored.length; index++) {
    const zone = readAuthoredZone(authored[index], index);
    if (seen.has(zone.i) || !physics.fixtures[zone.i]) continue;
    seen.add(zone.i);
    output.push({ ty: zone.ty, p: 0, l: zone.l * 30, i: zone.i, o: -1, ot: -1, f: -1 });
  }
  return output;
}

function readLiveZones(
  value: unknown,
  fixtures: readonly NativeSlot<NativeMapPhysics['fixtures'][number]>[],
): NativeClassicCapZone[] {
  if (!Array.isArray(value)) invalid('frame.capZones must be an array');
  const seen = new Set<number>();
  return value.map((entry, index): NativeClassicCapZone => {
    const label = `frame.capZones[${index}]`;
    const raw = record(entry, label);
    fields(raw, new Set(['ty', 'p', 'l', 'i', 'o', 'ot', 'f']), label);
    const ty = integer(own(raw, 'ty', label), `${label}.ty`);
    if (ty < 1 || ty > 5) invalid(`${label}.ty must be in [1, 5]`);
    const i = integer(own(raw, 'i', label), `${label}.i`);
    if (seen.has(i)) invalid(`${label}.i duplicates fixture ${i}`);
    if (!fixtures[i]) invalid(`${label}.i references missing fixture ${i}`);
    seen.add(i);
    const p = finite(own(raw, 'p', label), `${label}.p`);
    const l = finite(own(raw, 'l', label), `${label}.l`);
    if (p < 0 || l < 0) invalid(`${label}.p/l must be nonnegative`);
    const f = integer(own(raw, 'f', label), `${label}.f`);
    if (f < -1 || f > 20) invalid(`${label}.f must be in [-1, 20]`);
    return {
      ty,
      p,
      l,
      i,
      o: integer(own(raw, 'o', label), `${label}.o`),
      ot: integer(own(raw, 'ot', label), `${label}.ot`),
      f,
    };
  });
}

function readFrame(value: unknown, physics: NativeMapPhysics): NativeClassicCapZone[] {
  const raw = value === undefined ? {} : record(value, 'frame');
  fields(raw, new Set(['capZones', 'authoredCapZones', 'projectiles']), 'frame');
  if (has(raw, 'capZones') && has(raw, 'authoredCapZones'))
    invalid('frame.capZones and authoredCapZones are mutually exclusive');
  if (has(raw, 'projectiles')) {
    const projectiles = own(raw, 'projectiles', 'frame');
    if (!Array.isArray(projectiles)) invalid('frame.projectiles must be an array');
    if (projectiles.length > 0) invalid('projectiles and grapples are unsupported in Classic mode b');
  }
  if (has(raw, 'authoredCapZones')) {
    const authored = own(raw, 'authoredCapZones', 'frame') as readonly NativeClassicAuthoredCapZone[];
    return createNativeClassicCapZones(authored, physics);
  }
  return has(raw, 'capZones') ? readLiveZones(own(raw, 'capZones', 'frame'), physics.fixtures) : [];
}

interface RuntimeDisc extends PhysicsDisc {
  sx: number;
  sy: number;
  sxv: number;
  syv: number;
  ni: boolean;
  ds: number;
  da: number;
  vt: number;
  swing?: { b: number; p: [number, number]; l: number };
}

interface Carrier {
  bodies: Map<number, any>;
  radii: Map<number, number>;
  energies: Map<number, number>;
  capZones: NativeClassicCapZone[];
  capZoneContacts: NativeClassicContact[];
  capZoneTeamGoals: NativeClassicTeamGoal[];
  contacts: ({ count: number; players: number[] } | undefined)[][];
  instantWin: boolean[];
  deathCauses: Map<number, 1 | 3 | 4>;
  output: (PhysicsDisc | undefined)[];
  deaths: NativeClassicDeath[];
  retainedSwings: Set<number>;
  firedSwings: Set<number>;
  swingCollideDestroyEvents: number[];
}

const BASE_DENSITY = 1 / Math.PI;

function canonicalRadius(balance: number | undefined): number {
  return 1 + Math.max(Math.min((balance ?? 0) / 100, 1), -0.95);
}

export function createNativeClassicWorld(): NativeClassicWorld {
  const nativeWorld: NativeWorld = createNativeWorld();
  let disposed = false;

  function step(
    rawPhysics: NativeMapPhysics,
    rawDiscs: readonly (PhysicsDisc | undefined)[],
    rawInputs: Readonly<Record<number, number>>,
    rawOptions: NativeClassicWorldOptions = {},
    rawFrame?: NativeClassicFrame,
  ): NativeClassicWorldResult {
    if (disposed) throw new Error('Native Classic world instance has been disposed');
    // The map seam performs its own strict normalization/cloning before build.
    const options = readOptions(rawOptions);
    const discs = readDiscs(rawDiscs, options.knownPlayerIds);
    const inputs = readInputs(rawInputs, discs, options.mode);
    const capZones = readFrame(rawFrame, rawPhysics);
    if (
      rawPhysics.ftu !== undefined &&
      options.simulate !== undefined &&
      options.simulate !== (rawPhysics.ftu === -1)
    ) {
      invalid('options.simulate must agree with physics.ftu; omit it to use the native countdown gate');
    }
    for (const body of rawPhysics.bodies) {
      if (body?.fz.on) {
        // Active force zones are applied at contact time by the BeginContact
        // listener (original :4940-4995); no static rejection is required.
      }
    }
    for (const disc of discs) {
      if (!disc) continue;
      if (disc.lht !== 0) disc.lht--;
      if (disc.lht === 0) disc.lhid = -1;
    }
    const sorted = discs.filter((disc): disc is RuntimeDisc => disc !== undefined).sort((a, b) => a.id - b.id);
    const byId = new Map(sorted.map((disc) => [disc.id, disc]));
    let carrier!: Carrier;

    const physics = nativeWorld.stepWith(
      rawPhysics,
      {
        simulate: options.simulate,
        quality: options.quality,
        deltaMs: options.deltaMs,
        stepScale: options.stepScale,
      },
      {
        build(context: NativeWorldBuildContext): Carrier {
          const B = context.backend;
          const Vec2 = B.Common.Math.b2Vec2;
          const bodies = new Map<number, any>();
          const radii = new Map<number, number>();
          const energies = new Map<number, number>();
          carrier = {
            bodies,
            radii,
            energies,
            capZones,
            capZoneContacts: [],
            capZoneTeamGoals: [],
            contacts: [],
            instantWin: [],
            deathCauses: new Map(),
            output: [],
            deaths: [],
            retainedSwings: new Set(),
            firedSwings: new Set(),
            swingCollideDestroyEvents: [],
          };
          const listener = new B.Dynamics.b2ContactListener();
          listener.BeginContact = (contact: any): void => {
            const fixtureA = contact.GetFixtureA();
            const fixtureB = contact.GetFixtureB();
            const dataA = fixtureA.GetUserData();
            const dataB = fixtureB.GetUserData();
            const bodyA = fixtureA.GetBody().GetUserData();
            const bodyB = fixtureB.GetBody().GetUserData();
            for (let pass = 0; pass < 2; pass++) {
              const body = pass === 0 ? bodyA : bodyB;
              const other = pass === 0 ? bodyB : bodyA;
              const subjectData = pass === 0 ? dataA : dataB;
              const otherData = pass === 0 ? dataB : dataA;
              if (body?.type === 'disc' && other?.type === 'phys' && otherData?.death === true) {
                carrier.deathCauses.set(body.arrayID, 1);
              }
              if (
                body?.type === 'disc' &&
                other?.type === 'phys' &&
                otherData?.capzone === true &&
                otherData.capType === 1 &&
                subjectData?.type === 'discbody'
              ) {
                carrier.capZoneContacts.push({
                  zone: otherData.capID,
                  fixtureId: otherData.arrayID,
                  disc: body.arrayID,
                });
                const zone = otherData.capID as number;
                const team = body.team as number;
                const byTeam = carrier.contacts[zone] ?? (carrier.contacts[zone] = []);
                const entry = byTeam[team] ?? (byTeam[team] = { count: 0, players: [] });
                entry.count++;
                entry.players.push(body.arrayID);
                contact.SetEnabled(false);
              }
              if (
                body?.type === 'phys' &&
                other?.type === 'phys' &&
                otherData?.capzone === true &&
                otherData.capType !== 1
              ) {
                carrier.capZoneTeamGoals.push({ zone: otherData.capID, team: otherData.capType });
                carrier.instantWin[otherData.capType] = true;
                contact.SetEnabled(false);
              }
              if (body?.type === 'disc' && other?.type === 'disc') {
                const first = byId.get(body.arrayID);
                const second = byId.get(other.arrayID);
                if (options.noCollision || (options.teamCollision && body.team === other.team)) {
                  contact.SetEnabled(false);
                } else if (first && second) {
                  // Native (4899-4903): a swinging disc loses its swing on any
                  // enabled disc-disc contact; the retention gate consumes it.
                  // The native check reads stepDiscs[i].swing — the retained
                  // boolean (swing object present AND action2 held this tick).
                  if (first.swing !== undefined && carrier.retainedSwings.has(first.id))
                    carrier.swingCollideDestroyEvents.push(first.id);
                  if (second.swing !== undefined && carrier.retainedSwings.has(second.id))
                    carrier.swingCollideDestroyEvents.push(second.id);
                  first.lhid = second.id;
                  second.lhid = first.id;
                  first.lht = 120;
                  second.lht = 120;
                }
              }
              // Active force zone: original :4940-4995. The fz carrier is read
              // from this step's input physics exactly as the original reads
              // inputState.physics.bodies[bodyId].fz; the angle and radial
              // origin likewise come from the input body, not the live handle.
              if (body?.type === 'phys') {
                const inputBody = context.physics.bodies[body.arrayID];
                const zone = inputBody?.fz;
                if (zone?.on === true) {
                  contact.SetEnabled(false);
                  const otherBodyHandle = pass === 0 ? fixtureB.GetBody() : fixtureA.GetBody();
                  const power = new Vec2(zone.x, zone.y);
                  if (zone.t === 1) {
                    const cos = safeCos(inputBody!.a);
                    const sin = safeSin(inputBody!.a);
                    const adjustedX = power.x * cos - power.y * sin;
                    const adjustedY = power.x * sin + power.y * cos;
                    power.x = adjustedX;
                    power.y = adjustedY;
                  }
                  if (zone.t === 2 || zone.t === 3) {
                    const coefficient = zone.t === 2 ? -zone.cf : zone.cf;
                    const vector = new Vec2(
                      inputBody!.p[0] - otherBodyHandle.GetPosition().x,
                      inputBody!.p[1] - otherBodyHandle.GetPosition().y,
                    );
                    vector.Normalize();
                    vector.Multiply(coefficient);
                    power.x = vector.x;
                    power.y = vector.y;
                  }
                  if (
                    (other?.type === 'disc' && zone.d) ||
                    (other?.type === 'arrow' && zone.a) ||
                    (other?.type === 'phys' && zone.p)
                  ) {
                    otherBodyHandle.ApplyForce(power, otherBodyHandle.GetWorldCenter());
                  }
                }
              }
            }
          };
          // Native PostSolve (5027-5044): disc/phys contacts accumulate the
          // normal impulse on the disc body's userData; disc/disc never does.
          listener.PostSolve = (contact: any, impulse: any): void => {
            const bodyA = contact.GetFixtureA().GetBody();
            const bodyB = contact.GetFixtureB().GetBody();
            const dataA = bodyA.GetUserData();
            const dataB = bodyB.GetUserData();
            if (dataA?.type === 'disc' && dataB?.type === 'phys') dataA.impulsesThisStep += impulse.normalImpulses[0];
            else if (dataA?.type === 'phys' && dataB?.type === 'disc')
              dataB.impulsesThisStep += impulse.normalImpulses[0];
          };
          context.world.SetContactListener(listener);

          for (const disc of sorted) {
            if (!disc.alive) continue;
            const bits = inputs.get(disc.id)!;
            const heavy = (bits & 16) !== 0;
            const radius = canonicalRadius(options.balances[disc.id]);
            // Native swing retention (5221-5226): the joint is rebuilt only while
            // the input state carries a swing and the previous input held action2.
            const retainedSwing = options.mode === 'sp' && disc.swing !== undefined && (bits & INPUT_SECONDARY) !== 0;
            if (retainedSwing) carrier.retainedSwings.add(disc.id);
            let energy = disc.energy;
            if (options.mode === 'sp') {
              // Native grapple energy (5246-5267), applied before the fire gate.
              if (retainedSwing) {
                energy = Math.max(0, energy - 4);
                if (energy < 500) {
                  energy = 0;
                  disc.swing = undefined;
                }
              } else {
                energy = Math.min(1000, energy + 3);
              }
            } else if (options.mode !== 'bs') {
              // Native heavy meter (5228-5244) applies only to modes b and v;
              // Simple mode bs has no drain/recharge branch, so energy is frozen.
              energy = heavy ? Math.max(0, disc.energy - 10) : Math.min(1000, disc.energy + 5);
            }
            // Native heavy density (5276-5289) requires a1 && mo != "bs" && ds == 0.
            const density =
              heavy && disc.ds <= 0 && options.mode !== 'bs'
                ? BASE_DENSITY + 3.7 * (energy / 1000) * BASE_DENSITY
                : BASE_DENSITY;
            radii.set(disc.id, radius);
            energies.set(disc.id, energy);
            const definition = new B.Dynamics.b2BodyDef();
            definition.type = B.Dynamics.b2Body.b2_dynamicBody;
            definition.position.Set(disc.x, disc.y);
            definition.fixedRotation = true;
            definition.linearDamping = 0.01;
            definition.linearVelocity.Set(disc.xv, disc.yv);
            definition.angularVelocity = disc.angularVelocity;
            definition.angle = disc.angle;
            definition.angularDamping = 3.4;
            definition.bullet = true;
            definition.userData = {
              type: 'disc',
              arrayID: disc.id,
              team: options.teams[disc.id] ?? 1,
              impulsesThisStep: 0,
            };
            const body = context.world.CreateBody(definition);
            const fixture = new B.Dynamics.b2FixtureDef();
            fixture.shape = new B.Collision.Shapes.b2CircleShape(radius);
            fixture.density = density;
            fixture.friction = 0.001337;
            fixture.restitution = 0.95;
            fixture.filter.categoryBits = 1;
            fixture.filter.maskBits = 0xffff;
            fixture.filter.groupIndex = 0;
            fixture.userData = { type: 'discbody' };
            body.CreateFixture(fixture);
            body.SetLinearVelocity(new Vec2(disc.xv, disc.yv));
            bodies.set(disc.id, body);
          }
          return carrier;
        },
        afterMap(context: NativeWorldBuildContext): void {
          for (let zone = 0; zone < carrier.capZones.length; zone++) {
            const state = carrier.capZones[zone];
            const fixture = context.fixtures[state.i];
            // Initial cap creation excludes missing fixtures. np fixtures have no
            // handle and therefore cannot be tagged or produce contact events.
            if (!fixture) continue;
            Object.assign(fixture.GetUserData(), { capzone: true, capID: zone, capType: state.ty, fixtureID: state.i });
          }
          // Native grapple joint rebuild (5947-5989): only for a retained swing
          // (stepDiscs[i].swing — swing object present AND action2 held this
          // tick), the distance joint is re-created each tick from the persisted
          // attachment. The anchor rides the map body's current transform; the
          // slack/taut frequency selection uses the live disc/anchor separation.
          if (options.mode === 'sp') {
            const Vec2 = context.backend.Common.Math.b2Vec2;
            const DistanceJointDef = context.backend.Dynamics.Joints.b2DistanceJointDef;
            for (const disc of sorted) {
              if (!disc.alive || disc.swing === undefined || !carrier.retainedSwings.has(disc.id)) continue;
              const discBody = carrier.bodies.get(disc.id);
              const targetBody = context.bodies[disc.swing.b];
              if (discBody === undefined || targetBody === undefined) continue;
              const anchorWorld = targetBody.GetWorldPoint(new Vec2(disc.swing.p[0], disc.swing.p[1]));
              const discPosition = discBody.GetPosition();
              const distanceFromPlayer = Math.sqrt(
                (discPosition.x - anchorWorld.x) ** 2 + (discPosition.y - anchorWorld.y) ** 2,
              );
              const jointDefinition = new DistanceJointDef();
              jointDefinition.bodyA = discBody;
              jointDefinition.bodyB = targetBody;
              jointDefinition.localAnchorA.Set(0, 0);
              jointDefinition.localAnchorB.Set(disc.swing.p[0], disc.swing.p[1]);
              jointDefinition.length = disc.swing.l;
              jointDefinition.frequencyHz = distanceFromPlayer < disc.swing.l ? 0.01 : 2;
              jointDefinition.dampingRatio = 0;
              jointDefinition.collideConnected = true;
              context.world.CreateJoint(jointDefinition);
            }
          }
        },
        buildProjectiles(): void {
          // readFrame rejected every nonempty projectile table before world build.
        },
        beforeStep(context: NativeWorldBuildContext): void {
          if (!context.options.simulate) return;
          const Vec2 = context.backend.Common.Math.b2Vec2;
          for (const disc of sorted) {
            const body = carrier.bodies.get(disc.id);
            if (!body) continue;
            const bits = inputs.get(disc.id)!;
            const radius = carrier.radii.get(disc.id)!;
            const radiusSquared = (Math.PI * radius * radius) / (Math.PI * 1 * 1);
            const maximum = (options.fly ? 20 : 12) * radiusSquared;
            const force = new Vec2(0, 0);
            if ((bits & 4) !== 0) force.y = -maximum;
            else if ((bits & 8) !== 0) force.y = maximum;
            if ((bits & 1) !== 0) force.x = -maximum;
            else if ((bits & 2) !== 0) force.x = maximum;
            if ((bits & 16) !== 0) force.Multiply(0.7);
            body.ApplyForce(force, body.GetWorldCenter());

            if ((bits & 4) !== 0 && Math.abs(body.GetLinearVelocity().y) < 4) {
              const start = new Vec2(disc.x, disc.y);
              const end = new Vec2(disc.x, disc.y + radius + 0.15);
              context.world.RayCast(
                (fixture: any): number => {
                  const bodyData = fixture.GetBody().GetUserData();
                  if (!bodyData || bodyData.type !== 'phys') return -1;
                  // Original :6311-6315: force-zone bodies are never jumpable.
                  if (context.physics.bodies[bodyData.arrayID]?.fz?.on === true) return -1;
                  const data = fixture.GetUserData();
                  const collidesWithDisc = (fixture.GetFilterData().maskBits & 1) === 1;
                  if (!data || data.capzone || data.death === true || !collidesWithDisc) return -1;
                  body.GetLinearVelocity().y -= 10;
                  return 0;
                },
                start,
                end,
              );
            }

            // Native grapple fire gate (6344-6528): no existing swing, action2
            // held this tick, sp mode, and post-energy-update energy above 500.
            // The attachment is stored only; the joint is created next tick.
            if (
              options.mode === 'sp' &&
              disc.swing === undefined &&
              (bits & INPUT_SECONDARY) !== 0 &&
              carrier.energies.get(disc.id)! > 500
            ) {
              const discPosition = new Vec2(disc.x, disc.y);
              const candidates: any[] = [];
              const aabb = new context.backend.Collision.b2AABB();
              aabb.lowerBound = new Vec2(discPosition.x - 10, discPosition.y - 10);
              aabb.upperBound = new Vec2(discPosition.x + 10, discPosition.y + 10);
              context.world.QueryAABB((fixture: any): boolean => {
                const bodyData = fixture.GetBody().GetUserData();
                const fixtureData = fixture.GetUserData();
                // Native filter (6351-6371): phys bodies only; capzone and
                // noGrapple fixtures are excluded, as are bodies with active fz.
                if (bodyData?.type !== 'phys' || fixtureData?.capzone === true || fixtureData?.noGrapple === true)
                  return true;
                if (context.physics.bodies[bodyData.arrayID]?.fz?.on === true) return true;
                candidates.push(fixture);
                return true;
              }, aabb);
              const scored: { body: any; fixture: any; wp: any; d: number }[] = [];
              for (const fixture of candidates) {
                const shape = fixture.GetShape();
                const targetBody = fixture.GetBody();
                if (shape.GetType() === 0) {
                  // Circle: anchor on the rim ray toward the disc.
                  const center = targetBody.GetWorldPoint(shape.GetLocalPosition());
                  const offsetX = discPosition.x - center.x;
                  const offsetY = discPosition.y - center.y;
                  const centerDistance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
                  const hitLength = centerDistance - shape.GetRadius();
                  if (hitLength < 10) {
                    const hitRatio = centerDistance > 0 ? hitLength / centerDistance : 0;
                    scored.push({
                      body: targetBody,
                      fixture,
                      wp: new Vec2(offsetX * hitRatio + discPosition.x, offsetY * hitRatio + discPosition.y),
                      d: hitLength,
                    });
                  }
                } else {
                  // Polygon: per-edge point-to-segment projection in world space.
                  const vertices = shape.GetVertices();
                  for (let vertexIndex = 0; vertexIndex < vertices.length; vertexIndex++) {
                    const nextIndex = vertexIndex + 1 >= vertices.length ? 0 : vertexIndex + 1;
                    const start = targetBody.GetWorldPoint(vertices[vertexIndex]);
                    const end = targetBody.GetWorldPoint(vertices[nextIndex]);
                    const segmentX = end.x - start.x;
                    const segmentY = end.y - start.y;
                    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
                    let ratio =
                      lengthSquared > 0
                        ? ((discPosition.x - start.x) * segmentX + (discPosition.y - start.y) * segmentY) /
                          lengthSquared
                        : 0;
                    ratio = Math.max(0, Math.min(1, ratio));
                    const projection = new Vec2(start.x + segmentX * ratio, start.y + segmentY * ratio);
                    const distance = Math.sqrt(
                      (projection.x - discPosition.x) ** 2 + (projection.y - discPosition.y) ** 2,
                    );
                    if (distance < 10) {
                      scored.push({ body: targetBody, fixture, wp: projection, d: distance });
                    }
                  }
                }
              }
              scored.sort((left, right) => left.d - right.d);
              for (const candidate of scored) {
                // Native selection (6500-6527): first candidate with innerGrapple
                // or whose fixture does not contain the disc position.
                if (
                  candidate.fixture.GetUserData()?.innerGrapple === true ||
                  candidate.fixture.TestPoint(discPosition) === false
                ) {
                  const localPoint = candidate.body.GetLocalPoint(candidate.wp);
                  disc.swing = {
                    b: candidate.body.GetUserData().arrayID,
                    p: [localPoint.x, localPoint.y],
                    l: Math.sqrt((candidate.wp.x - discPosition.x) ** 2 + (candidate.wp.y - discPosition.y) ** 2),
                  };
                  carrier.firedSwings.add(disc.id);
                  break;
                }
              }
            }
          }
        },
        extract(context: NativeWorldBuildContext): void {
          // Capture processing follows ClearForces and precedes OOB. Contacts are
          // grouped by cap zone and native team ID, not by compacted roster index.
          for (let zone = 0; zone < carrier.contacts.length; zone++) {
            const byTeam = carrier.contacts[zone];
            if (!byTeam) continue;
            const state = carrier.capZones[zone];
            if (!state || state.f !== -1) continue;
            let entityCount = 0;
            let touchCount = 0;
            let representative = -1;
            for (let team = 0; team < byTeam.length; team++) {
              const entry = byTeam[team];
              if (!entry) continue;
              entityCount += team === 1 ? entry.count : 1;
              touchCount += entry.count;
              representative = entry.players[0];
            }
            if (entityCount > 1) {
              const ffa = byTeam[1];
              if (ffa && !ffa.players.includes(state.o)) state.p = Math.max(0, state.p - touchCount);
            } else if (entityCount === 1) {
              const team = options.teams[representative] ?? 1;
              const capTeam = team === 1 ? representative : team;
              if (state.o === -1) {
                state.p = 1;
                state.o = capTeam;
                state.ot = team;
              } else if (capTeam !== state.o) {
                state.p -= options.teamCollision ? byTeam[capTeam]!.count : 1;
                if (state.p <= 0) {
                  state.p = 0;
                  state.o = capTeam;
                  state.ot = team;
                }
              } else {
                state.p += options.teamCollision ? byTeam[capTeam]!.count : 1;
                if (state.p > state.l) state.p = state.l;
              }
            }
          }
          for (const state of carrier.capZones) {
            if (state.p < state.l) continue;
            if (state.f === -1) state.f = 20;
            else if (state.f !== 0) state.f--;
            else if (state.ot === 1) {
              for (const disc of sorted)
                if (carrier.bodies.has(disc.id) && disc.id !== state.o) carrier.deathCauses.set(disc.id, 3);
            } else {
              for (const disc of sorted) {
                if (carrier.bodies.has(disc.id) && (options.teams[disc.id] ?? 1) !== state.ot)
                  carrier.deathCauses.set(disc.id, 3);
              }
            }
          }
          for (let team = 0; team < carrier.instantWin.length; team++) {
            if (!carrier.instantWin[team]) continue;
            for (const disc of sorted) {
              if (carrier.bodies.has(disc.id) && (options.teams[disc.id] ?? 1) !== team)
                carrier.deathCauses.set(disc.id, 3);
            }
          }

          // OOB deliberately overwrites lethal/capture causes, as in native.
          const centreX = 365 / context.physics.ppm;
          const centreY = 250 / context.physics.ppm;
          const floor = 500 / context.physics.ppm;
          const radialLimit = 850 / context.physics.ppm;
          for (const disc of sorted) {
            const body = carrier.bodies.get(disc.id);
            if (!body) continue;
            const position = body.GetPosition();
            const dx = position.x - centreX;
            const dy = position.y - centreY;
            if (position.y > floor || (options.radialBounds && Math.sqrt(dx * dx + dy * dy) > radialLimit)) {
              carrier.deathCauses.set(disc.id, 4);
            }
          }

          carrier.output = discs.map((disc): PhysicsDisc | undefined => {
            if (!disc) return undefined;
            const body = carrier.bodies.get(disc.id);
            const cause = carrier.deathCauses.get(disc.id);
            const respawned = cause !== undefined && cause !== 3 && options.respawn;
            const position = body.GetPosition();
            const velocity = body.GetLinearVelocity();
            if (cause !== undefined) {
              carrier.deaths.push({
                id: disc.id,
                cause: cause === 1 ? 'lethal-contact' : cause === 3 ? 'capture' : 'out-of-world',
                x: position.x,
                y: position.y,
                xv: velocity.x,
                yv: velocity.y,
              });
              // Native omits the disc-table entry entirely unless this is a
              // respawn; capture deaths and non-respawn elimination are holes.
              if (!respawned) return undefined;
            }
            // Native grapple retention gate (7177-7187): a swing present on the
            // rebuilt joint survives only without a disc-disc collision event and
            // with accumulated normal impulses below 300; otherwise the swing is
            // dropped and energy is zeroed. Respawn deletes the swing (7202).
            let swing: { b: number; p: [number, number]; l: number } | undefined;
            let energy = carrier.energies.get(disc.id)!;
            if (options.mode === 'sp') {
              if (carrier.retainedSwings.has(disc.id)) {
                const impulse = body.GetUserData().impulsesThisStep as number;
                if (!carrier.swingCollideDestroyEvents.includes(disc.id) && impulse < 300) {
                  swing = disc.swing;
                } else {
                  energy = 0;
                }
              } else if (disc.swing !== undefined && carrier.firedSwings.has(disc.id)) {
                // Native (7167-7175): a newly fired attachment this tick is
                // serialized as-is, independent of the retention gate.
                swing = disc.swing;
              }
              if (respawned) swing = undefined;
            }
            return {
              id: disc.id,
              x: respawned ? disc.sx : position.x,
              y: respawned ? disc.sy : position.y,
              xv: respawned ? disc.sxv : velocity.x,
              yv: respawned ? disc.syv : velocity.y,
              angle: body.GetAngle(),
              angularVelocity: body.GetAngularVelocity(),
              radius: carrier.radii.get(disc.id)!,
              energy,
              heavy: (inputs.get(disc.id)! & 16) !== 0,
              alive: true,
              lhid: disc.lhid,
              lht: disc.lht,
              sx: disc.sx,
              sy: disc.sy,
              sxv: disc.sxv,
              syv: disc.syv,
              ni: respawned,
              ds: disc.ds,
              da: disc.da,
              vt: disc.vt,
              ...(swing === undefined ? {} : { swing }),
            };
          });
        },
      },
    );

    return {
      physics,
      discs: carrier.output,
      capZones: carrier.capZones,
      capZoneContacts: carrier.capZoneContacts,
      capZoneTeamGoals: carrier.capZoneTeamGoals,
      hits: carrier.output
        .filter((disc): disc is PhysicsDisc => disc !== undefined && disc.lht > 0 && disc.lhid >= 0)
        .map((disc) => ({ player: disc.id, other: disc.lhid })),
      deaths: carrier.deaths,
    };
  }

  return {
    step,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      nativeWorld.dispose();
    },
  };
}
