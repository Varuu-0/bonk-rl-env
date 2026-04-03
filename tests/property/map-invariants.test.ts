import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { PhysicsEngine, MapBodyDef } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

describe('Map invariants (property-based)', () => {
  it('any valid rect body can be added without crash', () => {
    fc.assert(fc.property(
      fc.float({ min: -1000, max: 1000 }),
      fc.float({ min: -1000, max: 1000 }),
      fc.float({ min: 1, max: 500 }),
      fc.float({ min: 1, max: 500 }),
      (x, y, w, h) => {
        const engine = new PhysicsEngine();
        const body: MapBodyDef = {
          name: 'test', type: 'rect', x, y, width: w, height: h, static: true,
        };
        expect(() => engine.addBody(body)).not.toThrow();
        safeDestroy(engine);
      }
    ));
  });

  it('any valid circle body can be added without crash', () => {
    fc.assert(fc.property(
      fc.float({ min: -1000, max: 1000 }),
      fc.float({ min: -1000, max: 1000 }),
      fc.float({ min: Math.fround(0.1), max: Math.fround(100) }),
      (x, y, r) => {
        const engine = new PhysicsEngine();
        const body: MapBodyDef = {
          name: 'test', type: 'circle', x, y, radius: r, static: true,
        };
        expect(() => engine.addBody(body)).not.toThrow();
        safeDestroy(engine);
      }
    ));
  });

  it('player always dies outside reasonable arena bounds', () => {
    fc.assert(fc.property(
      fc.integer({ min: 5000, max: 50000 }),
      (yPos) => {
        const engine = new PhysicsEngine();
        engine.addPlayer(0, 0, yPos);
        engine.tick();
        const state = engine.getPlayerState(0);
        expect(state.alive).toBe(false);
        safeDestroy(engine);
      }
    ));
  });

  it('same seed always produces same first 10 observations', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 999999 }),
      (seed) => {
        const run = () => {
          const env = new BonkEnvironment({ seed, maxTicks: 100 });
          const obs: number[] = [];
          for (let i = 0; i < 10; i++) {
            const result = env.step(0);
            obs.push(result.observation.playerX, result.observation.playerY);
          }
          env.close();
          return obs;
        };
        const first = run();
        const second = run();
        expect(first).toEqual(second);
      }
    ));
  });
});
