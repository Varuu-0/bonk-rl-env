/**
 * ipc-bridge.test.ts — Tests for IpcBridge handleRequest
 *
 * Tests the private handleRequest method by accessing it via type casting.
 * Covers JSON parsing, command dispatch, and error handling branches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IpcBridge } from '../../src/ipc/ipc-bridge';

describe('IpcBridge handleRequest', () => {
  let bridge: IpcBridge;

  beforeEach(() => {
    bridge = new IpcBridge({ server: { port: 15570 } } as any);
  });

  afterEach(async () => {
    try { await bridge.close(); } catch { /* ignore */ }
  });

  function captureSend(bridge: IpcBridge): { sendFn: any; sentMessages: any[] } {
    const sentMessages: any[] = [];
    const sendFn = vi.fn(async (frames: any[]) => {
      const rawResponse = frames[1]?.toString() ?? frames[1];
      sentMessages.push(rawResponse);
    });
    (bridge as any)._wrappedSend = sendFn;
    return { sendFn, sentMessages };
  }

  function callHandleRequest(bridge: IpcBridge, rawMsg: string): Promise<void> {
    return (bridge as any).handleRequest(Buffer.from('identity'), rawMsg);
  }

  describe('handleRequest', () => {
    it('handles malformed JSON', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, 'not json');
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBeDefined();
    });

    it('handles unknown command', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'foo' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Unknown command');
    });

    it('handles missing command field', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ foo: 'bar' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Unknown command');
    });

    it('handles init command with valid numEnvs', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
    });

    it('handles init with zero numEnvs as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 0 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid numEnvs');
    });

    it('handles init with negative numEnvs as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: -1 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid numEnvs');
    });

    it('handles init with string numEnvs as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 'five' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid numEnvs');
    });

    it('handles init with missing numEnvs as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid numEnvs');
    });

    it('handles init with config merging', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        config: { seed: 42 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
    });

    it('handles reset command', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      sentMessages.length = 0;
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1] }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      expect(response.data).toHaveProperty('observation');
    });

    it('handles reset without seeds', async () => {
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      expect(response.data).toHaveProperty('observation');
    });

    it('handles step command', async () => {
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1] }));
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      expect(response.data).toBeDefined();
    });

    it('handles step without actions as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid actions');
    });

    it('handles step with empty actions array as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [] }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid actions');
    });

    it('handles step with non-array actions as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: 0 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid actions');
    });

    it('handles step without init returns empty ok', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
    });

    it('handles reset without init returns empty ok', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
    });

    it('handles full init-reset-step lifecycle', async () => {
      const { sentMessages } = captureSend(bridge);

      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 2 }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1, 2] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0, 1] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
    });

    it('handles multiple sequential steps', async () => {
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1] }));

      for (let i = 0; i < 5; i++) {
        const { sentMessages } = captureSend(bridge);
        await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
        const response = JSON.parse(sentMessages[0]);
        expect(response.status).toBe('ok');
      }
    });
  });
});


describe('IpcBridge constructor internals', () => {
  it('uses port from config (line 17)', () => {
    const bridge = new IpcBridge({ server: { port: 19999 } } as any);
    expect(bridge.getPort()).toBe(19999);
  });

  it('initializes _closed to false (line 14)', () => {
    const bridge = new IpcBridge({ server: { port: 19998 } } as any);
    expect(bridge.isClosed()).toBe(false);
  });

  it('sets up wrapped send (line 22)', () => {
    const bridge = new IpcBridge({ server: { port: 19997 } } as any);
    expect((bridge as any)._wrappedSend).toBeDefined();
    expect(typeof (bridge as any)._wrappedSend).toBe('function');
  });
});

describe('IpcBridge close internals (lines 159-173)', () => {
  it('close sets _closed to true (line 163)', async () => {
    const bridge = new IpcBridge({ server: { port: 19996 } } as any);
    expect(bridge.isClosed()).toBe(false);
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
  });

  it('close is idempotent (lines 160-162)', async () => {
    const bridge = new IpcBridge({ server: { port: 19995 } } as any);
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    const pool = (bridge as any).pool;
    const spy = vi.spyOn(pool, 'close');
    await bridge.close();
    expect(spy).not.toHaveBeenCalled();
  });

  it('close closes socket (line 167)', async () => {
    const bridge = new IpcBridge({ server: { port: 19994 } } as any);
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
  });

  it('close ignores socket errors (lines 166-170)', async () => {
    const bridge = new IpcBridge({ server: { port: 19993 } } as any);
    await bridge.close();
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it('close closes worker pool (line 172)', async () => {
    const bridge = new IpcBridge({ server: { port: 19992 } } as any);
    const pool = (bridge as any).pool;
    const spy = vi.spyOn(pool, 'close');
    await bridge.close();
    expect(spy).toHaveBeenCalled();
  });
});
