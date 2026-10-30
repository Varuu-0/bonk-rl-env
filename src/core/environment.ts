/**
 * BonkEnvironment — Gymnasium-style RL environment for bonk.io physics.
 *
 * This is the main entry point for RL training. It wraps the PhysicsEngine
 * and provides a clean `reset()` / `step(action)` API that returns
 * { observation, reward, done, info }.
 *
 * Architecture:
 *   - AI controls player 0.
 *   - A single "dummy" opponent (player 1) uses a random or scripted policy.
 *   - The environment is fully synchronous — no networking, no real-time clock.
 *   - Each step() call advances physics by exactly one tick (1/30s).
 */

import * as fs from 'fs';
import * as path from 'path';

import { PhysicsEngine, PlayerInput, PlayerState, DeathEvent, MapDef, MapBodyDef, TPS } from './physics-engine';
import { normalizeMap } from './map-adapter';
import { isNativeMapJson, validateNativeMapJson, type NativeMap } from './native-map-codec';
import { createNativeMapModeSession, createNativeMapSession, nativeMapToArena } from './native-map-session';
import { createNativeFootballSession } from './native-football-session';
import type { NativeSession, NativeSessionSnapshot } from './native-session';
import type { NativeClassicMode } from './native-mode-session';
import type { NativeClassicCapZone } from './native-classic-world';
import { encodePlayerInput } from './action-codec';
import { PRNG } from './prng';
import { SharedMemoryManager } from '../ipc/shared-memory';
import { assertValidAction, decodeEncodedAction } from './action-validation';
import { assertSupportedSeed } from './seed-range';
export { MAX_OPPONENTS } from './opponent-capacity';

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Default episode length in ticks (native 30 s at 30 TPS). Tick-counted by
 * design — like every other native timer in the engine (a1a drain/recharge,
 * last-hit attribution 120, cap-zone hold `(l ?? 3) * 30`), maxTicks does NOT
 * rescale with a configured ticksPerSecond, so at a non-default TPS the
 * real-time episode length changes with the fixed tick count.
 */
const MAX_TICKS_DEFAULT = 30 * TPS;

/**
 * Upper bound of the validated frame-skip window and the single source of
 * truth for the [1, MAX_FRAME_SKIP] contract shared with the Python client.
 * Derivation flows one way only: this constant is exported here, copied into
 * manifests/backend-constants.json by `npm run gen:constants`, and pinned by
 * python/envs/bonk_env.py through its manifest parity test — so the backend
 * never accepts a frame-skip window that the client would reject when coalescing
 * terminal holds (#393).
 */
export const MAX_FRAME_SKIP = 100;

/** Native authored-map canvas and world origin. ClassicPhysics deliberately
 * retains native world metres internally; the public Observation contract is
 * authored map pixels, so the adapter subtracts this origin on presentation. */
const NATIVE_MAP_WIDTH = 730;
const NATIVE_MAP_HEIGHT = 500;
const NATIVE_ORIGIN_X = NATIVE_MAP_WIDTH / 2;
const NATIVE_ORIGIN_Y = NATIVE_MAP_HEIGHT / 2;

// SPAWN_POSITIONS removed, now read dynamically from map

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Discrete action space (6 binary flags packed into a single integer).
 * Actions can also be provided as a PlayerInput object directly.
 */
export type Action = PlayerInput | number;

export interface Observation {
  /** AI player state */
  playerX: number;
  playerY: number;
  playerVelX: number;
  playerVelY: number;
  playerAngle: number;
  playerAngularVel: number;
  playerIsHeavy: boolean;

  /** Opponent states (array for future multi-opponent support) */
  opponents: Array<{
    x: number;
    y: number;
    velX: number;
    velY: number;
    isHeavy: boolean;
    alive: boolean;
  }>;

  /** Arena boundaries */
  arenaHalfWidth: number;
  arenaHalfHeight: number;

  /** Current tick */
  tick: number;
}

export interface StepResult {
  observation: Observation;
  reward: number;
  done: boolean;
  truncated: boolean;
  /**
   * Whether the episode ended by a terminal condition (permanent
   * death/elimination) rather than by truncation. Top-level mirror of
   * `info.terminated` with the same truth semantics the pooled/IPC/Python
   * surfaces normalize (#391): true on a natural death (even when the
   * maxTicks boundary fires on the same tick), false on a pure truncation
   * and on non-terminal steps.
   */
  terminated: boolean;
  info: Record<string, any>;
}

export interface EnvironmentConfig {
  /**
   * Number of opponents (default 1). Bounded by MAX_OPPONENTS (see
   * src/core/opponent-capacity.ts): values above it are rejected at
   * construction because the bundled Box2D broadphase pair table (4096
   * slots) is exhausted by the quadratic pairs of co-located disc spawns
   * (#392).
   */
  numOpponents?: number;
  /** Maximum ticks per episode (default 900) */
  maxTicks?: number;
  /** Whether to use a random opponent policy (default true) */
  randomOpponent?: boolean;
  /** Raw native map JSON uses the native session path; exporter and internal
   * MapDef objects remain on the explicitly legacy physics implementation. */
  mapData?: MapDef | NativeMap;
  /** Original room gameSettings.mo for raw native maps, independent of the
   * map's m.mo targeting metadata. Static Arrow, Death Arrow and VTOL are
   * supported; non-Classic dynamic-map mechanics are rejected explicitly. */
  nativeMode?: NativeClassicMode | 'f';
  /** Initial native countdown (default 90). The original test-state oracle
   * uses 60; 5 is the other native fast-start value. Subsequent rounds
   * retain the native 90-tick countdown. */
  countdownTicks?: 5 | 60 | 90;
  /** Native gameSettings.wl: rounds a team must win (1..9, or 999 for no
   * score limit). Football scores use this limit; Classic uses the session
   * default (3). */
  roundsToWin?: number;
  /** Seed for deterministic randomness */
  seed?: number;
  /** Number of ticks to hold each action before requesting new decision (default 1) */
  frameSkip?: number;
  /** Optional physics override: pixels-per-metre scale factor */
  ppm?: number;
  /** Optional path to a map JSON file, used when mapData is absent */
  mapPath?: string;
  /**
   * Config-loader map path (`--map` | `DEFAULT_MAP_PATH` | `environment.defaultMapPath`),
   * used when both mapData and mapPath are absent. The worker forwards the merged
   * environment config verbatim, so this is the end-to-end documented surface (#199).
   */
  defaultMapPath?: string;
  /**
   * Player slot index controlled by the RL agent (0-7, default 0). The agent
   * observes, controls, and is rewarded for this slot; every other spawned
   * slot is an opponent (`AI_PLAYER_ID` | `--ai-player-id` |
   * `environment.aiPlayerId`). Must be within [0, numOpponents], the AI slot
   * plus one slot per opponent (#221).
   */
  aiPlayerId?: number;
  /** Opponent random-policy probabilities */
  oppMoveProb?: number;
  oppUpProb?: number;
  oppDownProb?: number;
  oppHeavyProb?: number;
  oppGrappleProb?: number;
  /** Config-loader aliases for the opponent random-policy probabilities */
  randomOppMoveProb?: number;
  randomOppUpProb?: number;
  randomOppDownProb?: number;
  randomOppHeavyProb?: number;
  randomOppGrappleProb?: number;
  /** Native team mode (`tea`): same-team discs do not collide (default false) */
  teamsEnabled?: boolean;
  /** Native no-collision physics mode (`nc`): discs never collide (default false) */
  noCollide?: boolean;
  /** Native flipped map mode (`fl`): flipped move-force base (default false).
   *  Explicit config wins over the map's `settings.fl` (symmetric with
   *  `noCollide` vs `settings.nc`). */
  flipped?: boolean;
  /** Native respawning mode (`re`): dead discs respawn at their spawn point
   *  (default false). Explicit config wins over the map's `settings.re`.
   *  Transient lethal/OOB deaths remain observable and rewarded but do not
   *  terminate; permanent cap-zone eliminations (type 3) still terminate. */
  respawnEnabled?: boolean;
  /** Documented physics.* tuning forwarded to the PhysicsEngine (issue #217).
   *  Absent keys keep the engine's sanity defaults, so an env built without a
   *  physics section runs with the exact verified native values. */
  physics?: PhysicsTuningConfig;
  /** Documented arena.* tuning (fallback half-bounds and bounds margin). */
  arena?: ArenaTuningConfig;
  /** Documented player.* movement tuning (moveForce, heavyMassMultiplier). */
  player?: PlayerTuningConfig;
  /** Reward for eliminating an opponent (input alias for reward.killReward; default 1.0) */
  killReward?: number;
  /** Penalty for being eliminated (input alias for reward.deathPenalty; default -1.0) */
  deathPenalty?: number;
  /** Per-tick penalty to encourage efficiency (input alias for reward.timePenalty; default -0.001) */
  timePenalty?: number;
  /** Reward weights — the single source of truth calculateReward reads (#220) */
  reward?: {
    killReward?: number;
    deathPenalty?: number;
    timePenalty?: number;
  };
}

/** Config-loader `physics.*` section: documented, tunable engine settings. */
export interface PhysicsTuningConfig {
  ticksPerSecond?: number;
  solverIterations?: number;
  /** Position constraint solver iterations per tick. Defaults follow the map's
   * native `pq` setting (6 low / 15 high); explicit values override it. */
  positionIterations?: number;
  scale?: number;
  gravityX?: number;
  gravityY?: number;
  enableSleeping?: boolean;
  worldAabbExtent?: number;
}

