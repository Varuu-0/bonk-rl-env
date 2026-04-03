import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvManager } from '../../src/env/env-manager';
import { BonkEnv } from '../../src/env/bonk-env';
import { PortManager } from '../../src/utils/port-manager';

describe('EnvManager lifecycle', () => {
  let manager: EnvManager;

  beforeEach(() => {
    manager = new EnvManager({
      portManager: { startPort: 7000, endPort: 7100 }
    });
  });

  afterEach(async () => {
    try { await manager.shutdownAll(); } catch { /* ignore */ }
  });

  describe('createEnv', () => {
    it('creates a single environment', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(env).toBeDefined();
      expect(env.isActive()).toBe(true);
    });

    it('creates environment with custom config', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({
        numEnvs: 2,
        useSharedMemory: false
      });
      expect(env).toBeDefined();
      expect(env.isActive()).toBe(true);
    });

    it('creates environment with shared memory', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({
        numEnvs: 1,
        useSharedMemory: true
      });
      expect(env).toBeDefined();
      expect(env.isActive()).toBe(true);
    });

    it('assigns unique IDs to environments', { timeout: 30000 }, async () => {
      const env1 = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      const env2 = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(env1.id).not.toBe(env2.id);
    });

    it('assigns unique ports to environments', { timeout: 30000 }, async () => {
      const env1 = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      const env2 = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(env1.port).not.toBe(env2.port);
    });

    it('throws after shutdown', async () => {
      await manager.shutdownAll();
      await expect(manager.createEnv()).rejects.toThrow('EnvManager has been shut down');
    });
  });

  describe('createPool', () => {
    it('creates a pool of environments', { timeout: 30000 }, async () => {
      const envs = await manager.createPool(3, { numEnvs: 1, useSharedMemory: false });
      expect(envs).toHaveLength(3);
      expect(envs.every(e => e.isActive())).toBe(true);
    });

    it('throws when pool size is less than 1', async () => {
      await expect(manager.createPool(0)).rejects.toThrow('Pool size must be at least 1');
    });

    it('throws when pool size is negative', async () => {
      await expect(manager.createPool(-1)).rejects.toThrow('Pool size must be at least 1');
    });
  });

  describe('shutdownAll', () => {
    it('shuts down all environments', { timeout: 30000 }, async () => {
      await manager.createPool(2, { numEnvs: 1, useSharedMemory: false });
      await manager.shutdownAll();
      expect(manager.getEnvCount()).toBe(0);
    });

    it('shutdown is idempotent', async () => {
      await manager.shutdownAll();
      await manager.shutdownAll();
    });

    it('marks manager as shut down', async () => {
      expect(manager.isShuttingDown()).toBe(false);
      await manager.shutdownAll();
      expect(manager.isShuttingDown()).toBe(true);
    });
  });

  describe('getAllEnvs', () => {
    it('returns empty array initially', () => {
      expect(manager.getAllEnvs()).toEqual([]);
    });

    it('returns created environments', { timeout: 30000 }, async () => {
      await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(manager.getAllEnvs()).toHaveLength(2);
    });
  });

  describe('getEnvCount', () => {
    it('returns 0 initially', () => {
      expect(manager.getEnvCount()).toBe(0);
    });

    it('returns correct count after creating environments', { timeout: 30000 }, async () => {
      await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(manager.getEnvCount()).toBe(1);
      await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(manager.getEnvCount()).toBe(2);
    });

    it('returns 0 after shutdown', { timeout: 30000 }, async () => {
      await manager.createPool(3, { numEnvs: 1, useSharedMemory: false });
      await manager.shutdownAll();
      expect(manager.getEnvCount()).toBe(0);
    });
  });

  describe('getEnv', () => {
    it('returns environment by ID', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      const found = manager.getEnv(env.id);
      expect(found).toBe(env);
    });

    it('returns undefined for unknown ID', () => {
      expect(manager.getEnv('nonexistent')).toBeUndefined();
    });
  });

  describe('hasEnv', () => {
    it('returns true for existing environment', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      expect(manager.hasEnv(env.id)).toBe(true);
    });

    it('returns false for unknown ID', () => {
      expect(manager.hasEnv('nonexistent')).toBe(false);
    });
  });

  describe('destroyEnv', () => {
    it('destroys a specific environment', { timeout: 30000 }, async () => {
      const env = await manager.createEnv({ numEnvs: 1, useSharedMemory: false });
      await manager.destroyEnv(env.id);
      expect(manager.getEnvCount()).toBe(0);
    });

    it('does not throw for unknown ID', async () => {
      await expect(manager.destroyEnv('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('resetAll', () => {
    it('resets all environments', { timeout: 30000 }, async () => {
      await manager.createPool(2, { numEnvs: 1, useSharedMemory: false });
      const results = await manager.resetAll([1, 2]);
      expect(results).toBeDefined();
    });

    it('works without seeds', { timeout: 30000 }, async () => {
      await manager.createPool(2, { numEnvs: 1, useSharedMemory: false });
      const results = await manager.resetAll();
      expect(results).toBeDefined();
    });
  });

  describe('stepAll', () => {
    it('steps all environments', { timeout: 30000 }, async () => {
      await manager.createPool(2, { numEnvs: 1, useSharedMemory: false });
      await manager.resetAll([1, 2]);
      const results = await manager.stepAll([0, 0]);
      expect(results).toBeDefined();
      expect(results).toHaveLength(2);
    });
  });

  describe('getPortManager', () => {
    it('returns the port manager instance', () => {
      const pm = manager.getPortManager();
      expect(pm).toBeInstanceOf(PortManager);
    });
  });
});

describe('BonkEnv lifecycle', () => {
  let env: BonkEnv;
  let pm: PortManager;

  beforeEach(() => {
    pm = new PortManager({ startPort: 7200, endPort: 7300 });
  });

  afterEach(async () => {
    try { await env?.stop(); } catch { /* ignore */ }
    pm.releaseAll();
  });

  describe('construction', () => {
    it('assigns unique ID', () => {
      const env1 = new BonkEnv({ numEnvs: 1, portManager: pm });
      const env2 = new BonkEnv({ numEnvs: 1, portManager: pm });
      expect(env1.id).not.toBe(env2.id);
    });

    it('assigns port from port manager', () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      expect(env.port).toBeGreaterThanOrEqual(7200);
      expect(env.port).toBeLessThanOrEqual(7300);
    });

    it('uses provided port', () => {
      env = new BonkEnv({ numEnvs: 1, port: 7250, portManager: pm });
      expect(env.port).toBe(7250);
    });

    it('is not active initially', () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      expect(env.isActive()).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('starts and stops successfully', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      expect(env.isActive()).toBe(true);
      await env.stop();
      expect(env.isActive()).toBe(false);
    });

    it('throws when starting already running environment', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      await expect(env.start()).rejects.toThrow('already running');
    });

    it('stop is idempotent', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      await env.stop();
      await env.stop();
    });

    it('can restart after stop', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      await env.stop();
      await env.start();
      expect(env.isActive()).toBe(true);
    });

    it('releases port on stop', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      const port = env.port;
      await env.start();
      await env.stop();
      expect(pm.isAllocated(port)).toBe(false);
    });
  });

  describe('reset', () => {
    it('reset works after start', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      const obs = await env.reset([1]);
      expect(obs).toBeDefined();
    });

    it('throws when resetting non-running environment', async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await expect(env.reset([1])).rejects.toThrow('not running');
    });

    it('works without seeds', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      const obs = await env.reset();
      expect(obs).toBeDefined();
    });
  });

  describe('step', () => {
    it('step works after reset', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      await env.reset([1]);
      const results = await env.step([0]);
      expect(results).toBeDefined();
    });

    it('throws when stepping non-running environment', async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await expect(env.step([0])).rejects.toThrow('not running');
    });
  });

  describe('getPool', () => {
    it('returns null when not running', () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      expect(env.getPool()).toBeNull();
    });

    it('returns pool when running', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      expect(env.getPool()).not.toBeNull();
    });
  });

  describe('ready', () => {
    it('resolves when running', { timeout: 30000 }, async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await env.start();
      await expect(env.ready()).resolves.not.toThrow();
    });

    it('throws when not running', async () => {
      env = new BonkEnv({ numEnvs: 1, portManager: pm });
      await expect(env.ready()).rejects.toThrow('not running');
    });
  });
});

