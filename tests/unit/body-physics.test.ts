/**
 * body-physics.test.ts — Vitest test suite for body physics fields
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    PhysicsEngine,
    MapBodyDef,
    SCALE,
} from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('Body Physics', () => {
    let engine: PhysicsEngine | null = null;
    afterEach(() => { safeDestroy(engine); engine = null; });

    describe('linearDamping', () => {
        it('linearDamping=0 body slides farther than linearDamping=5', () => {
            engine = new PhysicsEngine();

            const noDamping: MapBodyDef = {
                name: 'noDamp',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                linearDamping: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            const highDamping: MapBodyDef = {
                name: 'highDamp',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                linearDamping: 5,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(noDamping);
            engine.addBody(highDamping);

            const bodyMap = engine.getBodyMap();
            const noDampBody = bodyMap.get('noDamp');
            const highDampBody = bodyMap.get('highDamp');

            // @ts-ignore — box2d has no type declarations
            const b2Vec2 = require('box2d').b2Vec2;
            noDampBody.ApplyImpulse(new b2Vec2(5, 0), noDampBody.GetPosition());
            highDampBody.ApplyImpulse(new b2Vec2(5, 0), highDampBody.GetPosition());

            for (let i = 0; i < 30; i++) {
                engine.tick();
            }

            const noDampX = noDampBody.GetPosition().x;
            const highDampX = highDampBody.GetPosition().x;

            expect(noDampX).toBeGreaterThan(highDampX);
        });

        it('linearDamping defaults to 0 when not specified', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'defaultBody',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('defaultBody');

            expect(b2Body.m_linearDamping).toBe(0);

            // @ts-ignore — box2d has no type declarations
            const b2Vec2 = require('box2d').b2Vec2;
            b2Body.ApplyImpulse(new b2Vec2(2, 0), b2Body.GetPosition());

            engine.tick();

            const velX = b2Body.GetLinearVelocity().x;
            expect(velX).toBeGreaterThan(0);
        });
    });

    describe('angularDamping', () => {
        it('angularDamping=0 body retains higher angular velocity than angularDamping=5', () => {
            engine = new PhysicsEngine();

            const noDamping: MapBodyDef = {
                name: 'noAngDamp',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                angularDamping: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            const highDamping: MapBodyDef = {
                name: 'highAngDamp',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                angularDamping: 5,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(noDamping);
            engine.addBody(highDamping);

            const bodyMap = engine.getBodyMap();
            const noDampBody = bodyMap.get('noAngDamp');
            const highDampBody = bodyMap.get('highAngDamp');

            noDampBody.ApplyTorque(10);
            highDampBody.ApplyTorque(10);

            for (let i = 0; i < 60; i++) {
                engine.tick();
            }

            const noDampAngVel = Math.abs(noDampBody.GetAngularVelocity());
            const highDampAngVel = Math.abs(highDampBody.GetAngularVelocity());

            expect(noDampAngVel).toBeGreaterThan(highDampAngVel);
        });

        it('angularDamping defaults to 0 when not specified', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'defaultAngBody',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('defaultAngBody');

            expect(b2Body.m_angularDamping).toBe(0);
        });
    });

    describe('linearVelocity', () => {
        it('body with linearVelocity={x:5,y:0} moves right after 1 tick', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'movingBody',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                linearVelocity: { x: 5, y: 0 },
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);
            engine.tick();

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('movingBody');
            const posX = b2Body.GetPosition().x;

            expect(posX).toBeGreaterThan(0);
        });

        it('body without linearVelocity has no horizontal movement', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'staticVelBody',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);
            engine.tick();

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('staticVelBody');
            const posX = b2Body.GetPosition().x;

            expect(Math.abs(posX)).toBeLessThan(0.0001);
        });

        it('body with linearVelocity={x:0,y:-10} moves up', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'upwardBody',
                type: 'circle',
                x: 0, y: 0,
                radius: 10,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                linearVelocity: { x: 0, y: -10 },
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);
            engine.tick();

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('upwardBody');
            const posY = b2Body.GetPosition().y;

            expect(posY).toBeLessThan(0);
        });
    });

    describe('angularVelocity', () => {
        it('body with angularVelocity=5 has positive angular velocity after 1 tick', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'spinningBody',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                angularVelocity: 5,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);
            engine.tick();

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('spinningBody');
            const angVel = b2Body.GetAngularVelocity();

            expect(angVel).toBeGreaterThan(0);
        });

        it('body without angularVelocity has zero initial spin', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'noSpinBody',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);
            engine.tick();

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('noSpinBody');
            const angVel = b2Body.GetAngularVelocity();

            expect(Math.abs(angVel)).toBeLessThan(0.0001);
        });
    });

    describe('collidesWithPlayers', () => {
        it('player falls through floor with collidesWithPlayers=false', () => {
            engine = new PhysicsEngine();

            const floor: MapBodyDef = {
                name: 'ghostFloor',
                type: 'rect',
                x: 0,
                y: 100,
                width: 800,
                height: 30,
                static: true,
                collides: { g1: true, g2: true, g3: true, g4: true },
                collidesWithPlayers: false,
            };

            engine.addBody(floor);
            engine.addPlayer(0, 0, 95);

            for (let i = 0; i < 30; i++) {
                engine.tick();
            }

            const state = engine.getPlayerState(0);
            expect(state.y).toBeGreaterThan(110);
        });

        it('player is stopped by floor with default collidesWithPlayers', () => {
            engine = new PhysicsEngine();

            const floor: MapBodyDef = {
                name: 'solidFloor',
                type: 'rect',
                x: 0,
                y: 100,
                width: 800,
                height: 30,
                static: true,
                collides: { g1: true, g2: true, g3: true, g4: true },
            };

            engine.addBody(floor);
            engine.addPlayer(0, 0, 95);

            for (let i = 0; i < 30; i++) {
                engine.tick();
            }

            const state = engine.getPlayerState(0);
            expect(state.y).toBeLessThanOrEqual(105);
        });
    });

    describe('combined velocities', () => {
        it('body with both linearVelocity and angularVelocity moves and spins', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'comboBody',
                type: 'rect',
                x: 0, y: 0,
                width: 40, height: 20,
                static: false,
                density: 1,
                friction: 0,
                restitution: 0,
                linearVelocity: { x: 3, y: 0 },
                angularVelocity: 2,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);

            for (let i = 0; i < 10; i++) {
                engine.tick();
            }

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('comboBody');
            const posX = b2Body.GetPosition().x;
            const angVel = b2Body.GetAngularVelocity();

            expect(posX).toBeGreaterThan(0);
            expect(Math.abs(angVel)).toBeGreaterThan(0.001);
        });
    });

    describe('static body', () => {
        it('static body ignores linearVelocity and angularVelocity', () => {
            engine = new PhysicsEngine();

            const body: MapBodyDef = {
                name: 'staticBody',
                type: 'rect',
                x: 50, y: 50,
                width: 40, height: 20,
                static: true,
                linearVelocity: { x: 10, y: 10 },
                angularVelocity: 10,
                collides: { g1: false, g2: false, g3: false, g4: false },
            };

            engine.addBody(body);

            const bodyMap = engine.getBodyMap();
            const b2Body = bodyMap.get('staticBody');
            const initialX = b2Body.GetPosition().x;
            const initialY = b2Body.GetPosition().y;
            const initialAngle = b2Body.GetAngle();

            for (let i = 0; i < 10; i++) {
                engine.tick();
            }

            const finalX = b2Body.GetPosition().x;
            const finalY = b2Body.GetPosition().y;
            const finalAngle = b2Body.GetAngle();
            const angVel = b2Body.GetAngularVelocity();

            expect(Math.abs(finalX - initialX)).toBeLessThan(0.0001);
            expect(Math.abs(finalY - initialY)).toBeLessThan(0.0001);
            expect(Math.abs(finalAngle - initialAngle)).toBeLessThan(0.0001);
            expect(Math.abs(angVel)).toBeLessThan(0.0001);
        });
    });
});
