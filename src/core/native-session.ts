/**
 * Native Classic match/session state on a normalized static or dynamic arena.
 *
 * Ownership boundary: this module owns native IDs, spawn dealing, countdown,
 * elimination/scoring, result delay, round rollover and death-animation data.
 * Static maps use the verified ClassicPhysics backend. Dynamic maps and capture
 * zones use one NativeClassicWorld so map bodies and discs share each Box2D
 * Step; the two backends are never combined for the same arena.
 *
 * Source pins are alpha2s.slot-accurate.js createNewState 3734-4288 and step
 * 5946-6445 (raw numeric createNewState 4090 onward; step 6538 onward). There
 * are no browser, timer, DOM, network, map-loader or cross-repository imports.
 */
import {
  createClassicPhysics,
  type ClassicPhysics,
  type ClassicPhysicsWorld,
  type PhysicsDisc,
  type PhysicsPlatform,
} from './classic-physics';
import {
  dealNativeSpawns,
  validateNativeSpawns,
  type NativeSpawn,
  type NativeSpawnPlayer,
  type NativeTeam,
} from './native-spawns';
import { safeATan2, safeCos, safeSin } from './safe-trig';
import {
  createNativeClassicWorld,
  createNativeClassicCapZones,
  type NativeClassicCapZone,
  type NativeClassicContact,
  type NativeClassicTeamGoal,
  type NativeClassicWorld,
} from './native-classic-world';
import {
  cloneNativeMapPhysics,
  normalizeNativeMap,
  type NativeMapPhysics,
  type NativeMapSource,
} from './native-map-state';

export type { NativeSpawn, NativeSpawnPlayer, NativeTeam } from './native-spawns';
export type NativePlayerSlot<T> = T | undefined;

export interface NativeStaticArenaSettings {
  readonly respawn: boolean;
  readonly noCollision: boolean;
  readonly fly: boolean;
  readonly quality: 1 | 2;
}

/**
 * World-unit, already-normalized static arena. The raw-map adapter performs
 * authored normalization before this boundary. Every platform must be static
 * and use only the bounded Classic backend fields. Nonempty cap zones select
 * the separate normalized dynamic arena contract below.
 */
export interface NativeStaticArena {
  readonly ppm: number;
  readonly settings: NativeStaticArenaSettings;
  readonly spawns: readonly NativeSpawn[];
  readonly platforms: readonly PhysicsPlatform[];
  readonly capZones?: readonly never[];
}

/** Normalized map-owned state for the single-world dynamic Classic backend. */
export interface NativeDynamicArena extends Omit<NativeStaticArena, 'platforms' | 'capZones'> {
  readonly platforms?: readonly never[];
  readonly physics: NativeMapPhysics;
  readonly capZones: readonly {
    readonly ty: number;
    readonly l: number;
    readonly i: number;
    readonly n?: string;
  }[];
}

export type NativeSessionArena = NativeStaticArena | NativeDynamicArena;

export interface NativeSessionPlayer extends NativeSpawnPlayer {
  /** Optional cosmetic/config data is preserved verbatim in the sparse roster. */
  readonly [key: string]: unknown;
}

export interface NativeSessionOptions {
  readonly arena: NativeSessionArena;
  /** Dense configuration entries, placed into sparse native state by player.id. */
  readonly players: readonly NativeSessionPlayer[];
  readonly seed: number;
  /** Native gameSettings.tea; team winners and team scores when true. */
  readonly teamsEnabled?: boolean;
  /** Native gameSettings.wl (1..9, or 999 for no score limit). */
  readonly roundsToWin?: number;
  /** Testing hooks mirror native testing/fast flags. Normal defaults are 90. */
  readonly countdownTicks?: 5 | 60 | 90;
  readonly physicsFactory?: () => ClassicPhysics;
  /** Optional unified-world seam for normalized dynamic maps. Static maps do
   * not construct this backend and retain the verified ClassicPhysics path. */
  readonly dynamicWorldFactory?: () => NativeClassicWorld;
  /** Room gameSettings.mo for the unified dynamic world: b, sp or bs. The
   * original step reads the mode from the room settings argument (readable
   * :7221 via arg5), never from map metadata; sp/bs branch inside the
   * unified world exactly as in the isolated classic-physics slice. */
  readonly mode?: 'b' | 'sp' | 'bs';
}

export interface NativeDiscDeath {
  readonly i: number;
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
  readonly f: number;
  /** Native cause: 1 lethal/arrow contact, 3 capture, 4 out of world. */
  readonly m: 1 | 3 | 4;
}

export interface NativeRoundResult {
  readonly winner: number | null;
  readonly draw: boolean;
  readonly score: number | null;
}

