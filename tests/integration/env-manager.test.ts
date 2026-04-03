import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PortManager } from '../../src/utils/port-manager';
import { BonkEnv } from '../../src/env/bonk-env';
import { EnvManager } from '../../src/env/env-manager';
import { safeDestroy } from '../utils/test-helpers';

describe('EnvManager', () => {
  describe('Port Manager', () => {
    describe('basic allocation', () => {
      it('allocates port in range', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        expect(port1).toBeGreaterThanOrEqual(6000);
        expect(port1).toBeLessThanOrEqual(6005);
        pm.releaseAll();
      });

      it('allocates different port', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        const port2 = pm.allocate();
        expect(port1).not.toBe(port2);
        pm.releaseAll();
      });

      it('allocates third unique port', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        const port2 = pm.allocate();
        const port3 = pm.allocate();
        expect(port3).not.toBe(port1);
        expect(port3).not.toBe(port2);
        pm.releaseAll();
      });

      it('allocated count is 3', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        pm.allocate();
        pm.allocate();
        pm.allocate();
        expect(pm.getAllocatedCount()).toBe(3);
        pm.releaseAll();
      });

      it('released port decreases count', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        pm.allocate();
        pm.allocate();
        pm.release(port1);
        expect(pm.getAllocatedCount()).toBe(2);
        pm.releaseAll();
      });

      it('can reallocate released port', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        pm.allocate();
        pm.allocate();
        pm.release(port1);
        const portReallocated = pm.allocate();
        expect(!pm.isAllocated(port1) || portReallocated === port1).toBe(true);
        pm.releaseAll();
      });

      it('reallocation restores count', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        const port1 = pm.allocate();
        pm.allocate();
        pm.allocate();
        pm.release(port1);
        pm.allocate();
        expect(pm.getAllocatedCount()).toBe(3);
        pm.releaseAll();
      });

      it('releaseAll clears all ports', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6005 });
        pm.allocate();
        pm.allocate();
        pm.allocate();
        pm.releaseAll();
        expect(pm.getAllocatedCount()).toBe(0);
      });
    });

    describe('range limits', () => {
      it('allocates up to range limit (3 ports)', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6002 });
        const p1 = pm.allocate();
        const p2 = pm.allocate();
        const p3 = pm.allocate();
        expect(p3).not.toBe(undefined);
        pm.releaseAll();
      });

      it('throws when no ports available', () => {
        const pm = new PortManager({ startPort: 6000, endPort: 6002 });
        pm.allocate();
        pm.allocate();
        pm.allocate();
        expect(() => pm.allocate()).toThrow();
        pm.releaseAll();
      });
    });

    describe('port availability check', () => {
      it('can check if port is available', async () => {
        const available = await PortManager.isPortAvailable(59999);
        expect(typeof available).toBe('boolean');
      });
    });
  });

  describe('multiple environments', () => {
    it('creates 2 environments', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6100, endPort: 6200 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(2);
      expect(envs.length).toBe(2);
      await manager.shutdownAll();
    });

    it('all environments are running', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6100, endPort: 6200 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(2);
      const allRunning = envs.every(e => e.isActive());
      expect(allRunning).toBe(true);
      await manager.shutdownAll();
    });
  });

  describe('unique ports', () => {
    it('all ports are unique', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6200, endPort: 6300 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(4);
      const ports = envs.map(e => e.port);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
      await manager.shutdownAll();
    });

    it('all ports in expected range', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6200, endPort: 6300 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(4);
      const ports = envs.map(e => e.port);
      const allInRange = ports.every(p => p >= 6200 && p <= 6300);
      expect(allInRange).toBe(true);
      await manager.shutdownAll();
    });
  });

  describe('environment reset', () => {
    it('reset returns observations', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6300, endPort: 6400 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(2);
      const seeds = [123, 456];
      const obs = await manager.resetAll(seeds);
      expect(obs).toBeDefined();
      expect(obs.length).toBeGreaterThan(0);
      await manager.shutdownAll();
    });
  });

  describe('clean shutdown', () => {
    it('created 3 envs before shutdown', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6400, endPort: 6500 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      const envs = await manager.createPool(3);
      expect(envs.length).toBe(3);
      await manager.shutdownAll();
    });

    it('manager reports 0 environments after shutdown', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6400, endPort: 6500 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      await manager.createPool(3);
      await manager.shutdownAll();
      expect(manager.getEnvCount()).toBe(0);
    });

    it('cannot create env after shutdown', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 6400, endPort: 6500 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
      });

      await manager.createPool(3);
      await manager.shutdownAll();
      await expect(manager.createEnv()).rejects.toThrow();
    });
  });

  describe('single BonkEnv creation', () => {
    it('environment has ID', () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      expect(env.id.startsWith('env-')).toBe(true);
      pm.releaseAll();
    });

    it('environment has port assigned', () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      expect(env.port).toBeGreaterThanOrEqual(6500);
      expect(env.port).toBeLessThanOrEqual(6600);
      pm.releaseAll();
    });

    it('environment is not active initially', () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      expect(env.isActive()).toBe(false);
      pm.releaseAll();
    });

    it('environment is active after start', { timeout: 30000 }, async () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      await env.start();
      expect(env.isActive()).toBe(true);
      await env.stop();
      pm.releaseAll();
    });

    it('environment is not active after stop', { timeout: 30000 }, async () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      await env.start();
      await env.stop();
      expect(env.isActive()).toBe(false);
      pm.releaseAll();
    });
  });

  describe('BonkEnv lifecycle', () => {
    it('environment is not active initially', () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      expect(env.isActive()).toBe(false);
      pm.releaseAll();
    });

    it('environment is active after start', { timeout: 30000 }, async () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      await env.start();
      expect(env.isActive()).toBe(true);
      await env.stop();
      pm.releaseAll();
    });

    it('environment is not active after stop', { timeout: 30000 }, async () => {
      const pm = new PortManager({ startPort: 6500, endPort: 6600 });
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
      });
      await env.start();
      await env.stop();
      expect(env.isActive()).toBe(false);
      pm.releaseAll();
    });
  });
});
