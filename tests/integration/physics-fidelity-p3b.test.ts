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
 *  - `re`: a disc that died respawns at its spawn point with cleared grapple
 *    and fresh velocity (`x=sx; y=sy; xv=sxv; yv=syv; ni=true; delete swing`,
 *    readable 8595-8606); cap-zone eliminations (death type 3) stay permanent
 *    (§alive rule, readable 8463). The respawn runs at the start of the tick
 *    AFTER the death (issue #339) so the death stays observable to the
 *    environment on the tick it occurred.
 */
import { describe, it, expect, vi } from 'vitest';
import { PhysicsEngine, MOVE_FORCE, MOVE_FORCE_FLIP_MULTIPLIER, SCALE } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { normalizeMap } from '../../src/core/map-adapter';
import type { MapDef } from '../../src/core/physics-engine';

const path = require('path');

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

function exportedMap(nc: boolean): Record<string, unknown> {
    return {
        metadata: { name: 'p3b-exported-map' },
        settings: { nc },
        physics: { ppm: 12 },
        spawns: [
            { x: 0, y: 0, blue: true },
            { x: 0, y: 0, red: true },
        ],
        bodies: [{
            bodyIndex: 0,
            fixtureIndex: 0,
            name: 'floor',
            type: 'rect',
            x: 0,
            y: 500,
            width: 1200,
            height: 30,
            static: true,
            collidesGroup1: true,
        }],
    };
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
    it.each([true, false])('normalized exported settings.nc:%s drives player collision masks', (nc) => {
        // normalizeMap is the choke point every map surface (mapData, mapPath,
        // bundled maps) converges on. Its settings.nc output must drive the
        // disc filters directly: nc drops every player category bit, nc:false
        // keeps them — direct mask coverage, not inferred via separation.
        const rawMap = exportedMap(nc);
        const normalized = normalizeMap(rawMap);
        expect(normalized.settings?.nc).toBe(nc);
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: normalized,
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            expect((env as any).config.noCollide).toBe(nc);
            for (const id of [0, 1]) {
                const shape = physics.playerBodies.get(id).GetShapeList();
                const mask = shape.GetFilterData().maskBits;
                if (nc) {
                    expect(mask & PLAYER_BITS).toBe(0);
                } else {
                    expect(mask & PLAYER_BITS).not.toBe(0);
                }
                // Map geometry (category 1) stays solid either way.
                expect(mask & 0x0001).not.toBe(0);
            }
        } finally {
            env.close();
        }
    });

    it('exported settings.nc:true applies to player fixtures', () => {
        const rawMap = exportedMap(true);
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: rawMap as any,
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            expect((env as any).config.noCollide).toBe(true);
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

    it('internal MapDef settings.nc also drops every player category bit', () => {
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

    it('legacy physics.nc on a hand-authored MapDef still enables no-collide (issue #329)', () => {
        // Before P3b, hand-authored MapDefs carried nc under `physics`; the
        // exporter emits it under `settings`, but the legacy key must keep
        // working so old authored maps do not silently flip back to colliding.
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: { ...TEST_MAP, physics: { nc: true } },
            randomOpponent: false,
        } as any);
        try {
            env.reset(7);
            const physics: any = (env as any).physics;
            expect((env as any).config.noCollide).toBe(true);
            expect(physics.noCollide).toBe(true);
            for (const id of [0, 1]) {
                const mask = physics.playerBodies.get(id).GetShapeList().GetFilterData().maskBits;
                expect(mask & PLAYER_BITS).toBe(0);
            }
        } finally {
            env.close();
        }
    });

    it('settings.nc (parsed) wins over a conflicting legacy physics.nc', () => {
        // The parsed settings section is the authoritative map source; a
        // conflicting legacy physics.nc on the same map must not override it.
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: { ...TEST_MAP, settings: { nc: false }, physics: { nc: true } },
            randomOpponent: false,
        } as any);
        try {
            expect((env as any).config.noCollide).toBe(false);
        } finally {
            env.close();
        }
    });

    it('nc discs pass through each other; explicit nc:false discs separate on contact', () => {
        const run = (mapData: MapDef | Record<string, unknown>): number => {
            const env = new BonkEnvironment({
                numOpponents: 1,
                seed: 7,
                mapData: mapData as MapDef,
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
        expect(run(exportedMap(true))).toBeLessThan(5);
        expect(run(exportedMap(false))).toBeGreaterThan(20);
    });

    it('explicit noCollide config overrides map settings in both directions', () => {
        const mapTrueConfigFalse = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: exportedMap(true) as any,
            noCollide: false,
            randomOpponent: false,
        });
        const mapFalseConfigTrue = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: exportedMap(false) as any,
            noCollide: true,
            randomOpponent: false,
        });
        try {
            expect((mapTrueConfigFalse as any).config.noCollide).toBe(false);
            expect((mapTrueConfigFalse as any).physics.noCollide).toBe(false);
            expect((mapFalseConfigTrue as any).config.noCollide).toBe(true);
            expect((mapFalseConfigTrue as any).physics.noCollide).toBe(true);
        } finally {
            mapTrueConfigFalse.close();
            mapFalseConfigTrue.close();
        }
    });

    it('the mapPath file-loading surface applies bundled settings.nc:false to player masks', () => {
        // Simple 1v1 ships settings.nc:false; the env's file-loading path
        // (mapPath → JSON parse → normalizeMap) must carry it through so the
        // disc masks keep every player category bit.
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapPath: path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json'),
            randomOpponent: false,
        });
        try {
            expect((env as any).config.mapData.settings?.nc).toBe(false);
            expect((env as any).config.noCollide).toBe(false);
            env.reset(7);
            const physics: any = (env as any).physics;
            for (const id of [0, 1]) {
                const mask = physics.playerBodies.get(id).GetShapeList().GetFilterData().maskBits;
                expect(mask & PLAYER_BITS).not.toBe(0);
                expect(mask & 0x0001).not.toBe(0);
            }
        } finally {
            env.close();
        }
    });

    it('maps without settings keep the default colliding behaviour (noCollide false)', () => {
        // Issue #329 default-parity: a map that never declares nc must not flip
        // into no-collide mode — the genesis/default colliding behaviour stays
        // intact for maps without a settings section.
        const env = new BonkEnvironment({
            numOpponents: 1,
            seed: 7,
            mapData: TEST_MAP,
            randomOpponent: false,
        });
        try {
            expect((env as any).config.noCollide).toBe(false);
            env.reset(7);
            const physics: any = (env as any).physics;
            for (const id of [0, 1]) {
                const mask = physics.playerBodies.get(id).GetShapeList().GetFilterData().maskBits;
                expect(mask & PLAYER_BITS).not.toBe(0);
                expect(mask & 0x0001).not.toBe(0);
            }
        } finally {
            env.close();
        }
    });
});