describe('PortManager edge cases', () => {
  let pm: PortManager;

  beforeEach(() => {
    pm = new PortManager({ startPort: 7400, endPort: 7410 });
  });

  afterEach(() => {
    pm.releaseAll();
  });

  describe('allocation', () => {
    it('allocates sequential ports', () => {
      const p1 = pm.allocate();
      const p2 = pm.allocate();
      expect(p2).toBe(p1 + 1);
    });

    it('respects start hint via reserve', () => {
      pm.reserve(7405);
      expect(pm.isAllocated(7405)).toBe(true);
    });

    it('skips reserved ports during sequential allocation', () => {
      pm.reserve(7405);
      const p1 = pm.allocate();
      expect(p1).toBe(7400);
      const p2 = pm.allocate();
      expect(p2).toBe(7401);
      expect(p2).not.toBe(7405);
    });

    it('wraps around at end of range', () => {
      for (let i = 0; i < 11; i++) {
        pm.allocate();
      }
      pm.releaseAll();
      const p = pm.allocate();
      expect(p).toBe(7400);
    });

    it('isAllocated returns correct values', () => {
      const p = pm.allocate();
      expect(pm.isAllocated(p)).toBe(true);
      pm.release(p);
      expect(pm.isAllocated(p)).toBe(false);
    });

    it('getAllocatedCount is accurate', () => {
      expect(pm.getAllocatedCount()).toBe(0);
      pm.allocate();
      pm.allocate();
      expect(pm.getAllocatedCount()).toBe(2);
      pm.release(7400);
      expect(pm.getAllocatedCount()).toBe(1);
    });

    it('throws when no ports available', () => {
      for (let i = 0; i < 11; i++) {
        pm.allocate();
      }
      expect(() => pm.allocate()).toThrow('No available ports');
    });

    it('reallocates released port after wraparound', () => {
      const p1 = pm.allocate();
      const p2 = pm.allocate();
      pm.release(p1);
      pm.release(p2);
      pm.releaseAll();
      const p3 = pm.allocate();
      expect(p3).toBe(p1);
    });
  });

  describe('reserve', () => {
    it('throws when reserving already allocated port', () => {
      pm.allocate();
      expect(() => pm.reserve(7400)).toThrow('already allocated');
    });

    it('can reserve port outside sequential range', () => {
      pm.reserve(7410);
      expect(pm.isAllocated(7410)).toBe(true);
    });
  });

  describe('release', () => {
    it('does not throw when releasing unallocated port', () => {
      expect(() => pm.release(7405)).not.toThrow();
    });

    it('releaseAll resets current port pointer', () => {
      pm.allocate();
      pm.allocate();
      pm.releaseAll();
      expect(pm.allocate()).toBe(7400);
    });
  });

  describe('invalid range', () => {
    it('throws when startPort >= endPort', () => {
      expect(() => new PortManager({ startPort: 7500, endPort: 7400 })).toThrow('Start port must be less than end port');
    });

    it('throws when ports are out of valid range', () => {
      expect(() => new PortManager({ startPort: 0, endPort: 100 })).toThrow('Invalid port range');
      expect(() => new PortManager({ startPort: 6000, endPort: 70000 })).toThrow('Invalid port range');
    });
  });

  describe('isPortAvailable', () => {
    it('returns boolean for high port', async () => {
      const available = await PortManager.isPortAvailable(59999);
      expect(typeof available).toBe('boolean');
    });
  });

  describe('findAvailablePort', () => {
    it('finds an available port', async () => {
      const port = await PortManager.findAvailablePort(59000);
      expect(port).toBeGreaterThanOrEqual(59000);
    });
  });
});
