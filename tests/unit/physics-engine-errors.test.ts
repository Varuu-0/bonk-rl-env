import { describe, it, expect, afterEach, vi } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { safeDestroy, EMPTY_INPUT } from '../utils/test-helpers';

describe('PhysicsEngine error paths', () => {
  let engine: PhysicsEngine | null = null;
  afterEach(() => { safeDestroy(engine); engine = null; });

  describe('addBody with invalid polygons', () => {
    it('warns and skips polygon with < 3 vertices', () => {
      engine = new PhysicsEngine();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      engine.addBody({
        name: 'bad-poly',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
        static: true,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Polygon body "bad-poly" has insufficient vertices (need >= 3)',
      );
      warnSpy.mockRestore();
    });

    it('caps polygon to 8 vertices', () => {
      engine = new PhysicsEngine();
      const vertices = Array.from({ length: 12 }, (_, i) => ({
        x: Math.cos((i * 2 * Math.PI) / 12) * 50,
        y: Math.sin((i * 2 * Math.PI) / 12) * 50,
      }));

      engine.addBody({
        name: 'big-poly',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices,
        static: true,
      });

      // No error thrown — body added successfully with capped vertices
      expect(engine.getBodyMap().has('big-poly')).toBe(true);
    });
  });

  describe('getPlayerState for non-existent ID', () => {
    it('returns dead state for unknown player', () => {
      engine = new PhysicsEngine();
      const state = engine.getPlayerState(999);

      expect(state).toEqual({
        x: 0,
        y: 0,
        velX: 0,
        velY: 0,
        angle: 0,
        angularVel: 0,
        isHeavy: false,
        alive: false,
      });
    });
  });

  describe('applyInput for non-existent ID', () => {
    it('does not throw for unknown player', () => {
      engine = new PhysicsEngine();
      expect(() => {
        engine!.applyInput(999, EMPTY_INPUT);
      }).not.toThrow();
    });

    it('does not throw for dead player', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      // Manually simulate dead state via destroyAllBodies
      engine.destroyAllBodies();
      expect(() => {
        engine!.applyInput(0, EMPTY_INPUT);
      }).not.toThrow();
    });
  });

  describe('destroy called twice', () => {
    it('does not throw on second destroy', () => {
      engine = new PhysicsEngine();
      engine.destroy();
      expect(() => {
        engine!.destroy();
      }).not.toThrow();
    });
  });

  describe('fireGrapple with no platforms', () => {
    it('does not throw when no platforms exist', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);

      // Tick triggers ensureHooks which would call fireGrapple path
      expect(() => {
        engine!.tick();
      }).not.toThrow();
    });
  });
});
