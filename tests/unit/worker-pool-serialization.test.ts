/**
 * worker-pool-serialization.test.ts — Regression for #223 concurrency guard
 *
 * When a BonkEnv's pool is adopted by an IpcBridge (enableIpcServer), the same
 * WorkerPool instance is driven by BOTH the programmatic BonkEnv reset/step
 * API and the ZMQ IPC request loop. Without a guard, concurrent programmatic
 * and IPC calls could interleave worker signaling and mutate the reused
 * shared-memory buffers mid-serialization.
 *
 * These tests assert on the pool's internal operation boundary
 * (stepInternal/resetInternal/initInternal) using deferred promises, so they
 * deterministically prove that init/reset/step are serialized FIFO and that a
 * rejected operation never blocks the queue — without spawning real workers.
 * close() is deliberately NOT part of this lock (it must be able to interrupt
 * an in-flight batch), which is covered by worker-pool-failures.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('WorkerPool operation serialization (#223)', () => {
  it('serializes concurrent step/reset/init calls in FIFO order', async () => {
    const pool = new WorkerPool(1);
    const calls: string[] = [];

    const stepDeferreds = [deferred<any[]>(), deferred<any[]>()];
    let stepIdx = 0;
    vi.spyOn(pool as any, 'stepInternal').mockImplementation(() => {
      calls.push('step');
      return stepDeferreds[stepIdx++].promise;
    });
    const resetDeferred = deferred<any[]>();
    vi.spyOn(pool as any, 'resetInternal').mockImplementation(() => {
      calls.push('reset');
      return resetDeferred.promise;
    });
    const initDeferred = deferred<void>();
    vi.spyOn(pool as any, 'initInternal').mockImplementation(() => {
      calls.push('init');
      return initDeferred.promise;
    });

    const step1 = (pool as any).step([0]);
    const step2 = (pool as any).step([0]);
    const resetP = (pool as any).reset([1]);
    const initP = (pool as any).init(1, {}, false);

    await tick();
    // Only the first op may run; the rest must wait behind the lock.
    expect(calls).toEqual(['step']);

    stepDeferreds[0].resolve([]);
    await step1;
    await tick();
    expect(calls).toEqual(['step', 'step']);

    stepDeferreds[1].resolve([]);
    await step2;
    await tick();
    expect(calls).toEqual(['step', 'step', 'reset']);

    resetDeferred.resolve([]);
    await resetP;
    await tick();
    expect(calls).toEqual(['step', 'step', 'reset', 'init']);

    initDeferred.resolve(undefined);
    await initP;
  });

  it('lets a queued operation run even after an earlier one rejects', async () => {
    const pool = new WorkerPool(1);
    const firstDeferred = deferred<any[]>();
    const secondDeferred = deferred<any[]>();
    let isFirstOp = true;
    let secondStarted = false;
    vi.spyOn(pool as any, 'stepInternal').mockImplementation(() => {
      if (isFirstOp) {
        isFirstOp = false;
        return firstDeferred.promise;
      }
      secondStarted = true;
      return secondDeferred.promise;
    });

    const first = (pool as any).step([0]);
    const second = (pool as any).step([0]);
    await tick();
    expect(secondStarted).toBe(false);

    firstDeferred.reject(new Error('worker timeout'));
    await expect(first).rejects.toThrow('worker timeout');
    await tick();
    // The next op runs despite the earlier rejection (the lock must not poison).
    expect(secondStarted).toBe(true);

    secondDeferred.resolve([]);
    await expect(second).resolves.toEqual([]);
  });

  it('serializes init (which tears down/rebuilds the pool) against an in-flight step', async () => {
    const pool = new WorkerPool(1);
    const calls: string[] = [];
    const stepDeferred = deferred<any[]>();
    vi.spyOn(pool as any, 'stepInternal').mockImplementation(() => {
      calls.push('step');
      return stepDeferred.promise;
    });
    const initDeferred = deferred<void>();
    vi.spyOn(pool as any, 'initInternal').mockImplementation(() => {
      calls.push('init');
      return initDeferred.promise;
    });

    const stepP = (pool as any).step([0]);
    const initP = (pool as any).init(1, {}, false);
    await tick();
    expect(calls).toEqual(['step']);

    stepDeferred.resolve([]);
    await stepP;
    await tick();
    expect(calls).toEqual(['step', 'init']);

    initDeferred.resolve(undefined);
    await initP;
  });

  it('re-arms the lock for a queued op so a call arriving after the head settles still queues (#252)', async () => {
    const pool = new WorkerPool(1);
    const calls: string[] = [];
    const stepDeferreds = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
    let stepIdx = 0;
    vi.spyOn(pool as any, 'stepInternal').mockImplementation(() => {
      calls.push('step');
      return stepDeferreds[stepIdx++].promise;
    });

    // Head starts immediately (locks).
    const p1 = (pool as any).step([0]);
    // Queued behind p1.
    const p2 = (pool as any).step([0]);
    await tick();
    expect(calls).toEqual(['step']);

    // Head settles; the queued p2 starts and must re-arm the lock, so its
    // worker await holds exclusivity. A third call arriving *after* p1 settled
    // but *while p2 is still awaiting* must queue behind p2 — it must never take
    // the fast path and run concurrently (#252). Without the re-arm this third
    // call would see `_operationLocked === false` and interleave with p2.
    stepDeferreds[0].resolve([]);
    await p1;
    await tick();
    expect(calls).toEqual(['step', 'step']);

    const p3 = (pool as any).step([0]);
    await tick();
    // p3 must NOT have started while p2 is still in flight.
    expect(calls).toEqual(['step', 'step']);

    stepDeferreds[1].resolve([]);
    await p2;
    await tick();
    expect(calls).toEqual(['step', 'step', 'step']);

    stepDeferreds[2].resolve([]);
    await expect(p3).resolves.toEqual([]);
  });

  it('queues a call issued in the settled head continuation (same microtask drain) (#252)', async () => {
    const pool = new WorkerPool(1);
    const calls: string[] = [];
    const stepDeferreds = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
    let stepIdx = 0;
    vi.spyOn(pool as any, 'stepInternal').mockImplementation(() => {
      calls.push('step');
      return stepDeferreds[stepIdx++].promise;
    });

    const p1 = (pool as any).step([0]); // head (locks)
    const p2 = (pool as any).step([0]); // queued (sets _operationQueued)
    await tick();
    expect(calls).toEqual(['step']);

    // Resolve the head and issue a THIRD call in the SAME microtask drain:
    // when the head's clear handler runs it releases the lock, but the queued
    // op's `start` has not yet been scheduled, so this drained call would see
    // `_operationLocked === false` and fast-path alongside the still-pending
    // queued op unless the `_operationQueued` gate holds it (#252).
    stepDeferreds[0].resolve([]);
    const p3 = Promise.resolve().then(() => (pool as any).step([0]));
    await tick();
    // p2 started; the drained p3 must still be queued behind it.
    expect(calls).toEqual(['step', 'step']);

    stepDeferreds[1].resolve([]);
    await p2;
    await tick();
    expect(calls).toEqual(['step', 'step', 'step']);

    stepDeferreds[2].resolve([]);
    await expect(p3).resolves.toEqual([]);
  });
});