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
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
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
    private previousAliveState: Map<number, boolean> = new Map();
    private rng: PRNG;
    private lastAction: PlayerInput = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
    private frameSkipTicks: number = 0;
    private terminalReached: boolean = false;

    constructor(config: Partial<EnvironmentConfig> = {}) {
        // Normalize config: accept both camelCase and snake_case
        const frameSkip = config.frameSkip !== undefined ? config.frameSkip : (config as any).frame_skip;

        // Load map from file or use provided config
        let mapDef: MapDef;
        if (config.mapData) {
            mapDef = config.mapData;
        } else {
            const mapPath = path.join(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
            try {
                mapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            } catch (e) {
                console.warn("Could not load default map, using fallback box");
                mapDef = getDefaultMap();
            }
        }

        this.config = {
            numOpponents: config.numOpponents ?? 1,
            maxTicks: config.maxTicks ?? MAX_TICKS,
            randomOpponent: config.randomOpponent ?? true,
            mapData: mapDef,
            seed: config.seed ?? Math.floor(Math.random() * 1000000),
            frameSkip: frameSkip ?? 1,
        };

        this.rng = new PRNG(this.config.seed);
        this.physics = new PhysicsEngine();

        for (const body of this.config.mapData.bodies) {
            this.physics.addBody(body);
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
        // Clean up old physics engine, recover if corrupted
        try {
            this.physics.reset();
        } catch (e: any) {
            console.warn('[BonkEnvironment] reset: physics reset failed, creating fresh engine:', e?.message || e);
        }

        // Create fresh physics engine
        this.physics = new PhysicsEngine();

        // Re-add platforms after physics reset (they were destroyed by physics.reset())
        for (const body of this.config.mapData.bodies) {
            this.physics.addBody(body);
        }

        // Extract spawn positions from map
        const spawnVals = Object.values(this.config.mapData.spawnPoints);
        const teamB = spawnVals[0] || { x: -200, y: -100 };
        const teamR = spawnVals[1] || { x: 200, y: -100 };

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

        // Track initial alive states
        this.previousAliveState.clear();
        this.previousAliveState.set(this.aiPlayerId, true);
        for (const id of this.opponentIds) {
            this.previousAliveState.set(id, true);
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
            left: this.rng.next() < 0.2,
            right: this.rng.next() < 0.2,
            up: this.rng.next() < 0.15,
            down: this.rng.next() < 0.1,
            heavy: this.rng.next() < 0.05,
            grapple: this.rng.next() < 0.05,
        };
    }

    /**
     * Calculate reward for the current tick.
     *
     * Reward structure:
     *   +1.0  — opponent knocked off the map (killed)
     *   -1.0  — AI player knocked off the map (death)
     *   -0.001 — time penalty (encourages action)
     */
    private calculateReward(aiState: PlayerState, opponentStates: PlayerState[]): number {
        let reward = 0;

        // Check if AI just died this tick
        const aiWasAlive = this.previousAliveState.get(this.aiPlayerId) ?? true;
        if (aiWasAlive && !aiState.alive) {
            reward -= 1.0;
        }

        // Check if any opponent just died this tick
        for (let i = 0; i < this.opponentIds.length; i++) {
            const opState = opponentStates[i];
            const opWasAlive = this.previousAliveState.get(this.opponentIds[i]) ?? true;
            if (opWasAlive && !opState.alive) {
                reward += 1.0;
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

        return {
            playerX: aiState.x,
            playerY: aiState.y,
            playerVelX: aiState.velX,
            playerVelY: aiState.velY,
            playerAngle: aiState.angle,
            playerAngularVel: aiState.angularVel,
            playerIsHeavy: aiState.isHeavy,
            opponents,
            arenaHalfWidth: ARENA_HALF_WIDTH * SCALE,
            arenaHalfHeight: ARENA_HALF_HEIGHT * SCALE,
            tick: this.physics.getTickCount(),
        };
    }
}
