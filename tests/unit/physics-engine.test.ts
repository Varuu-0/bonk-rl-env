import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PhysicsEngine,
  PlayerInput,
  MapBodyDef,
  ARENA_HALF_WIDTH,
  ARENA_HALF_HEIGHT,
  TPS,
  DT,
  HEAVY_MASS_MULTIPLIER,
} from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('PhysicsEngine', () => {
  let engine: PhysicsEngine | null = null;
  afterEach(() => { safeDestroy(engine); engine = null; });

  describe('initialization', () => {
    it('creates a world', () => {
      engine = new PhysicsEngine();
      expect(engine).toBeDefined();
    });

    it('starts with tick count 0', () => {
      engine = new PhysicsEngine();
      expect(engine.getTickCount()).toBe(0);
    });
  });

  describe('player creation', () => {
    beforeEach(() => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
    });

    it('creates player at origin', () => {
      const state = engine!.getPlayerState(0);
      expect(state.x).toBe(0);
      expect(state.y).toBe(0);
    });

    it('player is alive initially', () => {
      const state = engine!.getPlayerState(0);
      expect(state.alive).toBe(true);
    });

    it('player is not heavy initially', () => {
      const state = engine!.getPlayerState(0);
      expect(state.isHeavy).toBe(false);
    });

    it('player has zero velocity', () => {
      const state = engine!.getPlayerState(0);
      expect(state.velX).toBe(0);
      expect(state.velY).toBe(0);
    });
  });

  describe('physics stepping', () => {
    it('increments tick count', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      const initialTick = engine.getTickCount();
      engine.tick();
      expect(engine.getTickCount()).toBe(initialTick + 1);
    });

    it('tick advances by DT seconds without throwing', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      expect(() => engine!.tick()).not.toThrow();
    });
  });

  describe('input application', () => {
    it('player has velocity after input', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      const input: PlayerInput = {
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      };
      engine.applyInput(0, input);
      engine.tick();
      const state = engine.getPlayerState(0);
      expect(state.velX !== 0 || state.velY !== 0).toBe(true);
    });
  });

  describe('heavy state', () => {
    it('player is heavy after heavy input', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      const heavyInput: PlayerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: true,
        grapple: false,
      };
      engine.applyInput(0, heavyInput);
      engine.tick();
      const state = engine.getPlayerState(0);
      expect(state.isHeavy).toBe(true);
    });

    it('player is not heavy after disabling', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      const heavyInput: PlayerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: true,
        grapple: false,
      };
      engine.applyInput(0, heavyInput);
      engine.tick();
      const lightInput: PlayerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      };
      engine.applyInput(0, lightInput);
      engine.tick();
      const state = engine.getPlayerState(0);
      expect(state.isHeavy).toBe(false);
    });
  });

  describe('arena bounds', () => {
    it('player outside bounds is marked dead', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0);
      engine.tick();
      const state = engine.getPlayerState(1);
      expect(state.alive).toBe(false);
    });
  });

  describe('map bodies', () => {
    it('floor body is added without throwing', () => {
      engine = new PhysicsEngine();
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      expect(() => engine!.addBody(floor)).not.toThrow();
    });

    it('player stays above static floor', () => {
      engine = new PhysicsEngine();
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      engine.addBody(floor);
      engine.addPlayer(0, 0, 150);
      engine.tick();
      const state = engine.getPlayerState(0);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('reset', () => {
    it('tick count increases', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 100, 100);
      engine.tick();
      engine.tick();
      expect(engine.getTickCount()).toBe(2);
    });

    it('tick count resets to 0', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 100, 100);
      engine.tick();
      engine.tick();
      engine.reset();
      expect(engine.getTickCount()).toBe(0);
    });

    it('non-existent player is marked dead after reset', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 100, 100);
      engine.tick();
      engine.reset();
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(false);
    });

    it('new player after reset is alive', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 100, 100);
      engine.tick();
      engine.reset();
      engine.addPlayer(0, 0, 0);
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });
  });

  describe('constants', () => {
    it('TPS is 30', () => {
      expect(TPS).toBe(30);
    });

    it('DT is approximately 1/30', () => {
      expect(DT).toBeCloseTo(1 / 30, 3);
    });

    it('HEAVY_MASS_MULTIPLIER is 3.0', () => {
      expect(HEAVY_MASS_MULTIPLIER).toBe(3.0);
    });
  });

  describe('getAlivePlayerIds', () => {
    it('returns an array', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.tick();
      const aliveIds = engine.getAlivePlayerIds();
      expect(Array.isArray(aliveIds)).toBe(true);
    });

    it('contains alive player 0', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0);
      engine.addPlayer(2, 0, 0);
      engine.tick();
      const aliveIds = engine.getAlivePlayerIds();
      expect(aliveIds.includes(0)).toBe(true);
    });

    it('does not contain dead player 1', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0);
      engine.addPlayer(2, 0, 0);
      engine.tick();
      const aliveIds = engine.getAlivePlayerIds();
      expect(aliveIds.includes(1)).toBe(false);
    });

    it('contains alive player 2', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0);
      engine.addPlayer(2, 0, 0);
      engine.tick();
      const aliveIds = engine.getAlivePlayerIds();
      expect(aliveIds.includes(2)).toBe(true);
    });
  });
});
