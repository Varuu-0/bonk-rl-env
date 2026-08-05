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
    MapDef,
    MapBodyDef,
    TPS,
} from './physics-engine';
import { PRNG } from './prng';
import { SharedMemoryManager } from '../ipc/shared-memory';

// ─── Constants ───────────────────────────────────────────────────────

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
    /** Documented physics.* tuning forwarded to the PhysicsEngine (issue #217).
     *  Absent keys keep the engine's sanity defaults, so an env built without a
     *  physics section runs with the exact verified native values. */
    physics?: PhysicsTuningConfig;
    /** Documented arena.* tuning (fallback half-bounds and bounds margin). */
    arena?: ArenaTuningConfig;
    /** Documented player.* movement tuning (moveForce, heavyMassMultiplier). */
    player?: PlayerTuningConfig;
}

/** Config-loader `physics.*` section: documented, tunable engine settings. */
export interface PhysicsTuningConfig {
    ticksPerSecond?: number;
    solverIterations?: number;
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

export class BonkEnvironment {
    private physics: PhysicsEngine;
    private config: Required<EnvironmentConfig>;
    private aiPlayerId: number = 0;
    private opponentIds: number[] = [];
    private aiTeam: string = 'blue';
    private scoreBlue: number = 0;
    private scoreRed: number = 0;
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
            mapDef = config.mapData;
        } else {
            // Resolve relative paths against the project root (see
            // resolveMapPath) so the loader's cwd-relative default cannot
            // shadow the cwd-independent fallback in worker mode.
            const configuredPath = config.mapPath || config.defaultMapPath || '';
            const mapPath = configuredPath
                ? resolveMapPath(configuredPath)
                : path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
            try {
                mapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
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

        this.config = {
            numOpponents: SharedMemoryManager.normalizeNumOpponents(config.numOpponents ?? rawConfig.num_opponents ?? 1),
            // The maxTicks default is 30 seconds at the effective tick rate, so
            // a configured ticksPerSecond keeps the same real-time episode
            // length instead of silently truncating at 900 ticks (#217).
            maxTicks: config.maxTicks ?? rawConfig.max_ticks ?? 30 * (config.physics?.ticksPerSecond ?? TPS),
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
            noCollide: config.noCollide ?? ((mapDef as any).physics?.nc ?? false),
            physics: config.physics ?? {},
            arena: config.arena ?? {},
            player: config.player ?? {},
        };

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
                for (const j of (mapDef as any).joints) {
                    (this.physics as any).addJoint(j, bodyMap);
                }
            }
        }

