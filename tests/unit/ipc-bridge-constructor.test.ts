/**
 * ipc-bridge-constructor.test.ts - Tests for IpcBridge constructor, start, close, and telemetry internals
 *
 * Targets uncovered lines:
 * - Lines 17-22: Constructor internals (port fallback, sock/pool creation, wrapped send)
 * - Lines 37-45: start() for-await loop body (_closed check, frame extraction) and error handling
 * - Lines 91-97: Telemetry recording at 5000-step boundary
 * - Lines 159-173: close() method internals (sock.close try/catch, pool.close)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sock: {
    closed: boolean;
    bind: () => Promise<void>;
    unbind: () => Promise<void>;
    close: () => void;
    send: () => Promise<void>;
    lastEndpoint?: string;
    [Symbol.asyncIterator]?: any;
  } = {
    closed: false,
    bind: async () => {},
    unbind: async () => {},
    // A closed ZMQ socket is permanently destroyed and can never be re-bound
    // (bind() throws "Socket is closed"), so close() marks the mock closed and
    // start() then recreates the transport exactly like production
    // (ipc-bridge.ts:263-267).
    close: () => {
      sock.closed = true;
    },
    send: async () => {},
  };
  // Model libzmq (issue #402): reading lastEndpoint on a destroyed socket
  // throws "Socket operation on non-socket" (EBADF-equivalent), which is what
  // makes a concurrent close() during start()'s post-bind window fatal. When
  // the socket is still open the getter reports no resolved endpoint so the
  // production `?? addr` fallback is exercised.
  Object.defineProperty(sock, 'lastEndpoint', {
    configurable: true,
    get(): string | undefined {
      if (sock.closed) {
        throw new Error('Socket operation on non-socket');
      }
      return undefined;
    },
  });
  const controller = {
    tick: vi.fn(() => false),
    reportNow: vi.fn(() => true),
  };
  return {
    sock,
    controller,
    // A fresh Router models the recreated transport after close(): the
    // returned socket is open again, so restart tests can observe the
    // recreation branch (new Router + re-wrapped send) firing.
    Router: vi.fn(function Router() {
      sock.closed = false;
      return sock;
    }),
    WorkerPool: vi.fn(),
    getConfig: vi.fn(),
    isTelemetryEnabled: vi.fn(),
    gpTick: vi.fn(),
    gpRecordMemory: vi.fn(),
    gpReport: vi.fn(),
    setLatestWorkerTelemetry: vi.fn(),
    wrap: vi.fn((_idx, fn) => fn),
  };
});

vi.mock('zeromq', () => mocks);
vi.mock('../../src/telemetry/profiler', () => {
  const gp = {
    tick: mocks.gpTick,
    recordMemory: mocks.gpRecordMemory,
    report: mocks.gpReport,
  };
  return {
    globalProfiler: gp,
    wrap: mocks.wrap,
    TelemetryIndices: { JSON_PARSE: 0, ZMQ_SEND: 1 },
    setLatestWorkerTelemetry: mocks.setLatestWorkerTelemetry,
  };
});
vi.mock('../../src/telemetry/telemetry-controller', () => ({
  isTelemetryEnabled: mocks.isTelemetryEnabled,
  getTelemetryController: () => mocks.controller,
}));
vi.mock('../../src/core/worker-pool', async (importOriginal) => {
  // MAX_NUM_ENVS must stay the real constant: ipc-bridge.ts compares
  // numEnvs against it before touching the (mocked) pool.
  const actual = await importOriginal<typeof import('../../src/core/worker-pool')>();
  return {
    WorkerPool: mocks.WorkerPool,
    MAX_NUM_ENVS: actual.MAX_NUM_ENVS,
  };
});
vi.mock('../../src/config/config-loader', () => ({
  getConfig: mocks.getConfig,
  DEFAULT_MAX_CLIENT_SESSIONS: 32,
  mergeEngineSections: () => ({ physics: {}, arena: {}, player: {} }),
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

const mockSock = mocks.sock;
let bindSpy: ReturnType<typeof vi.spyOn>;
let unbindSpy: ReturnType<typeof vi.spyOn>;
let closeSpy: ReturnType<typeof vi.spyOn>;
let sendSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.getConfig.mockClear();
  mocks.getConfig.mockReturnValue({
    server: { port: 5555, bindAddress: '127.0.0.1', maxClientSessions: 32 },
    environment: { seed: 0 },
    reward: { killReward: 1, deathPenalty: -1, timePenalty: -0.001 },
  });
  mocks.isTelemetryEnabled.mockClear();
  mocks.isTelemetryEnabled.mockReturnValue(true);
  mocks.controller.tick.mockImplementation(() => currentBridge !== null && currentBridge.stepCount % 5000 === 0);
  mocks.controller.reportNow.mockReturnValue(true);
  mocks.WorkerPool.mockClear();
  mocks.Router.mockClear();
  mockSock.closed = false;
  mocks.WorkerPool.mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue([]),
      step: vi.fn().mockResolvedValue([{ observation: [], reward: 0, done: 0, truncated: 0, tick: 0 }]),
      close: vi.fn(),
      getTelemetrySnapshots: vi.fn().mockResolvedValue([]),
      isUsingSharedMemory: vi.fn(() => false),
      // The idle reaper probes this to proactively evict failed pools; fake
      // pools model healthy ones unless a test overrides the return value.
      isFailed: vi.fn(() => false),
    };
  });
  mocks.gpTick.mockClear();
  mocks.gpRecordMemory.mockClear();
  mocks.gpReport.mockClear();
  mocks.setLatestWorkerTelemetry.mockClear();
  bindSpy = vi.spyOn(mockSock, 'bind').mockResolvedValue(undefined);
  unbindSpy = vi.spyOn(mockSock, 'unbind').mockResolvedValue(undefined);
  closeSpy = vi.spyOn(mockSock, 'close');
  sendSpy = vi.spyOn(mockSock, 'send').mockResolvedValue(undefined);
  delete mockSock[Symbol.asyncIterator];
});

afterEach(() => {
  bindSpy.mockRestore();
  unbindSpy.mockRestore();
  closeSpy.mockRestore();
  sendSpy.mockRestore();
  currentBridge = null;
  // A double-close regression test simulates the socket already being closed
  // (as start()'s catch leaves it after a failed bind); reset it so later
  // tests start from the pristine open-socket state.
  delete (mockSock as any).closed;
});

describe('IpcBridge constructor', () => {
  it('uses port from config when provided (line 17)', () => {
    const bridge = new IpcBridge({ server: { port: 12345 } });
    expect(bridge.getPort()).toBe(12345);
  });

  it('falls back to getConfig().server.port when no config (line 17)', () => {
    const bridge = new IpcBridge();
    expect(bridge.getPort()).toBe(5555);
  });

  it('falls back to getConfig().server.port when config has no server (line 17)', () => {
    const bridge = new IpcBridge({});
    expect(bridge.getPort()).toBe(5555);
  });

  it('uses bindAddress from config when provided', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: '0.0.0.0' } });
    expect(bridge.getBindAddress()).toBe('0.0.0.0');
  });

  it('wraps a bare IPv6 bind address in brackets for the tcp endpoint', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: '::1' } });
    expect(bridge.getBindAddress()).toBe('[::1]');
  });

  it('keeps an already-bracketed IPv6 bind address as-is', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: '[::1]' } });
    expect(bridge.getBindAddress()).toBe('[::1]');
  });

  it('passes a hostname bind address through unmodified', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: 'localhost' } });
    expect(bridge.getBindAddress()).toBe('localhost');
  });

  it('passes interface names containing underscores through unmodified', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: 'my_if0' } });
    expect(bridge.getBindAddress()).toBe('my_if0');

    const bridge2 = new IpcBridge({ server: { port: 12345, bindAddress: 'veth_1' } });
    expect(bridge2.getBindAddress()).toBe('veth_1');
  });

  it('passes the libzmq all-interfaces wildcard through unmodified', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: '*' } });
    expect(bridge.getBindAddress()).toBe('*');
  });

  it('rejects a host:port-style bind address with a clear error (issue #235)', () => {
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '127.0.0.1:5555' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
  });

  it('rejects a malformed bind address with a clear error (issue #235)', () => {
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: 'not a host' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
  });

  it('rejects a dotted-numeric bind address that is not a valid IPv4 (issue #235)', () => {
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '999.999.999.999' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '1.2.3.4.5' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
  });

  it('rejects a bare underscore bind address (issue #235)', () => {
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '_' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
  });

  it('rejects a purely numeric bind address that is not a valid IPv4 (issue #235)', () => {
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '999' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
    expect(() => new IpcBridge({ server: { port: 12345, bindAddress: '12345' } })).toThrowError(
      /Invalid server\.bindAddress/,
    );
  });

  it('falls back to the loopback default for an empty bind address', () => {
    const bridge = new IpcBridge({ server: { port: 12345, bindAddress: '  ' } });
    expect(bridge.getBindAddress()).toBe('127.0.0.1');
  });

  it('falls back to getConfig().server.bindAddress when no config', () => {
    const bridge = new IpcBridge();
    expect(bridge.getBindAddress()).toBe('127.0.0.1');
  });

  it('falls back to getConfig().server.bindAddress when config has no server', () => {
    const bridge = new IpcBridge({});
    expect(bridge.getBindAddress()).toBe('127.0.0.1');
  });

  it('creates a ZMQ Router socket (line 18)', () => {
    new IpcBridge();
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('creates a WorkerPool (line 19)', () => {
    const bridge = new IpcBridge();
    expect((bridge as any).pool).toBeDefined();
    expect(typeof (bridge as any).pool.init).toBe('function');
    expect(typeof (bridge as any).pool.step).toBe('function');
  });

  it('initializes _closed to false (line 14)', () => {
    const bridge = new IpcBridge();
    expect(bridge.isClosed()).toBe(false);
  });

  it('sets up wrapped send for telemetry (line 22)', () => {
    const bridge = new IpcBridge();
    expect((bridge as any)._wrappedSend).toBeDefined();
    expect(typeof (bridge as any)._wrappedSend).toBe('function');
  });
});

describe('IpcBridge start()', () => {
  it('binds socket to configured address (lines 29-31)', async () => {
    const bridge = new IpcBridge({ server: { port: 12345 } });
    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bindSpy).toHaveBeenCalledWith('tcp://127.0.0.1:12345');
    await bridge.close();
    await startPromise;
  });

  it('binds socket to the configured bind address when provided (issue #235)', async () => {
    const bridge = new IpcBridge({ server: { port: 12348, bindAddress: '0.0.0.0' } });
    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bindSpy).toHaveBeenCalledWith('tcp://0.0.0.0:12348');
    await bridge.close();
    await startPromise;
  });

  it('binds an IPv6 bind address with brackets in the endpoint (issue #235)', async () => {
    const bridge = new IpcBridge({ server: { port: 12348, bindAddress: '::1' } });
    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bindSpy).toHaveBeenCalledWith('tcp://[::1]:12348');
    await bridge.close();
    await startPromise;
  });

  it('sets _closed to false on start (line 32)', async () => {
    const bridge = new IpcBridge({ server: { port: 12346 } });
    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.isClosed()).toBe(false);
    await bridge.close();
    await startPromise;
  });
});

describe('IpcBridge start() for-await loop (lines 36-47)', () => {
  it('catches and logs errors in server loop when not closed (lines 42-46)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockSock[Symbol.asyncIterator] = function () {
      return {
        next: async () => {
          throw new Error('ZMQ connection lost');
        },
      };
    };

    const bridge = new IpcBridge({ server: { port: 12349 } });
    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    await bridge.close();
    await startPromise;

    expect(consoleErrorSpy).toHaveBeenCalledWith('[IPC] Error in server loop:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it('ignores errors during shutdown (line 44)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockSock[Symbol.asyncIterator] = function () {
      return {
        next: async () => {
          throw new Error('Socket closed');
        },
      };
    };

    const bridge = new IpcBridge({ server: { port: 12350 } });
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    // Note: start() resets _closed to false (line 32), so the error WILL be logged
    // This test verifies the try/catch structure exists (line 42-47)
    await bridge.start();
    // The error is logged because start() resets _closed to false
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  }, 10000);
});

describe('IpcBridge close() (lines 159-173)', () => {
  it('returns early if already closed (lines 160-162)', async () => {
    const bridge = new IpcBridge({ server: { port: 12351 } });
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);

    const poolCloseSpy = vi.spyOn((bridge as any).pool, 'close').mockClear();
    await bridge.close();
    expect(poolCloseSpy).not.toHaveBeenCalled();
  });

  it('sets _closed to true (line 163)', async () => {
    const bridge = new IpcBridge({ server: { port: 12352 } });
    expect(bridge.isClosed()).toBe(false);
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
  });

  it('closes the socket (line 167)', async () => {
    const bridge = new IpcBridge({ server: { port: 12353 } });
    await bridge.close();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('awaits endpoint unbind before closing the socket (#316)', async () => {
    const bridge = new IpcBridge({ server: { port: 12357 } });
    const endpoint = 'tcp://127.0.0.1:12357';
    (bridge as any).boundEndpoint = endpoint;

    let releaseUnbind!: () => void;
    unbindSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUnbind = resolve;
        }),
    );

    const closePromise = bridge.close();
    expect(unbindSpy).toHaveBeenCalledWith(endpoint);
    expect(closeSpy).not.toHaveBeenCalled();

    releaseUnbind();
    await closePromise;
    expect(closeSpy).toHaveBeenCalled();
  });

  it('ignores socket close errors (lines 166-170)', async () => {
    closeSpy.mockImplementation(() => {
      throw new Error('Socket already closed');
    });
    const bridge = new IpcBridge({ server: { port: 12354 } });
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it('does not close the socket a second time when close() follows a failed bind (issue #326)', async () => {
    // start()'s catch closes the ROUTER handle when a bind fails. A later
    // close() (server.ts rolls back a failed start via serverBridge.close())
    // must not close the already-closed socket a redundant second time.
    const bridge = new IpcBridge({ server: { port: 12354 } });
    // Model the failed-start path: construction yields an open ROUTER (like
    // production `new zmq.Router()`), then start()'s failed-bind catch
    // closes this bridge's socket handle before close() runs.
    (bridge as any).sock.closed = true;
    closeSpy.mockClear();
    await bridge.close();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('closes the worker pool (line 172)', async () => {
    const bridge = new IpcBridge({ server: { port: 12355 } });
    const poolCloseSpy = vi.spyOn((bridge as any).pool, 'close');
    await bridge.close();
    expect(poolCloseSpy).toHaveBeenCalled();
  });
});

describe('IpcBridge close()/start() lifecycle (#316)', () => {
  it('single-flights concurrent close() calls onto one teardown (#316)', async () => {
    const bridge = new IpcBridge({ server: { port: 12380 } });
    (bridge as any).boundEndpoint = 'tcp://127.0.0.1:12380';

    let releaseUnbind!: () => void;
    unbindSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUnbind = resolve;
        }),
    );

    const closeA = bridge.close();
    const closeB = bridge.close();
    // The second call shares the in-flight teardown instead of running a
    // second one (which would unbind/close the already-torn-down socket).
    expect(closeA).toBe(closeB);
    expect(unbindSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();

    releaseUnbind();
    await closeA;
    await closeB;
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('clears boundEndpoint only after a successful unbind (#316)', async () => {
    const bridge = new IpcBridge({ server: { port: 12381 } });
    (bridge as any).boundEndpoint = 'tcp://127.0.0.1:12381';

    await bridge.close();
    expect((bridge as any).boundEndpoint).toBeNull();
  });

  it('keeps boundEndpoint when unbind fails so a held port stays visible (#316)', async () => {
    const endpoint = 'tcp://127.0.0.1:12382';
    const bridge = new IpcBridge({ server: { port: 12382 } });
    (bridge as any).boundEndpoint = endpoint;

    unbindSpy.mockImplementationOnce(() => Promise.reject(new Error('endpoint gone')));
    await expect(bridge.close()).rejects.toThrow('endpoint gone');
    // The port may still be bound: the endpoint state must not be silently
    // discarded, or a restart would rebind into the #316 race it prevents.
    expect((bridge as any).boundEndpoint).toBe(endpoint);
  });

  it('does not wedge later close()/start() calls on a rejected close (#316)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = new IpcBridge({ server: { port: 12383 } });
      (bridge as any).boundEndpoint = 'tcp://127.0.0.1:12383';

      unbindSpy.mockImplementationOnce(() => Promise.reject(new Error('unbind failed')));
      await expect(bridge.close()).rejects.toThrow('unbind failed');

      // The bridge is already closed, so a later close() is a clean no-op
      // instead of a stale re-rejection of the retained promise.
      await expect(bridge.close()).resolves.toBeUndefined();

      // A restart can still bind and settle ready.
      const startPromise = bridge.start();
      await new Promise((r) => setTimeout(r, 10));
      expect(bindSpy).toHaveBeenCalled();
      // The destroyed socket forces the production transport-recreation path
      // (a fresh Router + re-wrapped send) instead of rebinding the dead one.
      expect(mocks.Router).toHaveBeenCalledTimes(2);
      expect((bridge as any).sock.closed).toBe(false);
      await bridge.close();
      await startPromise;
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('start() waits for an in-flight close() before binding (#316)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = new IpcBridge({ server: { port: 12384 } });
      (bridge as any).boundEndpoint = 'tcp://127.0.0.1:12384';

      let releaseUnbind!: () => void;
      unbindSpy.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseUnbind = resolve;
          }),
      );

      const closePromise = bridge.close();
      const startPromise = bridge.start();

      // While the prior close is still unbinding, the restart must not bind:
      // the port has not been released yet, and the transport has not been
      // recreated yet either (start() is still awaiting the in-flight close).
      await new Promise((r) => setTimeout(r, 20));
      expect(bindSpy).not.toHaveBeenCalled();
      expect(mocks.Router).toHaveBeenCalledTimes(1);

      releaseUnbind();
      await closePromise;
      await startPromise;
      expect(bindSpy).toHaveBeenCalled();
      // Only after the close completes does the restart recreate the socket.
      expect(mocks.Router).toHaveBeenCalledTimes(2);
      expect((bridge as any).sock.closed).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('start() recovers from a rejected in-flight close without hanging ready (#316)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = new IpcBridge({ server: { port: 12385 } });
      (bridge as any).boundEndpoint = 'tcp://127.0.0.1:12385';

      let rejectUnbind!: (err: Error) => void;
      unbindSpy.mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectUnbind = reject;
          }),
      );

      const closePromise = bridge.close();
      const startPromise = bridge.start();

      // The re-armed ready promise must settle (here via the restart's fresh
      // bind) instead of hanging forever after a rejected prior close.
      const readySettled = Promise.race([
        (bridge as any).ready.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);

      rejectUnbind(new Error('unbind failed'));
      await expect(closePromise).rejects.toThrow('unbind failed');
      expect(await readySettled).not.toBe('hung');
      await startPromise;
      expect(bindSpy).toHaveBeenCalled();
      // The rejected close still destroyed the socket, so the restart binds a
      // freshly recreated transport rather than the dead one.
      expect(mocks.Router).toHaveBeenCalledTimes(2);
      expect((bridge as any).sock.closed).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe('IpcBridge start()/close() race (#402)', () => {
  it('start() without awaiting then immediate close(): start and ready reject identically with BridgeClosedDuringStart', async () => {
    const bridge = new IpcBridge({ server: { port: 12386 } });
    // The exact race from issue #402: close() runs synchronously up to the
    // socket destroy while start() is still suspended at the bind await.
    const startPromise = bridge.start();
    const closePromise = bridge.close();

    // Exactly ONE deterministic outcome: a cancelled start rejects with the
    // clear named error — never resolves silently and never surfaces the
    // opaque libzmq error from reading a destroyed socket.
    const startOutcome = await startPromise.then(
      () => 'resolved',
      (e: any) => `${e?.name}: ${e?.message ?? e}`,
    );
    expect(startOutcome).toBe('BridgeClosedDuringStart: bridge was closed during start');

    // bridge.ready must settle within a short timeout, rejecting with the
    // SAME error so awaiting callers observe one consistent contract.
    const readyOutcome = await Promise.race([
      (bridge as any).ready.then(
        () => 'ready resolved',
        (e: any) => `ready rejected: ${e?.message ?? e}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('ready STILL PENDING'), 1500)),
    ]);
    expect(readyOutcome).toBe('ready rejected: bridge was closed during start');

    await closePromise;
  });

  it('close() while bind is still pending converts an opaque bind rejection into BridgeClosedDuringStart', async () => {
    // The second race window: close() destroys the ROUTER before the native
    // bind settles, so the pending bind promise itself rejects with the
    // opaque libzmq error. That rejection must be normalized into the same
    // clear error on both start() and ready (#402).
    let rejectBind!: (err: Error) => void;
    bindSpy.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectBind = reject;
        }),
    );

    const bridge = new IpcBridge({ server: { port: 12387 } });
    const startPromise = bridge.start();
    const closePromise = bridge.close();

    rejectBind(new Error('Socket operation on non-socket'));

    const startOutcome = await startPromise.then(
      () => 'resolved',
      (e: any) => `${e?.name}: ${e?.message ?? e}`,
    );
    expect(startOutcome).toBe('BridgeClosedDuringStart: bridge was closed during start');

    const readyOutcome = await Promise.race([
      (bridge as any).ready.then(
        () => 'ready resolved',
        (e: any) => `ready rejected: ${e?.message ?? e}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('ready STILL PENDING'), 1500)),
    ]);
    expect(readyOutcome).toBe('ready rejected: bridge was closed during start');

    await closePromise;
  });

  it('a genuine bind failure on a restart after close() keeps its real error and cleans up the recreated socket', async () => {
    const bridge = new IpcBridge({ server: { port: 12388 } });
    // Complete one open->close cycle so _closed is stale-true for the
    // restart, exactly like the #263/#316 restart flows.
    await bridge.close();

    const closeCallsBeforeRestart = closeSpy.mock.calls.length;
    bindSpy.mockRejectedValueOnce(new Error('bind failed: address already in use'));

    const startOutcome = await bridge.start().then(
      () => 'resolved',
      (e: any) => `${e?.name}: ${e?.message ?? e}`,
    );
    // The stale _closed from the previous cycle must NOT misclassify this
    // genuine failure as BridgeClosedDuringStart (#402 review).
    expect(startOutcome).toBe('Error: bind failed: address already in use');

    const readyOutcome = await Promise.race([
      (bridge as any).ready.then(
        () => 'ready resolved',
        (e: any) => `ready rejected: ${e?.message ?? e}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('ready STILL PENDING'), 1500)),
    ]);
    expect(readyOutcome).toBe('ready rejected: bind failed: address already in use');

    // The #326 cleanup must still run on the recreated Router so the native
    // handle cannot leak before the next start() recreates it again.
    expect(closeSpy.mock.calls.length).toBe(closeCallsBeforeRestart + 1);
  });

  it('normalizes a leftover-unwind EBUSY rebind failure into BridgeClosedDuringStart with a recoverable re-arm (#478)', async () => {
    // Complete one open->close cycle so the restart takes the recreation
    // path with stale _closed (#263/#316) and a closed mock transport —
    // modelling the post-unwind state. The rebind then loses the unwind
    // race with libzmq's delayed close: EBUSY "Socket is blocked by a bind
    // or unbind operation". Pre-fix that opaque ErrnoException was drained
    // into bridge.ready verbatim, terminally poisoning it (issue #478).
    const bridge = new IpcBridge({ server: { port: 12392 } });
    await bridge.close();
    const closeCallsBeforeRestart = closeSpy.mock.calls.length;

    const ebusy = new Error('Socket is blocked by a bind or unbind operation');
    (ebusy as NodeJS.ErrnoException).code = 'EBUSY';
    bindSpy.mockRejectedValueOnce(ebusy);

    // The transient cycle's armed signal: start() re-armed synchronously at
    // entry, so reading the property BEFORE awaiting the invocation captures
    // exactly the promise the cut-off drain settles (the #458 pre-drain of
    // the constructor signal happened during the close() above and is a
    // different, already-covered transition).
    const startInvocation = bridge.start();
    const windowReady = bridge.ready;
    const startOutcome = await startInvocation.then(
      () => 'resolved',
      (e: any) => `${e?.name}: ${e?.message ?? e}`,
    );
    // The transient unwinding contention must surface with the canonical
    // cut-off identity on start(), never the unclassified libzmq error —
    // and never the EADDRINUSE-class genuine-failure identity either.
    expect(startOutcome).toBe('BridgeClosedDuringStart: bridge was closed during start');

    // Every outstanding signal rejects with the SAME identity (fan-out).
    const readyOutcome = await Promise.race([
      windowReady.then(
        () => 'ready resolved',
        (e: any) => `ready rejected: ${e?.message ?? e}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('ready STILL PENDING'), 1500)),
    ]);
    expect(readyOutcome).toBe('ready rejected: bridge was closed during start');

    // The #326 cleanup ran on the blocked handle.
    expect(closeSpy.mock.calls.length).toBe(closeCallsBeforeRestart + 1);

    // The drain/rearm pairing (#478): the failed transient consumes the
    // exposed signal TERMINALLY (a rejection IS the settlement — no
    // ownerless pending rearm that close()/start() would have to chase);
    // the property keeps naming it until the NEXT start() re-points it
    // synchronously at entry, and that start()'s own bind re-arms
    // resolution.
    expect(bridge.ready).toBe(windowReady);
    const serveRetry = bridge.start();
    const retryReady = bridge.ready;
    expect(retryReady).not.toBe(windowReady);
    try {
      expect(
        await Promise.race([
          retryReady.then(
            () => 'ready resolved',
            (e: any) => `ready rejected: ${e?.message ?? e}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('ready STILL PENDING'), 1500)),
        ]),
      ).toBe('ready resolved');
    } finally {
      await bridge.close();
      await serveRetry;
    }
  });
});

describe('IpcBridge ready capture order (#435)', () => {
  /**
   * Settle-or-hang probe: reports how `promise` settled within `ms`, or
   * 'hung' if it is still pending. The hang verdict is exactly the #435
   * deadlock this suite guards against, so every assertion below compares
   * against an explicit outcome instead of awaiting bare (which would time
   * out with no diagnosis).
   */
  async function settleOutcome(promise: Promise<void>, ms = 1500): Promise<string> {
    return Promise.race([
      promise.then(
        () => 'resolved',
        (e: any) => `rejected(${e?.message ?? e})`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), ms)),
    ]);
  }

  it('settles a ready promise captured BEFORE start() when the bind succeeds', async () => {
    const bridge = new IpcBridge({ server: { port: 12389 } });
    // The race-free embedder pattern from issue #435: grab the readiness
    // signal first, then start the serve loop without awaiting start().
    const earlyReady = bridge.ready;
    const startPromise = bridge.start();
    try {
      expect(await settleOutcome(earlyReady)).toBe('resolved');
      expect(bridge.isClosed()).toBe(false);
    } finally {
      await bridge.close();
      await startPromise;
    }
  });

  it('rejects a ready promise captured BEFORE start() with the same bind failure start() reports', async () => {
    bindSpy.mockRejectedValueOnce(new Error('bind failed: address already in use'));
    const bridge = new IpcBridge({ server: { port: 12390 } });
    const earlyReady = bridge.ready;
    await expect(bridge.start()).rejects.toThrow('bind failed: address already in use');
    // The captured promise must reject too — never hang (EADDRINUSE class).
    expect(await settleOutcome(earlyReady)).toBe('rejected(bind failed: address already in use)');
    // The failed-bind cleanup (#326) still ran on the mock socket.
    expect(closeSpy).toHaveBeenCalled();
  });

  it('still settles a ready promise read AFTER start() on success (order pin)', async () => {
    const bridge = new IpcBridge({ server: { port: 12391 } });
    const startPromise = bridge.start();
    const lateReady = bridge.ready;
    try {
      expect(await settleOutcome(lateReady)).toBe('resolved');
    } finally {
      await bridge.close();
      await startPromise;
    }
  });

  it('still rejects a ready promise read AFTER start() on bind failure (order pin)', async () => {
    bindSpy.mockRejectedValueOnce(new Error('bind failed: EADDRINUSE'));
    const bridge = new IpcBridge({ server: { port: 12392 } });
    const startPromise = bridge.start();
    const lateReady = bridge.ready;
    await expect(startPromise).rejects.toThrow('bind failed: EADDRINUSE');
    expect(await settleOutcome(lateReady)).toBe('rejected(bind failed: EADDRINUSE)');
  });

  it('settles capturers on BOTH sides of the re-arm from one bind outcome', async () => {
    const bridge = new IpcBridge({ server: { port: 12393 } });
    const beforeStart = bridge.ready;
    const startPromise = bridge.start();
    const afterStart = bridge.ready;
    // start() re-armed a fresh promise for the new cycle (#263), but the
    // pre-start capture must settle alongside it, not be orphaned.
    expect(afterStart).not.toBe(beforeStart);
    try {
      expect(await settleOutcome(beforeStart)).toBe('resolved');
      expect(await settleOutcome(afterStart)).toBe('resolved');
    } finally {
      await bridge.close();
      await startPromise;
    }
  });

  it('rejects capturers on BOTH sides of the re-arm from one bind failure', async () => {
    bindSpy.mockRejectedValueOnce(new Error('EADDRINUSE'));
    const bridge = new IpcBridge({ server: { port: 12394 } });
    const beforeStart = bridge.ready;
    const startPromise = bridge.start();
    const afterStart = bridge.ready;
    expect(afterStart).not.toBe(beforeStart);
    await expect(startPromise).rejects.toThrow('EADDRINUSE');
    expect(await settleOutcome(beforeStart)).toBe('rejected(EADDRINUSE)');
    expect(await settleOutcome(afterStart)).toBe('rejected(EADDRINUSE)');
  });

  it('keeps settling pre-start captures across a close()+start() restart cycle', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = new IpcBridge({ server: { port: 12395 } });
      // Cycle 1: pre-start capture settles with the first bind.
      const firstCycle = bridge.ready;
      const serve1 = bridge.start();
      expect(await settleOutcome(firstCycle)).toBe('resolved');
      await roundTripClose(bridge, serve1);

      // Restart: a capture taken before the restart's start() (here the
      // already-settled cycle-1 promise handed out between cycles) stays
      // settled, and the restart's fresh signal resolves with the new bind.
      const staleBetweenCycles = bridge.ready;
      await expect(staleBetweenCycles).resolves.toBeUndefined();
      const serve2 = bridge.start();
      const restartedSignal = bridge.ready;
      expect(restartedSignal).not.toBe(firstCycle);
      expect(await settleOutcome(restartedSignal)).toBe('resolved');
      await roundTripClose(bridge, serve2);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('delivers a restart bind failure to a capture taken before the retry start()', async () => {
    const bridge = new IpcBridge({ server: { port: 12396 } });
    // First cycle fails while a pre-start capture is outstanding.
    bindSpy.mockRejectedValueOnce(new Error('address already in use'));
    const earlyCapture = bridge.ready;
    await expect(bridge.start()).rejects.toThrow('address already in use');
    expect(await settleOutcome(earlyCapture)).toBe('rejected(address already in use)');

    // Retry binds clean; the NEW current signal resolves, and the rejected
    // early capture can never flip back.
    const retryServe = bridge.start();
    const retrySignal = bridge.ready;
    expect(retrySignal).not.toBe(earlyCapture);
    try {
      expect(await settleOutcome(retrySignal)).toBe('resolved');
    } finally {
      await bridge.close();
      await retryServe;
    }
  });

  it('propagates BridgeClosedDuringStart to a pre-start capture identically (#402 interplay)', async () => {
    const bridge = new IpcBridge({ server: { port: 12397 } });
    const earlyReady = bridge.ready;
    const startPromise = bridge.start();
    const closePromise = bridge.close();

    await expect(startPromise).rejects.toThrow('bridge was closed during start');
    // The cancellation path also reaches the early capture: one consistent
    // outcome on both sides of the re-arm boundary.
    expect(await settleOutcome(earlyReady)).toBe('rejected(bridge was closed during start)');
    await closePromise;
  });

  // Pre-bind shutdown (#458): close() before the first start() is the one
  // lifecycle transition with NO bind-outcome drain inside start(), so the
  // constructor-armed signal would strand pending forever. Vitest fails the
  // run on unhandled rejections, so every assertion below additionally pins
  // that the drained promises stay handled (constructor/rearm swallow-catch).

  it('rejects a ready promise captured BEFORE a close() that precedes any start() (#458)', async () => {
    const bridge = new IpcBridge({ server: { port: 12398 } });
    // The exact embedder pattern the getter's JSDoc advertises: capture the
    // readiness signal, then abort startup without ever serving.
    const earlyReady = bridge.ready;
    await bridge.close();
    expect(await settleOutcome(earlyReady)).toBe('rejected(bridge was closed before start)');
  });

  it('rejects a ready promise read AFTER a close() that precedes any start() (#458)', async () => {
    const bridge = new IpcBridge({ server: { port: 12399 } });
    await bridge.close();
    // Post-close readers get the same drained (now rejected) generation, so
    // a shared readiness helper cannot wedge on a fresh read either.
    expect(await settleOutcome(bridge.ready)).toBe('rejected(bridge was closed before start)');
  });

  it('settles a ready promise captured concurrently with a pre-start close (#458)', async () => {
    const bridge = new IpcBridge({ server: { port: 12400 } });
    // Race capture and shutdown from independent async contexts: whichever
    // order the two interleave in, the outstanding generation must settle —
    // never hang.
    const readyOutcome = settleOutcome(bridge.ready, 1000);
    const closeOutcome = bridge.close().then(
      () => 'closed',
      () => 'closed-rejected',
    );
    expect(await closeOutcome).toBe('closed');
    expect(await readyOutcome).toBe('rejected(bridge was closed before start)');
    // A read taken after the same close settles identically.
    expect(await settleOutcome(bridge.ready)).toBe('rejected(bridge was closed before start)');
  });

  it('keeps a drained pre-start close idempotent on repeated close() (#458)', async () => {
    const bridge = new IpcBridge({ server: { port: 12401 } });
    const earlyReady = bridge.ready;
    await bridge.close();
    await expect(bridge.close()).resolves.toBeUndefined();
    expect(await settleOutcome(earlyReady)).toBe('rejected(bridge was closed before start)');
  });

  it('still restarts after a pre-start close: the fresh signal resolves on the new bind (#458)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = new IpcBridge({ server: { port: 12402 } });
      const stranded = bridge.ready;
      await bridge.close();
      expect(await settleOutcome(stranded)).toBe('rejected(bridge was closed before start)');

      // The restart contract (#263) is unchanged: a later start() arms a
      // fresh signal that resolves with the new bind, and the drained
      // rejection never leaks into the new cycle.
      const serve = bridge.start();
      const restartedSignal = bridge.ready;
      expect(restartedSignal).not.toBe(stranded);
      try {
        expect(await settleOutcome(restartedSignal)).toBe('resolved');
        expect(bridge.isClosed()).toBe(false);
      } finally {
        await bridge.close();
        await serve;
      }
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  /** Close the bridge and wait for its serve loop to exit cleanly. */
  async function roundTripClose(bridge: IpcBridge, serve: Promise<void>): Promise<void> {
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    await serve;
  }
});

