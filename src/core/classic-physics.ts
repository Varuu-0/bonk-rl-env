/**
 * Minimal, independently written Classic physics tick.
 *
 * The algorithm is reconstructed from the retained reference at
 * `.deobf/alpha2s.slot-accurate.numeric.js` (the disc, platform, force, jump and
 * step ranges) and uses the packaged modified Box2D backend. It deliberately
 * does not import match lifecycle, spawn selection or the static map loader.
 *
 * The world is rebuilt from the supplied state on every step, mirroring the
 * native `novakReset()` + recreate pattern. All inputs are validated before the
 * world is touched. Bodies/joints are destroyed after state extraction; the next
 * reset recreates the solver/contact bookkeeping as in the reference.
 */
import { createBackend } from './backend';
import { DT } from '../shared/units';
import { safeATan2, safeCos, safeSin } from './safe-trig';

export interface PhysicsDisc {
  id: number;
  x: number;
  y: number;
  xv: number;
  yv: number;
  angle: number;
  angularVelocity: number;
  radius: number;
  energy: number;
  heavy: boolean;
  alive: boolean;
  lhid: number;
  lht: number;
  /** Native round spawn position/velocity (`sx/sy/sxv/syv`). */
  sx?: number;
  sy?: number;
  sxv?: number;
  syv?: number;
  /** Native respawn marker: true only on the step that restored the spawn. */
  ni?: boolean;
  /** Native Arrow draw/aim state; omitted on legacy Classic fixture objects. */
  ds?: number;
  da?: number;
  vt?: number;
  /**
   * Native Grapple attachment: `b` is the map body arrayID, `p` the body-local
   * anchor and `l` the rope length. Present only in Grapple mode (`sp`).
   */
  swing?: { b: number; p: [number, number]; l: number };
}

/**
 * Native Arrow projectile state. `did` is the firing disc and `team` its team;
 * `fte` is the remaining lifetime in steps.
 */
export interface PhysicsProjectile {
  x: number;
  y: number;
  xv: number;
  yv: number;
  a: number;
  av: number;
  fte: number;
  did: number;
  type: 'arrow';
  team: number;
}

/** Auxiliary state carried between ticks, shaped like native `state.projectiles`. */
export interface ClassicPhysicsFrame {
  projectiles?: readonly (PhysicsProjectile | undefined)[];
}

/**
 * Flattened static fixture in world coordinates, structurally matching the
 * static-map loader's `StaticPlatform`.
 */
export interface PhysicsPlatform {
  id: number;
  bodyId: number;
  shape: 'box' | 'circle' | 'polygon';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  vertices?: readonly (readonly [number, number])[];
  angle: number;
  color: number;
  friction: number;
  restitution: number;
  lethal: boolean;
  /** Native fixture `ng`: never grappleable. */
  noGrapple?: boolean;
  /** Native fixture `ig`: grappleable even when the disc is inside the shape. */
  innerGrapple?: boolean;
  capZone?: number;
  capType?: number;
  bodyX?: number;
  bodyY?: number;
  bodyAngle?: number;
  localX?: number;
  localY?: number;
  localAngle?: number;
}

export interface ClassicPhysicsOptions {
  fly: boolean;
  noCollision: boolean;
  quality: 1 | 2;
  simulate: boolean;
  balances?: readonly number[];
  /** Native team values for projectile ownership and team-contact filtering. */
  teams?: readonly number[];
  teamCollision?: boolean;
  /** Native disc-definition mode. Game currently exposes Classic only. */
  mode?: 'b' | 'ar' | 'ard' | 'v' | 'sp' | 'bs';
  /** Native map setting `s.re`: immediately restore a death to its spawn. */
  respawn?: boolean;
  /**
   * Map pixels-per-metre. When present, applies the native non-tutorial
   * out-of-world gates (floor 500/ppm, radial 850/ppm around 365/250).
   */
  ppm?: number;
}

export interface ClassicPhysicsWorld {
  readonly discs: PhysicsDisc[];
  readonly platforms: readonly PhysicsPlatform[];
  readonly projectiles?: readonly (PhysicsProjectile | undefined)[];
  /** Actual native arrow contact observations, empty for Classic/VTOL. */
  readonly arrowContacts?: readonly {
    readonly projectile: number;
    readonly disc: number | null;
    readonly world: boolean;
  }[];
  /** Timed-capture sensor contacts (capType 1), one entry per disc/fixture.
   * `zone` is the native capID (index in the map's capZones array). */
  readonly capZoneContacts?: readonly {
    readonly zone: number;
    readonly fixtureId: number;
    readonly disc: number;
  }[];
  /** Instant-goal sensor contacts (capType 2..5): a physics body touched the
   * goal fixture. Static maps have no dynamic map bodies, so this stays empty
   * unless a future supported body kind can produce one. */
  readonly capZoneTeamGoals?: readonly { readonly zone: number; readonly team: number }[];
  readonly deaths?: readonly {
    readonly id: number;
    readonly cause: 'lethal-contact' | 'arrow' | 'out-of-world' | 'capture';
    /** Actual post-solver body state before any live-disc respawn restoration. */
    readonly x?: number;
    readonly y?: number;
    readonly xv?: number;
    readonly yv?: number;
  }[];
  readonly hits?: readonly { readonly player: number; readonly other: number }[];
}

export interface ClassicPhysics {
  step(
    discs: readonly PhysicsDisc[],
    platforms: readonly PhysicsPlatform[],
    inputs: Readonly<Record<number, number>>,
    options: ClassicPhysicsOptions,
    frame?: ClassicPhysicsFrame,
  ): PhysicsDisc[];
  stepWorld(
    discs: readonly PhysicsDisc[],
    platforms: readonly PhysicsPlatform[],
    inputs: Readonly<Record<number, number>>,
    options: ClassicPhysicsOptions,
    frame?: ClassicPhysicsFrame,
  ): ClassicPhysicsWorld;
  stepDetailed(
    discs: readonly PhysicsDisc[],
    platforms: readonly PhysicsPlatform[],
    inputs: Readonly<Record<number, number>>,
    options: ClassicPhysicsOptions,
    frame?: ClassicPhysicsFrame,
  ): ClassicPhysicsWorld;
  dispose(): void;
}

const GRAVITY_Y = 20;
const BASE_DENSITY = 1 / Math.PI;
const MAX_FORCE = 12;
const FLY_FORCE = 20;
const HEAVY_MULTIPLIER = 3.7;
const DISC_DENSITY_FRICTION = 0.001337;
const DISC_RESTITUTION = 0.95;
const DISC_LINEAR_DAMPING = 0.01;
const DISC_ANGULAR_DAMPING = 3.4;
const STATIC_CATEGORY = 4;
const WORLD_HALF_WIDTH = 730 / 2;
const WORLD_HALF_HEIGHT = 500 / 2;
const WORLD_FLOOR = 500;
const WORLD_RADIUS = 850;
const CANONICAL_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;

const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_UP = 4;
const INPUT_DOWN = 8;
const INPUT_HEAVY = 16;
const INPUT_SECONDARY = 32;
const FOOT_HALF_WIDTH = 0.3;
const FOOT_HALF_HEIGHT = 0.2;
const FOOT_OFFSET_X = -1;
const FOOT_OFFSET_Y = 0;
const WING_DENSITY = 0.2;
const WING_FRICTION = 0.2;
const WING_RESTITUTION = 0.7;
const VTOL_IMPULSE = -0.8;
const VTOL_WEAK_IMPULSE = 0.2;
const ARROW_SPEED_BASE = 15;
const ARROW_SPAWN_OFFSET = 1;
const ARROW_MIN_ANGLE_SPEED = 4;
const ARROW_LIFETIME = 150;
const ARROW_HALF_WIDTH = 0.5;
const ARROW_HALF_HEIGHT = 0.25;
const ARROW_DENSITY = 2.5;
const ARROW_FRICTION = 0.5;
const ARROW_RESTITUTION = 1;
const ARROW_FIRE_ENERGY = 500;
// Native Grapple constants (alpha2s.slot-accurate.numeric.js :4812-4814,
// :6373, :7181, :1062-1063).
const GRAPPLE_ENERGY_THRESHOLD = 500;
const GRAPPLE_ENERGY_DRAIN = 4;
const GRAPPLE_ENERGY_RECHARGE = 3;
const GRAPPLE_QUERY_RADIUS = 10;
const GRAPPLE_BREAK_IMPULSE = 300;
const GRAPPLE_SLACK_FREQUENCY = 0.01;
const GRAPPLE_SWING_FREQUENCY = 2;
const GRAPPLE_SWING_DAMPING = 0;
const PROJECTILE_FIELDS = new Set(['x', 'y', 'xv', 'yv', 'a', 'av', 'fte', 'did', 'shid', 'type', 'team', 'shootTeam']);

