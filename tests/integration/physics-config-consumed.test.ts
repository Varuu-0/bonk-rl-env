/**
 * physics-config-consumed.test.ts — Issue #217 regression coverage.
 *
 * The documented physics.*, arena.* and player.* config keys were silent
 * no-ops. Each key is now wired config-loader -> BonkEnvironment ->
 * PhysicsEngine, so a value set in config.json / env vars / CLI changes the
 * simulation. These tests prove the configured value is actually used, per
 * wired key. Defaults are also pinned so the no-config behavior is unchanged.
 *
 * Every environment in this file loads TEST_MAP explicitly. The repo now
 * ships a default map file (mapexporter PR #264), so the original "default
 * map file is absent, env falls back to the built-in box map" premise no
 * longer holds: the shipped map's spawn rests inside the floor and its 11
 * moving platforms trip an infinite loop in this Box2D port's broadphase
 * when stepped with a small world AABB. TEST_MAP is two static walls whose
 * shape AABBs span exactly x ±515 / y ±300 map px — the y extent comes from
 * the walls' 600 px height — the same extents the box map produced — so the
 * documented arena numbers hold:
 * arenaHalfWidth/Height = maxExtentPx + boundsMargin * scale:
 *   515 + 5*30 = 665 / 300 + 5*30 = 450 (defaults),
 *   515 / 300 (margin 0), 515 + 5*60 = 815 / 300 + 5*60 = 600 (scale 60).
 * Velocity deltas are sampled over a single tick (v2 - v1), which keeps
 * every measurement inside the 850-px death circle and away from the walls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { BonkEnv } from '../../src/env/bonk-env';
import { WorkerPool } from '../../src/core/worker-pool';
import { resetConfig } from '../../src/config/config-loader';
import { normalizeMap } from '../../src/core/map-adapter';
import type { MapDef } from '../../src/core/physics-engine';

/** Deterministic static-wall arena (x ±515 / y ±300 map px, no floor). */
const TEST_MAP: MapDef = {
    name: 'config-consumed-test-map',
    spawnPoints: {
        team_blue: { x: -200, y: -100 },
        team_red: { x: 200, y: -100 },
    },
    bodies: [
        { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
        { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
    ],
};

const EXPORTED_BOUNDS_MAP = {
    metadata: { name: 'exported-bounds-test' },
    physics: { ppm: 12, boundsWidth: 1000, boundsHeight: 800 },
    spawns: [
        { x: -100, y: -50, blue: true },
        { x: 100, y: -50, red: true },
    ],
    bodies: [
        { bodyIndex: 0, fixtureIndex: 0, name: 'floor', type: 'rect', x: 0, y: 200, width: 900, height: 20, static: true },
    ],
};

/** Free-fall vertical acceleration, in observation px/s per tick (g * dt * scale). */
function measureFallAccel(physics: Record<string, number> = {}): number {
    const env = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP, physics });
    try {
        env.reset(1);
        env.step(0);
        const v1 = env.step(0).observation.playerVelY;
        const v2 = env.step(0).observation.playerVelY;
        return v2 - v1;
    } finally {
        env.close();
    }
}

/** Horizontal thrust acceleration, in observation px/s per tick, for `action`. */
function measureThrustAccel(player: Record<string, number>, action: number): number {
    const env = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP, player });
    try {
        env.reset(1);
        env.step(0);
        const v1 = env.step(action).observation.playerVelX;
        const v2 = env.step(action).observation.playerVelX;
        return v2 - v1;
    } finally {
        env.close();
    }
}

/** Observation arena bounds for a given tuning config. */
function arenaBounds(cfg: Record<string, any>): { w: number; h: number } {
    const env = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP, ...cfg });
    try {
        env.reset(1);
        const o = env.step(0).observation;
        return { w: o.arenaHalfWidth, h: o.arenaHalfHeight };
    } finally {
        env.close();
    }
}

