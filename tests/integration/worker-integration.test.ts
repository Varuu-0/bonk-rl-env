/**
 * worker-integration.test.ts — Integration tests for worker thread behavior
 *
 * Tests worker.ts indirectly through WorkerPool's public API:
 * - Worker initialization in both shared memory and message passing modes
 * - Worker reset handling
 * - Worker step processing
 * - Worker telemetry reporting
 * - Worker termination and cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('Worker thread integration', () => {
  let pool: WorkerPool;

  afterEach(() => {
    pool.close();
  });

  describe('message passing mode', () => {
    beforeEach(() => {
      pool = new WorkerPool(1);
    });

    it('worker initializes and reports mode', async () => {
      await pool.init(2, {}, false);
      expect(pool.isUsingSharedMemory()).toBe(false);
    });

    it('worker processes reset and returns observations', async () => {
      await pool.init(2, {}, false);
      const obs = await pool.reset([1, 2]);
      expect(obs).toHaveLength(2);
      expect(obs[0]).toHaveProperty('playerX');
      expect(obs[0]).toHaveProperty('playerY');
      expect(obs[0]).toHaveProperty('tick');
    });

    it('worker processes step and returns results', async () => {
      await pool.init(2, {}, false);
      await pool.reset([1, 2]);
      const results = await pool.step([0, 0]);
      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty('observation');
      expect(results[0]).toHaveProperty('reward');
      expect(results[0]).toHaveProperty('done');
      expect(results[0]).toHaveProperty('truncated');
      expect(results[0]).toHaveProperty('info');
    });

    it('worker handles multiple sequential steps', async () => {
      await pool.init(2, {}, false);
      await pool.reset([1, 2]);
      for (let i = 0; i < 10; i++) {
        const results = await pool.step([0, 0]);
        expect(results).toHaveLength(2);
      }
    });

    it('worker handles episode resets mid-training', async () => {
      await pool.init(2, {}, false);
      await pool.reset([1, 2]);
      // Simulate training: step until done, then reset
      for (let i = 0; i < 50; i++) {
        const results = await pool.step([0, 0]);
        if (results[0].done) {
          await pool.reset([1, 2]);
        }
      }
    });

    it('worker terminates cleanly on close', async () => {
      await pool.init(2, {}, false);
      await pool.reset([1, 2]);
      await pool.step([0, 0]);
      pool.close();
      // No error means clean termination
    });
  });

  describe('shared memory mode', () => {
    beforeEach(() => {
      pool = new WorkerPool(1);
    });

    it('worker initializes in shared memory mode when supported', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(2, {}, true);
        expect(pool.isUsingSharedMemory()).toBe(true);
      }
    });

    it('worker processes reset in shared memory mode', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(2, {}, true);
        const obs = await pool.reset([1, 2]);
        expect(obs).toHaveLength(2);
      }
    });

    it('worker processes step in shared memory mode', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(2, {}, true);
        await pool.reset([1, 2]);
        const results = await pool.step([0, 0]);
        expect(results).toHaveLength(2);
        expect(results[0]).toHaveProperty('observation');
        expect(results[0]).toHaveProperty('reward');
        expect(results[0]).toHaveProperty('done');
      }
    });

    it('worker handles many steps in shared memory mode', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(4, {}, true);
        await pool.reset([1, 2, 3, 4]);
        for (let i = 0; i < 20; i++) {
          const results = await pool.step([0, 0, 0, 0]);
          expect(results).toHaveLength(4);
        }
      }
    });
  });

  describe('multi-worker coordination', () => {
    it('multiple workers distribute environments correctly', async () => {
      pool = new WorkerPool(2);
      await pool.init(4, {}, false);
      await pool.reset([1, 2, 3, 4]);
      const results = await pool.step([0, 0, 0, 0]);
      expect(results).toHaveLength(4);
    });

    it('workers handle uneven environment distribution', async () => {
      pool = new WorkerPool(3);
      await pool.init(5, {}, false);
      await pool.reset([1, 2, 3, 4, 5]);
      const results = await pool.step([0, 0, 0, 0, 0]);
      expect(results).toHaveLength(5);
    });

    it('workers all terminate on close', async () => {
      pool = new WorkerPool(4);
      await pool.init(8, {}, false);
      pool.close();
      // No error means all workers terminated cleanly
    });
  });

  describe('worker telemetry', () => {
    it('worker reports telemetry snapshots', async () => {
      pool = new WorkerPool(1);
      await pool.init(2, {}, false);
      await pool.reset([1, 2]);
      await pool.step([0, 0]);
      const snapshots = await pool.getTelemetrySnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toBeInstanceOf(BigUint64Array);
    });

    it('multiple workers report individual telemetry', async () => {
      pool = new WorkerPool(2);
      await pool.init(4, {}, false);
      await pool.reset([1, 2, 3, 4]);
      await pool.step([0, 0, 0, 0]);
      const snapshots = await pool.getTelemetrySnapshots();
      expect(snapshots).toHaveLength(2);
    });
  });
});
