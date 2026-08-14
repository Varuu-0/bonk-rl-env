/**
 * physics-fidelity-p3b.test.ts — P3b: runtime gating of the remaining map
 * settings `fl` (flipped force), `nc` (no collision), `re` (respawning).
 *
 * Native evidence (DEOBFUSCATION.md §11 / §Deep Dive Move Force, §Key
 * Collision Rules, readable 2026-07-29 artifact):
 *  - `fl`: the move-force base is 12 normally, 20 when `ms.fl` is true
 *    (`state.ms.fl ? 20 : 12`, §11 lines 720-730 / 935 / 4055). The port keeps
 *    its tuned base (MOVE_FORCE = 30, #234 ascent invariant) and applies the
 *    same 20/12 ratio (MOVE_FORCE_FLIP_MULTIPLIER) — proportions stay exact on
 *    any scale (P0 abstraction rule).
 *  - `nc`: all disc-disc contacts are disabled (`contact.SetEnabled(false)`
 *    when `physics.nc`, readable 1300-1303; §Key Collision Rules 5).
 *  - `re`: a disc that died respawns immediately at its spawn point with
 *    cleared grapple and fresh velocity (`x=sx; y=sy; xv=sxv; yv=syv;
 *    ni=true; delete swing`, readable 8595-8606); cap-zone eliminations
 *    (death type 3) stay permanent (§alive rule, readable 8463).
 */
import { describe, it, expect, vi } from 'vitest';
import { PhysicsEngine, MOVE_FORCE, MOVE_FORCE_FLIP_MULTIPLIER } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';

