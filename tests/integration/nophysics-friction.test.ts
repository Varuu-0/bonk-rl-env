/**
 * nophysics-friction.test.ts — Vitest migration for noPhysics sensor support and friction property
 *
 * Tests:
 * 1. noPhysics: true creates sensor (pass-through body)
 * 2. noPhysics: false creates normal body
 * 3. noPhysics undefined creates normal body
 * 4. Sensor still triggers lethal
 * 5. Multiple noPhysics bodies
 * 6. Mixed noPhysics and normal bodies
 * 7. Default friction (0.3)
 * 8. Custom friction low (0.1)
 * 9. Custom friction high (1.0)
 * 10. Friction affects sliding distance
 * 11. Friction on dynamic bodies
 * 12. noPhysics with circle shape
 * 13. noPhysics with polygon shape
 * 14. noPhysics body with restitution still passes through
 * 15. noPhysics combined with grapple properties
 * 16. Friction zero is fully slippery
 * 17. Friction comparison: low vs high over same distance
 * 18. noPhysics lethal sensor positioned on floor
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PhysicsEngine, PlayerInput, MapBodyDef, SCALE, DT, TPS, ARENA_HALF_WIDTH, ARENA_HALF_HEIGHT } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

const inputUp: PlayerInput = {
  left: false,
  right: false,
  up: true,
  down: false,
  heavy: false,
  grapple: false,
};

const inputRight: PlayerInput = {
  left: false,
  right: true,
  up: false,
  down: false,
  heavy: false,
  grapple: false,
};

const inputNone: PlayerInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  heavy: false,
  grapple: false,
};

describe('NoPhysicsFriction', () => {
  describe('noPhysics sensor tests', () => {
    it('player passes through noPhysics wall (y < 85)', () => {
      const engine = new PhysicsEngine();
      const wall: MapBodyDef = {
        name: 'ghost-wall',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
      };
      engine.addBody(wall);
      engine.addPlayer(0, 0, 120);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 85).toBe(true);
      expect(state.alive).toBe(true);
      safeDestroy(engine);
    });

    it('player is blocked by noPhysics: false wall (y >= 85)', () => {
      const engine = new PhysicsEngine();
      const wall: MapBodyDef = {
        name: 'solid-wall',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: false,
      };
      engine.addBody(wall);
      engine.addPlayer(0, 0, 120);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y >= 85).toBe(true);
      safeDestroy(engine);
    });

    it('player is blocked by wall without noPhysics (y >= 85)', () => {
      const engine = new PhysicsEngine();
      const wall: MapBodyDef = {
        name: 'default-wall',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
      };
      engine.addBody(wall);
      engine.addPlayer(0, 0, 120);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y >= 85).toBe(true);
      safeDestroy(engine);
    });

    it('sensor passes player through (x > 70) and lethal sensor kills player', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
      });
      const lethalWall: MapBodyDef = {
        name: 'lethal-sensor',
        type: 'rect',
        x: 80,
        y: 150,
        width: 20,
        height: 200,
        static: true,
        noPhysics: true,
        isLethal: true,
      };
      engine.addBody(lethalWall);
      engine.addPlayer(0, 0, 185);
      for (let i = 0; i < 15; i++) engine.tick();
      for (let i = 0; i < 90; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > 70).toBe(true);
      expect(state.alive).toBe(false);
      safeDestroy(engine);
    });

    it('player passes through all three ghost walls (y < 50)', () => {
      const engine = new PhysicsEngine();
      const walls: MapBodyDef[] = [
        { name: 'ghost-1', type: 'rect', x: 0, y: 60, width: 800, height: 20, static: true, noPhysics: true },
        { name: 'ghost-2', type: 'rect', x: 0, y: 80, width: 800, height: 20, static: true, noPhysics: true },
        { name: 'ghost-3', type: 'rect', x: 0, y: 100, width: 800, height: 20, static: true, noPhysics: true },
      ];
      for (const w of walls) engine.addBody(w);
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 50).toBe(true);
      expect(state.alive).toBe(true);
      safeDestroy(engine);
    });

    it('player passes through ghost wall (y < 100) and is blocked by solid wall (y >= 50)', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'ghost-wall',
        type: 'rect',
        x: 0,
        y: 110,
        width: 800,
        height: 20,
        static: true,
        noPhysics: true,
      });
      engine.addBody({
        name: 'solid-wall',
        type: 'rect',
        x: 0,
        y: 60,
        width: 800,
        height: 20,
        static: true,
        noPhysics: false,
      });
      engine.addPlayer(0, 0, 125);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 100).toBe(true);
      expect(state.y >= 50).toBe(true);
      safeDestroy(engine);
    });
  });

  describe('friction property tests', () => {
    it('player settles on default-friction floor and moves right', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'default-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
      });
      engine.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) {
        engine.tick();
      }
      const settleState = engine.getPlayerState(0);
      expect(settleState.y >= 165 && settleState.y <= 180).toBe(true);
      for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const slideState = engine.getPlayerState(0);
      expect(slideState.x > 0).toBe(true);
      expect(slideState.velX > 0).toBe(true);
      safeDestroy(engine);
    });

    it('player moves on low friction surface', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'slippery-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
        friction: 0.1,
      });
      engine.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engine.tick();
      for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > 0).toBe(true);
      expect(state.velX > 0).toBe(true);
      safeDestroy(engine);
    });

    it('player moves on high friction surface', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'grippy-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
        friction: 1.0,
      });
      engine.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engine.tick();
      for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > 0).toBe(true);
      expect(state.velX > 0).toBe(true);
      safeDestroy(engine);
    });

    it('low friction slides further or equal (low.x >= high.x)', () => {
      const engineLow = new PhysicsEngine();
      engineLow.addBody({
        name: 'slippery',
        type: 'rect',
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 0.1,
      });
      engineLow.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engineLow.tick();
      for (let i = 0; i < 45; i++) {
        engineLow.applyInput(0, inputRight);
        engineLow.tick();
      }
      const stateLow = engineLow.getPlayerState(0);

      const engineHigh = new PhysicsEngine();
      engineHigh.addBody({
        name: 'grippy',
        type: 'rect',
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 1.0,
      });
      engineHigh.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engineHigh.tick();
      for (let i = 0; i < 45; i++) {
        engineHigh.applyInput(0, inputRight);
        engineHigh.tick();
      }
      const stateHigh = engineHigh.getPlayerState(0);

      expect(stateLow.x >= stateHigh.x - 1).toBe(true);
      expect(stateLow.velX >= stateHigh.velX - 1).toBe(true);
      safeDestroy(engineLow);
      safeDestroy(engineHigh);
    });

    it('dynamic body with friction does not crash simulation', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'dynamic-platform',
        type: 'rect',
        x: 0,
        y: 200,
        width: 300,
        height: 20,
        static: false,
        density: 2.0,
        friction: 0.8,
      });
      engine.addBody({
        name: 'catch-floor',
        type: 'rect',
        x: 0,
        y: 250,
        width: 2000,
        height: 30,
        static: true,
      });
      engine.addPlayer(0, 0, 180);
      for (let i = 0; i < 30; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      safeDestroy(engine);
    });
  });

  describe('noPhysics shape variants', () => {
    it('player passes through noPhysics circle (y < 40)', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'ghost-circle',
        type: 'circle',
        x: 0,
        y: 80,
        radius: 40,
        static: true,
        noPhysics: true,
      });
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 40).toBe(true);
      safeDestroy(engine);
    });

    it('player passes through noPhysics polygon (y < 85)', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'ghost-poly',
        type: 'polygon',
        x: 0,
        y: 100,
        vertices: [
          { x: -50, y: -15 },
          { x: 50, y: -15 },
          { x: 0, y: 15 },
        ],
        static: true,
        noPhysics: true,
      });
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 85).toBe(true);
      safeDestroy(engine);
    });

    it('player passes through noPhysics body with high restitution (y < 85)', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'bouncy-ghost',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
        restitution: 0.9,
      });
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 85).toBe(true);
      safeDestroy(engine);
    });

    it('player passes through noPhysics+noGrapple body (y < 85)', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'ghost-no-grapple',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
        noGrapple: true,
      });
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 85).toBe(true);
      safeDestroy(engine);
    });
  });

  describe('additional friction tests', () => {
    it('zero friction player moves right and slides equal or further than default', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'ice-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 0.0,
      });
      engine.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engine.tick();
      for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const stateZero = engine.getPlayerState(0);

      const engineDefault = new PhysicsEngine();
      engineDefault.addBody({
        name: 'normal-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
      });
      engineDefault.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engineDefault.tick();
      for (let i = 0; i < 30; i++) {
        engineDefault.applyInput(0, inputRight);
        engineDefault.tick();
      }
      const stateDefault = engineDefault.getPlayerState(0);

      expect(stateZero.x > 0).toBe(true);
      expect(stateZero.x >= stateDefault.x - 1).toBe(true);
      safeDestroy(engine);
      safeDestroy(engineDefault);
    });

    it('low friction travels further or equal and both players moved right', () => {
      const engineLow = new PhysicsEngine();
      engineLow.addBody({
        name: 'low-friction-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 10000,
        height: 30,
        static: true,
        friction: 0.05,
      });
      engineLow.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engineLow.tick();

      const engineHigh = new PhysicsEngine();
      engineHigh.addBody({
        name: 'high-friction-floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 10000,
        height: 30,
        static: true,
        friction: 1.5,
      });
      engineHigh.addPlayer(0, 0, 183);
      for (let i = 0; i < 20; i++) engineHigh.tick();

      for (let i = 0; i < 60; i++) {
        engineLow.applyInput(0, inputRight);
        engineLow.tick();
        engineHigh.applyInput(0, inputRight);
        engineHigh.tick();
      }

      const stateLow = engineLow.getPlayerState(0);
      const stateHigh = engineHigh.getPlayerState(0);

      expect(stateLow.x >= stateHigh.x - 2).toBe(true);
      expect(stateLow.x > 0 && stateHigh.x > 0).toBe(true);
      safeDestroy(engineLow);
      safeDestroy(engineHigh);
    });
  });

  describe('combined noPhysics + friction scenarios', () => {
    it('player settles on floor before lethal sensor, passes through sensor wall (x > 90), and lethal sensor kills player', () => {
      const engine = new PhysicsEngine();
      engine.addBody({
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
      });
      engine.addBody({
        name: 'lethal-sensor-wall',
        type: 'rect',
        x: 100,
        y: 150,
        width: 20,
        height: 200,
        static: true,
        noPhysics: true,
        isLethal: true,
      });
      engine.addPlayer(0, 0, 185);
      for (let i = 0; i < 15; i++) engine.tick();
      const settled = engine.getPlayerState(0);
      expect(settled.alive).toBe(true);
      for (let i = 0; i < 90; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
      }
      const finalState = engine.getPlayerState(0);
      expect(finalState.x > 90).toBe(true);
      expect(finalState.alive).toBe(false);
      safeDestroy(engine);
    });
  });
});
