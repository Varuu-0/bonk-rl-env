/**
 * PhysicsEngine — Synchronous Box2D wrapper for the bonk.io RL environment.
 *
 * Wraps the `box2d` npm package (Box2DFlash v2.0 JS port, matching the
 * original bonk1-box2d AS3 source) into a clean, headless interface.
 *
 * Key design:
 *   - NO real-time clock. tick() is called manually by the RL loop.
 *   - Each tick() advances the world by exactly 1/30th of a second (30 TPS).
 *   - Player bodies are circles with configurable radius/density.
 *   - "Heavy" state reduces player input force without changing mass.
 */

// @ts-ignore — box2d has no type declarations
const box2d = require('box2d');

import { globalProfiler, wrap, TelemetryIndices } from '../telemetry/profiler';
import { isTelemetryEnabled } from '../telemetry/telemetry-controller';

const {
  b2World,
  b2AABB,
  b2Vec2,
  b2BodyDef,
  b2CircleDef,
  b2PolygonDef,
  b2Body,
  b2DistanceJointDef,
  b2RevoluteJointDef,
  b2PrismaticJointDef,
  b2GearJointDef,
  b2ContactListener,
  b2FilterData,
} = box2d;

// ─── Constants ───────────────────────────────────────────────────────
/** bonk.io runs at 30 ticks per second */
export const TPS = 30;
export const DT = 1 / TPS;

/** Bonk's default low-quality solver configuration. */
export const VELOCITY_ITERATIONS = 2;
export const POSITION_ITERATIONS = 6;

/** Conversion used by the bundled Box2D JS port for exported map coordinates. */
export const SCALE = 30;

/** Gravity in m/s² (bonk.io default) */
export const GRAVITY_X = 0;
export const GRAVITY_Y = 20;

/** Default player circle radius in metres */
export const DEFAULT_PPM = 12;

/**
 * Verified native player-disc fixture (DEOBFUSCATION §35.4 / §38.6, live
 * 2026-07-29 fixture, alpha2s.pretty.js 7397-7401; Node-verified index labels
 * 216=density / 217=friction / 218=restitution):
 * - density is the radius-normalized baseline `1 / (pi * r^2)` so the disc
 *   mass is exactly 1. Native heavy mode additionally scales density up to
 *   4.7x (§35.4) — that scaling is documented but not ported here;
 * - friction `0.001337`;
 * - restitution `0.95`.
 */
export const PLAYER_FRICTION = 0.001337;
export const PLAYER_RESTITUTION = 0.95;

/** Heavy/action reduces applied movement force; it does not change disc mass. */
export const HEAVY_FORCE_MULTIPLIER = 0.7;

// ─── Grapple / swing (DEOBFUSCATION §32, 2026-07-29 build) ──────────────
/**
 * Verified native grapple constants:
 * - Targeting: QueryAABB ±10 world units around the disc center, candidates
 *   scored by center-to-surface distance `d < 10` (§32.1). The 10 is in
 *   NATIVE world units (`map px / ppm`); this port's world is `map px / SCALE`,
 *   so the window is consumed as `GRAPPLE_TARGET_WINDOW * ppm / SCALE` port
 *   units — 4.0 at the default ppm = 12 (120 map px = 10 disc radii, not the
 *   300 map px a bare 10.0 port-unit window would reach).
 * - Joint: `frequencyHz = (sep < swing.l) ? 0.01 : swingF`,
 *   `dampingRatio = swingD`, with the only table-proven writers being
 *   `swingF = 2` (Hz) and `swingD = 0` (§32.4). `fh`/`dr` are map `d`-joint
 *   fields and never apply to the grapple.
 * - `a1a` energy meter (§32.3): spawn 1000, fire gate `a1a > 500`, drain
 *   4/step while swinging from the tick AFTER attach, recharge 3/step
 *   otherwise, forced release and zeroing below 500. The literal 500 is this
 *   energy threshold, NOT a reach.
 */
/** Native QueryAABB half-extent (native world units). Consumed as `* ppm / SCALE`. */
export const GRAPPLE_TARGET_WINDOW = 10.0;
export const GRAPPLE_FREQUENCY_HZ = 2.0;   // native swingF
export const GRAPPLE_DAMPING_RATIO = 0.0;  // native swingD
export const GRAPPLE_SLACK_FREQUENCY_HZ = 0.01;
export const A1A_SPAWN = 1000;
export const A1A_MAX = 1000;
export const A1A_FIRE_THRESHOLD = 500;
export const A1A_SWING_DRAIN = 4;
export const A1A_RECHARGE = 3;

/** Arena bounds (in metres). Players outside these are considered dead. */
export const ARENA_HALF_WIDTH = 25;
export const ARENA_HALF_HEIGHT = 20;

/** Arena-bounds margin (metres) added to the extents derived from map bodies. */
export const ARENA_BOUNDS_MARGIN = 5;

/**
 * World broadphase AABB half-extent (metres). Kept far larger than any playable
 * map (the OOB death circle is 850 map px = 28.3 m) so the bundled port never
 * brushes its boundary. The documented `physics.worldAabbExtent` default (1000)
 * is applied by the config pipeline; this constant is the oversized fallback
 * for engines constructed directly without options.
 */
export const WORLD_AABB_EXTENT = 5000;

/**
 * Movement-force base for the player disc after the native radius^2 scale
 * and before the heavy damp (DEOBFUSCATION §35.5 movement branch, lines
 * 7979-7997: `state.ms.fl ? 20 : 12`, scaled by radius^2 and then by 0.7
 * for heavy). The §35.5 radius^2 scale is the disc mass ratio
 * `π·r²/(π·1²)`; the verified mass-1 disc fixture (#212) pins that ratio to
 * exactly 1 for every disc radius, so the applied net acceleration is
 * radius-invariant (as in the native game) and no further per-ppm factor is
 * applied.
 *
 * The native 12 N base leaves the mass-1 disc unable to beat gravity 20
 * (net `Δv = (−12 + 20)·dt` downward), so the RL "up" bit could never
 * produce ascent (#234). This port raises the base to the smallest round
 * value that still ascends under the 0.7 heavy damp — `20 / 0.7 ≈ 28.57`,
 * rounded up to `30` — giving:
 *   - pure up: `(−30 + 20)` = −10 m/s² (upward);
 *   - up + heavy: `(−30·0.7 + 20)` = −1 m/s² (still upward);
 *   - down: `(+30 + 20)` = +50 m/s² (accelerated fall).
 */
export const MOVE_FORCE = 30.0;

/** Bonk's circular death boundary in native map pixels; consumed as `850 / SCALE` world units in this port. */
export const OUT_OF_BOUNDS_DISTANCE = 850;

/** Verified last-hit timer (`lht`): 120 ticks = 4 seconds at 30 TPS. */
export const LAST_HIT_TIMER_TICKS = 120;

// ─── Types ───────────────────────────────────────────────────────────

export interface PlayerState {
  x: number;
  y: number;
  velX: number;
  velY: number;
  angle: number;
  angularVel: number;
  isHeavy: boolean;
  alive: boolean;
  deathType: number;
}

export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  heavy: boolean;
  grapple: boolean;
}

export interface MapBodyDef {
  name: string;
  type: 'rect' | 'circle' | 'polygon';
  x: number;
  y: number;
  width?: number;    // For rect
  height?: number;   // For rect
  radius?: number;   // For circle
  vertices?: { x: number; y: number }[]; // For polygon
  /** Omitted static defaults to a dynamic body. */
  static?: boolean;
  density?: number;
  restitution?: number;
  angle?: number;
  isLethal?: boolean;
  /** Map passthrough only — no engine behavior reads this; kept for map-data fidelity, not a mechanic. */
  grappleMultiplier?: number;
  frequencyHz?: number;
  dampingRatio?: number;
  noPhysics?: boolean;           // When true, body should be a sensor (no collision response)
  noGrapple?: boolean;           // When true, cannot be grappled
  innerGrapple?: boolean;        // When true, grappable from inside the shape (§32.1 gate); outside grappling is unaffected
  friction?: number;             // Surface friction coefficient
  /** Native `f_p` (fricp): when true the friction is signed negative to select
   *  velocity-independent friction (DEOBFUSCATION §33.4). */
  fricPolarity?: boolean;
  /** Native `f_c` collision-group passthrough (provenance only; the engine
   *   filter is driven by `collides.gN`). */
  collisionGroup?: number;
  collides?: {                   // Collision group filtering
    g1: boolean;
    g2: boolean;
    g3: boolean;
    g4: boolean;
  };
  color?: number;                // Visual color (RGB as integer)
  surfaceName?: string;          // Surface type name
  linearDamping?: number;        // Body linear velocity drag
  angularDamping?: number;       // Body angular velocity drag
  linearVelocity?: { x: number; y: number }; // Starting velocity for dynamic bodies
  angularVelocity?: number;      // Starting rotational velocity
  aabb?: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; cx: number; cy: number }; // Pre-calculated AABB for polygons
}

export interface MapSpawnPoints {
  [team: string]: { x: number; y: number };
}