/** Deterministic static-wall arena (x ±515 / y ±300 map px, no floor). */
const TEST_MAP: MapDef = {
    name: 'p3b-test-map',
    spawnPoints: {
        team_blue: { x: -200, y: -100 },
        team_red: { x: 200, y: -100 },
    },
    bodies: [
        { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
        { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
    ],
};

const PLAYER_BITS = 0x0002 | 0x0004 | 0x0008 | 0x0010;

function withSettings(settings: MapDef['settings']): MapDef {
    return { ...TEST_MAP, settings };
}

/** One left-input tick on a fresh single-player engine; returns |velX| (map px/s). */
function leftTickVelX(engine: PhysicsEngine): number {
    engine.addPlayer(0, 0, 0);
    engine.applyInput(0, { left: true, right: false, up: false, down: false, heavy: false, grapple: false });
    engine.tick();
    return Math.abs(engine.getPlayerState(0).velX);
}

describe('P3b: fl — flipped move-force base (DEOBFUSCATION §11)', () => {
    it('default (no fl) applies the tuned base MOVE_FORCE (mass-1 disc: Δv = F·dt)', () => {
        const engine = new PhysicsEngine({});
        try {
            // F = 30, m = 1, dt = 1/30 → Δv = 1 m/s = 30 map px/s.
            expect(leftTickVelX(engine)).toBeCloseTo(MOVE_FORCE, 4);
        } finally {
            engine.destroy();
        }
    });

    it('flipped mode applies the flipped base = base × 20/12 (native 12 → 20)', () => {
        const engine = new PhysicsEngine({ flipped: true });
        try {
            expect((engine as any).flippedMoveForce).toBeCloseTo(MOVE_FORCE * MOVE_FORCE_FLIP_MULTIPLIER, 9);
            // Δv = 50/30 m/s = 50 map px/s.
            expect(leftTickVelX(engine)).toBeCloseTo(MOVE_FORCE * MOVE_FORCE_FLIP_MULTIPLIER, 4);
        } finally {
            engine.destroy();
        }
    });

    it('explicit flippedMoveForce overrides the ratio default', () => {
        const engine = new PhysicsEngine({ flipped: true, flippedMoveForce: 60 });
        try {
            expect(leftTickVelX(engine)).toBeCloseTo(60, 4);
        } finally {
            engine.destroy();
        }
    });

    it('env forwards mapData.settings.fl to the engine', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 7,
            mapData: withSettings({ fl: true }),
            randomOpponent: false,
        } as any);
        try {
            expect((env as any).physics.flipped).toBe(true);
            env.reset(7);
            const physics: any = (env as any).physics;
            physics.applyInput(0, { left: true, right: false, up: false, down: false, heavy: false, grapple: false });
            physics.tick();
            expect(Math.abs(physics.getPlayerState(0).velX)).toBeCloseTo(MOVE_FORCE * MOVE_FORCE_FLIP_MULTIPLIER, 4);
        } finally {
            env.close();
        }
    });

    it('explicit env config flipped overrides the map setting (asymmetric with nc)', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 7,
            mapData: withSettings({ fl: false }),
            flipped: true,
            randomOpponent: false,
        } as any);
        try {
            expect((env as any).physics.flipped).toBe(true);
        } finally {
            env.close();
        }
    });

    it('setFlipped re-validates the #234 ascent invariant on the effective base', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // gravity 20 vs base 18: broken at construction.
            const engine = new PhysicsEngine({ gravityY: 20, moveForce: 18 });
            expect(warn).toHaveBeenCalled();
            warn.mockClear();
            // Flipped base = 18 × 20/12 = 30: pure-up (30 > 20) AND up+heavy
            // (30 × 0.7 = 21 > 20) both clear — flipping must not re-warn.
            engine.setFlipped(true);
            expect(warn).not.toHaveBeenCalled();
            // Un-flipping re-breaks the invariant and must warn again.
            engine.setFlipped(false);
            expect(warn).toHaveBeenCalled();
            engine.destroy();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('P3b: nc — no-collision mode (readable 1300-1303)', () => {
    it('env forwards mapData.settings.nc: player masks drop every disc bit', () => {
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: withSettings({ nc: true }),
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            expect(physics.noCollide).toBe(true);
            for (const id of [0, 1]) {
                const shape = physics.playerBodies.get(id).GetShapeList();
                const mask = shape.GetFilterData().maskBits;
                expect(mask & PLAYER_BITS).toBe(0);
                // Map geometry (category 1) stays solid.
                expect(mask & 0x0001).not.toBe(0);
            }
        } finally {
            env.close();
        }
    });

    it('nc discs pass through each other; default discs separate on contact', () => {
        const run = (nc: boolean): number => {
            const env = new BonkEnvironment({
                numOpponents: 1,
                seed: 7,
                mapData: withSettings(nc ? { nc: true } : {}),
                randomOpponent: false,
            } as any);
            try {
                env.reset(7);
                const physics: any = (env as any).physics;
                const b0 = physics.playerBodies.get(0);
                const b1 = physics.playerBodies.get(1);
                // Overlapping discs (radius 12 map px): contact must push them
                // apart without nc, and leave them overlapped with nc.
                b0.SetXForm(new (require('box2d').b2Vec2)(-0.05, 0), 0);
                b1.SetXForm(new (require('box2d').b2Vec2)(0.05, 0), 0);
                for (let t = 0; t < 15; t++) physics.tick();
                const p0 = physics.getPlayerState(0);
                const p1 = physics.getPlayerState(1);
                return Math.abs(p0.x - p1.x);
            } finally {
                env.close();
            }
        };
        // Overlapping discs: contact correction must push the control discs
        // to (or past) the touching distance — 2 × 12 px radius = 24 px —
        // while nc discs keep their initial ~3 px separation.
        expect(run(true)).toBeLessThan(5);
        expect(run(false)).toBeGreaterThan(20);
    });
});

