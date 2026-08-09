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

const BIND_ADDRESS = '127.0.0.2';
const EXPECTED_ENDPOINT = `tcp://${BIND_ADDRESS}`;

/**
 * Wait until the ROUTER socket reports the configured bind endpoint (or
 * timeout). This deterministically awaits the async bind() instead of racing
 * a fixed sleep, and surfaces a bind failure as an assertion instead of a
 * flaky lastEndpoint read.
 */
async function waitForBindEndpoint(sock: any, endpoint: string, timeoutMs: number = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sock.lastEndpoint === endpoint) {
      return;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  expect(sock.lastEndpoint, `socket did not bind to ${endpoint}`).toBe(endpoint);
}

describe('IpcBridge honors a configured bind address (issue #235)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let startPromise: Promise<void>;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 15700, endPort: 15799 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port, bindAddress: BIND_ADDRESS } } as any);
    // start() runs the serve loop until close(), so do not await it here.
    // Keep the promise referenced so a bind failure is a handled rejection
    // that the readiness poll below surfaces as a test failure.
    startPromise = bridge.start();
    startPromise.catch(() => { /* surfaced by waitForBindEndpoint */ });
    await waitForBindEndpoint((bridge as any).sock, `${EXPECTED_ENDPOINT}:${port}`);
    client = new zmq.Dealer();
    await client.connect(`tcp://${BIND_ADDRESS}:${port}`);
    await new Promise(r => setTimeout(r, 100));
  }, 30000);

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    try { await bridge.close(); } catch { /* ignore */ }
    try { await startPromise; } catch { /* ignore */ }
    portManager.release(port);
  }, 10000);

  it('binds the socket to the configured bind address (last endpoint)', () => {
    const sock: any = (bridge as any).sock;
    expect(sock.lastEndpoint).toBe(`${EXPECTED_ENDPOINT}:${port}`);
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
