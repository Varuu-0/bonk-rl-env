/**
 * worker-pool-blackbox.test.ts — Black-box tests for WorkerPool
 *
 * These tests treat WorkerPool as a black box:
 * - Call init(), reset(), step(), close() through the public API
 * - Validate outputs (observations, rewards, done flags)
 * - Test lifecycle transitions, boundary values, error recovery
 * - No knowledge of internal worker threads, SharedMemoryManager, or message passing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool black-box', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool(1);
  });

  afterEach(() => {
    pool.close();
  });

  describe('init lifecycle', () => {
    it('initializes 1 environment successfully', async () => {
      await pool.init(1, {}, false);
    });

    it('initializes 4 environments successfully', async () => {
      await pool.init(4, {}, false);
    });

    it('initializes 16 environments successfully', async () => {
      await pool.init(16, {}, false);
    });

    it('can be re-initialized after close', async () => {
      await pool.init(2, {}, false);
      pool.close();
      pool = new WorkerPool(1);
      await pool.init(2, {}, false);
    });

    it('can be re-initialized without explicit close', async () => {
      await pool.init(2, {}, false);
      await pool.init(4, {}, false);
    });
  });

  describe('reset lifecycle', () => {
    beforeEach(async () => {
      await pool.init(3, {}, false);
    });

    it('returns observations for all environments', async () => {
      const obs = await pool.reset([1, 2, 3]);
      expect(obs).toHaveLength(3);
    });

    it('returns observations without seeds', async () => {
      const obs = await pool.reset();
      expect(obs).toHaveLength(3);
    });

    it('same seed produces same observation', async () => {
      const obs1 = await pool.reset([42, 42, 42]);
      const obs2 = await pool.reset([42, 42, 42]);
      expect(obs1).toEqual(obs2);
    });

    it('different seeds produce different observations', async () => {
      const obs1 = await pool.reset([1, 1, 1]);
      const obs2 = await pool.reset([999, 999, 999]);
      expect(obs1).not.toEqual(obs2);
    });
  });

  describe('step lifecycle', () => {
    beforeEach(async () => {
      await pool.init(3, {}, false);
      await pool.reset([1, 2, 3]);
    });

    it('returns results for all environments', async () => {
      const results = await pool.step([0, 0, 0]);
      expect(results).toHaveLength(3);
    });

    it('each result has required fields', async () => {
      const results = await pool.step([0, 0, 0]);
      for (const r of results) {
        expect(r).toHaveProperty('observation');
        expect(r).toHaveProperty('reward');
        expect(r).toHaveProperty('done');
        expect(r).toHaveProperty('truncated');
        expect(r).toHaveProperty('info');
      }
    });

    it('rewards are finite numbers', async () => {
      const results = await pool.step([0, 0, 0]);
      for (const r of results) {
        expect(Number.isFinite(r.reward)).toBe(true);
      }
    });

    it('done and truncated are booleans', async () => {
      const results = await pool.step([0, 0, 0]);
      for (const r of results) {
        expect(typeof r.done).toBe('boolean');
        expect(typeof r.truncated).toBe('boolean');
      }
    });

    it('observations are arrays of 14 numbers', async () => {
      const results = await pool.step([0, 0, 0]);
      for (const r of results) {
        expect(Array.isArray(r.observation)).toBe(true);
        expect(r.observation).toHaveLength(14);
      }
    });

    it('all valid actions (0-63) accepted', async () => {
      for (let action = 0; action <= 63; action++) {
        const results = await pool.step([action, action, action]);
        expect(results).toHaveLength(3);
      }
    });

    it('out-of-range actions handled gracefully', async () => {
      const results = await pool.step([100, -1, 255]);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(Number.isFinite(r.reward)).toBe(true);
      }
    });

    it('multiple sequential steps produce consistent results', async () => {
      await pool.reset([1, 2, 3]);
      const r1 = await pool.step([0, 0, 0]);
      const r2 = await pool.step([0, 0, 0]);
      expect(r1).toHaveLength(3);
      expect(r2).toHaveLength(3);
    });

    it('reset between steps works correctly', async () => {
      await pool.step([0, 0, 0]);
      await pool.reset([1, 2, 3]);
      const results = await pool.step([0, 0, 0]);
      expect(results).toHaveLength(3);
    });
  });

  describe('error recovery', () => {
    it('close is idempotent', () => {
      pool.close();
      pool.close();
    });

    it('close after init cleans up resources', async () => {
      await pool.init(4, {}, false);
      pool.close();
    });
  });

  describe('shared memory mode', () => {
    it('initializes with shared memory enabled', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(2, {}, true);
        expect(pool.isUsingSharedMemory()).toBe(true);
      }
    });

    it('shared memory step returns same structure as message passing', async () => {
      if (WorkerPool.isSupported()) {
        await pool.init(2, {}, true);
        await pool.reset([1, 2]);
        const results = await pool.step([0, 0]);
        expect(results).toHaveLength(2);
        for (const r of results) {
          expect(r).toHaveProperty('observation');
          expect(r).toHaveProperty('reward');
          expect(r).toHaveProperty('done');
        }
      }
    });
  });

  describe('multi-worker scaling', () => {
    it('2 workers with 4 environments', async () => {
      const pool2 = new WorkerPool(2);
      await pool2.init(4, {}, false);
      await pool2.reset([1, 2, 3, 4]);
      const results = await pool2.step([0, 0, 0, 0]);
      expect(results).toHaveLength(4);
      pool2.close();
    });

    it('4 workers with 8 environments', async () => {
      const pool4 = new WorkerPool(4);
      await pool4.init(8, {}, false);
      await pool4.reset([1, 2, 3, 4, 5, 6, 7, 8]);
      const results = await pool4.step([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(results).toHaveLength(8);
      pool4.close();
    });
  });
});