export interface MapDef {
  name: string;
  spawnPoints: MapSpawnPoints;
  bodies: MapBodyDef[];
  capZones?: Array<{ index: number; owner: string; type: number; fixture: string; shapeType: string; l?: number }>;
  joints?: Array<{
    type: string; bodyA: string; bodyB: string;
    anchorA?: { x: number; y: number }; anchorB?: { x: number; y: number };
    localAnchorA?: { x: number; y: number }; localAnchorB?: { x: number; y: number };
    length?: number; frequencyHz?: number; dampingRatio?: number; collideConnected?: boolean;
    // Native joint fields (§33.8) forwarded for exact construction:
    enableLimit?: boolean; lowerAngle?: number; upperAngle?: number;
    enableMotor?: boolean; motorSpeed?: number; maxMotorTorque?: number; maxMotorForce?: number;
    lowerTranslation?: number; upperTranslation?: number;
    axis?: { x: number; y: number };
    // Native indices: bodyA/bodyB are already resolved to names by the adapter,
    // bodyB === '' (or bodyB === GROUND_BODY_NAME) means the joint is ground-anchored.
    ratio?: number;               // gear (g) joint ratio
    jointA?: string; jointB?: string;  // gear referent joint names
    referenceAngle?: number;      // prismatic reference angle
    // ground: when bodyB is the synthetic ground body
    isGround?: boolean;
  }>;
  physics?: {
    ppm?: number;
    bounds?: { width: number; height: number };
    /** Map-relative out-of-bounds death-circle center in map units. When absent
     * the engine keeps the world origin, which is correct for maps authored
     * around the origin (see setDeathCircleCenter). */
    deathCenter?: { x: number; y: number };
  };
}

// ─── PhysicsEngine ───────────────────────────────────────────────────

/**
 * Optional engine tuning surface. Each field maps 1:1 onto a documented
 * config-loader key (`physics.*`, `arena.*`, `player.*`) that BonkEnvironment
 * forwards to the engine; every field falls back to a sanity default (the
 * module constants above) when absent, so `new PhysicsEngine()` keeps the
 * exact behaviour it always had.
 */
export interface PhysicsEngineOptions {
    /** Fixed physics update rate (ticks/second); dt = 1 / this value. Default: TPS (30). */
    ticksPerSecond?: number;
    /** Velocity constraint solver iterations per tick. Default: VELOCITY_ITERATIONS (2). */
    velocityIterations?: number;
    /** Pixels-per-metre conversion for exported map coordinates. Default: SCALE (30). */
    scale?: number;
    /** Horizontal world gravity (m/s²). Default: GRAVITY_X (0). */
    gravityX?: number;
    /** Vertical world gravity (m/s², positive down). Default: GRAVITY_Y (20).
     *  NOTE: cross-referenced with `moveForce` / `heavyForceMultiplier` for the
     *  #234 ascent invariant — outweighing moveForce (or moveForce × heavy)
     *  silently makes pure-up or up+heavy descend; see warnAscentInvariantBreak. */
    gravityY?: number;
    /** Allow inactive bodies to sleep. Default: true (native). */
    enableSleeping?: boolean;
    /** Half-extent of the world broadphase AABB. Default: WORLD_AABB_EXTENT (5000). */
    worldAabbExtent?: number;
    /** Fallback arena half-width (metres) when no map body defines the bounds. Default: ARENA_HALF_WIDTH (25). */
    arenaHalfWidth?: number;
    /** Fallback arena half-height (metres) when no map body defines the bounds. Default: ARENA_HALF_HEIGHT (20). */
    arenaHalfHeight?: number;
    /** Extra margin (metres) added to arena extents derived from map bodies. Default: ARENA_BOUNDS_MARGIN (5). */
    arenaBoundsMargin?: number;
    /** Movement-force base applied to all directions (× heavy for heavy). Default: MOVE_FORCE (30).
     *  Must exceed `gravityY` (pure up lifts) — see #234 and warnAscentInvariantBreak. */
    moveForce?: number;
    /** Force multiplier applied while heavy. Default: HEAVY_FORCE_MULTIPLIER (0.7).
     *  `moveForce × heavyForceMultiplier` must exceed `gravityY` for up+heavy to lift. */
    heavyForceMultiplier?: number;
}

/** Frozen final transforms of a dead disc, snapshotted when its body is detached
 * from the live world. Observations read these plain objects instead of the
 * destroyed b2Body, which this port may leave partially readable or recycle. */
interface DetachedPlayerSnapshot {
  x: number;
  y: number;
  velX: number;
  velY: number;
  angle: number;
  angularVel: number;
}

export class PhysicsEngine {
  private world: any;
  private playerBodies: Map<number, any> = new Map();
  private playerHeavyState: Map<number, boolean> = new Map();
  private playerAlive: Map<number, boolean> = new Map();
  /** Frozen final transforms of dead discs, snapshotted on detach so observations
   * never read a destroyed b2Body. Entries live until the next reset(). */
  private detachedPlayerStates: Map<number, DetachedPlayerSnapshot> = new Map();
  private playerGrappleJoints: Map<number, any> = new Map();
  /** Native a1a grapple/energy meter (0-1000), per player (DEOBFUSCATION §32.3). */
  private grappleEnergy: Map<number, number> = new Map();
  /**
   * Disc IDs whose grapple joint was created this tick. Native §32.3 runs the
   * a1a update BEFORE the fire gate in the same step, so the attach step never
   * drains the new rope; this marker makes updateGrappleEnergy() recharge
   * (instead of draining) on exactly that tick and lets a re-fire at the 501
   * crossing survive instead of being force-released in the same tick.
   */
  private swingJustStarted: Set<number> = new Set();
  private playerTeams: Map<number, string> = new Map();
  /**
   * Slot id treated as the "AI" disc for the default collision categories
   * (g1 for the AI disc, g2 for every other disc, matching the legacy
   * `id === 0` mapping). The environment configures this via setAiPlayerId()
   * so a nonzero aiPlayerId (issue #221) does not invert the categories.
   */
  private aiSlot: number = 0;
  private capZoneSensors: any[] = [];
  private lastScoredTeam: string | null = null;
  /** An instant goal ends the round; later sensor jitter must not re-score it. */
  private instantGoalResolved: boolean = false;
  private platformBodies: any[] = [];
  private platformBodyMap: Map<string, any> = new Map();
  private tickCount: number = 0;
  private arenaHalfWidth: number = ARENA_HALF_WIDTH;
  private arenaHalfHeight: number = ARENA_HALF_HEIGHT;
  /** Resolved instance tuning (from PhysicsEngineOptions; module constants used
   *  when the corresponding option is absent). */
  private tps: number = TPS;
  private dt: number = DT;
  private velocityIterations: number = VELOCITY_ITERATIONS;
  private scale: number = SCALE;
  private gravityX: number = GRAVITY_X;
  private gravityY: number = GRAVITY_Y;
  private enableSleeping: boolean = true;
  private worldAabbExtent: number = WORLD_AABB_EXTENT;
  private arenaBoundsMargin: number = ARENA_BOUNDS_MARGIN;
  private moveForce: number = MOVE_FORCE;
  private heavyForceMultiplier: number = HEAVY_FORCE_MULTIPLIER;
  /** Running arena extents in metres, folded in O(1) per addBody so map build
   *  and episode reset stay linear instead of rescanning every platform body
   *  (the old per-add full pass was O(bodies²)). */
  private arenaMinX: number = Infinity;
  private arenaMaxX: number = -Infinity;
  private arenaMinY: number = Infinity;
  private arenaMaxY: number = -Infinity;
  private ppm: number = DEFAULT_PPM;
  private _tempForce = new b2Vec2(0, 0);
  private playerDeathType: Map<number, number> = new Map();
  private capZoneState: Map<number, { ty: number; p: number; l: number; i: number; o: number; ot: string; f: number }> = new Map();
  private capZoneTouches: Array<{ zoneIndex: number; playerId: number; team: string }> = [];
  /** True when the game has teams enabled (native game setting `tea`). */
  private teamsEnabled: boolean = false;
  /** True for the native no-collision physics mode (`nc`). */
  private noCollide: boolean = false;
  /** Disc IDs whose grapple joint must be destroyed after this step (native swingCollideDestroyEvents). */
  private pendingSwingDestroy: Set<number> = new Set();
  /** Native lhid: last disc that touched each player. */
  private lastHitBy: Map<number, number> = new Map();
  /** Native lht: remaining attribution ticks (starts at 120 = 4s at 30 TPS). */
  private lastHitTicks: Map<number, number> = new Map();
  /** Cached squared OOB radius, computed from the resolved scale so a configured
   *  pixels-per-metre value moves the death circle with it (still exactly 850
   *  map px, verified native "Death Type 4"). */
  private oobRadiusSquared: number = Math.pow(OUT_OF_BOUNDS_DISTANCE / SCALE, 2);
  /** OOB death-circle center in world units. Defaults to the world origin;
   * setDeathCircleCenter() moves it to the map center for exported maps. */
  private oobCenterX: number = 0;
  private oobCenterY: number = 0;
  /** Reused by getArenaBounds so the zero-GC observation path allocates nothing per step. */
  private _arenaBoundsCache: { halfWidth: number; halfHeight: number } = { halfWidth: 0, halfHeight: 0 };

  constructor(options: PhysicsEngineOptions = {}) {
    // Resolve the documented tuning surface (config-loader physics/arena/player
    // sections) onto the engine. Every key is sanitized: a missing or invalid
    // value (0, Infinity, NaN, negatives, non-integers) falls back to its
    // sanity default (the module constant), so garbage options can never build
    // a broken world (dt = Infinity, inverted AABB, NaN gravity) and a bare
    // `new PhysicsEngine()` keeps the exact behaviour it always had.
    this.tps = PhysicsEngine.sanitizePositive(options.ticksPerSecond, TPS);
    this.dt = 1 / this.tps;
    this.velocityIterations = PhysicsEngine.sanitizeIntegerAtLeast(options.velocityIterations, VELOCITY_ITERATIONS, 1);
    this.scale = PhysicsEngine.sanitizePositive(options.scale, SCALE);
    this.gravityX = PhysicsEngine.sanitizeFinite(options.gravityX, GRAVITY_X);
    this.gravityY = PhysicsEngine.sanitizeFinite(options.gravityY, GRAVITY_Y);
    this.enableSleeping = PhysicsEngine.sanitizeBoolean(options.enableSleeping, true);
    this.worldAabbExtent = PhysicsEngine.sanitizePositive(options.worldAabbExtent, WORLD_AABB_EXTENT);
    this.arenaHalfWidth = PhysicsEngine.sanitizePositive(options.arenaHalfWidth, ARENA_HALF_WIDTH);
    this.arenaHalfHeight = PhysicsEngine.sanitizePositive(options.arenaHalfHeight, ARENA_HALF_HEIGHT);
    this.arenaBoundsMargin = PhysicsEngine.sanitizeNonNegative(options.arenaBoundsMargin, ARENA_BOUNDS_MARGIN);
    this.moveForce = PhysicsEngine.sanitizePositive(options.moveForce, MOVE_FORCE);
    this.heavyForceMultiplier = PhysicsEngine.sanitizeNonNegative(options.heavyForceMultiplier, HEAVY_FORCE_MULTIPLIER);
    this.oobRadiusSquared = Math.pow(OUT_OF_BOUNDS_DISTANCE / this.scale, 2);
    this.warnAscentInvariantBreak();
    this.createWorld();
  }

