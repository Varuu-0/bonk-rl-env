import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

describe('Input validation', () => {
  it('rejects out-of-range action (100) with a labeled error', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    try {
      expect(() => env.step(100)).toThrow('Invalid action: expected an encoded action in [0, 63], got 100');
    } finally {
      env.close();
    }
  });

  it('rejects negative action with a labeled error', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    try {
      expect(() => env.step(-1)).toThrow('Invalid action: expected an encoded action in [0, 63], got -1');
    } finally {
      env.close();
    }
  });

  it('rejects float action with a labeled error', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    try {
      expect(() => env.step(3.14)).toThrow('Invalid action: expected an encoded action in [0, 63], got 3.14');
    } finally {
      env.close();
    }
  });

  it('rejects negative seed in reset with a labeled error (#460)', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    try {
      // A negative seed used to bit-cast through the PRNG's `seed >>> 0`
      // onto a different stream (#460); it now rejects with the same
      // labeled error the pool transports raise, leaving the environment
      // usable for a subsequent valid reset.
      expect(() => env.reset(-42)).toThrow('Seed -42 out of supported range [0, 4294967294] for reset');
      expect(() => env.reset(42)).not.toThrow();
    } finally {
      env.close();
    }
  });

  it('handles addBody with missing required fields without crash', () => {
    const engine = new PhysicsEngine();
    const body = { name: 'test', type: 'rect', x: 0, y: 0, static: true } as any;
    expect(() => engine.addBody(body)).not.toThrow();
    safeDestroy(engine);
  });

  it('handles addBody with null name without crash', () => {
    const engine = new PhysicsEngine();
    const body = { name: null, type: 'rect', x: 0, y: 0, width: 10, height: 10, static: true } as any;
    expect(() => engine.addBody(body)).not.toThrow();
    safeDestroy(engine);
  });
});
