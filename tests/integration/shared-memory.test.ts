import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedMemoryManager, SHARED_INFO_FLOATS_PER_ENV } from '../../src/ipc/shared-memory';

describe('SharedMemoryManager', () => {
  describe('support check', () => {
    it('SharedArrayBuffer is supported', () => {
      const supported = SharedMemoryManager.isSupported();
      expect(supported).toBe(true);
    });
  });

  describe('action ring buffer', () => {
    let shm: SharedMemoryManager | null = null;

    beforeEach(() => {
      shm = new SharedMemoryManager(4, 16);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      shm?.dispose();
      shm = null;
    });

    it('read/write action ring buffer', () => {
      const actions = new Uint8Array([1, 2, 4, 8]);
      shm!.writeActions(actions);

      const slot = shm!.readActionSlot();
      const readActions = shm!.readActions(slot);
      expect(Array.from(readActions)).toEqual([1, 2, 4, 8]);
    });

    it('slot advances correctly', () => {
      const ringSize = 16;

      const actions1 = new Uint8Array([1, 2, 4, 8]);
      shm!.writeActions(actions1);
      const slot1 = shm!.readActionSlot();
      expect(slot1).toBe(0);

      const actions2 = new Uint8Array([16, 32, 1, 2]);
      shm!.writeActions(actions2);
      const slot2 = shm!.readActionSlot();
      expect(slot2).toBe(1);

      const readActions = shm!.readActions(slot2);
      expect(Array.from(readActions)).toEqual([16, 32, 1, 2]);
    });

    it.each([
      ['writeActions', true],
      ['writeActionsQuiet', false],
    ] as const)('%s publishes the slot only after its payload', (method, shouldWakeWorker) => {
      const actions = new Uint8Array([8, 4, 2, 1]);
      const actionSlotIndex = shm!.getControl().actionSlotIndex;
      const publishedPayloads: number[][] = [];
      const atomics = (globalThis as any).Atomics as {
        store(array: Int32Array, index: number, value: number): number;
      };
      const originalStore = atomics.store;
      const storeSpy = vi
        .spyOn(atomics, 'store')
        .mockImplementation((array: Int32Array, index: number, value: number) => {
          if (array === actionSlotIndex) {
            publishedPayloads.push(Array.from(shm!.readActions(value)));
          }
          return originalStore(array, index, value);
        });

      shm![method](actions);
      storeSpy.mockRestore();

      expect(publishedPayloads).toEqual([[8, 4, 2, 1]]);
      expect(shm!.hasNewActions()).toBe(shouldWakeWorker);

      if (!shouldWakeWorker) {
        shm!.sendCommand(1);
        expect(shm!.readCommand()).toBe(1);
        expect(shm!.hasNewActions()).toBe(true);
      }
    });
  });

  describe('worker synchronization', () => {
    let shm: SharedMemoryManager | null = null;

    beforeEach(() => {
      shm = new SharedMemoryManager(4, 16);
    });

    afterEach(() => {
      shm?.dispose();
      shm = null;
    });

    it('worker detects new actions', () => {
      shm!.writeActions(new Uint8Array([1, 2, 4, 8]));
      expect(shm!.hasNewActions()).toBe(true);
    });

    it('worker consumed actions clears flag', () => {
      shm!.signalWorkerConsumed();
      expect(shm!.hasNewActions()).toBe(false);
    });
  });

  describe('dynamic info layout', () => {
    it('preserves per-env native metadata and validates the shared stride', () => {
      const shm = new SharedMemoryManager(2, 16);
      try {
        expect(shm.getBuffer().byteLength).toBe(SharedMemoryManager.calculateBufferSize(2, 16));
        const single = new SharedMemoryManager(1, 16);
        try {
          expect(single.getBuffer().byteLength).toBe(296);
        } finally {
          single.dispose();
        }
        shm.writeAutoResetAfter(0, true);
        shm.writeAutoResetAfter(1, false);
        expect(Array.from(shm.readResults().autoResetAfter)).toEqual([1, 0]);
        shm.writeSeeds([42, 43]);
        expect(Array.from(shm.readSeeds())).toEqual([42, 43]);
        expect(Array.from(shm.readResults().autoResetAfter)).toEqual([42, 43]);
        shm.writeAutoResetAfter(0, false);
        shm.writeAutoResetAfter(1, true);
        expect(Array.from(shm.readResults().autoResetAfter)).toEqual([0, 1]);
        shm.writeInfo(0, [1, 1, 2, 3, 1, 67, 2]);
        shm.writeInfo(1, [0, 2, 4, 5, 1, 90, 1]);
        expect(Array.from(shm.readResults().info)).toEqual([1, 1, 2, 3, 1, 67, 2, 0, 2, 4, 5, 1, 90, 1]);
        expect(() => shm.writeInfo(0, new Float32Array(4))).toThrow(`${SHARED_INFO_FLOATS_PER_ENV} info floats`);
        expect(() => new SharedMemoryManager(2, 16, new SharedArrayBuffer(296))).toThrow('incompatible buffer size');
      } finally {
        shm.dispose();
      }
    });
  });

  describe('results signaling', () => {
    let shm: SharedMemoryManager | null = null;

    beforeEach(() => {
      shm = new SharedMemoryManager(4, 16);
    });

    afterEach(() => {
      shm?.dispose();
      shm = null;
    });

    it('reward and done values are readable', () => {
      shm!.writeReward(0, 1.5);
      shm!.writeDone(0, 1);
      shm!.signalMainReady();

      const results = shm!.readResults();
      expect(results.rewards[0]).toBeCloseTo(1.5);
      expect(results.dones[0]).toBe(1);
    });
  });
});