/** Config-loader `arena.*` section. */
export interface ArenaTuningConfig {
  defaultHalfWidth?: number;
  defaultHalfHeight?: number;
  boundsMargin?: number;
}

/** Config-loader `player.*` movement section. */
export interface PlayerTuningConfig {
  moveForce?: number;
  heavyMassMultiplier?: number;
}

/**
 * Resolved reward weights normalized at construction. The flat
 * killReward/deathPenalty/timePenalty input aliases and the nested `reward`
 * section are collapsed into this one object, which is the only reward state
 * stored on the environment and the only reward state calculateReward reads.
 * Penalties are enforced non-positive and every weight finite (#220).
 */
export interface ResolvedRewardConfig {
  killReward: number;
  deathPenalty: number;
  timePenalty: number;
}

// ─── Default Arena ───────────────────────────────────────────────────

/**
 * Resolve a possibly relative map path for loading. Absolute paths are used
 * as-is. Relative paths keep their legacy process-cwd meaning when the file
 * exists there (programmatic `mapPath` compatibility); otherwise they are
 * re-anchored against the project root so a repo-relative path such as the
 * loader default `maps/...` cannot silently box-fall-back when the worker's
 * inherited cwd differs from the repository root (#199).
 */
function resolveMapPath(mapFile: string): string {
  if (path.isAbsolute(mapFile)) {
    return mapFile;
  }
  if (fs.existsSync(mapFile)) {
    return mapFile;
  }
  return path.resolve(__dirname, '..', '..', mapFile);
}

/** Strict native-map selection shared by environment construction and pool
 * transport sizing. Legacy MapDef/exported maps deliberately return null. */
function configuredNativeMap(config: Partial<EnvironmentConfig>): NativeMap | null {
  if (config.mapData) return isNativeMapJson(config.mapData) ? validateNativeMapJson(config.mapData) : null;
  const configuredPath = config.mapPath || config.defaultMapPath || '';
  const mapPath = configuredPath
    ? resolveMapPath(configuredPath)
    : path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (error) {
    const failure = new Error(
      `Failed to load Bonk map "${mapPath}": ${error instanceof Error ? error.message : String(error)}`,
    ) as Error & { cause?: unknown };
    failure.cause = error;
    throw failure;
  }
  if (!isNativeMapJson(parsed)) return null;
  if (config.mapData) return null; // Malformed legacy MapDefs use their strict legacy normalizer.
  try {
    return validateNativeMapJson(parsed);
  } catch (error) {
    const failure = new Error(
      `Failed to load Bonk map "${mapPath}": ${error instanceof Error ? error.message : String(error)}`,
    ) as Error & { cause?: unknown };
    failure.cause = error;
    throw failure;
  }
}

/** Capture records required per resident in a shared-memory batch. This is a
 * strict map inspection, never an override or a second simulation backend. */
export function getNativeCapZoneCapacityForPool(config: Partial<EnvironmentConfig> = {}): number {
  return configuredNativeMap(config)?.capZones.length ?? 0;
}

// ─── Environment ─────────────────────────────────────────────────────

/**
 * Resolve a reward weight from its input candidates (flat then nested, then
 * the documented literal). A candidate is skipped when it is absent, not
 * finite, or — for a penalty — positive; the first acceptable candidate wins.
 * This keeps every weight finite and penalties non-positive, so a misconfigured
 * value can never invert the reward signal (#220).
 */
function pickRewardWeight(
  flat: number | undefined,
  nested: number | undefined,
  fallback: number,
  nonPositivePenalty: boolean,
): number {
  for (const candidate of [flat, nested]) {
    if (candidate === undefined) continue;
    if (!Number.isFinite(candidate)) continue;
    if (nonPositivePenalty && candidate > 0) continue;
    return candidate;
  }
  return fallback;
}

/**
 * Derive the cap-zone sensor extent, placement, and rotation for a fixture
 * body. Rect fixtures are covered exactly: the sensor is the rect's own
 * width/height rotated by the fixture angle — not the rotated rect's
 * axis-aligned AABB, which over-covers the corners at non-orthogonal angles.
 * Circle fixtures use radius*2; polygon fixtures use the axis-aligned bounding
 * box of their (angle-rotated, local-space) vertices centered on the AABB
 * center — rect/circle fixtures are symmetric about their origin, so their
 * center is the origin itself, but polygons need the AABB center offset.
 * Returns null for malformed fixtures — fewer than 3 declared vertices, fewer
 * than 3 finite vertices, a zero-area (collinear/coincident) vertex set, or an
 * unsupported type — so the caller skips the sensor entirely instead of
 * silently building a zero-area sensor that can never capture (#277).
 */
function getCapZoneSensorSize(
  fixtureDef: MapBodyDef,
): { w: number; h: number; cx: number; cy: number; angle: number } | null {
  if (fixtureDef.type === 'rect') {
    // addBody() rotates rectangles about their origin (physics-engine.ts:
    // 763), so the sensor must be the same rect rotated by the same angle
    // — exact fidelity with the fixture. An axis-aligned AABB would
    // over-cover the rect's corners at non-orthogonal angles and trigger
    // captures outside the fixture.
    const width = fixtureDef.width || 0;
    const height = fixtureDef.height || 0;
    return {
      w: width,
      h: height,
      cx: 0,
      cy: 0,
      angle: fixtureDef.angle || 0,
    };
  }
  if (fixtureDef.type === 'circle') {
    const w = (fixtureDef.radius || 0) * 2;
    return { w, h: w, cx: 0, cy: 0, angle: 0 };
  }
  if (fixtureDef.type === 'polygon' && Array.isArray(fixtureDef.vertices)) {
    // Match addBody()'s validation (physics-engine.ts:698): fewer than 3
    // vertices is malformed and must take the loud warn path, and only
    // the first 8 vertices build the actual Box2D shape — the AABB must
    // cover the same vertex window.
    if (fixtureDef.vertices.length < 3) {
      console.warn(`CapZone fixture "${fixtureDef.name}" has insufficient vertices (need >= 3)`);
      return null;
    }
    // addBody() rotates the fixture about its origin by def.angle
    // (physics-engine.ts:682, radians), so the sensor AABB must cover
    // the rotated vertices — an unrotated box would land in the wrong
    // region for angle !== 0.
    const angle = fixtureDef.angle || 0;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    let area2 = 0;
    let finiteCount = 0;
    const maxVertices = Math.min(fixtureDef.vertices.length, 8);
    const finite: { x: number; y: number }[] = [];
    for (let i = 0; i < maxVertices; i++) {
      const v = fixtureDef.vertices[i];
      // Skip non-finite coordinates so a single NaN vertex cannot
      // silently zero the extent.
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      finiteCount++;
      const rx = v.x * cosA - v.y * sinA;
      const ry = v.x * sinA + v.y * cosA;
      finite.push({ x: rx, y: ry });
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    // Mirror the >= 3 vertex guard: fewer than 3 usable vertices cannot
    // describe an area, so stay loud instead of building a zero-size sensor.
    if (finiteCount < 3) {
      console.warn(`CapZone fixture "${fixtureDef.name}" has insufficient finite vertices`);
      return null;
    }
    // Shoelace cross-product sum over the vertex window rejects any
    // collinear or coincident set — axis-aligned or diagonal — which
    // addBody does NOT validate (it only checks vertex count), yet Box2D
    // would refuse to form a shape from it. Stay loud instead of building
    // a degenerate sensor.
    for (let i = 0; i < finite.length; i++) {
      const a = finite[i];
      const b = finite[(i + 1) % finite.length];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area2) < 1e-9) {
      console.warn(`CapZone fixture "${fixtureDef.name}" has a degenerate zero-area polygon`);
      return null;
    }
    return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, angle: 0 };
  }
  console.warn(
    `CapZone fixture "${fixtureDef.name}" has unsupported type "${fixtureDef.type}" — skipping cap-zone sensor`,
  );
  return null;
}

export class BonkEnvironment {
  private physics!: PhysicsEngine;
  /** Strict raw-native Classic path, including normalized dynamic map bodies.
   * Exporter/internal MapDefs remain on the legacy engine until their own
   * native migration is evidence-backed. */
  private nativeSession: NativeSession | null = null;
  private nativeMap: NativeMap | null = null;
  private nativeArena: ReturnType<typeof nativeMapToArena> | null = null;
  private nativeTick: number = 0;
  private readonly nativeCountdownTicks: 5 | 60 | 90;
  /** Native round countdown configuration; ordinary matches default to 90. */
  private nativeDeathViews: Map<number, PlayerState> = new Map();
  private nativeSnapshot: NativeSessionSnapshot | null = null;
  private closed: boolean = false;
  /** Stored resolved config: flat reward keys are not stored — only the nested
   * `reward` object holds the resolved weights (single source of truth) (#220). */
  private config: Required<
    Omit<EnvironmentConfig, 'killReward' | 'deathPenalty' | 'timePenalty' | 'reward' | 'mapData'>
  > & {
    reward: Required<ResolvedRewardConfig>;
    mapData?: MapDef;
  };
  private aiPlayerId: number = 0;
  private opponentIds: number[] = [];
  private aiTeam: string = 'blue';
  private scoreBlue: number = 0;
  private scoreRed: number = 0;
  /** Per-player alive flags from the previous tick, used by the respawn-aware
   *  reward calculation (#339/#341): a disc that died and respawned counts
   *  alive-again on the next tick without re-firing the death penalty. */
  private previousAliveState: Map<number, boolean> = new Map();
  private rng: PRNG;
  private lastAction: PlayerInput = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
  private frameSkipTicks: number = 0;
  private terminalReached: boolean = false;
  // Terminal cause as recorded when the episode ended: the tail (hold)
  // steps replay these flags instead of hardcoding `truncated: false` /
  // `terminated: true`, which inverted truncation into termination (#197).
  private terminalTruncated: boolean = false;
  private terminalTerminated: boolean = false;
  private _obsBuffer: Float32Array = new Float32Array(16);
  private ppm: number = 12;
  private capZones: Array<{ index: number; owner: string; type: number }> = [];
  private mapBounds: { width: number; height: number } | null = null;
  /** Map-relative OOB death-circle center (physics.deathCenter), if declared. */
  private mapDeathCenter: { x: number; y: number } | null = null;
  /** Reused by getObservationArenaBounds so the fast observation path allocates nothing. */
  private _obsArenaBoundsCache: { halfWidth: number; halfHeight: number } = { halfWidth: 0, halfHeight: 0 };

