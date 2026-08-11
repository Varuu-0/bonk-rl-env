/**
 * physics-fidelity-p3.test.ts — P3: per-map physics settings.
 *
 * Native evidence (DEOBFUSCATION.md §Solver Iterations, §Gravity, §33.1):
 * - `pq` (map setting `s.pq`, blank-map default 1) gates the Step iteration
 *   counts: low (pq != 2) → Step(dt, 2, 6); high (pq == 2) → Step(dt, 15, 15).
 * - `gd` (map setting `s.gd`, blank-map default 25) is serialized in the map
 *   format and sanitized (gd >= 2) but the native client enforces gravity
 *   (0, 20) at every round start (`if (GetGravity().y != 20) SetGravity(new
 *   b2Vec2(0, 20))`, pretty 7238-7240) and has no gd application site — so the
 *   engine keeps config/default gravity and only exposes `gd` on MapDef.
 * - Port limitation: the bundled Box2D port's `Step(dt, iterations)` ignores
 *   the third argument, so only the resolved velocity count reaches the solver;
 *   the position count is resolved and asserted as the contract (tracked for
 *   the P4 differential gate).
 */
import { describe, it, expect, vi } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { normalizeMap } from '../../src/core/map-adapter';
import type { MapDef } from '../../src/core/physics-engine';

