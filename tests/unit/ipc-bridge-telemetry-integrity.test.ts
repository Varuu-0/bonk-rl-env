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
    isUsingSharedMemory: vi.fn(() => false),
  };
  return {
    sock,
    pool,
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
}));
vi.mock('../../src/core/worker-pool', () => ({
  WorkerPool: mocks.WorkerPool,
}));
vi.mock('../../src/config/config-loader', () => ({
  getConfig: mocks.getConfig,
  deepMerge: (base: Record<string, any>, override: Record<string, any>) => ({ ...base, ...override }),
  mergeEnvironmentConfig: (base: Record<string, any>, override: Record<string, any>) => ({ ...base, ...override }),
}));

import { IpcBridge } from '../../src/ipc/ipc-bridge';

describe('IpcBridge step reply integrity when telemetry fails (issue #185)', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  const stepResult = { observation: [], reward: 0.5, done: false, truncated: false, info: { tick: 5 } };

  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ server: { port: 5555 }, environment: { seed: 0 } });
    mocks.isTelemetryEnabled.mockReturnValue(true);
    mocks.pool.step.mockResolvedValue([stepResult]);
    mocks.pool.getTelemetrySnapshots.mockResolvedValue([]);
    sendSpy = vi.spyOn(mocks.sock, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    sendSpy.mockRestore();
  });

  async function initAndStepAtBoundary(port: number) {
    const bridge = new IpcBridge({ server: { port } } as any);
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

    await initAndStepAtBoundary(12364);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(response.data).toHaveLength(1);
    expect(response.data[0].reward).toBe(0.5);
    expect(mocks.pool.step).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('fetches telemetry snapshots in shared-memory mode without blocking (issue #240)', async () => {
    mocks.pool.isUsingSharedMemory.mockReturnValueOnce(true);

    await initAndStepAtBoundary(12365);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    // getTelemetrySnapshots is non-blocking in shared mode (it returns an
    // empty set immediately instead of waiting on unanswerable worker
    // messages), so the bridge always fetches instead of skipping.
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
});
