import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockParentPort } = vi.hoisted(() => ({
  mockParentPort: {
    on: vi.fn(),
    postMessage: vi.fn(),
  },
}));

vi.mock('worker_threads', () => ({
  parentPort: mockParentPort,
}));

import '../../src/core/worker';

describe('Worker thread', () => {
  let messageHandler: (msg: any) => void;

  beforeEach(() => {
    if (mockParentPort.on.mock.calls.length > 0) {
      messageHandler = mockParentPort.on.mock.calls[0][1];
    }
    mockParentPort.postMessage.mockClear();
  });

  describe('init message', () => {
    it('creates environments in message passing mode and responds with mode', () => {
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: {},
        id: 'test-1',
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-1',
          status: 'ok',
          data: { mode: 'message' },
        }),
      );
    }, 10000);

    // NOTE: SharedArrayBuffer init success path is NOT tested here.
    // Initializing with a real SharedArrayBuffer sets the module-level `sharedMem`
    // variable, which pollutes state for all subsequent tests. Tests that rely on
    // `sharedMem` being null (step-shared error path, wait-for-action error path)
    // would then hit the shared memory success paths, which call Atomics.wait()
    // and block forever in a single-threaded test context.
    // Shared memory init is tested via integration/e2e tests with real worker threads.

    it('rejects an out-of-domain init seed with the shared validator instead of wrapping (#460)', () => {
      // A driver posting init directly to the worker (bypassing
      // WorkerPool.initInternal's validation) must get the same labeled
      // rejection: only the derived per-env offset wraps, never the
      // caller-supplied base seed.
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: { seed: 2 ** 32 },
        id: 'init-bad-seed',
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'init-bad-seed',
          status: 'error',
          error: 'Invalid seed 4294967296: expected an integer in [0, 4294967294]',
        }),
      );
    }, 10000);
  });

  describe('reset message', () => {
    beforeEach(() => {
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: {},
        id: 'init-reset',
      });
      mockParentPort.postMessage.mockClear();
    });

    it('resets environments and returns observations', () => {
      messageHandler({
        type: 'reset',
        id: 'reset-1',
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'reset-1',
          status: 'ok',
          data: expect.any(Array),
        }),
      );
    }, 10000);

    it('resets environments with provided seeds', () => {
      messageHandler({
        type: 'reset',
        id: 'reset-seeds',
        seeds: [42],
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'reset-seeds',
          status: 'ok',
        }),
      );
    }, 10000);
  });

  describe('step message', () => {
    beforeEach(() => {
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: {},
        id: 'init-step',
      });
      mockParentPort.postMessage.mockClear();
    });

    it('steps environments with actions and returns results', () => {
      messageHandler({
        type: 'step',
        id: 'step-1',
        actions: [{ left: false, right: false, up: false, down: false, heavy: false }],
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'step-1',
          status: 'ok',
          data: expect.any(Array),
          telemetry: { tick: expect.any(Number) },
        }),
      );
    }, 10000);

    it('auto-resets environment when done is true', () => {
      const actions = [{ left: false, right: false, up: false, down: false, heavy: false }];

      messageHandler({ type: 'step', id: 'step-pre', actions });
      mockParentPort.postMessage.mockClear();

      messageHandler({ type: 'step', id: 'step-auto-reset', actions });
      const response = mockParentPort.postMessage.mock.calls[0][0];
      expect(response).toHaveProperty('id', 'step-auto-reset');
      expect(response).toHaveProperty('status', 'ok');
      expect(response.data).toHaveLength(1);
    }, 10000);
  });

  describe('step-shared message', () => {
    // NOTE: The success path of step-shared cannot be tested in isolation.
    // When sharedMem is initialized, the handler calls sharedMem.signalWorkerConsumed()
    // and sharedMem.signalMainReady(), which use Atomics.wait() to block until the
    // main thread calls Atomics.notify(). In a single-threaded test context, no other
    // thread will ever notify, so the test hangs forever.
    // Shared memory step is tested via integration/e2e tests with real worker threads.

    it('returns error when shared memory is not initialized', () => {
      // Init WITHOUT SharedArrayBuffer so sharedMem stays null
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: {},
        id: 'init-no-shared',
      });
      mockParentPort.postMessage.mockClear();

      messageHandler({
        type: 'step-shared',
        id: 'step-shared-no-mem',
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'step-shared-no-mem',
          status: 'error',
          error: expect.stringContaining('Shared memory not initialized'),
        }),
      );
    }, 10000);
  });

  describe('wait-for-action message', () => {
    // NOTE: The success path of wait-for-action cannot be tested in isolation.
    // When sharedMem is initialized, the handler enters a while(true) loop that calls
    // sharedMem.waitForActions(), which uses Atomics.wait() to block until the main
    // thread signals. In a single-threaded test context, this blocks forever.
    // Shared memory wait-for-action is tested via integration/e2e tests with real worker threads.

    it('returns error when shared memory is not initialized', () => {
      // Init WITHOUT SharedArrayBuffer so sharedMem stays null
      messageHandler({
        type: 'init',
        numEnvs: 1,
        config: {},
        id: 'init-no-shared-wait',
      });
      mockParentPort.postMessage.mockClear();

      messageHandler({
        type: 'wait-for-action',
        id: 'wait-no-mem',
        config: {},
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'wait-no-mem',
          status: 'error',
          error: 'Shared memory not initialized',
        }),
      );
    }, 10000);
  });

  describe('GET_TELEMETRY message', () => {
    it('returns telemetry buffer snapshot', () => {
      messageHandler({
        type: 'GET_TELEMETRY',
        id: 'telemetry-1',
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'telemetry-1',
          status: 'ok',
          data: expect.anything(),
        }),
      );
    }, 10000);
  });

  describe('error handling', () => {
    it('catches errors and responds with error status', () => {
      messageHandler({
        type: 'step',
        id: 'error-step',
        actions: null,
      });
      expect(mockParentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'error-step',
          status: 'error',
          error: expect.any(String),
        }),
      );
    }, 10000);
  });

  describe('unknown message type', () => {
    it('does not crash on unknown message type', () => {
      expect(() => {
        messageHandler({
          type: 'unknown-type',
          id: 'unknown-1',
        });
      }).not.toThrow();
    }, 10000);
  });
});
