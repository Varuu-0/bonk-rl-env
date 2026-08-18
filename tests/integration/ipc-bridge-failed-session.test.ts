/**
 * ipc-bridge-failed-session.test.ts — Regression coverage for issue #400
 *
 * When a client session's WorkerPool fails AFTER init (shared-memory step/reset
 * timeout, worker crash/exit, or a post-signal error), the pool transitions to
 * the failed state and can never serve again. handleRequest used to keep such a
 * session in `sessions`, so every later step/reset from that identity failed
 * with "worker pool is in failed state" and the dead session held a
 * maxClientSessions slot until the 5-minute idle reap. The fix mirrors the
 * init-failure cleanup: a step/reset failure that leaves the pool failed drops
 * the session and closes its pool, and a fresh init from the same identity
 * recreates a clean session without hitting the session cap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge drops sessions whose pool failed after init (issue #400)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;
  // The bridge keys sessions by the client's ZMQ routing identity in hex.
  const sessionKey = Buffer.from('failclient', 'utf8').toString('hex');

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 16200, endPort: 16299 });
    port = portManager.allocate();
    // A cap of 1 makes the freed-slot assertion exact: without the fix the
    // failed session keeps occupying the only slot and the fresh init fails.
    bridge = new IpcBridge({ server: { port, maxClientSessions: 1 } } as any);
    // start() runs the serve loop until close(), so do not await it.
    void bridge.start();

    client = new zmq.Dealer({ routingId: 'failclient' });
    await client.connect(`tcp://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 300));
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

  async function sendCommand(cmd: object): Promise<any> {
    await client.send(JSON.stringify(cmd));
    const [response] = await client.receive();
    return JSON.parse(response.toString());
  }

  function sessions(): Map<string, any> {
    return (bridge as any).sessions as Map<string, any>;
  }

  function init(useSharedMemory = true): Promise<any> {
    return sendCommand({ command: 'init', numEnvs: 1, useSharedMemory, config: {} });
  }

  it(
    'a step on a pool that failed after init errors AND removes the session, freeing the client-cap slot',
    { timeout: 60000 },
    async () => {
      const initResponse = await init();
      expect(initResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);

      // Force the pool into the failed state exactly as a shared-memory step
      // timeout / worker crash / post-signal error would (failPool -> 'failed').
      const session = sessions().get(sessionKey);
      await (session.pool as any).failPool(
        new Error('Shared-memory step timed out after 30000ms waiting for worker(s) 0'),
      );

      const stepResponse = await sendCommand({ command: 'step', actions: [0] });
      expect(stepResponse.status).toBe('error');
      expect(stepResponse.error).toContain('worker pool is in failed state');
      // The dead session must be dropped (and its pool closed), mirroring init-failure cleanup.
      expect(sessions().has(sessionKey)).toBe(false);

      // The single client-cap slot is now free: a fresh init from the same
      // identity succeeds. Before the fix this hit "Too many active client
      // sessions (max 1)" because the failed session never left the map.
      const reinitResponse = await init();
      expect(reinitResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);
    },
  );

  it('a reset on a pool that failed after init errors AND removes the session', { timeout: 60000 }, async () => {
    const initResponse = await init();
    expect(initResponse.status).toBe('ok');

    const session = sessions().get(sessionKey);
    await (session.pool as any).failPool(
      new Error('Shared-memory reset timed out after 30000ms waiting for worker(s) 0'),
    );

    const resetResponse = await sendCommand({ command: 'reset', seeds: [1] });
    expect(resetResponse.status).toBe('error');
    expect(resetResponse.error).toContain('worker pool is in failed state');
    expect(sessions().has(sessionKey)).toBe(false);
  });

  it('transient per-request errors do NOT drop a healthy session', { timeout: 60000 }, async () => {
    const initResponse = await init();
    expect(initResponse.status).toBe('ok');
    expect(sessions().has(sessionKey)).toBe(true);

    // A wrong-sized action batch is rejected before touching the pool: the
    // pool stays ready, so the session must remain mapped.
    const badStep = await sendCommand({ command: 'step', actions: [0, 0] });
    expect(badStep.status).toBe('error');
    expect(badStep.error).toContain('expected 1 action for 1 environment, got 2');
    expect(sessions().has(sessionKey)).toBe(true);
    expect((sessions().get(sessionKey).pool as any).isFailed()).toBe(false);

    // The session is still fully usable.
    const stepResponse = await sendCommand({ command: 'step', actions: [0] });
    expect(stepResponse.status).toBe('ok');
  });
});
