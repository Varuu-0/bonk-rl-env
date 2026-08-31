import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  type WorkerEvent = 'message' | 'error' | 'exit';
  type CommandBehavior = 'complete' | 'error' | 'timeout' | 'crash' | 'exit';

  const control = {
    initBehaviors: [] as Array<'ok' | 'error' | 'timeout'>,
    resetMessageBehavior: 'ok' as 'ok' | 'error' | 'silent',
    stepMessageBehavior: 'ok' as 'ok' | 'error' | 'silent',
    resetBehaviors: [] as Array<'ok' | 'error' | 'silent'>,
    stepBehaviors: [] as Array<'ok' | 'error' | 'silent'>,
    commandBehaviors: [] as CommandBehavior[],
    readError: false,
    stepTimeoutMs: 1000,
    messageTimeoutMs: 1000,
  };

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
        if (control.initBehaviors[this.index] === 'error') {
          this.emit('message', { id: message.id, status: 'error', error: 'synthetic init failure' });
        } else if (control.initBehaviors[this.index] !== 'timeout') {
          this.emit('message', {
            id: message.id,
            status: 'ok',
            data: { mode: message.sharedBuffer ? 'shared' : 'message' },
          });
        }
      } else if (message.type === 'reset') {
        const behavior = control.resetBehaviors[this.index] ?? control.resetMessageBehavior;
        if (behavior === 'error') {
          this.emit('message', { id: message.id, status: 'error', error: 'synthetic reset failure' });
        } else if (behavior !== 'silent') {
          this.emit('message', { id: message.id, status: 'ok', data: [{}] });
        }
      } else if (message.type === 'step') {
        const behavior = control.stepBehaviors[this.index] ?? control.stepMessageBehavior;
        if (behavior === 'error') {
          this.emit('message', { id: message.id, status: 'error', error: 'synthetic step failure' });
        } else if (behavior !== 'silent') {
          this.emit('message', { id: message.id, status: 'ok', data: [{}] });
        }
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
      const behavior = control.commandBehaviors[this.index] ?? 'complete';
      if (behavior === 'timeout') return;
      if (behavior === 'crash') {
        queueMicrotask(() => this.worker?.emit('error', new Error('synthetic worker crash')));
        return;
      }
      if (behavior === 'exit') {
        queueMicrotask(() => this.worker?.emit('exit', 1));
        return;
      }

      if (!this.sync) throw new Error('fake manager was not connected');
      this.ready = behavior === 'complete';
      Atomics.store(this.sync, this.workerIndex + 1, behavior === 'complete' ? 1 : -1);
      Atomics.add(this.sync, 0, 1);
      Atomics.notify(this.sync, 0);
    }

    isResultsReady(): boolean {
      return this.ready;
    }

    consumeResultsSignal(): void {
      this.ready = false;
    }

    readResults(): any {
      this.readCalls++;
      if (control.readError) throw new Error('synthetic shared-memory read failure');
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
    control.initBehaviors = [];
    control.resetMessageBehavior = 'ok';
    control.stepMessageBehavior = 'ok';
    control.resetBehaviors = [];
    control.stepBehaviors = [];
    control.commandBehaviors = [];
    control.readError = false;
    control.stepTimeoutMs = 1000;
    control.messageTimeoutMs = 1000;
  }

  return { control, FakeWorker, FakeSharedMemoryManager, reset };
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

import { WorkerPool, MAX_NUM_ENVS } from '../../src/core/worker-pool';
import { MAX_SUPPORTED_RESET_SEED } from '../../src/core/seed-range';
import { MAX_FRAME_SKIP } from '../../src/core/environment';

