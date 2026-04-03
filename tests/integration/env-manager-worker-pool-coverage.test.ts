import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvManager, getGlobalEnvManager, resetGlobalEnvManager } from '../../src/env/env-manager';
import { WorkerPool } from '../../src/core/worker-pool';
import { PortManager } from '../../src/utils/port-manager';
import { BonkEnv } from '../../src/env/bonk-env';

describe('EnvManager uncovered paths', () => {
  let manager: EnvManager;

  beforeEach(() => {
    manager = new EnvManager({
      portManager: { startPort: 7500, endPort: 7600 },
      defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
    });
  });

  afterEach(async () => {
    try { await manager.shutdownAll(); } catch { /* ignore */ }
  });

  describe('shutdownAll error handling (line ~168)', () => {
    it('catches and logs errors when stopping environments during shutdown', { timeout: 30000 }, async () => {
      const envs = await manager.createPool(2);
      expect(envs.length).toBe(2);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      envs[1].stop = async () => {
        throw new Error('Simulated stop failure');
      };

      await manager.shutdownAll();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error stopping environment'),
        expect.any(Error)
      );

      errorSpy.mockRestore();
    });
  });

  describe('resetAll non-array result handling (line ~202)', () => {
    it('handles non-array reset results by pushing directly', { timeout: 30000 }, async () => {
      const envs = await manager.createPool(1);
      expect(envs.length).toBe(1);

      const env = envs[0];
      const originalReset = env.reset.bind(env);

      vi.spyOn(env, 'reset').mockImplementation(async (seeds?: number[]) => {
        return { mockObservation: true, seed: seeds?.[0] };
      });

      const results = await manager.resetAll([42]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ mockObservation: true, seed: 42 });

      vi.restoreAllMocks();
    });

    it('handles array reset results by spreading', { timeout: 30000 }, async () => {
      const envs = await manager.createPool(1);

      const env = envs[0];
      vi.spyOn(env, 'reset').mockImplementation(async () => {
        return [{ obs: 1 }, { obs: 2 }];
      });

      const results = await manager.resetAll();

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ obs: 1 });
      expect(results[1]).toEqual({ obs: 2 });

      vi.restoreAllMocks();
    });
  });

  describe('getGlobalEnvManager (lines 252-256)', () => {
    beforeEach(async () => {
      await resetGlobalEnvManager();
    });

    afterEach(async () => {
      await resetGlobalEnvManager();
    });

    it('creates a new instance when none exists', () => {
      const gm = getGlobalEnvManager({
        portManager: { startPort: 7700, endPort: 7800 }
      });

      expect(gm).toBeInstanceOf(EnvManager);
    });

    it('returns the same instance on subsequent calls', () => {
      const gm1 = getGlobalEnvManager();
      const gm2 = getGlobalEnvManager();

      expect(gm1).toBe(gm2);
    });

    it('uses provided options for the instance', () => {
      const gm = getGlobalEnvManager({
        portManager: { startPort: 7700, endPort: 7800 }
      });

      const pm = gm.getPortManager();
      expect(pm).toBeDefined();
    });
  });

  describe('resetGlobalEnvManager (lines 262-266)', () => {
    beforeEach(async () => {
      await resetGlobalEnvManager();
    });

    afterEach(async () => {
      await resetGlobalEnvManager();
    });

    it('resets the global instance when one exists', async () => {
      const gm = getGlobalEnvManager();
      expect(gm).toBeInstanceOf(EnvManager);

      await resetGlobalEnvManager();

      expect(() => getGlobalEnvManager()).not.toThrow();
      const newGm = getGlobalEnvManager();
      expect(newGm).toBeInstanceOf(EnvManager);
      expect(newGm).not.toBe(gm);
    });

    it('does nothing when no global instance exists', async () => {
      await resetGlobalEnvManager();
      await resetGlobalEnvManager();
    });
  });
});

describe('WorkerPool uncovered paths', () => {
  let pool: WorkerPool;

  afterEach(() => {
    pool?.close();
  });

  describe('encodeAction with PlayerInput objects (lines 515-522)', () => {
    it('encodes all action flags correctly via shared memory step', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      const playerInput = {
        left: true,
        right: true,
        up: true,
        down: true,
        heavy: true,
        grapple: true,
      };

      await pool.reset([1]);
      const results = await pool.step([playerInput]);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('observation');
      expect(results[0]).toHaveProperty('reward');
    });

    it('encodes partial action flags correctly', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      const playerInput = {
        left: true,
        right: false,
        up: true,
        down: false,
        heavy: false,
        grapple: true,
      };

      await pool.reset([1]);
      const results = await pool.step([playerInput]);

      expect(results).toHaveLength(1);
    });

    it('encodes empty action object (all flags false)', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      const playerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      };

      await pool.reset([1]);
      const results = await pool.step([playerInput]);

      expect(results).toHaveLength(1);
    });

    it('handles mixed encoded numbers and PlayerInput objects', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(2, {}, true);

      await pool.reset([1, 2]);
      const results = await pool.step([
        { left: true, right: false, up: false, down: false, heavy: false, grapple: false },
        0
      ]);

      expect(results).toHaveLength(2);
    });
  });

  describe('extractObservation fallback without template (line 534)', () => {
    it('creates new observation object when template is missing via shared memory reset', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      const results = await pool.reset([1]);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('playerX');
      expect(results[0]).toHaveProperty('playerY');
      expect(results[0]).toHaveProperty('playerVelX');
      expect(results[0]).toHaveProperty('playerVelY');
      expect(results[0]).toHaveProperty('playerAngle');
      expect(results[0]).toHaveProperty('playerAngularVel');
      expect(results[0]).toHaveProperty('playerIsHeavy');
      expect(results[0]).toHaveProperty('opponents');
      expect(results[0]).toHaveProperty('tick');
    });

    it('returns observation with correct structure from shared memory step', async () => {
      if (!WorkerPool.isSupported()) {
        return;
      }

      pool = new WorkerPool(1);
      await pool.init(1, {}, true);

      await pool.reset([1]);
      const results = await pool.step([0]);

      expect(results).toHaveLength(1);
      const obs = results[0].observation;
      expect(obs).toHaveProperty('playerX');
      expect(obs).toHaveProperty('playerY');
      expect(obs).toHaveProperty('opponents');
      expect(Array.isArray(obs.opponents)).toBe(true);
      expect(obs.opponents[0]).toHaveProperty('x');
      expect(obs.opponents[0]).toHaveProperty('y');
      expect(obs.opponents[0]).toHaveProperty('alive');
    });
  });
});
