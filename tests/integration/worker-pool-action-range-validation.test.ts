/**
 * worker-pool-action-range-validation.test.ts — Regression coverage for issue #261
 *
 * Encoded actions outside the documented Discrete(64) space [0, 63] must be
 * rejected as a per-request input error in BOTH transports. Previously
 * `encodeAction()` passed any number through unchanged and `decodeAction()`
 * read only bits 0–5, so 64 executed the no-op action 0, 100 executed
 * up+grapple (100 & 63 = 36), and 255 executed every flag — the identical
 * request silently ran a different action than the caller asked for, with no
 * error in either transport.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool action range validation (issue #261)', () => {
  const runRejectionSequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, useSharedMemory);
      const baseline = (await pool.reset([1, 2]))[0].tick;

      // Values outside [0, 63] carry bits decodeAction() never reads and
      // would be silently re-interpreted as a different action. Every
      // rejection must carry the offending value in both transports and
      // must leave the pool ready.
      const invalidActions = [-1, 64, 100, 255];
      for (const action of invalidActions) {
        await expect(pool.step([action, 0])).rejects.toThrow(
          `Invalid action: expected an encoded action in [0, 63], got ${action}`,
        );
        expect((pool as any).state).toBe('ready');
      }

      // Boundary values [0, 63] remain valid in both transports. Rejections
      // happened before any worker state was touched: this step advances
      // every environment exactly one tick from baseline.
      const results = await pool.step([0, 63]);
      expect(results).toHaveLength(2);
      for (const res of results) {
        expect(res.observation.tick).toBe(baseline + 1);
      }
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: out-of-range action values are rejected and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runRejectionSequence(true);
  });

  it('message-passing mode: out-of-range action values are rejected and the pool recovers', async () => {
    await runRejectionSequence(false);
  });
});