describe('P3b: re — respawning mode (readable 8595-8606)', () => {
    it('a disc that dies OOB stays dead for the death tick, then respawns at its spawn point next tick', () => {
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
            // Death tick (issue #339): the death must stay observable; the
            // respawn is deferred to the start of the following tick.
            const deathState = physics.getPlayerState(0);
            expect(deathState.alive).toBe(false);
            expect(deathState.deathType).toBe(4);
            physics.tick();
            const st = physics.getPlayerState(0);
            expect(st.alive).toBe(true);
            expect(st.deathType).toBe(0);
            // Respawned at the AI spawn (team_blue: −200, −100 map px). One
            // tick of gravity drift (no floor under the spawn) can pull the
            // disc slightly below it, so assert it is back at the spawn
            // region, not at the death spot.
            expect(Math.abs(st.x - -200)).toBeLessThan(1);
            expect(Math.abs(st.y - -100)).toBeLessThan(2);
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

    it('a lethal respawn point detaches instead of becoming immune to a persistent contact', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addBody({
                name: 'lethal_spawn',
                type: 'rect',
                x: 0,
                y: 0,
                width: 120,
                height: 120,
                static: true,
                isLethal: true,
            });
            engine.addPlayer(0, 0, 0);

            engine.tick();
            // Death tick: the lethal death stays observable and the respawn
            // is queued (deferred, #339); the body is kept so the respawn
            // pass on the following tick can validate the lethal spawn point.
            expect(engine.getPlayerState(0).deathType).toBe(1);
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.isPendingRespawn(0)).toBe(true);

            engine.tick();
            // The deferred respawn pass detects the lethal spawn point and
            // detaches instead of restoring a disc immune to the fixture.
            expect(engine.isPendingRespawn(0)).toBe(false);
            expect((engine as any).playerBodies.has(0)).toBe(false);

            // The detached player must stay dead; a naive Persist-only fix
            // would otherwise create an unbounded death/respawn loop here.
            for (let i = 0; i < 30; i++) engine.tick();
            expect(engine.getPlayerState(0).deathType).toBe(1);
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect((engine as any).playerBodies.has(0)).toBe(false);
        } finally {
            engine.destroy();
        }
    });

    it('a lethal-contact death respawns to a valid spawn point and stays alive', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            engine.addBody({
                name: 'lethal_elsewhere',
                type: 'rect',
                x: 100,
                y: 0,
                width: 120,
                height: 120,
                static: true,
                isLethal: true,
            });
            engine.addPlayer(0, 0, 0);
            // Kill the disc by lethal contact (death type 1), not OOB: the
            // spawn point (0,0) is valid and outside the fixture, so `re`
            // must respawn it there. SetXForm takes WORLD units (map px /
            // SCALE): the fixture spans world x ∈ [1.33, 5.33], so teleport
            // the disc inside it rather than 100 world units out (past the
            // ~28.3-unit OOB circle), which would die OOB instead.
            (engine as any).playerBodies.get(0).SetXForm(new (require('box2d').b2Vec2)(100 / SCALE, 0), 0);

            engine.tick();
            // Death tick (issue #339): the lethal death must stay observable;
            // the respawn is deferred to the start of the following tick.
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(1);
            const deaths = engine.getDeathEvents();
            expect(deaths).toHaveLength(1);
            expect(deaths[0].playerId).toBe(0);
            expect(deaths[0].deathType).toBe(1);
            expect(deaths[0].state.alive).toBe(false);
            expect(engine.isPendingRespawn(0)).toBe(true);

            engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(true);
            expect(engine.getPlayerState(0).deathType).toBe(0);
            // One tick of gravity drift (no floor under the spawn) can pull
            // the disc slightly below it, so assert it is back at the spawn
            // region (0, 0), not at the death spot.
            expect(Math.abs(engine.getPlayerState(0).x)).toBeLessThan(1);
            expect(Math.abs(engine.getPlayerState(0).y)).toBeLessThan(2);
            expect((engine as any).playerBodies.has(0)).toBe(true);

            // No death→respawn churn: the respawned disc stays alive.
            for (let i = 0; i < 30; i++) engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(true);
            expect((engine as any).playerBodies.has(0)).toBe(true);
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

            // Type 4 remains respawnable even though the cap completed: the
            // disc stays dead on the death tick (queued for its deferred
            // respawn, #339) so the environment observes the death, then
            // returns to spawn on the following tick.
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(4);
            expect(engine.isPendingRespawn(0)).toBe(true);
            // The dying-step view keeps the pre-respawn snapshot so any
            // reader observes the death on the tick it happened.
            expect(engine.getVisiblePlayerState(0).alive).toBe(false);
            expect(engine.getVisiblePlayerState(0).deathType).toBe(4);

            engine.tick();
            expect(engine.getPlayerState(0).alive).toBe(true);
            expect(engine.getPlayerState(0).deathType).toBe(0);
            expect(engine.getPlayerState(0).x).toBeCloseTo(0, 4);
            expect(engine.isPendingRespawn(0)).toBe(false);
        } finally {
            engine.destroy();
        }
    });

    it('a respawn point whose disc overlaps a lethal fixture edge detaches (radius-aware, not center-only)', () => {
        const engine = new PhysicsEngine({ respawnEnabled: true });
        try {
            // Lethal rect spans x ∈ [-10, 10] map px; the disc radius is
            // ppm/SCALE = 0.4 world units = 12 map px. Spawning at x = 10.2
            // puts the disc CENTER just outside the fixture edge but the disc
            // circle still overlapping it — a center-only TestPoint check would
            // restore the disc there, and the persistent lethal contact would
            // not re-fire, leaving it immune to the fixture.
            engine.addBody({
                name: 'lethal_edge',
                type: 'rect',
                x: 0,
                y: 0,
                width: 20,
                height: 20,
                static: true,
                isLethal: true,
            });
            engine.addPlayer(0, 10.2, 0);

            engine.tick();
            // First tick: the overlapping disc dies by lethal contact (type 1)
            // and the respawn is queued (deferred, #339), so the death stays
            // observable before the spawn-point validation runs.
            expect(engine.getPlayerState(0).deathType).toBe(1);
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.isPendingRespawn(0)).toBe(true);

            engine.tick();
            // The deferred respawn pass tests the full disc circle against the
            // lethal fixture and detaches instead of restoring an immune disc.
            expect(engine.isPendingRespawn(0)).toBe(false);
            expect((engine as any).playerBodies.has(0)).toBe(false);

            // The detached player must stay dead; no death→respawn churn.
            for (let i = 0; i < 30; i++) engine.tick();
            expect(engine.getPlayerState(0).deathType).toBe(1);
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect((engine as any).playerBodies.has(0)).toBe(false);
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