  /**
   * Surfacing the #234 ascent invariant regression (SUGGESTION #7): `MOVE_FORCE
   * = 30` was chosen so the mass-1 disc ascends against `GRAVITY_Y = 20` (pure
   * up: −30 + 20 = −10 m/s²; up + heavy: −30·0.7 + 20 = −1 m/s²). gravityY and
   * moveForce are now independently tunable, so a config that raises downward
   * gravity (`gravityY > 0`) above `moveForce` (pure-up can no longer lift) or
   * above `moveForce · heavyForceMultiplier` (not even up+heavy can lift,
   * silently undoing the #234 fix) is a degenerate, load-bearing configuration.
   * Negative (upward) gravity always aids ascent, so it never breaks the
   * invariant and must not warn. This is a warning, not a throw: tuning to a
   * non-lifting regime is legal, and the engine must keep working, but the user
   * should be told the pairing is inverted so the silent regression is
   * surfaced.
   */
  private warnAscentInvariantBreak(): void {
    // The invariant only applies to downward gravity: `up` produces an upward
    // force (−moveForce) that must out-pull gravityY. Negative (upward) gravity
    // only ever helps a disc rise, so it is always in a lifting regime.
    if (this.gravityY <= 0) return;
    const gravity = this.gravityY;
    const heavyLift = this.moveForce * this.heavyForceMultiplier;
    if (gravity >= this.moveForce) {
      console.warn(
        `[PhysicsEngine] gravityY ${gravity.toFixed(1)} >= moveForce ${this.moveForce.toFixed(1)}: pure 'up' cannot beat gravity (#234 ascent invariant broken).`,
      );
    } else if (gravity >= heavyLift) {
      console.warn(
        `[PhysicsEngine] gravityY ${gravity.toFixed(1)} > moveForce*heavy ${heavyLift.toFixed(1)}: 'up'+heavy cannot beat gravity (#234 ascent invariant broken).`,
      );
    }
  }

  /** Returns `v` when it is a finite number, otherwise the default. */
  private static sanitizeFinite(v: number | undefined, def: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  }

  /** Returns `v` when it is a finite, strictly positive number, else the default. */
  private static sanitizePositive(v: number | undefined, def: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def;
  }

  /** Returns `v` when it is a finite, non-negative number, else the default. */
  private static sanitizeNonNegative(v: number | undefined, def: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def;
  }

  /** Returns `v` when it is a finite integer >= min, else the default. */
  private static sanitizeIntegerAtLeast(v: number | undefined, def: number, min: number): number {
    return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min ? v : def;
  }

  /** Returns `v` only when it is an actual boolean, else the default. Rejects
   *  loosely-truthy/falsy values (strings like `'false'`, 0, 1) so caller/Python
   *  config can never silently invert the sleeping flag via coercion. */
  private static sanitizeBoolean(v: boolean | undefined, def: boolean): boolean {
    return typeof v === 'boolean' ? v : def;
  }

  /** Create a fresh world from the resolved instance tuning. Used by the
   *  constructor and reset() so configuration survives world rebuilds. */
  private createWorld(): void {
    const worldAABB = new b2AABB();
    worldAABB.lowerBound.Set(-this.worldAabbExtent, -this.worldAabbExtent);
    worldAABB.upperBound.Set(this.worldAabbExtent, this.worldAabbExtent);

    const gravity = new b2Vec2(this.gravityX, this.gravityY);
    this.world = new b2World(worldAABB, gravity, this.enableSleeping);
    this.world.SetWarmStarting(false);

    // Set up collision listener for verified contact rules
    this.setupContactListener();
  }

  /**
   * Defines collision rules: lethal objects kill players.
   */
  private setupContactListener(): void {
    const listener = new b2ContactListener();

    // Reused scratch object — the listener callbacks are sequential and
    // synchronous within a Step, so a single allocation serves every contact.
    const scratch = { ud1: null as any, ud2: null as any };
    const extractContact = (contact: any): { ud1: any; ud2: any } | null => {
      const shape1 = contact.shape1 || (contact.GetShape1 ? contact.GetShape1() : contact.GetFixtureA?.());
      const shape2 = contact.shape2 || (contact.GetShape2 ? contact.GetShape2() : contact.GetFixtureB?.());
      if (!shape1 || !shape2) return null;
      const body1 = shape1.GetBody();
      const body2 = shape2.GetBody();
      if (!body1 || !body2) return null;
      scratch.ud1 = body1.GetUserData() || {};
      scratch.ud2 = body2.GetUserData() || {};
      return scratch;
    };

    listener.Add = (contact: any) => {
      try {
        globalProfiler.increment('collision_events');
        const info = extractContact(contact);
        if (!info) return;
        const { ud1, ud2 } = info;

        this.checkLethalCollision(ud1, ud2);
        this.checkLethalCollision(ud2, ud1);
        this.registerCapZoneContact(ud1, ud2, true);
        this.registerDiscContact(ud1, ud2);
      } catch (e) {
        // Ignore contact errors — some TOI contacts lack valid shapes
      }
    };

    listener.Persist = (contact: any) => {
      try {
        // Persisting contacts only matter for timed-zone touch tracking;
        // skip the extraction entirely when the map has no zones.
        if (this.capZoneSensors.length === 0) return;
        const info = extractContact(contact);
        if (!info) return;
        this.registerCapZoneContact(info.ud1, info.ud2, false);
      } catch (e) {
        // Ignore persist errors
      }
    };

    this.world.SetContactListener(listener);
  }

  /**
   * Contact-filter rules verified from the native client (DEOBFUSCATION
   * BeginContact case 6): `nc` mode disables every disc-disc contact, and
   * with teams on (`tea`) discs on the same team never collide.
   *
   * Port note: this Box2D v2.0 JS port never invokes SetContactFilter
   * callbacks, so the rules are enforced with per-disc category/mask data
   * updated dynamically. Team mode maps teams onto the native g1-g4
   * collision-group slots (red=g1, blue=g2, green=g3, yellow=g4) and
   * removes the disc's own team bit from its mask. Everything else falls
   * back to the default category/mask behaviour. (DEOBFUSCATION_FIX_TRACKER C4)
   */
  static readonly PLAYER_TEAM_BITS: Record<string, number> = {
    red: 0x0002,
    blue: 0x0004,
    green: 0x0008,
    yellow: 0x0010,
  };
  private static readonly ALL_PLAYER_BITS = 0x0002 | 0x0004 | 0x0008 | 0x0010;

  /** Recompute a disc's filter data from the current team's / nc settings. */
  private updatePlayerFilter(playerId: number): void {
    const body = this.playerBodies.get(playerId);
    const shape = body ? body.GetShapeList() : null;
    if (!shape) return;

    const filter = new b2FilterData();
    if (this.noCollide) {
      filter.categoryBits = playerId === this.aiSlot ? 0x0002 : 0x0004;
      filter.maskBits = 0xFFFF & ~PhysicsEngine.ALL_PLAYER_BITS;
    } else if (this.teamsEnabled) {
      const team = this.playerTeams.get(playerId);
      const teamBit = team !== undefined ? PhysicsEngine.PLAYER_TEAM_BITS[team] : undefined;
      if (teamBit !== undefined) {
        filter.categoryBits = teamBit;
        filter.maskBits = 0xFFFF & ~teamBit;
      } else {
        filter.categoryBits = playerId === this.aiSlot ? 0x0002 : 0x0004;
        filter.maskBits = 0xFFFF;
      }
    } else {
      filter.categoryBits = playerId === this.aiSlot ? 0x0002 : 0x0004;
      filter.maskBits = 0xFFFF;
    }
    shape.SetFilterData(filter);
    this.world.Refilter(shape);
  }

  /**
   * Sets the slot treated as the AI disc for default (non-team) collision
   * categories (g1 for the AI, g2 for every other disc). The environment calls
   * this with its configured aiPlayerId so nonzero slots keep the AI on g1
   * instead of inverting the legacy `id === 0` mapping (issue #221). The
   * default 0 keeps engine-only callers on the legacy mapping. Existing discs
   * are re-filtered immediately, so callers may set the slot after adding
   * players.
   */
  setAiPlayerId(playerId: number): void {
    this.aiSlot = playerId;
    this.updateAllPlayerFilters();
  }

  private updateAllPlayerFilters(): void {
    for (const id of this.playerBodies.keys()) {
      this.updatePlayerFilter(id);
    }
  }

