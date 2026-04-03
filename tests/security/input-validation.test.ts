import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

describe('Input validation', () => {
  it('handles out-of-range action (100) without crash', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    expect(() => env.step(100)).not.toThrow();
    env.close();
  });

  it('handles negative action without crash', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    expect(() => env.step(-1)).not.toThrow();
    env.close();
  });

  it('handles float action without crash', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    expect(() => env.step(3.14)).not.toThrow();
    env.close();
  });

  it('handles negative seed in reset without crash', () => {
    const env = new BonkEnvironment({ maxTicks: 100 });
    expect(() => env.reset(-42)).not.toThrow();
    env.close();
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
