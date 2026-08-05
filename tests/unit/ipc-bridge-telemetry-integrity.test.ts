/**
 * ipc-bridge-telemetry-integrity.test.ts — Regression coverage for issue #185
 *
 * The step reply is serialized before the post-step telemetry block runs. A
 * telemetry failure (e.g. `recordMemory()` throwing, or the worker snapshot
 * fetch rejecting — deterministic in shared-memory mode, where workers blocked
 * in Atomics.wait can never service GET_TELEMETRY) must NOT discard the reply
 * of a step that already completed: the client would otherwise be told the
 * step failed and retry it, double-stepping the environments.
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
}));

import { IpcBridge } from '../../src/ipc/ipc-bridge';

describe('IpcBridge step reply integrity when telemetry fails (issue #185)', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  const stepResult = { observation: [], reward: 0.5, done: false, truncated: false, info: { tick: 5 } };

  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ server: { port: 5555 }, environment: { seed: 0 } });
    mocks.isTelemetryEnabled.mockReturnValue(true);
    mocks.pool.step.mockResolvedValue([stepResult]);
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

  it('skips the worker snapshot fetch in shared-memory mode', async () => {
    mocks.pool.isUsingSharedMemory.mockReturnValueOnce(true);

    await initAndStepAtBoundary(12365);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(mocks.pool.getTelemetrySnapshots).not.toHaveBeenCalled();
  });

  it('skips the telemetry block entirely when telemetry is disabled', async () => {
    mocks.isTelemetryEnabled.mockReturnValue(false);

    await initAndStepAtBoundary(12366);

    const response = lastSentResponse();
    expect(response.status).toBe('ok');
    expect(mocks.pool.getTelemetrySnapshots).not.toHaveBeenCalled();
    expect(mocks.gpReport).not.toHaveBeenCalled();
  });
});