type VtolMoveType = 'none' | 'both' | 'left' | 'right' | 'downboth' | 'downleft' | 'downright';

const VTOL_VT: Readonly<Record<VtolMoveType, number>> = Object.freeze({
  none: 0,
  left: 1,
  right: 2,
  both: 3,
  downboth: 4,
  downleft: 5,
  downright: 6,
});

function vtolMoveType(bits: number): VtolMoveType {
  const up = (bits & INPUT_UP) !== 0;
  const down = (bits & INPUT_DOWN) !== 0;
  const left = (bits & INPUT_LEFT) !== 0;
  const right = (bits & INPUT_RIGHT) !== 0;
  if (up && left) return 'right';
  if (up && right) return 'left';
  if (up) return 'both';
  if (down && left) return 'downright';
  if (down && right) return 'downleft';
  if (down) return 'downboth';
  if (left && right) return 'both';
  if (left) return 'right';
  if (right) return 'left';
  return 'none';
}

function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function invalid(reason: string): never {
  throw new Error(`Invalid Classic physics input: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) invalid(`${label}.${key} must be an own data property`);
  return descriptor.value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value;
}

function readBalances(value: unknown): readonly number[] {
  if (!Array.isArray(value)) invalid('options.balances must be an array');
  const balances: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      // Native gameSettings.bal is sparse by player ID; a missing entry is
      // falsy and leaves the canonical radius at its default. Never densify
      // player IDs or read an inherited numeric property.
      balances[index] = 0;
      continue;
    }
    if (!('value' in descriptor)) invalid(`options.balances[${index}] must be an own data property`);
    const balance = descriptor.value;
    if (typeof balance !== 'number' || !Number.isInteger(balance) || balance < -100 || balance > 100) {
      invalid(`options.balances[${index}] must be an integer from -100 to 100`);
    }
    balances[index] = balance;
  }
  return balances;
}

function readOptions(value: unknown): ClassicPhysicsOptions {
  if (!isRecord(value)) invalid('options must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ![
        'fly',
        'noCollision',
        'quality',
        'simulate',
        'balances',
        'mode',
        'teams',
        'teamCollision',
        'respawn',
        'ppm',
      ].includes(key)
    ) {
      invalid(`options has unsupported field ${String(key)}`);
    }
  }
  const fly = ownData(value, 'fly', 'options');
  const noCollision = ownData(value, 'noCollision', 'options');
  const quality = ownData(value, 'quality', 'options');
  const simulate = ownData(value, 'simulate', 'options');
  const balances = Object.prototype.hasOwnProperty.call(value, 'balances')
    ? readBalances(ownData(value, 'balances', 'options'))
    : [];
  if (typeof fly !== 'boolean') invalid('options.fly must be a boolean');
  if (typeof noCollision !== 'boolean') invalid('options.noCollision must be a boolean');
  if (quality !== 1 && quality !== 2) invalid('options.quality must be 1 or 2');
  if (typeof simulate !== 'boolean') invalid('options.simulate must be a boolean');
  const mode = Object.prototype.hasOwnProperty.call(value, 'mode') ? ownData(value, 'mode', 'options') : 'b';
  if (mode !== 'b' && mode !== 'ar' && mode !== 'ard' && mode !== 'v' && mode !== 'sp' && mode !== 'bs')
    invalid('options.mode is unsupported');
  const teamsValue = Object.prototype.hasOwnProperty.call(value, 'teams')
    ? ownData(value, 'teams', 'options')
    : undefined;
  if (teamsValue !== undefined && !Array.isArray(teamsValue)) invalid('options.teams must be an array');
  const teams: number[] = [];
  if (teamsValue !== undefined) {
    for (let index = 0; index < teamsValue.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(teamsValue, String(index));
      if (descriptor === undefined) continue;
      if (!('value' in descriptor)) invalid(`options.teams[${index}] must be an own data property`);
      teams[index] = safeInteger(descriptor.value, `options.teams[${index}]`);
    }
  }
  const rawTeamCollision = Object.prototype.hasOwnProperty.call(value, 'teamCollision')
    ? ownData(value, 'teamCollision', 'options')
    : false;
  if (typeof rawTeamCollision !== 'boolean') invalid('options.teamCollision must be a boolean');
  const teamCollision = rawTeamCollision;
  const rawRespawn = Object.prototype.hasOwnProperty.call(value, 'respawn')
    ? ownData(value, 'respawn', 'options')
    : false;
  if (typeof rawRespawn !== 'boolean') invalid('options.respawn must be a boolean');
  const rawPpm = Object.prototype.hasOwnProperty.call(value, 'ppm') ? ownData(value, 'ppm', 'options') : undefined;
  if (rawPpm !== undefined && (typeof rawPpm !== 'number' || !Number.isFinite(rawPpm) || rawPpm < 2 || rawPpm > 300)) {
    invalid('options.ppm must be a finite number in [2, 300]');
  }
  return {
    fly,
    noCollision,
    quality,
    simulate,
    balances,
    mode,
    teams,
    teamCollision,
    respawn: rawRespawn,
    ppm: rawPpm as number | undefined,
  };
}

function readDiscs(value: unknown): PhysicsDisc[] {
  if (!Array.isArray(value)) invalid('discs must be an array');
  const seen = new Set<number>();
  const discs = value.map((raw, index) => {
    const label = `discs[${index}]`;
    if (!isRecord(raw)) invalid(`${label} must be a plain object`);
    const id = nonNegativeInteger(ownData(raw, 'id', label), `${label}.id`);
    if (seen.has(id)) invalid(`duplicate disc id ${id}`);
    seen.add(id);
    const x = finite(ownData(raw, 'x', label), `${label}.x`);
    const y = finite(ownData(raw, 'y', label), `${label}.y`);
    const xv = finite(ownData(raw, 'xv', label), `${label}.xv`);
    const yv = finite(ownData(raw, 'yv', label), `${label}.yv`);
    const angle = finite(ownData(raw, 'angle', label), `${label}.angle`);
    const angularVelocity = finite(ownData(raw, 'angularVelocity', label), `${label}.angularVelocity`);
    const radius = finite(ownData(raw, 'radius', label), `${label}.radius`);
    if (radius <= 0) invalid(`${label}.radius must be positive`);
    const energy = finite(ownData(raw, 'energy', label), `${label}.energy`);
    const heavy = ownData(raw, 'heavy', label);
    const alive = ownData(raw, 'alive', label);
    if (typeof heavy !== 'boolean') invalid(`${label}.heavy must be a boolean`);
    if (typeof alive !== 'boolean') invalid(`${label}.alive must be a boolean`);
    const lhid = safeInteger(ownData(raw, 'lhid', label), `${label}.lhid`);
    const lht = safeInteger(ownData(raw, 'lht', label), `${label}.lht`);
    if (lht < 0 || lht > 120) invalid(`${label}.lht must be an integer in [0, 120]`);
    const ds = raw.ds === undefined ? 0 : safeInteger(ownData(raw, 'ds', label), `${label}.ds`);
    const da = raw.da === undefined ? 270 : finite(ownData(raw, 'da', label), `${label}.da`);
    const vt = raw.vt === undefined ? 0 : safeInteger(ownData(raw, 'vt', label), `${label}.vt`);
    if (ds < 0 || ds > 100 || da < 0 || da >= 360 || vt < 0 || vt > 6)
      invalid(`${label} has invalid native mode state`);
    const rawSwing = Object.prototype.hasOwnProperty.call(raw, 'swing') ? ownData(raw, 'swing', label) : undefined;
    let swing: { b: number; p: [number, number]; l: number } | undefined;
    if (rawSwing !== undefined) {
      if (!isRecord(rawSwing)) invalid(`${label}.swing must be a plain object`);
      for (const key of Reflect.ownKeys(rawSwing)) {
        if (typeof key !== 'string' || !['b', 'p', 'l'].includes(key))
          invalid(`${label}.swing has unsupported field ${String(key)}`);
      }
      const swingB = nonNegativeInteger(ownData(rawSwing, 'b', `${label}.swing`), `${label}.swing.b`);
      const swingP = ownData(rawSwing, 'p', `${label}.swing`);
      if (!Array.isArray(swingP) || swingP.length !== 2) invalid(`${label}.swing.p must contain two numbers`);
      const swingL = finite(ownData(rawSwing, 'l', `${label}.swing`), `${label}.swing.l`);
      if (swingL < 0) invalid(`${label}.swing.l must be nonnegative`);
      swing = {
        b: swingB,
        p: [finite(swingP[0], `${label}.swing.p[0]`), finite(swingP[1], `${label}.swing.p[1]`)],
        l: swingL,
      };
    }
    const hasSpawn = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
    const sx = hasSpawn('sx') ? finite(ownData(raw, 'sx', label), `${label}.sx`) : x;
    const sy = hasSpawn('sy') ? finite(ownData(raw, 'sy', label), `${label}.sy`) : y;
    const sxv = hasSpawn('sxv') ? finite(ownData(raw, 'sxv', label), `${label}.sxv`) : xv;
    const syv = hasSpawn('syv') ? finite(ownData(raw, 'syv', label), `${label}.syv`) : yv;
    const ni = hasSpawn('ni') ? ownData(raw, 'ni', label) : false;
    if (typeof ni !== 'boolean') invalid(`${label}.ni must be a boolean`);
    return {
      id,
      x,
      y,
      xv,
      yv,
      angle,
      angularVelocity,
      radius,
      energy,
      heavy,
      alive,
      lhid,
      lht,
      sx,
      sy,
      sxv,
      syv,
      ni,
      ds,
      da,
      vt,
      ...(swing === undefined ? {} : { swing }),
    };
  });
  for (const disc of discs) {
    // Native keeps last-hit attribution to eliminated round-entry players.
    // Such a reference is not a live physics dependency; only self-reference
    // is invalid. The mode/session layer still validates arbitrary inputs.
    if (disc.lhid === disc.id) {
      invalid(`discs[lhid=${disc.lhid}] must be -1 or another native player id`);
    }
  }
  return discs;
}

function readProjectiles(value: unknown, label: string): (PhysicsProjectile | undefined)[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map((raw, index): PhysicsProjectile | undefined => {
    const item = `${label}[${index}]`;
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) invalid(`${item} must be a plain object`);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !PROJECTILE_FIELDS.has(key)) {
        invalid(`${item} has unsupported field ${String(key)}`);
      }
    }
    if (ownData(raw, 'type', item) !== 'arrow') invalid(`${item}.type is unsupported`);
    const hasDid = Object.prototype.hasOwnProperty.call(raw, 'did');
    const hasShid = Object.prototype.hasOwnProperty.call(raw, 'shid');
    if (hasDid === hasShid) invalid(`${item} must provide exactly one of did or shid`);
    const did = nonNegativeInteger(hasDid ? ownData(raw, 'did', item) : ownData(raw, 'shid', item), `${item}.did`);
    const hasTeam = Object.prototype.hasOwnProperty.call(raw, 'team');
    const hasShootTeam = Object.prototype.hasOwnProperty.call(raw, 'shootTeam');
    if (hasTeam && hasShootTeam) invalid(`${item} must not provide both team and shootTeam`);
    const team = hasTeam
      ? safeInteger(ownData(raw, 'team', item), `${item}.team`)
      : hasShootTeam
        ? safeInteger(ownData(raw, 'shootTeam', item), `${item}.shootTeam`)
        : 0;
    return {
      x: finite(ownData(raw, 'x', item), `${item}.x`),
      y: finite(ownData(raw, 'y', item), `${item}.y`),
      a: finite(ownData(raw, 'a', item), `${item}.a`),
      av: finite(ownData(raw, 'av', item), `${item}.av`),
      did,
      xv: finite(ownData(raw, 'xv', item), `${item}.xv`),
      yv: finite(ownData(raw, 'yv', item), `${item}.yv`),
      fte: nonNegativeInteger(ownData(raw, 'fte', item), `${item}.fte`),
      type: 'arrow',
      team,
    };
  });
}

function readFrame(value: unknown): ClassicPhysicsFrame {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid('frame must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key !== 'projectiles') {
      invalid(`frame has unsupported field ${String(key)}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'projectiles')) return {};
  return { projectiles: readProjectiles(ownData(value, 'projectiles', 'frame'), 'frame.projectiles') };
}