  /**
   * Verified disc-disc contact side effects (native BeginContact case 6):
   * a disc in swing state is queued for grapple-destroy after the step, and
   * both discs record last-hit attribution (`lhid`, `lht = 120` ticks).
   * Contacts disabled by the nc/team filter never reach this handler, which
   * matches the native else-branch semantics.
   */
  private registerDiscContact(ud1: any, ud2: any): void {
    if (ud1.playerId === undefined || ud2.playerId === undefined) return;
    const a: number = ud1.playerId;
    const b: number = ud2.playerId;
    if (this.playerGrappleJoints.has(a)) this.pendingSwingDestroy.add(a);
    if (this.playerGrappleJoints.has(b)) this.pendingSwingDestroy.add(b);
    this.lastHitBy.set(a, b);
    this.lastHitBy.set(b, a);
    this.lastHitTicks.set(a, LAST_HIT_TIMER_TICKS);
    this.lastHitTicks.set(b, LAST_HIT_TIMER_TICKS);
  }

  private checkLethalCollision(playerData: any, staticData: any): void {
    if (playerData.playerId !== undefined && staticData.isLethal) {
      this.playerAlive.set(playerData.playerId, false);
      this.playerDeathType.set(playerData.playerId, 1);
      globalProfiler.increment('collision_lethal');
    }
  }

  private registerCapZoneContact(ud1: any, ud2: any, isBegin: boolean): void {
    let zoneUd: any = null;
    let otherUd: any = null;
    if (ud1.isCapZone) { zoneUd = ud1; otherUd = ud2; }
    else if (ud2.isCapZone) { zoneUd = ud2; otherUd = ud1; }
    if (!zoneUd) return;

    if (zoneUd.zoneType === 1) {
      if (otherUd.playerId !== undefined) {
        const team = this.playerTeams.get(otherUd.playerId) ?? '';
        this.capZoneTouches.push({ zoneIndex: zoneUd.zoneIndex, playerId: otherUd.playerId, team });
      }
    } else if (isBegin) {
      // Native teamGoalEvent fires once on contact BEGIN; a body dwelling in
      // the zone must not re-score on every persisting tick.
      // Keep this truthiness check aligned with addBody(): an omitted static
      // flag is dynamic, while any truthy value makes the body static.
      if (otherUd.playerId === undefined && !otherUd.isCapZone && !otherUd.static) {
        this.triggerInstantGoal(zoneUd.zoneType);
      }
    }
  }

  private capTypeToTeam(capType: number): string | null {
    switch (capType) {
      case 2: return 'red';
      case 3: return 'blue';
      case 4: return 'green';
      case 5: return 'yellow';
      default: return null;
    }
  }

  private triggerInstantGoal(capType: number): void {
    if (this.instantGoalResolved) return;
    const winnerTeam = this.capTypeToTeam(capType);
    if (!winnerTeam) return;
    this.instantGoalResolved = true;
    this.lastScoredTeam = winnerTeam;
    for (const [id, team] of this.playerTeams) {
      if (team !== winnerTeam) {
        this.playerAlive.set(id, false);
        this.playerDeathType.set(id, 3);
      }
    }
  }

  /**
   * Add a static or dynamic body from a MapBodyDef to the world.
   */
  addBody(def: MapBodyDef): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(def.x / this.scale, def.y / this.scale);
    if (def.angle) bodyDef.angle = def.angle;
    bodyDef.linearDamping = def.linearDamping ?? 0;
    bodyDef.angularDamping = def.angularDamping ?? 0;

    const body = this.world.CreateBody(bodyDef);

    let shapeDef: any;
    if (def.type === 'rect') {
      shapeDef = new b2PolygonDef();
      const hw = (def.width || 0) / 2;
      const hh = (def.height || 0) / 2;
      shapeDef.SetAsBox(hw / this.scale, hh / this.scale);
     } else if (def.type === 'circle') {
       shapeDef = new b2CircleDef();
       shapeDef.radius = (def.radius || 0) / this.scale;
     } else if (def.type === 'polygon') {
       if (!def.vertices || def.vertices.length < 3) {
         console.warn(`Polygon body "${def.name}" has insufficient vertices (need >= 3)`);
         this.world.DestroyBody(body);
         return; // Skip invalid polygon
       }
       shapeDef = new b2PolygonDef();
       // Box2D supports max 8 vertices for convex polygons
       const maxVertices = Math.min(def.vertices.length, 8);
       for (let i = 0; i < maxVertices; i++) {
         const v = def.vertices[i];
         shapeDef.vertices[i].Set(v.x / this.scale, v.y / this.scale);
       }
       shapeDef.vertexCount = maxVertices;
     }

     // Native fixture density clamp (DEOBFUSCATION §33.4, line 3269): a non-finite
     // or sub-0.0001 authored dynamic density is raised to the 0.0001 floor so a
     // dynamic body never ends up massless. `Math.max(NaN, ...)` is NaN, so guard
     // non-finite values explicitly. Static bodies keep density 0 (static bodies
     // contribute no mass in Box2D regardless of this value).
     const authoredDensity = def.density;
     let dynamicDensity: number;
     if (authoredDensity === undefined) {
       // No authored density: default to the native surface default 1.0.
       // Do NOT floor to 0.0001 here.
       dynamicDensity = 1.0;
     } else if (Number.isFinite(authoredDensity)) {
       // Finite authored value, clamped up to the 0.0001 floor (§33.4).
       dynamicDensity = Math.max(authoredDensity, 0.0001);
     } else {
       // NaN/Infinity would poison mass; floor per the clamp guard.
       dynamicDensity = 0.0001;
     }
     shapeDef.density = def.static ? 0 : dynamicDensity;
      // Native friction (DEOBFUSCATION §33.4): `fix.fr ?? body.s.fric`. Native
      // line 3267 makes `f_p` (fricPolarity) surfaces NEGATIVE to get
      // "velocity-independent friction" — but that trick only works because the
      // native disc friction is 0 (b2MixFriction = sqrt(f1*f2) => sqrt(-f*0) =
      // -0). This port's disc friction is positive (PLAYER_FRICTION =
      // 0.001337), so a negative surface friction makes the mix NaN and
      // poisons the contact impulse and then the disc position on the first
      // contact tick (#276). Reproduce the native frictionless effect as
      // friction 0, and clamp authored negative/non-finite friction up to 0 so
      // the sqrt mix can never see a negative product (map-vs-map divergence
      // from the native negative mix is documented in DEOBFUSCATION §33.4).
      const authoredFriction = def.friction;
      const baseFriction = authoredFriction === undefined
        ? 0.3
        : (Number.isFinite(authoredFriction) ? Math.max(authoredFriction, 0) : 0);
      shapeDef.friction = def.fricPolarity ? 0 : baseFriction;
      const restitutionValue = def.restitution === -1 ? 0.8 : (def.restitution ?? 0.8);
     shapeDef.restitution = restitutionValue;

      // Handle noPhysics: true → make body a sensor (no collision response, but still triggers contact events)
      if (def.noPhysics) {
        shapeDef.isSensor = true;
      }

      // Apply collision filtering: `collides` gates only the player-group bits
      // (g1-g4 = the disc team slots 0x0002/0x0004/0x0008/0x0010), mirroring the
      // native mask construction (DEOBFUSCATION §33.4) where maskBits starts at
      // the full mask and only false group flags subtract their bit — the map
      // category is never subtracted. Here that means the map category 0x0001
      // stays in maskBits whenever at least one player group is enabled, so map
      // geometry stays solid to other map bodies. An all-false `collides` body
      // (legacy "ghost geometry" such as visual/no-Physics-style barriers)
      // keeps its fully-ghost mask 0x0000 so third-party-map behavior is
      // unchanged. (The bundled exports also carry a "collidesWithPlayers"
      // key on every fixture; it is not part of MapBodyDef and has no native
      // player-collision effect — native `f_p` clears only bit 0, this port's
      // map category — so it is deliberately ignored and platforms stay solid
      // to players.)
      if (def.collides) {
        const filter = new b2FilterData();
        filter.categoryBits = 0x0001; // Map bodies are category 1
        filter.maskBits =
          (def.collides.g1 || def.collides.g2 || def.collides.g3 || def.collides.g4)
            ? 0x0001 // Map bodies always collide with each other
            : 0x0000; // All-false legacy ghost geometry
        if (def.collides.g1) filter.maskBits |= 0x0002;
        if (def.collides.g2) filter.maskBits |= 0x0004;
        if (def.collides.g3) filter.maskBits |= 0x0008;
        if (def.collides.g4) filter.maskBits |= 0x0010;

        shapeDef.filter = filter;
      }

    body.CreateShape(shapeDef);
    body.SetMassFromShapes();
    body.SetUserData(def); // Stores isLethal and other map passthrough fields

    // Set initial velocity for dynamic bodies
    if (!def.static) {
      if (def.linearVelocity) {
        body.SetLinearVelocity(new b2Vec2(def.linearVelocity.x, def.linearVelocity.y));
      }
      if (def.angularVelocity !== undefined) {
        body.SetAngularVelocity(def.angularVelocity);
      }
    }

    this.platformBodies.push(body);
    if (def.name) this.platformBodyMap.set(def.name, body);