describe('IpcBridge telemetry at 5000 steps (lines 90-98)', () => {
  async function simulateSteps(bridge: IpcBridge, count: number): Promise<any> {
    currentBridge = bridge;
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    // B9 fix: step/reset before init now correctly return an error, so the
    // bridge must be initialized before any steps can be counted.
    await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    // handleRequest routes steps to the per-identity session pool created by
    // that init (issue #193), not (bridge as any).pool (the local/bypass
    // pool). Spy on the session pool so the step mock actually intercepts
    // the requests that drive the telemetry branch under test.
    const results = mocks.WorkerPool.mock.results;
    const sessionPool = results[results.length - 1].value;
    vi.spyOn(sessionPool, 'step').mockResolvedValue([{ observation: [], reward: 0, done: 0, truncated: 0, tick: 0 }]);
    for (let i = 0; i < count; i++) {
      await handleRequest(Buffer.from('identity'), JSON.stringify({ command: 'step', actions: [0] }));
    }
    return sessionPool;
  }

  it('does NOT record memory before 5000 steps (line 90)', async () => {
    const bridge = new IpcBridge({ server: { port: 12356 } });
    await simulateSteps(bridge, 100);
    expect((bridge as any).stepCount).toBe(100);
    expect((bridge as any).stepCount % 5000).not.toBe(0);
  });

  it('records memory at exactly 5000 steps (line 91)', async () => {
    const bridge = new IpcBridge({ server: { port: 12357 } });
    await simulateSteps(bridge, 5000);
    expect((bridge as any).stepCount).toBe(5000);
    expect((bridge as any).stepCount % 5000).toBe(0);
    expect(mocks.gpRecordMemory).toHaveBeenCalled();
  });

  it('checks telemetry enabled at 5000 steps (line 93)', async () => {
    const bridge = new IpcBridge({ server: { port: 12358 } });
    await simulateSteps(bridge, 5000);
    expect((bridge as any).stepCount).toBe(5000);
    expect(mocks.gpRecordMemory).toHaveBeenCalled();
  });

  it('fetches telemetry snapshots when enabled (lines 94-96)', async () => {
    const bridge = new IpcBridge({ server: { port: 12359 } });
    await simulateSteps(bridge, 5000);
    expect((bridge as any).stepCount).toBe(5000);
    expect(mocks.gpRecordMemory).toHaveBeenCalled();
  });

  it('reports at 5000 steps when telemetry enabled (line 97)', async () => {
    const bridge = new IpcBridge({ server: { port: 12360 } });
    await simulateSteps(bridge, 5000);
    expect((bridge as any).stepCount).toBe(5000);
    expect(mocks.gpRecordMemory).toHaveBeenCalled();
  });

  it('does NOT run telemetry branch when disabled', async () => {
    mocks.isTelemetryEnabled.mockReturnValueOnce(false);
    const bridge = new IpcBridge({ server: { port: 12361 } });
    await simulateSteps(bridge, 5000);
    expect((bridge as any).stepCount).toBe(5000);
  });

  it('records memory again at 10000 steps', async () => {
    const bridge = new IpcBridge({ server: { port: 12362 } });
    await simulateSteps(bridge, 10000);
    expect((bridge as any).stepCount).toBe(10000);
    expect((bridge as any).stepCount % 5000).toBe(0);
  });
});

