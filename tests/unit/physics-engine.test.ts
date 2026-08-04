import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PhysicsEngine,
  PlayerInput,
  MapBodyDef,
  ARENA_HALF_WIDTH,
  ARENA_HALF_HEIGHT,
  TPS,
  DT,
  HEAVY_FORCE_MULTIPLIER,
  GRAVITY_Y,
  MOVE_FORCE,
  DEFAULT_PPM,
  OUT_OF_BOUNDS_DISTANCE,
  VELOCITY_ITERATIONS,
  POSITION_ITERATIONS,
  SCALE,
} from '../../src/core/physics-engine';
import { safeDestroy, UP_INPUT } from '../utils/test-helpers';

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

    it('applies movement through the center of mass without torque', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);

      // @ts-ignore -- box2d has no type declarations
      const { b2CircleDef } = require('box2d');
      const body = (engine as any).playerBodies.get(0);
      const offsetFixture = new b2CircleDef();
      offsetFixture.radius = 0.4;
      offsetFixture.localPosition.Set(1, 0);
      offsetFixture.density = 1;
      body.CreateShape(offsetFixture);
      body.SetMassFromShapes();

      expect(body.GetWorldCenter().x).not.toBe(body.GetPosition().x);

      engine.applyInput(0, UP_INPUT);
      engine.tick();

      expect(engine.getPlayerState(0).angularVel).toBeCloseTo(0, 12);
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
      engine.addPlayer(1, 3000, 0);
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

    it('HEAVY_FORCE_MULTIPLIER is 0.7', () => {
      expect(HEAVY_FORCE_MULTIPLIER).toBe(0.7);
    });

    // Verified native bonk.io physics constants (DEOBFUSCATION.md).
    it('GRAVITY_Y is 20 (not 10)', () => {
      expect(GRAVITY_Y).toBe(20);
    });

    it('MOVE_FORCE is 12', () => {
      expect(MOVE_FORCE).toBe(12);
    });

    it('DEFAULT_PPM is 12', () => {
      expect(DEFAULT_PPM).toBe(12);
    });

    it('VELOCITY_ITERATIONS is 2 and POSITION_ITERATIONS is 6', () => {
      expect(VELOCITY_ITERATIONS).toBe(2);
      expect(POSITION_ITERATIONS).toBe(6);
    });

    it('OUT_OF_BOUNDS_DISTANCE is 850 map units (consumed as 850/SCALE world units)', () => {
      expect(OUT_OF_BOUNDS_DISTANCE).toBe(850);
    });

    it('SCALE is 30', () => {
      expect(SCALE).toBe(30);
    });
  });

  describe('out-of-bounds boundary', () => {
    // Verified (DEOBFUSCATION Death Type 4): the native death circle is
    // exactly 850 map-coordinate units — the 850/ppm world-unit formula cancels
    // because native world = map px / ppm. This port converts px with SCALE,
    // so the threshold is 850/SCALE = 28.33m world (= 850 map units).
    it('player just inside the circular OOB radius survives', () => {
      engine = new PhysicsEngine();
      // 820 map units -> 27.33m < 28.33m threshold
      engine.addPlayer(0, 820, 0);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(true);
    });

    it('player beyond the circular OOB radius is eliminated with deathType 4', () => {
      engine = new PhysicsEngine();
      // 900 map units -> 30.0m > 28.33m threshold (native kills at 850 px)
      engine.addPlayer(0, 900, 0);
      engine.tick();
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(false);
      expect(state.deathType).toBe(4);
    });

    it('OOB radius is ppm-independent (same death circle after setScale)', () => {
      engine = new PhysicsEngine();
      engine.setScale(4);
      // 900 map units with ppm=4: the ppm must not widen the death circle.
      engine.addPlayer(0, 900, 0);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(false);
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
      engine.addPlayer(1, 3000, 0);
      engine.addPlayer(2, 0, 0);
      engine.tick();
      const aliveIds = engine.getAlivePlayerIds();
      expect(aliveIds.includes(0)).toBe(true);
    });

    it('does not contain dead player 1', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 3000, 0);
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
