/**
 * ipc-bridge-telemetry-integrity.test.ts — Regression coverage for issues
 * #185, #229, #240
 *
 * The step reply is serialized before the post-step telemetry block runs.
 * A telemetry failure (e.g. `recordMemory()` throwing, or the worker snapshot
 * fetch rejecting) must NOT discard the reply of a step that already
 * completed: the client would otherwise be told the step failed and retry it,
 * double-stepping the environments (#185).
 *
 * The reply must also be transmitted before/independent of the telemetry
 * fetch, and the fetch must never await inside the request path: in
 * message-passing mode a hung worker would otherwise hold the completed
 * step's reply (and the single-threaded ZMQ loop) for up to messageTimeoutMs
 * (#229). In shared-memory mode the snapshot fetch is non-blocking — workers
 * blocked in Atomics.wait can never service GET_TELEMETRY, so the pool
 * returns an empty set immediately (#240).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sock = {
    bind: async () => {},
    close: () => {},
    send: async () => {},
  };
  const pool = {
    init: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue([]),
    step: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    getTelemetrySnapshots: vi.fn().mockResolvedValue([]),
  };
  const controller = {
    tick: vi.fn(() => false),
    reportNow: vi.fn(() => true),
  };
  return {
    sock,
    pool,
    controller,
    Router: function Router() { return sock; },
    WorkerPool: vi.fn(function WorkerPool() { return pool; }),
    getConfig: vi.fn(),
    isTelemetryEnabled: vi.fn(),
    gpTick: vi.fn(),
    gpRecordMemory: vi.fn(),
    gpReport: vi.fn(),
    setLatestWorkerTelemetry: vi.fn(),
    wrap: vi.fn((_idx, fn) => fn),
  };
});

vi.mock('zeromq', () => ({ Router: mocks.Router }));
vi.mock('../../src/telemetry/profiler', () => ({
  globalProfiler: {
    tick: mocks.gpTick,
    recordMemory: mocks.gpRecordMemory,
    report: mocks.gpReport,
  },
  wrap: mocks.wrap,
  TelemetryIndices: { JSON_PARSE: 0, ZMQ_SEND: 1 },
  setLatestWorkerTelemetry: mocks.setLatestWorkerTelemetry,
}));
vi.mock('../../src/telemetry/telemetry-controller', () => ({
  isTelemetryEnabled: mocks.isTelemetryEnabled,
  getTelemetryController: () => mocks.controller,
}));
vi.mock('../../src/core/worker-pool', () => ({
  WorkerPool: mocks.WorkerPool,
}));
vi.mock('../../src/config/config-loader', () => ({
  getConfig: mocks.getConfig,
  DEFAULT_MAX_CLIENT_SESSIONS: 32,
  deepMerge: (base: Record<string, any>, override: Record<string, any>) => ({ ...base, ...override }),
  mergeEnvironmentConfig: (base: Record<string, any>, override: Record<string, any>) => ({ ...base, ...override }),
  mergeEngineSections: (override: Record<string, any>) => ({ physics: {}, arena: {}, player: {} }),
  resolveEnvironmentConfig: (override: Record<string, any>) => {
    const config = mocks.getConfig();
    return {
      ...config.environment,
      ...override,
      reward: { ...config.reward, ...override.reward },
    };
  },
}));

import { IpcBridge } from '../../src/ipc/ipc-bridge';

// The bridge decides report boundaries via the controller's tick(), so the
// mock keeps the historical 5000-step boundary by consulting the live bridge.
let currentBridge: any = null;

describe('IpcBridge step reply integrity when telemetry fails (issue #185)', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  const stepResult = { observation: [], reward: 0.5, done: false, truncated: false, info: { tick: 5 } };

  beforeEach(() => {
    mocks.getConfig.mockReturnValue({
      server: { port: 5555 },
      environment: { seed: 0 },
      reward: { killReward: 1, deathPenalty: -1, timePenalty: -0.001 },
    });
    mocks.isTelemetryEnabled.mockReturnValue(true);
    mocks.pool.step.mockResolvedValue([stepResult]);
    mocks.pool.getTelemetrySnapshots.mockResolvedValue([]);
    mocks.controller.tick.mockImplementation(() => currentBridge !== null && currentBridge.stepCount % 5000 === 0);
    mocks.controller.reportNow.mockReturnValue(true);
    sendSpy = vi.spyOn(mocks.sock, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    currentBridge = null;
    sendSpy.mockRestore();
  });

  async function initAndStepAtBoundary(port: number) {
    const bridge = new IpcBridge({ server: { port } } as any);
    currentBridge = bridge;
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    (bridge as any).stepCount = 4999;
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    return bridge;
  }

  function lastSentResponse(): any {
    const call = sendSpy.mock.calls[sendSpy.mock.calls.length - 1];
    const frames = call[0] as any[];
    return JSON.parse(frames[1].toString());
  }

  it('reports ok for a completed step when recordMemory throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.gpRecordMemory.mockImplementationOnce(() => { throw new Error('synthetic memory failure'); });

    await initAndStepAtBoundary(12363);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(response.data).toHaveLength(1);
    expect(response.data[0].reward).toBe(0.5);
    expect(mocks.pool.step).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('reports ok for a completed step when getTelemetrySnapshots rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.pool.getTelemetrySnapshots.mockRejectedValueOnce(new Error('snapshot timeout'));

    const bridge = await initAndStepAtBoundary(12364);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(response.data).toHaveLength(1);
    expect(response.data[0].reward).toBe(0.5);
    expect(mocks.pool.step).toHaveBeenCalledTimes(1);
    expect(mocks.pool.getTelemetrySnapshots).toHaveBeenCalledWith({ failOnTimeout: false });

    // The detached snapshot failure must not poison the pool used by the next
    // request. A real message-mode timeout is covered at WorkerPool level.
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastSentResponse().status).toBe('ok');
    expect(mocks.pool.step).toHaveBeenCalledTimes(2);
    consoleErrorSpy.mockRestore();
  });

  it('fetches telemetry snapshots on the boundary step, including in shared-memory mode (issue #240)', async () => {
    await initAndStepAtBoundary(12365);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    // The bridge always fetches instead of skipping: getTelemetrySnapshots
    // is non-blocking in shared mode (it returns an empty set immediately
    // instead of waiting on unanswerable worker messages), so no mode check
    // is needed at the bridge.
    expect(mocks.pool.getTelemetrySnapshots).toHaveBeenCalled();
  });

  it('skips the telemetry block entirely when telemetry is disabled', async () => {
    mocks.isTelemetryEnabled.mockReturnValue(false);

    await initAndStepAtBoundary(12366);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(mocks.pool.getTelemetrySnapshots).not.toHaveBeenCalled();
    expect(mocks.gpReport).not.toHaveBeenCalled();
  });

  it('sends the step reply before the telemetry snapshot fetch completes (issue #229)', async () => {
    const events: string[] = [];
    let resolveSnapshots!: (value: BigUint64Array[]) => void;
    mocks.pool.getTelemetrySnapshots.mockImplementation(() => new Promise<BigUint64Array[]>(res => {
      events.push('snapshot-start');
      resolveSnapshots = res;
    }));
    sendSpy.mockImplementation(async () => {
      events.push('send');
    });

    await initAndStepAtBoundary(12367);

    // init replies once, then the boundary step's reply is sent eagerly —
    // before the telemetry fetch even begins — so a slow or hung worker
    // snapshot fetch can never delay or stall the completed step's reply.
    expect(events).toEqual(['send', 'send', 'snapshot-start']);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(response.data).toHaveLength(1);
    expect(mocks.pool.step).toHaveBeenCalledTimes(1);

    // Unblock the detached telemetry task so it settles cleanly.
    resolveSnapshots([]);
    await new Promise(r => setImmediate(r));
  });

  it('does not reap a pool while detached telemetry is still reading it', async () => {
    let resolveSnapshots!: (value: BigUint64Array[]) => void;
    mocks.pool.getTelemetrySnapshots.mockImplementation(() => new Promise<BigUint64Array[]>(res => {
      resolveSnapshots = res;
    }));

    const bridge = await initAndStepAtBoundary(12368);
    const session = (bridge as any).sessions.get(Buffer.from('identity').toString('hex'));
    session.lastActivityAt = Date.now() - 5 * 60 * 1000;

    await (bridge as any).reapExpiredSessions();
    expect(mocks.pool.close).not.toHaveBeenCalled();
    expect((bridge as any).sessions.get(Buffer.from('identity').toString('hex'))).toBe(session);

    resolveSnapshots([]);
    await new Promise(r => setImmediate(r));
    session.lastActivityAt = Date.now() - 5 * 60 * 1000;

    await (bridge as any).reapExpiredSessions();
    expect(mocks.pool.close).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping boundary steps into a single fetch and report (single-flight)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every step is a report-due step so two consecutive steps both enter the
    // telemetry branch while the first snapshot fetch is still pending.
    mocks.controller.tick.mockReturnValue(true);
    const bridge = new IpcBridge({ server: { port: 5555 } } as any);
    currentBridge = bridge;
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    let resolveSnapshots!: (value: BigUint64Array[]) => void;
    mocks.pool.getTelemetrySnapshots.mockImplementation(() => new Promise<BigUint64Array[]>(res => {
      resolveSnapshots = res;
    }));

    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    // First boundary step: the snapshot fetch starts and hangs unresolved.
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    // Second boundary step arrives while the first fetch is still in flight.
    // It must be a no-op — no overlapping fetch, no duplicate report.
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));

    expect(mocks.pool.getTelemetrySnapshots).toHaveBeenCalledTimes(1);

    resolveSnapshots([]);
    await new Promise(r => setImmediate(r));

    expect(mocks.setLatestWorkerTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.controller.reportNow).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('re-arms the single-flight guard after a snapshot failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.controller.tick.mockReturnValue(true);
    mocks.pool.getTelemetrySnapshots.mockRejectedValueOnce(new Error('snapshot timeout'));

    const bridge = new IpcBridge({ server: { port: 5555 } } as any);
    currentBridge = bridge;
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    // First boundary step: the fetch rejects, and the `finally` clears the
    // guard so later reports are not permanently disabled.
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    // Second boundary step: now the default fetch resolves.
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    await new Promise(r => setImmediate(r));

    expect(mocks.pool.getTelemetrySnapshots).toHaveBeenCalledTimes(2);
    expect(mocks.setLatestWorkerTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.controller.reportNow).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