        // Add capZone sensors from map data
        if (mapDef.capZones && mapDef.capZones.length > 0) {
            for (const zone of mapDef.capZones) {
                const fixtureDef = mapDef.bodies.find(b => b.name === zone.fixture);
                if (fixtureDef) {
                    let cx = fixtureDef.x;
                    let cy = fixtureDef.y;
                    let w = 0, h = 0;
                    if (fixtureDef.type === 'rect') {
                        w = fixtureDef.width || 0;
                        h = fixtureDef.height || 0;
                    } else if (fixtureDef.type === 'circle') {
                        w = (fixtureDef.radius || 0) * 2;
                        h = w;
                    }
                    if (typeof (this.physics as any).addCapZone === 'function') {
                        (this.physics as any).addCapZone(zone, cx, cy, w, h);
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
                for (const j of (this.config.mapData as any).joints) {
                    (this.physics as any).addJoint(j, bodyMap);
                }
            }
        }

        // Re-add capZone sensors
        if (this.config.mapData.capZones && this.config.mapData.capZones.length > 0) {
            for (const zone of this.config.mapData.capZones) {
                const fixtureDef = this.config.mapData.bodies.find(b => b.name === zone.fixture);
                if (fixtureDef) {
                    let cx = fixtureDef.x;
                    let cy = fixtureDef.y;
                    let w = 0, h = 0;
                    if (fixtureDef.type === 'rect') {
                        w = fixtureDef.width || 0;
                        h = fixtureDef.height || 0;
                    } else if (fixtureDef.type === 'circle') {
                        w = (fixtureDef.radius || 0) * 2;
                        h = w;
                    }
                    if (typeof (this.physics as any).addCapZone === 'function') {
                        (this.physics as any).addCapZone(zone, cx, cy, w, h);
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

        // Track initial alive states
        this.previousAliveState.clear();
        this.previousAliveState.set(this.aiPlayerId, true);
        for (const id of this.opponentIds) {
            this.previousAliveState.set(id, true);
        }

        // Re-apply explicit map bounds last — body re-adds above recomputed
        // dynamic bounds and would otherwise clobber the override every reset.
        if (this.mapBounds && typeof (this.physics as any).setMapBounds === 'function') {
            this.physics.setMapBounds(this.mapBounds.width, this.mapBounds.height);
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
                    aiAlive: this.physics.getPlayerState(this.aiPlayerId).alive,
                    opponentsAlive: this.opponentIds.filter(
                        id => this.physics.getPlayerState(id).alive,
                    ).length,
                    terminated: this.terminalTerminated,
                    frameSkip: this.config.frameSkip,
                    capZones: this.capZones,
                    scoreBlue: this.scoreBlue,
                    scoreRed: this.scoreRed,
                    aiTeam: this.aiTeam,
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

        // Cache player states to avoid repeated lookups
        const aiState = this.physics.getPlayerState(this.aiPlayerId);
        const opponentStates = this.opponentIds.map(id => this.physics.getPlayerState(id));

        // Calculate reward
        const reward = this.calculateReward(aiState, opponentStates);

        // Update previous alive state for next reward calculation
        this.previousAliveState.set(this.aiPlayerId, aiState.alive);
        for (let i = 0; i < this.opponentIds.length; i++) {
            this.previousAliveState.set(this.opponentIds[i], opponentStates[i].alive);
        }

        // Check for terminal state (death or maxTicks). With zero opponents
        // the empty-state check must not be vacuously true: an episode with
        // no opponents can only end via the AI's death or truncation.
        const allOpponentsDead = opponentStates.length > 0 && opponentStates.every(s => !s.alive);
        const terminated = !aiState.alive || allOpponentsDead;
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
            return {
                left: !!(action & 1),
                right: !!(action & 2),
                up: !!(action & 4),
                down: !!(action & 8),
                heavy: !!(action & 16),
                grapple: !!(action & 32),
            };
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
     * Reward structure:
     *   +1.0  — opponent knocked off the map (killed)
     *   -1.0  — AI player knocked off the map (death)
     *   ±1.0  — cap-zone capture for/against the AI team (single reward for
     *           the event; cap-zone eliminations (deathType 3) do NOT also
     *           count as kills)
     *   -0.001 — time penalty (encourages action)
     */
    private calculateReward(aiState: PlayerState, opponentStates: PlayerState[]): number {
        let reward = 0;

        // Check if AI just died this tick (cap-zone eliminations score via the
        // capture branch below instead of double-counting as a death)
        const aiWasAlive = this.previousAliveState.get(this.aiPlayerId) ?? true;
        if (aiWasAlive && !aiState.alive && aiState.deathType !== 3) {
            reward -= 1.0;
        }

        // Check if any opponent just died this tick
        for (let i = 0; i < this.opponentIds.length; i++) {
            const opState = opponentStates[i];
            const opWasAlive = this.previousAliveState.get(this.opponentIds[i]) ?? true;
            if (opWasAlive && !opState.alive && opState.deathType !== 3) {
                reward += 1.0;
            }
        }

        // Check capZone scoring
        if (typeof (this.physics as any).getTeamScored === 'function') {
            const scoredTeam = (this.physics as any).getTeamScored();
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
        }

        // Small time penalty
        reward -= 0.001;

        return reward;
    }

    /**
     * Build the observation object from current physics state.
     */
    private getObservation(): Observation {
        const aiState = this.physics.getPlayerState(this.aiPlayerId);

        const opponents = this.opponentIds.map(id => {
            const s = this.physics.getPlayerState(id);
            return {
                x: s.x,
                y: s.y,
                velX: s.velX,
                velY: s.velY,
                isHeavy: s.isHeavy,
                alive: s.alive,
            };
        });

        const arenaBounds = this.physics.getArenaBounds();

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
     * Fast observation extraction — returns a pre-allocated Float32Array
     * directly from physics state, skipping intermediate object creation.
     * Layout matches worker.ts observationToArray() output: 7 player floats,
     * 6 floats per opponent (first opponent at 7-12, extras appended after
     * the tick at 16+), 2 arena floats at 13-14, tick at 15.
     */
    getObservationFast(): Float32Array {
        const aiState = this.physics.getPlayerState(this.aiPlayerId);

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
            const state = this.physics.getPlayerState(this.opponentIds[i]);
            const base = i === 0 ? 7 : 16 + 6 * (i - 1);
            this._obsBuffer[base] = state.x;
            this._obsBuffer[base + 1] = state.y;
            this._obsBuffer[base + 2] = state.velX;
            this._obsBuffer[base + 3] = state.velY;
            this._obsBuffer[base + 4] = state.isHeavy ? 1 : 0;
            this._obsBuffer[base + 5] = state.alive ? 1 : 0;
        }

        const arenaBounds = this.physics.getArenaBounds();
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
