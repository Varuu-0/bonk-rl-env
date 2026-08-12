import { describe, it, expect } from 'vitest';
import { PhysicsEngine, SCALE } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';
import { loadMap } from '../utils/map-loader';

/**
 * Regression tests for #276 — negative fixture friction corrupting the disc.
 *
 * Root cause: `addBody()` stored negative friction for `f_p` (fricPolarity)
 * surfaces and map-authored negative friction (the bundled maps contain
 * `friction: -1` fixtures). The Box2D port mixes contact friction as
 * `sqrt(f1 * f2)`, and this port's disc friction is positive
 * (`PLAYER_FRICTION = 0.001337`), so the very first contact with such a
 * fixture produced `sqrt(negative) = NaN`, poisoning the tangent impulse,
 * the disc position, and — because `NaN > threshold` is false — defeating
 * the OOB death check and leaving an immortal NaN disc for the episode.
 */

/** Step a single-disc engine `steps` times and require every state finite. */
function expectFiniteDisc(e: PhysicsEngine, steps: number): void {
    for (let t = 1; t <= steps; t++) {
        e.tick();
        const s = e.getPlayerState(0);
        expect(Number.isFinite(s.x), `t=${t}: x must be finite, got ${s.x}`).toBe(true);
        expect(Number.isFinite(s.y), `t=${t}: y must be finite, got ${s.y}`).toBe(true);
    }
}

describe('negative-friction regression (#276)', () => {
    it('keeps the disc finite on a f_p (fricPolarity) platform (friction 0.3)', () => {
        const e = new PhysicsEngine();
        try {
            e.addBody({
                name: 'polar', type: 'rect', x: 0, y: 120, width: 200, height: 20,
                static: true, friction: 0.3, fricPolarity: true,
            } as any);
            e.addPlayer(0, 0, 110);
            expectFiniteDisc(e, 10);
        } finally {
            safeDestroy(e);
        }
    });

    it('keeps the disc finite on a map-authored negative-friction platform (friction -1)', () => {
        const e = new PhysicsEngine();
        try {
            e.addBody({
                name: 'neg', type: 'rect', x: 0, y: 120, width: 200, height: 20,
                static: true, friction: -1, fricPolarity: false,
            } as any);
            e.addPlayer(0, 0, 110);
            expectFiniteDisc(e, 10);
        } finally {
            safeDestroy(e);
        }
    });

    it('keeps the disc finite on a f_p surface with no authored friction (undefined)', () => {
        const e = new PhysicsEngine();
        try {
            e.addBody({
                name: 'polar-undef', type: 'rect', x: 0, y: 120, width: 200, height: 20,
                static: true, fricPolarity: true,
            } as any);
            e.addPlayer(0, 0, 110);
            expectFiniteDisc(e, 10);
        } finally {
            safeDestroy(e);
        }
    });

    it('kills a disc whose position becomes non-finite instead of leaving it immortal', () => {
        const e = new PhysicsEngine();
        try {
            e.addBody({
                name: 'p', type: 'rect', x: 0, y: 120, width: 200, height: 20,
                static: true,
            } as any);
            e.addPlayer(0, 0, 110);
            // Simulate the pre-fix corruption: a NaN body position. The OOB
            // death check must treat non-finite positions as out-of-bounds
            // (`NaN > threshold` is always false, so without the guard the
            // disc would be immortal).
            const body = (e as any).playerBodies.get(0);
            const pos = body.GetPosition();
            pos.x = NaN;
            pos.y = NaN;
            e.tick();
            const s = e.getPlayerState(0);
            expect(s.alive).toBe(false);
            expect(s.deathType).toBe(4);
        } finally {
            safeDestroy(e);
        }
    });
});

describe('negative-friction regression (#276): environment with a real map', () => {
    it('keeps observations finite when the AI contacts the WDB friction:-1 obstacle', () => {
        const map = loadMap('bonk_WDB__no_nothing__1232248.json');
        const env = new BonkEnvironment({
            mapData: map as any,
            numOpponents: 0,
            seed: 1,
            maxTicks: 100,
        });
        try {
            env.reset(1);
            // Force the AI disc onto the map's dynamic friction:-1 obstacle at
            // (0,195) (collidesPlayers: true), the direct-trace repro in #276.
            const physics = (env as any).physics as PhysicsEngine;
            const body = (physics as any).playerBodies.get(0);
            body.GetPosition().Set(0 / SCALE, 195 / SCALE);
            body.GetLinearVelocity().Set(0, 0);
            for (let i = 0; i < 10; i++) {
                const r = env.step(0);
                expect(Number.isFinite(r.observation.playerX), `step ${i + 1} playerX`).toBe(true);
                expect(Number.isFinite(r.observation.playerY), `step ${i + 1} playerY`).toBe(true);
            }
        } finally {
            env.close();
        }
    });
});
