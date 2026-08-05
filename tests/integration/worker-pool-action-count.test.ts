/**
 * worker-pool-action-count.test.ts — Regression coverage for issue #191
 *
 * A step whose action array length does not match the number of environments
 * must be rejected as a per-request input error in BOTH transports, without
 * failing the worker pool. Previously, shared-memory mode encoded `undefined`
 * for the tail environments and the resulting TypeError permanently failed the
 * pool, while message mode recovered — a transport divergence.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool action batch validation (issue #191)', () => {
  const runRecoverySequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, useSharedMemory);
      await pool.reset([11, 22]);

      // Short batch: per-request error, pool untouched.
      await expect(pool.step([0])).rejects.toThrow(
        'Invalid action batch: expected 2 actions for 2 environments, got 1',
      );
      expect(pool.isUsingSharedMemory()).toBe(useSharedMemory);
      expect((pool as any).state).toBe('ready');

      // Correctly sized follow-ups succeed in both transports.
      const results = await pool.step([0, 0]);
      expect(results).toHaveLength(2);
      const obs = await pool.reset([33, 44]);
      expect(obs).toHaveLength(2);
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: short batch is transient and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runRecoverySequence(true);
  });

  it('message-passing mode: short batch is transient and the pool recovers', async () => {
    await runRecoverySequence(false);
  });

  it('shared-memory mode: over-long batch is transient and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, true);
      await pool.reset([1, 2]);

      await expect(pool.step([0, 0, 0])).rejects.toThrow(
        'Invalid action batch: expected 2 actions for 2 environments, got 3',
      );
      expect((pool as any).state).toBe('ready');
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);
    } finally {
      await pool.close();
    }
  });

  it('shared-memory mode: a null action is a labeled transient error', async () => {
    if (!WorkerPool.isSupported()) return;
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, true);
      await pool.reset([1, 2]);

      await expect(pool.step([null as any, 0])).rejects.toThrow(
        'Invalid action: expected a PlayerInput object or an encoded number, got null',
      );
      expect((pool as any).state).toBe('ready');
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);
    } finally {
      await pool.close();
    }
  });
});