  constructor(config: Partial<EnvironmentConfig> = {}) {
    // Normalize config: accept both camelCase and snake_case. The
    // camelCase key wins when present (an explicit per-env value); the
    // snake_case alias is only consulted when the camelCase key is
    // absent, which the alias-aware config merge guarantees for keys
    // that only carry injected defaults (#204).
    const rawConfig = config as any;
    const frameSkip = config.frameSkip ?? rawConfig.frame_skip;
    const nativeMode = rawConfig.nativeMode ?? 'b';
    if (
      nativeMode !== 'b' &&
      nativeMode !== 'ar' &&
      nativeMode !== 'ard' &&
      nativeMode !== 'v' &&
      nativeMode !== 'sp' &&
      nativeMode !== 'bs' &&
      nativeMode !== 'f'
    ) {
      throw new Error(
        `Invalid nativeMode ${JSON.stringify(nativeMode)}: expected original gameSettings.mo b, ar, ard, v, sp or bs, or gameSettings.ga f`,
      );
    }
    if (nativeMode === 'f' && !config.teamsEnabled) {
      // Native football is a teams-only mode: createNewState spawns only teams
      // 2 and 3. An FFA football room is not a native configuration.
      throw new Error('Invalid nativeMode f: native football requires teamsEnabled (teams 2 and 3)');
    }

    // Validate before map loading or world construction (#392). This keeps an
    // oversized opponent count from exhausting the fixed Box2D broadphase
    // pair table and surfacing its opaque library-internal TypeError instead.
    const numOpponents = SharedMemoryManager.normalizeNumOpponents(config.numOpponents ?? rawConfig.num_opponents ?? 1);

    // Load map from file or use provided config. `mapData` (programmatic)
    // wins; otherwise the documented map-path surface is honored end to
    // end: the config-loader resolves `--map` / `DEFAULT_MAP_PATH` /
    // `environment.defaultMapPath` into `defaultMapPath`, which the worker
    // forwards verbatim. `mapPath` is the per-env programmatic override;
    // the hardcoded WDB path is only the last-resort fallback.
    let mapFile = '';
    const nativeModeValue = rawConfig.nativeMode ?? 'b';
    const nativeMap = nativeModeValue === 'f' ? null : configuredNativeMap(config);
    if (nativeMap) {
      // Arrow, Death Arrow and VTOL mechanics are not implemented in the
      // unified dynamic world; reject a dynamic map for those modes at
      // construction instead of silently dropping the mode mechanics.
      // sp and bs run on the unified world when the map needs it (native
      // step reads gameSettings.mo from the room settings argument,
      // readable :7221); m.mo never selects physics (display metadata,
      // readable :27591/:11269/:33953).
      if (nativeModeValue === 'ar' || nativeModeValue === 'ard' || nativeModeValue === 'v') {
        const probe = nativeMapToArena(nativeMap);
        if ('physics' in probe) {
          throw new Error(
            `Invalid configuration: nativeMode ${JSON.stringify(nativeModeValue)} requires a static arena; ` +
              'the configured native map uses dynamic mechanics (moving bodies, joints, shrink, force zones or capture zones) ' +
              'that are only simulated by the unified dynamic world, which implements modes b, sp and bs only.',
          );
        }
        this.nativeArena = probe;
      } else {
        this.nativeArena = nativeMapToArena(nativeMap, nativeModeValue as 'b' | 'sp' | 'bs');
      }
    }
    let mapDef: MapDef | undefined = nativeMap ? undefined : config.mapData ? normalizeMap(config.mapData) : undefined;
    if (nativeModeValue === 'f') {
      // Football has no map JSON: the pitch is hardcoded in the native
      // FootballPhysics class. Any map configuration would be silently
      // ignored, so reject it instead.
      if (config.mapData || config.mapPath || config.defaultMapPath) {
        throw new Error(
          'Invalid nativeMode f configuration: native football has no map; remove mapData/mapPath/defaultMapPath',
        );
      }
    } else if (!config.mapData && !nativeMap) {
      // Legacy maps retain their historical loader and fallback path. Native
      // failures are thrown by configuredNativeMap before this branch.
      const configuredPath = config.mapPath || config.defaultMapPath || '';
      const mapPath = configuredPath
        ? resolveMapPath(configuredPath)
        : path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
      const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      mapDef = normalizeMap(parsed);
      mapFile = mapPath;
    }
    // A non-Classic native room mode with no native map would silently fall
    // back to the legacy engine and ignore the requested mode — the exact
    // "silently omit mechanics" failure the map contract forbids. Legacy
    // maps are only supported in the native Classic room mode 'b', whose
    // native session accepts the legacy arena conversion. Every other
    // native mode requires a native map (mapData/mapPath/defaultMapPath in
    // native format). Fail loudly instead of training on the wrong engine.
    if (nativeModeValue !== 'b' && nativeModeValue !== 'f' && !nativeMap) {
      const configuredPath = config.mapPath || config.defaultMapPath || '';
      throw new Error(
        `Invalid configuration: nativeMode ${JSON.stringify(nativeModeValue)} requires a native map ` +
          `(mapData/mapPath/defaultMapPath in native format); ` +
          (configuredPath ? `"${configuredPath}" is not a native map. ` : 'no map was configured. ') +
          `Legacy maps are only supported with nativeMode 'b' (default).`,
      );
    }

    // Read map-level physics overrides. Raw native maps are authoritative for
    // PPM and s.re/s.nc/s.fl; legacy tuning is rejected before a native reset.
    this.nativeMap = nativeMap ?? null;
    const nativeCountdownTicks = rawConfig.countdownTicks ?? 90;
    if (nativeCountdownTicks !== 5 && nativeCountdownTicks !== 60 && nativeCountdownTicks !== 90) {
      throw new Error(`Invalid native countdownTicks ${nativeCountdownTicks}: expected 5, 60 or 90`);
    }
    this.nativeCountdownTicks = nativeCountdownTicks;
    this.ppm = this.nativeArena?.ppm ?? config.ppm ?? mapDef?.physics?.ppm ?? 12;
    this.capZones = this.nativeArena ? [] : (mapDef?.capZones ?? []);
    // Opponent random-policy probabilities: accept both the direct
    // opp*Prob names and the config-loader's documented randomOpp*Prob
    // aliases; an explicit opp*Prob value wins over the alias.
    const oppMoveProb = config.oppMoveProb ?? config.randomOppMoveProb ?? 0.2;
    const oppUpProb = config.oppUpProb ?? config.randomOppUpProb ?? 0.15;
    const oppDownProb = config.oppDownProb ?? config.randomOppDownProb ?? 0.1;
    const oppHeavyProb = config.oppHeavyProb ?? config.randomOppHeavyProb ?? 0.05;
    const oppGrappleProb = config.oppGrappleProb ?? config.randomOppGrappleProb ?? (nativeMap ? 0 : 0.05);

    // Reward shaping weights. The flat killReward/deathPenalty/timePenalty
    // input aliases win over the nested reward section; both are resolved
    // into a single stored reward object (this.config.reward) that is the
    // only state calculateReward reads — never two copies kept in sync.
    // Penalties are non-positive and every weight finite; an invalid value
    // falls through to the next candidate and then the documented literal
    // so config-free environments keep the same rewards (#220).
    const reward = {
      killReward: pickRewardWeight(config.killReward, config.reward?.killReward, 1.0, false),
      deathPenalty: pickRewardWeight(config.deathPenalty, config.reward?.deathPenalty, -1.0, true),
      timePenalty: pickRewardWeight(config.timePenalty, config.reward?.timePenalty, -0.001, true),
    };

    this.config = {
      numOpponents,
      maxTicks: config.maxTicks ?? rawConfig.max_ticks ?? MAX_TICKS_DEFAULT,
      randomOpponent: config.randomOpponent ?? rawConfig.random_opponent ?? true,
      mapData: mapDef,
      nativeMode,
      countdownTicks: this.nativeCountdownTicks,
      roundsToWin: config.roundsToWin ?? rawConfig.rounds_to_win ?? 3,
      // Seed 0 is a valid deterministic seed and must reach the PRNG: a
      // truthiness check would map `--seed 0` / `SEED=0` /
      // `environment.seed: 0` onto a random seed while reset(0) and
      // pool.reset([0]) stay deterministic, silently breaking
      // constructed-env replay (#200). Only an absent seed (undefined/
      // null) falls back to a random one.
      seed: config.seed !== undefined && config.seed !== null ? config.seed : Math.floor(Math.random() * 1000000),
      frameSkip: frameSkip ?? 1,
      ppm: this.ppm,
      mapPath: mapFile,
      defaultMapPath: config.defaultMapPath ?? '',
      aiPlayerId: config.aiPlayerId ?? 0,
      oppMoveProb,
      oppUpProb,
      oppDownProb,
      oppHeavyProb,
      oppGrappleProb,
      randomOppMoveProb: oppMoveProb,
      randomOppUpProb: oppUpProb,
      randomOppDownProb: oppDownProb,
      randomOppHeavyProb: oppHeavyProb,
      randomOppGrappleProb: oppGrappleProb,
      teamsEnabled: config.teamsEnabled ?? (mapDef as any)?.physics?.teams ?? false,
      noCollide: nativeMap?.s.nc ?? config.noCollide ?? mapDef?.settings?.nc ?? mapDef?.physics?.nc ?? false,
      flipped: nativeMap?.s.fl ?? config.flipped ?? !!mapDef?.settings?.fl,
      respawnEnabled: nativeMap?.s.re ?? config.respawnEnabled ?? !!mapDef?.settings?.re,
      physics: config.physics ?? {},
      arena: config.arena ?? {},
      player: config.player ?? {},
      reward,
    };

    // The truncation predicate is `tickCount >= maxTicks`, so a
    // non-positive maxTicks would make every step terminal and truncated
    // from tick 1 — a permanently-terminal env that auto-resets forever
    // (#266). Reject it loudly at construction (the choke point every
    // surface converges on: programmatic, config.json, worker, IPC).
    if (!Number.isInteger(this.config.maxTicks) || this.config.maxTicks < 1) {
      throw new Error(`Invalid maxTicks ${this.config.maxTicks}: expected a positive integer`);
    }

    // frameSkip is the per-cycle tick window the frame-skip machinery
    // compares against directly: NaN freezes action input forever
    // (`frameSkipTicks >= NaN` is never true, so the counter never resets
    // to 0 and lastAction is never re-decoded), a fractional value
    // silently widens the terminal-hold window to ceil(frameSkip) done
    // steps — which the Python client's `_frame_skip_window` rejects and
    // then misclassifies as extra episode boundaries — and a non-positive
    // value disables the terminal hold entirely (#393). Fail loudly here,
    // at the choke point every forwarding surface converges on
    // (programmatic, config.json, worker init, IPC), mirroring the
    // maxTicks guard and the Python client's [1, MAX_FRAME_SKIP] contract.
    if (
      !Number.isInteger(this.config.frameSkip) ||
      this.config.frameSkip < 1 ||
      this.config.frameSkip > MAX_FRAME_SKIP
    ) {
      throw new Error(`Invalid frameSkip ${this.config.frameSkip}: expected an integer in [1, ${MAX_FRAME_SKIP}]`);
    }

    // The AI slot is config-driven, never hardcoded to 0 (#221). An
    // out-of-range slot fails loudly here instead of being silently
    // ignored: with numOpponents opponents the spawned players occupy
    // slots [0, numOpponents] (the AI plus one slot per opponent).
    this.aiPlayerId = this.config.aiPlayerId;
    if (!Number.isInteger(this.aiPlayerId) || this.aiPlayerId < 0) {
      throw new Error(`Invalid aiPlayerId ${this.aiPlayerId}: expected a non-negative integer player slot`);
    }
    if (this.aiPlayerId > this.config.numOpponents) {
      throw new Error(
        `Invalid aiPlayerId ${this.aiPlayerId}: with ${this.config.numOpponents} opponent(s) the player slots are 0..${this.config.numOpponents}`,
      );
    }

    // The constructor seed slot shares the pool's supported domain
    // [0, MAX_SUPPORTED_RESET_SEED] (#460): the PRNG normalizes any number
    // with `seed >>> 0`, silently bit-casting negatives, wrapping values
    // >= 2^32 and truncating fractions onto a DIFFERENT stream than the
    // caller requested. Every other seeding surface (both pool transports,
    // the IPC bridge, the Python client) already rejects exactly these
    // values, so accepting them here would make a rollout recorded through
    // the direct API unreproducible through any other surface. Only an
    // absent seed (undefined/null) falls back to a random one above (#200).
    assertSupportedSeed(this.config.seed, 'constructor');

    this.rng = new PRNG(this.config.seed);
    if (this.nativeMap || this.config.nativeMode === 'f') {
      this.initializeNativeSession(rawConfig);
      return;
    }
    if (!mapDef) throw new Error('Legacy environment requires a normalized MapDef');
    const legacyMap = mapDef;
    this.physics = new PhysicsEngine({
      ticksPerSecond: config.physics?.ticksPerSecond,
      velocityIterations: config.physics?.solverIterations,
      positionIterations: config.physics?.positionIterations,
      // Per-map native physics quality (pq): 2 → 15/15 solver iterations,
      // anything else → 2/6 (DEOBFUSCATION §Solver Iterations). Explicit
      // solverIterations/positionIterations config keys override it.
      physicsQuality: this.config.mapData!.settings?.pq,
      // Per-map native settings (P3b): `fl` flips the move-force base,
      // `re` enables immediate respawn on death (except cap-zone
      // eliminations). Resolved at construction (config wins over the
      // map) and forwarded like pq — the raw config object is not a
      // settings source the engine re-reads.
      flipped: this.config.flipped,
      respawnEnabled: this.config.respawnEnabled,
      scale: config.physics?.scale,
      gravityX: config.physics?.gravityX,
      gravityY: config.physics?.gravityY,
      enableSleeping: config.physics?.enableSleeping,
      worldAabbExtent: config.physics?.worldAabbExtent,
      arenaHalfWidth: config.arena?.defaultHalfWidth,
      arenaHalfHeight: config.arena?.defaultHalfHeight,
      arenaBoundsMargin: config.arena?.boundsMargin,
      moveForce: config.player?.moveForce,
      heavyForceMultiplier: config.player?.heavyMassMultiplier,
    });

    // Size the fast-observation buffer for the configured opponent count
    // (7 player floats + 6 per opponent + 2 arena + 1 tick). The first
    // opponent keeps offsets 7-12 and arena/tick stay at 13-15, so the
    // default single-opponent layout matches the legacy 16-float record;
    // additional opponents append 6-float blocks after the tick.
    this._obsBuffer = new Float32Array(16 + 6 * Math.max(0, this.config.numOpponents - 1));

    // Apply verified native game settings before adding bodies
    this.physics.setTeamsEnabled(this.config.teamsEnabled);
    this.physics.setNoCollide(this.config.noCollide);

    // Set PPM before adding bodies. setPpm is the canonical setter; the
    // legacy setScale alias (same PPM semantics) is accepted too so an
    // engine exposing only the pre-#319 API still receives its PPM config.
    if (typeof (this.physics as any).setPpm === 'function') {
      (this.physics as any).setPpm(this.ppm);
    } else if (typeof (this.physics as any).setScale === 'function') {
      (this.physics as any).setScale(this.ppm);
    }

    for (const body of this.config.mapData!.bodies) {
      this.physics.addBody(body);
    }

    // Add joints if defined
    if (legacyMap.joints && legacyMap.joints.length > 0) {
      const bodyMap = (this.physics as any).getBodyMap?.();
      if (bodyMap) {
        // Create non-gear joints FIRST so gear referents (which the
        // engine resolves from the created-joint map) always exist,
        // regardless of the joint array order.
        const gearJoints: any[] = [];
        for (const j of legacyMap.joints) {
          if (j.type === 'g' || j.type === 'gear') gearJoints.push(j);
          else (this.physics as any).addJoint(j, bodyMap);
        }
        for (const j of gearJoints) {
          (this.physics as any).addJoint(j, bodyMap);
        }
      }
    }

    // Add capZone sensors from map data
    if (legacyMap.capZones && legacyMap.capZones.length > 0) {
      for (const zone of legacyMap.capZones) {
        const fixtureDef = legacyMap.bodies.find((b) => b.name === zone.fixture);
        if (fixtureDef) {
          const size = getCapZoneSensorSize(fixtureDef);
          if (size && typeof (this.physics as any).addCapZone === 'function') {
            (this.physics as any).addCapZone(
              zone,
              fixtureDef.x + size.cx,
              fixtureDef.y + size.cy,
              size.w,
              size.h,
              size.angle,
            );
          }
        } else {
          console.warn(`CapZone fixture "${zone.fixture}" not found`);
        }
      }
    }

    // Cache explicit map bounds — reset() re-adds bodies, which recomputes
    // dynamic bounds, so the override must be re-applied after every reset.
    this.mapBounds = legacyMap.physics?.bounds ?? null;

    // Cache the map's OOB death-circle center (physics.deathCenter). The
    // native death circle is centered on the map's authored origin (850 map
    // units, DEOBFUSCATION "Death Type 4"); exported maps whose coordinates
    // are offset from the world origin carry that center here. Maps without
    // one use the engine default (world origin), preserving origin-centered
    // behavior for hand-built maps.
    this.mapDeathCenter = legacyMap.physics?.deathCenter ?? null;
    if (this.mapDeathCenter && typeof (this.physics as any).setDeathCircleCenter === 'function') {
      this.physics.setDeathCircleCenter(this.mapDeathCenter.x, this.mapDeathCenter.y);
    }

    this.reset();
  }

