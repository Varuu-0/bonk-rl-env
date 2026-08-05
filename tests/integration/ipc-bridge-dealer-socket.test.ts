/**
 * ipc-bridge-dealer-socket.test.ts — DEALER-socket regression coverage for issue #191
 *
 * Exercises the exact failure scenario from the issue over a real ZMQ DEALER
 * socket (as the Python client does): a `step` request with fewer actions than
 * environments must be rejected as a per-request error, and a subsequent
 * correctly-sized step/reset must still succeed. Previously, in shared-memory
 * mode, the short batch permanently failed the pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { WorkerPool } from '../../src/core/worker-pool';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge DEALER-socket action batch validation (issue #191)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 15600, endPort: 15699 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
    // start() runs the serve loop until close(), so do not await it.
    void bridge.start();
    client = new zmq.Dealer();
    await client.connect(`tcp://127.0.0.1:${port}`);
    await new Promise(r => setTimeout(r, 300));
  }, 30000);

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    try { await bridge.close(); } catch { /* ignore */ }
    portManager.release(port);
  }, 10000);

  async function sendCommand(cmd: object): Promise<any> {
    await client.send(JSON.stringify(cmd));
    const [response] = await client.receive();
    return JSON.parse(response.toString());
  }

  const expectShortBatchIsTransient = async (useSharedMemory: boolean) => {
    await sendCommand({ command: 'init', numEnvs: 2, useSharedMemory });

    const bad = await sendCommand({ command: 'step', actions: [0] });
    expect(bad.status).toBe('error');
    expect(bad.error).toContain('Invalid actions: expected 2 actions for 2 environments, got 1');

    const good = await sendCommand({ command: 'step', actions: [0, 0] });
    expect(good.status).toBe('ok');
    expect(good.data).toHaveLength(2);

    const reset = await sendCommand({ command: 'reset', seeds: [1, 2] });
    expect(reset.status).toBe('ok');
    expect(reset.data.observation).toHaveLength(2);
  };

  it('message-passing mode: short batch is a per-request error and the pool recovers', async () => {
    await expectShortBatchIsTransient(false);
  }, 60000);

  it('shared-memory mode: short batch is a per-request error and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await expectShortBatchIsTransient(true);
  }, 60000);

  it('programmatic initEnv tracks the env count for IPC step validation', async () => {
    await bridge.initEnv(2, {}, false);

    const good = await sendCommand({ command: 'step', actions: [0, 0] });
    expect(good.status).toBe('ok');
    expect(good.data).toHaveLength(2);

    const short = await sendCommand({ command: 'step', actions: [0] });
    expect(short.status).toBe('error');
    expect(short.error).toContain('Invalid actions: expected 2 actions for 2 environments, got 1');
  }, 60000);

  const expectOverlongBatchIsTransient = async (useSharedMemory: boolean) => {
    await sendCommand({ command: 'init', numEnvs: 2, useSharedMemory });

    // Over-long step actions: rejected before any pool state is touched.
    const badStep = await sendCommand({ command: 'step', actions: [0, 0, 0] });
    expect(badStep.status).toBe('error');
    expect(badStep.error).toContain('Invalid actions: expected 2 actions for 2 environments, got 3');

    // Over-long reset seeds: same per-request error, pool untouched.
    const badReset = await sendCommand({ command: 'reset', seeds: [1, 2, 3] });
    expect(badReset.status).toBe('error');
    expect(badReset.error).toContain('Invalid seeds: expected at most 2 seeds for 2 environments, got 3');

    // Non-array seeds are rejected with a clean error reply.
    const badSeeds = await sendCommand({ command: 'reset', seeds: 42 });
    expect(badSeeds.status).toBe('error');
    expect(badSeeds.error).toContain('Invalid seeds: must be an array');

    // Correctly sized follow-ups succeed.
    const goodStep = await sendCommand({ command: 'step', actions: [0, 0] });
    expect(goodStep.status).toBe('ok');
    expect(goodStep.data).toHaveLength(2);

    const goodReset = await sendCommand({ command: 'reset', seeds: [1, 2] });
    expect(goodReset.status).toBe('ok');
    expect(goodReset.data.observation).toHaveLength(2);
  };

  it('message-passing mode: over-long batches are per-request errors and the pool recovers', async () => {
    await expectOverlongBatchIsTransient(false);
  }, 60000);

  it('shared-memory mode: over-long batches are per-request errors and the pool recovers', async () => {
    if (!WorkerPool.isSupported()) return;
    await expectOverlongBatchIsTransient(true);
  }, 60000);
});
