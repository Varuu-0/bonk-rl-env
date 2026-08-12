import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    PhysicsEngine,
    MapDef,
    MapBodyDef,
    SCALE,
} from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

describe('CapZoneScoring', () => {
    let engine: PhysicsEngine | null = null;
    afterEach(() => { safeDestroy(engine); engine = null; });

    function addBall(
        eng: PhysicsEngine,
        x: number,
        y: number,
        vx: number,
        vy: number,
    ): void {
        const def: any = {
            name: 'ball',
            type: 'circle',
            x,
            y,
            radius: 5,
            static: false,
            density: 1,
            linearVelocity: { x: vx, y: vy },
            restitution: 0,
            friction: 0,
            isBall: true,
        };
        eng.addBody(def);
    }

    describe('team assignment', () => {
        it('setPlayerTeam assigns blue to player 0', () => {
            engine = new PhysicsEngine();
            engine.setPlayerTeam(0, 'blue');
            expect(engine.getPlayerTeam(0)).toBe('blue');
        });

        it('setPlayerTeam assigns red to player 1', () => {
            engine = new PhysicsEngine();
            engine.setPlayerTeam(1, 'red');
            expect(engine.getPlayerTeam(1)).toBe('red');
        });

        it('getPlayerTeam returns undefined for unassigned player', () => {
            engine = new PhysicsEngine();
            expect(engine.getPlayerTeam(99)).toBe(undefined);
        });
    });

    describe('capzone sensor', () => {
        it('addCapZone creates a sensor body without crashing', () => {
            engine = new PhysicsEngine();
            expect(() => {
                engine!.addCapZone(
                    { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                    0, 100, 200, 50,
                );
            }).not.toThrow();
        });

        it('addCapZone multiple zones does not throw', () => {
            engine = new PhysicsEngine();
            expect(() => {
                engine!.addCapZone(
                    { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                    0, -100, 200, 50,
                );
                engine!.addCapZone(
                    { index: 1, owner: 'neutral', type: 3, fixture: 'zone', shapeType: 'bx' },
                    0, 300, 200, 50,
                );
            }).not.toThrow();
        });
    });

    describe('scoring detection', () => {
        // Verified native cap-zone team mapping (DEOBFUSCATION §30):
        //   type 2 = red, type 3 = blue, type 4 = green, type 5 = yellow.
        it('ball entering type 2 (red) zone triggers red score', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const result = engine.getTeamScored();
            expect(result).toBe('red');
        });

        it('ball entering type 3 (blue) zone triggers blue score', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 3, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const result = engine.getTeamScored();
            expect(result).toBe('blue');
        });

        it('getTeamScored returns null when no scoring', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 200, width: 800, height: 30,
                static: true,
            });
            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 30; i++) engine.tick();

            expect(engine.getTeamScored()).toBe(null);
        });

        it('getTeamScored resets after reading', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const first = engine.getTeamScored();
            const second = engine.getTeamScored();

            expect(first).toBe('red');
            expect(second).toBe(null);
        });

        it('reset() clears scoring state', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            engine.reset();

            expect(engine.getTeamScored()).toBe(null);
        });
    });

    describe('instant-zone elimination', () => {
        // Verified (DEOBFUSCATION §30): instant cap zones (type 2-5) are
        // triggered ONLY by a dynamic non-player physics body entering the
        // sensor. The winning team is derived from the zone type, and every
        // disc NOT on the winning team is eliminated with deathType 3.
        it('dynamic non-player body triggers instant zone and eliminates losers with deathType 3', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 1600, height: 30,
                static: true,
            });

            // type 2 = red instant zone
            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            engine.addPlayer(0, 300, 50);   // blue team (loses)
            engine.setPlayerTeam(0, 'blue');
            engine.addPlayer(1, -300, 50);  // red team (wins)
            engine.setPlayerTeam(1, 'red');

            // Dynamic non-player body falls into the instant zone.
            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            expect(engine.getTeamScored()).toBe('red');
            const loser = engine.getPlayerState(0);
            const winner = engine.getPlayerState(1);
            expect(loser.alive).toBe(false);
            expect(loser.deathType).toBe(3);
            expect(winner.alive).toBe(true);
            expect(winner.deathType).toBe(0);
        });

        it('treats a body with omitted static as dynamic', () => {
            engine = new PhysicsEngine();
            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );
            engine.addPlayer(0, 300, 50);
            engine.setPlayerTeam(0, 'blue');
            engine.addPlayer(1, -300, 50);
            engine.setPlayerTeam(1, 'red');
            engine.addBody({
                name: 'implicit-dynamic-ball', type: 'circle',
                x: 0, y: 50, radius: 5, density: 1,
                linearVelocity: { x: 0, y: 0 }, restitution: 0, friction: 0,
            });

            for (let i = 0; i < 100; i++) engine.tick();

            expect(engine.getTeamScored()).toBe('red');
        });

        it('does not score for a body with a truthy static value', () => {
            engine = new PhysicsEngine();

            // Map data can be hand-authored, so the contact guard must match
            // addBody() and treat every truthy static value as static.
            (engine as any).registerCapZoneContact(
                { isCapZone: true, zoneType: 2, zoneIndex: 0 },
                { static: 1 },
                true,
            );

            expect(engine.getTeamScored()).toBe(null);
        });

        it('does not score when a dynamic body carries truthy static user data', () => {
            engine = new PhysicsEngine();
            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );
            // Static bodies never generate contacts, so the body must be
            // created dynamic to reach the sensor. addBody() stores the def
            // object itself as user data, so mutating it after creation makes
            // the guard see truthy `static` while the body still collides.
            const def: any = {
                name: 'truthy-static-ball', type: 'circle',
                x: 0, y: 50, radius: 5, density: 1,
                static: false,
                restitution: 0, friction: 0,
            };
            engine.addBody(def);
            def.static = 1 as any;

            for (let i = 0; i < 100; i++) engine.tick();

            expect(engine.getTeamScored()).toBe(null);
        });

        it('player-disc contact does NOT trigger an instant zone', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 600, width: 1600, height: 30,
                static: true,
            });

            // Large instant zone covering the resting spot of the player disc.
            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 3, fixture: 'zone', shapeType: 'bx' },
                0, 470, 400, 300,
            );

            engine.addPlayer(0, 0, 300);
            engine.setPlayerTeam(0, 'blue');

            for (let i = 0; i < 100; i++) engine.tick();

            // A player disc contacting the sensor must not score or eliminate.
            expect(engine.getTeamScored()).toBe(null);
            expect(engine.getPlayerState(0).alive).toBe(true);
        });
    });

    describe('instant-zone single-fire (native teamGoalEvent fires on contact begin)', () => {
        it('a dwelling body does not re-score on persisting ticks', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                // Floor top is inside the zone, so the ball continues to
                // overlap the sensor after the first BeginContact event.
                x: 0, y: 245, width: 1600, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'zone', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            engine.addPlayer(0, 300, 50);
            engine.setPlayerTeam(0, 'blue');
            engine.addPlayer(1, -300, 50);
            engine.setPlayerTeam(1, 'red');

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            // First read consumes the single goal.
            expect(engine.getTeamScored()).toBe('red');
            // The ball still rests in the zone — persist contacts must not
            // produce a new score on later ticks.
            for (let i = 0; i < 30; i++) engine.tick();
            expect(engine.getTeamScored()).toBe(null);
        });
    });

    describe('timed-zone capture', () => {
        // Verified (DEOBFUSCATION §30): a timed zone (type 1) accumulates
        // progress `p` while a single team holds it, up to a limit of `l*30`.
        // Once the limit is reached a `f=20` tick countdown begins, after
        // which the holding team scores and non-holders are eliminated with
        // deathType 3. Using l=0.1 keeps the limit at 3 ticks so the test
        // exercises the countdown rather than 30 ticks of pure progress.
        it('scores after l*30 progress and the f=20 countdown', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 600, width: 2000, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 1, fixture: 'zone', shapeType: 'bx', l: 0.1 },
                0, 540, 400, 300,
            );

            engine.addPlayer(0, 0, 400);    // red holder, rests inside the zone
            engine.setPlayerTeam(0, 'red');
            engine.addPlayer(1, 500, 400); // blue, outside the zone
            engine.setPlayerTeam(1, 'blue');

            // Progress fills (~3 ticks) and the f=20 countdown begins; no score yet.
            for (let i = 0; i < 8; i++) engine.tick();
            expect(engine.getTeamScored()).toBe(null);

            // After the 20-tick countdown elapses the zone scores for red.
            for (let i = 0; i < 30; i++) engine.tick();
            expect(engine.getTeamScored()).toBe('red');
            expect(engine.getPlayerState(1).alive).toBe(false);
            expect(engine.getPlayerState(1).deathType).toBe(3);
            expect(engine.getPlayerState(0).alive).toBe(true);
        });

        // Native completion semantics (DEOBFUSCATION §34.6, lines 3698-3703):
        // the whole completion block runs `while (p >= l)` — the f countdown
        // only advances while the zone progress is at the limit, so a contested
        // zone (p < l) pauses the timer and the capture only fires at f == 0
        // while the holder keeps p at the limit.
        it('capture countdown pauses while the zone is contested and only resumes after the holder regains p >= l', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 600, width: 2000, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 1, fixture: 'zone', shapeType: 'bx', l: 0.1 },
                0, 540, 400, 300,
            );

            engine.addPlayer(0, 0, 400);    // red holder, rests inside the zone
            engine.setPlayerTeam(0, 'red');
            engine.addPlayer(1, 500, 400); // blue, outside the zone
            engine.setPlayerTeam(1, 'blue');

            // Red holds the zone alone: real contact events fill p to l and
            // start the f = 20 countdown.
            for (let i = 0; i < 8; i++) engine.tick();
            let s: any = (engine as any).capZoneState.get(0);
            expect(s.p).toBe(s.l);
            expect(s.f).toBeGreaterThan(0);
            expect(engine.getTeamScored()).toBe(null);

            // Blue enters and contests: progress drops below the limit and the
            // running countdown must pause instead of completing the capture.
            s.p = 0;
            s.f = 5;
            for (let i = 0; i < 6; i++) {
                (engine as any).capZoneTouches.push({ zoneIndex: 0, playerId: 1, team: 'blue' });
                engine.tick();
            }
            s = (engine as any).capZoneState.get(0);
            expect(s.p).toBe(0);
            expect(s.f).toBe(5);
            expect(engine.getTeamScored()).toBe(null);
            expect(engine.getPlayerState(0).alive).toBe(true);
            expect(engine.getPlayerState(1).alive).toBe(true);

            // Blue leaves the zone: red alone re-fills p to the limit and the
            // paused countdown resumes from 5 — the capture fires only after
            // the re-hold, not for the contested interval.
            for (let i = 0; i < 10; i++) engine.tick();
            expect(engine.getTeamScored()).toBe('red');
            expect(engine.getPlayerState(1).alive).toBe(false);
            expect(engine.getPlayerState(1).deathType).toBe(3);
            expect(engine.getPlayerState(0).alive).toBe(true);
        });

        it('a takeover team that never completed the hold cannot win; the capture fires only after it holds p >= l', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 600, width: 2000, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 1, fixture: 'zone', shapeType: 'bx', l: 0.1 },
                0, 540, 400, 300,
            );

            engine.addPlayer(0, 0, 400);    // red holder, rests inside the zone
            engine.setPlayerTeam(0, 'red');
            engine.addPlayer(1, 500, 400); // blue, outside the zone
            engine.setPlayerTeam(1, 'blue');

            // Red holds the zone alone: p fills to l and the countdown starts.
            for (let i = 0; i < 8; i++) engine.tick();
            let s: any = (engine as any).capZoneState.get(0);
            expect(s.p).toBe(s.l);
            expect(s.f).toBeGreaterThan(0);

            // Blue takes over mid-countdown while the holder dies: ownership
            // transfers with progress reset to 0 and f still running.
            s.p = 0;
            s.o = 1;
            s.ot = 'blue';
            s.f = 5;
            (engine as any).detachPlayer(0, (engine as any).playerBodies.get(0));

            // Blue alone must complete the hold: p refills to l before the
            // paused countdown resumes from 5. While p < l nothing fires.
            for (let i = 0; i < 5; i++) {
                (engine as any).capZoneTouches.push({ zoneIndex: 0, playerId: 1, team: 'blue' });
                engine.tick();
            }
            expect(engine.getTeamScored()).toBe(null);

            for (let i = 0; i < 7; i++) {
                (engine as any).capZoneTouches.push({ zoneIndex: 0, playerId: 1, team: 'blue' });
                engine.tick();
            }
            expect(engine.getTeamScored()).toBe('blue');
            expect(engine.getPlayerState(0).alive).toBe(false);
            expect(engine.getPlayerState(0).deathType).toBe(3);
            expect(engine.getPlayerState(1).alive).toBe(true);
        });
    });

    describe('environment integration', () => {
        it('capzone capture scores exactly +1 (eliminations do not double-count as kill rewards)', () => {
            const mapData: MapDef = {
                name: 'capzone-reward',
                spawnPoints: {
                    team_blue: { x: -300, y: -100 },
                    team_red: { x: 300, y: -100 },
                },
                bodies: [
                    { name: 'floor', type: 'rect', x: 0, y: 400, width: 800, height: 30, static: true },
                    // noPhysics fixture: geometry defines the zone sensor but
                    // does not block the falling ball.
                    { name: 'zone_fixture', type: 'rect', x: 0, y: 190, width: 200, height: 100, static: true, noPhysics: true },
                    // Dynamic ball falls into the type-3 (blue) instant zone.
                    { name: 'ball', type: 'circle', x: 0, y: 50, radius: 10, static: false, density: 1, restitution: 0, friction: 0 },
                ],
                capZones: [
                    { index: 0, owner: 'neutral', type: 3, fixture: 'zone_fixture', shapeType: 'bx' },
                ],
            };

            // Static opponent keeps the episode alive until the ball reaches
            // the zone; the elimination lands on the same capture tick.
            const env = new BonkEnvironment({ mapData, numOpponents: 1, randomOpponent: false, seed: 42, maxTicks: 900 });
            try {
                let captureReward: number | null = null;
                for (let i = 0; i < 300; i++) {
                    const r = env.step(0);
                    if ((r.info.scoreBlue ?? 0) > 0) {
                        captureReward = r.reward;
                        break;
                    }
                    if (r.done) break;
                }

                expect(captureReward).not.toBe(null);
                // Exactly +1.0 capture, -0.001 time penalty. A double-count
                // would read 1.999 (capture + elimination kill reward).
                expect(captureReward!).toBeCloseTo(0.999, 3);
            } finally {
                env.close();
            }
        });

        it('capzone on a polygon fixture captures identically to an equivalent rect (#277)', () => {
            // Same bounds (200 x 100) as the rect control case above, but the
            // zone fixture is a polygon. Previously the polygon sizing branch
            // left w = h = 0, building a degenerate point sensor that never
            // registered a touch, so the instant goal never fired.
            const polygonFixture = {
                name: 'zone_fixture', type: 'polygon' as const, x: 0, y: 190,
                vertices: [{ x: -100, y: -50 }, { x: 100, y: -50 }, { x: 100, y: 50 }, { x: -100, y: 50 }],
                static: true, noPhysics: true,
            };
            const mapData: MapDef = {
                name: 'capzone-polygon-reward',
                spawnPoints: {
                    team_blue: { x: -300, y: -100 },
                    team_red: { x: 300, y: -100 },
                },
                bodies: [
                    { name: 'floor', type: 'rect', x: 0, y: 400, width: 800, height: 30, static: true },
                    polygonFixture,
                    { name: 'ball', type: 'circle', x: 0, y: 50, radius: 10, static: false, density: 1, restitution: 0, friction: 0 },
                ],
                capZones: [
                    { index: 0, owner: 'neutral', type: 3, fixture: 'zone_fixture', shapeType: 'polygon' },
                ],
            };

            const env = new BonkEnvironment({ mapData, numOpponents: 1, randomOpponent: false, seed: 42, maxTicks: 900 });
            try {
                // The sensor must be non-degenerate: 4 vertices spanning the
                // fixture's extent, not a coincident point at (0, 0).
                const sensor = (env as any).physics.capZoneSensors[0] as { GetShapeList(): any };
                const shape = sensor.GetShapeList();
                expect(shape.m_vertexCount).toBe(4);
                const xs: number[] = [];
                const ys: number[] = [];
                for (let i = 0; i < shape.m_vertexCount; i++) {
                    xs.push(shape.m_vertices[i].x);
                    ys.push(shape.m_vertices[i].y);
                }
                expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
                expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);

                let captureReward: number | null = null;
                let captureStep: number | null = null;
                for (let i = 0; i < 300; i++) {
                    const r = env.step(0);
                    if ((r.info.scoreBlue ?? 0) > 0) {
                        captureReward = r.reward;
                        captureStep = i;
                        break;
                    }
                    if (r.done) break;
                }

                // Polygon zone must capture in the same step budget as the
                // rect control (step ~15), not silently never fire.
                expect(captureReward).not.toBe(null);
                expect(captureReward!).toBeCloseTo(0.999, 3);
                expect(captureStep!).toBeLessThanOrEqual(20);

                // reset() rebuilds the sensor from the same map data — it must
                // stay non-degenerate, otherwise the next episode is dead.
                env.reset();
                const resetSensor = (env as any).physics.capZoneSensors[0] as { GetShapeList(): any };
                const resetShape = resetSensor.GetShapeList();
                expect(resetShape.m_vertexCount).toBe(4);
                const rxs: number[] = [];
                const rys: number[] = [];
                for (let i = 0; i < resetShape.m_vertexCount; i++) {
                    rxs.push(resetShape.m_vertices[i].x);
                    rys.push(resetShape.m_vertices[i].y);
                }
                expect(Math.max(...rxs) - Math.min(...rxs)).toBeGreaterThan(0);
                expect(Math.max(...rys) - Math.min(...rys)).toBeGreaterThan(0);
            } finally {
                env.close();
            }
        });

        it('BonkEnvironment with capZones map includes capZones in step info', () => {
            const mapData: MapDef = {
                name: 'capzone-test',
                spawnPoints: {
                    team_blue: { x: -200, y: -100 },
                    team_red: { x: 200, y: -100 },
                },
                bodies: [
                    { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
                ],
                capZones: [
                    { index: 0, owner: 'neutral', type: 2, fixture: 'floor', shapeType: 'bx' },
                ],
            };

            const env = new BonkEnvironment({ mapData, numOpponents: 0 });
            try {
                const result = env.step(0);

                expect(result.info.capZones).toBeDefined();
                expect(result.info.capZones.length).toBe(1);
                expect(result.info.capZones[0].type).toBe(2);
            } finally {
                env.close();
            }
        });

        it('BonkEnvironment without capZones still works', () => {
            const mapData: MapDef = {
                name: 'no-capzone-test',
                spawnPoints: {
                    team_blue: { x: -200, y: -100 },
                    team_red: { x: 200, y: -100 },
                },
                bodies: [
                    { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
                ],
            };

            const env = new BonkEnvironment({ mapData, numOpponents: 0 });
            try {
                expect(() => {
                    for (let i = 0; i < 10; i++) env.step(0);
                }).not.toThrow();

                const info = env.step(0).info;
                expect(JSON.stringify(info.capZones)).toBe('[]');
            } finally {
                env.close();
            }
        });
    });
});
