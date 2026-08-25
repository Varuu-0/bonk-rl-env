/**
 * worker-pool-num-opponents-validation.test.ts — Regression coverage for
 * issue #392 on the pooled surfaces.
 *
 * `pool.init(1, { numOpponents: 87 })` previously failed the whole pool with
 * 'Worker pool initialization failed: Cannot read properties of undefined
 * (reading 'next')' — the bundled Box2D pair table exhausted inside the
 * worker's world construction. Validation now rejects out-of-range counts
 * before any worker is spawned, with a labeled error naming numOpponents and
 * the MAX_OPPONENTS bound, and the pool stays usable for a valid re-init.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';
import { MAX_OPPONENTS } from '../../src/core/opponent-capacity';

describe('WorkerPool numOpponents validation (#392)', () => {
  it('rejects an out-of-range numOpponents before spawning workers, and the pool stays usable', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await expect(pool.init(1, { maxTicks: 5, seed: 1, numOpponents: 87 }, true)).rejects.toThrow(
        /Invalid numOpponents 87: expected at most 64 opponents/,
      );
      await expect(pool.init(1, { maxTicks: 5, seed: 1, numOpponents: 87 }, true)).rejects.not.toThrow(
        /reading 'next'/,
      );

      // The rejection fire before any worker world was built: the same
      // pool can be re-initialized with the max-allowed count.
      await pool.init(1, { maxTicks: 5, seed: 1, numOpponents: MAX_OPPONENTS }, true);
      const obs = (await pool.reset([1]))[0];
      expect(obs.opponents.length).toBe(MAX_OPPONENTS);
    } finally {
      await pool.close();
    }
  });

  it('rejects the snake_case num_opponents alias one past the bound in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    for (const useSharedMemory of [true, false]) {
      const pool = new WorkerPool(1);
      try {
        await expect(
          pool.init(1, { maxTicks: 5, seed: 1, num_opponents: MAX_OPPONENTS + 1 }, useSharedMemory),
        ).rejects.toThrow(
          new RegExp(`Invalid numOpponents ${MAX_OPPONENTS + 1}: expected at most ${MAX_OPPONENTS} opponents`),
        );
      } finally {
        await pool.close();
      }
    }
  });

  it('accepts the MAX_OPPONENTS bound in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    for (const useSharedMemory of [true, false]) {
      const pool = new WorkerPool(1);
      try {
        await pool.init(1, { maxTicks: 5, seed: 1, numOpponents: MAX_OPPONENTS }, useSharedMemory);
        const obs = (await pool.reset([1]))[0];
        expect(obs.opponents.length).toBe(MAX_OPPONENTS);
        const stepObs = (await pool.step([2]))[0].observation;
        expect(stepObs.opponents.length).toBe(MAX_OPPONENTS);
      } finally {
        await pool.close();
      }
    }
  });
});
