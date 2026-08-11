/**
 * worker-pool-action-value-validation.test.ts — Regression coverage for issues #225 and #278
 *
 * A full-length step batch whose entries are malformed action values must be
 * rejected as a per-request input error in BOTH transports, identically to the
 * length check (#191) and malformed-entry checks (#207). Issue #225 covered
 * string/boolean values; issue #278 extends the rejection to every other
 * wrong-shaped value — arrays, empty objects, non-boolean field values, NaN,
 * and null — which previously slipped through `encodeAction()` and were
 * silently encoded as a different (usually no-op) action in both transports,
 * or crashed with an opaque TypeError on the direct environment.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool action value validation (issues #225/#278)', () => {
  const runRejectionSequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, {}, useSharedMemory);
      const baseline = (await pool.reset([1, 2]))[0].tick;

      // Every malformed shape must be rejected with a labeled error in both
      // transports and must leave the pool ready. `NaN` stringifies as `null`,
      // so the batch labels use the shape rather than a JSON round-trip.
      const invalidBatches: [any[], string][] = [
        [['3', 0], 'Invalid action: expected a PlayerInput object or an encoded number, got string'],
        [[true, 0], 'Invalid action: expected a PlayerInput object or an encoded number, got boolean'],
        [[null, 0], 'Invalid action: expected a PlayerInput object or an encoded number, got null'],
        [[NaN, 0], 'Invalid action: expected a finite encoded number, got NaN'],
        [[[2], 0], 'Invalid action: expected a PlayerInput object, got array'],
        [[{}, 0], 'Invalid action: expected a PlayerInput object with a boolean field, got an empty object'],
        [[{ left: 'true' }, 0], 'Invalid action: field "left" must be boolean, got string'],
        [[{ right: 1 }, 0], 'Invalid action: field "right" must be boolean, got number'],
      ];
      for (const [actions, message] of invalidBatches) {
        await expect(pool.step(actions)).rejects.toThrow(message);
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

  it('shared-memory mode: malformed action values are rejected and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runRejectionSequence(true);
  });

  it('message-passing mode: malformed action values are rejected and the pool recovers', async () => {
    await runRejectionSequence(false);
  });
});
