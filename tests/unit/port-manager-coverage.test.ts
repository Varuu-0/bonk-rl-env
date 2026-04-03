import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PortManager,
  getGlobalPortManager,
  resetGlobalPortManager,
} from '../../src/utils/port-manager';

describe('PortManager - Coverage Extension', () => {
  describe('isPortAvailable - error path (lines 127-131)', () => {
    it('returns false when port is in use (EADDRINUSE path, line 128)', async () => {
      const pm = new PortManager({ startPort: 59990, endPort: 59995 });
      const port = pm.allocate();

      const server = require('net').createServer();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

      const result = await PortManager.isPortAvailable(port);
      expect(result).toBe(false);

      await new Promise<void>((resolve) => server.close(() => resolve()));
      pm.release(port);
    });

    it('returns true when port is free (listening path, line 136)', async () => {
      const result = await PortManager.isPortAvailable(59998);
      expect(result).toBe(true);
    });
  });

  describe('findAvailablePort - happy path (line 151)', () => {
    it('returns the first available port found', async () => {
      const port = await PortManager.findAvailablePort(59100);
      expect(port).toBeGreaterThanOrEqual(59100);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it('uses default start port 6000 when no argument provided', async () => {
      const port = await PortManager.findAvailablePort();
      expect(port).toBeGreaterThanOrEqual(6000);
    });
  });

  describe('findAvailablePort - no ports available (line 154)', () => {
    it('throws when no ports are available in the entire range', async () => {
      const spy = vi.spyOn(PortManager, 'isPortAvailable').mockResolvedValue(false);

      await expect(PortManager.findAvailablePort(65530)).rejects.toThrow('No available ports found');

      spy.mockRestore();
    });
  });

  describe('getGlobalPortManager (lines 175-178)', () => {
    beforeEach(() => {
      resetGlobalPortManager();
    });

    afterEach(() => {
      resetGlobalPortManager();
    });

    it('creates a new PortManager when no global instance exists', () => {
      const pm = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      expect(pm).toBeInstanceOf(PortManager);
      expect(pm.getAllocatedCount()).toBe(0);
    });

    it('returns the same instance on subsequent calls', () => {
      const pm1 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      const pm2 = getGlobalPortManager();
      expect(pm1).toBe(pm2);
    });

    it('ignores options on subsequent calls and returns existing instance', () => {
      const pm1 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      const pm2 = getGlobalPortManager({ startPort: 8000, endPort: 8010 });
      expect(pm1).toBe(pm2);
    });

    it('uses provided options when creating the first instance', () => {
      const pm = getGlobalPortManager({ startPort: 8000, endPort: 8005 });
      const port = pm.allocate();
      expect(port).toBe(8000);
    });
  });

  describe('resetGlobalPortManager (lines 185-189)', () => {
    beforeEach(() => {
      resetGlobalPortManager();
    });

    afterEach(() => {
      resetGlobalPortManager();
    });

    it('releases all ports and nullifies the global instance', () => {
      const pm1 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      pm1.allocate();
      pm1.allocate();
      expect(pm1.getAllocatedCount()).toBe(2);

      resetGlobalPortManager();

      const pm2 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      expect(pm2).not.toBe(pm1);
      expect(pm2.getAllocatedCount()).toBe(0);
    });

    it('does not throw when called with no existing instance', () => {
      resetGlobalPortManager();
      resetGlobalPortManager();
      expect(() => resetGlobalPortManager()).not.toThrow();
    });

    it('creates a fresh instance after reset', () => {
      const pm1 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      pm1.allocate();

      resetGlobalPortManager();

      const pm2 = getGlobalPortManager({ startPort: 7000, endPort: 7010 });
      expect(pm2.getAllocatedCount()).toBe(0);
      expect(pm2.allocate()).toBe(7000);
    });
  });

  describe('reserve - edge cases', () => {
    let pm: PortManager;

    beforeEach(() => {
      pm = new PortManager({ startPort: 6000, endPort: 6005 });
    });

    it('reserves a port at the start boundary', () => {
      pm.reserve(6000);
      expect(pm.isAllocated(6000)).toBe(true);
    });

    it('reserves a port at the end boundary', () => {
      pm.reserve(6005);
      expect(pm.isAllocated(6005)).toBe(true);
    });

    it('throws when reserving a port already reserved', () => {
      pm.reserve(6003);
      expect(() => pm.reserve(6003)).toThrow('Port 6003 is already allocated');
    });

    it('prevents allocate from returning a reserved port', () => {
      pm.reserve(6000);
      const port = pm.allocate();
      expect(port).not.toBe(6000);
    });
  });
});
