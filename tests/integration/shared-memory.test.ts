import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedMemoryManager } from '../../src/ipc/shared-memory';

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
