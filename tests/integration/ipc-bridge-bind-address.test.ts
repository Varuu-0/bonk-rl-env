/**
 * ipc-bridge-bind-address.test.ts — regression coverage for issue #235
 *
 * The IpcBridge must honor a configured `server.bindAddress` (plus the
 * BIND_ADDRESS env var / --bind-address CLI surface via the config pipeline)
 * when it binds the ZMQ ROUTER socket. Previously the bind endpoint was
 * hardcoded to `tcp://127.0.0.1:<port>`, silently discarding any configured
 * non-loopback interface (ECONNREFUSED for remote clients). This test starts
 * a bridge on an alternate loopback address (127.0.0.2) on a free port and
 * proves:
 *   1. The socket's last bind endpoint is exactly the configured address.
 *   2. A DEALER client (as the Python client does) can connect to the
 *      configured address and complete a request/reply round-trip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge honors a configured bind address (issue #235)', () => {
  const BIND_ADDRESS = '127.0.0.2';
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 15700, endPort: 15799 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port, bindAddress: BIND_ADDRESS } } as any);
    // start() runs the serve loop until close(), so do not await it.
    void bridge.start();
    client = new zmq.Dealer();
    await client.connect(`tcp://${BIND_ADDRESS}:${port}`);
    await new Promise(r => setTimeout(r, 300));
  }, 30000);

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    try { await bridge.close(); } catch { /* ignore */ }
    portManager.release(port);
  }, 10000);

  it('binds the socket to the configured bind address (last endpoint)', () => {
    const sock: any = (bridge as any).sock;
    expect(sock.lastEndpoint).toBe(`tcp://${BIND_ADDRESS}:${port}`);
  });

  it('exposes the configured bind address via getBindAddress()', () => {
    expect(bridge.getBindAddress()).toBe(BIND_ADDRESS);
  });

  it('is reachable on the configured address: DEALER round-trip succeeds (issue #235)', async () => {
    // A `reset` before init is rejected with a per-request error reply, which
    // proves the client connected to the configured interface and completed a
    // full request/reply round-trip without initializing any pool state.
    await client.send(JSON.stringify({ command: 'reset' }));
    const [response] = await client.receive();
    const parsed = JSON.parse(response.toString());
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('Worker pool not initialized');
  }, 30000);
});