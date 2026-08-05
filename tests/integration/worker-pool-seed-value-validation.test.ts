/**
 * worker-pool-seed-value-validation.test.ts — Regression coverage for issue #226
 *
 * Out-of-contract seed VALUES (non-integers, negatives, values >= 2^32) must be
 * rejected as a per-request input error in BOTH transports. Previously the
 * range check only ran in shared-memory mode: message passing forwarded the raw
 * seeds to `env.reset()`, whose PRNG silently normalizes any number with
 * `seed >>> 0` (3.7 -> 3, -1 -> 4294967295, 2^32 -> 0), so the identical
 * request either threw (shared) or reseeded with a different, unintended value
 * (message), breaking deterministic replay.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool seed value validation (issue #226)', () => {
  const runRejectionSequence = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(2, { seed: 1 }, useSharedMemory);

      // A valid reset first, so the rejections below come from the value check
      // rather than an uninitialized pool.
      await pool.reset([1, 2]);

      const invalidBatches: number[][] = [
        [-1, 1], // negative: bit-cast by the PRNG's `>>> 0` in message mode
        [3.7, 2], // non-integer: truncated by the PRNG's `>>> 0`
        [4294967296, 3], // 2^32: wraps to seed 0
        [4294967295, 4], // 0xFFFFFFFF: valid uint32 but > 0xFFFFFFFE
      ];
      for (const seeds of invalidBatches) {
        await expect(pool.reset(seeds)).rejects.toThrow(
          /out of supported range \[0, 4294967294\]/,
        );
        expect((pool as any).state).toBe('ready');
      }

      // Boundary values remain valid in both transports.
      await expect(pool.reset([0, 0xFFFFFFFE])).resolves.toHaveLength(2);
      await expect(pool.step([0, 0])).resolves.toHaveLength(2);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: out-of-range seed values are rejected and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await runRejectionSequence(true);
  });

  it('message-passing mode: out-of-range seed values are rejected and the pool recovers', async () => {
    await runRejectionSequence(false);
  });
});