export interface NativeSessionSnapshot {
  readonly tick: number;
  readonly roundTick: number;
  readonly seed: number;
  readonly ftu: number;
  readonly fte: number;
  readonly rl: number;
  readonly rc: number;
  readonly lscr: number;
  readonly winner: number | null;
  readonly draw: boolean;
  readonly scores: readonly NativePlayerSlot<number>[];
  readonly players: readonly NativePlayerSlot<NativeSessionPlayer>[];
  readonly discs: readonly NativePlayerSlot<PhysicsDisc>[];
  readonly platforms: readonly PhysicsPlatform[];
  /** Present only for unified dynamic sessions; sparse IDs/holes are preserved. */
  readonly physics?: NativeMapPhysics;
  readonly capZones?: readonly NativeClassicCapZone[];
  /** Presentation records; these are not the live-disc elimination state. */
  readonly discDeaths: readonly NativeDiscDeath[];
  readonly phase: 'countdown' | 'active' | 'round-result' | 'match-result';
  readonly matchComplete: boolean;
  readonly roundResult: NativeRoundResult | null;
  /** Latest round result, including the completed round after native rollover. */
  readonly lastRoundResult: NativeRoundResult | null;
}

export interface NativeSessionEvents {
  readonly deaths: readonly NativeDiscDeath[];
  readonly respawns: readonly number[];
  readonly roundResult: NativeRoundResult | null;
  /** Most recent non-draw round winner. Retained across rollover like lscr. */
  readonly lastRoundResult: NativeRoundResult | null;
  readonly newRound: boolean;
  readonly capZoneContacts: readonly NativeClassicContact[];
  readonly capZoneTeamGoals: readonly NativeClassicTeamGoal[];
}

export interface NativeSessionStep {
  readonly state: NativeSessionSnapshot;
  readonly events: NativeSessionEvents;
}

export interface NativeSession {
  getState(): NativeSessionSnapshot;
  getEvents(): NativeSessionEvents;
  step(inputs?: Readonly<Record<number, number>>): NativeSessionSnapshot;
  stepWithEvents(inputs?: Readonly<Record<number, number>>): NativeSessionStep;
  dispose(): void;
}

const OPTION_FIELDS = new Set([
  'arena',
  'players',
  'seed',
  'teamsEnabled',
  'roundsToWin',
  'countdownTicks',
  'physicsFactory',
  'dynamicWorldFactory',
  'mode',
]);
const ARENA_FIELDS = new Set(['ppm', 'settings', 'spawns', 'platforms', 'capZones', 'name', 'metadata', 'physics']);
const CAP_ZONE_FIELDS = new Set(['ty', 'l', 'i', 'n']);
const SETTINGS_FIELDS = new Set(['respawn', 'noCollision', 'fly', 'quality']);
const PLATFORM_FIELDS = new Set([
  'id',
  'bodyId',
  'shape',
  'x',
  'y',
  'width',
  'height',
  'radius',
  'vertices',
  'angle',
  'color',
  'friction',
  'restitution',
  'lethal',
  'bodyX',
  'bodyY',
  'bodyAngle',
  'localX',
  'localY',
  'localAngle',
]);
const CANONICAL_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const MAX_ID = 0xffffffff;
const MAX_PLAYERS = 1024;