function readPlatforms(value: unknown): PhysicsPlatform[] {
  if (!Array.isArray(value)) invalid('platforms must be an array');
  return value.map((raw, index) => {
    const label = `platforms[${index}]`;
    if (!isRecord(raw)) invalid(`${label} must be a plain object`);
    const id = nonNegativeInteger(ownData(raw, 'id', label), `${label}.id`);
    const bodyId = nonNegativeInteger(ownData(raw, 'bodyId', label), `${label}.bodyId`);
    const shape = ownData(raw, 'shape', label);
    if (shape !== 'box' && shape !== 'circle' && shape !== 'polygon')
      invalid(`${label}.shape must be "box", "circle" or "polygon"`);
    const x = finite(ownData(raw, 'x', label), `${label}.x`);
    const y = finite(ownData(raw, 'y', label), `${label}.y`);
    const angle = finite(ownData(raw, 'angle', label), `${label}.angle`);
    const color = finite(ownData(raw, 'color', label), `${label}.color`);
    const friction = finite(ownData(raw, 'friction', label), `${label}.friction`);
    const restitution = finite(ownData(raw, 'restitution', label), `${label}.restitution`);
    if (friction > 1) invalid(`${label}.friction must be at most 1`);
    if (restitution < 0) invalid(`${label}.restitution must be non-negative`);
    const lethal = ownData(raw, 'lethal', label);
    if (typeof lethal !== 'boolean') invalid(`${label}.lethal must be a boolean`);
    const rawCapZone = Object.prototype.hasOwnProperty.call(raw, 'capZone')
      ? ownData(raw, 'capZone', label)
      : undefined;
    const rawCapType = Object.prototype.hasOwnProperty.call(raw, 'capType')
      ? ownData(raw, 'capType', label)
      : undefined;
    const capZone = rawCapZone === undefined ? undefined : nonNegativeInteger(rawCapZone, `${label}.capZone`);
    const capType = rawCapType === undefined ? undefined : nonNegativeInteger(rawCapType, `${label}.capType`);
    if ((capZone === undefined) !== (capType === undefined))
      invalid(`${label} capZone and capType must be supplied together`);
    const rawNoGrapple = Object.prototype.hasOwnProperty.call(raw, 'noGrapple')
      ? ownData(raw, 'noGrapple', label)
      : undefined;
    const rawInnerGrapple = Object.prototype.hasOwnProperty.call(raw, 'innerGrapple')
      ? ownData(raw, 'innerGrapple', label)
      : undefined;
    if (rawNoGrapple !== undefined && typeof rawNoGrapple !== 'boolean')
      invalid(`${label}.noGrapple must be a boolean`);
    if (rawInnerGrapple !== undefined && typeof rawInnerGrapple !== 'boolean')
      invalid(`${label}.innerGrapple must be a boolean`);
    const grappleFlags = {
      ...(rawNoGrapple === undefined ? {} : { noGrapple: rawNoGrapple }),
      ...(rawInnerGrapple === undefined ? {} : { innerGrapple: rawInnerGrapple }),
    };
    const transformKeys = ['bodyX', 'bodyY', 'bodyAngle', 'localX', 'localY', 'localAngle'] as const;
    const transforms: Partial<PhysicsPlatform> = {};
    const transformCount = transformKeys.filter((key) => Object.prototype.hasOwnProperty.call(raw, key)).length;
    if (transformCount !== 0 && transformCount !== transformKeys.length) {
      invalid(`${label} must provide all transforms or omit all of them`);
    }
    if (transformCount === transformKeys.length) {
      for (const key of transformKeys) transforms[key] = finite(ownData(raw, key, label), `${label}.${key}`);
    }

    if (shape === 'box') {
      const width = finite(ownData(raw, 'width', label), `${label}.width`);
      const height = finite(ownData(raw, 'height', label), `${label}.height`);
      if (width <= 0 || height <= 0) invalid(`${label} box dimensions must be positive`);
      return {
        id,
        bodyId,
        shape,
        x,
        y,
        width,
        height,
        angle,
        color,
        friction,
        restitution,
        lethal,
        capZone,
        capType,
        ...transforms,
        ...grappleFlags,
      };
    }
    if (shape === 'polygon') {
      const rawVertices = ownData(raw, 'vertices', label);
      if (!Array.isArray(rawVertices) || rawVertices.length < 3 || rawVertices.length > 100)
        invalid(`${label}.vertices must contain 3..100 points`);
      const vertices = rawVertices.map((rawVertex, index) => {
        if (!Array.isArray(rawVertex) || rawVertex.length !== 2)
          invalid(`${label}.vertices[${index}] must contain two numbers`);
        return [
          finite(rawVertex[0], `${label}.vertices[${index}][0]`),
          finite(rawVertex[1], `${label}.vertices[${index}][1]`),
        ] as const;
      });
      return {
        id,
        bodyId,
        shape,
        x,
        y,
        vertices,
        angle,
        color,
        friction,
        restitution,
        lethal,
        capZone,
        capType,
        ...transforms,
        ...grappleFlags,
      };
    }
    const radius = finite(ownData(raw, 'radius', label), `${label}.radius`);
    if (radius <= 0) invalid(`${label}.radius must be positive`);
    return {
      id,
      bodyId,
      shape,
      x,
      y,
      radius,
      angle,
      color,
      friction,
      restitution,
      lethal,
      capZone,
      capType,
      ...transforms,
      ...grappleFlags,
    };
  });
}

