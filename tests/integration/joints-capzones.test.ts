import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    PhysicsEngine,
    MapDef,
    MapBodyDef,
    SCALE,
} from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('JointsCapZones', () => {
    let engine: PhysicsEngine | null = null;
    afterEach(() => { safeDestroy(engine); engine = null; });

    const box2d = require('box2d');
    const { b2Vec2 } = box2d;

    describe('joints', () => {
        it('addJoint with lpj type constrains ball', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'platform',
                type: 'rect',
                x: 0, y: 0,
                width: 100, height: 10,
                static: true,
            });
            engine.addBody({
                name: 'ball',
                type: 'circle',
                x: 0, y: 0.5,
                radius: 0.167,
                static: false,
                density: 1,
            });

            const bodyMap = (engine as any).getBodyMap();
            (engine as any).addJoint(
                { type: 'lpj', bodyA: 'ball', bodyB: 'platform', frequencyHz: 4, dampingRatio: 0.5, collideConnected: true },
                bodyMap,
            );

            const ballBody = bodyMap.get('ball');
            ballBody.ApplyImpulse(new b2Vec2(0, -5), ballBody.GetPosition());

            for (let i = 0; i < 100; i++) engine.tick();

            const ballY = ballBody.GetPosition().y * SCALE;
            expect(ballY).toBeGreaterThan(-10);
        });

        it('addJoint with unknown body name does not crash', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'platform',
                type: 'rect',
                x: 0, y: 0,
                width: 100, height: 10,
                static: true,
            });

            const bodyMap = (engine as any).getBodyMap();

            expect(() => {
                (engine as any).addJoint(
                    { type: 'lpj', bodyA: 'nonexistent', bodyB: 'platform' },
                    bodyMap,
                );
            }).not.toThrow();
        });

        it('getBodyMap returns bodies indexed by name', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor',
                type: 'rect',
                x: 0, y: 200,
                width: 200, height: 20,
                static: true,
            });
            engine.addBody({
                name: 'wall',
                type: 'rect',
                x: 100, y: 0,
                width: 10, height: 200,
                static: true,
            });

            const bodyMap = (engine as any).getBodyMap();

            expect(bodyMap.has('floor')).toBe(true);
            expect(bodyMap.has('wall')).toBe(true);
            expect(bodyMap.size).toBe(2);
        });

        it('destroyAllBodies clears bodyMap', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'block',
                type: 'rect',
                x: 0, y: 0,
                width: 50, height: 10,
                static: true,
            });

            engine.destroyAllBodies();

            const bodyMap = (engine as any).getBodyMap();
            expect(bodyMap.size).toBe(0);
        });

        it('reset() clears bodyMap', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'block',
                type: 'rect',
                x: 0, y: 0,
                width: 50, height: 10,
                static: true,
            });

            engine.reset();

            const bodyMap = (engine as any).getBodyMap();
            expect(bodyMap.size).toBe(0);
        });

        it('distance joint constrains body separation', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'anchor',
                type: 'circle',
                x: 0, y: 0,
                radius: 1,
                static: true,
            });
            engine.addBody({
                name: 'weight',
                type: 'circle',
                x: 0, y: 10,
                radius: 1,
                static: false,
                density: 1,
            });

            const bodyMap = (engine as any).getBodyMap();
            (engine as any).addJoint(
                { type: 'lpj', bodyA: 'weight', bodyB: 'anchor', length: 10, frequencyHz: 4, dampingRatio: 0.5 },
                bodyMap,
            );

            for (let i = 0; i < 200; i++) engine.tick();

            const anchorPos = bodyMap.get('anchor').GetPosition();
            const weightPos = bodyMap.get('weight').GetPosition();
            const dx = (weightPos.x - anchorPos.x) * SCALE;
            const dy = (weightPos.y - anchorPos.y) * SCALE;
            const dist = Math.sqrt(dx * dx + dy * dy);

            expect(Math.abs(dist - 10)).toBeLessThan(2);
        });
    });

    describe('map bounds', () => {
        it('setMapBounds overrides calculated arena bounds', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'small',
                type: 'rect',
                x: 0, y: 0,
                width: 10, height: 10,
                static: true,
            });

            (engine as any).setMapBounds(100, 80);

            engine.addPlayer(0, 0, 0);

            const rightInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: false };

            for (let i = 0; i < 300; i++) {
                engine.applyInput(0, rightInput);
                engine.tick();
            }

            const state = engine.getPlayerState(0);
            expect(state.alive).toBe(false);
        });

        it('setMapBounds kill zone works in all directions', () => {
            engine = new PhysicsEngine();

            engine.addBody({
                name: 'floor',
                type: 'rect',
                x: 0, y: 29,
                width: 200, height: 5,
                static: true,
            });

            (engine as any).setMapBounds(60, 60);

            engine.addPlayer(0, 0, 0);

            const state0 = engine.getPlayerState(0);
            expect(state0.alive).toBe(true);

            const rightInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: false };
            for (let i = 0; i < 500; i++) {
                engine.applyInput(0, rightInput);
                engine.tick();
            }

            const state1 = engine.getPlayerState(0);
            expect(state1.alive).toBe(false);
        });

        it('setMapBounds with small value kills player quickly', () => {
            engine = new PhysicsEngine();

            (engine as any).setMapBounds(0.2, 0.2);

            engine.addPlayer(0, 0, 0);

            for (let i = 0; i < 30; i++) engine.tick();

            const state = engine.getPlayerState(0);
            expect(state.alive).toBe(false);
        });
    });

    describe('capzones', () => {
        it('MapDef type accepts capZones array', () => {
            const mapDef: MapDef = {
                name: 'test-map',
                spawnPoints: { blue: { x: 0, y: 0 } },
                bodies: [],
                capZones: [{ index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' }],
            };

            expect(mapDef.capZones!.length).toBe(1);
            expect(mapDef.capZones![0].type).toBe(2);
        });

        it('MapDef with empty capZones is valid', () => {
            const mapDef: MapDef = {
                name: 'empty-capzones',
                spawnPoints: {},
                bodies: [],
                capZones: [],
            };

            expect(mapDef.capZones!.length).toBe(0);
        });

        it('MapDef capZones optional', () => {
            const mapDef: MapDef = {
                name: 'no-capzones',
                spawnPoints: {},
                bodies: [],
            };

            expect(mapDef.capZones).toBe(undefined);
        });
    });

    describe('physics overrides', () => {
        it('MapDef with physics.ppm is accepted', () => {
            const mapDef: MapDef = {
                name: 'ppm-map',
                spawnPoints: {},
                bodies: [],
                physics: { ppm: 12 },
            };

            expect(mapDef.physics!.ppm).toBe(12);
        });

        it('MapDef with physics.bounds is accepted', () => {
            const mapDef: MapDef = {
                name: 'bounds-map',
                spawnPoints: {},
                bodies: [],
                physics: { bounds: { width: 1825, height: 1825 } },
            };

            expect(mapDef.physics!.bounds!.width).toBe(1825);
        });
    });
});