describe('physics/arena/player config is consumed by the engine (#217)', () => {
    it('defaults are unchanged: gravity 20, thrust 30, arena 665x450 (scale 30, margin 5)', () => {
        expect(measureFallAccel()).toBeCloseTo(20, 6);
        expect(measureThrustAccel({}, 2)).toBeCloseTo(30, 6);
        const bounds = arenaBounds({});
        expect(bounds.w).toBeCloseTo(665, 6);
        expect(bounds.h).toBeCloseTo(450, 6);
    });

    it('physics.gravityY changes the fall acceleration', () => {
        // Per-tick Δv = g * dt * scale, so gravityY 5 gives 5 (one quarter of 20).
        expect(measureFallAccel({ gravityY: 5 })).toBeCloseTo(5, 6);
        expect(measureFallAccel({ gravityY: 10 })).toBeCloseTo(10, 6);
        expect(measureFallAccel({ gravityY: 5 })).toBeCloseTo(measureFallAccel({}) / 4, 6);
    });

    it('physics.gravityX produces horizontal drift', () => {
        const env = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP, physics: { gravityX: 5 } });
        try {
            env.reset(1);
            env.step(0);
            const v1 = env.step(0).observation.playerVelX;
            const v2 = env.step(0).observation.playerVelX;
            const accel = v2 - v1;
            expect(accel).toBeCloseTo(5, 6);
            expect(accel).not.toBeCloseTo(0, 1);
        } finally {
            env.close();
        }
    });

    it('player.moveForce changes the applied thrust', () => {
        expect(measureThrustAccel({ moveForce: 30 }, 2)).toBeCloseTo(30, 6);
        expect(measureThrustAccel({ moveForce: 60 }, 2)).toBeCloseTo(60, 6);
        expect(measureThrustAccel({ moveForce: 60 }, 2)).toBeCloseTo(2 * measureThrustAccel({ moveForce: 30 }, 2), 6);
    });

    it('player.heavyMassMultiplier changes the heavy thrust damp', () => {
        // action 18 = right (bit 1) + heavy (bit 4): thrust × multiplier.
        expect(measureThrustAccel({ heavyMassMultiplier: 0.7 }, 18)).toBeCloseTo(21, 6);
        expect(measureThrustAccel({ heavyMassMultiplier: 0.35 }, 18)).toBeCloseTo(10.5, 6);
        expect(measureThrustAccel({ heavyMassMultiplier: 0.35 }, 18)).toBeCloseTo(
            measureThrustAccel({ heavyMassMultiplier: 0.7 }, 18) / 2, 6,
        );
    });

    it('physics.ticksPerSecond halves the per-tick fall acceleration at 60 tps', () => {
        // Per-tick Δv = g * (1/tps) * scale: at 60 tps each tick advances half
        // the time of 30 tps, so the per-tick velocity change halves.
        expect(measureFallAccel({ ticksPerSecond: 60 })).toBeCloseTo(10, 6);
        expect(measureFallAccel({ ticksPerSecond: 60 })).toBeCloseTo(measureFallAccel({}) / 2, 6);
    });

    it('physics.scale rescales arena observation bounds', () => {
        // Observation px = maxExtentPx + margin*scale -> 515 + 5*60 = 815,
        // 300 + 5*60 = 600 (vs 665/450 at scale 30).
        const s60 = arenaBounds({ physics: { scale: 60 } });
        expect(s60.w).toBeCloseTo(815, 6);
        expect(s60.h).toBeCloseTo(600, 6);
        const s30 = arenaBounds({});
        expect(s60.w - s30.w).toBeCloseTo(150, 6);
        expect(s60.h - s30.h).toBeCloseTo(150, 6);
    });

    it('arena.boundsMargin changes the observation arena bounds', () => {
        // Zero margin removes the 5 m margin from both extents: 515/300.
        const m0 = arenaBounds({ arena: { boundsMargin: 0 } });
        expect(m0.w).toBeCloseTo(515, 6);
        expect(m0.h).toBeCloseTo(300, 6);
        const def = arenaBounds({});
        expect(def.w - m0.w).toBeCloseTo(5 * 30, 6);
        expect(def.h - m0.h).toBeCloseTo(5 * 30, 6);
    });

    it('converts exported map-pixel bounds once before reporting observations (#320)', () => {
        const map = normalizeMap(EXPORTED_BOUNDS_MAP);
        expect(map.physics?.bounds).toEqual({ width: 1000, height: 800 });

        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            maxTicks: 10,
            mapData: EXPORTED_BOUNDS_MAP as any,
        });
        try {
            // The constructor performs an initial reset, exercising the same
            // path as the first step before an explicit caller reset.
            const firstStep = env.step(0).observation;
            // Exact equality: the map-px half bounds must round-trip without
            // 1-ulp drift (500.00000000000006) for exact-equality consumers.
            expect(firstStep.arenaHalfWidth).toBe(500);
            expect(firstStep.arenaHalfHeight).toBe(400);

            const fast = env.getObservationFast();
            expect(fast[13]).toBe(500);
            expect(fast[14]).toBe(400);

            const reset = env.reset(1);
            expect(reset.arenaHalfWidth).toBe(500);
            expect(reset.arenaHalfHeight).toBe(400);
        } finally {
            env.close();
        }
    });

    it('keeps exported map-pixel bounds stable when physics.scale changes (#320)', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: EXPORTED_BOUNDS_MAP as any,
            physics: { scale: 60 },
        });
        try {
            const observation = env.reset(1);
            expect(observation.arenaHalfWidth).toBe(500);
            expect(observation.arenaHalfHeight).toBe(400);
        } finally {
            env.close();
        }
    });

    it('arena.defaultHalfWidth/Height set the fallback bounds for bodyless maps', () => {
        const emptyMap: MapDef = {
            name: 'empty',
            spawnPoints: { team_blue: { x: 0, y: -100 }, team_red: { x: 0, y: 100 } },
            bodies: [],
        };
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: emptyMap,
            arena: { defaultHalfWidth: 40, defaultHalfHeight: 30 },
        });
        try {
            env.reset(1);
            expect(env.step(0).observation.arenaHalfWidth).toBeCloseTo(40 * 30, 6);
            expect(env.step(0).observation.arenaHalfHeight).toBeCloseTo(30 * 30, 6);
        } finally {
            env.close();
        }
    });

    it('physics.enableSleeping/worldAabbExtent/solverIterations reach the engine', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: TEST_MAP,
            physics: { enableSleeping: false, worldAabbExtent: 250, solverIterations: 12 },
        });
        const eng: any = (env as any).physics;
        try {
            // World construction consumed the settings.
            expect(eng.world.m_allowSleep).toBe(false);
            expect(eng.world.m_broadPhase.m_worldAABB.upperBound.y).toBe(250);
            expect(eng.world.m_broadPhase.m_worldAABB.lowerBound.y).toBe(-250);

            // Every physics tick forwards the configured solver iterations.
            env.reset(1);
            const stepSpy = vi.spyOn(eng.world, 'Step');
            env.step(0);
            expect(stepSpy).toHaveBeenCalledWith(expect.closeTo(1 / 30, 12), 12, 6);
            stepSpy.mockRestore();
        } finally {
            env.close();
        }
    });

    it('physics world-construction settings survive the fresh world on reset', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: TEST_MAP,
            physics: { gravityX: 3, gravityY: 7, enableSleeping: false, worldAabbExtent: 250 },
        });
        const eng: any = (env as any).physics;
        try {
            const previousWorld = eng.world;
            env.reset(2);

            // reset() must rebuild from the #217-resolved tuning, rather than
            // silently returning the replacement world to native defaults.
            expect(eng.world).not.toBe(previousWorld);
            expect(eng.world.m_gravity.x).toBe(3);
            expect(eng.world.m_gravity.y).toBe(7);
            expect(eng.world.m_allowSleep).toBe(false);
            expect(eng.world.m_broadPhase.m_worldAABB.upperBound.y).toBe(250);
            expect(eng.world.m_broadPhase.m_worldAABB.lowerBound.y).toBe(-250);
        } finally {
            env.close();
        }
    });

    it('a bare engine accepts the tuning options and applies them', () => {
        const engine = new PhysicsEngine({
            ticksPerSecond: 60,
            velocityIterations: 12,
            scale: 60,
            gravityX: 1,
            gravityY: 5,
            enableSleeping: false,
            worldAabbExtent: 250,
            arenaHalfWidth: 40,
            arenaHalfHeight: 30,
            arenaBoundsMargin: 0,
            moveForce: 77,
            heavyForceMultiplier: 0.3,
        });
        const anyEng: any = engine;
        // World construction consumed every numeric/boolean option.
        expect(anyEng.tps).toBe(60);
        expect(anyEng.dt).toBeCloseTo(1 / 60, 12);
        expect(anyEng.velocityIterations).toBe(12);
        expect(anyEng.scale).toBe(60);
        expect(anyEng.gravityX).toBe(1);
        expect(anyEng.gravityY).toBe(5);
        expect(anyEng.enableSleeping).toBe(false);
        expect(anyEng.worldAabbExtent).toBe(250);
        expect(anyEng.arenaHalfWidth).toBe(40);
        expect(anyEng.arenaHalfHeight).toBe(30);
        expect(anyEng.arenaBoundsMargin).toBe(0);
        expect(anyEng.moveForce).toBe(77);
        expect(anyEng.heavyForceMultiplier).toBe(0.3);
        // The world itself was built from them.
        expect(anyEng.world.m_gravity.x).toBe(1);
        expect(anyEng.world.m_gravity.y).toBe(5);
        expect(anyEng.world.m_allowSleep).toBe(false);
        expect(anyEng.world.m_broadPhase.m_worldAABB.upperBound.y).toBe(250);
        // The resolved scale drives conversions (death circle stays 850 map px => 850/scale).
        expect(anyEng.oobRadiusSquared).toBeCloseTo(Math.pow(850 / 60, 2), 10);
        engine.destroy();
    });

    it('a bare engine falls back to sanity defaults for invalid options', () => {
        const engine = new PhysicsEngine({
            ticksPerSecond: 0,            // would make dt = Infinity
            velocityIterations: 0,
            scale: 0,                     // would make coordinates Infinity
            gravityX: Infinity,           // would NaN the simulation
            gravityY: Number.NaN,
            worldAabbExtent: -100,        // would invert the AABB
            arenaHalfWidth: -1,
            arenaBoundsMargin: -5,
            moveForce: 0,
            heavyForceMultiplier: -1,
        });
        const anyEng: any = engine;
        expect(anyEng.tps).toBe(30);
        expect(anyEng.dt).toBeCloseTo(1 / 30, 12);
        expect(anyEng.velocityIterations).toBe(2);
        expect(anyEng.scale).toBe(30);
        expect(anyEng.gravityX).toBe(0);
        expect(anyEng.gravityY).toBe(20);
        expect(anyEng.enableSleeping).toBe(true);
        expect(anyEng.worldAabbExtent).toBe(5000);
        expect(anyEng.arenaHalfWidth).toBe(25);
        expect(anyEng.arenaHalfHeight).toBe(20);
        expect(anyEng.arenaBoundsMargin).toBe(5);
        expect(anyEng.moveForce).toBe(30);
        expect(anyEng.heavyForceMultiplier).toBe(0.7);
        engine.destroy();
    });

    it('enableSleeping rejects string coercion, accepting only real booleans', () => {
        // String `'false'` is truthy; a naive `Boolean(value)` would turn it into
        // true and silently invert the sleep flag. Real booleans still win.
        const engines = [
            new PhysicsEngine({ enableSleeping: 'false' as any }),
            new PhysicsEngine({ enableSleeping: 'true' as any }),
            new PhysicsEngine({ enableSleeping: 0 as any }),
            new PhysicsEngine({ enableSleeping: false }),
            new PhysicsEngine({ enableSleeping: true }),
            new PhysicsEngine({}),
        ];
        try {
            // Non-boolean runtime values (string 'false'/'true', 0) and the
            // omitted default must all fall back to `true`, never to `false`:
            for (const idx of [0, 1, 2, 4, 5]) {
                const anyEng: any = engines[idx];
                expect(anyEng.enableSleeping).toBe(true);
                expect(anyEng.world.m_allowSleep).toBe(true);
            }
            // A real `false` boolean must still win over the default.
            expect((engines[3] as any).enableSleeping).toBe(false);
            expect((engines[3] as any).world.m_allowSleep).toBe(false);
        } finally {
            for (const eng of engines) eng.destroy();
        }
    });

    it('a tuning pass that breaks the #234 ascent invariant warns (positive gravity only)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const engines: PhysicsEngine[] = [];
        try {
            // Default pairing (30 / 0.7 / 20): pure-up and up+heavy both lift, so no warn.
            engines.push(new PhysicsEngine({}));
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockClear();

            // gravityY 25 < moveForce 30, but > 30 * 0.7 = 21: up+heavy can no longer lift.
            engines.push(new PhysicsEngine({ gravityY: 25 }));
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0][0])).toMatch(/ascent invariant/);

            // gravityY 35 >= moveForce 30: pure-up cannot lift either.
            warnSpy.mockClear();
            engines.push(new PhysicsEngine({ gravityY: 35 }));
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0][0])).toMatch(/pure 'up'/);

            // gravityY 25 does NOT warn when gravity is negative (upward): the
            // invariant only applies to downward gravity, which always aids ascent.
            warnSpy.mockClear();
            engines.push(new PhysicsEngine({ gravityY: -25 }));
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            for (const engine of engines) engine.destroy();
        }
    });

    it('maxTicks is tick-counted, not rescaled by ticksPerSecond (contract locked)', () => {
        // maxTicks and every native timer (a1a drain/recharge, last-hit 120,
        // cap-zone `(l ?? 3)*30`) are tick-counted: raising ticksPerSecond
        // changes the per-tick sim step, NOT the tick counters. This locks the
        // documented #217 contract so a future rescaling regression is caught.
        const env30 = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP });
        const env60 = new BonkEnvironment({ numOpponents: 0, seed: 1, mapData: TEST_MAP, physics: { ticksPerSecond: 60 } });
        try {
            expect((env30 as any).config.maxTicks).toBe(900);
            // 60 TPS must NOT silently double the episode length to 1800.
            expect((env60 as any).config.maxTicks).toBe(900);
        } finally {
            env30.close();
            env60.close();
        }
    });
});

