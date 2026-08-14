import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    it('getScale reports the coordinate scale, unaffected by setPpm', () => {
      engine = new PhysicsEngine();
      expect(engine.getScale()).toBe(SCALE);
      engine.setPpm(4);
      expect(engine.getScale()).toBe(SCALE); // PPM shapes the disc radius, not the coordinate conversion
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

    it('player disc fixture matches the verified native values (mass exactly 1)', () => {
      const body = (engine as any).playerBodies.get(0);
      const shape = body.GetShapeList();

      // density = 1/(pi*r^2) with r = ppm/SCALE = 0.4 -> mass exactly 1
      expect(shape.m_density).toBeCloseTo(1 / (Math.PI * 0.4 * 0.4), 10);
      expect(body.GetMass()).toBeCloseTo(1.0, 10);
      expect(shape.m_friction).toBe(0.001337);
      expect(shape.m_restitution).toBe(0.95);
    });

    it('player disc density is radius-normalized for other ppm values too', () => {
      engine = new PhysicsEngine();
      engine.setPpm(6); // radius 6/30 = 0.2
      engine.addPlayer(0, 0, 0);
      const body = (engine as any).playerBodies.get(0);
      const shape = body.GetShapeList();
      expect(shape.m_density).toBeCloseTo(1 / (Math.PI * 0.2 * 0.2), 10);
      expect(body.GetMass()).toBeCloseTo(1.0, 10);
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

    // DEOBFUSCATION.md §35.5: native movement-force base is 12 (flipped 20),
    // scaled by radius^2 (the disc mass ratio, pinned to 1 by the mass-1
    // fixture) and ×0.7 for heavy. #234 raises the default base to 30 (the
    // smallest round value above the heavy-lift threshold 20/0.7 ≈ 28.57) so
    // the verified mass-1 disc out-thrusts gravity 20 — pure "up" and even
    // up+heavy must produce upward acceleration.
    it('MOVE_FORCE is 30', () => {
      expect(MOVE_FORCE).toBe(30);
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

    it('OOB radius is ppm-independent (same death circle after setPpm)', () => {
      engine = new PhysicsEngine();
      engine.setPpm(4);
      // 900 map units with ppm=4: the ppm must not widen the death circle.
      engine.addPlayer(0, 900, 0);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(false);
    });

    it('death circle follows the configured map center, not the world origin', () => {
      engine = new PhysicsEngine();
      // Map centered at (800, 800) map units (an arena offset from the world
      // origin, like the bundled exports): the disc at spawn is ~50 units
      // from the map center and must survive the first tick.
      engine.setDeathCircleCenter(800, 800);
      engine.addPlayer(0, 800, 850);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(true);

      // A disc more than 850 map units from the map center still dies with
      // deathType 4 (native rule, measured from the map center).
      engine.addPlayer(1, 800, 1700); // 900 map units from (800, 800)
      engine.tick();
      const outside = engine.getPlayerState(1);
      expect(outside.alive).toBe(false);
      expect(outside.deathType).toBe(4);
    });

    it('reset() clears a stale death-circle center back to the origin default', () => {
      engine = new PhysicsEngine();
      // Map centered at (800, 800): the disc ~50 units from that center survives.
      engine.setDeathCircleCenter(800, 800);
      engine.addPlayer(0, 800, 850);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(true);

      // Reused for a map WITHOUT a deathCenter: the stale (800, 800) center must
      // not persist, so the same disc (~1167 from the origin) is now OOB.
      engine.reset();
      engine.addPlayer(0, 800, 850);
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(false);
      expect(engine.getPlayerState(0).deathType).toBe(4);
    });

    it('non-finite death-circle center is ignored and never disables OOB', () => {
      engine = new PhysicsEngine();
      engine.setDeathCircleCenter(NaN, NaN);

      // A disc just beyond the origin-based OOB radius must still die: the
      // rejected NaN center must not have disabled the OOB check map-wide.
      engine.addPlayer(0, 900, 0);
      engine.tick();
      const killed = engine.getPlayerState(0);
      expect(killed.alive).toBe(false);
      expect(killed.deathType).toBe(4);

      // And a non-finite center must not clobber a previously valid one.
      engine.reset();
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      engine.setDeathCircleCenter(800, 800);
      engine.setDeathCircleCenter(Infinity, 0);
      warned.mockRestore();
      engine.addPlayer(1, 800, 850); // safe if center stayed (800, 800)
      engine.tick();
      expect(engine.getPlayerState(1).alive).toBe(true);
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

  describe('dead-disc final state observability', () => {
    it('snapshots final transforms and velocity so they stay readable and stable across post-death ticks', () => {
      engine = new PhysicsEngine();
      // Player starts beyond the circular OOB boundary and dies on the first tick.
      engine.addPlayer(0, 900, -900);
      engine.tick();

      const deathState = engine.getPlayerState(0);
      expect(deathState.alive).toBe(false);
      expect(deathState.deathType).toBe(4);
      // The snapshot must capture real transforms, not the zero default.
      expect(deathState.x).not.toBe(0);
      expect(deathState.y).not.toBe(0);

      for (let i = 0; i < 5; i++) {
        engine.tick();
        const state = engine.getPlayerState(0);
        expect(state.alive).toBe(false);
        expect(state.deathType).toBe(4);
        expect(state.x).toBe(deathState.x);
        expect(state.y).toBe(deathState.y);
        expect(state.velX).toBe(deathState.velX);
        expect(state.velY).toBe(deathState.velY);
        expect(state.angle).toBe(deathState.angle);
        expect(state.angularVel).toBe(deathState.angularVel);
      }
    });

    it('releases the destroyed body from playerBodies on detach so observations never read it', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 900, 0);
      engine.tick();

      expect((engine as any).playerBodies.has(0)).toBe(true);
      expect((engine as any).playerBodies.has(1)).toBe(false);
      expect((engine as any).detachedPlayerStates.has(1)).toBe(true);

      // A subsequent tick keeps player 0's live body intact and does not touch
      // the already-detached dead disc again.
      engine.tick();
      expect((engine as any).playerBodies.has(0)).toBe(true);
      expect((engine as any).playerBodies.has(1)).toBe(false);
      expect(engine.getPlayerState(0).alive).toBe(true);
    });
  });
});