    // Fold this body's AABB into the running arena extents instead of
    // rescanning every platform body, keeping map build and episode reset
    // O(bodies) rather than O(bodies²).
    this.extendArenaExtents(body);
  }

  addCapZone(zone: { index: number; owner: string; type: number; fixture: string; shapeType: string; l?: number }, x: number, y: number, width: number, height: number): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(x / this.scale, y / this.scale);

    const body = this.world.CreateBody(bodyDef);

    const shapeDef = new b2PolygonDef();
    shapeDef.SetAsBox((width / 2) / this.scale, (height / 2) / this.scale);
    shapeDef.density = 0;
    shapeDef.isSensor = true;

    body.CreateShape(shapeDef);
    body.SetUserData({ isCapZone: true, zoneType: zone.type, zoneIndex: zone.index, owner: zone.owner });
    this.capZoneSensors.push(body);

    if (zone.type === 1) {
      const limit = (zone.l ?? 3) * 30;
      this.capZoneState.set(zone.index, {
        ty: zone.type,
        p: 0,
        l: limit,
        i: zone.index,
        o: -1,
        ot: '',
        f: -1,
      });
    }
  }

  /** Enable/disable native team-mode (`tea`) disc-collision rules. */
  setTeamsEnabled(enabled: boolean): void {
    this.teamsEnabled = enabled;
    this.updateAllPlayerFilters();
  }

  /** Enable/disable the native no-collision (`nc`) physics mode. */
  setNoCollide(enabled: boolean): void {
    this.noCollide = enabled;
    this.updateAllPlayerFilters();
  }

  /**
   * Native last-hit attribution (`lhid`/`lht`) for a player.
   * Returns null once the 120-tick attribution window has expired.
   */
  getLastHit(playerId: number): { attackerId: number; ticksRemaining: number } | null {
    const ticks = this.lastHitTicks.get(playerId);
    const attacker = this.lastHitBy.get(playerId);
    if (ticks === undefined || ticks <= 0 || attacker === undefined) return null;
    return { attackerId: attacker, ticksRemaining: ticks };
  }

  /** Whether the player currently has an active grapple joint (native `swing`). */
  hasGrappleJoint(playerId: number): boolean {
    return this.playerGrappleJoints.has(playerId);
  }

  setPlayerTeam(playerId: number, team: string): void {
    this.playerTeams.set(playerId, team);
    this.updatePlayerFilter(playerId);
  }

  getPlayerTeam(playerId: number): string | undefined {
    return this.playerTeams.get(playerId);
  }

  getTeamScored(): string | null {
    const scored = this.lastScoredTeam;
    this.lastScoredTeam = null;
    return scored;
  }

  /**
   * Fold one body's shape AABBs into the running arena extents and refresh
   * arenaHalfWidth/Height. O(1) per body; addBody calls this instead of a
   * full-world rescan.
   */
  private extendArenaExtents(body: any): void {
    const aabb = new b2AABB();
    const transform = body.GetXForm();
    for (let shape = body.GetShapeList(); shape !== null; shape = shape.GetNext()) {
      shape.ComputeAABB(aabb, transform);
      this.arenaMinX = Math.min(this.arenaMinX, aabb.lowerBound.x);
      this.arenaMaxX = Math.max(this.arenaMaxX, aabb.upperBound.x);
      this.arenaMinY = Math.min(this.arenaMinY, aabb.lowerBound.y);
      this.arenaMaxY = Math.max(this.arenaMaxY, aabb.upperBound.y);
    }

    if (isFinite(this.arenaMinX)) {
      // Extra margin beyond the map extents (configured arena.boundsMargin).
      const margin = this.arenaBoundsMargin;
      this.arenaHalfWidth = Math.max(Math.abs(this.arenaMinX), Math.abs(this.arenaMaxX)) + margin;
      this.arenaHalfHeight = Math.max(Math.abs(this.arenaMinY), Math.abs(this.arenaMaxY)) + margin;
    }
  }

  /**
   * Calculate arena bounds based on map body extents.
   * Call this after adding all map bodies (or at any time; it rebases the
   * running extents on a full scan of every current platform body).
   */
  calculateArenaBounds(): void {
    this.arenaMinX = Infinity;
    this.arenaMaxX = -Infinity;
    this.arenaMinY = Infinity;
    this.arenaMaxY = -Infinity;

    for (const body of this.platformBodies) {
      this.extendArenaExtents(body);
    }
  }

  /**
   * Set explicit map bounds from the map's physics.bounds.
   * Overrides dynamically calculated arena bounds.
   */
  setMapBounds(widthMetres: number, heightMetres: number): void {
    this.arenaHalfWidth = widthMetres / 2;
    this.arenaHalfHeight = heightMetres / 2;
  }

  /**
   * Per-map arena bounds in map coordinates (metres × this.scale).
   * Returns a cached object — callers must treat it as read-only.
   */
  getArenaBounds(): { halfWidth: number; halfHeight: number } {
    this._arenaBoundsCache.halfWidth = this.arenaHalfWidth * this.scale;
    this._arenaBoundsCache.halfHeight = this.arenaHalfHeight * this.scale;
    return this._arenaBoundsCache;
  }

  /**
   * Sets the map's player-disc radius setting before players are created.
   * Exported map coordinates are converted through this.scale for this Box2D port.
   */
  setScale(ppm: number): void {
    if (Number.isFinite(ppm) && ppm > 0) {
      this.ppm = ppm;
      // OOB stays 850/this.scale: the native 850/ppm rule is in native world units
      // (px/ppm); the map-coordinate death circle is exactly 850 px for every
      // map, so in this port's px/scale world the ppm cancels. (DEOBFUSCATION
      // §"Death Type 4", tracked in DEOBFUSCATION_FIX_TRACKER.)
    }
  }

  /**
   * Sets the out-of-bounds death-circle center in map coordinates.
   *
   * Native semantics (DEOBFUSCATION "Death Type 4"): a disc dies with
   * deathType 4 when its center is more than 850 map units from the map
   * center. The native engine authors maps around the world origin (editor
   * canvas 730×500 with the world origin at the canvas center, §33.5), so
   * its `GetPosition().Length()` check is origin-relative only because the
   * map center IS the world origin. Exported maps carry their map-center
   * offset in the fixture data (`physics.deathCenter`); maps already
   * centered on the world origin keep the default (0, 0).
   *
   * The radius is unchanged: OUT_OF_BOUNDS_DISTANCE (850) map units from
   * this center, measured to the disc center (native GetPosition, so the
   * disc radius never widens or shrinks the boundary).
   */
  setDeathCircleCenter(centerXMapUnits: number, centerYMapUnits: number): void {
    // A non-finite center would make every OOB distance check NaN, and NaN >
    // threshold is false, silently disabling OOB elimination map-wide. Guard
    // so the death circle is always defined: ignore the bad input and keep the
    // previous (default-origin or last-valid) center.
    if (!Number.isFinite(centerXMapUnits) || !Number.isFinite(centerYMapUnits)) {
      console.warn(
        `setDeathCircleCenter ignoring non-finite center (${centerXMapUnits}, ${centerYMapUnits}); ` +
          `keeping the previous death-circle center so OOB elimination stays enabled`,
      );
      return;
    }
    this.oobCenterX = centerXMapUnits / this.scale;
    this.oobCenterY = centerYMapUnits / this.scale;
  }

  getBodyMap(): Map<string, any> {
    return this.platformBodyMap;
  }

  /**
   * Add a joint between two named bodies from the map definition.
   * Looks up bodies by name in the platformBodyMap.
   */
  /** Synthetic static body used as the "ground" for ground-anchored joints. */
  private groundBody: any = null;

  /** Lazily create the shared static ground body (b2Body with no fixtures). */
  private ensureGroundBody(): any {
    // Invariant: `groundBody` only ever points at a body in the CURRENT world.
    // We null it in reset() (and guard here) so a stale body from a destroyed
    // world can never be reused across episodes.
    if (!this.groundBody || this.groundBody.m_world === null || this.groundBody.m_world !== this.world) {
      const bd = new b2BodyDef();
      this.groundBody = this.world.CreateBody(bd);
    }
    return this.groundBody;
  }

  addJoint(def: Record<string, any>, bodyMap: Map<string, any>): void {
    const bodyA = bodyMap.get(def.bodyA);
    // A joint is ground-anchored ONLY when explicitly marked `isGround` (the
    // adapter sets it for bodyB = -1). `bodyB` being empty/undefined for any
    // OTHER reason is a malformed reference and must warn+skip, NOT silently
    // become a ground joint.
    const isGround = def.isGround === true;
    let bodyB: any = null;
    if (isGround) {
      bodyB = this.ensureGroundBody();
    } else {
      bodyB = bodyMap.get(def.bodyB);
      if (!bodyB) {
        console.warn(`Joint references unknown body "${def.bodyB}" (bodyA="${def.bodyA}")`);
        return;
      }
    }
    if (!bodyA) {
      console.warn(`Joint references unknown body "${def.bodyA}" — skipping joint`);
      return;
    }

    const cd = def.collideConnected ?? false;
    const makeAnchorA = (a?: { x: number; y: number }) =>
      a ? new b2Vec2(a.x / this.scale, a.y / this.scale) : (bodyA.GetPosition().Copy());
    const makeAnchorB = (a?: { x: number; y: number }, b?: any) =>
      a ? new b2Vec2(a.x / this.scale, a.y / this.scale) : (b.GetPosition().Copy());

    const type = def.type;
    let created: any = null;
    if (type === 'distance' || type === 'd') {
      const jd = new b2DistanceJointDef();
      // Ground anchors use native map-px coords (ab += [365/ppm, 250/ppm]).
      const a = makeAnchorA(def.anchorA);
      const b = isGround
        ? new b2Vec2((def.anchorB?.x ?? 0) / this.scale, (def.anchorB?.y ?? 0) / this.scale)
        : makeAnchorB(def.anchorB, bodyB);
      jd.Initialize(bodyA, bodyB, a, b);
      // apply an explicit authored length after Initialize (Initialize sets
      // length from the anchor distance) (§33.7 d: len→0.01-floor).
      if (typeof def.length === 'number' && Number.isFinite(def.length)) {
        jd.length = def.length / this.scale;
      }
      jd.collideConnected = cd;
      jd.frequencyHz = def.frequencyHz ?? 0;
      jd.dampingRatio = def.dampingRatio ?? 0;
      created = this.world.CreateJoint(jd);
    } else if (type === 'rv' || type === 'revolute') {
      const jd = new b2RevoluteJointDef();
      jd.Initialize(bodyA, bodyB, makeAnchorA(def.anchorA));
      jd.collideConnected = cd;
      jd.enableLimit = !!def.enableLimit;
      // Adapter forwards the exporter's lower/upperLimit (which map to the
      // revolute lower/upper ANGLE).
      jd.lowerAngle = def.lowerAngle ?? def.lowerLimit ?? 0;
      jd.upperAngle = def.upperAngle ?? def.upperLimit ?? 0;
      jd.enableMotor = !!def.enableMotor;
      jd.motorSpeed = def.motorSpeed ?? 0;
      jd.maxMotorTorque = def.maxMotorTorque ?? 0;
      created = this.world.CreateJoint(jd);
    } else if (type === 'lpj' || type === 'lsj' || type === 'p' || type === 'prismatic') {
      const jd = new b2PrismaticJointDef();
      const axis = def.axis ? new b2Vec2(def.axis.x, def.axis.y) : new b2Vec2(1, 0);
      jd.Initialize(bodyA, bodyB, makeAnchorA(def.anchorA), axis);
      jd.collideConnected = cd;
      if (def.referenceAngle !== undefined) jd.referenceAngle = def.referenceAngle;
      jd.enableLimit = !!def.enableLimit;
      jd.lowerTranslation = def.lowerTranslation ?? 0;
      jd.upperTranslation = def.upperTranslation ?? 0;
      jd.enableMotor = !!def.enableMotor;
      jd.motorSpeed = def.motorSpeed ?? 0;
      jd.maxMotorForce = def.maxMotorForce ?? 0;
      created = this.world.CreateJoint(jd);
    } else if (type === 'g' || type === 'gear') {
      const j1 = def.jointA ? (this.createdJoints.get(def.jointA) ?? null) : null;
      const j2 = def.jointB ? (this.createdJoints.get(def.jointB) ?? null) : null;
      if (!j1 || !j2) {
        console.warn(`Gear joint references missing referent joints: ${def.jointA}, ${def.jointB}`);
        return;
      }
      const gd = new b2GearJointDef();
      // b2GearJoint computes coordinate1/coordinate2 from the referent type;
      // a distance (or other) referent leaves coordinate undefined and the
      // constant NaN — a silently broken joint. Validate the referents are
      // revolute or prismatic before constructing (§33.8 g).
      const gearOk = (j: any): boolean =>
        j.m_type === box2d.b2Joint.e_revoluteJoint || j.m_type === box2d.b2Joint.e_prismaticJoint;
      if (!gearOk(j1) || !gearOk(j2)) {
        console.warn(
          `Gear joint referents must be revolute or prismatic (${def.jointA}:${j1.m_type}, ${def.jointB}:${j2.m_type}) — skipping joint`);
        return;
      }
      gd.joint1 = j1;
      gd.joint2 = j2;
      gd.ratio = def.ratio ?? 1;
      gd.bodyA = bodyA;
      gd.bodyB = bodyB;
      created = this.world.CreateJoint(gd);
    } else {
      console.warn(`Unknown joint type: ${type}`);
    }

    // Register the created joint by name for gear (g) referent resolution.
    if (created && def.name) {
      this.createdJoints.set(def.name, created);
    }
  }

  /** Map of created joints by name for gear (g) referent resolution. */
  private createdJoints: Map<string, any> = new Map();

  /**
   * Add a dynamic circular player body.
   * Returns the player ID (0-indexed).
   */
  addPlayer(id: number, x: number, y: number): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(x / this.scale, y / this.scale);

    const body = this.world.CreateBody(bodyDef);

    const circleDef = new b2CircleDef();
    circleDef.radius = this.ppm / this.scale;
    // Verified native disc fixture: density = 1/(pi*r^2) baseline so the disc
    // mass is exactly 1 (DEOBFUSCATION §35.4 / §38.6), friction 0.001337,
    // restitution 0.95 (live 2026-07-29 fixture).
    circleDef.density = 1 / (Math.PI * circleDef.radius * circleDef.radius);
    circleDef.friction = PLAYER_FRICTION;
    circleDef.restitution = PLAYER_RESTITUTION;

    // Assign collision category based on the AI slot: AI disc = team g1
    // (category 0x0002), every other disc = team g2 (category 0x0004). The
    // category follows the configured AI slot (setAiPlayerId), not a hardcoded
    // id 0, so a nonzero aiPlayerId keeps the g1 mapping on the AI (#221).
    const filter = new b2FilterData();
    filter.categoryBits = id === this.aiSlot ? 0x0002 : 0x0004;
    filter.maskBits = 0xFFFF; // Collide with everything by default
    circleDef.filter = filter;

    body.CreateShape(circleDef);
    body.SetMassFromShapes();

    // Allow rotation (bonk players spin)
    body.SetUserData({ playerId: id });

    this.playerBodies.set(id, body);
    this.detachedPlayerStates.delete(id);
    this.updatePlayerFilter(id);
    this.playerHeavyState.set(id, false);
    this.playerAlive.set(id, true);
    this.playerDeathType.set(id, 0);
    // Native a1a spawn value (DEOBFUSCATION §32.3, line 6866).
    this.grappleEnergy.set(id, A1A_SPAWN);
  }

  /**
   * Native a1a grapple/energy meter for a player (0-1000). Used by the
   * §32.3 fire gate (a1a > 500), 4/step swing drain, and 3/step recharge.
   */
  getGrappleEnergy(playerId: number): number {
    return this.grappleEnergy.get(playerId) ?? 0;
  }

  /**
   * Apply player inputs as forces on their body.
   */
  applyInput(playerId: number, input: PlayerInput): void {
    const body = this.playerBodies.get(playerId);
    if (!body || !this.playerAlive.get(playerId)) return;

    const force = this._tempForce;
    force.x = 0;
    force.y = 0;

    // Native movement-force model (DEOBFUSCATION §35.5): the radius^2 scale
    // is the disc mass ratio `π·r²/(π·1²)`, which the verified mass-1 disc
    // fixture (#212) pins to exactly 1 for every disc radius — so the applied
    // force is constant and the net acceleration is radius/ppm-invariant, and
    // no per-map `ppm` factor is needed. Heavy then damps the vector via the
    // configured heavy multiplier. The base and the heavy damp are the
    // documented `player.moveForce` / `player.heavyMassMultiplier` surfaces.
    if (input.left) force.x -= this.moveForce;
    if (input.right) force.x += this.moveForce;
    if (input.up) force.y -= this.moveForce;
    if (input.down) force.y += this.moveForce;

    if (input.heavy) force.Multiply(this.heavyForceMultiplier);
    body.ApplyForce(force, body.GetWorldCenter());
    this.playerHeavyState.set(playerId, input.heavy);

    // Handle grapple toggle
    const hasGrapple = this.playerGrappleJoints.has(playerId);
    if (input.grapple && !hasGrapple) {
      this.fireGrapple(playerId);
    } else if (!input.grapple && hasGrapple) {
      this.releaseGrapple(playerId);
    }
  }

  /**
   * Fires a grapple to the closest eligible platform surface.
   *
   * Verified native semantics (DEOBFUSCATION §32, 2026-07-29 build):
   * - Gate: the a1a energy meter must be above 500 (the 500 literal is an
   *   energy threshold, NOT a reach).
   * - Targeting: a ±10 world-unit window around the disc center (native
   *   QueryAABB, equivalent here to iterating the port's platform bodies).
   *   Candidates are map phys bodies only (noGrapple/capzone/players
   *   excluded), scored by center-to-surface distance `d < 10`, sorted
   *   ascending, and the first candidate that is `innerGrapple` or does not
   *   contain the disc center wins (TestPoint gate).
   * - Anchor: body-local surface point (`swing.p = body.GetLocalPoint(world
   *   surface point)`); rest length = distance from disc center to surface.
   * - Joint tuning: `frequencyHz = swingF` (2 Hz) / `dampingRatio = swingD`
   *   (0); the slack/taut 0.01 Hz branch is applied per tick. Map `fh`/`dr`
   *   belong to `d` joints and never apply to the grapple.
   */
  private fireGrapple(playerId: number): void {
    const body = this.playerBodies.get(playerId);
    if (!body) return;

    // a1a energy gate (§32.3): fire requires a1a > 500.
    const energy = this.grappleEnergy.get(playerId) ?? 0;
    if (energy <= A1A_FIRE_THRESHOLD) return;

    globalProfiler.increment('grapple_fire');

    const playerPos = body.GetPosition();

    // §32.1: candidates must lie within the native ±10 world-unit window of
    // the disc center, scored by center-to-surface distance `d < 10`. The 10
    // is a NATIVE world unit (= map px / ppm); this port's world is
    // map px / SCALE, so the window is converted once here to
    // `10 * ppm / SCALE` port units (4.0 at the default ppm = 12 → 120 map px
    // = 10 disc radii, not the 300 map px a bare 10.0 value would reach). The
    // native QueryAABB is a broadphase pre-filter over that same window;
    // iterating the port's platform bodies (the only grappable "phys" bodies)
    // with the identical `d < window` scoring yields exactly the same candidate
    // set. The per-shape AABB overlap test below reproduces the broadphase
    // filter without a fixed-size result buffer: a shape whose surface is
    // within `window` units of the disc center always overlaps the ±window box.
    const windowUnits = (GRAPPLE_TARGET_WINDOW * this.ppm) / this.scale;
    const queryAabb = new b2AABB();
    queryAabb.lowerBound.Set(playerPos.x - windowUnits, playerPos.y - windowUnits);
    queryAabb.upperBound.Set(playerPos.x + windowUnits, playerPos.y + windowUnits);

    const candidates: Array<{ d: number; shape: any; body: any; point: { x: number; y: number } }> = [];
    const shapeAabb = new b2AABB();
    for (const pBody of this.platformBodies) {
      const ud = pBody.GetUserData() || {};
      // Native query filter (lines 8148-8161): noGrapple surfaces excluded;
      // players and capzones are never in platformBodies so never grappleable.
      if (ud.noGrapple) continue;

      const xf = pBody.GetXForm();
      for (let shape = pBody.GetShapeList(); shape !== null; shape = shape.GetNext()) {
        shape.ComputeAABB(shapeAabb, xf);
        if (shapeAabb.lowerBound.x > queryAabb.upperBound.x || shapeAabb.upperBound.x < queryAabb.lowerBound.x ||
            shapeAabb.lowerBound.y > queryAabb.upperBound.y || shapeAabb.upperBound.y < queryAabb.lowerBound.y) {
          continue; // broadphase window miss — cannot satisfy d < window
        }
        const surface = this.closestSurfacePoint(shape, pBody, playerPos);
        if (surface.d < windowUnits) {
          candidates.push({ d: surface.d, shape, body: pBody, point: surface.point });
        }
      }
    }

    if (candidates.length === 0) return;

    // §32.1: candidates sorted by distance ascending (lines 8288-8295).
    candidates.sort((a, b) => a.d - b.d);

    // §32.1 final gate (lines 8297-8306): the first candidate that is
    // innerGrapple or does NOT contain the disc center wins.
    let chosen: typeof candidates[number] | null = null;
    for (const c of candidates) {
      const ud = c.body.GetUserData() || {};
      if (ud.innerGrapple || !c.shape.TestPoint(c.body.GetXForm(), playerPos)) {
        chosen = c;
        break;
      }
    }
    if (!chosen) return;

    // §32.2: joint with body-local surface anchor and rest length = distance
    // from the disc center to the surface point (`swing.p` / `swing.l`).
    const jointDef = new b2DistanceJointDef();
    jointDef.Initialize(body, chosen.body, playerPos, chosen.point);
    jointDef.collideConnected = true;
    jointDef.frequencyHz = GRAPPLE_FREQUENCY_HZ;
    jointDef.dampingRatio = GRAPPLE_DAMPING_RATIO;

    const joint = this.world.CreateJoint(jointDef);
    this.playerGrappleJoints.set(playerId, joint);
    // §32.3 native step order: the a1a update runs before the fire gate in the
    // same physics step, so the attach tick must not drain (or force-release)
    // the new rope — updateGrappleEnergy() recharges it instead so the first
    // drain hits on the next tick. Without this a re-fire at exactly 501 is
    // force-released in the same tick (501 - 4 = 497 < 500) and the recharge
    // path is dead.
    this.swingJustStarted.add(playerId);
  }

  /**
   * §32.1 scoring: closest point on a shape's surface to the disc center and
   * the center-to-surface distance. Circles: `d = |center - player| - radius`
   * with the surface point on the rim toward the player. Polygons (rects
   * included): per-edge point-to-segment projection, closest wins, matching
   * the native edge/chain scoring.
   */
  private closestSurfacePoint(shape: any, body: any, playerPos: any): { d: number; point: { x: number; y: number } } {
    // Circle shapes are discriminated by the port's GetLocalPosition API,
    // which is exposed only on b2CircleShape in this build; polygons have no
    // such method and fall through to the per-edge projection scoring below.
    if (typeof shape.GetLocalPosition === 'function') {
      const center = body.GetWorldPoint(shape.GetLocalPosition());
      const dx = center.x - playerPos.x;
      const dy = center.y - playerPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radius = shape.m_radius;
      if (dist < 1e-9) {
        // Degenerate: player exactly at the circle center; any rim point works.
        return { d: -radius, point: { x: center.x + radius, y: center.y } };
      }
      return {
        d: dist - radius,
        point: { x: center.x - (dx / dist) * radius, y: center.y - (dy / dist) * radius },
      };
    }

    // Polygon: per-edge point-to-segment projection.
    const vertices = shape.m_vertices;
    const count = shape.m_vertexCount;
    let bestD = Infinity;
    let bestPoint = { x: 0, y: 0 };
    for (let i = 0; i < count; i++) {
      const a = body.GetWorldPoint(vertices[i]);
      const b = body.GetWorldPoint(vertices[(i + 1) % count]);
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = playerPos.x - a.x;
      const apy = playerPos.y - a.y;
      const len2 = abx * abx + aby * aby;
      let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * abx;
      const py = a.y + t * aby;
      const ddx = px - playerPos.x;
      const ddy = py - playerPos.y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < bestD) {
        bestD = d;
        bestPoint = { x: px, y: py };
      }
    }
    return { d: bestD, point: bestPoint };
  }

  /**
   * §32.4: the native rope rebuilds the joint every step with
   * `frequencyHz = (separation < swing.l) ? 0.01 : swingF`. The port keeps
   * the joint alive and instead re-reads the current separation each tick,
   * mutating m_frequencyHz (this Box2D port's distance joint re-reads the
   * field in InitVelocityConstraints every step).
   */
  private updateGrappleJointTuning(): void {
    for (const [playerId, joint] of this.playerGrappleJoints) {
      const body = this.playerBodies.get(playerId);
      if (!body) continue;
      const anchor = joint.GetBody2().GetWorldPoint(joint.m_localAnchor2);
      const pos = body.GetPosition();
      const dx = anchor.x - pos.x;
      const dy = anchor.y - pos.y;
      const sep = Math.sqrt(dx * dx + dy * dy);
      joint.m_frequencyHz = sep < joint.m_length ? GRAPPLE_SLACK_FREQUENCY_HZ : GRAPPLE_FREQUENCY_HZ;
    }
  }

  /**
   * §32.3 a1a energy meter: drain 4/step while swinging (from the tick AFTER
   * the rope attaches; the attach tick recharges because the native runs its
   * a1a update before the fire gate in the same step) with forced release
   * (and zeroing) below 500; recharge 3/step otherwise, capped at 1000.
   */
  private updateGrappleEnergy(): void {
    for (const [playerId, body] of Array.from(this.playerBodies)) {
      if (!this.playerAlive.get(playerId)) continue;
      let energy = this.grappleEnergy.get(playerId) ?? A1A_SPAWN;
      if (this.playerGrappleJoints.has(playerId)) {
        if (this.swingJustStarted.delete(playerId)) {
          // Attach tick (§32.3 native order): the step's energy update already
          // ran before the fire gate, so it applies the not-yet-swinging
          // recharge branch. A re-fire at 501 recharges to 504 and thus
          // survives its first drain instead of being released in the same
          // tick (501 - 4 = 497 < 500).
          energy = Math.min(energy + A1A_RECHARGE, A1A_MAX);
        } else {
          energy -= A1A_SWING_DRAIN;
          if (energy < 0) energy = 0;
          if (energy < A1A_FIRE_THRESHOLD) {
            energy = 0;
            this.releaseGrapple(playerId); // forced release below 500
          }
        }
      } else {
        energy = Math.min(energy + A1A_RECHARGE, A1A_MAX);
      }
      this.grappleEnergy.set(playerId, energy);
    }
  }

  private releaseGrapple(playerId: number): void {
    // The swingJustStarted marker only ever accompanies a live joint: purge it
    // on every release (button release, forced drain-out, collision break,
    // detachPlayer) so it can never outlive the joint and mis-flag a later
    // re-fire as an attach tick.
    this.swingJustStarted.delete(playerId);
    const joint = this.playerGrappleJoints.get(playerId);
    if (joint) {
      this.world.DestroyJoint(joint);
      this.playerGrappleJoints.delete(playerId);
    }
  }

  /**
   * Freeze a dead disc's final transforms and remove its body from the live
   * world. Observations read the plain-object snapshot instead of the destroyed
   * b2Body, and the destroyed proxy can no longer leave the fixed broadphase
   * AABB during direct post-death engine ticks.
   */
  private detachPlayer(id: number, body: any): void {
    this.releaseGrapple(id);
    this.pendingSwingDestroy.delete(id);
    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();
    this.detachedPlayerStates.set(id, {
      x: pos.x * this.scale,
      y: pos.y * this.scale,
      velX: vel.x * this.scale,
      velY: vel.y * this.scale,
      angle: body.GetAngle(),
      angularVel: body.GetAngularVelocity(),
    });
    this.world.DestroyBody(body);
    this.playerBodies.delete(id);
  }

  /**
   * Advance the physics simulation by exactly one tick (1/30s).
   * This is the core synchronous step — no real-time clock involved.
   */
    tick(): void {
        if (!this.world) return;
        // This bundled Box2D v2.0 port accepts only one iteration count and
        // ignores the third argument. The real client uses Step(dt, 2, 6);
        // the configured solver iterations drive the velocity-iteration count.
    // Count down last-hit attribution timers (native lht) before the step so
    // contacts created during this Step keep their full 120-tick window.
    for (const [id, ticks] of this.lastHitTicks) {
      if (ticks <= 1) {
        this.lastHitTicks.delete(id);
        this.lastHitBy.delete(id);
      } else {
        this.lastHitTicks.set(id, ticks - 1);
      }
    }

    // Native §32.3 a1a energy update (may force-release a depleted swing),
    // then §32.4 slack/taut joint tuning for the coming step.
    this.updateGrappleEnergy();
    this.updateGrappleJointTuning();

        this.world.Step(this.dt, this.velocityIterations, POSITION_ITERATIONS);
    this.tickCount++;

    // Process cap-zone completion countdowns (before this tick's touches)
    this.processCapZoneCountdowns();

    // Process cap-zone touches collected during Step
    this.processCapZoneTouches();
    this.capZoneTouches.length = 0;

    // Process verified swingCollideDestroyEvents: discs that collided while
    // swinging lose their grapple joint after the step. A collision break
    // also zeroes a1a (native line 8767).
    if (this.pendingSwingDestroy.size > 0) {
      for (const id of this.pendingSwingDestroy) {
        this.releaseGrapple(id);
        this.grappleEnergy.set(id, 0);
      }
      this.pendingSwingDestroy.clear();
    }

    // One pass over a snapshot of the player map: detect OOB deaths, then detach
    // every dead disc. Iterating a copy (instead of the live map, which
    // detachPlayer deletes from) keeps the pass robust if a future cleanup ever
    // removes a not-yet-visited id, which a Map iterator would silently skip.
    // The common no-death tick stays a single walk instead of two full passes.
    for (const [id, body] of Array.from(this.playerBodies)) {
      if (this.playerAlive.get(id)) {
        // Squared comparison avoids a per-player Math.sqrt; threshold identical.
        // Distance is measured from the OOB death-circle center (defaults to
        // the world origin; setDeathCircleCenter moves it to the map center).
        const pos = body.GetPosition();
        const dx = pos.x - this.oobCenterX;
        const dy = pos.y - this.oobCenterY;
        const d2 = dx * dx + dy * dy;
        // Fail-safe (#276): a non-finite position (NaN/Infinity from any
        // solver corruption) must count as out-of-bounds. Without this guard,
        // `NaN > threshold` is false, so a corrupted disc would be immortal
        // and poison every observation for the rest of the episode.
        if (!Number.isFinite(d2) || d2 > this.oobRadiusSquared) {
          this.playerAlive.set(id, false);
          this.playerDeathType.set(id, 4);
          globalProfiler.increment('death_out_of_bounds');
        }
      }

      if (!this.playerAlive.get(id)) {
        this.detachPlayer(id, body);
      }
    }

    if (isTelemetryEnabled()) {
      globalProfiler.gauge('active_joints', this.playerGrappleJoints.size);
    }
  }

  /**
   * Timed cap-zone (type 1) completion countdown, gated on the native
   * `while (p >= l)` rule (DEOBFUSCATION §34.6, lines 3698-3703): the f
   * countdown only advances while the zone progress is at the limit, so a
   * contested zone (p < l) pauses the timer and a takeover team must hold
   * the zone to the limit before the capture fires.
   */
  private processCapZoneCountdowns(): void {
    for (const [, state] of this.capZoneState) {
      if (state.f > 0 && state.p >= state.l) {
        state.f--;
        if (state.f === 0) {
          const ownerTeam = state.ot;
          for (const [id, team] of this.playerTeams) {
            if (team !== ownerTeam) {
              this.playerAlive.set(id, false);
              this.playerDeathType.set(id, 3);
            }
          }
          this.lastScoredTeam = ownerTeam || null;
          state.p = 0;
          state.o = -1;
          state.ot = '';
          state.f = -1;
        }
      }
    }
  }

  private processCapZoneTouches(): void {
    if (this.capZoneTouches.length === 0) return;

    const touchesByZone = new Map<number, Array<{ playerId: number; team: string }>>();
    for (const touch of this.capZoneTouches) {
      let arr = touchesByZone.get(touch.zoneIndex);
      if (!arr) { arr = []; touchesByZone.set(touch.zoneIndex, arr); }
      arr.push({ playerId: touch.playerId, team: touch.team });
    }

    for (const [zoneIndex, touches] of touchesByZone) {
      const state = this.capZoneState.get(zoneIndex);
      if (!state || state.ty !== 1) continue;

      const touchesByTeam = new Map<string, number[]>();
      for (const t of touches) {
        let arr = touchesByTeam.get(t.team);
        if (!arr) { arr = []; touchesByTeam.set(t.team, arr); }
        arr.push(t.playerId);
      }

      const teams = Array.from(touchesByTeam.keys());

      if (teams.length === 1) {
        const team = teams[0];
        const playerIds = touchesByTeam.get(team)!;
        const playerId = playerIds[0];

        if (state.o === -1 || state.ot === '') {
          state.p = 1;
          state.o = playerId;
          state.ot = team;
        } else if (state.ot === team) {
          state.p = Math.min(state.p + playerIds.length, state.l);
        } else {
          state.p -= playerIds.length;
          if (state.p <= 0) {
            state.p = 0;
            state.o = playerId;
            state.ot = team;
          }
        }
      } else {
        let totalCount = 0;
        for (const [, ids] of touchesByTeam) totalCount += ids.length;
        state.p = Math.max(state.p - totalCount, 0);
      }

      if (state.p >= state.l && state.f < 0) {
        state.f = 20;
      }
    }
  }

  /**
   * Get the current state of a player.
   */
  getPlayerState(playerId: number): PlayerState {
    const detached = this.detachedPlayerStates.get(playerId);
    if (detached) {
      return {
        x: detached.x,
        y: detached.y,
        velX: detached.velX,
        velY: detached.velY,
        angle: detached.angle,
        angularVel: detached.angularVel,
        isHeavy: this.playerHeavyState.get(playerId) || false,
        alive: false,
        deathType: this.playerDeathType.get(playerId) || 0,
      };
    }

    const body = this.playerBodies.get(playerId);
    if (!body) {
      return {
        x: 0, y: 0, velX: 0, velY: 0,
        angle: 0, angularVel: 0,
        isHeavy: false, alive: false, deathType: 0,
      };
    }

    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();

    return {
      x: pos.x * this.scale,
      y: pos.y * this.scale,
      velX: vel.x * this.scale,
      velY: vel.y * this.scale,
      angle: body.GetAngle(),
      angularVel: body.GetAngularVelocity(),
      isHeavy: this.playerHeavyState.get(playerId) || false,
      alive: this.playerAlive.get(playerId) || false,
      deathType: this.playerDeathType.get(playerId) || 0,
    };
  }

  /**
   * Get all alive player IDs.
   */
  getAlivePlayerIds(): number[] {
    const alive: number[] = [];
    for (const [id, isAlive] of this.playerAlive) {
      if (isAlive) alive.push(id);
    }
    return alive;
  }

  /**
   * Get the current tick number.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Reset the world — discard the old world entirely and create a fresh one.
   * This avoids box2d broadphase corruption that occurs when destroying many
   * bodies (especially polygons and dynamic bodies) individually.
   */
  reset(): void {
    // Don't try to destroy bodies one-by-one — box2d broadphase gets corrupted
    // on complex maps. Just create a fresh world (from the resolved instance
    // tuning: gravity, sleeping, AABB all keep their configured values) and let
    // the old one be GC'd.
    this.createWorld();

    // Clear all state
    this.playerBodies.clear();
    this.playerHeavyState.clear();
    this.playerAlive.clear();
    this.detachedPlayerStates.clear();
    this.playerDeathType.clear();
    this.playerGrappleJoints.clear();
    this.grappleEnergy.clear();
    this.swingJustStarted.clear();
    this.playerTeams.clear();
    // The AI-slot category mapping belongs to the episode: a fresh world
    // starts with the legacy default (slot 0 = AI), and the environment
    // re-applies setAiPlayerId() before spawning players each episode.
    this.aiSlot = 0;
    this.capZoneSensors = [];
    // Joint state belongs to the old world: drop the ground body and the
    // created-joint map so a fresh episode cannot reuse a stale ground body
    // (ensureGroundBody also guards on this.world) or stale gear referents.
    this.groundBody = null;
    this.createdJoints.clear();
    this.capZoneState.clear();
    this.capZoneTouches = [];
    this.lastScoredTeam = null;
    this.instantGoalResolved = false;
    this.pendingSwingDestroy.clear();
    this.lastHitBy.clear();
    this.lastHitTicks.clear();
    this.platformBodies = [];
    this.platformBodyMap = new Map();
    // Running arena extents belong to the fresh world; bodies re-added after
    // reset() rebuild them incrementally.
    this.arenaMinX = Infinity;
    this.arenaMaxX = -Infinity;
    this.arenaMinY = Infinity;
    this.arenaMaxY = -Infinity;
    this.tickCount = 0;
    // Reset the OOB death-circle center to the origin default. Although it is
    // map-level configuration, it must not survive across maps: reusing this
    // engine for a map without a physics.deathCenter would otherwise keep a
    // stale center from the previous map and shift (never disable) the death
    // circle. The environment re-applies deathCenter after every reset for maps
    // that define it; maps without one fall back to the origin default.
    this.oobCenterX = 0;
    this.oobCenterY = 0;
  }

  /**
   * Completely destroy the world for cleanup.
   */
  destroy(): void {
    this.world = null;
  }
}

