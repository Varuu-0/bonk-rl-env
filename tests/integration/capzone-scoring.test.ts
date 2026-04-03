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
                    { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                    0, 100, 200, 50,
                );
            }).not.toThrow();
        });

        it('addCapZone multiple zones does not throw', () => {
            engine = new PhysicsEngine();
            expect(() => {
                engine!.addCapZone(
                    { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                    0, -100, 200, 50,
                );
                engine!.addCapZone(
                    { index: 1, owner: 'neutral', type: 3, fixture: 'Red', shapeType: 'bx' },
                    0, 300, 200, 50,
                );
            }).not.toThrow();
        });
    });

    describe('scoring detection', () => {
        it('ball entering type 2 zone triggers blue score', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const result = engine.getTeamScored();
            expect(result).toBe('blue');
        });

        it('ball entering type 3 zone triggers red score', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 3, fixture: 'Red', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const result = engine.getTeamScored();
            expect(result).toBe('red');
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
                { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            const first = engine.getTeamScored();
            const second = engine.getTeamScored();

            expect(first).toBe('blue');
            expect(second).toBe(null);
        });

        it('destroyAllBodies clears scoring state', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            engine.destroyAllBodies();

            expect(engine.getTeamScored()).toBe(null);
        });

        it('reset() clears scoring state', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor', type: 'rect',
                x: 0, y: 500, width: 800, height: 30,
                static: true,
            });

            engine.addCapZone(
                { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
                0, 190, 200, 100,
            );

            addBall(engine, 0, 50, 0, 0);

            for (let i = 0; i < 100; i++) engine.tick();

            engine.reset();

            expect(engine.getTeamScored()).toBe(null);
        });
    });

    describe('environment integration', () => {
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
