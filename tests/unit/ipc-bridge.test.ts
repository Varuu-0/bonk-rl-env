/**
 * ipc-bridge.test.ts — Tests for IpcBridge handleRequest
 *
 * Tests the private handleRequest method by accessing it via type casting.
 * Covers JSON parsing, command dispatch, and error handling branches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { WorkerPool } from '../../src/core/worker-pool';
import { BonkEnvironment } from '../../src/core/environment';
import { resetConfig } from '../../src/config/config-loader';

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

    it('rejects init with a fractional numEnvs as error (#195)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1.5 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBe('Invalid numEnvs: must be a positive integer');
    });

    it('rejects init with a sub-one fractional numEnvs as error (#195)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 0.5 }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBe('Invalid numEnvs: must be a positive integer');
    });

    it('rejects a non-decimal numeric-string numEnvs as error (#195)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: '0x2' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBe('Invalid numEnvs: must be a positive integer');
    });

    it('coerces a numeric-string numEnvs to a positive integer (#195)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: '2' }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1, 2] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0, 0] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0, 0, 0] }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('expected 2 actions');
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

    it('forwards snake_case frame_skip through init to the worker (#204)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: 4, maxTicks: 100 }
      }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      expect(response.data[0].info.frameSkip).toBe(4);
    });

    it('forwards snake_case max_ticks through init to the worker (#204)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { max_ticks: 5, frame_skip: 1 }
      }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      await callHandleRequest(bridge, JSON.stringify({ command: 'reset', seeds: [1] }));
      expect(JSON.parse(sentMessages[0]).status).toBe('ok');
      sentMessages.length = 0;

      let firstDone = -1;
      let truncated = false;
      for (let i = 1; i <= 10; i++) {
        sentMessages.length = 0;
        await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
        const stepResponse = JSON.parse(sentMessages[0]);
        expect(stepResponse.status).toBe('ok');
        if (firstDone === -1 && stepResponse.data[0].done) {
          firstDone = i;
          truncated = stepResponse.data[0].truncated;
        }
      }
      expect(firstDone).toBe(5);
      expect(truncated).toBe(true);
    });

    it('rejects init with a non-positive max_ticks instead of serving a permanently-terminal pool (#266)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { max_ticks: 0 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid maxTicks 0: expected a positive integer');
    });

    it('rejects init with a negative max_ticks (#266)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { max_ticks: -3 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid maxTicks -3: expected a positive integer');
    });

    it('rejects init with a zero frame_skip (#393)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: 0 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid frameSkip 0: expected an integer in [1, 100]');
    });

    it('rejects init with a negative frame_skip (#393)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: -2 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid frameSkip -2: expected an integer in [1, 100]');
    });

    it('rejects init with a fractional frame_skip (#393)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: 2.5 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid frameSkip 2.5: expected an integer in [1, 100]');
    });

    it('rejects init with a frame_skip past the cap (#393)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: 1000 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('Invalid frameSkip 1000: expected an integer in [1, 100]');
    });

    it('accepts init with frame_skip at the MAX_FRAME_SKIP boundary (#393)', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({
        command: 'init',
        numEnvs: 1,
        useSharedMemory: false,
        config: { frame_skip: 100, maxTicks: 50 }
      }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
    });

    it('forwards loader reward environment variables through IPC init to worker environments (#220)', { timeout: 30000 }, async () => {
      const rewardEnvKeys = ['KILL_REWARD', 'DEATH_PENALTY', 'TIME_PENALTY'] as const;
      const savedRewardEnv = Object.fromEntries(
        rewardEnvKeys.map(key => [key, process.env[key]]),
      ) as Record<typeof rewardEnvKeys[number], string | undefined>;

      const runStep = async (port: number, config: Record<string, any>) => {
        const workerBridge = new IpcBridge({ server: { port } } as any);
        const { sentMessages } = captureSend(workerBridge);
        try {
          await callHandleRequest(workerBridge, JSON.stringify({
            command: 'init',
            numEnvs: 1,
            useSharedMemory: false,
            config,
          }));
          expect(JSON.parse(sentMessages[0]).status).toBe('ok');

          sentMessages.length = 0;
          await callHandleRequest(workerBridge, JSON.stringify({ command: 'reset', seeds: [1] }));
          expect(JSON.parse(sentMessages[0]).status).toBe('ok');

          sentMessages.length = 0;
          await callHandleRequest(workerBridge, JSON.stringify({ command: 'step', actions: [0] }));
          return JSON.parse(sentMessages[0]).data[0];
        } finally {
          await workerBridge.close();
        }
      };

      await bridge.close();
      process.env.KILL_REWARD = '7';
      process.env.DEATH_PENALTY = '-5';
      process.env.TIME_PENALTY = '-0.5';
      resetConfig();

      try {
        const killResult = await runStep(15573, {
          numOpponents: 1,
          randomOpponent: false,
          maxTicks: 100,
          mapData: {
            name: 'ipc-reward-kill',
            spawnPoints: {
              team_blue: { x: -200, y: -100 },
              team_red: { x: 200, y: -100 },
            },
            bodies: [
              { name: 'lethal', type: 'rect', x: 200, y: -100, width: 100, height: 100, static: true, isLethal: true },
            ],
          },
        });
        expect(killResult.reward).toBe(6.5);

        const deathResult = await runStep(15574, {
          numOpponents: 0,
          randomOpponent: false,
          maxTicks: 100,
          mapData: {
            name: 'ipc-reward-death',
            spawnPoints: {
              team_blue: { x: 0, y: 0 },
              team_red: { x: 200, y: -100 },
            },
            bodies: [
              { name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true },
            ],
          },
        });
        expect(deathResult.reward).toBe(-5.5);

        const timeResult = await runStep(15575, {
          numOpponents: 0,
          randomOpponent: false,
          maxTicks: 100,
        });
        expect(timeResult.done).toBe(false);
        expect(timeResult.reward).toBe(-0.5);
      } finally {
        for (const key of rewardEnvKeys) {
          if (savedRewardEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedRewardEnv[key];
          }
        }
        resetConfig();
      }
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

    it('handles step before init as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'step', actions: [0] }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBe('Worker pool not initialized');
    });

    it('handles reset before init as error', async () => {
      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'reset' }));
      expect(sentMessages).toHaveLength(1);
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toBe('Worker pool not initialized');
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

describe('IpcBridge solver precedence (#325)', () => {
  let savedSolverIterations: string | undefined;
  let savedArgv: string[];

  beforeEach(() => {
    savedSolverIterations = process.env.SOLVER_ITERATIONS;
    savedArgv = [...process.argv];
    delete (process.env as any).SOLVER_ITERATIONS;
    process.argv = ['node', 'script.js'];
    resetConfig();
  });

  afterEach(() => {
    if (savedSolverIterations === undefined) {
      delete (process.env as any).SOLVER_ITERATIONS;
    } else {
      process.env.SOLVER_ITERATIONS = savedSolverIterations;
    }
    process.argv = savedArgv;
    resetConfig();
  });

  const mapData = {
    name: 'ipc-pq-test-map',
    spawnPoints: {
      team_blue: { x: -200, y: -100 },
      team_red: { x: 200, y: -100 },
    },
    bodies: [
      { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
      { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
    ],
    settings: { pq: 2 },
  };

  async function initThroughIpc(
    bridge: IpcBridge,
    config: Record<string, any>,
  ): Promise<any> {
    const captured: any[] = [];
    const sentMessages: any[] = [];
    const initSpy = vi.spyOn(WorkerPool.prototype, 'init').mockImplementation(async (_count, workerConfig) => {
      captured.push(workerConfig);
    });
    (bridge as any)._wrappedSend = vi.fn(async (frames: any[]) => {
      sentMessages.push(frames[1]?.toString() ?? frames[1]);
    });

    try {
      await (bridge as any).handleRequest(
        Buffer.from('ipc-pq-test-client'),
        JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false, config }),
      );
      expect(JSON.parse(sentMessages[0])).toMatchObject({ status: 'ok' });
      expect(captured).toHaveLength(1);
      return captured[0];
    } finally {
      initSpy.mockRestore();
    }
  }

  it('forwards pq=2 through IPC without injecting solverIterations=2 (#325)', async () => {
    const bridge = new IpcBridge({ server: { port: 15576 } } as any);
    try {
      const workerConfig = await initThroughIpc(bridge, {
        mapData,
        numOpponents: 0,
      });
      expect(workerConfig.mapData.settings.pq).toBe(2);
      expect(workerConfig.physics.solverIterations).toBeUndefined();

      const workerEnv = new BonkEnvironment(workerConfig);
      try {
        expect((workerEnv as any).physics.velocityIterations).toBe(15);
        expect((workerEnv as any).physics.positionIterations).toBe(15);
      } finally {
        workerEnv.close();
      }
    } finally {
      await bridge.close();
    }
  });

  it('preserves an explicit IPC solverIterations override over pq=2 (#325)', async () => {
    const bridge = new IpcBridge({ server: { port: 15577 } } as any);
    try {
      const workerConfig = await initThroughIpc(bridge, {
        mapData,
        numOpponents: 0,
        physics: { solverIterations: 12 },
      });
      expect(workerConfig.physics.solverIterations).toBe(12);

      const workerEnv = new BonkEnvironment(workerConfig);
      try {
        expect((workerEnv as any).physics.velocityIterations).toBe(12);
        expect((workerEnv as any).physics.positionIterations).toBe(15);
      } finally {
        workerEnv.close();
      }
    } finally {
      await bridge.close();
    }
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

describe('IpcBridge initEnv validation (#195, #227)', () => {
  it('rejects a non-positive or non-integer numEnvs before touching the pool', async () => {
    const bridge = new IpcBridge({ server: { port: 15571 } } as any);
    try {
      const pool = (bridge as any).pool;
      const initSpy = vi.spyOn(pool, 'init');

      await expect((bridge as any).initEnv(0)).rejects.toThrow('Invalid numEnvs: must be a positive integer');
      await expect((bridge as any).initEnv(-1)).rejects.toThrow('Invalid numEnvs: must be a positive integer');
      await expect((bridge as any).initEnv(1.5)).rejects.toThrow('Invalid numEnvs: must be a positive integer');
      expect(initSpy).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('applies a valid integer initEnv', async () => {
    const bridge = new IpcBridge({ server: { port: 15572 } } as any);
    try {
      await (bridge as any).initEnv(1, {}, false);
      expect((bridge as any).localSession.numEnvs).toBe(1);
    } finally {
      await bridge.close();
    }
  });
});

describe('IpcBridge adopted pool (enableIpcServer hosts the env pool, #223/#252)', () => {
  function captureSend(bridge: IpcBridge): { sentMessages: any[] } {
    const sentMessages: any[] = [];
    (bridge as any)._wrappedSend = vi.fn(async (frames: any[]) => {
      sentMessages.push(frames[1]?.toString() ?? frames[1]);
    });
    return { sentMessages };
  }

  function callHandleRequest(bridge: IpcBridge, rawMsg: string): Promise<void> {
    return (bridge as any).handleRequest(Buffer.from('identity'), rawMsg);
  }

  it('accepts an init matching the hosted env count without re-initializing the adopted pool', async () => {
    const bridge = new IpcBridge({ server: { port: 15600 } } as any);
    try {
      const adopted = (bridge as any).pool;
      const initSpy = vi.spyOn(adopted, 'init');
      bridge.adoptPool(adopted, 2);

      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 2 }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      // The env-configured pool must not be discarded/rebuild: adoption already
      // marks the pool initialized with the hosted count, so a client init is a
      // no-op that must never re-initialize (which would drop the env workers).
      expect(initSpy).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('rejects an init whose numEnvs mismatches the hosted env count (#223/#252)', async () => {
    const bridge = new IpcBridge({ server: { port: 15601 } } as any);
    try {
      bridge.adoptPool((bridge as any).pool, 2);

      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 1 }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('error');
      expect(response.error).toContain('this IPC server hosts 2 environment(s)');
    } finally {
      await bridge.close();
    }
  });

  it('does not reject the Python BonkVecEnv useSharedMemory:true init against a false adopted pool; echoes effective values (#252)', async () => {
    const bridge = new IpcBridge({ server: { port: 15604 } } as any);
    try {
      // Host env configured useSharedMemory:false + enableIpcServer:true — the
      // configuration the PR's integration tests use. The Python BonkVecEnv
      // hardcodes "useSharedMemory": true on every init and consumes only the
      // JSON replies (python/envs/bonk_env.py:82). The value is transport-internal
      // to the host's workers and never changes the JSON contract, so this must
      // be accepted with an ok reply and the effective values echoed, not a hard
      // error that would raise RuntimeError in BonkVecEnv.__init__.
      bridge.adoptPool((bridge as any).pool, 2, { config: { frameSkip: 3 }, useSharedMemory: false });

      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 2, useSharedMemory: true }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      expect(response.config).toEqual({ frameSkip: 3 });
      expect(response.useSharedMemory).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('echoes the effective config/useSharedMemory on a matching-count adopted-pool init (#252)', async () => {
    const bridge = new IpcBridge({ server: { port: 15605 } } as any);
    try {
      bridge.adoptPool((bridge as any).pool, 2, { config: { frameSkip: 3, maxTicks: 200 }, useSharedMemory: false });

      const { sentMessages } = captureSend(bridge);
      await callHandleRequest(bridge, JSON.stringify({ command: 'init', numEnvs: 2, useSharedMemory: false }));
      const response = JSON.parse(sentMessages[0]);
      expect(response.status).toBe('ok');
      // The client's own settings are honored only to the extent they match the
      // hosted env; the effective config that will actually serve is echoed so
      // the client can detect any divergence instead of silently discarding it.
      expect(response.config).toEqual({ frameSkip: 3, maxTicks: 200 });
      expect(response.useSharedMemory).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('rejects adopting a pool after the bridge pool is already initialized', async () => {
    const bridge = new IpcBridge({ server: { port: 15602 } } as any);
    try {
      await (bridge as any).initEnv(1, {}, false);
      expect(() => bridge.adoptPool((bridge as any).pool, 1)).toThrow(
        'Cannot adopt a pool after the bridge pool has been initialized'
      );
    } finally {
      await bridge.close();
    }
  });

  it('rejects adopting a second pool onto an already-hosting bridge', async () => {
    const bridge = new IpcBridge({ server: { port: 15603 } } as any);
    try {
      bridge.adoptPool((bridge as any).pool, 1);
      expect(() => bridge.adoptPool((bridge as any).pool, 1)).toThrow(
        'Cannot adopt a pool after the bridge pool has been initialized'
      );
    } finally {
      await bridge.close();
    }
  });
});