describe('P3b: re — respawning mode (readable 8595-8606)', () => {
    it('a disc that dies OOB respawns at its spawn point, alive, next tick', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 7,
            mapData: withSettings({ re: true }),
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            expect(physics.respawnEnabled).toBe(true);
            // Teleport far beyond the 850/scale death circle (≈28.3 world units).
            physics.playerBodies.get(0).SetXForm(new (require('box2d').b2Vec2)(200, 0), 0);
            physics.tick();
            const st = physics.getPlayerState(0);
            expect(st.alive).toBe(true);
            expect(st.deathType).toBe(0);
            // Respawned at the AI spawn (team_blue: −200, −100 map px).
            expect(st.x).toBeCloseTo(-200, 4);
            expect(st.y).toBeCloseTo(-100, 4);
            // Grapple was cleared by the respawn (native `delete disc.swing`).
            expect(physics.hasGrappleJoint(0)).toBe(false);
        } finally {
            env.close();
        }
    });

    it('without re the same death stays dead (detached)', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 7,
            mapData: withSettings({}),
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            physics.playerBodies.get(0).SetXForm(new (require('box2d').b2Vec2)(200, 0), 0);
            physics.tick();
            expect(physics.getPlayerState(0).alive).toBe(false);
            expect(physics.getPlayerState(0).deathType).toBe(4);
        } finally {
            env.close();
        }
    });

    it('cap-zone eliminations (death type 3) stay permanent even with re', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addPlayer(0, 0, 0);
            const anyEng: any = engine;
            anyEng.playerAlive.set(0, false);
            anyEng.playerDeathType.set(0, 3);
            engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(3);
        } finally {
            engine.destroy();
        }
    });

    it('an OOB spawn point detaches instead of death→respawn churning every tick', () => {
        // Spawn far outside the 850/scale death circle: with re on, a naive
        // respawn would die again next tick forever. The fail-safe detaches.
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addPlayer(0, 1000, 0); // 1000 px >> 850 px OOB radius
            engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(4);
            // No live body left to respawn: the world churn ended after one tick.
            expect((engine as any).playerBodies.has(0)).toBe(false);
        } finally {
            engine.destroy();
        }
    });

    it('a non-finite spawn coordinate detaches too (NaN bypasses a plain > comparison)', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addPlayer(0, 0, 0);
            const anyEng: any = engine;
            // Corrupt the recorded spawn: `NaN > r²` is false, so only the
            // explicit non-finite guard can stop the death→respawn churn.
            anyEng.playerSpawnPoints.set(0, { x: NaN, y: 0 });
            anyEng.playerAlive.set(0, false);
            anyEng.playerDeathType.set(0, 4);
            engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect((engine as any).playerBodies.has(0)).toBe(false);
        } finally {
            engine.destroy();
        }
    });

    it('preserves an OOB death when timed cap completion lands on the same tick', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addPlayer(0, 0, 0);
            engine.setPlayerTeam(0, 'blue');
            engine.addPlayer(1, 100, 0);
            engine.setPlayerTeam(1, 'red');

            // Arrange the blue disc outside the death circle while a red-owned
            // timed zone is one countdown tick from eliminating blue.
            (engine as any).playerBodies.get(0).SetXForm(
                new (require('box2d').b2Vec2)(200, 0),
                0,
            );
            (engine as any).capZoneState.set(0, {
                ty: 1,
                p: 1,
                l: 1,
                i: 0,
                o: 1,
                ot: 'red',
                f: 1,
            });

            engine.tick();

            const deaths = engine.getDeathEvents();
            expect(deaths).toHaveLength(1);
            expect(deaths[0].playerId).toBe(0);
            expect(deaths[0].deathType).toBe(4);
            expect(deaths[0].state.alive).toBe(false);
            expect(engine.getTeamScored()).toBe('red');

            // Type 4 remains respawnable even though the cap completed, while
            // the capture event is still available to the environment.
            expect(engine.getPlayerState(0).alive).toBe(true);
            expect(engine.getPlayerState(0).deathType).toBe(0);
            expect(engine.getPlayerState(0).x).toBeCloseTo(0, 4);
            // The dying-step view keeps the pre-respawn snapshot so any
            // reader observes the death on the tick it happened.
            expect(engine.getVisiblePlayerState(0).alive).toBe(false);
            expect(engine.getVisiblePlayerState(0).deathType).toBe(4);
        } finally {
            engine.destroy();
        }
    });

    it('an instant-goal elimination stays terminal even when the victim is OOB', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addPlayer(0, 0, 0);
            engine.setPlayerTeam(0, 'blue');
            engine.addPlayer(1, 100, 0);
            engine.setPlayerTeam(1, 'red');

            // Red scores a round-ending instant goal while blue's disc sits
            // outside the death circle: the type-3 elimination must remain
            // terminal, so the OOB pass must not reclassify it into a
            // respawnable type-4 death.
            (engine as any).playerBodies.get(0).SetXForm(
                new (require('box2d').b2Vec2)(200, 0),
                0,
            );
            (engine as any).triggerInstantGoal(2);

            engine.tick();

            const deaths = engine.getDeathEvents();
            expect(deaths).toHaveLength(1);
            expect(deaths[0].playerId).toBe(0);
            expect(deaths[0].deathType).toBe(3);
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(3);
            expect(engine.getVisiblePlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(1).alive).toBe(true);
        } finally {
            engine.destroy();
        }
    });

    it('explicit env config respawnEnabled overrides the map setting', () => {
        const env = new BonkEnvironment({
            numOpponents: 0,
            seed: 7,
            mapData: withSettings({ re: false }),
            respawnEnabled: true,
            randomOpponent: false,
        } as any);
        try {
            expect((env as any).physics.respawnEnabled).toBe(true);
        } finally {
            env.close();
        }
    });
});
