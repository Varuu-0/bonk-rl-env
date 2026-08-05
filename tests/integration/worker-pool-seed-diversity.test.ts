/**
 * worker-pool-seed-diversity.test.ts — Regression coverage for the #200 review
 *
 * The constructor now honors seed 0 (the config-loader default), so pooled
 * environments must not all construct on the identical seed-0 PRNG stream:
 * every environment gets a deterministic per-env construction seed (config
 * seed + global env index), which keeps each env reproducible while removing
 * the all-identical-trajectories hazard.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('Worker-pool per-env construction seeds (review of #200)', () => {
  it('pooled environments stepped without reset seeds do not run identical trajectories', async () => {
    const pool = new WorkerPool(1);
    try {
      // Message mode exercises the same per-env construction path with the
      // default config (seed 0) and no SAB dependency.
      await pool.init(2, {}, false);
      await pool.reset();

      const signatures: number[][][] = [[], []];
      for (let step = 0; step < 30; step++) {
        const results = await pool.step([0, 0]);
        for (let envIdx = 0; envIdx < 2; envIdx++) {
          const o = results[envIdx].observation;
          signatures[envIdx].push([
            o.playerX, o.playerY,
            o.opponents[0].x, o.opponents[0].y,
          ]);
        }
      }

      // Before the fix both envs shared the seed-0 stream and were identical.
      expect(signatures[0]).not.toEqual(signatures[1]);
    } finally {
      await pool.close();
    }
  });

  it('per-env construction streams are reproducible across pool runs', async () => {
    const runOnce = async (): Promise<number[][]> => {
      const pool = new WorkerPool(1);
      try {
        await pool.init(2, { seed: 7 }, false);
        await pool.reset();
        const signatures: number[][] = [];
        for (let step = 0; step < 20; step++) {
          const results = await pool.step([0, 0]);
          const o = results[1].observation;
          signatures.push([o.playerX, o.playerY, o.opponents[0].x, o.opponents[0].y]);
        }
        return signatures;
      } finally {
        await pool.close();
      }
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first).toEqual(second);
  });
});