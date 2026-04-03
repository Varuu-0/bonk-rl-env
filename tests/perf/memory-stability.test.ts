import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

describe('Memory stability', () => {
  it('no significant heap growth after many resets', () => {
    if (global.gc) global.gc();
    const env = new BonkEnvironment({ maxTicks: 5000 });
    const initialHeap = process.memoryUsage().heapUsed;

    for (let i = 0; i < 50; i++) {
      env.reset();
      for (let j = 0; j < 100; j++) {
        env.step(0);
      }
    }

    if (global.gc) global.gc();
    const finalHeap = process.memoryUsage().heapUsed;
    const growthMB = (finalHeap - initialHeap) / (1024 * 1024);

    env.close();
    expect(growthMB).toBeLessThan(20);
  });
});
