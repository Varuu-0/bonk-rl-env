import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PhysicsEngine, SCALE } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('DynamicArenaBounds', () => {
  let engine: PhysicsEngine | null = null;
  afterEach(() => { safeDestroy(engine); engine = null; });

  describe('default bounds', () => {
    it('center player alive with no map bodies', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 2200, 0);
      engine.tick();

      const center = engine.getPlayerState(0);
      const outside = engine.getPlayerState(1);
      expect(center.alive).toBe(true);
      expect(outside.alive).toBe(false);
    });
  });

  describe('single body bounds', () => {
    it('player near single body is alive', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'platform',
        type: 'rect',
        x: 0,
        y: 0,
        width: 300,
        height: 30,
        static: true,
      });
      engine.addPlayer(0, 50, 0);
      engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });
  });

  describe('multiple bodies bounds', () => {
    it('player between multiple bodies is alive', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'left', type: 'rect',
        x: -300, y: 0, width: 100, height: 30, static: true,
      });
      engine.addBody({
        name: 'right', type: 'rect',
        x: 300, y: 0, width: 100, height: 30, static: true,
      });
      engine.addPlayer(0, 0, 0);
      engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });
  });

  describe('five metre margin', () => {
    it('player within 5m margin is alive', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'center', type: 'rect',
        x: 0, y: 0, width: 100, height: 30, static: true,
      });
      engine.addPlayer(0, 5 * SCALE, 0);
      engine.tick();

      const inside = engine.getPlayerState(0);
      expect(inside.alive).toBe(true);
    });
  });

  describe('player death outside bounds', () => {
    it('player outside the verified circular boundary is dead', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'small', type: 'rect',
        x: 0, y: 0, width: 100, height: 30, static: true,
      });
      engine.addPlayer(0, 2200, 0);
      engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(false);
    });

    it('player on body stays alive', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'floor', type: 'rect',
        x: 0, y: 100, width: 600, height: 30, static: true,
      });
      engine.addPlayer(0, 0, 80);
      engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });
  });

  describe('large map bounds', () => {
    it('player within large map bounds is alive and player outside is dead', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'wdb-floor', type: 'rect',
        x: 1000, y: 0, width: 1825, height: 30, static: true,
      });
      engine.addPlayer(0, 800, 0);   // inside the verified 850-unit OOB circle
      engine.addPlayer(1, 2300, 0);  // far outside it
      engine.tick();

      const inside = engine.getPlayerState(0);
      const outside = engine.getPlayerState(1);
      expect(inside.alive).toBe(true);
      expect(outside.alive).toBe(false);
    });
  });

  describe('asymmetric bounds', () => {
    it('player near right-side body is alive', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'right-only', type: 'rect',
        x: 600, y: 0, width: 200, height: 30, static: true,
      });
      engine.addPlayer(0, 720, 0);
      engine.addPlayer(1, -10, 0);
      engine.tick();

      const right = engine.getPlayerState(0);
      const left = engine.getPlayerState(1);
      expect(right.alive).toBe(true);
      expect(left.alive).toBe(true);
    });
  });

  describe('bounds recalculation', () => {
    it('reported bounds recalculate on each addBody', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'near', type: 'rect',
        x: 0, y: 0, width: 100, height: 30, static: true,
      });
      const beforeBounds = { ...(engine as any).getArenaBounds() };
      engine.addBody({
        name: 'far', type: 'rect',
        x: 800, y: 0, width: 200, height: 30, static: true,
      });
      const afterBounds = { ...(engine as any).getArenaBounds() };
      expect(afterBounds.halfWidth).toBeGreaterThan(beforeBounds.halfWidth);
    });

    it('reset preserves reported-bound recalculation', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'far', type: 'rect',
        x: 500, y: 0, width: 200, height: 30, static: true,
      });
      // getArenaBounds returns a cached object for the zero-GC observation
      // path; snapshot values before mutating the world.
      const beforeReset = { ...(engine as any).getArenaBounds() };

      engine.reset();

      engine.addBody({
        name: 'small', type: 'rect',
        x: 0, y: 0, width: 100, height: 30, static: true,
      });
      const afterReset = { ...(engine as any).getArenaBounds() };
      expect(afterReset.halfWidth).toBeLessThan(beforeReset.halfWidth);
    });
  });

  describe('incremental bounds (linear per addBody)', () => {
    it('addBody folds extents incrementally instead of rescanning all bodies', () => {
      engine = new PhysicsEngine();
      const spy = vi.spyOn(engine as any, 'calculateArenaBounds');
      for (let i = 0; i < 200; i++) {
        engine.addBody({
          name: `b${i}`,
          type: 'rect',
          x: i * 10,
          y: 0,
          width: 10,
          height: 10,
          static: true,
        });
      }
      // The quadratic path rescaned every body once per add; after the fix a
      // full build must not trigger a single full-world scan from addBody.
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();

      // Bounds are still correct after 200 adds, and identical to a recompute.
      const incremental = { ...(engine as any).getArenaBounds() };
      expect(incremental.halfWidth).toBeGreaterThan(2000); // 66.5m extent + 5m margin
      engine.calculateArenaBounds();
      expect((engine as any).getArenaBounds()).toEqual(incremental);
    });

    it('reset rebases incremental extents on the fresh world', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'far', type: 'rect',
        x: 500, y: 0, width: 200, height: 30, static: true,
      });
      const beforeReset = { ...(engine as any).getArenaBounds() };

      engine.reset();
      engine.addBody({
        name: 'small', type: 'rect',
        x: 0, y: 0, width: 100, height: 30, static: true,
      });
      engine.calculateArenaBounds();
      const afterReset = { ...(engine as any).getArenaBounds() };
      expect(afterReset.halfWidth).toBeLessThan(beforeReset.halfWidth);
    });
  });

  describe('tall body', () => {
    it('tall body expands reported arena half-height', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'wall', type: 'rect',
        x: 0, y: 600, width: 30, height: 300, static: true,
      });
      expect((engine as any).getArenaBounds().halfHeight).toBeGreaterThanOrEqual(900);
    });
  });

  describe('negative coordinates', () => {
    it('negative coordinate bodies expand reported bounds correctly', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'left-platform', type: 'rect',
        x: -600, y: 0, width: 200, height: 30, static: true,
      });
      expect((engine as any).getArenaBounds().halfWidth).toBeGreaterThanOrEqual(850);
    });
  });
});
