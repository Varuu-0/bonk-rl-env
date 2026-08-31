/**
 * bonk-env-orphaned-host-pool.test.ts — Regression coverage for issue #479
 *
 * When an adopted host WorkerPool fails (worker crash/exit, shared-memory
 * timeout, post-signal error), the IpcBridge closes the corpse and rebuilds
 * a fresh bridge-owned pool for IPC clients (#400). Before the fix the
 * owning BonkEnv kept its this.pool reference pinned to the dead pool and
 * kept reporting isActive() === true, so every direct step()/reset()/
 * getPool() from the owner hit the corpse and rejected with the misleading
 * "worker pool is closed".
 *
 * The fix, pinned here:
 * - the onHostPoolFailed hook drops the dead reference (getPool() returns
 *   null), flips isRunning, and sets a sticky isFailed() flag;
 * - isActive() also reports false while the live pool sits in its failed
 *   state before any recovery ran, so it never lies;
 * - step()/reset() reject with a distinct message naming the adopted
 *   failure and the stop() + start() recovery path;
 * - the bridge stays up and serves IPC clients from the rebuilt pool, and
 *   env.stop() shuts the whole thing down without double-closes or leaks;
 * - stop() + start() recovers the env on a fresh pool.
 *
 * Port band: 17400-17509 is reserved for this suite. It is disjoint from
 * bonk-env-ipc-server.test.ts (16400-16899+) and from every other
 * integration suite's range; vitest runs suites concurrently in forks, so
 * overlapping fixed ranges mean intermittent EADDRINUSE in beforeAll.
 */
import { describe, it, expect, vi } from 'vitest';
import * as zmq from 'zeromq';
import { BonkEnv } from '../../src/env/bonk-env';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { WorkerPool } from '../../src/core/worker-pool';
import { PortManager } from '../../src/utils/port-manager';

// Fail fast with a clear message instead of hanging a whole suite when a
// reply never arrives (e.g. a regression that swallows a request).
const RECEIVE_TIMEOUT_MS = 10000;

async function sendCommand(client: zmq.Dealer, cmd: object): Promise<any> {
  await client.send(JSON.stringify(cmd));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      client.receive(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `sendCommand timed out after ${RECEIVE_TIMEOUT_MS}ms waiting for a reply to ${JSON.stringify(cmd)}`,
            ),
          );
        }, RECEIVE_TIMEOUT_MS);
        timer?.unref?.();
      }),
    ]);
    return JSON.parse(reply[0].toString());
  } finally {
    clearTimeout(timer);
  }
}

