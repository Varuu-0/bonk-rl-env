/**
 * worker-pool-close-init-race.test.ts — Regression for #427
 *
 * close() deliberately runs outside the operation lock so it can interrupt
 * in-flight work. initInternal() was written as if it were serialized against
 * that close: nothing between its first await and `state = 'ready'` honored an
 * external shutdown, so an awaited close() resolved while the still-pending
 * init resumed, resurrected the pool to 'ready' with live workers — or, when
 * the close landed during the worker-reply wait, flipped the already-closed
 * pool to 'failed'. These tests pin the contract: once close() settles, the
 * pool stays terminally closed, every init that was pending when close() ran
 * rejects (running, queued behind the lock, or mid resume), and no spawned
 * worker survives.
 *
 * Deterministic fake workers hold their init replies so both interleavings
 * are driven manually instead of depending on thread-startup timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  type WorkerEvent = 'message' | 'error' | 'exit';

  const control = {
    // While true, init requests receive no reply until the test emits one
    // manually, pinning init at its worker-reply suspension point.
    holdInitReplies: true,
  };

  class CloseRaceWorker {
    static instances: CloseRaceWorker[] = [];

    readonly handlers = new Map<WorkerEvent, Array<(...args: any[]) => void>>();
    readonly sent: any[] = [];
    terminated = false;

    constructor(_path: string) {
      CloseRaceWorker.instances.push(this);
    }

    on(event: WorkerEvent, handler: (...args: any[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: WorkerEvent, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    postMessage(message: any): void {
      this.sent.push(message);
      if (message.type === 'init' && !control.holdInitReplies) {
        this.emit('message', { id: message.id, status: 'ok', data: {} });
      } else if (message.type === 'reset') {
        this.emit('message', { id: message.id, status: 'ok', data: [{}] });
      }
    }

    async terminate(): Promise<number> {
      this.terminated = true;
      return 0;
    }
  }

  function reset(): void {
    CloseRaceWorker.instances = [];
    control.holdInitReplies = true;
  }

  return { control, CloseRaceWorker, reset };
});

vi.mock('worker_threads', () => ({ Worker: fakes.CloseRaceWorker }));

import { WorkerPool } from '../../src/core/worker-pool';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('WorkerPool close() during pending init() (#427)', () => {
  let pool: WorkerPool | undefined;

  beforeEach(() => {
    fakes.reset();
  });

  afterEach(async () => {
    await pool?.close();
  });

  it('aborts an init interrupted before any worker spawns and leaves the pool closed', async () => {
    pool = new WorkerPool(2);
    // init() suspends at its internal pre-clean teardown; the awaited
    // close() lands inside that window, before the spawn loop ever runs.
    const initPromise = pool.init(2, {}, false);

    await pool.close();

    await expect(initPromise).rejects.toThrow(/initialization aborted/i);
    expect(fakes.CloseRaceWorker.instances).toHaveLength(0);
    expect((pool as any).workers).toHaveLength(0);
    expect(pool.isFailed()).toBe(false);
    await expect(pool.reset()).rejects.toThrow(/worker pool is closed/);
  });

  it('rejects init, terminates spawned workers, and never resurrects when replies arrive after close', async () => {
    pool = new WorkerPool(2);
    const initPromise = pool.init(2, {}, false);

    await tick(); // let init reach its worker-reply wait
    expect(fakes.CloseRaceWorker.instances).toHaveLength(2);

    await pool.close();
    expect(fakes.CloseRaceWorker.instances.every((worker) => worker.terminated)).toBe(true);

    await expect(initPromise).rejects.toThrow(/closed/i);

    // Straggler init replies arriving after close() has settled must not
    // resurrect the pool to 'ready' nor relabel it 'failed'.
    for (const worker of fakes.CloseRaceWorker.instances) {
      const initMsg = worker.sent.find((msg) => msg.type === 'init');
      worker.emit('message', { id: initMsg.id, status: 'ok', data: {} });
    }
    await tick();

    expect(pool.isFailed()).toBe(false);
    expect((pool as any).workers).toHaveLength(0);
    await expect(pool.reset()).rejects.toThrow(/worker pool is closed/);
  });

  it('keeps the sequential init -> close -> re-init lifecycle working after an aborted init', async () => {
    pool = new WorkerPool(1);
    const initPromise = pool.init(1, {}, false);
    await tick(); // first init is now pinned at its worker-reply wait

    await pool.close();
    await expect(initPromise).rejects.toThrow(/closed/i);

    fakes.control.holdInitReplies = false;
    await pool.init(1, {}, false);
    const observations = await pool.reset();
    expect(observations).toHaveLength(1);
  });

  it('aborts init when close() runs between the last reply resolving and init resuming', async () => {
    pool = new WorkerPool(1);
    const initPromise = pool.init(1, {}, false);
    await tick(); // init is now pinned at its worker-reply wait

    // Resolve the init reply and close() in the SAME synchronous block: the
    // reply resolves Promise.all, but init's continuation only drains after
    // close()'s synchronous section has already bumped the epoch and closed
    // the pool — exercising the post-await abort checkpoint.
    const worker = fakes.CloseRaceWorker.instances[0];
    const initMsg = worker.sent.find((msg) => msg.type === 'init');
    worker.emit('message', { id: initMsg.id, status: 'ok', data: {} });
    const closePromise = pool.close();

    await closePromise;
    await expect(initPromise).rejects.toThrow(/initialization aborted/i);
    expect(pool.isFailed()).toBe(false);
    await expect(pool.reset()).rejects.toThrow(/worker pool is closed/);
    expect((pool as any).workers).toHaveLength(0);
  });

  it('cancels an init that was queued behind the lock when close() ran, instead of starting it after the close settles', async () => {
    pool = new WorkerPool(1);
    // Pin a first init at its reply wait so the second init queues behind
    // it on the operation lock while still only being *called*, not started.
    const firstInit = pool.init(1, {}, false);
    await tick();
    const queuedInit = pool.init(1, {}, false);
    await tick();

    await pool.close(); // must win over BOTH pending inits

    await expect(firstInit).rejects.toThrow(/closed/i);
    await expect(queuedInit).rejects.toThrow(/initialization aborted/i);
    expect(fakes.CloseRaceWorker.instances).toHaveLength(1); // queued init never spawned
    expect((pool as any).workers).toHaveLength(0);
    expect(pool.isFailed()).toBe(false);
    await expect(pool.reset()).rejects.toThrow(/worker pool is closed/);
  });
});
