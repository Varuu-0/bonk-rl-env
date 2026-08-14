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

import {
    PhysicsEngine,
    PlayerInput,
    PlayerState,
    DeathEvent,
    MapDef,
    MapBodyDef,
    TPS,
} from './physics-engine';
import { normalizeMap } from './map-adapter';
import { PRNG } from './prng';
import { SharedMemoryManager } from '../ipc/shared-memory';
import { assertValidAction, decodeEncodedAction } from './action-validation';

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Default episode length in ticks (native 30 s at 30 TPS). Tick-counted by
 * design — like every other native timer in the engine (a1a drain/recharge,
 * last-hit attribution 120, cap-zone hold `(l ?? 3) * 30`), maxTicks does NOT
 * rescale with a configured ticksPerSecond, so at a non-default TPS the
 * real-time episode length changes with the fixed tick count.
 */
const MAX_TICKS_DEFAULT = 30 * TPS;

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
    info: Record<string, any>;
}

export interface EnvironmentConfig {
    /** Number of opponents (default 1) */
    numOpponents?: number;
    /** Maximum ticks per episode (default 900) */
    maxTicks?: number;
    /** Whether to use a random opponent policy (default true) */
    randomOpponent?: boolean;
    /** Custom map definition */
    mapData?: MapDef;
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

/**
 * Creates a simple default map config if none is provided.
 */
function getDefaultMap(): MapDef {
    return {
        name: "Default_Box",
        spawnPoints: {
            team_blue: { x: -200, y: -100 },
            team_red: { x: 200, y: -100 }
        },
        bodies: [
            { name: "floor", type: "rect", x: 0, y: 200, width: 800, height: 30, static: true },
            { name: "left", type: "rect", x: -500, y: 0, width: 30, height: 600, static: true },
            { name: "right", type: "rect", x: 500, y: 0, width: 30, height: 600, static: true }
        ]
    };
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
function getCapZoneSensorSize(fixtureDef: MapBodyDef): { w: number; h: number; cx: number; cy: number; angle: number } | null {
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
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
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
    console.warn(`CapZone fixture "${fixtureDef.name}" has unsupported type "${fixtureDef.type}" — skipping cap-zone sensor`);
    return null;
}

export class BonkEnvironment {
    private physics: PhysicsEngine;
    /** Stored resolved config: flat reward keys are not stored — only the nested
     * `reward` object holds the resolved weights (single source of truth) (#220). */
    private config: Required<Omit<EnvironmentConfig, 'killReward' | 'deathPenalty' | 'timePenalty' | 'reward'>> & { reward: Required<ResolvedRewardConfig> };
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

        // Load map from file or use provided config. `mapData` (programmatic)
        // wins; otherwise the documented map-path surface is honored end to
        // end: the config-loader resolves `--map` / `DEFAULT_MAP_PATH` /
        // `environment.defaultMapPath` into `defaultMapPath`, which the worker
        // forwards verbatim. `mapPath` is the per-env programmatic override;
        // the hardcoded WDB path is only the last-resort fallback.
        let mapDef: MapDef;
        let mapFile = '';
        if (config.mapData) {
            // Programmatic mapData is normalized too: callers may pass either
            // the real exported bonk format or an already-normalized MapDef.
            mapDef = normalizeMap(config.mapData);
        } else {
            // Resolve relative paths against the project root (see
            // resolveMapPath) so the loader's cwd-relative default cannot
            // shadow the cwd-independent fallback in worker mode.
            const configuredPath = config.mapPath || config.defaultMapPath || '';
            const mapPath = configuredPath
                ? resolveMapPath(configuredPath)
                : path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
            try {
                const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                // Convert the real exported bonk format into the engine MapDef.
                const normalized = normalizeMap(parsed);
                mapDef = normalized;
                mapFile = mapPath;
            } catch (e) {
                console.warn(`Could not load map "${mapPath}", using fallback box`);
                mapDef = getDefaultMap();
            }
        }

        // Read map-level physics overrides
        this.ppm = config.ppm ?? (mapDef as any).physics?.ppm ?? 12;
        this.capZones = (mapDef as any).capZones ?? [];

        // Opponent random-policy probabilities: accept both the direct
        // opp*Prob names and the config-loader's documented randomOpp*Prob
        // aliases; an explicit opp*Prob value wins over the alias.
        const oppMoveProb = config.oppMoveProb ?? config.randomOppMoveProb ?? 0.2;
        const oppUpProb = config.oppUpProb ?? config.randomOppUpProb ?? 0.15;
        const oppDownProb = config.oppDownProb ?? config.randomOppDownProb ?? 0.1;
        const oppHeavyProb = config.oppHeavyProb ?? config.randomOppHeavyProb ?? 0.05;
        const oppGrappleProb = config.oppGrappleProb ?? config.randomOppGrappleProb ?? 0.05;

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
            numOpponents: SharedMemoryManager.normalizeNumOpponents(config.numOpponents ?? rawConfig.num_opponents ?? 1),
            maxTicks: config.maxTicks ?? rawConfig.max_ticks ?? MAX_TICKS_DEFAULT,
            randomOpponent: config.randomOpponent ?? rawConfig.random_opponent ?? true,
            mapData: mapDef,
            // Seed 0 is a valid deterministic seed and must reach the PRNG: a
            // truthiness check would map `--seed 0` / `SEED=0` /
            // `environment.seed: 0` onto a random seed while reset(0) and
            // pool.reset([0]) stay deterministic, silently breaking
            // constructed-env replay (#200). Only an absent seed (undefined/
            // null) falls back to a random one.
            seed: config.seed !== undefined && config.seed !== null
                ? config.seed
                : Math.floor(Math.random() * 1000000),
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
            teamsEnabled: config.teamsEnabled ?? ((mapDef as any).physics?.teams ?? false),
            noCollide: config.noCollide ?? (mapDef as any).settings?.nc ?? false,
            // Symmetric with noCollide: explicit config overrides the map's
            // per-map settings (P3b fl/re gating).
            flipped: config.flipped ?? !!((mapDef as any).settings?.fl),
            respawnEnabled: config.respawnEnabled ?? !!((mapDef as any).settings?.re),
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
            throw new Error(
                `Invalid maxTicks ${this.config.maxTicks}: expected a positive integer`,
            );
        }

        // The AI slot is config-driven, never hardcoded to 0 (#221). An
        // out-of-range slot fails loudly here instead of being silently
        // ignored: with numOpponents opponents the spawned players occupy
        // slots [0, numOpponents] (the AI plus one slot per opponent).
        this.aiPlayerId = this.config.aiPlayerId;
        if (!Number.isInteger(this.aiPlayerId) || this.aiPlayerId < 0) {
            throw new Error(
                `Invalid aiPlayerId ${this.aiPlayerId}: expected a non-negative integer player slot`,
            );
        }
        if (this.aiPlayerId > this.config.numOpponents) {
            throw new Error(
                `Invalid aiPlayerId ${this.aiPlayerId}: with ${this.config.numOpponents} opponent(s) the player slots are 0..${this.config.numOpponents}`,
            );
        }

        this.rng = new PRNG(this.config.seed);
        this.physics = new PhysicsEngine({
            ticksPerSecond: config.physics?.ticksPerSecond,
            velocityIterations: config.physics?.solverIterations,
            positionIterations: config.physics?.positionIterations,
            // Per-map native physics quality (pq): 2 → 15/15 solver iterations,
            // anything else → 2/6 (DEOBFUSCATION §Solver Iterations). Explicit
            // solverIterations/positionIterations config keys override it.
            physicsQuality: this.config.mapData.settings?.pq,
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

        // Set PPM before adding bodies
        if (typeof (this.physics as any).setScale === 'function') {
            (this.physics as any).setScale(this.ppm);
        }

        for (const body of this.config.mapData.bodies) {
            this.physics.addBody(body);
        }

        // Add joints if defined
        if ((mapDef as any).joints && (mapDef as any).joints.length > 0) {
            const bodyMap = (this.physics as any).getBodyMap?.();
            if (bodyMap) {
                // Create non-gear joints FIRST so gear referents (which the
                // engine resolves from the created-joint map) always exist,
                // regardless of the joint array order.
                const gearJoints: any[] = [];
                for (const j of (mapDef as any).joints) {
                    if (j.type === 'g' || j.type === 'gear') gearJoints.push(j);
                    else (this.physics as any).addJoint(j, bodyMap);
                }
                for (const j of gearJoints) {
                    (this.physics as any).addJoint(j, bodyMap);
                }
            }
        }

        // Add capZone sensors from map data
        if (mapDef.capZones && mapDef.capZones.length > 0) {
            for (const zone of mapDef.capZones) {
                const fixtureDef = mapDef.bodies.find(b => b.name === zone.fixture);
                if (fixtureDef) {
                    const size = getCapZoneSensorSize(fixtureDef);
                    if (size && typeof (this.physics as any).addCapZone === 'function') {
                        (this.physics as any).addCapZone(zone, fixtureDef.x + size.cx, fixtureDef.y + size.cy, size.w, size.h, size.angle);
                    }
                } else {
                    console.warn(`CapZone fixture "${zone.fixture}" not found`);
                }
            }
        }

        // Cache explicit map bounds — reset() re-adds bodies, which recomputes
        // dynamic bounds, so the override must be re-applied after every reset.
        this.mapBounds = (mapDef as any).physics?.bounds ?? null;

        // Cache the map's OOB death-circle center (physics.deathCenter). The
        // native death circle is centered on the map's authored origin (850 map
        // units, DEOBFUSCATION "Death Type 4"); exported maps whose coordinates
        // are offset from the world origin carry that center here. Maps without
        // one use the engine default (world origin), preserving origin-centered
        // behavior for hand-built maps.
        this.mapDeathCenter = (mapDef as any).physics?.deathCenter ?? null;
        if (this.mapDeathCenter && typeof (this.physics as any).setDeathCircleCenter === 'function') {
            this.physics.setDeathCircleCenter(this.mapDeathCenter.x, this.mapDeathCenter.y);
        }

        this.reset();
    }

    /**
     * Reset the environment to initial state, returning the first observation.
     */
    reset(seed?: number): Observation {
        if (seed !== undefined) {
            this.config.seed = seed;
            this.rng.setSeed(seed);
        }
        this.scoreBlue = 0;
        this.scoreRed = 0;
        // Discard the old Box2D world instead of destroying bodies in-place;
        // the bundled port can retain invalid broadphase bounds after teardown.
        this.physics.reset();

        // Re-add platforms to the fresh world
        for (const body of this.config.mapData.bodies) {
            this.physics.addBody(body);
        }

        // Re-add joints if defined
        if ((this.config.mapData as any).joints && (this.config.mapData as any).joints.length > 0) {
            const bodyMap = (this.physics as any).getBodyMap?.();
            if (bodyMap) {
                const gearJoints: any[] = [];
                for (const j of (this.config.mapData as any).joints) {
                    if (j.type === 'g' || j.type === 'gear') gearJoints.push(j);
                    else (this.physics as any).addJoint(j, bodyMap);
                }
                for (const j of gearJoints) {
                    (this.physics as any).addJoint(j, bodyMap);
                }
            }
        }

        // Re-add capZone sensors
        if (this.config.mapData.capZones && this.config.mapData.capZones.length > 0) {
            for (const zone of this.config.mapData.capZones) {
                const fixtureDef = this.config.mapData.bodies.find(b => b.name === zone.fixture);
                if (fixtureDef) {
                    const size = getCapZoneSensorSize(fixtureDef);
                    if (size && typeof (this.physics as any).addCapZone === 'function') {
                        (this.physics as any).addCapZone(zone, fixtureDef.x + size.cx, fixtureDef.y + size.cy, size.w, size.h, size.angle);
                    }
                }
            }
        }

        // Extract spawn positions from map using team keys
        const spawnPoints = this.config.mapData.spawnPoints;
        const spawnKeys = Object.keys(spawnPoints);
        const teamB = spawnPoints.team_blue || (spawnKeys.length > 0 ? spawnPoints[spawnKeys[0]] : null) || { x: -200, y: -100 };
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
        this.physics.addPlayer(
            this.aiPlayerId,
            teamB.x,
            teamB.y,
        );

        // Add opponent(s)
        this.opponentIds = [];
        for (let slot = 0; slot <= this.config.numOpponents; slot++) {
            if (slot === this.aiPlayerId) continue;
            this.physics.addPlayer(
                slot,
                teamR.x,
                teamR.y,
            );
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
        // getScale skips the override instead of throwing in reset().
        // Both methods are duck-checked: an engine exposing setMapBounds but not
        // getScale skips the override instead of throwing in reset().
        if (this.mapBounds
            && typeof (this.physics as any).setMapBounds === 'function'
            && typeof (this.physics as any).getScale === 'function') {
            const scale = (this.physics as any).getScale();
            this.physics.setMapBounds(this.mapBounds.width / scale, this.mapBounds.height / scale);
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
        // Reject malformed actions (arrays, empty objects, non-boolean field
        // values, null, NaN, ...) with the same labeled error the pool
        // surfaces, before any state is touched. A wrong-shaped action must
        // not silently execute as a different no-op action or crash with an
        // opaque TypeError (#278).
        assertValidAction(action);
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
                info: {
                    tick: this.physics.getTickCount(),
                    aiAlive: this.getVisiblePlayerState(this.aiPlayerId).alive,
                    opponentsAlive: this.opponentIds.filter(
                        id => this.getVisiblePlayerState(id).alive,
                    ).length,
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

        // If starting a new frame skip cycle, update the stored action
        if (this.frameSkipTicks === 0) {
            this.lastAction = this.decodeAction(action);
        }

        const aiInput = this.lastAction;

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
        const opponentPhysicsStates = this.opponentIds.map(id => this.physics.getPlayerState(id));
        const aiState = this.getVisiblePlayerState(this.aiPlayerId);
        const opponentStates = this.opponentIds.map(id => this.getVisiblePlayerState(id));

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
        const allOpponentsPermanentlyDead = opponentStates.length > 0 && opponentStates.every((s, i) =>
            !s.alive && !this.physics.isPendingRespawn(this.opponentIds[i]),
        );
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
            info: {
                tick: this.physics.getTickCount(),
                aiAlive: aiState.alive,
                opponentsAlive: opponentStates.filter(s => s.alive).length,
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
        try {
            this.physics.destroy();
        } catch (e: any) {
            console.warn('[BonkEnvironment] close: physics destroy failed:', e?.message || e);
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────

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
                const onLosingTeam = scoredTeam === this.aiTeam
                    ? this.opponentIds.includes(event.playerId)
                    : event.playerId === this.aiPlayerId;
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
                this.scoreBlue += (this.aiTeam === 'blue' ? 1 : 0);
                this.scoreRed += (this.aiTeam === 'red' ? 1 : 0);
            } else {
                reward -= 1.0;
                this.scoreBlue += (scoredTeam === 'blue' ? 1 : 0);
                this.scoreRed += (scoredTeam === 'red' ? 1 : 0);
            }
        }

        // Per-tick time penalty
        reward += this.config.reward.timePenalty;

        return reward;
    }

    /**
     * Build the observation object from current physics state.
     */
    private getObservation(): Observation {
        const aiState = this.getVisiblePlayerState(this.aiPlayerId);

        const opponents = this.opponentIds.map(id => {
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

    /** The dying-step view: physics' pre-respawn snapshot for the latest tick
     *  (the single source of truth shared with render readers), otherwise the
     *  live state. */
    private getVisiblePlayerState(playerId: number): PlayerState {
        return this.physics.getVisiblePlayerState(playerId);
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
        if (this.mapBounds !== null
            && typeof (this.physics as any).setMapBounds === 'function'
            && typeof (this.physics as any).getScale === 'function') {
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
        this._obsBuffer[15] = this.physics.getTickCount();
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
    getStaticInfo(): { frameSkip: number; capZones: Array<{ index: number; owner: string; type: number }>; aiTeam: string } {
        return {
            frameSkip: this.config.frameSkip,
            capZones: this.capZones,
            aiTeam: this.aiTeam,
        };
    }
}
