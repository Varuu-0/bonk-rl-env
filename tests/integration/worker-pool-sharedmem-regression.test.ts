/**
 * worker-pool-sharedmem-regression.test.ts — Regression coverage for the
 * shared-memory result-extraction path.
 *
 * Guards against two previously-fixed corruption bugs:
 *   R2C1 — missing `actionIdx += wEnvs` made every worker overwrite result
 *          slot 0..N-1, so only the last worker's data survived.
 *   R2C2 — `_obsPool` template was aliased across workers (worker-local SAB
 *          index used as the global pool index), so observations collided.
 *
 * The end-to-end worker test suite also exercises worker startup. This file
 * isolates the extraction locus to pin the global-vs-worker-local indexing
 * invariant without requiring thread scheduling to be deterministic.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool extractObservation regression (unit-level)', () => {
  // Build a Float32Array simulating one worker's shared-memory observation
   // region: `wEnvs` envs, 16 floats each. Env i is filled with value (base+i).
  function makeWorkerObs(wEnvs: number, base: number): Float32Array {
    const obs = new Float32Array(wEnvs * 16);
    for (let e = 0; e < wEnvs; e++) {
      for (let k = 0; k < 16; k++) {
        obs[e * 16 + k] = base + e;
      }
    }
    return obs;
  }

  it('distinct global pool indices yield distinct, non-aliased observations', () => {
    const pool = new WorkerPool(2);
    // Set up the pre-allocated observation template pool (normally done in init).
    (pool as any).initObsPool(4);

    // Two workers, two envs each. Each worker has its own SAB observation region.
    const worker0Obs = makeWorkerObs(2, 10); // envs 0,1 -> values 10,11
    const worker1Obs = makeWorkerObs(2, 20); // envs 2,3 -> values 20,21

    // R2C1: the global result index (poolIdx) must advance across workers so
    // each env lands in its own slot. sabIdx is worker-local.
    const o0 = (pool as any).extractObservation(worker0Obs, 0, 0); // env 0
    const o1 = (pool as any).extractObservation(worker0Obs, 1, 1); // env 1
    const o2 = (pool as any).extractObservation(worker1Obs, 0, 2); // env 2
    const o3 = (pool as any).extractObservation(worker1Obs, 1, 3); // env 3

    // R2C2: each observation is a distinct object (no template aliasing).
    expect(o0).not.toBe(o1);
    expect(o0).not.toBe(o2);
    expect(o0).not.toBe(o3);
    expect(o1).not.toBe(o3);

    // Each slot reflects its own env's data, not another worker's.
    expect(o0.playerX).toBe(10);
    expect(o1.playerX).toBe(11);
    expect(o2.playerX).toBe(20);
    expect(o3.playerX).toBe(21);

    // Mutating one slot must not corrupt another (true independence).
    const before = o3.playerX;
    o0.playerX = 999999;
    expect(o3.playerX).toBe(before);
  });

  it('extractObservation returns a valid structured object for an out-of-range index', () => {
    const pool = new WorkerPool(1);
    (pool as any).initObsPool(1);
    const obs = makeWorkerObs(1, 5);
    // poolIdx beyond the pool size falls back to a fresh object (no crash).
    const o = (pool as any).extractObservation(obs, 0, 99);
    expect(o).toHaveProperty('playerX');
    expect(o).toHaveProperty('opponents');
    expect(o.playerX).toBe(5);
  });
});

describe('WorkerPool shared-memory result ownership', () => {
  it('keeps retained step results unchanged across later steps', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, {}, true);
      const resetBatch = await pool.reset([1]);
      const resetObservation = resetBatch[0];
      const resetSnapshot = structuredClone(resetObservation);

      const retainedBatch = await pool.step([{ right: true }]);
      const retainedResult = retainedBatch[0];
      const retainedInfo = retainedResult.info;
      const retainedObservation = retainedResult.observation;
      const retainedOpponent = retainedObservation.opponents[0];
      const snapshot = structuredClone(retainedResult);

      expect(retainedObservation).not.toBe(resetObservation);
      expect(resetObservation).toEqual(resetSnapshot);

      const nextBatch = await pool.step([{ left: true }]);

      expect(nextBatch).not.toBe(retainedBatch);
      expect(nextBatch[0]).not.toBe(retainedResult);
      expect(nextBatch[0].info).not.toBe(retainedInfo);
      expect(nextBatch[0].observation).not.toBe(retainedObservation);
      expect(nextBatch[0].observation.opponents[0]).not.toBe(retainedOpponent);
      expect(retainedResult).toEqual(snapshot);
    } finally {
      await pool.close();
    }
  });

  it('keeps retained terminal observations unchanged across later steps', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, { maxTicks: 1 }, true);
      await pool.reset([1]);

      const retainedResult = (await pool.step([0]))[0];
      const retainedTerminal = retainedResult.info.terminal_observation;
      const retainedOpponent = retainedTerminal.opponents[0];
      const snapshot = structuredClone(retainedTerminal);

      const nextResult = (await pool.step([0]))[0];

      expect(retainedResult.done).toBe(true);
      expect(nextResult.info.terminal_observation).not.toBe(retainedTerminal);
      expect(nextResult.info.terminal_observation.opponents[0]).not.toBe(retainedOpponent);
      expect(retainedTerminal).toEqual(snapshot);
    } finally {
      await pool.close();
    }
  });
});
