/**
 * ipc-bridge-overlapping-start.test.ts — regression coverage for issue #418
 *
 * IpcBridge.start() had no overlapping-call guard: a second start() while a
 * serve cycle was live re-ran the bind on the shared ROUTER, and its
 * EADDRINUSE cleanup closed the socket OUT FROM UNDER the healthy first
 * cycle — every later client request hung forever, isClosed() kept reporting
 * false, and even close() wedged (unbind on the destroyed socket). The guard
 * added with this suite rejects an overlapping start() fast, before any
 * state mutation, so the running bridge keeps serving untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

// 16400-16499 is reserved for this suite; every other ipc-bridge suite owns
// a disjoint range and vitest forks run in parallel.
describe('IpcBridge overlapping start() calls (issue #418)', () => {
  let portManager: PortManager;
  let port: number;

  beforeAll(() => {
    portManager = new PortManager({ startPort: 16400, endPort: 16499 });
    port = portManager.allocate();
  });

  afterAll(() => {
    portManager.release(port);
  }, 10000);

  /**
   * Fresh DEALER client round-trip (as the Python client does): connect,
   * `init`, await the reply. Bounded receive/send timeouts turn the #418
   * symptom — a silently dead listener that hangs every request — into a
   * fast, diagnosable failure instead of a suite-wide timeout.
   */
  async function roundTripInitStatus(): Promise<string> {
    const client = new zmq.Dealer({ receiveTimeout: 5000, sendTimeout: 5000 });
    try {
      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 100));
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const [reply] = await client.receive();
      return JSON.parse(reply.toString()).status;
    } finally {
      client.close();
    }
  }

  /**
   * Wait until the bridge's port is bindable again after close(), using the
   * same throwaway-ROUTER probe as the restart suite: libzmq releases the
   * listener asynchronously, so poll instead of assuming immediate release.
   */
  async function waitForPortFree(deadline = Date.now() + 5000): Promise<void> {
    const endpoint = `tcp://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      const probe = new zmq.Router();
      let bound = false;
      try {
        await probe.bind(endpoint);
        bound = true;
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'EADDRINUSE') {
          throw err;
        }
      } finally {
        if (bound) {
          try {
            await probe.unbind(endpoint);
          } catch {
            /* best-effort probe teardown */
          }
        }
        probe.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`port ${port} did not become free`);
  }

  it('a start() while serving rejects fast and leaves the live serve cycle untouched', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const sockBefore = (bridge as any).sock;
    try {
      // First serve cycle: never awaited directly (it only exits on
      // close()); bind failures surface via ready/round-trips below.
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      // The live cycle's readiness signal must be captured BEFORE the
      // overlap: the guard must reject without re-arming/swapping it.
      const liveReady = bridge.ready;

      // Overlapping call: fails fast with a clear error...
      await expect(bridge.start()).rejects.toThrow(/already running/);

      // ...WITHOUT touching the running instance's transport or state:
      // same, still-open ROUTER handle; readiness signal not swapped;
      // truthful isClosed().
      expect((bridge as any).sock).toBe(sockBefore);
      expect((bridge as any).sock.closed).toBe(false);
      expect(bridge.ready).toBe(liveReady);
      expect(bridge.isClosed()).toBe(false);

      // The ORIGINAL serve loop still answers requests.
      expect(await roundTripInitStatus()).toBe('ok');

      // The documented recovery path works normally afterwards: close()
      // resolves (no "Socket is closed" wedge), reports closed, and the
      // first serve promise settles.
      await expect(bridge.close()).resolves.toBeUndefined();
      expect(bridge.isClosed()).toBe(true);
      await serve1;
      await waitForPortFree();
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('the in-flight flag clears when a cycle settles, so restart-after-overlap still works', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;

      // Overlap rejected while cycle 1 is live...
      await expect(bridge.start()).rejects.toThrow(/already running/);
      await bridge.close();
      await serve1;

      // ...but its rejection must not leak the guard: a genuine restart of
      // the same instance (#263 flow) binds and serves again.
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a failed (bind-error) attempt clears the guard so an immediate retry can start', async () => {
    // Occupy the port so the first attempt fails its bind like the #326/#435
    // retry flows; the guard must clear when that attempt rejects.
    const blocker = net.createServer();
    let bridge: IpcBridge | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', resolve);
      });

      bridge = new IpcBridge({ server: { port } } as any);
      const earlyReady = bridge.ready;
      await expect(bridge.start()).rejects.toThrow(); // EADDRINUSE class
      expect(
        await Promise.race([
          earlyReady.then(
            () => 'resolved',
            () => 'rejected',
          ),
          new Promise<string>((r) => setTimeout(() => r('hung'), 1500)),
        ]),
      ).toBe('rejected');
      expect(bridge.isClosed()).toBe(false);

      // Release the port; the retry must be allowed to run (guard cleared)
      // and reach a healthy serving state.
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await waitForPortFree();

      const serveRetry = bridge.start();
      serveRetry.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serveRetry;
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      if (bridge && !bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);
});