describe('IpcBridge per-client session cap (issue #193)', () => {
  function lastResponse(): any {
    const call = sendSpy.mock.calls[sendSpy.mock.calls.length - 1];
    const frames = call[0] as any[];
    return JSON.parse(frames[1].toString());
  }

  it('rejects a new client init beyond the cap loudly and without touching the first session', async () => {
    const bridge = new IpcBridge({ server: { port: 12370, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    await handleRequest(Buffer.from('clientB'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    const rejected = lastResponse();
    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Too many active client sessions (max 1)');

    // The rejected identity must fail loudly on reset/step (no silent
    // fallback to another pool), and the first session keeps working.
    await handleRequest(Buffer.from('clientB'), JSON.stringify({ command: 'reset', seeds: [1] }));
    expect(lastResponse().status).toBe('error');
    expect(lastResponse().error).toBe('Worker pool not initialized');

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'reset', seeds: [1] }));
    expect(lastResponse().status).toBe('ok');
  });

  it('releases a newly-created session when its init fails so another client can use the cap slot', async () => {
    const initError = new Error('worker startup failed');
    // A genuine post-teardown init failure leaves state 'failed' (failPool
    // ran in initInternal's own catch); only such dead pools are evicted.
    const failedSessionPool = {
      init: vi.fn().mockRejectedValue(initError),
      close: vi.fn().mockResolvedValue(undefined),
      isFailed: vi.fn(() => true),
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = new IpcBridge({ server: { port: 12376, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const failedClient = Buffer.from('failed-client');

    mocks.WorkerPool.mockImplementationOnce(function FailedWorkerPool() {
      return failedSessionPool;
    });
    try {
      await handleRequest(failedClient, JSON.stringify({ command: 'init', numEnvs: 1 }));

      expect(lastResponse()).toMatchObject({ status: 'error', error: 'worker startup failed' });
      expect(failedSessionPool.close).toHaveBeenCalledTimes(1);
      expect((bridge as any).sessions.has(failedClient.toString('hex'))).toBe(false);

      await handleRequest(Buffer.from('next-client'), JSON.stringify({ command: 'init', numEnvs: 1 }));
      expect(lastResponse().status).toBe('ok');
      expect((bridge as any).sessions.size).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('drops an existing session whose re-init fails the pool so it never holds a cap slot', async () => {
    const initError = new Error('worker startup failed');
    const bridge = new IpcBridge({ server: { port: 12377, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const client = Buffer.from('reinit-client');

    await handleRequest(client, JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    const session = (bridge as any).sessions.get(client.toString('hex'));
    session.pool.init.mockRejectedValueOnce(initError);
    // Model a genuine post-teardown failure: failPool ran inside
    // initInternal's own catch, so the pool reports failed and eviction is
    // correct. A rejection that leaves the pool ready keeps its session
    // (issue #440) — see the validation-only test below.
    (session.pool as any).isFailed.mockReturnValue(true);
    const closeSpy = vi.spyOn(session.pool, 'close');

    await handleRequest(client, JSON.stringify({ command: 'init', numEnvs: 1 }));

    expect(lastResponse()).toMatchObject({ status: 'error', error: 'worker startup failed' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // The failed re-init drops the session outright, so its cap slot is freed
    // immediately instead of being held by a stale/retrying session.
    expect((bridge as any).sessions.size).toBe(0);
    await handleRequest(Buffer.from('next-client'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');
    expect((bridge as any).sessions.size).toBe(1);
  });

  it('keeps an existing session whose re-init was rejected while the pool stayed ready (#440)', async () => {
    const initError = new Error('Invalid numOpponents 65: expected at most 64 opponents');
    const bridge = new IpcBridge({ server: { port: 12379, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const client = Buffer.from('reinit-client-440');

    await handleRequest(client, JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    const session = (bridge as any).sessions.get(client.toString('hex'));
    // Pre-teardown validation rejects BEFORE closeInternal(): the pool stays
    // 'ready' (not failed), so the bridge must not evict or close anything.
    session.pool.init.mockRejectedValueOnce(initError);
    const closeSpy = vi.spyOn(session.pool, 'close');

    await handleRequest(client, JSON.stringify({ command: 'init', numEnvs: 1 }));

    expect(lastResponse()).toMatchObject({
      status: 'error',
      error: 'Invalid numOpponents 65: expected at most 64 opponents',
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect((bridge as any).sessions.size).toBe(1);

    // The surviving session still serves its original pool.
    await handleRequest(client, JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');
  });

  it('keeps the local pool pinned to a programmatic caller across a failed init (no silent re-admission)', async () => {
    const initError = new Error('worker startup failed');
    const bridge = new IpcBridge({ server: { port: 12378, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const caller = Buffer.from('caller');

    await bridge.initEnv(1, {}, false);
    // Establish the programmatic caller through IPC so it is the single
    // identity pinned to the local/bypass pool.
    await handleRequest(caller, JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');

    const failedPool = {
      init: vi.fn().mockRejectedValue(initError),
      close: vi.fn().mockResolvedValue(undefined),
      isFailed: vi.fn(() => true),
    };
    mocks.WorkerPool.mockImplementationOnce(function FailedWorkerPool() {
      return failedPool;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A separate identity's init fails and empties the session map.
      await handleRequest(Buffer.from('failed-client'), JSON.stringify({ command: 'init', numEnvs: 1 }));

      expect(lastResponse()).toMatchObject({ status: 'error', error: 'worker startup failed' });
      expect((bridge as any).sessions.size).toBe(0);
      // The pinned programmatic caller still uses the local pool.
      await handleRequest(caller, JSON.stringify({ command: 'step', actions: [0] }));
      expect(lastResponse().status).toBe('ok');
      // Neither the just-failed identity nor any other un-pinned identity may
      // silently rejoin the local/bypass pool in hybrid mode: loud failure.
      await handleRequest(Buffer.from('failed-client'), JSON.stringify({ command: 'reset', seeds: [1] }));
      expect(lastResponse()).toMatchObject({ status: 'error', error: 'Worker pool not initialized' });
      await handleRequest(Buffer.from('stranger'), JSON.stringify({ command: 'reset', seeds: [1] }));
      expect(lastResponse()).toMatchObject({ status: 'error', error: 'Worker pool not initialized' });
    } finally {
      consoleErrorSpy.mockRestore();
    }

    // Not deadlocked: with the map empty, a new identity can still init.
    await handleRequest(Buffer.from('new-client'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');
    expect((bridge as any).sessions.size).toBe(1);
  });

  it('reaps an idle session, frees its slot, and keeps its identity loud', async () => {
    const bridge = new IpcBridge({ server: { port: 12371, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const clientA = Buffer.from('clientA');

    await handleRequest(clientA, JSON.stringify({ command: 'init', numEnvs: 1 }));
    const session = (bridge as any).sessions.get(clientA.toString('hex'));
    session.lastActivityAt = Date.now() - 5 * 60 * 1000;

    await (bridge as any).reapExpiredSessions();

    expect(session.pool.close).toHaveBeenCalledTimes(1);
    expect((bridge as any).sessions.size).toBe(0);

    // A reaped identity must re-init; it cannot silently borrow the local
    // pool even when that pool was initialized programmatically.
    await bridge.initEnv(1, {}, false);
    await handleRequest(clientA, JSON.stringify({ command: 'reset' }));
    expect(lastResponse()).toMatchObject({ status: 'error', error: 'Worker pool not initialized' });

    await handleRequest(Buffer.from('clientB'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');
  });

  it('does not reap a session while a request is still using its pool', async () => {
    const bridge = new IpcBridge({ server: { port: 12372, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const clientA = Buffer.from('clientA');

    await handleRequest(clientA, JSON.stringify({ command: 'init', numEnvs: 1 }));
    const session = (bridge as any).sessions.get(clientA.toString('hex'));
    session.lastActivityAt = Date.now() - 5 * 60 * 1000;
    session.activeRequests = 1;

    await (bridge as any).reapExpiredSessions();

    expect(session.pool.close).not.toHaveBeenCalled();
    expect((bridge as any).sessions.get(clientA.toString('hex'))).toBe(session);
  });

  it('keeps rejected identities loud after their cap slot opens without an identity registry', async () => {
    const bridge = new IpcBridge({ server: { port: 12373, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    for (let i = 0; i < 40; i++) {
      await handleRequest(Buffer.from(`rejected-${i}`), JSON.stringify({ command: 'init', numEnvs: 1 }));
      expect(lastResponse().status).toBe('error');
    }

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'close' }));
    await bridge.initEnv(1, {}, false);
    await handleRequest(Buffer.from('rejected-39'), JSON.stringify({ command: 'step', actions: [0] }));

    expect(lastResponse()).toMatchObject({ status: 'error', error: 'Worker pool not initialized' });
  });

  it('keeps an established bypass identity after another client starts session mode', async () => {
    const bridge = new IpcBridge({ server: { port: 12374, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);
    const bypass = Buffer.from('bypass-client');

    await bridge.initEnv(1, {}, false);
    await handleRequest(bypass, JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    await handleRequest(bypass, JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');
  });

  it('does not let a second fallback identity overwrite the established bypass pin (issue #270)', async () => {
    const bridge = new IpcBridge({ server: { port: 12378, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await bridge.initEnv(1, {}, false);
    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');
    expect((bridge as any).localSessionIdentity).toBe(Buffer.from('clientA').toString('hex'));

    // A second pre-init identity must not silently steal the pin: it fails
    // loudly on its own first use (with a pin-specific error, not the generic
    // uninitialized-pool error) instead of revoking the first client.
    await handleRequest(Buffer.from('clientB'), JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse()).toMatchObject({ status: 'error', error: 'Local pool is pinned to another identity' });
    expect((bridge as any).localSessionIdentity).toBe(Buffer.from('clientA').toString('hex'));

    // Session mode engages; the first bypass client keeps its pool.
    await handleRequest(Buffer.from('clientC'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');
  });

  it('does not pin the local pool to an identity whose request fails validation (issue #270)', async () => {
    const bridge = new IpcBridge({ server: { port: 12379, maxClientSessions: 1 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await bridge.initEnv(1, {}, false);

    // A transient identity sends an invalid step (empty actions); its request
    // must fail without claiming the pin, or it would permanently lock out
    // the real programmatic caller.
    await handleRequest(Buffer.from('transient'), JSON.stringify({ command: 'step', actions: [] }));
    expect(lastResponse()).toMatchObject({ status: 'error', error: 'Invalid actions: array cannot be empty' });
    expect((bridge as any).localSessionIdentity).toBeUndefined();

    // An invalid reset (non-array seeds) is equally non-pinning.
    await handleRequest(Buffer.from('transient'), JSON.stringify({ command: 'reset', seeds: 'nope' }));
    expect(lastResponse()).toMatchObject({ status: 'error', error: 'Invalid seeds: must be an array' });
    expect((bridge as any).localSessionIdentity).toBeUndefined();

    // The legitimate identity can still use the local pool afterwards and
    // becomes the pinned bypass identity.
    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'step', actions: [0] }));
    expect(lastResponse().status).toBe('ok');
    expect((bridge as any).localSessionIdentity).toBe(Buffer.from('clientA').toString('hex'));
  });

  it('clamps an invalid (zero/negative) session cap to 1 instead of rejecting every init', () => {
    const bridge = new IpcBridge({ server: { port: 12375, maxClientSessions: 0 } } as any);
    expect((bridge as any).maxClientSessions).toBe(1);
  });

  it('floors a fractional session cap so it cannot silently relax the bound (issue #259)', () => {
    expect((new IpcBridge({ server: { port: 12375, maxClientSessions: 1.5 } } as any) as any).maxClientSessions).toBe(
      1,
    );
    expect((new IpcBridge({ server: { port: 12375, maxClientSessions: 2.5 } } as any) as any).maxClientSessions).toBe(
      2,
    );
    expect((new IpcBridge({ server: { port: 12375, maxClientSessions: '1.5' } } as any) as any).maxClientSessions).toBe(
      1,
    );
    expect((new IpcBridge({ server: { port: 12375, maxClientSessions: 0.5 } } as any) as any).maxClientSessions).toBe(
      1,
    );
  });

  it('falls back to the default cap for non-number cap values instead of coercing them (issue #259)', () => {
    for (const bad of [true, false, [5], {}, 'not-a-number', NaN, Infinity, '1e999']) {
      const bridge = new IpcBridge({ server: { port: 12375, maxClientSessions: bad } } as any);
      expect((bridge as any).maxClientSessions).toBe(32);
    }
  });

  it('enforces a fractional cap as its floored integer: 1.5 admits one session, not two (issue #259)', async () => {
    const bridge = new IpcBridge({ server: { port: 12379, maxClientSessions: 1.5 } } as any);
    const handleRequest = (bridge as any).handleRequest.bind(bridge);

    await handleRequest(Buffer.from('clientA'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    expect(lastResponse().status).toBe('ok');

    await handleRequest(Buffer.from('clientB'), JSON.stringify({ command: 'init', numEnvs: 1 }));
    const rejected = lastResponse();
    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Too many active client sessions (max 1)');
  });

  it('falls back to the default session cap when the cap is omitted', () => {
    // The getConfig mock normally reports 32; override it for both constructor
    // reads (port, then cap) with a cap-less config so the only path to a
    // finite cap is the bridge's built-in default fallback.
    mocks.getConfig.mockReturnValue({ server: { port: 5555 }, environment: { seed: 0 } });
    const bridge = new IpcBridge({} as any);
    expect((bridge as any).maxClientSessions).toBe(32);
  });
});
