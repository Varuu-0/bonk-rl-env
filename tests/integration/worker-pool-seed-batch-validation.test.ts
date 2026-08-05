/**
 * worker-pool-seed-batch-validation.test.ts — Regression coverage for issue #213
 *
 * An over-long seed array (`seeds.length > totalEnvs`) must be rejected as a
 * per-request input error in BOTH transports, without failing the pool.
 * Previously the surplus seeds were silently truncated by the per-worker
 * slices, so `reset([1, 2, 3])` on a 2-env pool dropped seed 3 with no error.
 *
 * Short seed lists remain legal: they reset the tail environments unseeded
 * (the #183 semantics pinned by worker-pool-stale-seeds.test.ts), so only the
 * over-long direction is rejected here.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool reset seed batch validation (issue #213)', () => {
  const runOverlongSequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, { seed: 1 }, useSharedMemory);
      await pool.reset([11, 22]);

      // Over-long batch: per-request error, pool untouched.
      await expect(pool.reset([11, 22, 33])).rejects.toThrow(
        'Invalid seed batch: expected at most 2 seeds for 2 environments, got 3',
      );
      expect(pool.isUsingSharedMemory()).toBe(useSharedMemory);
      expect((pool as any).state).toBe('ready');

      // Non-array seeds are rejected too.
      await expect(pool.reset(42 as any)).rejects.toThrow(
        'Invalid seed batch: expected an array of seeds, got number',
      );

      // Correctly sized follow-ups succeed in both transports.
      await expect(pool.reset([33, 44])).resolves.toHaveLength(2);
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);

      // Short seed lists remain legal (#183): tail envs reset unseeded.
      const partial = await pool.reset([7]);
      expect(partial).toHaveLength(2);
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: over-long seed batch is transient and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runOverlongSequence(true);
  });

  it('message-passing mode: over-long seed batch is transient and the pool recovers', async () => {
    await runOverlongSequence(false);
  });
});
