/**
 * ipc-bridge-multiclient.test.ts — Per-client worker-pool isolation regression coverage for issue #193
 *
 * A single IpcBridge serves multiple ZMQ DEALER clients, each with its own
 * routing identity (the documented transport model for Python clients). Each
 * client that calls `init` must own its own worker pool:
 *   - a second client's `init` must not silently reset the first client's
 *     episode (tick keeps advancing, env count unchanged),
 *   - one client's session `close` must not break the other clients' pools.
 * Previously the bridge shared one process-global pool, so B's init recreated
 * the pool under A (silent reset) and A's close killed B's pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge per-client worker-pool isolation (issue #193)', () => {
  let bridge: IpcBridge;
  let clientA: zmq.Dealer;
  let clientB: zmq.Dealer;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 17200, endPort: 17299 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
    // start() runs the serve loop until close(), so do not await it.
    void bridge.start();

    clientA = new zmq.Dealer({ routingId: 'clientA' });
    await clientA.connect(`tcp://127.0.0.1:${port}`);
    clientB = new zmq.Dealer({ routingId: 'clientB' });
    await clientB.connect(`tcp://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 300));
  }, 30000);

  afterAll(async () => {
    try {
      clientA.close();
    } catch {
      /* ignore */
    }
    try {
      clientB.close();
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

  async function sendCommand(client: zmq.Dealer, cmd: object): Promise<any> {
    await client.send(JSON.stringify(cmd));
    const [response] = await client.receive();
    return JSON.parse(response.toString());
  }

  async function stepTick(
    client: zmq.Dealer,
    envs: number,
  ): Promise<{ status: string; tick?: number; results?: number; error?: string }> {
    const response = await sendCommand(client, {
      command: 'step',
      actions: new Array(envs).fill(0),
    });
    if (response.status !== 'ok') {
      return { status: response.status, error: response.error };
    }
    return { status: 'ok', tick: response.data[0].info.tick, results: response.data.length };
  }

  it("a second client init reset does not reset the first client's episode", async () => {
    const initA = await sendCommand(clientA, { command: 'init', numEnvs: 1, useSharedMemory: false, config: {} });
    expect(initA.status).toBe('ok');
    const resetA = await sendCommand(clientA, { command: 'reset', seeds: [7] });
    expect(resetA.status).toBe('ok');
    expect(resetA.data.observation).toHaveLength(1);

    const step1 = await stepTick(clientA, 1);
    expect(step1.status).toBe('ok');
    expect(step1.tick).toBe(1);
    const step2 = await stepTick(clientA, 1);
    expect(step2.status).toBe('ok');
    expect(step2.tick).toBe(2);

    // A second client joins the same server with a DIFFERENT env count — the
    // strongest form of the old bug: it used to recreate the shared pool and
    // retarget the shared env-count validation at B's count.
    const initB = await sendCommand(clientB, { command: 'init', numEnvs: 2, useSharedMemory: false, config: {} });
    expect(initB.status).toBe('ok');

    // A's episode must continue untouched: same env count, tick still advancing.
    const step3 = await stepTick(clientA, 1);
    expect(step3.status).toBe('ok');
    expect(step3.results).toBe(1);
    expect(step3.tick).toBe(3);

    // A's action batch is still validated against A's own env count.
    const wrongSize = await sendCommand(clientA, { command: 'step', actions: [0, 0] });
    expect(wrongSize.status).toBe('error');
    expect(wrongSize.error).toContain('expected 1 action for 1 environment, got 2');

    // B's session is independent: its pool runs 2 envs and B's own episode advances.
    const resetB = await sendCommand(clientB, { command: 'reset', seeds: [1, 2] });
    expect(resetB.status).toBe('ok');
    expect(resetB.data.observation).toHaveLength(2);
    const bStep1 = await stepTick(clientB, 2);
    expect(bStep1.status).toBe('ok');
    expect(bStep1.results).toBe(2);
    const bStep2 = await stepTick(clientB, 2);
    expect(bStep2.status).toBe('ok');
    expect(bStep2.tick).toBe(bStep1.tick! + 1);
  }, 60000);

  it('one client session close must not break the other client (issue #193 regression)', async () => {
    // Fresh sessions for both clients.
    const initA = await sendCommand(clientA, { command: 'init', numEnvs: 1, useSharedMemory: false, config: {} });
    expect(initA.status).toBe('ok');
    const resetA = await sendCommand(clientA, { command: 'reset', seeds: [11] });
    expect(resetA.status).toBe('ok');
    const aStep1 = await stepTick(clientA, 1);
    expect(aStep1.status).toBe('ok');
    const aStep2 = await stepTick(clientA, 1);
    expect(aStep2.status).toBe('ok');
    expect(aStep2.tick).toBe(aStep1.tick! + 1);

    const initB = await sendCommand(clientB, { command: 'init', numEnvs: 1, useSharedMemory: false, config: {} });
    expect(initB.status).toBe('ok');
    const resetB = await sendCommand(clientB, { command: 'reset', seeds: [23] });
    expect(resetB.status).toBe('ok');
    const bStep1 = await stepTick(clientB, 1);
    expect(bStep1.status).toBe('ok');

    // A closes its own session only.
    const closeA = await sendCommand(clientA, { command: 'close' });
    expect(closeA.status).toBe('ok');

    // B's pool must still be alive and B's episode must keep advancing.
    const bStep2 = await stepTick(clientB, 1);
    expect(bStep2.status).toBe('ok');
    expect(bStep2.tick).toBe(bStep1.tick! + 1);

    // The closed client's own pool is gone: its next request fails loudly
    // instead of breaking the other client. This must hold even when the
    // bridge's local/bypass pool (initEnv) is initialized — a registered
    // identity must never silently redirect to another pool.
    await bridge.initEnv(1, {}, false);
    const aAfterClose = await stepTick(clientA, 1);
    expect(aAfterClose.status).toBe('error');
    expect(aAfterClose.error).toBe('Worker pool not initialized');
  }, 60000);
});