// ─── Telemetry Wrapping for Hot Paths ───────────────────────────────────

// Wrap selected PhysicsEngine methods for profiling
// Only enable wrapping when telemetry is explicitly enabled for performance
// Hooks are enabled lazily on first call to avoid module-load timing issues
const physicsProto = PhysicsEngine.prototype as any;
let hooksEnabled = false;

function enablePhysicsHooks(): void {
  if (hooksEnabled) return;
  
  if (!isTelemetryEnabled()) {
    return; // Skip wrapping when telemetry is disabled for performance
  }
  
  physicsProto.tick = wrap(TelemetryIndices.PHYSICS_TICK, physicsProto.tick);
  physicsProto.fireGrapple = wrap(TelemetryIndices.RAYCAST_CALL, physicsProto.fireGrapple);
  physicsProto.checkLethalCollision = wrap(
    TelemetryIndices.COLLISION_RESOLVE,
    physicsProto.checkLethalCollision,
  );
  hooksEnabled = true;
}

// Lazy hook installer - wraps methods on first access
// This ensures TelemetryController is initialized before hooks are enabled
function ensureHooks(): void {
  if (!hooksEnabled) {
    enablePhysicsHooks();
  }
}

// Wrap tick() to ensure hooks are enabled before first physics step
const originalTick = physicsProto.tick;
physicsProto.tick = function(...args: any[]) {
  ensureHooks();
  return originalTick.apply(this, args);
};
