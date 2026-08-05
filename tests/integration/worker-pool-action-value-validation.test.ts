/**
 * worker-pool-action-value-validation.test.ts — Regression coverage for issue #225
 *
 * A full-length step batch whose entries are string/boolean values must be
 * rejected as a per-request input error in BOTH transports, identically to the
 * length check (#191) and malformed-entry checks (#207). Previously
 * shared-memory mode rejected such entries inside `encodeAction()` while
 * message passing forwarded the raw values to the worker, where
 * `decodeAction()`/`applyInput()` silently treated them as all-falsy no-ops —
 * the identical request errored in one transport and silently dropped the
 * action in the other, silently corrupting trajectories.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool action value validation (issue #225)', () => {
  const runRejectionSequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, useSharedMemory);
      const baseline = (await pool.reset([1, 2]))[0].tick;

      // String and boolean entries are the malformed shapes the issue
      // reproduces. Every rejection must carry the offending type in the same
      // message in both transports and must leave the pool ready.
      const invalidBatches: [any[], string][] = [
        [['3', 0], 'string'],
        [[true, 0], 'boolean'],
      ];
      for (const [actions, type] of invalidBatches) {
        await expect(pool.step(actions)).rejects.toThrow(
          `Invalid action: expected a PlayerInput object or an encoded number, got ${type}`,
        );
        expect((pool as any).state).toBe('ready');
      }

      // Rejections happened before any worker state was touched: the next
      // valid step advances every environment exactly one tick from baseline.
      const results = await pool.step([0, 0]);
      expect(results).toHaveLength(2);
      for (const res of results) {
        expect(res.observation.tick).toBe(baseline + 1);
      }
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: string/boolean action values are rejected and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runRejectionSequence(true);
  });

  it('message-passing mode: string/boolean action values are rejected and the pool recovers', async () => {
    await runRejectionSequence(false);
  });
});