  /**
   * Reset the environment to initial state, returning the first observation.
   */
  reset(seed?: number): Observation {
    if (this.closed) throw new Error('BonkEnvironment is closed');
    if (seed !== undefined) {
      assertSupportedSeed(seed, 'reset');
      this.config.seed = seed;
      this.rng.setSeed(seed);
    }
    if (this.nativeMap || this.config.nativeMode === 'f') {
      this.resetNativeSession();
      return this.getObservation();
    }
    this.scoreBlue = 0;
    this.scoreRed = 0;
    // Discard the old Box2D world instead of destroying bodies in-place;
    // the bundled port can retain invalid broadphase bounds after teardown.
    this.physics.reset();

    // Re-add platforms to the fresh world
    for (const body of this.config.mapData!.bodies) {
      this.physics.addBody(body);
    }

    // Re-add joints if defined
    if (this.config.mapData!.joints && this.config.mapData!.joints.length > 0) {
      const bodyMap = (this.physics as any).getBodyMap?.();
      if (bodyMap) {
        const gearJoints: any[] = [];
        for (const j of this.config.mapData!.joints!) {
          if (j.type === 'g' || j.type === 'gear') gearJoints.push(j);
          else (this.physics as any).addJoint(j, bodyMap);
        }
        for (const j of gearJoints) {
          (this.physics as any).addJoint(j, bodyMap);
        }
      }
    }

    // Re-add capZone sensors
    if (this.config.mapData!.capZones && this.config.mapData!.capZones.length > 0) {
      for (const zone of this.config.mapData!.capZones) {
        const fixtureDef = this.config.mapData!.bodies.find((b) => b.name === zone.fixture);
        if (fixtureDef) {
          const size = getCapZoneSensorSize(fixtureDef);
          if (size && typeof (this.physics as any).addCapZone === 'function') {
            (this.physics as any).addCapZone(
              zone,
              fixtureDef.x + size.cx,
              fixtureDef.y + size.cy,
              size.w,
              size.h,
              size.angle,
            );
          }
        }
      }
    }

    // Extract spawn positions from map using team keys
    const spawnPoints = this.config.mapData!.spawnPoints;
    const spawnKeys = Object.keys(spawnPoints);
    const teamB = spawnPoints.team_blue ||
      (spawnKeys.length > 0 ? spawnPoints[spawnKeys[0]] : null) || { x: -200, y: -100 };
    const teamR = spawnPoints.team_red || { x: 200, y: -100 };

    // Add the AI player on its configured slot (never reassigned to 0
    // here), then one opponent per remaining slot of [0, numOpponents]
    // (#221). The AI spawns on the blue team spawn and opponents on the
    // red team spawn regardless of slot numbering, as before.
    //
    // Re-apply the AI slot to the engine every reset (setPlayerTeam below
    // is re-applied per episode too): the default collision categories
    // keep the AI disc on g1 and opponents on g2 whatever their slots.
    this.physics.setAiPlayerId(this.aiPlayerId);
    this.physics.addPlayer(this.aiPlayerId, teamB.x, teamB.y);

    // Add opponent(s)
    this.opponentIds = [];
    for (let slot = 0; slot <= this.config.numOpponents; slot++) {
      if (slot === this.aiPlayerId) continue;
      this.physics.addPlayer(slot, teamR.x, teamR.y);
      this.opponentIds.push(slot);
    }

    // Set team assignments
    if (typeof (this.physics as any).setPlayerTeam === 'function') {
      (this.physics as any).setPlayerTeam(this.aiPlayerId, this.aiTeam);
      for (const id of this.opponentIds) {
        (this.physics as any).setPlayerTeam(id, this.aiTeam === 'blue' ? 'red' : 'blue');
      }
    }

    // Re-apply explicit map bounds last — body re-adds above recomputed
    // dynamic bounds and would otherwise clobber the override every reset.
    // MapDef physics.bounds are map pixels, while setMapBounds consumes
    // internal world metres; convert with the engine's resolved scale so
    // custom physics.scale values preserve the observation's map-pixel unit.
    // Both methods are duck-checked: an engine exposing setMapBounds but not
    // getScale skips the override instead of throwing in reset(). The
    // returned scale itself is also validated — a partial engine reporting
    // 0/NaN would otherwise silently store Infinity/NaN bounds.
    if (
      this.mapBounds &&
      typeof (this.physics as any).setMapBounds === 'function' &&
      typeof (this.physics as any).getScale === 'function'
    ) {
      const scale = (this.physics as any).getScale();
      if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
        this.physics.setMapBounds(this.mapBounds.width / scale, this.mapBounds.height / scale);
      }
    }

