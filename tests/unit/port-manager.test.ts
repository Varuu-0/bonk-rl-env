import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PortManager } from '../../src/utils/port-manager';

describe('PortManager', () => {
  let pm: PortManager;

  beforeEach(() => {
    pm = new PortManager({ startPort: 6000, endPort: 6010 });
  });

  describe('allocatePort', () => {
    it('returns a valid port within the range', () => {
      const port = pm.allocate();
      expect(port).toBeGreaterThanOrEqual(6000);
      expect(port).toBeLessThanOrEqual(6010);
    });

    it('allocates sequentially', () => {
      const p1 = pm.allocate();
      const p2 = pm.allocate();
      expect(p2).toBe(p1 + 1);
    });

    it('wraps around when reaching end of range', () => {
      const ports: number[] = [];
      for (let i = 0; i < 11; i++) {
        ports.push(pm.allocate());
      }
      expect(ports).toContain(6000);
      expect(ports).toContain(6010);
      expect(ports.length).toBe(11);

      pm.releaseAll();
      const afterReset = pm.allocate();
      expect(afterReset).toBe(6000);
    });

    it('throws when all ports are allocated', () => {
      for (let i = 0; i < 11; i++) {
        pm.allocate();
      }
      expect(() => pm.allocate()).toThrow('No available ports');
    });
  });

  describe('release and reuse', () => {
    it('releases a port and marks it as unallocated', () => {
      const p1 = pm.allocate();
      expect(pm.isAllocated(p1)).toBe(true);
      pm.release(p1);
      expect(pm.isAllocated(p1)).toBe(false);
    });

    it('getAllocatedCount reflects releases', () => {
      pm.allocate();
      pm.allocate();
      expect(pm.getAllocatedCount()).toBe(2);

      pm.release(6000);
      expect(pm.getAllocatedCount()).toBe(1);
    });
  });

  describe('isAllocated', () => {
    it('returns true for allocated ports', () => {
      const port = pm.allocate();
      expect(pm.isAllocated(port)).toBe(true);
    });

    it('returns false for unallocated ports', () => {
      expect(pm.isAllocated(6000)).toBe(false);
      pm.allocate();
      expect(pm.isAllocated(6001)).toBe(false);
    });
  });

  describe('release unallocated port', () => {
    it('does not throw when releasing an unallocated port', () => {
      expect(() => {
        pm.release(6005);
      }).not.toThrow();
    });
  });

  describe('reserve', () => {
    it('reserves a specific port', () => {
      pm.reserve(6005);
      expect(pm.isAllocated(6005)).toBe(true);
    });

    it('throws when reserving an already allocated port', () => {
      pm.allocate(); // allocates 6000
      expect(() => {
        pm.reserve(6000);
      }).toThrow('Port 6000 is already allocated');
    });
  });

  describe('releaseAll', () => {
    it('clears all allocations', () => {
      pm.allocate();
      pm.allocate();
      pm.allocate();
      expect(pm.getAllocatedCount()).toBe(3);

      pm.releaseAll();
      expect(pm.getAllocatedCount()).toBe(0);
    });

    it('resets the current port pointer', () => {
      pm.allocate();
      pm.allocate();
      pm.releaseAll();

      const next = pm.allocate();
      expect(next).toBe(6000);
    });
  });

  describe('invalid range', () => {
    it('throws when startPort >= endPort', () => {
      expect(() => {
        new PortManager({ startPort: 7000, endPort: 6000 });
      }).toThrow('Start port must be less than end port');
    });

    it('throws when ports are out of valid range', () => {
      expect(() => {
        new PortManager({ startPort: 0, endPort: 100 });
      }).toThrow('Invalid port range');

      expect(() => {
        new PortManager({ startPort: 6000, endPort: 70000 });
      }).toThrow('Invalid port range');
    });
  });
});
