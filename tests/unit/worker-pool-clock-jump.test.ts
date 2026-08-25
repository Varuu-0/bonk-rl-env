import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for #426: the shared-memory batch deadline in
// waitForSharedCompletion() must be derived from a monotonic clock. A single
// forward wall-clock adjustment (NTP step, VM pause/resume catch-up) landing
// mid-batch used to exhaust the wall-clock budget instantly, escalating a
// healthy batch into failPool() which terminated every worker and bricked
// the pool. These tests mock Date.now() to inject such a jump while real
// timers drive worker completion, proving deadlines ignore wall-clock steps
// and that genuine timeouts still fire.

const fakes = vi.hoisted(() => {
  type WorkerEvent = 'message' | 'error' | 'exit';

  const control = {
    // Per-worker real-time delay before a shared command completes.
    commandDelayMs: [] as number[],
    // One-time forward Date.now() step applied when worker 0 completes.
    clockJumpMs: 0,
    stepTimeoutMs: 1000,
    messageTimeoutMs: 1000,
  };

  let clockOffsetMs = 0;
  const realDateNow = Date.now.bind(Date);

  function installFakeWallClock(): void {
    (Date as any).now = () => realDateNow() + clockOffsetMs;
  }

  function restoreRealWallClock(): void {
    (Date as any).now = realDateNow;
    clockOffsetMs = 0;
  }

  class FakeWorker {
    static instances: FakeWorker[] = [];

    readonly index: number;
    readonly handlers = new Map<WorkerEvent, Array<(...args: any[]) => void>>();
    terminated = false;

    constructor(_path: string) {
      this.index = FakeWorker.instances.length;
      FakeWorker.instances.push(this);
    }

    on(event: WorkerEvent, handler: (...args: any[]) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: WorkerEvent, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    postMessage(message: any): void {
      if (message.type === 'init') {
        const manager = FakeSharedMemoryManager.instances.find(
          (candidate) => candidate.getBuffer() === message.sharedBuffer,
        );
        manager?.connect(message.syncBuffer, message.workerIndex, this);
        this.emit('message', {
          id: message.id,
          status: 'ok',
          data: { mode: message.sharedBuffer ? 'shared' : 'message' },
        });
      }
    }

    terminate(): Promise<number> {
      this.terminated = true;
      return Promise.resolve(1);
    }
  }

  class FakeSharedMemoryManager {
    static instances: FakeSharedMemoryManager[] = [];

    readonly index: number;
    readonly buffer = new SharedArrayBuffer(4);
    readonly numEnvs: number;
    disposed = false;
    ready = false;
    readCalls = 0;
    private sync: Int32Array | null = null;
    private workerIndex = 0;
    private worker: FakeWorker | null = null;

    constructor(numEnvs: number) {
      this.index = FakeSharedMemoryManager.instances.length;
      this.numEnvs = numEnvs;
      FakeSharedMemoryManager.instances.push(this);
    }

    static isSupported(): boolean {
      return true;
    }

    static normalizeNumOpponents(value: unknown): number {
      const n = Number(value);
      if (!Number.isFinite(n)) return 1;
      return Math.max(0, Math.floor(n));
    }

    getBuffer(): SharedArrayBuffer {
      return this.buffer;
    }

    connect(syncBuffer: SharedArrayBuffer, workerIndex: number, worker: FakeWorker): void {
      this.sync = new Int32Array(syncBuffer);
      this.workerIndex = workerIndex;
      this.worker = worker;
    }

    writeSeeds(_seeds: number[]): void {}
    writeActionsQuiet(_actions: Uint8Array): void {}

    sendCommand(_command: number): void {
      if (!this.sync) throw new Error('fake manager was not connected');
      const delay = control.commandDelayMs[this.index] ?? 0;
      setTimeout(() => {
        if (!this.sync) return;
        // The forward wall-clock step lands exactly while the batch is in
        // flight: worker 0 completes first, stragglers are still pending.
        if (this.workerIndex === 0 && control.clockJumpMs !== 0) {
          clockOffsetMs += control.clockJumpMs;
          control.clockJumpMs = 0;
        }
        this.ready = true;
        Atomics.store(this.sync, this.workerIndex + 1, 1);
        Atomics.add(this.sync, 0, 1);
        Atomics.notify(this.sync, 0);
      }, delay);
    }

    isResultsReady(): boolean {
      return this.ready;
    }

    consumeResultsSignal(): void {
      this.ready = false;
    }

    readResults(): any {
      this.readCalls++;
      return {
        observations: new Float32Array(this.numEnvs * 16),
        terminalObservations: new Float32Array(this.numEnvs * 16),
        hasTerminalObs: new Uint8Array(this.numEnvs),
        rewards: new Float32Array(this.numEnvs),
        dones: new Uint8Array(this.numEnvs),
        truncated: new Uint8Array(this.numEnvs),
        terminated: new Uint8Array(this.numEnvs),
        ticks: new Uint32Array(this.numEnvs),
        info: new Float32Array(this.numEnvs * 4),
      };
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  function reset(): void {
    FakeWorker.instances = [];
    FakeSharedMemoryManager.instances = [];
    control.commandDelayMs = [];
    control.clockJumpMs = 0;
    control.stepTimeoutMs = 1000;
    control.messageTimeoutMs = 1000;
    restoreRealWallClock();
  }

  return { control, FakeWorker, FakeSharedMemoryManager, reset, installFakeWallClock, restoreRealWallClock };
});

vi.mock('worker_threads', () => ({ Worker: fakes.FakeWorker }));
vi.mock('../../src/ipc/shared-memory', () => ({
  SharedMemoryManager: fakes.FakeSharedMemoryManager,
}));
vi.mock('../../src/config/config-loader', () => ({
  getConfig: () => ({
    workerPool: {
      numWorkers: 1,
      useSharedMemory: true,
      ringBufferSize: 16,
      messageTimeoutMs: fakes.control.messageTimeoutMs,
      stepTimeoutMs: fakes.control.stepTimeoutMs,
    },
  }),
}));

import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool shared-batch deadline vs wall-clock steps', () => {
  let pool: WorkerPool | undefined;

  beforeEach(() => {
    fakes.reset();
    fakes.installFakeWallClock();
  });

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
    fakes.restoreRealWallClock();
  });

  it('CONTROL: healthy straddled completions succeed without a clock step', async () => {
    fakes.control.commandDelayMs = [15, 40];
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);

    expect(await pool.step([0, 0])).toHaveLength(2);

    expect((pool as any).state).toBe('ready');
    expect(fakes.FakeWorker.instances.every((worker) => !worker.terminated)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => !manager.disposed)).toBe(true);
  });

  it('survives a forward Date.now step landing mid-step-batch (#426)', async () => {
    fakes.control.commandDelayMs = [15, 40];
    fakes.control.clockJumpMs = 60_000;
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);

    expect(await pool.step([0, 0])).toHaveLength(2);

    expect((pool as any).state).toBe('ready');
    expect(fakes.FakeWorker.instances.every((worker) => !worker.terminated)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => !manager.disposed)).toBe(true);

    // The pool must remain usable after the clock step.
    fakes.control.clockJumpMs = 60_000;
    expect(await pool.step([0, 0])).toHaveLength(2);
    expect((pool as any).state).toBe('ready');
  });

  it('survives a forward Date.now step landing mid-reset-batch (#426)', async () => {
    fakes.control.commandDelayMs = [15, 40];
    fakes.control.clockJumpMs = 60_000;
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);

    expect(await pool.reset()).toHaveLength(2);

    expect((pool as any).state).toBe('ready');
    expect(fakes.FakeWorker.instances.every((worker) => !worker.terminated)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => !manager.disposed)).toBe(true);
  });

  it('still times out genuinely hung workers under the mocked wall clock', async () => {
    fakes.control.stepTimeoutMs = 20;
    fakes.control.commandDelayMs = [60_000];
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);

    await expect(pool.step([0])).rejects.toThrow('Shared-memory step timed out after 20ms waiting for worker(s) 0');

    expect(fakes.FakeSharedMemoryManager.instances[0].readCalls).toBe(0);
    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });
});
