/**
 * ipc-bridge-e2e.test.ts — Black-box E2E tests for the ZMQ IPC bridge
 *
 * These tests treat the IpcBridge as a black box:
 * - Connect via ZMQ DEALER socket (simulating a Python client)
 * - Send JSON commands and validate JSON responses
 * - No knowledge of internal WorkerPool, SharedMemoryManager, or worker threads
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';

describe('IpcBridge black-box E2E', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  const testPort = 15556;

  beforeAll(async () => {
    bridge = new IpcBridge({ server: { port: testPort } } as any);
    await bridge.start();
    client = new zmq.Dealer();
    await client.connect(`tcp://127.0.0.1:${testPort}`);
    await new Promise(r => setTimeout(r, 500));
  }, 30000);

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    try { await bridge.close(); } catch { /* ignore */ }
  }, 10000);

  async function sendCommand(cmd: object): Promise<any> {
    await client.send(JSON.stringify(cmd));
    const [response] = await client.receive();
    return JSON.parse(response.toString());
  }

  describe('init command', () => {
    it('initializes a single environment', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: 1 });
      expect(result.status).toBe('ok');
    });

    it('initializes multiple environments', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: 4 });
      expect(result.status).toBe('ok');
    });

    it('rejects numEnvs=0', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: 0 });
      expect(result.status).toBe('error');
      expect(result.error).toContain('positive');
    });

    it('rejects negative numEnvs', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: -5 });
      expect(result.status).toBe('error');
    });

    it('rejects non-numeric numEnvs', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: 'abc' });
      expect(result.status).toBe('error');
    });

    it('accepts custom environment config', async () => {
      const result = await sendCommand({
        command: 'init',
        numEnvs: 2,
        config: { seed: 42, maxTicks: 500 },
      });
      expect(result.status).toBe('ok');
    });
  });

  describe('reset command', () => {
    it('initializes before reset', async () => {
      const result = await sendCommand({ command: 'init', numEnvs: 3 });
      expect(result.status).toBe('ok');
    });

    it('returns observations for all environments', async () => {
      const result = await sendCommand({ command: 'reset', seeds: [1, 2, 3] });
      expect(result.status).toBe('ok');
      expect(result.data.observation).toHaveLength(3);
    });

    it('each observation has 14 values', async () => {
      const result = await sendCommand({ command: 'reset', seeds: [1, 2, 3] });
      for (const obs of result.data.observation) {
        expect(obs).toHaveLength(14);
      }
    });

    it('same seed produces same observation', async () => {
      const r1 = await sendCommand({ command: 'reset', seeds: [99, 99, 99] });
      const r2 = await sendCommand({ command: 'reset', seeds: [99, 99, 99] });
      expect(r1.data.observation).toEqual(r2.data.observation);
    });

    it('different seeds produce different observations', async () => {
      const r1 = await sendCommand({ command: 'reset', seeds: [1, 1, 1] });
      const r2 = await sendCommand({ command: 'reset', seeds: [999, 999, 999] });
      expect(r1.data.observation).not.toEqual(r2.data.observation);
    });
  });

  describe('step command', () => {
    it('initializes and resets before step', async () => {
      await sendCommand({ command: 'init', numEnvs: 3 });
      await sendCommand({ command: 'reset', seeds: [1, 2, 3] });
    });

    it('returns results for all environments', async () => {
      const result = await sendCommand({ command: 'step', actions: [0, 0, 0] });
      expect(result.status).toBe('ok');
      expect(result.data).toHaveLength(3);
    });

    it('each result has observation, reward, done, truncated, info', async () => {
      const result = await sendCommand({ command: 'step', actions: [0, 0, 0] });
      for (const r of result.data) {
        expect(r).toHaveProperty('observation');
        expect(r).toHaveProperty('reward');
        expect(r).toHaveProperty('done');
        expect(r).toHaveProperty('truncated');
        expect(r).toHaveProperty('info');
      }
    });

    it('reward is a finite number', async () => {
      const result = await sendCommand({ command: 'step', actions: [0, 0, 0] });
      for (const r of result.data) {
        expect(typeof r.reward).toBe('number');
        expect(Number.isFinite(r.reward)).toBe(true);
      }
    });

    it('done and truncated are booleans', async () => {
      const result = await sendCommand({ command: 'step', actions: [0, 0, 0] });
      for (const r of result.data) {
        expect(typeof r.done).toBe('boolean');
        expect(typeof r.truncated).toBe('boolean');
      }
    });

    it('all valid actions (0-63) are accepted', async () => {
      for (let action = 0; action <= 63; action++) {
        const result = await sendCommand({ command: 'step', actions: [action, action, action] });
        expect(result.status).toBe('ok');
      }
    });

    it('out-of-range actions handled gracefully', async () => {
      const result = await sendCommand({ command: 'step', actions: [100, -1, 255] });
      expect(result.status).toBe('ok');
    });
  });

  describe('error handling', () => {
    it('unknown command returns error', async () => {
      const result = await sendCommand({ command: 'foo' });
      expect(result.status).toBe('error');
      expect(result.error).toContain('Unknown command');
    });

    it('malformed JSON returns error', async () => {
      await client.send('not json at all {{{');
      const [response] = await client.receive();
      const result = JSON.parse(response.toString());
      expect(result.status).toBe('error');
    });

    it('missing command field returns error', async () => {
      const result = await sendCommand({ foo: 'bar' });
      expect(result.status).toBe('error');
    });

    it('empty actions array returns error', async () => {
      const result = await sendCommand({ command: 'step', actions: [] });
      expect(result.status).toBe('error');
    });

    it('missing actions field returns error', async () => {
      const result = await sendCommand({ command: 'step' });
      expect(result.status).toBe('error');
    });
  });

  describe('protocol compliance', () => {
    it('every response has a status field', async () => {
      await sendCommand({ command: 'init', numEnvs: 1 });
      const resetResult = await sendCommand({ command: 'reset', seeds: [1] });
      expect(resetResult).toHaveProperty('status');
      const stepResult = await sendCommand({ command: 'step', actions: [0] });
      expect(stepResult).toHaveProperty('status');
      const errorResult = await sendCommand({ command: 'bad' });
      expect(errorResult).toHaveProperty('status');
    });

    it('success responses include data field', async () => {
      await sendCommand({ command: 'init', numEnvs: 1 });
      const resetResult = await sendCommand({ command: 'reset', seeds: [1] });
      expect(resetResult.data).toBeDefined();
      const stepResult = await sendCommand({ command: 'step', actions: [0] });
      expect(stepResult.data).toBeDefined();
    });

    it('error responses include error message', async () => {
      const result = await sendCommand({ command: 'bad' });
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });
});
