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

    // Pre-allocated objects for zero-allocation hot path
    private _cachedObservation: Observation = {
        playerX: 0, playerY: 0, playerVelX: 0, playerVelY: 0,
        playerAngle: 0, playerAngularVel: 0, playerIsHeavy: false,
        opponents: [],
        arenaHalfWidth: 0, arenaHalfHeight: 0, tick: 0,
    };
    private _cachedStepResult: StepResult = {
        observation: null as any,
        reward: 0, done: false, truncated: false,
        info: {},
    };
    private _cachedInfo: Record<string, any> = {
        tick: 0, aiAlive: false, opponentsAlive: 0, terminated: false, frameSkip: 1,
    };
    private _cachedOpInput: PlayerInput = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
    private _cachedDecodeInput: PlayerInput = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };

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

        // Pre-allocate opponent entries in cached observation
        this._cachedObservation.opponents = [];
        for (let i = 0; i < this.config.numOpponents; i++) {
            this._cachedObservation.opponents.push({ x: 0, y: 0, velX: 0, velY: 0, isHeavy: false, alive: false });
        }

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
            // Terminal path: fetch fresh states since cached ones aren't available
            const termAiState = this.physics.getPlayerState(this.aiPlayerId);
            const termOpStates = this.opponentIds.map(id => this.physics.getPlayerState(id));
            const observation = this.getObservation(termAiState, termOpStates);
            this._cachedInfo.tick = this.physics.getTickCount();
            this._cachedInfo.aiAlive = termAiState.alive;
            this._cachedInfo.opponentsAlive = termOpStates.filter(s => s.alive).length;
            this._cachedInfo.terminated = true;
            this._cachedInfo.frameSkip = this.config.frameSkip;
            this._cachedStepResult.observation = observation;
            this._cachedStepResult.reward = 0;
            this._cachedStepResult.done = true;
            this._cachedStepResult.truncated = false;
            this._cachedStepResult.info = this._cachedInfo;
            return this._cachedStepResult;
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

        const observation = this.getObservation(aiState, opponentStates);

        this._cachedInfo.tick = this.physics.getTickCount();
        this._cachedInfo.aiAlive = aiState.alive;
        this._cachedInfo.opponentsAlive = opponentStates.filter(s => s.alive).length;
        this._cachedInfo.terminated = terminated;
        this._cachedInfo.frameSkip = this.config.frameSkip;
        this._cachedStepResult.observation = observation;
        this._cachedStepResult.reward = reward;
        this._cachedStepResult.done = terminated || truncated;
        this._cachedStepResult.truncated = truncated;
        this._cachedStepResult.info = this._cachedInfo;
        return this._cachedStepResult;
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
            this._cachedDecodeInput.left = !!(action & 1);
            this._cachedDecodeInput.right = !!(action & 2);
            this._cachedDecodeInput.up = !!(action & 4);
            this._cachedDecodeInput.down = !!(action & 8);
            this._cachedDecodeInput.heavy = !!(action & 16);
            this._cachedDecodeInput.grapple = !!(action & 32);
            return this._cachedDecodeInput;
        }
        return action;
    }

    /**
     * Generate opponent input (random or scripted).
     */
    private getOpponentInput(opId: number): PlayerInput {
        if (!this.config.randomOpponent) {
            this._cachedOpInput.left = false;
            this._cachedOpInput.right = false;
            this._cachedOpInput.up = false;
            this._cachedOpInput.down = false;
            this._cachedOpInput.heavy = false;
            this._cachedOpInput.grapple = false;
            return this._cachedOpInput;
        }

        // Simple random policy: each direction has x% chance per tick
        this._cachedOpInput.left = this.rng.next() < 0.2;
        this._cachedOpInput.right = this.rng.next() < 0.2;
        this._cachedOpInput.up = this.rng.next() < 0.15;
        this._cachedOpInput.down = this.rng.next() < 0.1;
        this._cachedOpInput.heavy = this.rng.next() < 0.05;
        this._cachedOpInput.grapple = this.rng.next() < 0.05;
        return this._cachedOpInput;
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
    private getObservation(aiState?: PlayerState, opponentStates?: PlayerState[]): Observation {
        if (!aiState) {
            aiState = this.physics.getPlayerState(this.aiPlayerId);
        }
        if (!opponentStates) {
            opponentStates = this.opponentIds.map(id => this.physics.getPlayerState(id));
        }

        this._cachedObservation.playerX = aiState.x;
        this._cachedObservation.playerY = aiState.y;
        this._cachedObservation.playerVelX = aiState.velX;
        this._cachedObservation.playerVelY = aiState.velY;
        this._cachedObservation.playerAngle = aiState.angle;
        this._cachedObservation.playerAngularVel = aiState.angularVel;
        this._cachedObservation.playerIsHeavy = aiState.isHeavy;
        this._cachedObservation.arenaHalfWidth = ARENA_HALF_WIDTH * SCALE;
        this._cachedObservation.arenaHalfHeight = ARENA_HALF_HEIGHT * SCALE;
        this._cachedObservation.tick = this.physics.getTickCount();

        for (let i = 0; i < opponentStates.length; i++) {
            const s = opponentStates[i];
            const op = this._cachedObservation.opponents[i];
            op.x = s.x;
            op.y = s.y;
            op.velX = s.velX;
            op.velY = s.velY;
            op.isHeavy = s.isHeavy;
            op.alive = s.alive;
        }

        return this._cachedObservation;
    }
}
