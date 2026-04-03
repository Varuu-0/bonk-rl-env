import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsEngine, PlayerInput, MapBodyDef, SCALE, DT, TPS } from '../../src/core/physics-engine';
import { safeDestroy, makePlatform, GRAPPLE_INPUT } from '../utils/test-helpers';

function noInput(): PlayerInput {
  return { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
}

function makePlatformDef(overrides: Partial<MapBodyDef> & { x: number; y: number }): MapBodyDef {
  return {
    name: overrides.name || 'platform',
    type: 'rect',
    width: overrides.width || 200,
    height: overrides.height || 20,
    static: overrides.static !== undefined ? overrides.static : true,
    ...overrides,
  };
}

describe('GrappleMechanics', () => {
  let engine: PhysicsEngine | null = null;
  afterEach(() => { safeDestroy(engine); engine = null; });

  describe('basic grapple', () => {
    it('attaches grapple and keeps player alive', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p1', x: 0, y: 100 }));
      engine.addPlayer(0, 0, 0);
      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('slingshot', () => {
    it('applies upward impulse with grappleMultiplier 99999', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'slingshot',
        x: 0,
        y: 50,
        grappleMultiplier: 99999,
      }));
      engine.addPlayer(0, 0, 0);

      const beforeState = engine.getPlayerState(0);
      engine.applyInput(0, GRAPPLE_INPUT);
      engine.tick();

      const afterState = engine.getPlayerState(0);
      expect(afterState.velY).toBeLessThan(beforeState.velY);
      expect(afterState.alive).toBe(true);
    });

    it('preserves velocity after impulse', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'boundary',
        x: 0,
        y: -500,
        width: 100,
        height: 10,
      }));
      engine.addBody(makePlatformDef({
        name: 'slingshot',
        x: 0,
        y: 50,
        grappleMultiplier: 99999,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      engine.tick();

      const state1 = engine.getPlayerState(0);
      expect(state1.velY).toBeLessThan(0);
      expect(state1.alive).toBe(true);

      for (let i = 0; i < 5; i++) engine.tick();
      const state2 = engine.getPlayerState(0);
      expect(state2.alive).toBe(true);
    });
  });

  describe('noGrapple', () => {
    it('prevents grapple when noGrapple is true', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'no-grapple-platform',
        x: 0,
        y: 50,
        noGrapple: true,
        noPhysics: true,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 20; i++) engine.tick();
      engine.applyInput(0, noInput());
      for (let i = 0; i < 30; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(100);
    });

    it('allows grapple when noGrapple is false', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'grapple-ok',
        x: 0,
        y: 50,
        noGrapple: false,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });

    it('allows grapple when noGrapple is undefined', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'default-platform',
        x: 0,
        y: 50,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('innerGrapple', () => {
    it('prevents grapple when innerGrapple is true', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inner-grapple-platform',
        x: 0,
        y: 50,
        innerGrapple: true,
        noPhysics: true,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 20; i++) engine.tick();
      engine.applyInput(0, noInput());
      for (let i = 0; i < 30; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(100);
    });

    it('allows grapple when innerGrapple is false', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inner-grapple-false',
        x: 0,
        y: 50,
        innerGrapple: false,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('grapple release', () => {
    it('releases grapple and player falls', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) engine.tick();

      const attachedState = engine.getPlayerState(0);

      engine.applyInput(0, noInput());
      for (let i = 0; i < 30; i++) engine.tick();

      const releasedState = engine.getPlayerState(0);
      expect(releasedState.y).toBeGreaterThan(attachedState.y);
      expect(releasedState.alive).toBe(true);
    });

    it('re-attaches after release', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) engine.tick();

      engine.applyInput(0, noInput());
      for (let i = 0; i < 5; i++) engine.tick();

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('grapple with movement', () => {
    it('allows horizontal velocity while swinging', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'swing-target', x: 100, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 5; i++) engine.tick();

      const rightInput: PlayerInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: true };
      engine.applyInput(0, rightInput);
      for (let i = 0; i < 20; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(Math.abs(state.velX)).toBeGreaterThan(0.1);
      expect(state.alive).toBe(true);
    });
  });

  describe('multiple players', () => {
    it('allows multiple players grappling simultaneously', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p1', x: -100, y: 50 }));
      engine.addBody(makePlatformDef({ name: 'p2', x: 100, y: 50 }));
      engine.addPlayer(0, -100, 0);
      engine.addPlayer(1, 100, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      engine.applyInput(1, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state0 = engine.getPlayerState(0);
      const state1 = engine.getPlayerState(1);
      expect(state0.alive).toBe(true);
      expect(state1.alive).toBe(true);
      expect(state0.y).toBeLessThan(200);
      expect(state1.y).toBeLessThan(200);
    });
  });

  describe('grapple to dynamic body', () => {
    it('grapples to dynamic (non-static) body', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'dynamic-platform',
        x: 0,
        y: 50,
        static: false,
        density: 2.0,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(300);
    });
  });

  describe('grapple distance limit', () => {
    it('fails to grapple when platform is beyond 10m', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'far-platform', x: 0, y: 0 }));
      engine.addPlayer(0, 0, 500);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 20; i++) engine.tick();

      engine.applyInput(0, noInput());
      for (let i = 0; i < 10; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(400);
    });
  });

  describe('heavy + grapple combo', () => {
    it('player survives heavy and grapple simultaneously', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      const heavyGrapple: PlayerInput = { left: false, right: false, up: false, down: false, heavy: true, grapple: true };
      engine.applyInput(0, heavyGrapple);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.isHeavy).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('rapid grapple toggle', () => {
    it('player survives rapid grapple on/off cycling', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      for (let cycle = 0; cycle < 5; cycle++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
        engine.applyInput(0, noInput());
        engine.tick();
      }

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const finalState = engine.getPlayerState(0);
      expect(finalState.y).toBeLessThan(200);
    });
  });

  describe('no grapple without platform', () => {
    it('player falls freely when no platform is available', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 30; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(100);
    });
  });
});
