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
 * `bridge.ready` re-armed to reflect the new bind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  it('start → close → start serves fresh DEALER round-trips on the same instance', async () => {
    // First serve cycle.
    const readyBeforeFirstStart = bridge.ready;
    const serve1 = bridge.start();
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
});
