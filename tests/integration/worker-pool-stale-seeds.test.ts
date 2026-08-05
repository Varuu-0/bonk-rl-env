/**
 * worker-pool-stale-seeds.test.ts — Regression coverage for issue #183
 *
 * A shared-memory reset with fewer seeds than environments must not silently
 * replay the previous batch's seeds for the tail environments. Previously the
 * seed table was only partially overwritten, so `reset([333])` after
 * `reset([111, 222])` re-ran env 1 with the stale seed 222 — producing a
 * bit-identical trajectory to the reseeded control. Message mode always left
 * such environments unseeded (continuing their RNG stream), so the two
 * transports disagreed on the same API call.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('Shared-memory reset with a short seed list (issue #183)', () => {
  it('does not replay stale seeds for environments beyond the seed list', async () => {
    if (!WorkerPool.isSupported()) return;

    const runSequence = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        // A nonzero config seed keeps environment construction deterministic.
        await pool.init(2, { seed: 1 }, useSharedMemory);
        await pool.reset([111, 222]);
        const seededA = await pool.step([0, 0]); // env 1 seeded 222
        await pool.reset([333, 222]);
        const seededB = await pool.step([0, 0]); // control: env 1 re-seeded 222
        await pool.reset([333]);                 // env 1 has NO seed this call
        const partial = await pool.step([0, 0]);
        return { seededA, seededB, partial };
      } finally {
        await pool.close();
      }
    };

    const shared = await runSequence(true);
    const message = await runSequence(false);

    // Sanity: reseeding env 1 with 222 is bit-identical across resets.
    expect(shared.seededB[1].observation).toEqual(shared.seededA[1].observation);
    expect(message.seededB[1].observation).toEqual(message.seededA[1].observation);

    // Regression: after the partial seed list, env 1 must NOT replay the stale
    // seed 222 (which would make `partial` bit-identical to the control). It
    // continues its RNG stream instead, so its trajectory differs. Message mode
    // always behaved this way; the fix aligns shared mode with it.
    expect(shared.partial[1].observation).not.toEqual(shared.seededB[1].observation);
    expect(message.partial[1].observation).not.toEqual(message.seededB[1].observation);
  });
});
