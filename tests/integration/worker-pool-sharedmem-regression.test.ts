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

  it('snapshots every nested field of the pooled result graph (structural guard)', async () => {
    if (!WorkerPool.isSupported()) return;

    const collectRefs = (value: any, into: Set<any>): void => {
      if (value === null || typeof value !== 'object') return;
      if (into.has(value)) return;
      into.add(value);
      for (const key of Object.keys(value)) collectRefs(value[key], into);
    };

    // Walks the snapshot and fails if any node aliases the pooled source. This
    // is the guard that breaks when a future nested mutable field added to
    // extractObservation() is not deep-copied by snapshotObservation().
    const expectGraphIndependent = (source: any, snapshot: any): void => {
      const sourceRefs = new Set<any>();
      collectRefs(source, sourceRefs);

      const walk = (value: any): void => {
        if (value === null || typeof value !== 'object') return;
        expect(sourceRefs.has(value)).toBe(false);
        for (const key of Object.keys(value)) walk(value[key]);
      };

      walk(snapshot);
      expect(snapshot).toEqual(source);
    };

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, {}, true);
      await pool.reset([1]);
      const borrowed = (await pool.step([{ right: true }], { ownership: 'borrowed' }))[0];
      expectGraphIndependent(borrowed, (pool as any).snapshotResult(borrowed));

      await pool.close();
      await pool.init(1, { maxTicks: 1 }, true);
      await pool.reset([1]);
      const terminalBorrowed = (await pool.step([0], { ownership: 'borrowed' }))[0];
      expect(terminalBorrowed.info.terminal_observation).toBeDefined();
      expectGraphIndependent(terminalBorrowed, (pool as any).snapshotResult(terminalBorrowed));
    } finally {
      await pool.close();
    }
  });

  it('preserves non-plain members (Date/Map/Set/typed array) through the snapshot boundary', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, {}, true);
      await pool.reset([1]);

      const fixture = {
        playerX: 1,
        opponents: [{ x: 2, alive: true }],
        observedAt: new Date(1700000000000),
        tags: new Set(['a', 'b']),
        lookup: new Map([['k', 5]]),
        samples: new Float64Array([1.5, 2.5]),
      };

      const snapshot = (pool as any).snapshotObservation(fixture);

      // Plain graph members must remain fully owned, as before.
      expect(snapshot).not.toBe(fixture);
      expect(snapshot.opponents).not.toBe(fixture.opponents);
      expect(snapshot.opponents[0]).not.toBe(fixture.opponents[0]);

      // Non-plain members must survive snapshotting as their real types
      // instead of degrading to {} (guards the snapshot deep copy, which
      // preserves Date/Map/Set/typed-array members).
      expect(snapshot.observedAt).toBeInstanceOf(Date);
      expect(snapshot.observedAt).toEqual(fixture.observedAt);
      expect(snapshot.observedAt).not.toBe(fixture.observedAt);
      expect(snapshot.tags).toBeInstanceOf(Set);
      expect(snapshot.tags).toEqual(fixture.tags);
      expect(snapshot.tags).not.toBe(fixture.tags);
      expect(snapshot.lookup).toBeInstanceOf(Map);
      expect(snapshot.lookup).toEqual(fixture.lookup);
      expect(snapshot.lookup).not.toBe(fixture.lookup);
      expect(snapshot.samples).toBeInstanceOf(Float64Array);
      expect(snapshot.samples).toEqual(fixture.samples);
      expect(snapshot.samples).not.toBe(fixture.samples);

      expect(snapshot).toEqual(fixture);
    } finally {
      await pool.close();
    }
  });

  it('deep-copies nested plain objects, arrays, and SAB-backed members (fallback path)', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, {}, true);
      await pool.reset([1]);

      // Force the manual deep-copy path even on runtimes where the global
      // structuredClone exists, so the fallback branches are genuinely
      // exercised rather than always bypassed on Node 20+.
      const scDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
      if (scDescriptor && scDescriptor.configurable) {
        Object.defineProperty(globalThis, 'structuredClone', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }

      const sab = new SharedArrayBuffer(8);
      const sabView = new Float64Array(sab);
      sabView[0] = 3.5;
      const sab2 = new SharedArrayBuffer(8);
      const sabDataView = new DataView(sab2);
      sabDataView.setFloat32(0, 1.25);
      const bareSab = new SharedArrayBuffer(8);

      const fixture = {
        playerX: 1,
        nested: { depth: [1, 2, { inner: 'x' }] },
        labels: ['a', 'b'],
        observedAt: new Date(1700000000000),
        tags: new Set(['x']),
        lookup: new Map([['k', 1]]),
        samples: new Float64Array([1.5, 2.5]),
        sabView,
        sabDataView,
        bareSab: sab,
      };

      try {
        const snapshot = (pool as any).snapshotObservation(fixture);

        // Nested plain objects and arrays are fully owned.
        expect(snapshot).not.toBe(fixture);
        expect(snapshot.nested).toEqual(fixture.nested);
        expect(snapshot.nested).not.toBe(fixture.nested);
        expect(snapshot.nested.depth).not.toBe(fixture.nested.depth);
        expect(snapshot.nested.depth[2]).not.toBe(fixture.nested.depth[2]);
        expect(snapshot.labels).toEqual(fixture.labels);
        expect(snapshot.labels).not.toBe(fixture.labels);

        // Non-plain members survive as their real types.
        expect(snapshot.observedAt).toBeInstanceOf(Date);
        expect(snapshot.observedAt.getTime()).toBe(fixture.observedAt.getTime());
        expect(snapshot.tags).toBeInstanceOf(Set);
        expect(snapshot.tags).toEqual(fixture.tags);
        expect(snapshot.lookup).toBeInstanceOf(Map);
        expect(snapshot.lookup).toEqual(fixture.lookup);
        expect(snapshot.samples).toBeInstanceOf(Float64Array);
        expect(snapshot.samples).toEqual(fixture.samples);
        expect(snapshot.samples.buffer).not.toBe(fixture.samples.buffer);

        // SharedArrayBuffer-backed views must be copied, not shared: this is
        // exactly where structuredClone would re-alias the pool's SAB.
        expect(snapshot.sabView).toBeInstanceOf(Float64Array);
        expect(snapshot.sabView[0]).toBe(3.5);
        expect(snapshot.sabView.buffer).not.toBe(sab);
        expect(snapshot.sabDataView).toBeInstanceOf(DataView);
        expect(snapshot.sabDataView.getFloat32(0)).toBe(1.25);
        expect(snapshot.sabDataView.buffer).not.toBe(sab2);
        expect(snapshot.bareSab).toBeInstanceOf((globalThis as any).SharedArrayBuffer);
        expect(snapshot.bareSab).not.toBe(bareSab);

        // Mutating the snapshot must not leak into the source graph.
        snapshot.playerX = 99;
        snapshot.nested.depth[0] = 99;
        snapshot.samples[0] = 99;
        snapshot.sabView[0] = 99;
        expect(fixture.playerX).toBe(1);
        expect(fixture.nested.depth[0]).toBe(1);
        expect(fixture.samples[0]).toBe(1.5);
        expect(sabView[0]).toBe(3.5);
      } finally {
        if (scDescriptor) {
          Object.defineProperty(globalThis, 'structuredClone', scDescriptor);
        }
      }
    } finally {
      await pool.close();
    }
  });
});

describe('WorkerPool message-passing result ownership', () => {
  it('keeps retained step results stable regardless of the ownership option', async () => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, {}, false); // message passing (structured clone)
      await pool.reset([1]);

      // `borrowed` is a no-op in message-passing mode: worker transport
      // already structured-clones every result, so retaining is safe.
      const retained = (await pool.step([{ right: true }], { ownership: 'borrowed' }))[0];
      const snapshot = structuredClone(retained);

      await pool.step([{ left: true }], { ownership: 'owned' });

      expect(retained).toEqual(snapshot);
    } finally {
      await pool.close();
    }
  });
});