describe('WorkerPool failure state', () => {
  let pool: WorkerPool | undefined;

  beforeEach(() => {
    fakes.reset();
  });

  afterEach(async () => {
    await pool?.close();
    vi.restoreAllMocks();
  });

  it('cleans every started worker and shared manager after partial init failure', async () => {
    fakes.control.initBehaviors = ['ok', 'error'];
    pool = new WorkerPool(2);

    await expect(pool.init(2, {}, true)).rejects.toThrow('synthetic init failure');

    expect(fakes.FakeWorker.instances).toHaveLength(2);
    expect(fakes.FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(2);
    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => manager.disposed)).toBe(true);
    await expect(pool.step([0, 0])).rejects.toThrow('worker pool is in failed state');
  });

  it('failedStateError mirrors assertReady on a failed pool and throws on a non-failed one (review of #436)', async () => {
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);

    // Healthy pool: misuse is a call-site bug and must throw instead of
    // silently fabricating a plausible "...(unknown failure)" client error.
    expect(() => pool!.failedStateError('step')).toThrow(
      "Internal error: failedStateError('step') requires a failed pool, got state 'ready'",
    );

    fakes.control.commandBehaviors = ['complete', 'error'];
    await expect(pool.step([0, 0])).rejects.toThrow('Worker 1 reported an error');
    expect(pool.isFailed()).toBe(true);

    // The shared formatter reproduces the exact reactive message that a
    // retried step receives from assertReady — no duplicated template.
    const reactiveMessage = await pool.step([0, 0]).then(
      () => 'unexpected step success on a failed pool',
      (error: Error) => error.message,
    );
    expect(reactiveMessage).toContain('worker pool is in failed state');
    expect(pool.failedStateError('step')).toBe(reactiveMessage);

    // Post-close boundary: close() flips the state to 'closed' and clears
    // the recorded failure, and the guard must throw there too — the
    // documented precondition covers every non-failed state, not just
    // 'ready'.
    await pool.close();
    expect(pool.isFailed()).toBe(false);
    expect(() => pool!.failedStateError('step')).toThrow(
      "Internal error: failedStateError('step') requires a failed pool, got state 'closed'",
    );
  });

  it('rejects a shared worker error without reading partial results', async () => {
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);
    fakes.control.commandBehaviors = ['complete', 'error'];

    await expect(pool.step([0, 0])).rejects.toThrow('Worker 1 reported an error');

    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => manager.readCalls === 0)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances.every((manager) => manager.disposed)).toBe(true);
    await expect(pool.reset()).rejects.toThrow('worker pool is in failed state');
  });

  it('times out without reading stale results and fails the pool', async () => {
    fakes.control.stepTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    await expect(pool.step([0])).rejects.toThrow('Shared-memory step timed out after 20ms waiting for worker(s) 0');

    expect(fakes.FakeSharedMemoryManager.instances[0].readCalls).toBe(0);
    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });

  it('times out during reset without returning stale observations', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    await expect(pool.reset()).rejects.toThrow('Shared-memory reset timed out after 20ms waiting for worker(s) 0');

    expect(fakes.FakeSharedMemoryManager.instances[0].readCalls).toBe(0);
    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });

  it('propagates a worker crash through the active shared batch', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['crash'];

    await expect(pool.step([0])).rejects.toThrow('Worker 0 failed: synthetic worker crash');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });

  it('fails the pool when a worker exits during an active shared batch', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['exit'];

    await expect(pool.step([0])).rejects.toThrow('Worker 0 failed: Worker 0 exited unexpectedly with code 1');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a worker exits during an active message-passing batch', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);
    fakes.control.stepMessageBehavior = 'silent';

    const pendingStep = pool.step([0]);
    fakes.FakeWorker.instances[0].emit('exit', 1);

    await expect(pendingStep).rejects.toThrow('Worker 0 failed: Worker 0 exited unexpectedly with code 1');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('interrupts an active shared batch when close() is called and stays closed', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    const pendingStep = pool.step([0]);
    await pool.close();

    await expect(pendingStep).rejects.toThrow('Shared-memory step interrupted because worker pool is closed');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is closed');
  });

  it('fails the pool and cleans up when a worker never answers init', async () => {
    fakes.control.messageTimeoutMs = 20;
    fakes.control.initBehaviors = ['timeout'];
    pool = new WorkerPool(1);

    await expect(pool.init(1, {}, true)).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a message-mode worker hangs on step', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);
    fakes.control.stepMessageBehavior = 'silent';

    await expect(pool.step([0])).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a message-mode worker hangs on reset', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);
    fakes.control.resetMessageBehavior = 'silent';

    await expect(pool.reset()).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.reset()).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a hung worker times out after another worker error-replies in the same step batch', async () => {
    fakes.control.messageTimeoutMs = 20;
    fakes.control.stepBehaviors = ['error', 'silent'];
    pool = new WorkerPool(2);
    await pool.init(2, {}, false);

    await expect(pool.step([0, 0])).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    await expect(pool.step([0, 0])).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a hung worker times out after another worker error-replies in the same reset batch', async () => {
    fakes.control.messageTimeoutMs = 20;
    fakes.control.resetBehaviors = ['error', 'silent'];
    pool = new WorkerPool(2);
    await pool.init(2, {}, false);

    await expect(pool.reset()).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    await expect(pool.reset()).rejects.toThrow('worker pool is in failed state');
  });

  it('keeps the pool usable when only live workers error-reply in a message-mode batch', async () => {
    fakes.control.stepBehaviors = ['error', 'ok'];
    pool = new WorkerPool(2);
    await pool.init(2, {}, false);

    await expect(pool.step([0, 0])).rejects.toThrow('synthetic step failure');

    expect(fakes.FakeWorker.instances.every((worker) => worker.terminated)).toBe(false);
    fakes.control.stepBehaviors = ['ok', 'ok'];
    const results = await pool.step([0, 0]);
    expect(results).toHaveLength(2);
  });

  it('fails the pool when a message-mode telemetry snapshot times out', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);

    await expect(pool.getTelemetrySnapshots()).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('keeps the pool usable when detached telemetry snapshot times out', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);

    await expect(pool.getTelemetrySnapshots({ failOnTimeout: false })).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    const results = await pool.step([0]);
    expect(results).toHaveLength(1);
  });

  it('propagates message-mode reset errors without failing the pool', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);
    fakes.control.resetMessageBehavior = 'error';

    await expect(pool.reset()).rejects.toThrow('synthetic reset failure');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    fakes.control.resetMessageBehavior = 'ok';
    const observations = await pool.reset();
    expect(observations).toHaveLength(1);
  });

  it('propagates message-mode step errors without failing the pool', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, false);
    fakes.control.stepMessageBehavior = 'error';

    await expect(pool.step([0])).rejects.toThrow('synthetic step failure');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    fakes.control.stepMessageBehavior = 'ok';
    const results = await pool.step([0]);
    expect(results).toHaveLength(1);
  });

  it('treats a short action batch in shared mode as a transient per-request error', async () => {
    pool = new WorkerPool(1);
    await pool.init(2, {}, true);
    await pool.reset([1, 2]);

    await expect(pool.step([0])).rejects.toThrow('Invalid action batch: expected 2 actions for 2 environments, got 1');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(false);

    const results = await pool.step([0, 0]);
    expect(results).toHaveLength(2);
    await expect(pool.reset([1, 2])).resolves.toHaveLength(2);
  });

  it('treats a short action batch in message mode as a transient per-request error', async () => {
    pool = new WorkerPool(1);
    await pool.init(2, {}, false);
    await pool.reset([1, 2]);

    await expect(pool.step([0])).rejects.toThrow('Invalid action batch: expected 2 actions for 2 environments, got 1');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);

    await expect(pool.step([0, 0])).resolves.toBeDefined();
    expect((pool as any).state).toBe('ready');
  });

  it('rejects an over-long action batch without touching the pool', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    await pool.reset([1]);

    await expect(pool.step([0, 0])).rejects.toThrow('Invalid action batch: expected 1 action for 1 environment, got 2');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    await expect(pool.step([0])).resolves.toHaveLength(1);
  });

  it('treats an invalid (null) action in shared mode as a transient per-request error', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    await pool.reset([1]);

    await expect(pool.step([null as any])).rejects.toThrow(
      'Invalid action: expected a PlayerInput object or an encoded number, got null',
    );

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(false);
    expect((pool as any).state).toBe('ready');

    const results = await pool.step([0]);
    expect(results).toHaveLength(1);
  });

  it('returns non-blocking telemetry snapshots in shared mode without timing out (issue #240)', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);

    // Shared-mode workers block in Atomics.wait inside the wait-for-action
    // loop and can never answer GET_TELEMETRY, so the snapshot must return
    // immediately (empty) instead of waiting out messageTimeoutMs, and it
    // must not fail the pool.
    const started = Date.now();
    const snapshots = await pool.getTelemetrySnapshots();
    expect(Date.now() - started).toBeLessThan(200);
    expect(snapshots).toHaveLength(0);

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(false);
    const results = await pool.step([0]);
    expect(results).toHaveLength(1);
    expect((pool as any).state).toBe('ready');
  });

  it('propagates shared-memory read errors and disposes the pool', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.readError = true;

    await expect(pool.step([0])).rejects.toThrow('synthetic shared-memory read failure');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });

  describe('init validation (#195, #227)', () => {
    it('rejects init(0) in message mode with a clear error and no workers', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(0, {}, false)).rejects.toThrow(
        'Invalid environment count: expected a positive integer, got 0',
      );

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects init(0) in shared-memory mode with the same error and no workers', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(0, {}, true)).rejects.toThrow(
        'Invalid environment count: expected a positive integer, got 0',
      );

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects init(-1) with a clear error in both transports (no RangeError)', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(1);
        await expect(p.init(-1, {}, useShared)).rejects.toThrow(
          'Invalid environment count: expected a positive integer, got -1',
        );
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        await p.close();
      }
    });

    it('rejects a non-integer totalEnvs in both transports', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(1);
        await expect(p.init(2.5, {}, useShared)).rejects.toThrow(
          'Invalid environment count: expected a positive integer, got 2.5',
        );
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        await p.close();
      }
    });

    it('keeps the pool usable after a rejected init', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(0, {}, true)).rejects.toThrow(
        'Invalid environment count: expected a positive integer, got 0',
      );

      await pool.init(1, {}, true);
      expect((pool as any).state).toBe('ready');
      const results = await pool.step([0]);
      expect(results).toHaveLength(1);
    });

    it('rejects an out-of-domain config seed in both transports before any worker or buffer exists (#460)', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(1);
        for (const badSeed of [2 ** 32, -1, 1.9, MAX_SUPPORTED_RESET_SEED + 1]) {
          await expect(p.init(2, { seed: badSeed }, useShared)).rejects.toThrow(
            `Invalid seed ${badSeed}: expected an integer in [0, ${MAX_SUPPORTED_RESET_SEED}]`,
          );
        }
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(0);
        expect((p as any).state).toBe('idle');
        await p.close();
      }
    });

    it('keeps an existing healthy pool serving after a rejected seed re-init (validation-only, #440 doctrine)', async () => {
      pool = new WorkerPool(1);

      await pool.init(1, { seed: 42 }, false);
      expect((pool as any).state).toBe('ready');
      expect(fakes.FakeWorker.instances).toHaveLength(1);
      const survivingWorker = fakes.FakeWorker.instances[0];

      await expect(pool.init(1, { seed: 2 ** 32 }, false)).rejects.toThrow(
        `Invalid seed ${2 ** 32}: expected an integer in [0, ${MAX_SUPPORTED_RESET_SEED}]`,
      );

      // The validation threw before closeInternal(): the healthy pool and
      // its live worker survive (same instance, not torn down, none
      // re-spawned) and keep serving.
      expect((pool as any).state).toBe('ready');
      expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
      expect(survivingWorker.terminated).toBe(false);
      const results = await pool.step([0]);
      expect(results).toHaveLength(1);
    });

    describe('pre-teardown per-env config validation (#488)', () => {
      it('keeps a healthy pool serving after a re-init rejected by maxTicks validation (#488)', async () => {
        pool = new WorkerPool(1);

        await pool.init(1, { maxTicks: 900, seed: 42 }, false);
        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toHaveLength(1);
        const survivingWorker = fakes.FakeWorker.instances[0];

        await expect(pool.init(1, { maxTicks: -1 }, false)).rejects.toThrow(
          'Invalid maxTicks -1: expected a positive integer',
        );

        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
        expect(survivingWorker.terminated).toBe(false);
        const results = await pool.step([0]);
        expect(results).toHaveLength(1);
      });

      it('rejects a snake_case max_ticks alias in a re-init without tearing down the pool (#488)', async () => {
        pool = new WorkerPool(1);

        await pool.init(1, { maxTicks: 900, seed: 7 }, false);
        const survivingWorker = fakes.FakeWorker.instances[0];

        await expect(pool.init(1, { max_ticks: 0 }, false)).rejects.toThrow(
          'Invalid maxTicks 0: expected a positive integer',
        );

        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
        expect(survivingWorker.terminated).toBe(false);
      });

      it('keeps a healthy pool serving after a re-init rejected by frameSkip validation (#488)', async () => {
        pool = new WorkerPool(1);

        await pool.init(1, { frameSkip: 4, seed: 42 }, false);
        const survivingWorker = fakes.FakeWorker.instances[0];

        await expect(pool.init(1, { frameSkip: 0 }, false)).rejects.toThrow(
          `Invalid frameSkip 0: expected an integer in [1, ${MAX_FRAME_SKIP}]`,
        );

        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
        expect(survivingWorker.terminated).toBe(false);
        const results = await pool.step([0]);
        expect(results).toHaveLength(1);
      });

      it('rejects a frameSkip past the MAX_FRAME_SKIP cap in a re-init without tearing down the pool (#488)', async () => {
        pool = new WorkerPool(1);

        await pool.init(1, { frameSkip: 4, seed: 42 }, false);
        const survivingWorker = fakes.FakeWorker.instances[0];

        await expect(pool.init(1, { frameSkip: MAX_FRAME_SKIP * 10 }, false)).rejects.toThrow(
          `Invalid frameSkip ${MAX_FRAME_SKIP * 10}: expected an integer in [1, ${MAX_FRAME_SKIP}]`,
        );

        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
        expect(survivingWorker.terminated).toBe(false);
      });

      it('keeps a healthy pool serving after a re-init rejected by aiPlayerId validation (#488)', async () => {
        pool = new WorkerPool(1);

        await pool.init(1, { numOpponents: 1, maxTicks: 900, seed: 42 }, false);
        const survivingWorker = fakes.FakeWorker.instances[0];

        await expect(pool.init(1, { aiPlayerId: 99, numOpponents: 1 }, false)).rejects.toThrow(
          'Invalid aiPlayerId 99: with 1 opponent(s) the player slots are 0..1',
        );
        await expect(pool.init(1, { aiPlayerId: -2 }, false)).rejects.toThrow(
          'Invalid aiPlayerId -2: expected a non-negative integer player slot',
        );

        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toEqual([survivingWorker]);
        expect(survivingWorker.terminated).toBe(false);
        const results = await pool.step([0]);
        expect(results).toHaveLength(1);
      });

      it('a genuinely failing re-init (post-teardown worker failure) still cleans up correctly (#440 legacy path)', async () => {
        fakes.control.initBehaviors = ['ok', 'error'];
        pool = new WorkerPool(1);

        // First init succeeds; the healthy worker survives it.
        await pool.init(1, { seed: 42 }, false);
        expect((pool as any).state).toBe('ready');
        expect(fakes.FakeWorker.instances).toHaveLength(1);

        // Re-init: closeInternal() tears down the healthy worker, the fresh
        // worker errors, failPool runs, and everything is cleaned up.
        await expect(pool.init(1, {}, false)).rejects.toThrow('synthetic init failure');

        expect((pool as any).state).toBe('failed');
        expect(fakes.FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
        expect(fakes.FakeSharedMemoryManager.instances.every((manager) => manager.disposed)).toBe(true);
        await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
      });
    });

    it('still initializes successfully with a valid config seed', async () => {
      pool = new WorkerPool(1);

      // Shared mode with the fakes (as in the MAX_NUM_ENVS acceptance test
      // above) so per-env batch lengths are modeled; the message-mode
      // fakes reply with one batch per worker regardless of env count.
      await pool.init(2, { seed: MAX_SUPPORTED_RESET_SEED }, true);
      expect((pool as any).state).toBe('ready');
      const results = await pool.step([0, 0]);
      expect(results).toHaveLength(2);
    });
  });

  describe('init upper-bound validation (#390)', () => {
    it('rejects MAX_NUM_ENVS + 1 in message mode with a clear error and no workers', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(MAX_NUM_ENVS + 1, {}, false)).rejects.toThrow(
        `Invalid environment count: expected an integer in [1, ${MAX_NUM_ENVS}], got ${MAX_NUM_ENVS + 1}`,
      );

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects MAX_NUM_ENVS + 1 in shared-memory mode with the same error and no buffers', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(MAX_NUM_ENVS + 1, {}, true)).rejects.toThrow(
        `Invalid environment count: expected an integer in [1, ${MAX_NUM_ENVS}], got ${MAX_NUM_ENVS + 1}`,
      );

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects huge-but-integer counts in both transports with the bound, not a RangeError or timeout', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(1);
        for (const oversized of [1e6, 2 ** 40]) {
          const started = Date.now();
          await expect(p.init(oversized, {}, useShared)).rejects.toThrow(
            `Invalid environment count: expected an integer in [1, ${MAX_NUM_ENVS}], got ${oversized}`,
          );
          expect(Date.now() - started).toBeLessThan(1000);
        }
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        expect((p as any).state).toBe('idle');
        await p.close();
      }
    });

    it('accepts exactly MAX_NUM_ENVS in shared mode and keeps the pool usable', async () => {
      pool = new WorkerPool(1);
      await pool.init(MAX_NUM_ENVS, {}, true);

      expect((pool as any).state).toBe('ready');
      const results = await pool.step(new Array(MAX_NUM_ENVS).fill(0));
      expect(results).toHaveLength(MAX_NUM_ENVS);
    });

    it('keeps the pool usable after a rejected oversized init', async () => {
      pool = new WorkerPool(1);

      await expect(pool.init(MAX_NUM_ENVS + 1, {}, true)).rejects.toThrow('Invalid environment count');

      await pool.init(1, {}, true);
      expect((pool as any).state).toBe('ready');
      const results = await pool.step([0]);
      expect(results).toHaveLength(1);
    });
  });

  describe('worker-count validation (#269)', () => {
    it('rejects a zero-worker pool in message mode with a clear error and no workers', async () => {
      pool = new WorkerPool(0);

      await expect(pool.init(2, {}, false)).rejects.toThrow('Invalid worker count: expected a positive integer, got 0');

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects a zero-worker pool in shared-memory mode with the same error and no workers', async () => {
      pool = new WorkerPool(0);

      await expect(pool.init(2, {}, true)).rejects.toThrow('Invalid worker count: expected a positive integer, got 0');

      expect(fakes.FakeWorker.instances).toHaveLength(0);
      expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(0);
      expect((pool as any).state).toBe('idle');
    });

    it('rejects a negative worker count in both transports (no RangeError)', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(-1);
        await expect(p.init(2, {}, useShared)).rejects.toThrow(
          'Invalid worker count: expected a positive integer, got -1',
        );
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        expect((p as any).state).toBe('idle');
        await p.close();
      }
    });

    it('rejects a non-integer worker count in both transports', async () => {
      for (const useShared of [false, true]) {
        const p = new WorkerPool(1.5);
        await expect(p.init(2, {}, useShared)).rejects.toThrow(
          'Invalid worker count: expected a positive integer, got 1.5',
        );
        expect(fakes.FakeWorker.instances).toHaveLength(0);
        await p.close();
      }
    });

    it('keeps pools usable after a rejected worker-count init', async () => {
      pool = new WorkerPool(0);
      await expect(pool.init(2, {}, true)).rejects.toThrow('Invalid worker count');
      expect((pool as any).state).toBe('idle');
      await pool.close();

      const valid = new WorkerPool(2);
      await valid.init(2, {}, true);
      expect((valid as any).state).toBe('ready');
      const observations = await valid.reset();
      expect(observations).toHaveLength(2);
      await valid.close();
    });
  });
});
