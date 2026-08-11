import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { PhysicsEngine, MapBodyDef } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

// Regression suite for #271: the bundled maps bonk_WeiRd_DeAth_BalL__80622.json
// and bonk_WDB__no_nothing__1232248.json authored their player spawns inside
// overlapping platforms, which exploded the Box2D port's solver to NaN from
// tick ~4–11. The solver corruption is gone, but the fail-safe guarantees the
// issue asked for must be pinned so they cannot regress:
//   1. every observation on these maps stays finite and the disc stays alive;
//   2. the two-overlapping-platform spawn still simulates finite for 60 ticks;
//   3. a disc whose position goes NaN dies via the OOB check instead of
//      persisting forever with alive=true (NaN > radius is false).
const NAN_MAPS = {
    weird: 'bonk_WeiRd_DeAth_BalL__80622.json',
    wdb: 'bonk_WDB__no_nothing__1232248.json',
};

const STEP_TICKS = 30;

describe('bundled maps never corrupt episodes with NaN physics (#271)', () => {
    it.each(Object.entries(NAN_MAPS))('%s: every observation stays finite and the AI disc stays alive', (_label, file) => {
        const env = new BonkEnvironment({
            mapPath: path.join(process.cwd(), 'maps', file),
            seed: 12345,
            numOpponents: 1,
            maxTicks: 1000,
            randomOpponent: false,
        });
        try {
            env.reset(12345);
            let firstObs: { playerX: number; playerY: number } | null = null;
            let lastObs: { playerX: number; playerY: number } | null = null;
            for (let t = 1; t <= STEP_TICKS; t++) {
                const r = env.step(0);
                const o = r.observation;
                expect(Number.isFinite(o.playerX)).toBe(true);
                expect(Number.isFinite(o.playerY)).toBe(true);
                expect(Number.isFinite(o.playerVelX)).toBe(true);
                expect(Number.isFinite(o.playerVelY)).toBe(true);
                expect(Number.isFinite(o.playerAngle)).toBe(true);
                for (const opp of o.opponents) {
                    expect(Number.isFinite(opp.x)).toBe(true);
                    expect(Number.isFinite(opp.y)).toBe(true);
                    expect(Number.isFinite(opp.velX)).toBe(true);
                    expect(Number.isFinite(opp.velY)).toBe(true);
                }
                // A corrupted (NaN) disc must not become immortal: the episode
                // must still be able to end by death, and the disc is expected
                // to remain alive through the pin window.
                expect(r.info.aiAlive).toBe(true);
                if (firstObs === null) firstObs = { playerX: o.playerX, playerY: o.playerY };
                lastObs = { playerX: o.playerX, playerY: o.playerY };
            }
            // The disc must be *moving* (gravity applies), not frozen at spawn.
            const moved =
                Math.abs(lastObs!.playerX - firstObs!.playerX) > 1 ||
                Math.abs(lastObs!.playerY - firstObs!.playerY) > 1;
            expect(moved).toBe(true);
        } finally {
            env.close();
        }
    });
});

describe('PhysicsEngine spawn-overlap regression (#271)', () => {
    it('a disc spawned over two overlapping static platforms stays finite for 60 ticks', () => {
        const engine = new PhysicsEngine();
        try {
            // Minimal trigger from the issue: the two overlapping static rects
            // under the WeiRd spawn point (-350,225,50,20) + (0,237.5,750,25)
            // used to explode the port's solver to NaN at tick ~4.
            const all = { g1: true, g2: true, g3: true, g4: true };
            const p1: MapBodyDef = {
                name: 'p1', type: 'rect', x: -350, y: 225,
                width: 50, height: 20, static: true, collides: all,
            };
            const p2: MapBodyDef = {
                name: 'p2', type: 'rect', x: 0, y: 237.5,
                width: 750, height: 25, static: true, collides: all,
            };
            engine.addBody(p1);
            engine.addBody(p2);
            engine.addPlayer(0, -315, 212.5); // spawn as authored by the WeiRd map

            for (let t = 1; t <= 60; t++) {
                engine.tick();
                const s = engine.getPlayerState(0);
                expect(Number.isFinite(s.x)).toBe(true);
                expect(Number.isFinite(s.y)).toBe(true);
                expect(Number.isFinite(s.velX)).toBe(true);
                expect(Number.isFinite(s.velY)).toBe(true);
            }
        } finally {
            safeDestroy(engine);
        }
    });
});

describe('NaN disc dies via the fail-safe OOB check (#271)', () => {
    it('a disc forced to a NaN position is eliminated with deathType 4, not immortal', () => {
        const engine = new PhysicsEngine();
        try {
            engine.addPlayer(0, 0, 0);
            // Corrupt the disc's transform to NaN, simulating a solver that
            // produced an invalid position (the issue's tick-4 explosion).
            const body = (engine as any).playerBodies.get(0);
            body.SetXForm({ x: NaN, y: NaN }, 0);

            engine.tick();

            const s = engine.getPlayerState(0);
            expect(s.alive).toBe(false);
            expect(s.deathType).toBe(4);
        } finally {
            safeDestroy(engine);
        }
    });

    it('a disc forced to an infinite position is eliminated with deathType 4', () => {
        const engine = new PhysicsEngine();
        try {
            engine.addPlayer(0, 0, 0);
            const body = (engine as any).playerBodies.get(0);
            body.SetXForm({ x: Infinity, y: Infinity }, 0);

            engine.tick();

            const s = engine.getPlayerState(0);
            expect(s.alive).toBe(false);
            expect(s.deathType).toBe(4);
        } finally {
            safeDestroy(engine);
        }
    });
});