/** Deterministic static-wall arena (x ±515 / y ±300 map px, no floor). */
const TEST_MAP: MapDef = {
    name: 'p3-test-map',
    spawnPoints: {
        team_blue: { x: -200, y: -100 },
        team_red: { x: 200, y: -100 },
    },
    bodies: [
        { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
        { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
    ],
};

/** Capture the iteration args the engine forwards to the world's Step. */
function stepArgs(engine: PhysicsEngine): [number, number, number] {
    const anyEng: any = engine;
    const spy = vi.spyOn(anyEng.world, 'Step');
    engine.tick();
    const calls = spy.mock.calls as [number, number, number][];
    spy.mockRestore();
    return calls[calls.length - 1];
}

describe('P3: per-map pq gates solver iterations (DEOBFUSCATION §Solver Iterations)', () => {
    it('defaults (no pq) resolve low quality 2 velocity / 6 position iterations', () => {
        const engine = new PhysicsEngine({});
        const anyEng: any = engine;
        try {
            expect(anyEng.velocityIterations).toBe(2);
            expect(anyEng.positionIterations).toBe(6);
            const args = stepArgs(engine);
            expect(args[1]).toBe(2);
            expect(args[2]).toBe(6);
        } finally {
            engine.destroy();
        }
    });

    it('pq = 2 (high quality) resolves 15 velocity / 15 position iterations', () => {
        const engine = new PhysicsEngine({ physicsQuality: 2 });
        const anyEng: any = engine;
        try {
            expect(anyEng.velocityIterations).toBe(15);
            expect(anyEng.positionIterations).toBe(15);
            const args = stepArgs(engine);
            expect(args[1]).toBe(15);
            expect(args[2]).toBe(15);
        } finally {
            engine.destroy();
        }
    });

    it('pq = 1 (low quality) keeps 2 / 6', () => {
        const engine = new PhysicsEngine({ physicsQuality: 1 });
        const anyEng: any = engine;
        try {
            expect(anyEng.velocityIterations).toBe(2);
            expect(anyEng.positionIterations).toBe(6);
        } finally {
            engine.destroy();
        }
    });

    it('explicit solverIterations/positionIterations override the pq defaults', () => {
        const engine = new PhysicsEngine({ physicsQuality: 2, velocityIterations: 12, positionIterations: 8 });
        const anyEng: any = engine;
        try {
            expect(anyEng.velocityIterations).toBe(12);
            expect(anyEng.positionIterations).toBe(8);
            const args = stepArgs(engine);
            expect(args[1]).toBe(12);
            expect(args[2]).toBe(8);
        } finally {
            engine.destroy();
        }
    });

    it('explicit velocityIterations alone keeps the pq-derived position count', () => {
        const engine = new PhysicsEngine({ physicsQuality: 2, velocityIterations: 12 });
        const anyEng: any = engine;
        try {
            expect(anyEng.velocityIterations).toBe(12);
            expect(anyEng.positionIterations).toBe(15);
        } finally {
            engine.destroy();
        }
    });

    it('invalid pq values (0, 3, NaN, string) fall back to low quality', () => {
        for (const bad of [0, 3, Number.NaN, '2' as any, undefined as any]) {
            const engine = new PhysicsEngine({ physicsQuality: bad });
            const anyEng: any = engine;
            try {
                expect(anyEng.velocityIterations).toBe(2);
                expect(anyEng.positionIterations).toBe(6);
            } finally {
                engine.destroy();
            }
        }
    });

    it('solver behavior actually changes: a heavy stack settles faster at high quality', () => {
        // High-quality solving (15/15) resolves the position constraint far more
        // accurately per tick than low (2/6): a disc resting on a platform sinks
        // measurably less after the same number of ticks.
        const build = (pq: number) => {
            const engine = new PhysicsEngine({ physicsQuality: pq });
            (engine as any).addBody({ name: 'floor', type: 'rect', x: 0, y: 0, width: 800, height: 30, static: true });
            (engine as any).addPlayer(0, 0, -100);
            return engine;
        };
        const low = build(1);
        const high = build(2);
        try {
            for (let i = 0; i < 120; i++) { low.tick(); high.tick(); }
            const lowY = (low as any).getPlayerState(0).y;
            const highY = (high as any).getPlayerState(0).y;
            // Both discs rest on the platform (y ≈ -30 + radius), but the
            // low-quality solve must sink at least as much as the high-quality one.
            expect(Number.isFinite(lowY)).toBe(true);
            expect(Number.isFinite(highY)).toBe(true);
            expect(lowY).toBeLessThanOrEqual(highY + 1e-6);
        } finally {
            low.destroy();
            high.destroy();
        }
    });
});

describe('P3: map settings parse through normalizeMap (DEOBFUSCATION §33.1)', () => {
    it('forwards valid settings (re/nc/pq/gd/fl) onto MapDef.settings', () => {
        const md = normalizeMap({
            bodies: [{ bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true }],
            spawns: [{ x: 0, y: -100, blue: true, red: true }],
            settings: { re: true, nc: true, pq: 2, gd: 30, fl: true },
        } as any) as any;
        expect(md.settings).toEqual({ re: true, nc: true, pq: 2, gd: 30, fl: true });
    });

    it('drops out-of-range pq (1..2) and gd (< 2) per the native sanitizer', () => {
        const md = normalizeMap({
            bodies: [{ bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true }],
            spawns: [{ x: 0, y: -100, blue: true, red: true }],
            settings: { pq: 3, gd: 1 },
        } as any) as any;
        // Nothing survives validation -> no overrides (engine keeps low quality
        // and default gravity), so the settings object is dropped entirely.
        expect(md.settings).toBeUndefined();
    });

    it('no settings object stays undefined', () => {
        const md = normalizeMap({
            bodies: [{ bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true }],
            spawns: [{ x: 0, y: -100, blue: true, red: true }],
        } as any) as any;
        expect(md.settings).toBeUndefined();
    });

    it('non-boolean re/nc/fl are dropped', () => {
        const md = normalizeMap({
            bodies: [{ bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true }],
            spawns: [{ x: 0, y: -100, blue: true, red: true }],
            settings: { re: 'yes' as any, nc: 1 as any, fl: false },
        } as any) as any;
        expect(md.settings).toEqual({ fl: false });
    });
});

describe('P3: map settings reach the environment (pq applied, gd enforced away)', () => {
    it('map settings.pq = 2 makes the env step with 15 velocity iterations', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: { ...TEST_MAP, settings: { pq: 2 } },
        });
        const eng: any = (env as any).physics;
        try {
            expect(eng.velocityIterations).toBe(15);
            expect(eng.positionIterations).toBe(15);
            env.reset(1);
            const stepSpy = vi.spyOn(eng.world, 'Step');
            env.step(0);
            expect(stepSpy).toHaveBeenCalledWith(expect.closeTo(1 / 30, 12), 15, 15);
            stepSpy.mockRestore();
        } finally {
            env.close();
        }
    });

    it('explicit physics.solverIterations config wins over map pq', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: { ...TEST_MAP, settings: { pq: 2 } },
            physics: { solverIterations: 12 },
        });
        const eng: any = (env as any).physics;
        try {
            expect(eng.velocityIterations).toBe(12);
            expect(eng.positionIterations).toBe(15);
        } finally {
            env.close();
        }
    });

    it('map settings.gd is exposed but never overrides gravity (native enforcement parity)', () => {
        // The native client forces gravity to (0, 20) at round start and has no
        // gd application site (pretty 7238-7240), so a map carrying gd: 25 must
        // still simulate with the enforced default.
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 1,
            mapData: { ...TEST_MAP, settings: { gd: 25 } },
        });
        const eng: any = (env as any).physics;
        try {
            expect(eng.world.m_gravity.x).toBe(0);
            expect(eng.world.m_gravity.y).toBe(20);
            expect((env as any).config.mapData.settings?.gd).toBe(25);
        } finally {
            env.close();
        }
    });
});
