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
    SCALE,
    TPS,
} from './physics-engine';
import { PRNG } from './prng';

// ─── Constants ───────────────────────────────────────────────────────

/** Maximum number of ticks before a round is forcefully ended (truncation). */
const MAX_TICKS = 30 * TPS; // 30 seconds at 30 TPS = 900 ticks

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
    /** Opponent random-policy probabilities */
    oppMoveProb?: number;
    oppUpProb?: number;
    oppDownProb?: number;
    oppHeavyProb?: number;
    oppGrappleProb?: number;
    /** Native team mode (`tea`): same-team discs do not collide (default false) */
    teamsEnabled?: boolean;
    /** Native no-collision physics mode (`nc`): discs never collide (default false) */
    noCollide?: boolean;
}

// ─── Default Arena ───────────────────────────────────────────────────

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
    private _obsBuffer: Float32Array = new Float32Array(16);
    private ppm: number = 12;
    private capZones: Array<{ index: number; owner: string; type: number }> = [];
    private mapBounds: { width: number; height: number } | null = null;

    constructor(config: Partial<EnvironmentConfig> = {}) {
        // Normalize config: accept both camelCase and snake_case
        const frameSkip = config.frameSkip !== undefined ? config.frameSkip : (config as any).frame_skip;

        // Load map from file or use provided config
        let mapDef: MapDef;
        if (config.mapData) {
            mapDef = config.mapData;
        } else {
            const mapPath = config.mapPath || path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
            try {
                mapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            } catch (e) {
                console.warn("Could not load default map, using fallback box");
                mapDef = getDefaultMap();
            }
        }

        // Read map-level physics overrides
        this.ppm = config.ppm ?? (mapDef as any).physics?.ppm ?? 12;
        this.capZones = (mapDef as any).capZones ?? [];

        this.config = {
            numOpponents: config.numOpponents ?? 1,
            maxTicks: config.maxTicks ?? MAX_TICKS,
            randomOpponent: config.randomOpponent ?? true,
            mapData: mapDef,
            seed: (config.seed && config.seed !== 0) ? config.seed : Math.floor(Math.random() * 1000000),
            frameSkip: frameSkip ?? 1,
            ppm: this.ppm,
            mapPath: config.mapPath ?? '',
            oppMoveProb: config.oppMoveProb ?? 0.2,
            oppUpProb: config.oppUpProb ?? 0.15,
            oppDownProb: config.oppDownProb ?? 0.1,
            oppHeavyProb: config.oppHeavyProb ?? 0.05,
            oppGrappleProb: config.oppGrappleProb ?? 0.05,
            teamsEnabled: config.teamsEnabled ?? ((mapDef as any).physics?.teams ?? false),
            noCollide: config.noCollide ?? ((mapDef as any).physics?.nc ?? false),
        };

        this.rng = new PRNG(this.config.seed);
        this.physics = new PhysicsEngine();

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

        // Add AI player
        this.aiPlayerId = 0;
        this.physics.addPlayer(
            this.aiPlayerId,
            teamB.x,
            teamB.y,
        );

        // Add opponent(s)
        this.opponentIds = [];
        for (let i = 0; i < this.config.numOpponents; i++) {
            const id = i + 1;
            this.physics.addPlayer(
                id,
                teamR.x,
                teamR.y,
            );
            this.opponentIds.push(id);
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

        // Reset frame skip state
        this.frameSkipTicks = 0;
        this.terminalReached = false;
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
        // If terminal was already reached in a previous tick of this cycle, return done immediately
        // without stepping physics further (rewards were already accumulated)
        if (this.terminalReached) {
            this.frameSkipTicks++;
            if (this.frameSkipTicks >= this.config.frameSkip) {
                this.frameSkipTicks = 0;
                this.terminalReached = false;
            }
            const observation = this.getObservation();
            return {
                observation,
                reward: 0,
                done: true,
                truncated: false,
                info: {
                    tick: this.physics.getTickCount(),
                    aiAlive: this.physics.getPlayerState(this.aiPlayerId).alive,
                    opponentsAlive: this.opponentIds.filter(
                        id => this.physics.getPlayerState(id).alive,
                    ).length,
                    terminated: true,
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

        // Check for terminal state (death or maxTicks)
        const allOpponentsDead = opponentStates.every(s => !s.alive);
        const terminated = !aiState.alive || allOpponentsDead;
        const truncated = this.physics.getTickCount() >= this.config.maxTicks;

        // If terminal reached, set flag to report done immediately on subsequent ticks
        if (terminated || truncated) {
            this.terminalReached = true;
        }

        // Increment frame skip counter
        this.frameSkipTicks++;

        // Reset frame skip counter for next action after completing the cycle
        if (this.frameSkipTicks >= this.config.frameSkip) {
            this.frameSkipTicks = 0;
            // Only clear terminalReached if we're not in a terminal state
            if (!terminated && !truncated) {
                this.terminalReached = false;
            }
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
     * Fast observation extraction — returns a pre-allocated Float32Array(16)
     * directly from physics state, skipping intermediate object creation.
     * Layout matches worker.ts observationToArray() output.
     */
    getObservationFast(): Float32Array {
        const aiState = this.physics.getPlayerState(this.aiPlayerId);
        const oppId = this.opponentIds[0];
        const oppState = oppId !== undefined ? this.physics.getPlayerState(oppId) : null;

        this._obsBuffer[0] = aiState.x;
        this._obsBuffer[1] = aiState.y;
        this._obsBuffer[2] = aiState.velX;
        this._obsBuffer[3] = aiState.velY;
        this._obsBuffer[4] = aiState.angle;
        this._obsBuffer[5] = aiState.angularVel;
        this._obsBuffer[6] = aiState.isHeavy ? 1 : 0;

        if (oppState) {
            this._obsBuffer[7] = oppState.x;
            this._obsBuffer[8] = oppState.y;
            this._obsBuffer[9] = oppState.velX;
            this._obsBuffer[10] = oppState.velY;
            this._obsBuffer[11] = oppState.isHeavy ? 1 : 0;
            this._obsBuffer[12] = oppState.alive ? 1 : 0;
        } else {
            this._obsBuffer[7] = 0;
            this._obsBuffer[8] = 0;
            this._obsBuffer[9] = 0;
            this._obsBuffer[10] = 0;
            this._obsBuffer[11] = 0;
            this._obsBuffer[12] = 0;
        }

        const arenaBounds = this.physics.getArenaBounds();
        this._obsBuffer[13] = arenaBounds.halfWidth;
        this._obsBuffer[14] = arenaBounds.halfHeight;
        this._obsBuffer[15] = this.physics.getTickCount();
        return this._obsBuffer;
    }
}
