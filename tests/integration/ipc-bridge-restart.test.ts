/**
 * ipc-bridge-restart.test.ts — regression coverage for issue #263
 *
 * IpcBridge.close() permanently destroys the ZMQ ROUTER socket, but both the
 * code and the docs treat a later start() on the same instance as a
 * supported restart ("a later `start()` restarts clean"). Previously that
 * restart deterministically failed with the opaque `Socket is closed`
 * (libzmq sockets can never be re-bound after close()). This test proves the
 * documented lifecycle end to end: start → DEALER round-trip → close → start
 * the SAME instance again → a fresh DEALER round-trip succeeds, with
 * `bridge.ready` re-armed to reflect the new bind — and that a restart whose
 * bind fails once still recovers on retry (ready resolves for the live bind).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge can be restarted after close() (issue #263)', () => {
  let bridge: IpcBridge;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 15800, endPort: 15899 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
  }, 30000);

  afterAll(async () => {
    try { await bridge.close(); } catch { /* ignore */ }
    portManager.release(port);
  }, 10000);

  /**
   * Connect a fresh DEALER client (as the Python client does) to the
   * bridge's port and complete an `init` → `reset` round-trip. The reset
   * observation length proves the response came from a live pool served by
   * the currently-bound ROUTER socket.
   */
  async function roundTrip(numEnvs: number): Promise<void> {
    const client = new zmq.Dealer();
    try {
      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise(r => setTimeout(r, 100));

      const sendCommand = async (cmd: object): Promise<any> => {
        await client.send(JSON.stringify(cmd));
        const [response] = await client.receive();
        return JSON.parse(response.toString());
      };

      const init = await sendCommand({ command: 'init', numEnvs, useSharedMemory: false });
      expect(init.status).toBe('ok');

      const reset = await sendCommand({ command: 'reset', seeds: Array.from({ length: numEnvs }, (_, i) => i + 1) });
      expect(reset.status).toBe('ok');
      expect(reset.data.observation).toHaveLength(numEnvs);
    } finally {
      client.close();
    }
  }

  /**
   * Wait until the bridge's port is bindable again. The closed listener
   * releases it asynchronously, so poll with a throwaway ROUTER and await
   * that probe's explicit unbind before allowing the follow-up bind.
   */
  async function waitForPortFree(): Promise<void> {
    const endpoint = `tcp://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = new zmq.Router();
      let bound = false;
      let unbound = false;
      try {
        await probe.bind(endpoint);
        bound = true;
        await probe.unbind(endpoint);
        unbound = true;
        return;
      } catch {
        // Retry after the probe has been fully torn down below.
      } finally {
        if (bound && !unbound) {
          try { await probe.unbind(endpoint); } catch { /* close below */ }
        }
        probe.close();
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`port ${port} did not become free`);
  }

  it('leaves the probe endpoint immediately rebindable (#327)', async () => {
    const endpoint = `tcp://127.0.0.1:${port}`;

    for (let attempt = 0; attempt < 50; attempt++) {
      await waitForPortFree();

      const retry = new zmq.Router();
      let bound = false;
      try {
        await retry.bind(endpoint);
        bound = true;
      } finally {
        try {
          if (bound) await retry.unbind(endpoint);
        } finally {
          retry.close();
        }
      }
    }
  }, 60000);

  it('start → close → start serves fresh DEALER round-trips on the same instance', async () => {
    // First serve cycle. start() only exits on close(), so never await it
    // directly; keep the promise referenced and surface bind failures via
    // bridge.ready (an unhandled serve rejection would crash the worker).
    const readyBeforeFirstStart = bridge.ready;
    const serve1 = bridge.start();
    serve1.catch(() => {});
    await bridge.ready;
    expect(bridge.isClosed()).toBe(false);
    await roundTrip(1);

    // Full shutdown: the socket is destroyed here, so a restart must
    // recreate it from scratch.
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    await serve1; // the first serve loop exits once the socket is closed

    // Restart the same instance (the documented "later start() + restart").
    const serve2 = bridge.start();
    serve2.catch(() => {});
    // `ready` must be re-armed for the new serve cycle: awaiting it below
    // reflects the re-bound socket, not the already-resolved first bind.
    expect(bridge.ready).not.toBe(readyBeforeFirstStart);
    await bridge.ready;
    expect(bridge.isClosed()).toBe(false);
    await roundTrip(1);

    // Second cycle must shut down the same way.
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    await serve2;
  }, 60000);

  it('recovers when a restart bind fails once: ready rejects, then resolves on retry', async () => {
    // First serve cycle + full shutdown so the socket is destroyed.
    const serve1 = bridge.start();
    serve1.catch(() => {});
    await bridge.ready;
    await bridge.close();
    await serve1;

    // Occupy the port so the restart's bind deterministically fails once.
    // The listener is closed in `finally` so a failed assertion can never
    // leave the port bound for the rest of the suite.
    const blocker = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', resolve);
      });

      const serve2 = bridge.start();
      serve2.catch(() => {}); // the bind failure surfaces via bridge.ready
      await expect(bridge.ready).rejects.toThrow();
      expect(bridge.isClosed()).toBe(true);

      // Release the port; the retry must re-arm ready and bind fresh.
      await new Promise<void>(resolve => blocker.close(() => resolve()));
      await waitForPortFree();

      const serve3 = bridge.start();
      serve3.catch(() => {});
      await expect(bridge.ready).resolves.toBeUndefined();
      expect(bridge.isClosed()).toBe(false);

      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await serve3;
    } finally {
      // The success path already closed the listener above; only close here
      // if an assertion failed while it was still listening, so a redundant
      // close (which rejects with ERR_SERVER_NOT_RUNNING) is a true no-op.
      if (blocker.listening) await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  }, 60000);
});
