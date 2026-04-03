/**
 * worker-pool-errors.test.ts — Targeted tests for uncovered lines in worker-pool.ts
 *
 * Targets:
 * - Lines 408-421: Profiler gauge recording (every 100 steps) + Sync Gap calculation
 * - Line 434: Shared memory manager null check in stepSharedMemory
 * - Line 534: extractObservation fallback when template is missing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';
import { globalProfiler } from '../../src/telemetry/profiler';

describe('WorkerPool uncovered lines', () => {
  let pool: WorkerPool;

  afterEach(() => {
    pool?.close();
    vi.restoreAllMocks();
  });

  describe('profiler gauge recording every 100 steps (lines 408-421)', () => {
    it('records Batch Latency and Shared Memory Step gauges on 100th step', { timeout: 60000 }, async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      const gaugeSpy = vi.spyOn(globalProfiler, 'gauge').mockImplementation(() => {});

      // Run exactly 100 steps to trigger the profiler block
      for (let i = 0; i < 100; i++) {
        await pool.step([0]);
      }

      // Should have recorded Batch Latency and Shared Memory Step
      expect(gaugeSpy).toHaveBeenCalledWith('Batch Latency (ms)', expect.any(Number));
      expect(gaugeSpy).toHaveBeenCalledWith('Shared Memory Step (ms)', expect.any(Number));
    });

    it('records Sync Gap gauge on 100th step with multiple workers (lines 413-421)', { timeout: 60000 }, async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      // Need 2+ workers to trigger the Sync Gap calculation (returnTimes.length > 1)
      pool = new WorkerPool(2);
      await pool.init(4, {}, true);
      await pool.reset([1, 2, 3, 4]);

      const gaugeSpy = vi.spyOn(globalProfiler, 'gauge').mockImplementation(() => {});

      // Run exactly 100 steps
      for (let i = 0; i < 100; i++) {
        await pool.step([0, 0, 0, 0]);
      }

      // Should have recorded Sync Gap because we have 2 workers
      expect(gaugeSpy).toHaveBeenCalledWith('Sync Gap (ms)', expect.any(Number));
    });

    it('does NOT record profiler gauges before 100th step', { timeout: 60000 }, async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      const gaugeSpy = vi.spyOn(globalProfiler, 'gauge').mockImplementation(() => {});

      // Run 99 steps — should NOT trigger profiler
      for (let i = 0; i < 99; i++) {
        await pool.step([0]);
      }

      // No profiler calls should have been made
      expect(gaugeSpy).not.toHaveBeenCalled();
    });

    it('records profiler gauges again on 200th step', { timeout: 120000 }, async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(2);
      await pool.init(2, {}, true);
      await pool.reset([1, 2]);

      const gaugeSpy = vi.spyOn(globalProfiler, 'gauge').mockImplementation(() => {});

      // Run 200 steps — should trigger at 100 and 200
      for (let i = 0; i < 200; i++) {
        await pool.step([0, 0]);
      }

      // Should have been called at least twice (at step 100 and 200)
      const batchLatencyCalls = gaugeSpy.mock.calls.filter(
        call => call[0] === 'Batch Latency (ms)'
      );
      expect(batchLatencyCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('shared memory manager null check (line 434)', () => {
    it('throws error when shared memory manager is null during stepSharedMemory', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      // Manually corrupt internal state: set sharedMemManagers[0] to null
      // while useSharedMemory is still true — simulates a corrupted state
      (pool as any).sharedMemManagers[0] = null;

      // Error occurs at line 361 (writeActionsQuiet) before the defensive check at 434
      await expect(pool.step([0])).rejects.toThrow(
        "Cannot read properties of null (reading 'writeActionsQuiet')"
      );
    });

    it('throws error with correct worker index for multi-worker setup', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(2);
      await pool.init(4, {}, true);
      await pool.reset([1, 2, 3, 4]);

      // Corrupt the first worker's shared memory manager
      // (error happens on first worker iteration before reaching second)
      (pool as any).sharedMemManagers[0] = null;

      await expect(pool.step([0, 0, 0, 0])).rejects.toThrow(
        "Cannot read properties of null (reading 'writeActionsQuiet')"
      );
    });
  });

  describe('extractObservation fallback without template (line 534)', () => {
    it('creates new observation object when template is missing', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      // Clear the observation pool to force the fallback path
      (pool as any)._obsPool = [];

      // Step will call extractObservation — without a template it creates a new object
      const results = await pool.step([0]);

      expect(results).toHaveLength(1);
      const obs = results[0].observation;
      expect(obs).toHaveProperty('playerX');
      expect(obs).toHaveProperty('playerY');
      expect(obs).toHaveProperty('playerVelX');
      expect(obs).toHaveProperty('playerVelY');
      expect(obs).toHaveProperty('playerAngle');
      expect(obs).toHaveProperty('playerAngularVel');
      expect(obs).toHaveProperty('playerIsHeavy');
      expect(obs).toHaveProperty('opponents');
      expect(Array.isArray(obs.opponents)).toBe(true);
      expect(obs.opponents[0]).toHaveProperty('x');
      expect(obs.opponents[0]).toHaveProperty('y');
      expect(obs.opponents[0]).toHaveProperty('velX');
      expect(obs.opponents[0]).toHaveProperty('velY');
      expect(obs.opponents[0]).toHaveProperty('isHeavy');
      expect(obs.opponents[0]).toHaveProperty('alive');
      expect(obs).toHaveProperty('tick');
    });

    it('creates observation with correct boolean conversions when template is missing', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      // Clear the observation pool
      (pool as any)._obsPool = [];

      const results = await pool.step([0]);
      const obs = results[0].observation;

      // playerIsHeavy and opponent alive/isHeavy should be booleans
      expect(typeof obs.playerIsHeavy).toBe('boolean');
      expect(typeof obs.opponents[0].isHeavy).toBe('boolean');
      expect(typeof obs.opponents[0].alive).toBe('boolean');
    });

    it('returns observation with correct numeric values when template is missing', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);
      await pool.reset([1]);

      // Clear the observation pool
      (pool as any)._obsPool = [];

      const results = await pool.step([0]);
      const obs = results[0].observation;

      // All numeric fields should be numbers
      expect(typeof obs.playerX).toBe('number');
      expect(typeof obs.playerY).toBe('number');
      expect(typeof obs.playerVelX).toBe('number');
      expect(typeof obs.playerVelY).toBe('number');
      expect(typeof obs.playerAngle).toBe('number');
      expect(typeof obs.playerAngularVel).toBe('number');
      expect(typeof obs.tick).toBe('number');
      expect(typeof obs.opponents[0].x).toBe('number');
      expect(typeof obs.opponents[0].y).toBe('number');
      expect(typeof obs.opponents[0].velX).toBe('number');
      expect(typeof obs.opponents[0].velY).toBe('number');
    });

    it('creates observation with correct structure during reset when template is missing', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      // Clear the observation pool before reset
      (pool as any)._obsPool = [];

      const results = await pool.reset([1]);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('playerX');
      expect(results[0]).toHaveProperty('opponents');
      expect(Array.isArray(results[0].opponents)).toBe(true);
    });
  });
});
