import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

// global.gc is exposed to test forks via `execArgv: ['--expose-gc']` in
// vitest.config.ts. Asserting the precondition makes the heap-growth
// measurement meaningful: it samples actual retained memory after a forced
// GC, not whatever V8 happened to have collected between two raw samples.
function forceFullGC(): void {
  if (typeof global.gc !== 'function') {
    throw new Error(
      'global.gc is unavailable: vitest must run with --expose-gc (see vitest.config.ts `execArgv`)'
    );
  }
  global.gc();
  global.gc();
}

describe('Memory stability', () => {
  it('no significant heap growth after many resets', () => {
    const env = new BonkEnvironment({ maxTicks: 5000 });
    forceFullGC();
    const initialHeap = process.memoryUsage().heapUsed;

    for (let i = 0; i < 50; i++) {
      env.reset();
      for (let j = 0; j < 100; j++) {
        env.step(0);
      }
    }

    forceFullGC();
    const finalHeap = process.memoryUsage().heapUsed;
    const growthMB = (finalHeap - initialHeap) / (1024 * 1024);

    env.close();
    expect(growthMB).toBeLessThan(20);
  });
});
