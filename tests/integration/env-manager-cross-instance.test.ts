/**
 * Cross-instance EnvManager port coordination (#432).
 *
 * Two independently constructed default EnvManagers share no allocator
 * state of their own; the PortManager registry plus the OS probe must
 * guarantee distinct, bindable ports, and a second IPC-enabled environment
 * must start cleanly alongside the first instead of dying with
 * EADDRINUSE.
 */

import { describe, it, expect } from 'vitest';
import { PortManager } from '../../src/utils/port-manager';
import { EnvManager } from '../../src/env/env-manager';

// Above every range used by other suites so parallel fork workers never
// contend for the same ports.
const CUSTOM_BASE = 17200;

async function shutdownQuietly(managers: EnvManager[]): Promise<void> {
  await Promise.allSettled(managers.map((manager) => manager.shutdownAll()));
}

describe('EnvManager cross-instance port coordination (#432)', () => {
  it('two default managers assign distinct ports to their environments', { timeout: 60000 }, async () => {
    const managers = [new EnvManager(), new EnvManager()];

    try {
      const e1 = await managers[0].createEnv({ useSharedMemory: false });
      const e2 = await managers[1].createEnv({ useSharedMemory: false });

      expect(e1.isActive()).toBe(true);
      expect(e2.isActive()).toBe(true);
      expect(e2.port).not.toBe(e1.port);
    } finally {
      await shutdownQuietly(managers);
    }
  });

  it('a second IPC-enabled env starts cleanly alongside the first', { timeout: 120000 }, async () => {
    const managers = [new EnvManager(), new EnvManager()];

    try {
      const configs = { enableIpcServer: true, useSharedMemory: false } as const;
      const e1 = await managers[0].createEnv(configs);
      const e2 = await managers[1].createEnv(configs);

      // Both Router sockets actually bound: a duplicate allocation would
      // have rejected the second start() with EADDRINUSE (#432).
      expect(e1.isActive()).toBe(true);
      expect(e2.isActive()).toBe(true);
      expect(e2.port).not.toBe(e1.port);
    } finally {
      await shutdownQuietly(managers);
    }
  });

  it('honors a caller-supplied portManager over the manager allocator', { timeout: 60000 }, async () => {
    const custom = new PortManager({ startPort: CUSTOM_BASE, endPort: CUSTOM_BASE + 10 });
    const manager = new EnvManager();

    try {
      const env = await manager.createEnv({
        useSharedMemory: false,
        portManager: custom,
      });

      expect(env.port).toBeGreaterThanOrEqual(CUSTOM_BASE);
      expect(env.port).toBeLessThanOrEqual(CUSTOM_BASE + 10);
      expect(custom.isAllocated(env.port)).toBe(true);
      expect(manager.getPortManager().getAllocatedCount()).toBe(0);
    } finally {
      await shutdownQuietly([manager]);
      custom.releaseAll();
    }
  });
});
