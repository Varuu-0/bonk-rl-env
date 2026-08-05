/**
 * worker-pool-batch-atomicity.test.ts — Regression coverage for issue #207
 *
 * A malformed step batch (wrong length, or an invalid entry) must be
 * rejected before any worker is signalled, in BOTH transports: no
 * environment may advance on a request that errors. Previously a short
 * batch in message-passing mode advanced every environment before the
 * failure point (worker A's envs and the failing worker's earlier envs)
 * while the pool stayed ready, so every later step ran on permanently
 * desynced states — the same corruption a full-length batch with an
 * `undefined` entry still caused until the entry-level check.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool malformed step batches leave no environment advanced (issue #207)', () => {
  /**
   * Every environment starts at tick 0 after reset and advances by exactly
   * one tick per executed step, so a correct step following a rejected
   * batch must return every environment at baseline + 1 — proving the
   * failed request advanced nothing and the pool resumed from the state
   * before it.
   */
  const assertResumesFromPreErrorState = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(2);
    try {
      await pool.init(4, {}, useSharedMemory);
      const baseline = (await pool.reset([1, 2, 3, 4]))[0].tick;

      await expect(pool.step([0, 0, 0])).rejects.toThrow(
        'Invalid action batch: expected 4 actions for 4 environments, got 3',
      );
      expect((pool as any).state).toBe('ready');

      const results = await pool.step([0, 0, 0, 0]);
      expect(results).toHaveLength(4);
      for (const res of results) {
        expect(res.observation.tick).toBe(baseline + 1);
      }
    } finally {
      await pool.close();
    }
  };

  it('message-passing mode: short batch errors before dispatch and the next step resumes cleanly', async () => {
    await assertResumesFromPreErrorState(false);
  });

  it('shared-memory mode: short batch errors before dispatch and the next step resumes cleanly', async () => {
    if (!WorkerPool.isSupported()) return;
    await assertResumesFromPreErrorState(true);
  });

  const assertInvalidEntryIsAtomic = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(2);
    try {
      await pool.init(4, {}, useSharedMemory);
      const baseline = (await pool.reset([1, 2, 3, 4]))[0].tick;

      await expect(pool.step([0, 0, undefined as any, 0])).rejects.toThrow(
        'Invalid action: expected a PlayerInput object or an encoded number, got undefined',
      );
      expect((pool as any).state).toBe('ready');

      const results = await pool.step([0, 0, 0, 0]);
      expect(results).toHaveLength(4);
      for (const res of results) {
        expect(res.observation.tick).toBe(baseline + 1);
      }
    } finally {
      await pool.close();
    }
  };

  it('message-passing mode: an invalid entry errors before dispatch and the next step resumes cleanly', async () => {
    await assertInvalidEntryIsAtomic(false);
  });

  it('shared-memory mode: an invalid entry errors before dispatch and the next step resumes cleanly', async () => {
    if (!WorkerPool.isSupported()) return;
    await assertInvalidEntryIsAtomic(true);
  });
});
