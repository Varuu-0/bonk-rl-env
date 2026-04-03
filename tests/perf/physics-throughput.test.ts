import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('Physics throughput', () => {
  it('achieves minimum ticks per second', () => {
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    const steps = 10000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < steps; i++) engine.tick();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
    const tps = steps / elapsed;
    safeDestroy(engine);
    expect(tps).toBeGreaterThan(10000);
  });
});