function invalid(reason: string): never {
  throw new Error(`Invalid native session input: ${reason}`);
}
function unsupported(reason: string): never {
  throw new Error(`Unsupported native session feature: ${reason}`);
}
function own(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) invalid(`${label}.${key} must be an own data property`);
  return descriptor.value;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${label} must not have symbol fields`);
  return value as Record<string, unknown>;
}
function fields(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Reflect.ownKeys(value))
    if (typeof key !== 'string' || !allowed.has(key)) invalid(`${label} has unsupported field ${String(key)}`);
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}
function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
function clonePlayers(
  players: readonly NativePlayerSlot<NativeSessionPlayer>[],
): NativePlayerSlot<NativeSessionPlayer>[] {
  return players.map((player) => (player === undefined ? undefined : freeze({ ...player })));
}
function cloneDiscs(discs: readonly (PhysicsDisc | undefined)[]): NativePlayerSlot<PhysicsDisc>[] {
  const output: NativePlayerSlot<PhysicsDisc>[] = [];
  for (const disc of discs) if (disc !== undefined) output[disc.id] = freeze({ ...disc });
  return output;
}
function cloneScores(scores: readonly NativePlayerSlot<number>[]): NativePlayerSlot<number>[] {
  return scores.slice();
}
function freezePhysics(physics: NativeMapPhysics): NativeMapPhysics {
  for (const collection of [physics.shapes, physics.fixtures, physics.bodies, physics.joints]) {
    for (const entry of collection) if (entry) freeze(entry);
    freeze(collection);
  }
  for (const body of physics.bodies)
    if (body) {
      freeze(body.s);
      freeze(body.p);
      freeze(body.lv);
      freeze(body.cf);
      freeze(body.fz);
      freeze(body.fx);
    }
  for (const shape of physics.shapes)
    if (shape) {
      freeze(shape.c);
      if (shape.type === 'po') freeze(shape.v.map(freeze));
    }
  for (const joint of physics.joints)
    if (joint) {
      freeze(joint.d);
      if (joint.type === 'rv' || joint.type === 'p' || joint.type === 'd') {
        freeze(joint.aa);
        freeze(joint.ab);
      }
      if (joint.type === 'p') freeze(joint.axa);
    }
  freeze(physics.bro);
  freeze(physics.ss.map(freeze));
  return freeze(physics);
}
function cloneDeaths(deaths: readonly NativeDiscDeath[]): NativeDiscDeath[] {
  return deaths.map((death) => freeze({ ...death }));
}

function hasOwnName(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function validateArena(value: unknown): NativeSessionArena {
  const raw = record(value, 'arena');
  fields(raw, ARENA_FIELDS, 'arena');
  if (Object.prototype.hasOwnProperty.call(raw, 'v') || Object.prototype.hasOwnProperty.call(raw, 'mapData'))
    unsupported('authored maps and legacy MapDef must be normalized by native-map-state before creating a session');
  const ppm = finite(own(raw, 'ppm', 'arena'), 'arena.ppm');
  if (ppm < 2 || ppm > 300) invalid('arena.ppm must be in [2, 300]');
  const rawSettings = record(own(raw, 'settings', 'arena'), 'arena.settings');
  fields(rawSettings, SETTINGS_FIELDS, 'arena.settings');
  const quality = own(rawSettings, 'quality', 'arena.settings');
  if (quality !== 1 && quality !== 2) invalid('arena.settings.quality must be 1 or 2');
  const settings = freeze({
    respawn: boolean(own(rawSettings, 'respawn', 'arena.settings'), 'arena.settings.respawn'),
    noCollision: boolean(own(rawSettings, 'noCollision', 'arena.settings'), 'arena.settings.noCollision'),
    fly: boolean(own(rawSettings, 'fly', 'arena.settings'), 'arena.settings.fly'),
    quality: quality as 1 | 2,
  });
  if (Object.prototype.hasOwnProperty.call(raw, 'capZones') && !Array.isArray(own(raw, 'capZones', 'arena')))
    invalid('arena.capZones must be an array');
  const rawCapZones = (
    Object.prototype.hasOwnProperty.call(raw, 'capZones') ? own(raw, 'capZones', 'arena') : []
  ) as unknown[];
  const dynamic = Object.prototype.hasOwnProperty.call(raw, 'physics');
  if (dynamic) {
    if (
      Object.prototype.hasOwnProperty.call(raw, 'platforms') &&
      (own(raw, 'platforms', 'arena') as unknown[]).length > 0
    )
      unsupported('dynamic arenas must step normalized physics, not a separate static platform world');
    const rawPhysics = record(own(raw, 'physics', 'arena'), 'arena.physics');
    if (!hasOwnName(rawPhysics, 'ppm') || typeof rawPhysics.ppm !== 'number')
      unsupported('native physics states must be normalized in world units before creating a session');
    const physics = normalizeNativeMap({ physics: rawPhysics } as unknown as NativeMapSource, { authored: false });
    const capZones = rawCapZones.map((entry, index) => {
      const zone = record(own(rawCapZones, String(index), 'arena.capZones'), `arena.capZones[${index}]`);
      fields(zone, CAP_ZONE_FIELDS, `arena.capZones[${index}]`);
      const ty = integer(own(zone, 'ty', `arena.capZones[${index}]`), `arena.capZones[${index}].ty`);
      if (ty < 1 || ty > 5) invalid(`arena.capZones[${index}].ty must be in [1, 5]`);
      const seconds = finite(own(zone, 'l', `arena.capZones[${index}]`), `arena.capZones[${index}].l`);
      if (seconds < 0) invalid(`arena.capZones[${index}].l must be nonnegative`);
      const fixture = integer(own(zone, 'i', `arena.capZones[${index}]`), `arena.capZones[${index}].i`);
      if (hasOwnName(zone, 'n') && typeof own(zone, 'n', `arena.capZones[${index}]`) !== 'string')
        invalid(`arena.capZones[${index}].n must be a string`);
      return freeze({ ty, l: seconds, i: fixture, ...(hasOwnName(zone, 'n') ? { n: zone.n as string } : {}) });
    });
    return freeze({
      ppm,
      settings,
      spawns: validateNativeSpawns(own(raw, 'spawns', 'arena')),
      physics,
      capZones: freeze(capZones),
    });
  }
  if (rawCapZones.length > 0) unsupported('cap zones and instant goals require normalized dynamic map physics');
  const spawns = validateNativeSpawns(own(raw, 'spawns', 'arena'));
  const rawPlatforms = own(raw, 'platforms', 'arena');
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length > 4096)
    invalid('arena.platforms must be an array with at most 4096 entries');
  const platformIds = new Set<number>();
  const bodyTransforms = new Map<number, readonly number[]>();
  const platforms = rawPlatforms.map((entry, index): PhysicsPlatform => {
    const platform = record(entry, `arena.platforms[${index}]`);
    fields(platform, PLATFORM_FIELDS, `arena.platforms[${index}]`);
    const id = integer(own(platform, 'id', `arena.platforms[${index}]`), `arena.platforms[${index}].id`);
    const bodyId = integer(own(platform, 'bodyId', `arena.platforms[${index}]`), `arena.platforms[${index}].bodyId`);
    if (id < 0 || bodyId < 0 || platformIds.has(id))
      invalid(`arena.platforms[${index}] has a negative or duplicate fixture ID`);
    platformIds.add(id);
    const shape = own(platform, 'shape', `arena.platforms[${index}]`);
    if (shape !== 'box' && shape !== 'circle' && shape !== 'polygon')
      invalid(`arena.platforms[${index}].shape is unsupported`);
    const base = {
      id,
      bodyId,
      shape,
      x: finite(own(platform, 'x', `arena.platforms[${index}]`), `arena.platforms[${index}].x`),
      y: finite(own(platform, 'y', `arena.platforms[${index}]`), `arena.platforms[${index}].y`),
      angle: finite(own(platform, 'angle', `arena.platforms[${index}]`), `arena.platforms[${index}].angle`),
      color: finite(own(platform, 'color', `arena.platforms[${index}]`), `arena.platforms[${index}].color`),
      friction: finite(own(platform, 'friction', `arena.platforms[${index}]`), `arena.platforms[${index}].friction`),
      restitution: finite(
        own(platform, 'restitution', `arena.platforms[${index}]`),
        `arena.platforms[${index}].restitution`,
      ),
      lethal: boolean(own(platform, 'lethal', `arena.platforms[${index}]`), `arena.platforms[${index}].lethal`),
    };
    const transformNames = ['bodyX', 'bodyY', 'bodyAngle', 'localX', 'localY', 'localAngle'];
    const transformCount = transformNames.filter((name) => Object.prototype.hasOwnProperty.call(platform, name)).length;
    if (transformCount !== 0 && transformCount !== transformNames.length)
      invalid(`arena.platforms[${index}] must provide all static transforms or none`);
    const transforms: Record<string, number> = {};
    for (const name of transformNames)
      if (transformCount)
        transforms[name] = finite(
          own(platform, name, `arena.platforms[${index}]`),
          `arena.platforms[${index}].${name}`,
        );
    const bodyTransform = transformCount
      ? [transforms.bodyX, transforms.bodyY, transforms.bodyAngle]
      : [base.x, base.y, base.angle];
    const previousTransform = bodyTransforms.get(bodyId);
    if (previousTransform && previousTransform.some((value, component) => value !== bodyTransform[component])) {
      invalid(`arena.platforms[${index}] disagrees with the static transform for shared body ${bodyId}`);
    }
    bodyTransforms.set(bodyId, bodyTransform);
    const shapeData: {
      width?: number;
      height?: number;
      radius?: number;
      vertices?: readonly (readonly [number, number])[];
    } =
      shape === 'box'
        ? {
            width: finite(own(platform, 'width', `arena.platforms[${index}]`), `arena.platforms[${index}].width`),
            height: finite(own(platform, 'height', `arena.platforms[${index}]`), `arena.platforms[${index}].height`),
          }
        : shape === 'circle'
          ? {
              radius: finite(own(platform, 'radius', `arena.platforms[${index}]`), `arena.platforms[${index}].radius`),
            }
          : {
              vertices: (own(platform, 'vertices', `arena.platforms[${index}]`) as unknown[]).map(
                (point, pointIndex) => {
                  if (!Array.isArray(point) || point.length !== 2)
                    invalid(`arena.platforms[${index}].vertices[${pointIndex}] must be a two-number array`);
                  return freeze([
                    finite(point[0], `arena.platforms[${index}].vertices[${pointIndex}][0]`),
                    finite(point[1], `arena.platforms[${index}].vertices[${pointIndex}][1]`),
                  ] as const);
                },
              ),
            };
    if (
      shapeData.width !== undefined &&
      shapeData.height !== undefined &&
      (shapeData.width <= 0 || shapeData.height <= 0)
    )
      invalid(`arena.platforms[${index}] dimensions must be positive`);
    if (shapeData.radius !== undefined && shapeData.radius <= 0)
      invalid(`arena.platforms[${index}].radius must be positive`);
    return freeze({ ...base, ...shapeData, ...transforms } as PhysicsPlatform);
  });
  return freeze({ ppm, settings, spawns, platforms: freeze(platforms), capZones: freeze([]) });
}

function validateRoster(value: unknown): readonly NativeSessionPlayer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAYERS)
    invalid('players must contain 1..1024 dense entries');
  const seen = new Set<number>();
  const players: NativeSessionPlayer[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = record(own(value, String(index), 'players'), `players[${index}]`);
    const id = integer(own(raw, 'id', `players[${index}]`), `players[${index}].id`);
    const team = integer(own(raw, 'team', `players[${index}]`), `players[${index}].team`);
    if (id < 0 || id > MAX_ID || seen.has(id)) invalid(`players[${index}].id must be unique and in [0, ${MAX_ID}]`);
    seen.add(id);
    if (team < 0 || team > 5) invalid(`players[${index}].team must be in [0, 5]`);
    if (
      Object.prototype.hasOwnProperty.call(raw, 'spectator') &&
      typeof own(raw, 'spectator', `players[${index}]`) !== 'boolean'
    )
      invalid(`players[${index}].spectator must be boolean`);
    players.push(freeze({ ...raw, id, team: team as NativeTeam } as NativeSessionPlayer));
  }
  return freeze(players);
}

function deathFromPhysics(
  id: number,
  disc: PhysicsDisc | undefined,
  cause: string,
  ppm: number,
  pose: Partial<Readonly<Pick<PhysicsDisc, 'x' | 'y' | 'xv' | 'yv'>>>,
): NativeDiscDeath {
  const m =
    cause === 'out-of-world' ? 4 : cause === 'capture' ? 3 : cause === 'lethal-contact' || cause === 'arrow' ? 1 : -1;
  if (m === -1) invalid(`unknown physics death cause ${String(cause)}`);
  if (!disc && (pose.x === undefined || pose.y === undefined || pose.xv === undefined || pose.yv === undefined))
    invalid(`physics eliminated disc ${id} without preserving its pre-death body state`);
  let x = pose.x ?? disc!.x,
    y = pose.y ?? disc!.y,
    xv = pose.xv ?? disc!.xv,
    yv = pose.yv ?? disc!.yv;
  if (m === 4) {
    // Native out-of-world presentation is clamped to the map rectangle and
    // launched inward; it remains separate from the eliminated/respawned disc.
    const minX = 1 / ppm,
      minY = 1 / ppm;
    const maxX = 729 / ppm,
      maxY = 499 / ppm;
    const bodyX = x,
      bodyY = y;
    x = Math.min(Math.max(bodyX, minX), maxX);
    y = Math.min(Math.max(bodyY, minY), maxY);
    let angle: number;
    if (x === minX && y === maxY) angle = -Math.PI / 4 + 0.25;
    else if (x === maxX && y === maxY) angle = (-3 * Math.PI) / 4 - 0.25;
    else angle = safeATan2(y - bodyY, x - bodyX);
    xv = safeCos(angle) * 20;
    yv = safeSin(angle) * 20;
  }
  return freeze({ i: id, x, y, xv, yv, f: 0, m });
}

/** Construct a deterministic native session. Inputs and snapshots contain no
 * live backend objects; all public observations are detached pure data. */
export function createNativeSession(options: NativeSessionOptions): NativeSession {
  const rawOptions = record(options, 'options');
  fields(rawOptions, OPTION_FIELDS, 'options');
  const arena = validateArena(own(rawOptions, 'arena', 'options'));
  const players = validateRoster(own(rawOptions, 'players', 'options'));
  const initialSeed = integer(own(rawOptions, 'seed', 'options'), 'seed');
  if (initialSeed < 0 || initialSeed > MAX_ID) invalid(`seed must be in [0, ${MAX_ID}]`);
  const teamsEnabled = Object.prototype.hasOwnProperty.call(rawOptions, 'teamsEnabled')
    ? boolean(own(rawOptions, 'teamsEnabled', 'options'), 'teamsEnabled')
    : false;
  const roundsToWin = Object.prototype.hasOwnProperty.call(rawOptions, 'roundsToWin')
    ? integer(own(rawOptions, 'roundsToWin', 'options'), 'roundsToWin')
    : 3;
  if (!((roundsToWin >= 1 && roundsToWin <= 9) || roundsToWin === 999)) invalid('roundsToWin must be in [1, 9] or 999');
  const countdownTicks = Object.prototype.hasOwnProperty.call(rawOptions, 'countdownTicks')
    ? integer(own(rawOptions, 'countdownTicks', 'options'), 'countdownTicks')
    : 90;
  if (countdownTicks !== 5 && countdownTicks !== 60 && countdownTicks !== 90)
    invalid('countdownTicks must be a native testing/fast/default value: 5, 60 or 90');
  const factory = Object.prototype.hasOwnProperty.call(rawOptions, 'physicsFactory')
    ? own(rawOptions, 'physicsFactory', 'options')
    : createClassicPhysics;
  if (typeof factory !== 'function') invalid('physicsFactory must be a function');
  const dynamicFactory = Object.prototype.hasOwnProperty.call(rawOptions, 'dynamicWorldFactory')
    ? own(rawOptions, 'dynamicWorldFactory', 'options')
    : createNativeClassicWorld;
  if (typeof dynamicFactory !== 'function') invalid('dynamicWorldFactory must be a function');
  const sessionMode = Object.prototype.hasOwnProperty.call(rawOptions, 'mode')
    ? own(rawOptions, 'mode', 'options')
    : 'b';
  if (sessionMode !== 'b' && sessionMode !== 'sp' && sessionMode !== 'bs')
    invalid('mode must be b, sp or bs for the unified dynamic world');
  const dynamicSessionMode = sessionMode as 'b' | 'sp' | 'bs';
  const dynamicArena = 'physics' in arena ? arena : null;
  if (dynamicArena && Object.prototype.hasOwnProperty.call(rawOptions, 'physicsFactory'))
    unsupported('dynamic arenas use one NativeClassicWorld, not a separate ClassicPhysics solver');

  const roster: NativePlayerSlot<NativeSessionPlayer>[] = [];
  const teams: number[] = [];
  const balances: number[] = [];
  for (const player of players) {
    roster[player.id] = player;
    teams[player.id] = player.team;
    const balance = Object.prototype.hasOwnProperty.call(player, 'balance') ? player.balance : 0;
    if (
      balance !== undefined &&
      (!Number.isInteger(balance) || (balance as number) < -100 || (balance as number) > 100)
    )
      invalid(`player ${player.id}.balance must be in [-100, 100]`);
    balances[player.id] = (balance as number | undefined) ?? 0;
  }
  const active = players.filter(
    (player) => !player.spectator && player.team >= 1 && (!teamsEnabled || player.team >= 2),
  );
  if (active.length === 0) invalid('at least one active non-spectator player is required');
  if (teamsEnabled && new Set(active.map((player) => player.team)).size < 2)
    invalid('team matches require at least two teams');
  const scores: NativePlayerSlot<number>[] = [];
  if (teamsEnabled) for (const player of active) scores[player.team] = 0;
  else for (const player of players) scores[player.id] = 0;
  let roundSeed = initialSeed;
  let seed = initialSeed;
  let discs: PhysicsDisc[] = [];
  let platforms = arena.platforms ?? [];
  let mapPhysics = dynamicArena ? cloneNativeMapPhysics(dynamicArena.physics) : null;
  let capZones: NativeClassicCapZone[] = [];
  let deaths: NativeDiscDeath[] = [];
  let ftu = countdownTicks;
  let fte = -1;
  let rl = 0;
  let rc = 0;
  let tick = 0;
  let lastScorer = -1;
  let roundResult: NativeRoundResult | null = null;
  let lastRoundResult: NativeRoundResult | null = null;
  let matchComplete = false;
  let disposed = false;
  let events: NativeSessionEvents = freeze({
    deaths: freeze([]),
    respawns: freeze([]),
    roundResult: null,
    lastRoundResult: null,
    newRound: false,
    capZoneContacts: freeze([]),
    capZoneTeamGoals: freeze([]),
  });

  function planRound(initial: boolean): void {
    const plan = dealNativeSpawns({ spawns: arena.spawns, players, seed: roundSeed, teamsEnabled });
    seed = plan.seed;
    discs = plan.assignments.map((assignment): PhysicsDisc => ({
      id: assignment.playerId,
      x: assignment.x,
      y: assignment.y,
      xv: assignment.xv,
      yv: assignment.yv,
      sx: assignment.x,
      sy: assignment.y,
      sxv: assignment.xv,
      syv: assignment.yv,
      angle: 0,
      angularVelocity: 0,
      radius: 1,
      energy: 1000,
      heavy: false,
      alive: true,
      lhid: -1,
      lht: 0,
      ni: false,
      ds: 0,
      da: 270,
      vt: 0,
    }));
    if (discs.length === 0) unsupported('arena cannot spawn any active roster member');
    platforms = arena.platforms ?? [];
    if (dynamicArena) {
      mapPhysics = cloneNativeMapPhysics(dynamicArena.physics);
      mapPhysics.ftu = initial ? countdownTicks : 90;
      // createNewState rebuilds capture state from the authored definitions;
      // progress, ownership and completion delay never cross a round boundary.
      capZones = createNativeClassicCapZones(dynamicArena.capZones, mapPhysics);
    }
    deaths = [];
    ftu = initial ? countdownTicks : 90;
    fte = -1;
    rl = 0;
    roundResult = null;
    if (initial) lastRoundResult = null;
  }
  planRound(true);
  const physics = dynamicArena ? null : (factory as () => ClassicPhysics)();
  const dynamicWorld = dynamicArena ? (dynamicFactory as () => NativeClassicWorld)() : null;
  if (physics && (typeof physics.stepWorld !== 'function' || typeof physics.dispose !== 'function')) {
    physics.dispose?.();
    invalid('physicsFactory must return a ClassicPhysics implementation');
  }
  if (dynamicWorld && (typeof dynamicWorld.step !== 'function' || typeof dynamicWorld.dispose !== 'function')) {
    dynamicWorld.dispose?.();
    invalid('dynamicWorldFactory must return a NativeClassicWorld implementation');
  }

  // ClassicPhysics consumes dense numeric vectors, not sparse player tables.
  // Holes are neutral native defaults; IDs in roster/discs stay untouched.
  const physicsTeams = Array.from(
    { length: players.reduce((max, player) => Math.max(max, player.id), 0) + 1 },
    (_, id) => teams[id] ?? 1,
  );
  const physicsBalances = Array.from({ length: physicsTeams.length }, (_, id) => balances[id] ?? 0);

  function snapshot(): NativeSessionSnapshot {
    const result = roundResult === null ? null : freeze({ ...roundResult });
    return freeze({
      tick,
      roundTick: rl,
      seed,
      ftu,
      fte,
      rl,
      rc,
      lscr: lastScorer,
      winner: result?.winner ?? null,
      draw: result?.draw ?? false,
      scores: freeze(cloneScores(scores)),
      players: freeze(clonePlayers(roster)),
      discs: freeze(cloneDiscs(discs)),
      platforms: freeze(platforms.map((platform) => freeze({ ...platform }))),
      ...(mapPhysics
        ? {
            physics: freezePhysics(cloneNativeMapPhysics(mapPhysics)),
            capZones: freeze(capZones.map((zone) => freeze({ ...zone }))),
          }
        : {}),
      discDeaths: freeze(cloneDeaths(deaths)),
      phase: fte >= 0 ? ('round-result' as const) : ftu === -1 ? ('active' as const) : ('countdown' as const),
      matchComplete,
      roundResult: result,
      lastRoundResult: lastRoundResult === null ? null : freeze({ ...lastRoundResult }),
    });
  }
  function assertActive(): void {
    if (disposed) throw new Error('Native session has been disposed');
  }
  function completeRound(entryDiscs: readonly PhysicsDisc[]): void {
    // Exact step order: death/resolver counters include every input disc, while
    // current-step deaths remove live candidates. ftu does not suppress this
    // logic; native can resolve a countdown/no-contest round as well.
    const survivors: PhysicsDisc[] = [];
    let lastWinner = -1;
    let lastTeam = -1;
    const survivingTeams = new Set<number>();
    for (const disc of discs) {
      if (!disc.alive) continue;
      survivors.push(disc);
      lastWinner = disc.id;
      lastTeam = teams[disc.id] ?? 1;
      survivingTeams.add(lastTeam);
    }
    const initialCount = entryDiscs.length;
    let gameEnd = false;
    let win = false;
    let winner = -1;
    if (!teamsEnabled) {
      if (survivors.length === 1 && initialCount > 1) {
        gameEnd = true;
        win = true;
        winner = lastWinner;
      } else if (survivors.length === 0 && initialCount === 1) gameEnd = true;
      else if (survivors.length === 0 && initialCount > 1) gameEnd = true;
    } else {
      const initialTeams = new Set(entryDiscs.map((disc) => teams[disc.id] ?? 1));
      if (survivingTeams.size === 1 && initialTeams.size > 1) {
        gameEnd = true;
        win = true;
        winner = lastTeam;
      } else if (survivingTeams.size === 0 && initialTeams.size === 1) gameEnd = true;
      else if (survivingTeams.size === 0 && initialTeams.size > 1) gameEnd = true;
    }
    if (!gameEnd || fte >= 0) return;
    if (win) {
      scores[winner] = (scores[winner] ?? 0) + 1;
      lastScorer = winner;
    } else lastScorer = -1;
    fte = 90;
    roundResult = freeze({ winner: win ? winner : null, draw: !win, score: win ? (scores[winner] ?? null) : null });
    lastRoundResult = roundResult;
    if (win && (scores[winner] ?? 0) >= roundsToWin) matchComplete = true;
  }

  function advance(inputs: Readonly<Record<number, number>>): void {
    if (matchComplete) return;
    if (fte === 0) {
      // Native calls createNewState with inputState.seed (the original round
      // seed), not the already advanced state.seed. No solver step runs on this
      // call; scores/lscr survive and rc increments by exactly one.
      rc++;
      roundSeed = seed;
      planRound(false);
      tick++;
      events = freeze({
        deaths: freeze([]),
        respawns: freeze([]),
        roundResult: null,
        lastRoundResult: lastRoundResult === null ? null : freeze({ ...lastRoundResult }),
        newRound: true,
        capZoneContacts: freeze([]),
        capZoneTeamGoals: freeze([]),
      });
      return;
    }
    const entryFtu = ftu;
    const normalized: Record<number, number> = {};
    const inputRecord = record(inputs, 'inputs');
    for (const key of Object.getOwnPropertyNames(inputRecord)) {
      if (!CANONICAL_DECIMAL_ID.test(key))
        invalid(`inputs key ${JSON.stringify(key)} is not a canonical decimal player ID`);
      const id = Number(key);
      if (!roster[id]) invalid(`inputs contains unknown player ${key}`);
      const value = own(inputRecord, key, 'inputs');
      // Grapple mode carries the native action2 on bit 5 (readable :8006).
      // Every other mode masks to the five classic bits exactly as before.
      const maxValue = dynamicSessionMode === 'sp' ? 63 : 31;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maxValue)
        invalid(`inputs[${key}] must be an integer in [0, ${maxValue}]`);
    }
    if (matchComplete) return;
    const previousDiscs = discs;
    const live = previousDiscs.filter((disc) => disc.alive);
    const known = new Set(live.map((disc) => disc.id));
    for (const key of Object.getOwnPropertyNames(inputRecord)) {
      const id = Number(key);
      if (known.has(id)) normalized[id] = own(inputRecord, key, 'inputs') as number;
    }
    for (const id of known) normalized[id] ??= 0;
    let backendDeaths: readonly {
      readonly id: number;
      readonly cause: string;
      readonly x?: number;
      readonly y?: number;
      readonly xv?: number;
      readonly yv?: number;
    }[];
    let capZoneContacts: readonly NativeClassicContact[] = [];
    let capZoneTeamGoals: readonly NativeClassicTeamGoal[] = [];
    if (dynamicWorld && mapPhysics) {
      const sparseDiscs: (PhysicsDisc | undefined)[] = [];
      for (const disc of live) sparseDiscs[disc.id] = disc;
      mapPhysics.ftu = entryFtu;
      const world = dynamicWorld.step(
        mapPhysics,
        sparseDiscs,
        normalized,
        {
          fly: arena.settings.fly,
          noCollision: arena.settings.noCollision,
          quality: arena.settings.quality,
          simulate: entryFtu === -1,
          balances: physicsBalances,
          teams: physicsTeams,
          teamCollision: teamsEnabled,
          mode: dynamicSessionMode,
          respawn: arena.settings.respawn,
          radialBounds: true,
          knownPlayerIds: active.map((player) => player.id),
        },
        { capZones },
      );
      mapPhysics = world.physics;
      capZones = world.capZones.map((zone) => ({ ...zone }));
      discs = world.discs.filter((disc): disc is PhysicsDisc => disc !== undefined).map((disc) => ({ ...disc }));
      backendDeaths = world.deaths;
      capZoneContacts = world.capZoneContacts.map((contact) => ({ ...contact }));
      capZoneTeamGoals = world.capZoneTeamGoals.map((goal) => ({ ...goal }));
    } else {
      const world = physics!.stepWorld(
        previousDiscs.filter((disc) => disc.alive),
        platforms,
        normalized,
        {
          fly: arena.settings.fly,
          noCollision: arena.settings.noCollision,
          quality: arena.settings.quality,
          simulate: entryFtu === -1,
          balances: physicsBalances,
          teams: physicsTeams,
          teamCollision: teamsEnabled,
          mode: 'b',
          respawn: arena.settings.respawn,
          ppm: arena.ppm,
        },
      );
      if (world.capZoneContacts?.length || world.capZoneTeamGoals?.length)
        unsupported('static physics emitted cap-zone events for an arena validated without cap zones');
      discs = world.discs.map((disc) => ({ ...disc }));
      platforms = world.platforms;
      backendDeaths = world.deaths ?? [];
    }
    const deathRecords = backendDeaths.map((death) => {
      const disc = discs.find((entry) => entry.id === death.id);
      // Deaths may remove the live entry entirely. Presentation always uses the
      // un-respawned solver body pose/velocity, not a respawned outgoing disc.
      return deathFromPhysics(death.id, disc, death.cause, arena.ppm, death);
    });
    if (arena.settings.respawn && !dynamicWorld) {
      const causes = new Map(backendDeaths.map((death) => [death.id, death.cause]));
      discs = discs.map((disc) => {
        const cause = causes.get(disc.id);
        if (cause === undefined || cause === 'capture') return disc;
        return { ...disc, x: disc.sx!, y: disc.sy!, xv: disc.sxv!, yv: disc.syv!, alive: true, ni: true };
      });
    }
    deaths = deaths
      .filter((death) => death.f <= 90)
      .map((death) => freeze({ ...death, f: death.f + 1 }))
      .concat(deathRecords);
    ftu = entryFtu > -1 ? entryFtu - 1 : entryFtu;
    rl++;
    tick++;
    if (fte >= 0) fte--;
    else completeRound(previousDiscs);
    const respawns = discs.filter((disc) => disc.ni).map((disc) => disc.id);
    events = freeze({
      deaths: freeze(deathRecords),
      respawns: freeze(respawns),
      roundResult: fte === 90 && roundResult !== null ? freeze({ ...roundResult }) : null,
      lastRoundResult: lastRoundResult === null ? null : freeze({ ...lastRoundResult }),
      newRound: false,
      capZoneContacts: freeze(capZoneContacts.map(freeze)),
      capZoneTeamGoals: freeze(capZoneTeamGoals.map(freeze)),
    });
  }

  function stepWithEvents(inputs: Readonly<Record<number, number>> = {}): NativeSessionStep {
    assertActive();
    advance(inputs);
    return freeze({ state: snapshot(), events });
  }
  return freeze({
    getState: snapshot,
    getEvents: () => events,
    step(inputs: Readonly<Record<number, number>> = {}): NativeSessionSnapshot {
      return stepWithEvents(inputs).state;
    },
    stepWithEvents,
    dispose(): void {
      if (disposed) return;
      physics?.dispose();
      dynamicWorld?.dispose();
      discs = [];
      platforms = [];
      mapPhysics = null;
      capZones = [];
      deaths = [];
      disposed = true;
    },
  });
}
