/**
 * ipc-bridge-use-shared-memory-validation.test.ts — Regression coverage for
 * issue #433 on the wire surface.
 *
 * The IPC `init` command used to read `payload.useSharedMemory` unvalidated,
 * so a DEALER client sending `"useSharedMemory": "false"` (a JSON string —
 * a plausible encoding mistake for any non-Python client) received
 * `{"status":"ok"}` while its session pool silently served the
 * SharedArrayBuffer transport the caller asked to disable.
 *
 * The bridge now rejects a malformed value up front as a per-request error
 * (word-identical to the pool-level rejection, mirroring the numEnvs guards
 * of #390) without creating a session or touching worker state, and a
 * well-formed init from the same identity still works.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { describeInvalidUseSharedMemory } from '../../src/core/worker-pool';
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

describe('IpcBridge rejects malformed useSharedMemory init requests (issue #433)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;
  // The bridge keys sessions by the client's ZMQ routing identity in hex.
  const sessionKey = Buffer.from('shmclient', 'utf8').toString('hex');

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 16500, endPort: 16599 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
    // start() runs the serve loop until close(), so do not await it. A
    // rejection handler is still required: on a bind failure start() rejects
    // and an unhandled rejection terminates the process on Node >=20 — the
    // real failure surfaces through `await bridge.ready` below (#252).
    void bridge.start().catch(() => {
      /* bind failures surface via bridge.ready */
    });

    client = new zmq.Dealer({ routingId: 'shmclient' });
    await client.connect(`tcp://127.0.0.1:${port}`);
    // Await the bind signal instead of a fixed sleep: ready resolves once
    // the Router socket is bound and accepting connections (#263 contract).
    await bridge.ready;
  }, 30000);

  afterAll(async () => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    portManager.release(port);
  }, 10000);

  function sessions(): Map<string, any> {
    return (bridge as any).sessions as Map<string, any>;
  }

  it('errors a DEALER init with useSharedMemory:"false" without creating a session or enabling SAB', async () => {
    const reply = await sendCommand(client, { command: 'init', numEnvs: 1, config: {}, useSharedMemory: 'false' });

    expect(reply.status).toBe('error');
    expect(reply.error).toBe('Invalid useSharedMemory: expected a boolean (true or false), got string "false"');
    // The malformed request never reached a pool: no session was created
    // (no client-cap slot consumed) and no worker was spawned.
    expect(sessions().size).toBe(0);

    // The bridge stays healthy: a well-formed init from the same identity
    // works, and the resolved transport is a real boolean in message mode —
    // never the string the client sent.
    const ok = await sendCommand(client, { command: 'init', numEnvs: 1, config: {}, useSharedMemory: false });
    expect(ok.status).toBe('ok');
    const pool = sessions().get(sessionKey).pool;
    expect(typeof pool.isUsingSharedMemory()).toBe('boolean');
    expect(pool.isUsingSharedMemory()).toBe(false);
  });

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['null', null],
    ['empty object', {}],
  ])('errors a DEALER init with useSharedMemory:%s without disturbing the healthy session', async (_label, value) => {
    const reply = await sendCommand(client, { command: 'init', numEnvs: 1, config: {}, useSharedMemory: value });

    expect(reply.status).toBe('error');
    expect(reply.error).toBe(
      `Invalid useSharedMemory: expected a boolean (true or false), got ${describeInvalidUseSharedMemory(value)}`,
    );
    // The healthy session from the earlier valid init is untouched: the
    // malformed request is a pure per-request error.
    expect(sessions().size).toBe(1);
    const pool = sessions().get(sessionKey).pool;
    expect(pool.isFailed()).toBe(false);
    expect(pool.isUsingSharedMemory()).toBe(false);
  });

  it('still serves explicit boolean true over the SharedArrayBuffer transport', async () => {
    const reply = await sendCommand(client, { command: 'init', numEnvs: 1, config: {}, useSharedMemory: true });
    expect(reply.status).toBe('ok');
    const pool = sessions().get(sessionKey).pool;
    expect(pool.isUsingSharedMemory()).toBe(true);
    const reset = await sendCommand(client, { command: 'reset', seeds: [1] });
    expect(reset.status).toBe('ok');
  });
});
