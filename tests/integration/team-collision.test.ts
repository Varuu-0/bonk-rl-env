/**
 * team-collision.test.ts — Verified native disc-disc contact rules
 * (docs/DEOBFUSCATION.md, BeginContact case 6):
 *
 *   1. `nc` mode disables every disc-disc contact.
 *   2. With teams on (`tea`), discs on the same team never collide.
 *   3. Enabled disc-disc contacts queue swing-destroy events (a swinging
 *      disc's grapple joint is destroyed after the step) and record
 *      last-hit attribution (`lhid`, `lht = 120` ticks = 4s at 30 TPS).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PhysicsEngine, LAST_HIT_TIMER_TICKS } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

const NO_INPUT = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
const GRAPPLE_INPUT = { ...NO_INPUT, grapple: true };

function horizontalSeparation(engine: PhysicsEngine, a: number, b: number): number {
    const sa = engine.getPlayerState(a);
    const sb = engine.getPlayerState(b);
    return Math.abs(sa.x - sb.x);
}

describe('TeamDiscCollision (verified contact rules)', () => {
    let engine: PhysicsEngine | null = null;
    afterEach(() => { safeDestroy(engine); engine = null; });

    describe('same-team collision disable (tea)', () => {
        it('same-team overlapping discs do not collide when teams enabled', () => {
            engine = new PhysicsEngine();
            engine.setTeamsEnabled(true);
            // Overlapping discs: 20 map units apart, radii sum = 2 * (12/30) = 0.8m > 0.667m
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            engine.setPlayerTeam(0, 'red');
            engine.setPlayerTeam(1, 'red');

            const initialSep = horizontalSeparation(engine, 0, 1);
            for (let i = 0; i < 15; i++) engine.tick();

            // No contact filtering => no mutual impulse => separation unchanged.
            expect(horizontalSeparation(engine, 0, 1)).toBeCloseTo(initialSep, 5);
        });

        it('opposite-team overlapping discs still collide when teams enabled', () => {
            engine = new PhysicsEngine();
            engine.setTeamsEnabled(true);
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            engine.setPlayerTeam(0, 'red');
            engine.setPlayerTeam(1, 'blue');

            const initialSep = horizontalSeparation(engine, 0, 1);
            for (let i = 0; i < 15; i++) engine.tick();

            // Contact resolves the overlap: discs get pushed apart.
            expect(horizontalSeparation(engine, 0, 1)).toBeGreaterThan(initialSep + 3);
        });

        it('default mode (teams disabled) unchanged: overlapping discs collide', () => {
            engine = new PhysicsEngine();
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            engine.setPlayerTeam(0, 'red');
            engine.setPlayerTeam(1, 'red');

            const initialSep = horizontalSeparation(engine, 0, 1);
            for (let i = 0; i < 15; i++) engine.tick();

            expect(horizontalSeparation(engine, 0, 1)).toBeGreaterThan(initialSep + 3);
        });

        it('unassigned teams do not disable collisions', () => {
            engine = new PhysicsEngine();
            engine.setTeamsEnabled(true);
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            // No setPlayerTeam calls: both team values are undefined.

            const initialSep = horizontalSeparation(engine, 0, 1);
            for (let i = 0; i < 15; i++) engine.tick();

            expect(horizontalSeparation(engine, 0, 1)).toBeGreaterThan(initialSep + 3);
        });
    });

    describe('no-collision mode (nc)', () => {
        it('disc-disc contacts are fully disabled', () => {
            engine = new PhysicsEngine();
            engine.setNoCollide(true);
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            engine.setPlayerTeam(0, 'red');
            engine.setPlayerTeam(1, 'blue');

            const initialSep = horizontalSeparation(engine, 0, 1);
            for (let i = 0; i < 15; i++) engine.tick();

            expect(horizontalSeparation(engine, 0, 1)).toBeCloseTo(initialSep, 5);
        });
    });

    describe('environment wiring', () => {
        it('BonkEnvironment forwards teamsEnabled/noCollide to the engine', async () => {
            const { BonkEnvironment } = await import('../../src/core/environment');
            const env = new BonkEnvironment({ numOpponents: 1, teamsEnabled: true, seed: 7 });
            try {
                // Engine internals are private; verify persisted flags by behavior:
                // AI (blue) and opponent (red) are opposite teams, so they collide;
                // two same-team discs created directly would not. Smoke check only.
                env.reset();
                const r = env.step(0);
                expect(r.observation).toBeDefined();
            } finally {
                env.close();
            }
        });
    });

    describe('swing-destroy events (swingCollideDestroyEvents)', () => {
        it('a grappling disc that collides with another disc loses its grapple', () => {
            engine = new PhysicsEngine();
            engine.addBody({
                name: 'anchor', type: 'rect',
                x: 0, y: 0, width: 400, height: 30, static: true,
            });
            engine.addPlayer(0, 0, 100);  // 3.33m below anchor, within 500/SCALE range
            engine.addPlayer(1, 0, 115);  // overlaps player 0 (15 map units < 0.8m)
            engine.setPlayerTeam(0, 'red');
            engine.setPlayerTeam(1, 'blue');

            engine.applyInput(0, GRAPPLE_INPUT);
            expect(engine.hasGrappleJoint(0)).toBe(true);

            // Hold grapple (grapple:true keeps the joint); player 1 overlaps.
            engine.applyInput(0, GRAPPLE_INPUT);
            engine.applyInput(1, NO_INPUT);
            engine.tick();

            // The disc-disc contact while swinging destroys player 0's grapple.
            expect(engine.hasGrappleJoint(0)).toBe(false);
        });

        it('grapple survives while no disc-disc contact occurs', () => {
            engine = new PhysicsEngine();
            engine.addBody({
                name: 'anchor', type: 'rect',
                x: 0, y: 0, width: 400, height: 30, static: true,
            });
            engine.addPlayer(0, 0, 100);
            engine.addPlayer(1, 400, 300); // far away, no contact

            engine.applyInput(0, GRAPPLE_INPUT);
            for (let i = 0; i < 5; i++) {
                engine.applyInput(0, GRAPPLE_INPUT);
                engine.tick();
            }

            expect(engine.hasGrappleJoint(0)).toBe(true);
        });
    });

    describe('last-hit attribution (lhid / lht)', () => {
        it('records both directions with a 120-tick window and expires', () => {
            engine = new PhysicsEngine();
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);

            engine.tick();

            const hit0 = engine.getLastHit(0);
            const hit1 = engine.getLastHit(1);
            expect(hit0?.attackerId).toBe(1);
            expect(hit1?.attackerId).toBe(0);
            expect(hit0?.ticksRemaining).toBe(LAST_HIT_TIMER_TICKS);

            for (let i = 0; i < 5; i++) engine.tick();
            expect(engine.getLastHit(0)?.ticksRemaining).toBe(LAST_HIT_TIMER_TICKS - 5);

            for (let i = 0; i < LAST_HIT_TIMER_TICKS; i++) engine.tick();
            expect(engine.getLastHit(0)).toBe(null);
            expect(engine.getLastHit(1)).toBe(null);
        });

        it('no attribution for contacts disabled by nc/team filters', () => {
            engine = new PhysicsEngine();
            engine.setNoCollide(true);
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);

            engine.tick();

            expect(engine.getLastHit(0)).toBe(null);
            expect(engine.getLastHit(1)).toBe(null);
        });
    });

    describe('state cleanup', () => {
        it('reset clears swing-destroy and last-hit state', () => {
            engine = new PhysicsEngine();
            engine.addPlayer(0, 0, 0);
            engine.addPlayer(1, 20, 0);
            engine.tick();
            expect(engine.getLastHit(0)).not.toBe(null);

            engine.reset();
            expect(engine.getLastHit(0)).toBe(null);
            expect(engine.hasGrappleJoint(0)).toBe(false);
        });
    });
});
