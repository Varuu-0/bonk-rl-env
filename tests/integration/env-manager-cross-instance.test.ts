/**
 * Cross-instance EnvManager port coordination (#432).
 *
 * Two independently constructed default EnvManagers share no allocator
 * state of their own; the PortManager registry plus the OS probe must
 * guarantee distinct, bindable ports, and a second IPC-enabled environment
 * must start cleanly alongside the first instead of dying with
 * EADDRINUSE.
 *
 * The first two tests intentionally use the real default 6000-7000 range —
 * that is the headline #432 scenario. Other suites running in parallel
 * forks have their own module registries, and any cross-process collision
 * is defused by the OS probe (assertions are relative: distinctness and
 * active state, never absolute port numbers). The custom-allocator test
 * below pins a reserved high range instead.
 */

import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { PortManager } from '../../src/utils/port-manager';
import { BonkEnv } from '../../src/env/bonk-env';
import { EnvManager } from '../../src/env/env-manager';

// Above every fixed range used by other suites (the highest is 16400+
// in the IPC server tests).
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

  it('probes and relocates a falsy port:0 env like any auto-allocated env', { timeout: 60000 }, async () => {
    // port: 0 is falsy, so the constructor treats it as "allocate" —
    // the start()-time OS probe must apply to it exactly as it does for
    // a port the allocator picked on its own (#432 review).
    const env = new BonkEnv({ numEnvs: 1, useSharedMemory: false, port: 0 });
    const blockedPort = env.port;
    const blocker = await new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(blockedPort, '127.0.0.1', () => resolve(server));
    });

    try {
      await env.start();
      expect(env.isActive()).toBe(true);
      expect(env.port).not.toBe(blockedPort);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await env.stop();
    }
  });
});