describe('physics/arena/player config reaches workers through the pool (#217)', () => {
    const envs: BonkEnv[] = [];
    let savedSolverIterations: string | undefined;
    let savedArgv: string[];

    beforeEach(() => {
        savedSolverIterations = process.env.SOLVER_ITERATIONS;
        savedArgv = [...process.argv];
        delete (process.env as any).SOLVER_ITERATIONS;
        process.argv = ['node', 'script.js'];
        resetConfig();
    });

    afterEach(async () => {
        for (const env of envs.splice(0)) {
            try { await env.stop(); } catch { /* ignore */ }
        }
        if (savedSolverIterations === undefined) {
            delete (process.env as any).SOLVER_ITERATIONS;
        } else {
            process.env.SOLVER_ITERATIONS = savedSolverIterations;
        }
        process.argv = savedArgv;
        resetConfig();
    });

    it('arena.boundsMargin set in the per-env config changes worker observations', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, arena: { boundsMargin: 0 } },
        });
        envs.push(env);
        await env.start();

        const obs = (await env.reset([1])) as any[];
        expect(obs[0].arenaHalfWidth).toBeCloseTo(515, 0);
        expect(obs[0].arenaHalfHeight).toBeCloseTo(300, 0);
    });

    it('physics.gravityY set in the per-env config changes worker fall acceleration', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, physics: { gravityY: 5 }, numOpponents: 0 },
        });
        envs.push(env);
        await env.start();

        const obs0 = (await env.reset([1])) as any[];
        expect(obs0[0].playerVelY).toBeCloseTo(0, 6);
        await env.step([0]);
        const v1 = ((await env.step([0])) as any[])[0].observation.playerVelY;
        const v2 = ((await env.step([0])) as any[])[0].observation.playerVelY;
        expect(v2 - v1).toBeCloseTo(5, 1);
    });

    it('physics.scale set in the per-env config changes worker arena observations', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, physics: { scale: 60 } },
        });
        envs.push(env);
        await env.start();

        const obs = (await env.reset([1])) as any[];
        expect(obs[0].arenaHalfWidth).toBeCloseTo(815, 0);
        expect(obs[0].arenaHalfHeight).toBeCloseTo(600, 0);
    });

    it('physics.ticksPerSecond set in the per-env config halves worker fall acceleration', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, physics: { ticksPerSecond: 60 }, numOpponents: 0 },
        });
        envs.push(env);
        await env.start();

        await env.reset([1]);
        await env.step([0]);
        const v1 = ((await env.step([0])) as any[])[0].observation.playerVelY;
        const v2 = ((await env.step([0])) as any[])[0].observation.playerVelY;
        // Per-tick Δv = g * dt * scale with dt = 1/60: 10, half of the 30-TPS 20.
        expect(v2 - v1).toBeCloseTo(10, 1);
    });

    it('BonkEnv.start forwards a pq=2 map without the loader solver default (#325)', { timeout: 30000 }, async () => {
        const captured: any[] = [];
        const initSpy = vi.spyOn(WorkerPool.prototype, 'init').mockImplementation(async (_count, config) => {
            captured.push(config);
        });
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: {
                mapData: { ...TEST_MAP, settings: { pq: 2 } },
                numOpponents: 0,
            },
        });
        envs.push(env);

        try {
            await env.start();
            expect(captured).toHaveLength(1);
            expect(captured[0].mapData.settings.pq).toBe(2);
            expect(captured[0].physics.solverIterations).toBeUndefined();

            const workerEnv = new BonkEnvironment(captured[0]);
            try {
                expect((workerEnv as any).physics.velocityIterations).toBe(15);
                expect((workerEnv as any).physics.positionIterations).toBe(15);
            } finally {
                workerEnv.close();
            }
        } finally {
            initSpy.mockRestore();
        }
    });

    it('BonkEnv.start preserves an explicit solverIterations override over pq=2 (#325)', { timeout: 30000 }, async () => {
        const captured: any[] = [];
        const initSpy = vi.spyOn(WorkerPool.prototype, 'init').mockImplementation(async (_count, config) => {
            captured.push(config);
        });
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: {
                mapData: { ...TEST_MAP, settings: { pq: 2 } },
                numOpponents: 0,
                physics: { solverIterations: 12 },
            },
        });
        envs.push(env);

        try {
            await env.start();
            expect(captured[0].physics.solverIterations).toBe(12);

            const workerEnv = new BonkEnvironment(captured[0]);
            try {
                expect((workerEnv as any).physics.velocityIterations).toBe(12);
                expect((workerEnv as any).physics.positionIterations).toBe(15);
            } finally {
                workerEnv.close();
            }
        } finally {
            initSpy.mockRestore();
        }
    });

    it('player.moveForce set in the per-env config changes worker thrust', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, player: { moveForce: 60 }, numOpponents: 0 },
        });
        envs.push(env);
        await env.start();

        await env.reset([1]);
        await env.step([2]); // action 2 = right
        const v1 = ((await env.step([2])) as any[])[0].observation.playerVelX;
        const v2 = ((await env.step([2])) as any[])[0].observation.playerVelX;
        expect(v2 - v1).toBeCloseTo(60, 1);
    });

    it('player.heavyMassMultiplier set in the per-env config changes worker heavy thrust', { timeout: 30000 }, async () => {
        const env = new BonkEnv({
            numEnvs: 1,
            useSharedMemory: false,
            config: { mapData: TEST_MAP, player: { heavyMassMultiplier: 0.35 }, numOpponents: 0 },
        });
        envs.push(env);
        await env.start();

        await env.reset([1]);
        await env.step([18]); // action 18 = right + heavy
        const v1 = ((await env.step([18])) as any[])[0].observation.playerVelX;
        const v2 = ((await env.step([18])) as any[])[0].observation.playerVelX;
        expect(v2 - v1).toBeCloseTo(10.5, 1);
    });
});