describe('BonkEnv drops the orphaned adopted host pool (issue #479)', () => {
  it(
    'host-pool failure recovery drops the dead reference and deactivates the env while IPC recovers',
    { timeout: 60000 },
    async () => {
      const portManager = new PortManager({ startPort: 17400, endPort: 17449 });
      const port = 17400;
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager,
        port,
        enableIpcServer: true,
      });
      await env.start();
      const bridge = (env as any).bridge as IpcBridge;
      const deadPool = env.getPool() as WorkerPool;
      expect(deadPool).not.toBeNull();
      expect(env.isActive()).toBe(true);
      expect(env.isFailed()).toBe(false);

      const client = new zmq.Dealer({ routingId: 'orphan479' });
      // The bridge and the env both warn loudly about the replacement;
      // silence them for the duration of the forced failure.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await client.connect(`tcp://127.0.0.1:${port}`);
        await bridge.ready;

        // A matching-count init shares the adopted host session, and both
        // directions prove the host pool actually served IPC and direct use.
        expect((await sendCommand(client, { command: 'init', numEnvs: 1 })).status).toBe('ok');
        await env.reset([7]);
        expect(await env.step([0])).toHaveLength(1);
        expect((await sendCommand(client, { command: 'step', actions: [0] })).status).toBe('ok');

        // Kill the adopted pool exactly as a worker crash / shared-memory
        // timeout would, then let the next client request drive the bridge's
        // recovery (the #436 ACK-time health check reports the real error).
        await (deadPool as any).failPool(new Error('simulated host failure'));
        const failedInit = await sendCommand(client, { command: 'init', numEnvs: 1 });
        expect(failedInit.status).toBe('error');
        expect(failedInit.error).toContain('worker pool is in failed state');
        expect(failedInit.error).toContain('simulated host failure');

        // Bridge side: un-adoption plus a rebuilt pool, and a plain re-init
        // serves IPC clients from it — the documented #400 recovery contract.
        expect((bridge as any)._hostPool).toBe(false);
        const rebuiltPool = (bridge as any).localSession.pool as WorkerPool;
        expect(rebuiltPool).not.toBe(deadPool);
        expect(rebuiltPool.isFailed()).toBe(false);
        expect((await sendCommand(client, { command: 'init', numEnvs: 1, useSharedMemory: false })).status).toBe('ok');
        expect((await sendCommand(client, { command: 'step', actions: [0] })).status).toBe('ok');

        // Owner side: the dead reference is dropped and every direct surface
        // agrees — not the misleading "worker pool is closed".
        expect(env.isFailed()).toBe(true);
        expect(env.isActive()).toBe(false);
        expect(env.getPool()).toBeNull();
        await expect(env.ready()).rejects.toThrow('not running');

        let stepError!: Error;
        try {
          await env.step([0]);
        } catch (error) {
          stepError = error as Error;
        }
        expect(stepError).toBeInstanceOf(Error);
        expect(stepError.message).toContain('adopted worker pool failed');
        expect(stepError.message).toContain('stop() + start()');
        expect(stepError.message).not.toContain('worker pool is closed');

        let resetError!: Error;
        try {
          await env.reset([7]);
        } catch (error) {
          resetError = error as Error;
        }
        expect(resetError.message).toContain('adopted worker pool failed');
        expect(resetError.message).not.toContain('worker pool is closed');

        // Close direction: with the env's own pool already null, stop() shuts
        // the bridge down, which closes the now-bridge-owned rebuilt pool —
        // nothing double-closes and nothing leaks.
        await env.stop();
        expect((env as any).bridge).toBeNull();
        expect((rebuiltPool as any).workers).toHaveLength(0);
        expect(portManager.isAllocated(port)).toBe(false);
      } finally {
        warnSpy.mockRestore();
        try {
          client.close();
        } catch {
          /* ignore */
        }
        try {
          await env.stop();
        } catch {
          /* ignore */
        }
        portManager.releaseAll();
      }
    },
  );

  it(
    'stop() + start() recovers the env on a fresh pool after an adopted host failure',
    { timeout: 90000 },
    async () => {
      const portManager = new PortManager({ startPort: 17450, endPort: 17499 });
      const port = 17450;
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager,
        port,
        enableIpcServer: true,
      });
      await env.start();
      const bridge = (env as any).bridge as IpcBridge;
      const deadPool = env.getPool() as WorkerPool;

      const client = new zmq.Dealer({ routingId: 'orphan479b' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await client.connect(`tcp://127.0.0.1:${port}`);
        await bridge.ready;
        expect((await sendCommand(client, { command: 'init', numEnvs: 1 })).status).toBe('ok');

        await (deadPool as any).failPool(new Error('simulated host failure'));
        const failedInit = await sendCommand(client, { command: 'init', numEnvs: 1 });
        expect(failedInit.status).toBe('error');
        expect(env.isFailed()).toBe(true);
        expect(env.getPool()).toBeNull();
        // The bridge is still bound and serving; a failure must not tear the
        // port down behind IPC clients' backs.
        expect(portManager.isAllocated(port)).toBe(true);

        // The documented direct-caller recovery path.
        await env.stop();
        await env.start();
        expect(env.isActive()).toBe(true);
        expect(env.isFailed()).toBe(false);
        const freshPool = env.getPool() as WorkerPool;
        expect(freshPool).not.toBeNull();
        expect(freshPool).not.toBe(deadPool);

        // Direct calls work again on the fresh pool.
        await env.reset([5]);
        expect(await env.step([0])).toHaveLength(1);

        // And IPC clients can reconnect to the restarted bridge.
        client.close();
        const client2 = new zmq.Dealer({ routingId: 'orphan479c' });
        await client2.connect(`tcp://127.0.0.1:${port}`);
        await bridge.ready;
        expect((await sendCommand(client2, { command: 'init', numEnvs: 1 })).status).toBe('ok');
        expect((await sendCommand(client2, { command: 'step', actions: [0] })).status).toBe('ok');
        client2.close();
      } finally {
        warnSpy.mockRestore();
        try {
          client.close();
        } catch {
          /* ignore */
        }
        try {
          await env.stop();
        } catch {
          /* ignore */
        }
        portManager.releaseAll();
      }
    },
  );

  it('a directly-owned failed pool deactivates the env before any recovery runs', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: 17500, endPort: 17509 });
    const env = new BonkEnv({ numEnvs: 1, useSharedMemory: false, portManager });
    await env.start();
    try {
      await env.reset([1]);
      expect(await env.step([0])).toHaveLength(1);

      // No bridge exists here, so nothing runs recovery: the pool just sits
      // failed. isActive() must still stop reporting health immediately, and
      // the pool surfaces its own accurate failed-state errors.
      await (env.getPool() as WorkerPool as any).failPool(new Error('direct failure'));
      expect(env.isFailed()).toBe(true);
      expect(env.isActive()).toBe(false);
      expect((env.getPool() as WorkerPool).isFailed()).toBe(true);
      await expect(env.step([0])).rejects.toThrow('worker pool is in failed state');
      await expect(env.reset([1])).rejects.toThrow('worker pool is in failed state');

      // Restart clears it: a fresh pool serves again.
      await env.stop();
      await env.start();
      expect(env.isFailed()).toBe(false);
      expect(env.isActive()).toBe(true);
      await env.reset([1]);
      expect(await env.step([0])).toHaveLength(1);
    } finally {
      await env.stop();
      portManager.releaseAll();
    }
  });
});