function readInputs(value: unknown, discs: readonly PhysicsDisc[]): Map<number, number> {
  if (!isRecord(value)) invalid('inputs must be a plain object keyed by disc id');
  if (Object.getOwnPropertySymbols(value).length > 0) invalid('symbol input keys are not supported');
  const known = new Set(discs.map((disc) => disc.id));
  const inputs = new Map<number, number>();
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!CANONICAL_DECIMAL_ID.test(key)) invalid(`input key ${JSON.stringify(key)} is not a canonical decimal disc id`);
    const id = Number(key);
    if (!known.has(id)) invalid(`input for unknown disc id ${key}`);
    const raw = ownData(value, key, 'inputs');
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 63) {
      invalid(`input for disc ${key} must be an integer in [0, 63]`);
    }
    inputs.set(id, raw);
  }
  for (const disc of discs) {
    if (!inputs.has(disc.id)) invalid(`missing input for disc ${disc.id}`);
  }
  return inputs;
}

interface PlatformTransforms {
  bodyX: number;
  bodyY: number;
  bodyAngle: number;
  localX: number;
  localY: number;
  localAngle: number;
}

function platformTransforms(platform: PhysicsPlatform): PlatformTransforms {
  if (platform.bodyX === undefined) {
    return {
      bodyX: platform.x,
      bodyY: platform.y,
      bodyAngle: platform.angle,
      localX: 0,
      localY: 0,
      localAngle: 0,
    };
  }
  return {
    bodyX: platform.bodyX,
    bodyY: platform.bodyY!,
    bodyAngle: platform.bodyAngle!,
    localX: platform.localX!,
    localY: platform.localY!,
    localAngle: platform.localAngle!,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(Math.min(value, maximum), minimum);
}

function canonicalRadius(balance: number | undefined): number {
  return 1 + clamp((balance ?? 0) / 100, -0.95, 1);
}

function sortedDiscsForRelease(discs: readonly PhysicsDisc[]): PhysicsDisc[] {
  return discs.slice().sort((a, b) => a.id - b.id);
}

export function createClassicPhysics(): ClassicPhysics {
  const B = createBackend();
  const Vec2 = B.Common.Math.b2Vec2;
  let world: any = new B.Dynamics.b2World(new Vec2(0, GRAVITY_Y));
  world.SetWarmStarting(false);

  const listener = new B.Dynamics.b2ContactListener();
  let lethalHits = new Set<number>();
  let contactDiscs = new Map<number, PhysicsDisc>();
  let contactNoCollision = false;
  let contactMode: 'b' | 'ar' | 'ard' | 'v' | 'sp' | 'bs' = 'b';
  let contactTeams: readonly number[] = [];
  let contactTeamCollision = false;
  let swingCollideDestroyEvents: number[] = [];
  let retainedSwings = new Set<number>();
  let arrowContacts: { projectile: number; disc: number | null; world: boolean }[] = [];
  let capZoneContacts: { zone: number; fixtureId: number; disc: number }[] = [];
  let capZoneTeamGoals: { zone: number; team: number }[] = [];
  const arrowContact = (contact: any, arrow: any, other: any): void => {
    if (other && other.type === 'disc') {
      const disc = contactDiscs.get(other.arrayID);
      if (
        other.arrayID === arrow.discID ||
        (contactTeamCollision && disc && (contactTeams[disc.id] ?? 1) === arrow.team)
      ) {
        contact.SetEnabled(false);
        return;
      }
      arrow.hitDiscsThisStep.push(other.arrayID);
      arrowContacts.push({ projectile: arrow.arrayID, disc: other.arrayID, world: false });
      if (contactMode === 'ard') lethalHits.add(other.arrayID);
      return;
    }
    arrow.hitWorldThisStep = true;
    arrowContacts.push({ projectile: arrow.arrayID, disc: null, world: true });
  };
  listener.BeginContact = (contact: any): void => {
    const fixtureA = contact.GetFixtureA();
    const fixtureB = contact.GetFixtureB();
    const dataA = fixtureA.GetUserData();
    const dataB = fixtureB.GetUserData();
    const bodyA = fixtureA.GetBody().GetUserData();
    const bodyB = fixtureB.GetBody().GetUserData();
    for (let index = 0; index < 2; index++) {
      const subjectData = index === 0 ? dataA : dataB;
      const body = index === 0 ? bodyA : bodyB;
      const other = index === 0 ? bodyB : bodyA;
      const otherData = index === 0 ? dataB : dataA;
      if (body && body.type === 'disc' && otherData && otherData.death === true) lethalHits.add(body.arrayID);
      // Native listener (5383-5405, 4851-4886) disables disc/fixture sensor
      // contacts. Only the primary disc fixture feeds the timed-cap collection;
      // VTOL wing contacts are disabled but never counted.
      if (body && body.type === 'disc' && other && other.type === 'phys' && otherData && otherData.capzone === true) {
        if (otherData.capType === 1 && subjectData && subjectData.type === 'discbody') {
          capZoneContacts.push({ zone: otherData.capID, fixtureId: otherData.fixtureID, disc: body.arrayID });
          contact.SetEnabled(false);
        } else if (subjectData && subjectData.type === 'discwing') {
          contact.SetEnabled(false);
        }
      }
      if (body && body.type === 'arrow' && other && other.type === 'phys' && otherData && otherData.capzone === true) {
        contact.SetEnabled(false);
      }
      // Instant goals are driven by map physics bodies, never directly by a
      // disc; the triggering contact is disabled as in the native listener.
      if (
        body &&
        body.type === 'phys' &&
        other &&
        other.type === 'phys' &&
        otherData &&
        otherData.capzone === true &&
        otherData.capType !== 1
      ) {
        capZoneTeamGoals.push({ zone: otherData.capID, team: otherData.capType });
        contact.SetEnabled(false);
      }
      if (body && body.type === 'disc' && other && other.type === 'disc') {
        const discA = contactDiscs.get(body.arrayID);
        const discB = contactDiscs.get(other.arrayID);
        if (
          contactNoCollision ||
          (contactTeamCollision && discA && discB && (contactTeams[discA.id] ?? 1) === (contactTeams[discB.id] ?? 1))
        ) {
          contact.SetEnabled(false);
        } else if (discA !== undefined && discB !== undefined) {
          // Native (4899-4903): a swinging disc loses its swing on any enabled
          // disc-disc contact; the event is consumed by the retention gate.
          // The native check reads stepDiscs[i].swing — the retained boolean
          // (swing object present AND action2 held this tick).
          if (discA.swing !== undefined && retainedSwings.has(discA.id)) swingCollideDestroyEvents.push(discA.id);
          if (discB.swing !== undefined && retainedSwings.has(discB.id)) swingCollideDestroyEvents.push(discB.id);
          discA.lhid = discB.id;
          discB.lhid = discA.id;
          discA.lht = 120;
          discB.lht = 120;
        }
      }
      if (body && body.type === 'arrow') arrowContact(contact, body, other);
    }
  };
  // Native PostSolve (5027-5044): disc/phys contacts accumulate the normal
  // impulse on the disc body's userData. Disc/disc contacts never accumulate.
  // The grapple retention gate reads this counter after the step.
  listener.PostSolve = (contact: any, impulse: any): void => {
    const bodyA = contact.GetFixtureA().GetBody();
    const bodyB = contact.GetFixtureB().GetBody();
    const dataA = bodyA.GetUserData();
    const dataB = bodyB.GetUserData();
    if (dataA?.type === 'disc' && dataB?.type === 'phys') dataA.impulsesThisStep += impulse.normalImpulses[0];
    else if (dataA?.type === 'phys' && dataB?.type === 'disc') dataB.impulsesThisStep += impulse.normalImpulses[0];
  };

  let disposed = false;

  function stepWorld(
    rawDiscs: readonly PhysicsDisc[],
    rawPlatforms: readonly PhysicsPlatform[],
    rawInputs: Readonly<Record<number, number>>,
    rawOptions: ClassicPhysicsOptions,
    rawFrame?: ClassicPhysicsFrame,
  ): ClassicPhysicsWorld {
    if (disposed) throw new Error('Classic physics instance has been disposed');

    const discs = readDiscs(rawDiscs);
    const platforms = readPlatforms(rawPlatforms);
    const transforms = platforms.map(platformTransforms);
    const inputs = readInputs(rawInputs, discs);
    const options = readOptions(rawOptions);
    const frame = readFrame(rawFrame);
    const projectiles =
      frame.projectiles?.map((projectile) => (projectile === undefined ? undefined : { ...projectile })) ?? [];
    if (projectiles.length > 0 && options.mode !== 'ar' && options.mode !== 'ard')
      invalid('projectiles require Arrow mode');
    if (options.mode !== 'ar' && options.mode !== 'ard' && options.mode !== 'sp') {
      for (const bits of inputs.values())
        if (bits & INPUT_SECONDARY) invalid('secondary input requires Arrow or Grapple mode');
    }
    const releasedArrows: PhysicsProjectile[] = [];
    if (options.simulate && (options.mode === 'ar' || options.mode === 'ard')) {
      for (const disc of sortedDiscsForRelease(discs)) {
        const bits = inputs.get(disc.id)!;
        if (disc.alive && (bits & INPUT_SECONDARY) === 0 && disc.ds! > 0) {
          const angle = disc.da! * (Math.PI / 180);
          const speed = ARROW_SPEED_BASE + disc.ds!;
          releasedArrows.push({
            x: disc.x + safeCos(angle),
            y: disc.y + safeSin(angle),
            a: angle,
            av: 0,
            did: disc.id,
            xv: safeCos(angle) * speed,
            yv: safeSin(angle) * speed,
            fte: ARROW_LIFETIME,
            type: 'arrow',
            team: options.teams![disc.id] ?? 1,
          });
        }
      }
    }
    const radii = new Map(discs.map((disc) => [disc.id, canonicalRadius(options.balances?.[disc.id])]));
    for (const disc of discs) {
      if (disc.lht !== 0) disc.lht -= 1;
      if (disc.lht === 0) disc.lhid = -1;
    }
    const bodyTransforms = new Map<number, string>();
    for (let index = 0; index < platforms.length; index++) {
      const platform = platforms[index];
      const transform = transforms[index];
      const key = JSON.stringify([transform.bodyX, transform.bodyY, transform.bodyAngle]);
      const existing = bodyTransforms.get(platform.bodyId);
      if (existing !== undefined && existing !== key) {
        invalid('Shared static body requires matching explicit local transforms');
      }
      bodyTransforms.set(platform.bodyId, key);
    }

    world.novakReset();
    if (world.GetGravity().y !== GRAVITY_Y) world.SetGravity(new Vec2(0, GRAVITY_Y));
    contactDiscs = new Map(discs.map((disc) => [disc.id, disc]));
    contactNoCollision = options.noCollision;
    contactMode = options.mode!;
    contactTeams = options.teams!;
    contactTeamCollision = options.teamCollision!;
    swingCollideDestroyEvents = [];
    retainedSwings = new Set();
    arrowContacts = [];
    capZoneContacts = [];
    capZoneTeamGoals = [];
    world.SetContactListener(listener);
    lethalHits = new Set<number>();

    const Body = B.Dynamics.b2Body;
    const CircleShape = B.Collision.Shapes.b2CircleShape;
    const PolygonShape = B.Collision.Shapes.b2PolygonShape;
    const BodyDef = B.Dynamics.b2BodyDef;
    const FixtureDef = B.Dynamics.b2FixtureDef;

    const sortedDiscs = discs.slice().sort((left, right) => left.id - right.id);
    const created = new Map<number, any>();
    const energies = new Map<number, number>();
    const firedSwings = new Set<number>();
    const arrowDrawStates = new Map<number, boolean>();
    const vtolMoves = new Map<number, VtolMoveType>();
    const projectileBodies = new Map<number, any>();
    const projectileRecords = new Map<number, any>();
    const releasedIds = new Set(releasedArrows.map((arrow) => arrow.did));

    for (const [index, arrow] of projectiles.entries()) {
      if (!arrow || arrow.fte <= 0) continue;
      const definition = new BodyDef();
      definition.type = Body.b2_dynamicBody;
      definition.position.Set(arrow.x, arrow.y);
      const velocity = new Vec2(arrow.xv, arrow.yv);
      if (velocity.Length() > ARROW_MIN_ANGLE_SPEED) {
        definition.angle = safeATan2(arrow.yv, arrow.xv);
        definition.angularVelocity = 0;
      } else {
        definition.angle = arrow.a;
        definition.angularVelocity = arrow.av;
      }
      definition.angularDamping = 0;
      definition.bullet = true;
      definition.userData = {
        type: arrow.type,
        arrayID: index,
        discID: arrow.did,
        hitDiscsThisStep: [],
        hitWorldThisStep: false,
        destroyThisStep: false,
        team: arrow.team,
        fte: arrow.fte,
      };
      const body = world.CreateBody(definition);
      const shape = new PolygonShape();
      shape.SetAsOrientedBox(ARROW_HALF_WIDTH, ARROW_HALF_HEIGHT, new Vec2(0, 0), 0);
      const fixture = new FixtureDef();
      fixture.shape = shape;
      fixture.density = ARROW_DENSITY;
      fixture.friction = ARROW_FRICTION;
      fixture.restitution = ARROW_RESTITUTION;
      fixture.userData = { type: arrow.type, arrayID: index };
      body.CreateFixture(fixture);
      body.SetLinearVelocity(velocity);
      projectileBodies.set(index, body);
      projectileRecords.set(index, definition.userData);
    }

    for (const disc of sortedDiscs) {
      if (!disc.alive) continue;
      const bits = inputs.get(disc.id)!;
      const radius = radii.get(disc.id)!;
      const heavy = (bits & INPUT_HEAVY) !== 0;
      // Native reads the pre-step draw state for both density and movement
      // force before incrementing ds for a new charge. In particular, the
      // first directional input on the charge tick still applies force.
      const arrowDrawing = (options.mode === 'ar' || options.mode === 'ard') && disc.ds !== 0;
      arrowDrawStates.set(disc.id, arrowDrawing);
      let energy = clamp(disc.energy, 0, 1000);
      // Native swing retention (5221-5226): the joint is rebuilt only while the
      // input state carries a swing and the previous input held action2. The
      // physics layer models held action2 as the current input bits; a released
      // button simply stops rebuilding the joint next tick without zeroing energy.
      const retainedSwing = options.mode === 'sp' && disc.swing !== undefined && (bits & INPUT_SECONDARY) !== 0;
      if (retainedSwing) retainedSwings.add(disc.id);
      // Native heavy meter (5228-5244) applies only to modes b and v; Simple
      // mode bs (5278) has no drain/recharge branch, so its energy is frozen.
      if (options.mode === 'b' || options.mode === 'v') {
        if (heavy) energy = Math.max(0, energy - 10);
        else energy = Math.min(1000, energy + 5);
      } else if (options.mode === 'sp') {
        // Native grapple energy (5246-5267), applied before the fire gate.
        if (retainedSwing) {
          energy = Math.max(0, energy - GRAPPLE_ENERGY_DRAIN);
          if (energy < GRAPPLE_ENERGY_THRESHOLD) {
            energy = 0;
            disc.swing = undefined;
          }
        } else {
          energy = Math.min(1000, energy + GRAPPLE_ENERGY_RECHARGE);
        }
      } else if (options.simulate && (options.mode === 'ar' || options.mode === 'ard')) {
        // Native arrow recharge (5268-5272) requires ftu == -1 and ar/ard only.
        energy = Math.min(1000, energy + 8);
      }
      if (releasedIds.has(disc.id)) {
        energy = ARROW_FIRE_ENERGY;
        disc.ds = 0;
      }
      // Arrow fire energy is the mode-specific post-release override.
      energies.set(disc.id, releasedIds.has(disc.id) ? ARROW_FIRE_ENERGY : energy);
      if (
        options.simulate &&
        (options.mode === 'ar' || options.mode === 'ard') &&
        (bits & INPUT_SECONDARY) !== 0 &&
        energy === 1000
      ) {
        if (disc.ds! < 100) disc.ds = disc.ds! + 1;
        if ((bits & INPUT_LEFT) !== 0) disc.da = wrapDegrees(disc.da! - 5);
        if ((bits & INPUT_RIGHT) !== 0) disc.da = wrapDegrees(disc.da! + 5);
      }
      if (options.mode === 'v' && options.simulate) {
        const move = vtolMoveType(bits);
        vtolMoves.set(disc.id, move);
        disc.vt = VTOL_VT[move];
      }

      // Native heavy density (5276-5289) requires a1 && mo != "bs" && ds == 0.
      // Simple mode bs therefore always uses the base density.
      const density =
        heavy && !arrowDrawing && options.mode !== 'bs'
          ? BASE_DENSITY + HEAVY_MULTIPLIER * (energy / 1000) * BASE_DENSITY
          : BASE_DENSITY;

      const bodyDefinition = new BodyDef();
      bodyDefinition.type = Body.b2_dynamicBody;
      bodyDefinition.position.Set(disc.x, disc.y);
      bodyDefinition.fixedRotation = options.mode !== 'v';
      bodyDefinition.linearDamping = DISC_LINEAR_DAMPING;
      bodyDefinition.linearVelocity.Set(disc.xv, disc.yv);
      bodyDefinition.angularVelocity = disc.angularVelocity;
      bodyDefinition.angle = disc.angle;
      bodyDefinition.angularDamping = DISC_ANGULAR_DAMPING;
      bodyDefinition.bullet = true;
      bodyDefinition.userData = { type: 'disc', arrayID: disc.id, impulsesThisStep: 0 };
      const body = world.CreateBody(bodyDefinition);

      const fixtureDefinition = new FixtureDef();
      fixtureDefinition.shape = new CircleShape(radius);
      fixtureDefinition.density = density;
      fixtureDefinition.friction = DISC_DENSITY_FRICTION;
      fixtureDefinition.restitution = DISC_RESTITUTION;
      fixtureDefinition.filter.categoryBits = 1;
      fixtureDefinition.filter.maskBits = 0xffff;
      fixtureDefinition.filter.groupIndex = 0;
      fixtureDefinition.userData = { type: 'discbody' };
      body.CreateFixture(fixtureDefinition);

      if (options.mode === 'v') {
        for (const offsetX of [FOOT_OFFSET_X, -FOOT_OFFSET_X]) {
          const wingDefinition = new FixtureDef();
          const wingShape = new PolygonShape();
          wingShape.SetAsOrientedBox(
            FOOT_HALF_WIDTH * radius,
            FOOT_HALF_HEIGHT * radius,
            new Vec2(offsetX * radius, FOOT_OFFSET_Y * radius),
            0,
          );
          wingDefinition.shape = wingShape;
          wingDefinition.density = WING_DENSITY;
          wingDefinition.friction = WING_FRICTION;
          wingDefinition.restitution = WING_RESTITUTION;
          wingDefinition.filter.categoryBits = 1;
          wingDefinition.filter.maskBits = 0xffff;
          wingDefinition.filter.groupIndex = 0;
          wingDefinition.userData = { type: 'discwing' };
          body.CreateFixture(wingDefinition);
        }
      }

      body.SetLinearVelocity(new Vec2(disc.xv, disc.yv));
      created.set(disc.id, body);
    }

    const staticBodies = new Map<number, any>();
    for (let platformIndex = 0; platformIndex < platforms.length; platformIndex++) {
      const platform = platforms[platformIndex];
      const transform = transforms[platformIndex];
      let body = staticBodies.get(platform.bodyId);
      if (!body) {
        const bodyDefinition = new BodyDef();
        bodyDefinition.type = Body.b2_staticBody;
        // Native body placement is (map coordinate + origin) / ppm. Do not
        // reconstruct it from the separately rounded render transform.
        bodyDefinition.position.Set(transform.bodyX, transform.bodyY);
        bodyDefinition.angle = transform.bodyAngle;
        bodyDefinition.userData = { type: 'phys', arrayID: platform.bodyId };
        body = world.CreateBody(bodyDefinition);
        staticBodies.set(platform.bodyId, body);
      }

      const fixtureDefinition = new FixtureDef();
      if (platform.shape === 'box') {
        const shape = new PolygonShape();
        const halfWidth = platform.width! / 2;
        const halfHeight = platform.height! / 2;
        const cos = safeCos(transform.localAngle);
        const sin = safeSin(transform.localAngle);
        // Keep native clockwise-from-top-right vertex order, rather than the
        // backend SetAsBox ordering; tied contact selection can depend on it.
        const vertices = [
          [halfWidth, -halfHeight],
          [halfWidth, halfHeight],
          [-halfWidth, halfHeight],
          [-halfWidth, -halfHeight],
        ].map(([x, y]) => new Vec2(cos * x - sin * y + transform.localX, sin * x + cos * y + transform.localY));
        shape.SetAsArray(vertices);
        fixtureDefinition.shape = shape;
      } else if (platform.shape === 'circle') {
        fixtureDefinition.shape = new CircleShape(platform.radius!);
        fixtureDefinition.shape.SetLocalPosition(new Vec2(transform.localX, transform.localY));
      } else {
        const shape = new PolygonShape();
        shape.SetAsArray(platform.vertices!.map(([x, y]) => new Vec2(x + transform.localX, y + transform.localY)));
        fixtureDefinition.shape = shape;
      }
      fixtureDefinition.friction = platform.friction;
      fixtureDefinition.restitution = platform.restitution;
      fixtureDefinition.filter.categoryBits = STATIC_CATEGORY;
      fixtureDefinition.filter.maskBits = 0xffff;
      fixtureDefinition.filter.groupIndex = 0;
      fixtureDefinition.userData = {
        type: 'phys',
        death: platform.lethal,
        fixtureID: platform.id,
        ...(platform.capZone === undefined
          ? {}
          : { capzone: true, capID: platform.capZone, capType: platform.capType }),
        ...(platform.noGrapple === true ? { noGrapple: true } : {}),
        ...(platform.innerGrapple === true ? { innerGrapple: true } : {}),
      };
      body.CreateFixture(fixtureDefinition);
    }

    // Native grapple joint rebuild (5947-5989): only for a retained swing
    // (stepDiscs[i].swing — swing object present AND action2 held this tick),
    // the distance joint is re-created each tick from the persisted attachment.
    // The anchor rides the map body's current transform; the slack/taut
    // frequency selection uses the live disc/anchor separation.
    if (options.mode === 'sp') {
      for (const disc of sortedDiscs) {
        if (!disc.alive || disc.swing === undefined || !retainedSwings.has(disc.id)) continue;
        const discBody = created.get(disc.id);
        const targetBody = staticBodies.get(disc.swing.b);
        if (discBody === undefined || targetBody === undefined) continue;
        const anchorWorld = targetBody.GetWorldPoint(new Vec2(disc.swing.p[0], disc.swing.p[1]));
        const discPosition = discBody.GetPosition();
        const distanceFromPlayer = Math.sqrt(
          (discPosition.x - anchorWorld.x) ** 2 + (discPosition.y - anchorWorld.y) ** 2,
        );
        const jointDefinition = new B.Dynamics.Joints.b2DistanceJointDef();
        jointDefinition.bodyA = discBody;
        jointDefinition.bodyB = targetBody;
        jointDefinition.localAnchorA.Set(0, 0);
        jointDefinition.localAnchorB.Set(disc.swing.p[0], disc.swing.p[1]);
        jointDefinition.length = disc.swing.l;
        jointDefinition.frequencyHz =
          distanceFromPlayer < disc.swing.l ? GRAPPLE_SLACK_FREQUENCY : GRAPPLE_SWING_FREQUENCY;
        jointDefinition.dampingRatio = GRAPPLE_SWING_DAMPING;
        jointDefinition.collideConnected = true;
        world.CreateJoint(jointDefinition);
      }
    }

    if (options.simulate) {
      for (const disc of sortedDiscs) {
        if (!disc.alive) continue;
        const bits = inputs.get(disc.id)!;
        const body = created.get(disc.id)!;
        const radius = radii.get(disc.id)!;
        const radiusSquared = (Math.PI * radius * radius) / (Math.PI * 1 * 1);
        const arrowDrawing = arrowDrawStates.get(disc.id)!;
        if (options.mode !== 'v' && !arrowDrawing) {
          const force = new Vec2(0, 0);
          const maximum = (options.fly ? FLY_FORCE : MAX_FORCE) * radiusSquared;
          if ((bits & INPUT_UP) !== 0) force.y = -maximum;
          else if ((bits & INPUT_DOWN) !== 0) force.y = maximum;
          if ((bits & INPUT_LEFT) !== 0) force.x = -maximum;
          else if ((bits & INPUT_RIGHT) !== 0) force.x = maximum;
          if ((bits & INPUT_HEAVY) !== 0) force.Multiply(0.7);
          body.ApplyForce(force, body.GetWorldCenter());
        }

        if (options.mode === 'v' && options.simulate) {
          const move = vtolMoves.get(disc.id) ?? 'none';
          if (move !== 'none') {
            const down = move === 'downboth' || move === 'downleft' || move === 'downright';
            const strength = (down ? -VTOL_IMPULSE : VTOL_IMPULSE) * radiusSquared;
            const weakStrength = strength * VTOL_WEAK_IMPULSE;
            const fullImpulse = body.GetWorldVector(new Vec2(0, strength));
            const weakImpulse = body.GetWorldVector(new Vec2(0, weakStrength));
            const leftPoint = body.GetWorldPoint(
              new Vec2(FOOT_OFFSET_X * radiusSquared, FOOT_OFFSET_Y * radiusSquared),
            );
            const rightPoint = body.GetWorldPoint(
              new Vec2(-FOOT_OFFSET_X * radiusSquared, FOOT_OFFSET_Y * radiusSquared),
            );
            if (move === 'both' || move === 'downboth') {
              body.ApplyImpulse(fullImpulse, leftPoint);
              body.ApplyImpulse(fullImpulse, rightPoint);
            } else if (move === 'left' || move === 'downright') {
              body.ApplyImpulse(fullImpulse, leftPoint);
              body.ApplyImpulse(weakImpulse, rightPoint);
            } else {
              body.ApplyImpulse(weakImpulse, leftPoint);
              body.ApplyImpulse(fullImpulse, rightPoint);
            }
          }
        }

        // Native grapple fire gate (6344-6528): no existing swing, action2 held
        // this tick, sp mode, and post-energy-update energy above the threshold.
        // The attachment is stored only; the joint is created on the NEXT tick.
        if (
          options.mode === 'sp' &&
          disc.swing === undefined &&
          (bits & INPUT_SECONDARY) !== 0 &&
          energies.get(disc.id)! > GRAPPLE_ENERGY_THRESHOLD
        ) {
          const discPosition = new Vec2(disc.x, disc.y);
          const candidates: any[] = [];
          const aabb = new B.Collision.b2AABB();
          aabb.lowerBound = new Vec2(discPosition.x - GRAPPLE_QUERY_RADIUS, discPosition.y - GRAPPLE_QUERY_RADIUS);
          aabb.upperBound = new Vec2(discPosition.x + GRAPPLE_QUERY_RADIUS, discPosition.y + GRAPPLE_QUERY_RADIUS);
          world.QueryAABB((fixture: any): boolean => {
            const bodyData = fixture.GetBody().GetUserData();
            const fixtureData = fixture.GetUserData();
            // Native filter (6351-6371): phys bodies only, never capzone or
            // noGrapple fixtures. Static fixtures carry no active fz here.
            if (bodyData?.type !== 'phys' || fixtureData?.capzone === true || fixtureData?.noGrapple === true)
              return true;
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
              const offset = new Vec2(discPosition.x - center.x, discPosition.y - center.y);
              const centerDistance = offset.Length();
              const hitLength = centerDistance - shape.GetRadius();
              if (hitLength < GRAPPLE_QUERY_RADIUS) {
                const hitRatio = centerDistance > 0 ? hitLength / centerDistance : 0;
                const anchor = new Vec2(offset.x * hitRatio + discPosition.x, offset.y * hitRatio + discPosition.y);
                scored.push({ body: targetBody, fixture, wp: anchor, d: hitLength });
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
                    ? ((discPosition.x - start.x) * segmentX + (discPosition.y - start.y) * segmentY) / lengthSquared
                    : 0;
                ratio = Math.max(0, Math.min(1, ratio));
                const projection = new Vec2(start.x + segmentX * ratio, start.y + segmentY * ratio);
                const distance = Math.sqrt((projection.x - discPosition.x) ** 2 + (projection.y - discPosition.y) ** 2);
                if (distance < GRAPPLE_QUERY_RADIUS) {
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
              firedSwings.add(disc.id);
              break;
            }
          }
        }

        if ((bits & INPUT_UP) !== 0 && Math.abs(body.GetLinearVelocity().y) < 4) {
          const start = new Vec2(disc.x, disc.y);
          const end = new Vec2(disc.x, disc.y + (radius + 0.15));
          world.RayCast(
            (fixture: any): number => {
              const bodyData = fixture.GetBody().GetUserData();
              if (!bodyData || bodyData.type !== 'phys') return -1;
              const fixtureData = fixture.GetUserData();
              const maskBits = fixture.GetFilterData().maskBits;
              const collidesWithDisc = (1 & maskBits) === 1;
              if (!fixtureData || fixtureData.death === true || !collidesWithDisc) return -1;
              body.GetLinearVelocity().y -= 10;
              return 0;
            },
            start,
            end,
          );
        }
      }

      const velocityIterations = options.quality === 2 ? 15 : 2;
      const positionIterations = options.quality === 2 ? 15 : 6;
      world.Step(DT, velocityIterations, positionIterations);
    }
    world.ClearForces();

    // Native step order (pinned alpha2s.slot-accurate.numeric.js): contact
    // deaths are cause 1 (4848/4930), bounds deaths are cause 4 (6975-6982)
    // and overwrite an earlier cause. Respawn restores sx/sy/sxv/syv and sets
    // ni on the same step (7114-7203); cause 3 capture is permanent.
    const deathCauses = new Map<number, 'lethal-contact' | 'arrow' | 'out-of-world' | 'capture'>();
    for (const disc of discs) {
      if (!disc.alive || !lethalHits.has(disc.id)) continue;
      deathCauses.set(disc.id, options.mode === 'ard' ? 'arrow' : 'lethal-contact');
    }
    if (options.ppm !== undefined) {
      const floor = WORLD_FLOOR / options.ppm;
      const radius = WORLD_RADIUS / options.ppm;
      const centerX = WORLD_HALF_WIDTH / options.ppm;
      const centerY = WORLD_HALF_HEIGHT / options.ppm;
      for (const disc of discs) {
        if (!disc.alive) continue;
        const body = created.get(disc.id);
        if (body === undefined) continue;
        const position = body.GetPosition();
        const radial = Math.sqrt((position.x - centerX) ** 2 + (position.y - centerY) ** 2);
        if (position.y > floor || radial > radius) deathCauses.set(disc.id, 'out-of-world');
      }
    }

    const output: PhysicsDisc[] = discs.map((disc) => {
      const body = created.get(disc.id);
      if (body === undefined) {
        return { ...disc, radius: radii.get(disc.id)!, ni: false };
      }
      const cause = deathCauses.get(disc.id);
      // Native respawn is immediate in the same step and restores only the
      // authored round spawn position/velocity. Capture (cause 3) is permanent.
      const respawned = cause !== undefined && cause !== 'capture' && options.respawn === true;
      const x = respawned ? disc.sx! : body.GetPosition().x;
      const y = respawned ? disc.sy! : body.GetPosition().y;
      const xv = respawned ? disc.sxv! : body.GetLinearVelocity().x;
      const yv = respawned ? disc.syv! : body.GetLinearVelocity().y;
      // Native grapple retention gate (7177-7187): a swing present on the
      // rebuilt joint survives only without a disc-disc collision event and
      // with accumulated normal impulses below the break threshold; otherwise
      // the swing is dropped and energy is zeroed. Respawn deletes the swing
      // (7202); a newly fired attachment (7167-7175) is serialized as-is.
      let swing: { b: number; p: [number, number]; l: number } | undefined;
      let energy = energies.get(disc.id)!;
      if (options.mode === 'sp') {
        if (retainedSwings.has(disc.id)) {
          const impulse = body.GetUserData().impulsesThisStep as number;
          if (!swingCollideDestroyEvents.includes(disc.id) && impulse < GRAPPLE_BREAK_IMPULSE) {
            swing = disc.swing;
          } else {
            energy = 0;
          }
        } else if (firedSwings.has(disc.id)) {
          // Native (7167-7175): a newly fired attachment this tick is
          // serialized as-is, independent of the retention gate.
          swing = disc.swing;
        }
        if (respawned) swing = undefined;
      }
      return {
        id: disc.id,
        x,
        y,
        xv,
        yv,
        angle: body.GetAngle(),
        angularVelocity: body.GetAngularVelocity(),
        radius: radii.get(disc.id)!,
        energy,
        heavy: (inputs.get(disc.id)! & INPUT_HEAVY) !== 0,
        alive: disc.alive && (cause === undefined || respawned),
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
    const outputProjectiles: (PhysicsProjectile | undefined)[] = Array.from(
      { length: projectiles.length },
      () => undefined,
    );
    projectiles.forEach((arrow, index) => {
      if (!arrow) return;
      const record = projectileRecords.get(index);
      const body = projectileBodies.get(index);
      if (!body || !record || record.destroyThisStep || record.fte <= 0) return;
      outputProjectiles[index] = {
        x: body.GetPosition().x,
        y: body.GetPosition().y,
        xv: body.GetLinearVelocity().x,
        yv: body.GetLinearVelocity().y,
        a: body.GetAngle(),
        av: body.GetAngularVelocity(),
        did: arrow.did,
        fte: Math.max(0, arrow.fte - 1),
        type: arrow.type,
        team: arrow.team,
      };
    });
    while (outputProjectiles.length > 0 && outputProjectiles[outputProjectiles.length - 1] === undefined)
      outputProjectiles.pop();
    outputProjectiles.push(...releasedArrows);
    const outputPlatforms: readonly PhysicsPlatform[] = Object.freeze(
      platforms.map((platform, index) => {
        const transform = transforms[index];
        const body = staticBodies.get(platform.bodyId)!;
        const position = body.GetPosition();
        const bodyX = position.x;
        const bodyY = position.y;
        const bodyAngle = body.GetAngle();
        const cos = safeCos(bodyAngle);
        const sin = safeSin(bodyAngle);
        return Object.freeze({
          id: platform.id,
          bodyId: platform.bodyId,
          shape: platform.shape,
          ...(platform.shape === 'box'
            ? { width: platform.width!, height: platform.height! }
            : platform.shape === 'circle'
              ? { radius: platform.radius! }
              : { vertices: platform.vertices!.map((vertex) => [...vertex] as const) }),
          bodyX,
          bodyY,
          bodyAngle,
          localX: transform.localX,
          localY: transform.localY,
          localAngle: transform.localAngle,
          x: bodyX + cos * transform.localX - sin * transform.localY,
          y: bodyY + sin * transform.localX + cos * transform.localY,
          angle: bodyAngle + transform.localAngle,
          color: platform.color,
          friction: platform.friction,
          restitution: platform.restitution,
          lethal: platform.lethal,
          ...(platform.capZone === undefined ? {} : { capZone: platform.capZone, capType: platform.capType }),
          ...(platform.noGrapple === true ? { noGrapple: true } : {}),
          ...(platform.innerGrapple === true ? { innerGrapple: true } : {}),
        });
      }),
    );
    while (world.GetBodyList()) world.DestroyBody(world.GetBodyList());
    while (world.GetJointList()) world.DestroyJoint(world.GetJointList());
    const hits = output
      .filter((disc) => disc.lht > 0 && disc.lhid >= 0)
      .map((disc) => Object.freeze({ player: disc.id, other: disc.lhid }));
    const deaths = Array.from(deathCauses, ([id, cause]) => {
      const body = created.get(id);
      const position = body?.GetPosition();
      const velocity = body?.GetLinearVelocity();
      return Object.freeze({
        id,
        cause,
        ...(body === undefined ? {} : { x: position.x, y: position.y, xv: velocity.x, yv: velocity.y }),
      });
    });
    return {
      discs: output,
      platforms: outputPlatforms,
      projectiles: outputProjectiles,
      arrowContacts,
      capZoneContacts,
      capZoneTeamGoals,
      hits,
      deaths,
    };
  }

  function step(
    discs: readonly PhysicsDisc[],
    platforms: readonly PhysicsPlatform[],
    inputs: Readonly<Record<number, number>>,
    options: ClassicPhysicsOptions,
    frame?: ClassicPhysicsFrame,
  ): PhysicsDisc[] {
    return stepWorld(discs, platforms, inputs, options, frame).discs;
  }

  return {
    step,
    stepWorld,
    stepDetailed: stepWorld,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lethalHits = new Set<number>();
      world.novakReset();
      world = null;
    },
  };
}