    // Re-apply the map's OOB death-circle center — like mapBounds it is a
    // map-level override that must survive the fresh world of every reset.
    if (this.mapDeathCenter && typeof (this.physics as any).setDeathCircleCenter === 'function') {
      this.physics.setDeathCircleCenter(this.mapDeathCenter.x, this.mapDeathCenter.y);
    }

    // Reset frame skip state
    this.frameSkipTicks = 0;
    this.terminalReached = false;
    this.terminalTruncated = false;
    this.terminalTerminated = false;
    this.lastAction = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };

    return this.getObservation();
  }

  /**
   * Step the environment by one tick with the given AI action.
   *
   * @param action Either a PlayerInput object or an integer encoding:
   *   - Bit 0: left
   *   - Bit 1: right
   *   - Bit 2: up
   *   - Bit 3: down
   *   - Bit 4: heavy
   *   - Bit 5: grapple
   */
  step(action: Action): StepResult {
    if (this.closed) throw new Error('BonkEnvironment is closed');
    assertValidAction(action);
    if (this.nativeSession) return this.stepNative(action);
    const result = this.stepLegacy(action);
    // Boundary metadata describes what the environment actually did after
    // producing this result, not an inferred done/tick transition.
    result.info.autoResetAfter = result.done && !this.isTerminalHoldActive();
    return result;
  }

  private stepLegacy(action: Action): StepResult {
    // If terminal was already reached in a previous tick of this cycle,
    // return done immediately without stepping physics further (rewards
    // were already accumulated). terminalReached is only cleared by an
    // explicit reset(): once the frame-skip hold window elapses, the
    // episode stays idle (no physics advance, same flags) instead of
    // resuming physics past maxTicks (#197). frameSkipTicks keeps
    // counting terminal reports so isTerminalHoldActive() can tell the
    // worker layer when the hold window has been served.
    if (this.terminalReached) {
      // Cap the counter at frameSkip so a long idle terminal stretch
      // (until an explicit reset) never grows it unboundedly; the
      // hold-active predicate reads only whether it is below frameSkip.
      this.frameSkipTicks = Math.min(this.frameSkipTicks + 1, this.config.frameSkip);
      const observation = this.getObservation();
      return {
        observation,
        reward: 0,
        done: true,
        truncated: this.terminalTruncated,
        terminated: this.terminalTerminated,
        info: {
          tick: this.physics.getTickCount(),
          aiAlive: this.getVisiblePlayerState(this.aiPlayerId).alive,
          opponentsAlive: this.opponentIds.filter((id) => this.getVisiblePlayerState(id).alive).length,
          terminated: this.terminalTerminated,
          frameSkip: this.config.frameSkip,
          capZones: this.capZones,
          scoreBlue: this.scoreBlue,
          scoreRed: this.scoreRed,
          aiTeam: this.aiTeam,
          terminal_observation: observation,
        },
      };
    }

    // If starting a new frame skip cycle, update the stored action. Object
    // actions must be snapshotted BY VALUE: they are supplied as the caller's
    // own reference, and this.lastAction is re-applied on every intermediate
    // tick of the hold window. A caller that reuses/mutates one PlayerInput
    // dict between step() calls would otherwise silently change the held
    // inputs mid-cycle (#399). Encoded numbers need no extra copy:
    // decodeEncodedAction already builds a fresh object.
    if (this.frameSkipTicks === 0) {
      this.lastAction = typeof action === 'number' ? this.decodeAction(action) : { ...action };
    }

    const aiInput = this.lastAction;

    // Drain deferred respawns BEFORE any input is applied (#409): a disc
    // queued by the previous tick's death pass must be alive at its spawn
    // when applyInput runs, or the action sent for the tick in which it
    // becomes visible is silently dropped by the engine's alive-guard.
    // tick() keeps an idempotent drain for direct engine drivers; the
    // #339 dying-step observability contract is untouched — deaths are
    // still snapshotted and queued only at the end of the dying tick.
    this.physics.processRespawns();

    // Apply AI input
    this.physics.applyInput(this.aiPlayerId, aiInput);

    // Apply opponent inputs (random policy)
    for (const opId of this.opponentIds) {
      const opInput = this.getOpponentInput(opId);
      this.physics.applyInput(opId, opInput);
    }

    // Step physics by exactly 1 tick
    this.physics.tick();

    // Consume the tick's death events (the reward source). Physics keeps
    // the pre-respawn snapshots itself and exposes them through
    // getVisiblePlayerState, so observation/info read the dying step even
    // though the disc already respawned.
    const deathEvents = this.physics.getDeathEvents();

    // Cache both the physical post-tick state (termination policy) and the
    // event-overlaid state (the public dying-step observation contract).
    const aiPhysicsState = this.physics.getPlayerState(this.aiPlayerId);
    const opponentPhysicsStates = this.opponentIds.map((id) => this.physics.getPlayerState(id));
    const aiState = this.getVisiblePlayerState(this.aiPlayerId);
    const opponentStates = this.opponentIds.map((id) => this.getVisiblePlayerState(id));

    // Calculate reward
    const reward = this.calculateReward(deathEvents);

    // Update previous alive state for next reward calculation
    this.previousAliveState.set(this.aiPlayerId, aiState.alive);
    for (let i = 0; i < this.opponentIds.length; i++) {
      this.previousAliveState.set(this.opponentIds[i], opponentStates[i].alive);
    }

    // Check for terminal state (permanent death or maxTicks). On a respawn
    // map a lethal/OOB death is observable this step (aiAlive false,
    // deathPenalty/killReward fire) but the engine queues the disc for its
    // deferred respawn, so the death does NOT terminate the episode — the
    // round continues with the respawned disc, matching native `re`
    // semantics (issue #339, coordinated with the #341/#371 death
    // contract). Only a permanent death terminates: cap-zone elimination
    // (type 3), respawning disabled, or an invalid spawn point that
    // detached immediately. With zero opponents the empty-state check
    // must not be vacuously true: an episode with no opponents can only
    // end via the AI's permanent death or truncation.
    const aiPendingRespawn = this.physics.isPendingRespawn(this.aiPlayerId);
    const allOpponentsPermanentlyDead =
      opponentStates.length > 0 &&
      opponentStates.every((s, i) => !s.alive && !this.physics.isPendingRespawn(this.opponentIds[i]));
    const terminated = (!aiState.alive && !aiPendingRespawn) || allOpponentsPermanentlyDead;
    const truncated = this.physics.getTickCount() >= this.config.maxTicks;

    // If terminal reached, set flag to report done immediately on subsequent ticks.
    // Record the terminal cause so the hold tail reports the same flags as
    // the ending step instead of inverting truncation into termination (#197).
    if (terminated || truncated) {
      this.terminalReached = true;
      this.terminalTruncated = truncated;
      this.terminalTerminated = terminated;
    }

    // Increment frame skip counter
    this.frameSkipTicks++;

    // A normal cycle boundary (no terminal state) starts a fresh frame-skip
    // cycle. When the episode ends on this step the counter is left at the
    // boundary value: the hold window is measured through the current cycle,
    // and a terminal step that lands exactly on the boundary serves no hold
    // tail steps (isTerminalHoldActive already reports false).
    if (this.frameSkipTicks >= this.config.frameSkip && !terminated && !truncated) {
      this.frameSkipTicks = 0;
    }

    const observation = this.getObservation();

    return {
      observation,
      reward,
      done: terminated || truncated,
      truncated,
      terminated,
      info: {
        tick: this.physics.getTickCount(),
        aiAlive: aiState.alive,
        opponentsAlive: opponentStates.filter((s) => s.alive).length,
        terminated,
        frameSkip: this.config.frameSkip,
        capZones: this.capZones,
        scoreBlue: this.scoreBlue,
        scoreRed: this.scoreRed,
        aiTeam: this.aiTeam,
        ...(terminated || truncated ? { terminal_observation: observation } : {}),
      },
    };
  }

  /**
   * Close the environment and release resources.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.nativeSession?.dispose();
    this.nativeSession = null;
    try {
      this.physics.destroy();
    } catch (e: any) {
      console.warn('[BonkEnvironment] close: physics destroy failed:', e?.message || e);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────

  /** Reject legacy tuning that would otherwise be silently ignored by native
   * simulation. These remain available to the explicitly legacy MapDef path. */
  private initializeNativeSession(rawConfig: Readonly<Record<string, any>>): void {
    this.validateNativeConfig();
    for (const key of ['ppm', 'noCollide', 'no_collide', 'flipped', 'respawnEnabled', 'respawn_enabled']) {
      if (rawConfig[key] !== undefined)
        throw new Error(`Unsupported native environment config: ${key} overrides cannot change authored map settings`);
    }
    this.ppm = this.nativeArena?.ppm ?? (this.config.nativeMode === 'f' ? 11 : this.ppm);
    this.capZones = [];
    this.physics = new PhysicsEngine();
    this.mapBounds = { width: NATIVE_MAP_WIDTH, height: NATIVE_MAP_HEIGHT };
    this._obsBuffer = new Float32Array(16 + 6 * Math.max(0, this.config.numOpponents - 1));
    this.opponentIds = Array.from({ length: this.config.numOpponents + 1 }, (_, id) => id).filter(
      (id) => id !== this.aiPlayerId,
    );
    this.reset();
  }

  private validateNativeConfig(): void {
    const hasValues = (value: object | undefined): boolean => value !== undefined && Object.keys(value).length > 0;
    if (hasValues(this.config.physics) || hasValues(this.config.arena) || hasValues(this.config.player)) {
      throw new Error(
        'Unsupported native environment config: physics/arena/player legacy tuning cannot override native simulation',
      );
    }
    if (!Number.isInteger(this.config.maxTicks) || this.config.maxTicks < 1) {
      throw new Error(`Invalid maxTicks ${this.config.maxTicks}: expected a positive integer`);
    }
    if (
      !Number.isInteger(this.config.frameSkip) ||
      this.config.frameSkip < 1 ||
      this.config.frameSkip > MAX_FRAME_SKIP
    ) {
      throw new Error(`Invalid frameSkip ${this.config.frameSkip}: expected an integer in [1, ${MAX_FRAME_SKIP}]`);
    }
    if (
      !Number.isInteger(this.config.aiPlayerId) ||
      this.config.aiPlayerId < 0 ||
      this.config.aiPlayerId > this.config.numOpponents
    ) {
      throw new Error(
        `Invalid aiPlayerId ${this.config.aiPlayerId}: expected a slot in [0, ${this.config.numOpponents}]`,
      );
    }
    const probabilities = [
      this.config.oppMoveProb,
      this.config.oppUpProb,
      this.config.oppDownProb,
      this.config.oppHeavyProb,
      this.config.oppGrappleProb,
    ];
    if (probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('Invalid native opponent policy: probabilities must be finite values in [0, 1]');
    }
    if (this.config.oppGrappleProb > 0) {
      throw new Error(
        'Unsupported native environment config: random grapple policy requires the unified grapple backend; set oppGrappleProb to 0',
      );
    }
  }

  private createNativePlayers(): Array<{ id: number; team: 1 | 2 | 3 | 4 | 5 }> {
    return Array.from({ length: this.config.numOpponents + 1 }, (_, id) => ({
      id,
      // The native map has no room-level roster. RL supplies a two-team roster
      // only when teams are explicitly enabled; ordinary public play is FFA.
      team: (this.config.teamsEnabled ? (id === this.aiPlayerId ? 3 : 2) : 1) as 1 | 2 | 3,
    }));
  }

  private resetNativeSession(): void {
    if (this.config.nativeMode === 'f') {
      // Football: standalone native physics with no map. The roster must
      // contain both native football teams (validated at construction).
      this.nativeSession?.dispose();
      this.nativeSession = createNativeFootballSession({
        players: this.createNativePlayers(),
        seed: this.config.seed,
        roundsToWin: this.config.roundsToWin ?? 3,
      });
      this.nativeTick = 0;
      this.nativeSnapshot = this.nativeSession.getState();
      this.nativeDeathViews.clear();
      this.scoreBlue = this.nativeSnapshot.scores[3] ?? 0;
      this.scoreRed = this.nativeSnapshot.scores[2] ?? 0;
      this.previousAliveState.clear();
      for (const disc of this.nativeSnapshot.discs) {
        if (disc) this.previousAliveState.set(disc.id, disc.alive);
      }
      this.frameSkipTicks = 0;
      this.terminalReached = false;
      this.terminalTruncated = false;
      this.terminalTerminated = false;
      this.lastAction = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
      return;
    }
    if (!this.nativeMap || !this.nativeArena) throw new Error('Native session requires a validated native map');
    this.nativeSession?.dispose();
    const sessionOptions = {
      map: this.nativeMap,
      players: this.createNativePlayers(),
      seed: this.config.seed,
      teamsEnabled: this.config.teamsEnabled,
      countdownTicks: this.nativeCountdownTicks,
    } as const;
    // Modes sp and bs run on the unified dynamic world when the map needs it
    // (native step reads gameSettings.mo from the room settings argument,
    // readable :7221); ar/ard/v were rejected at construction for dynamic
    // maps, so they always take the static mode session here.
    this.nativeSession =
      this.config.nativeMode === 'b' || (this.config.nativeMode !== 'sp' && this.config.nativeMode !== 'bs')
        ? this.config.nativeMode === 'b'
          ? createNativeMapSession(sessionOptions)
          : createNativeMapModeSession({ ...sessionOptions, mode: this.config.nativeMode as 'ar' | 'ard' | 'v' })
        : createNativeMapModeSession({ ...sessionOptions, mode: this.config.nativeMode as 'sp' | 'bs' });
    this.nativeTick = 0;
    this.nativeSnapshot = this.nativeSession.getState();
    this.nativeDeathViews.clear();
    this.scoreBlue = 0;
    this.scoreRed = 0;
    this.previousAliveState.clear();
    for (const disc of this.nativeSnapshot.discs) {
      if (disc) this.previousAliveState.set(disc.id, disc.alive);
    }
    this.frameSkipTicks = 0;
    this.terminalReached = false;
    this.terminalTruncated = false;
    this.terminalTerminated = false;
    this.lastAction = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
  }

  private nativePlayerState(id: number, state = this.nativeState()): PlayerState {
    const death = this.nativeDeathViews.get(id);
    // A permanent native elimination removes the disc-table entry. The public
    // death view remains complete throughout the terminal hold, so it must not
    // require a live outgoing entry merely to read angle/heavy state.
    const source =
      death ??
      (() => {
        const disc = this.nativeDisc(id, state);
        return {
          x: disc.x,
          y: disc.y,
          velX: disc.xv,
          velY: disc.yv,
          angle: disc.angle,
          angularVel: disc.angularVelocity,
          isHeavy: disc.heavy,
          alive: disc.alive,
          deathType: 0,
        };
      })();
    return {
      x: source.x * this.ppm - NATIVE_ORIGIN_X,
      y: source.y * this.ppm - NATIVE_ORIGIN_Y,
      velX: source.velX * this.ppm,
      velY: source.velY * this.ppm,
      angle: source.angle,
      angularVel: source.angularVel,
      isHeavy: source.isHeavy,
      alive: source.alive,
      deathType: source.deathType,
    };
  }

  private nativeState(): NativeSessionSnapshot {
    if (!this.nativeSession || !this.nativeSnapshot) throw new Error('Native session is not initialized');
    return this.nativeSnapshot;
  }

  private nativeDisc(id: number, state = this.nativeState()) {
    const disc = state.discs[id];
    if (!disc) throw new Error(`Native map has no eligible spawn for configured player ${id}`);
    return disc;
  }

  private stepNative(action: Action): StepResult {
    if (this.terminalReached) {
      this.frameSkipTicks = Math.min(this.frameSkipTicks + 1, this.config.frameSkip);
      const observation = this.getObservation();
      return {
        observation,
        reward: 0,
        done: true,
        truncated: this.terminalTruncated,
        terminated: this.terminalTerminated,
        info: this.nativeStepInfo(observation, this.terminalTerminated, true),
      };
    }
    if (this.frameSkipTicks === 0) {
      this.lastAction = typeof action === 'number' ? this.decodeAction(action) : { ...action };
    }
    // Public bit 5 is named grapple for the legacy action schema. In native
    // Arrow/Death Arrow/Grapple it carries original action2; Football consumes
    // it as the zero-force control. All other native modes reject it instead
    // of silently dropping a control or switching backend.
    if (
      this.lastAction.grapple &&
      this.config.nativeMode !== 'ar' &&
      this.config.nativeMode !== 'ard' &&
      this.config.nativeMode !== 'sp' &&
      this.config.nativeMode !== 'f'
    ) {
      throw new Error(
        `Unsupported native Classic action (mode ${this.config.nativeMode}): grapple/action2 is supported only in Arrow, Death Arrow, Grapple or Football mode`,
      );
    }
    const inputs: Record<number, number> = {
      [this.aiPlayerId]: encodePlayerInput(this.lastAction),
    };
    for (const id of this.opponentIds) {
      const input = this.getOpponentInput(id);
      if (
        input.grapple &&
        this.config.nativeMode !== 'ar' &&
        this.config.nativeMode !== 'ard' &&
        this.config.nativeMode !== 'sp' &&
        this.config.nativeMode !== 'f'
      )
        throw new Error(
          `Unsupported native Classic opponent action (mode ${this.config.nativeMode}): grapple/action2 is supported only in Arrow, Death Arrow, Grapple or Football mode`,
        );
      inputs[id] = encodePlayerInput(input);
    }
    const previousDiscs = this.nativeState().discs;
    const result = this.nativeSession!.stepWithEvents(inputs);
    this.nativeSnapshot = result.state;
    this.nativeTick = result.state.tick;
    this.nativeDeathViews.clear();
    const deaths: DeathEvent[] = result.events.deaths.map((death) => {
      // Dynamic native elimination can remove the outgoing disc on the same
      // tick. Its death record replaces pose/velocity only; angular/control
      // presentation comes from the valid pre-step disc in that case.
      const disc = result.state.discs[death.i] ?? previousDiscs[death.i];
      if (!disc) throw new Error(`Native death ${death.i} has no outgoing or pre-step disc for angular state`);
      return {
        playerId: death.i,
        deathType: death.m,
        state: {
          x: death.x,
          y: death.y,
          velX: death.xv,
          velY: death.yv,
          // Presentation records replace pose/velocity, not the outgoing
          // disc's angular/control state. Native discDeaths carry only the
          // former; substituting zero here would change the public view.
          angle: disc.angle,
          angularVel: disc.angularVelocity,
          isHeavy: disc.heavy,
          alive: false,
          deathType: death.m,
        },
      };
    });
    for (const death of deaths) this.nativeDeathViews.set(death.playerId, death.state);
    let reward = this.config.reward.timePenalty;
    for (const death of deaths) {
      if (death.deathType === 3) continue;
      reward += death.playerId === this.aiPlayerId ? this.config.reward.deathPenalty : this.config.reward.killReward;
    }
    const state = result.state;
    if (result.events.roundResult && !result.events.roundResult.draw && this.config.teamsEnabled) {
      if (result.events.roundResult.winner === 3) this.scoreBlue++;
      if (result.events.roundResult.winner === 2) this.scoreRed++;
      reward += result.events.roundResult.winner === 3 ? 1 : -1;
    }
    const respawned = new Set(result.events.respawns);
    const aiAlive = this.nativePlayerState(this.aiPlayerId, state).alive;
    const opponentsAlive = this.opponentIds.filter((id) => this.nativePlayerState(id, state).alive).length;
    const aiVisible = this.getVisiblePlayerState(this.aiPlayerId);
    const aiPermanentlyDead = !aiVisible.alive && !respawned.has(this.aiPlayerId);
    const allOpponentsPermanentlyDead =
      this.opponentIds.length > 0 &&
      this.opponentIds.every((id) => !this.getVisiblePlayerState(id).alive && !respawned.has(id));
    // Football: a completed match (score limit reached) is a terminal state.
    // Football discs never die (alive: true always), so the elimination paths
    // above can never fire; without this check every football episode would
    // end only by maxTicks truncation with the session frozen at the final
    // score — the agent would keep "stepping" a dead match.
    const matchComplete = state.matchComplete === true;
    const terminated = aiPermanentlyDead || allOpponentsPermanentlyDead || matchComplete;
    const truncated = this.nativeTick >= this.config.maxTicks;
    if (terminated || truncated) {
      this.terminalReached = true;
      this.terminalTruncated = truncated;
      this.terminalTerminated = terminated;
    }
    this.frameSkipTicks++;
    if (this.frameSkipTicks >= this.config.frameSkip && !terminated && !truncated) this.frameSkipTicks = 0;
    const observation = this.getObservation();
    return {
      observation,
      reward,
      done: terminated || truncated,
      truncated,
      terminated,
      info: this.nativeStepInfo(observation, terminated, false, aiAlive, opponentsAlive),
    };
  }

  private nativeStepInfo(
    observation: Observation,
    terminated: boolean,
    terminalHold: boolean,
    aiAlive = this.nativePlayerState(this.aiPlayerId).alive,
    opponentsAlive = this.opponentIds.filter((id) => this.nativePlayerState(id).alive).length,
  ): Record<string, any> {
    return {
      tick: this.nativeTick,
      aiAlive,
      opponentsAlive,
      // The worker performs the reset after receiving this terminal result;
      // direct callers receive the identical predicate from step().
      autoResetAfter: this.terminalReached && !this.isTerminalHoldActive(),
      terminated,
      frameSkip: this.config.frameSkip,
      capZones: this.capZones,
      scoreBlue: this.scoreBlue,
      scoreRed: this.scoreRed,
      aiTeam: this.aiTeam,
      native: true,
      nativeMode: this.config.nativeMode,
      nativePhase: this.nativeState().phase,
      nativeRoundTick: this.nativeState().rl,
      // Native capture state is dynamic. Copy each entry so public callers
      // cannot mutate the session's frozen snapshot and reset/rollover changes
      // are visible through every transport rather than just direct calls.
      nativeCapZones: (this.nativeState().capZones ?? []).map((zone) => ({ ...zone })),
      ...(this.terminalReached || terminalHold ? { terminal_observation: observation } : {}),
    };
  }

  private getObservation(): Observation {
    if (this.nativeSession) {
      const view = (id: number): PlayerState => this.nativePlayerState(id);
      const ai = view(this.aiPlayerId);
      return {
        playerX: ai.x,
        playerY: ai.y,
        playerVelX: ai.velX,
        playerVelY: ai.velY,
        playerAngle: ai.angle,
        playerAngularVel: ai.angularVel,
        playerIsHeavy: ai.isHeavy,
        opponents: this.opponentIds.map((id) => {
          const opponent = view(id);
          return {
            x: opponent.x,
            y: opponent.y,
            velX: opponent.velX,
            velY: opponent.velY,
            isHeavy: opponent.isHeavy,
            alive: opponent.alive,
          };
        }),
        arenaHalfWidth: this.getObservationArenaBounds().halfWidth,
        arenaHalfHeight: this.getObservationArenaBounds().halfHeight,
        tick: this.nativeTick,
      };
    }
    const aiState = this.getVisiblePlayerState(this.aiPlayerId);

    const opponents = this.opponentIds.map((id) => {
      const s = this.getVisiblePlayerState(id);
      return {
        x: s.x,
        y: s.y,
        velX: s.velX,
        velY: s.velY,
        isHeavy: s.isHeavy,
        alive: s.alive,
      };
    });

    const arenaBounds = this.getObservationArenaBounds();

    return {
      playerX: aiState.x,
      playerY: aiState.y,
      playerVelX: aiState.velX,
      playerVelY: aiState.velY,
      playerAngle: aiState.angle,
      playerAngularVel: aiState.angularVel,
      playerIsHeavy: aiState.isHeavy,
      opponents,
      arenaHalfWidth: arenaBounds.halfWidth,
      arenaHalfHeight: arenaBounds.halfHeight,
      tick: this.physics.getTickCount(),
    };
  }

  /**
   * Convert an action (integer or object) to PlayerInput.
   */
  private decodeAction(action: Action): PlayerInput {
    if (typeof action === 'number') {
      return decodeEncodedAction(action);
    }
    return action;
  }

  /**
   * Generate opponent input (random or scripted).
   */
  private getOpponentInput(opId: number): PlayerInput {
    if (!this.config.randomOpponent) {
      return { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
    }

    // Simple random policy: each direction has x% chance per tick
    return {
      left: this.rng.next() < this.config.oppMoveProb,
      right: this.rng.next() < this.config.oppMoveProb,
      up: this.rng.next() < this.config.oppUpProb,
      down: this.rng.next() < this.config.oppDownProb,
      heavy: this.rng.next() < this.config.oppHeavyProb,
      grapple: this.rng.next() < this.config.oppGrappleProb,
    };
  }

  /**
   * Calculate reward for the current tick.
   *
   * Reward structure (weights configurable via reward.killReward /
   * reward.deathPenalty / reward.timePenalty; documented defaults are the
   * legacy literals when unset, #220). Convention: all weights are signed
   * deltas added to the tick reward. killReward may be signed (positive
   * rewards elimination, negative discourages it); deathPenalty and
   * timePenalty are enforced non-positive so a "penalty" always reduces
   * reward and can never reward the event it names:
   *   +killReward   — opponent knocked off the map (killed; on respawn maps
   *                   every transient respawn death is rewarded too)
   *   +deathPenalty — AI player knocked off the map (death; default -1.0;
   *                   on respawn maps every transient respawn death is
   *                   penalized too)
   *   ±1.0  — cap-zone capture for/against the AI team (single reward for
   *           the event; cap-zone eliminations (deathType 3) do NOT also
   *           count as kills; on non-respawn maps a same-tick death of a
   *           losing-team player is priced by the capture only)
   *   +timePenalty — per-tick penalty (encourages action; default -0.001)
   */
  private calculateReward(deathEvents: readonly DeathEvent[]): number {
    let reward = 0;

    // getTeamScored() is consume-once: read it before the death loop so a
    // same-tick capture can absorb the losing team's deaths below.
    let scoredTeam: string | null = null;
    if (typeof (this.physics as any).getTeamScored === 'function') {
      scoredTeam = (this.physics as any).getTeamScored();
    }

    // Events are the transition source because a respawn-enabled death is
    // already alive again in the post-tick physics state. Cap-zone deaths
    // remain priced only by the capture branch below.
    for (const event of deathEvents) {
      if (event.deathType === 3) continue;
      // On a non-respawn map a same-tick capture eliminates the losing
      // team: such deaths are priced by the capture only (the documented
      // single reward for the event). On respawn maps the transient
      // death is a real elimination and keeps its death reward.
      if (!this.config.respawnEnabled && scoredTeam) {
        const onLosingTeam =
          scoredTeam === this.aiTeam ? this.opponentIds.includes(event.playerId) : event.playerId === this.aiPlayerId;
        if (onLosingTeam) continue;
      }
      if (event.playerId === this.aiPlayerId) {
        reward += this.config.reward.deathPenalty;
      } else if (this.opponentIds.includes(event.playerId)) {
        reward += this.config.reward.killReward;
      }
    }

    // Check capZone scoring
    if (scoredTeam) {
      if (scoredTeam === this.aiTeam) {
        reward += 1.0;
        this.scoreBlue += this.aiTeam === 'blue' ? 1 : 0;
        this.scoreRed += this.aiTeam === 'red' ? 1 : 0;
      } else {
        reward -= 1.0;
        this.scoreBlue += scoredTeam === 'blue' ? 1 : 0;
        this.scoreRed += scoredTeam === 'red' ? 1 : 0;
      }
    }

    // Per-tick time penalty
    reward += this.config.reward.timePenalty;

    return reward;
  }

  /** The dying-step view: the latest death presentation record, otherwise the
   * live native/legacy state. A native respawned disc remains alive in physics
   * while this result exposes its death for exactly one public step. */
  private getVisiblePlayerState(playerId: number): PlayerState {
    return this.nativeSession ? this.nativePlayerState(playerId) : this.physics.getVisiblePlayerState(playerId);
  }

  /**
   * Arena half extents for the observation, in map pixels. When an exported
   * map declares explicit physics.bounds, reset() stores world metres
   * (bounds / scale) in the engine and getArenaBounds() converts back with
   * × scale; that round trip can drift by 1 ulp (e.g. 500.00000000000006
   * for a 1000px bound), so report the authoritative map pixels directly.
   * Mirrors the reset() duck-check: an engine without setMapBounds or
   * getScale keeps the engine-reported (dynamic) bounds.
   */
  private getObservationArenaBounds(): { halfWidth: number; halfHeight: number } {
    if (
      this.mapBounds !== null &&
      typeof (this.physics as any).setMapBounds === 'function' &&
      typeof (this.physics as any).getScale === 'function'
    ) {
      this._obsArenaBoundsCache.halfWidth = this.mapBounds.width / 2;
      this._obsArenaBoundsCache.halfHeight = this.mapBounds.height / 2;
      return this._obsArenaBoundsCache;
    }
    return this.physics.getArenaBounds();
  }

  /**
   * Fast observation extraction — returns a pre-allocated Float32Array
   * directly from physics state, skipping intermediate object creation.
   * Layout matches worker.ts observationToArray() output: 7 player floats,
   * 6 floats per opponent (first opponent at 7-12, extras appended after
   * the tick at 16+), 2 arena floats at 13-14, tick at 15.
   */
  getObservationFast(): Float32Array {
    const aiState = this.getVisiblePlayerState(this.aiPlayerId);

    this._obsBuffer[0] = aiState.x;
    this._obsBuffer[1] = aiState.y;
    this._obsBuffer[2] = aiState.velX;
    this._obsBuffer[3] = aiState.velY;
    this._obsBuffer[4] = aiState.angle;
    this._obsBuffer[5] = aiState.angularVel;
    this._obsBuffer[6] = aiState.isHeavy ? 1 : 0;

    // The opponent count is fixed per config and reset() spawns exactly
    // that many, so every block is rewritten each call (blocks beyond the
    // live count stay zero because the buffer is fresh and never had
    // values written into them).
    const numOpponents = Math.min(this.opponentIds.length, this.config.numOpponents);
    for (let i = 0; i < numOpponents; i++) {
      const state = this.getVisiblePlayerState(this.opponentIds[i]);
      const base = i === 0 ? 7 : 16 + 6 * (i - 1);
      this._obsBuffer[base] = state.x;
      this._obsBuffer[base + 1] = state.y;
      this._obsBuffer[base + 2] = state.velX;
      this._obsBuffer[base + 3] = state.velY;
      this._obsBuffer[base + 4] = state.isHeavy ? 1 : 0;
      this._obsBuffer[base + 5] = state.alive ? 1 : 0;
    }

    const arenaBounds = this.getObservationArenaBounds();
    this._obsBuffer[13] = arenaBounds.halfWidth;
    this._obsBuffer[14] = arenaBounds.halfHeight;
    this._obsBuffer[15] = this.nativeSession ? this.nativeTick : this.physics.getTickCount();
    return this._obsBuffer;
  }

  /**
   * True while the environment is inside the frame-skip terminal hold
   * window: the episode has ended (this.terminalReached) but the current
   * action cycle has not yet crossed its boundary (frameSkipTicks below
   * frameSkip). The worker layer uses this to defer auto-reset until the
   * entire hold window has been reported, so with frameSkip > 1 the
   * terminal done result is delivered for the full window before a fresh
   * episode begins (#228). Once the window elapses the environment stays
   * terminal (no physics advance, same flags) until reset() (#197).
   */
  isTerminalHoldActive(): boolean {
    return this.terminalReached && this.frameSkipTicks < this.config.frameSkip;
  }

  /**
   * Static fields of the step info contract (constant for the environment's
   * lifetime): frame skip, map cap zones, and the AI team. Shared-memory
   * mode transports these once at init instead of every step; the dynamic
   * info fields (aiAlive, opponentsAlive, scoreBlue, scoreRed, tick) travel
   * with each step.
   */
  /** Maximum capture-zone records any reset of this authored map can expose. */
  getNativeCapZoneCapacity(): number {
    return this.nativeMap?.capZones.length ?? 0;
  }

  getStaticInfo(): {
    frameSkip: number;
    capZones: Array<{ index: number; owner: string; type: number }>;
    aiTeam: string;
    native?: true;
    nativeMode?: NativeClassicMode | 'f';
    /** Authored zone capacity; live native state is transported per step. */
    nativeCapZoneCapacity?: number;
  } {
    return {
      frameSkip: this.config.frameSkip,
      capZones: this.capZones,
      aiTeam: this.aiTeam,
      ...(this.nativeMap || this.config.nativeMode === 'f'
        ? {
            native: true as const,
            nativeMode: this.config.nativeMode,
            nativeCapZoneCapacity: this.getNativeCapZoneCapacity(),
          }
        : {}),
    };
  }
}
