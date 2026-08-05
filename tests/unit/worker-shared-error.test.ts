import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  const parentPort = {
    on: vi.fn(),
    postMessage: vi.fn(),
  };

  class ThrowingEnvironment {
    reset(): any {
      return {};
    }

    step(): never {
      throw new Error('synthetic environment failure');
    }

    getObservationFast(): Float32Array {
      return new Float32Array(16);
    }

    getStaticInfo(): { frameSkip: number; capZones: never[]; aiTeam: string } {
      return { frameSkip: 1, capZones: [], aiTeam: 'blue' };
    }
  }

  class FakeSharedMemoryManager {
    static isSupported(): boolean {
      return true;
    }

    static normalizeNumOpponents(value: unknown): number {
      const n = Number(value);
      if (!Number.isFinite(n)) return 1;
      return Math.max(0, Math.floor(n));
    }

    constructor(_numEnvs: number, _ringSize: number, _buffer: SharedArrayBuffer) {}
    waitForActions(): string { return 'not-equal'; }
    readCommand(): number { return 0; }
    readActionSlot(): number { return 0; }
    getActionsView(): Uint8Array { return new Uint8Array(1); }
  }

  return { parentPort, ThrowingEnvironment, FakeSharedMemoryManager };
});

vi.mock('worker_threads', () => ({ parentPort: fakes.parentPort }));
vi.mock('../../src/core/environment', () => ({
  BonkEnvironment: fakes.ThrowingEnvironment,
}));
vi.mock('../../src/ipc/shared-memory', () => ({
  SharedMemoryManager: fakes.FakeSharedMemoryManager,
}));

import '../../src/core/worker';

describe('shared-memory worker error signaling', () => {
  let messageHandler: (message: any) => void;

  beforeEach(() => {
    messageHandler = fakes.parentPort.on.mock.calls[0][1];
    fakes.parentPort.postMessage.mockClear();
  });

  it('publishes an error status and wakes the pool when environment work throws', () => {
    const syncBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const sync = new Int32Array(syncBuffer);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    messageHandler({
      type: 'init',
      id: 'init',
      numEnvs: 1,
      workerIndex: 0,
      sharedBuffer: new SharedArrayBuffer(4),
      syncBuffer,
    });
    fakes.parentPort.postMessage.mockClear();

    messageHandler({ type: 'wait-for-action' });

    expect(Atomics.load(sync, 0)).toBe(1);
    expect(Atomics.load(sync, 1)).toBe(-1);
    expect(fakes.parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'worker-loop-crash: synthetic environment failure',
      }),
    );
    errorSpy.mockRestore();
  });
});
