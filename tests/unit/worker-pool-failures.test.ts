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
          candidate => candidate.getBuffer() === message.sharedBuffer,
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
        ticks: new Uint32Array(this.numEnvs),
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

import { WorkerPool } from '../../src/core/worker-pool';

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
    expect(fakes.FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances).toHaveLength(2);
    expect(fakes.FakeSharedMemoryManager.instances.every(manager => manager.disposed)).toBe(true);
    await expect(pool.step([0, 0])).rejects.toThrow('worker pool is in failed state');
  });

  it('rejects a shared worker error without reading partial results', async () => {
    pool = new WorkerPool(2);
    await pool.init(2, {}, true);
    fakes.control.commandBehaviors = ['complete', 'error'];

    await expect(pool.step([0, 0])).rejects.toThrow('Worker 1 reported an error');

    expect(fakes.FakeSharedMemoryManager.instances.every(manager => manager.readCalls === 0)).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances.every(manager => manager.disposed)).toBe(true);
    await expect(pool.reset()).rejects.toThrow('worker pool is in failed state');
  });

  it('times out without reading stale results and fails the pool', async () => {
    fakes.control.stepTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    await expect(pool.step([0])).rejects.toThrow(
      'Shared-memory step timed out after 20ms waiting for worker(s) 0',
    );

    expect(fakes.FakeSharedMemoryManager.instances[0].readCalls).toBe(0);
    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });

  it('times out during reset without returning stale observations', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    await expect(pool.reset()).rejects.toThrow(
      'Shared-memory reset timed out after 20ms waiting for worker(s) 0',
    );

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

    await expect(pool.step([0])).rejects.toThrow(
      'Worker 0 failed: Worker 0 exited unexpectedly with code 1',
    );

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

    await expect(pendingStep).rejects.toThrow(
      'Worker 0 failed: Worker 0 exited unexpectedly with code 1',
    );

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.step([0])).rejects.toThrow('worker pool is in failed state');
  });

  it('interrupts an active shared batch when close() is called and stays closed', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.commandBehaviors = ['timeout'];

    const pendingStep = pool.step([0]);
    await pool.close();

    await expect(pendingStep).rejects.toThrow(
      'Shared-memory step interrupted because worker pool is closed',
    );

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

    expect(fakes.FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
    await expect(pool.step([0, 0])).rejects.toThrow('worker pool is in failed state');
  });

  it('fails the pool when a hung worker times out after another worker error-replies in the same reset batch', async () => {
    fakes.control.messageTimeoutMs = 20;
    fakes.control.resetBehaviors = ['error', 'silent'];
    pool = new WorkerPool(2);
    await pool.init(2, {}, false);

    await expect(pool.reset()).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
    await expect(pool.reset()).rejects.toThrow('worker pool is in failed state');
  });

  it('keeps the pool usable when only live workers error-reply in a message-mode batch', async () => {
    fakes.control.stepBehaviors = ['error', 'ok'];
    pool = new WorkerPool(2);
    await pool.init(2, {}, false);

    await expect(pool.step([0, 0])).rejects.toThrow('synthetic step failure');

    expect(fakes.FakeWorker.instances.every(worker => worker.terminated)).toBe(false);
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

  it('propagates telemetry snapshot errors without failing the pool', async () => {
    fakes.control.messageTimeoutMs = 20;
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);

    await expect(pool.getTelemetrySnapshots()).rejects.toThrow('timed out');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(false);
    const results = await pool.step([0]);
    expect(results).toHaveLength(1);
  });

  it('propagates shared-memory read errors and disposes the pool', async () => {
    pool = new WorkerPool(1);
    await pool.init(1, {}, true);
    fakes.control.readError = true;

    await expect(pool.step([0])).rejects.toThrow('synthetic shared-memory read failure');

    expect(fakes.FakeWorker.instances[0].terminated).toBe(true);
    expect(fakes.FakeSharedMemoryManager.instances[0].disposed).toBe(true);
  });
});
