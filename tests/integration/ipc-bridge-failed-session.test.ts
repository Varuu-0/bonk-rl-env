/**
 * ipc-bridge-failed-session.test.ts — Regression coverage for issues #400 and #440
 *
 * When a client session's WorkerPool fails AFTER init (shared-memory step/reset
 * timeout, worker crash/exit, or a post-signal error), the pool transitions to
 * the failed state and can never serve again. handleRequest used to keep such a
 * session in `sessions`, so every later step/reset from that identity failed
 * with "worker pool is in failed state" and the dead session held a
 * maxClientSessions slot until the 5-minute idle reap. The fix mirrors the
 * init-failure cleanup: a step/reset failure that leaves the pool failed drops
 * the session and closes its pool, and a fresh init from the same identity
 * recreates a clean session without hitting the session cap.
 *
 * Review-hardening round:
 * - the session reaper now also drops failed-pool sessions proactively, so an
 *   async failure between requests frees its slot without waiting for the
 *   idle timeout or a retry to trigger the reactive drop;
 * - the adopted HOST session gets the same treatment: a dead host pool is
 *   closed and un-adopted (reactively and from the reaper) so sharing IPC
 *   clients recover with a plain re-init instead of staying wedged forever.
 *
 * Issue #440: an init failure that does NOT consume the pool must not evict
 * anything. WorkerPool.initInternal validates numOpponents BEFORE
 * closeInternal(), so a re-init rejected by that validation leaves the old
 * pool 'ready' with live workers — deleting the session and closing the pool
 * destroyed a healthy mid-episode environment over one bad request. Only a
 * genuinely failing init (post-teardown worker/env failure, state 'failed')
 * still takes the eviction path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { WorkerPool } from '../../src/core/worker-pool';
import { PortManager } from '../../src/utils/port-manager';
import { MAX_OPPONENTS } from '../../src/core/opponent-capacity';

// Fail fast with a clear message instead of hanging a whole suite when a
// reply never arrives (e.g. a regression that swallows a request).
const RECEIVE_TIMEOUT_MS = 10000;

async function sendCommand(client: zmq.Dealer, cmd: object): Promise<any> {
  await client.send(JSON.stringify(cmd));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      client.receive(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `sendCommand timed out after ${RECEIVE_TIMEOUT_MS}ms waiting for a reply to ${JSON.stringify(cmd)}`,
            ),
          );
        }, RECEIVE_TIMEOUT_MS);
        timer?.unref?.();
      }),
    ]);
    return JSON.parse(reply[0].toString());
  } finally {
    clearTimeout(timer);
  }
}

describe('IpcBridge drops sessions whose pool failed after init (issue #400)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;
  // The bridge keys sessions by the client's ZMQ routing identity in hex.
  const sessionKey = Buffer.from('failclient', 'utf8').toString('hex');

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 16200, endPort: 16299 });
    port = portManager.allocate();
    // A cap of 1 makes the freed-slot assertion exact: without the fix the
    // failed session keeps occupying the only slot and the fresh init fails.
    bridge = new IpcBridge({ server: { port, maxClientSessions: 1 } } as any);
    // start() runs the serve loop until close(), so do not await it. A
    // rejection handler is still required: on a bind failure start() rejects
    // and an unhandled rejection terminates the process on Node >=20 — the
    // real failure surfaces through `await bridge.ready` below (#252).
    void bridge.start().catch(() => {
      /* bind failures surface via bridge.ready */
    });

    client = new zmq.Dealer({ routingId: 'failclient' });
    await client.connect(`tcp://127.0.0.1:${port}`);
    // Await the bind signal instead of a fixed sleep: ready resolves once
    // the Router socket is bound and accepting connections (#263 contract).
    await bridge.ready;
  }, 30000);

  afterAll(async () => {
    try {
      client.close();
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

  function sessions(): Map<string, any> {
    return (bridge as any).sessions as Map<string, any>;
  }

  function init(useSharedMemory = true): Promise<any> {
    return sendCommand(client, { command: 'init', numEnvs: 1, useSharedMemory, config: {} });
  }

  it(
    'a step on a pool that failed after init errors AND removes the session, freeing the client-cap slot',
    { timeout: 60000 },
    async () => {
      const initResponse = await init();
      expect(initResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);

      // Force the pool into the failed state exactly as a shared-memory step
      // timeout / worker crash / post-signal error would (failPool -> 'failed').
      const session = sessions().get(sessionKey);
      await (session.pool as any).failPool(
        new Error('Shared-memory step timed out after 30000ms waiting for worker(s) 0'),
      );

      const stepResponse = await sendCommand(client, { command: 'step', actions: [0] });
      expect(stepResponse.status).toBe('error');
      expect(stepResponse.error).toContain('worker pool is in failed state');
      // The dead session must be dropped (and its pool closed), mirroring init-failure cleanup.
      expect(sessions().has(sessionKey)).toBe(false);

      // The single client-cap slot is now free: a fresh init from the same
      // identity succeeds. Before the fix this hit "Too many active client
      // sessions (max 1)" because the failed session never left the map.
      const reinitResponse = await init();
      expect(reinitResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);
    },
  );

  it('a reset on a pool that failed after init errors AND removes the session', { timeout: 60000 }, async () => {
    const initResponse = await init();
    expect(initResponse.status).toBe('ok');

    const session = sessions().get(sessionKey);
    await (session.pool as any).failPool(
      new Error('Shared-memory reset timed out after 30000ms waiting for worker(s) 0'),
    );

    const resetResponse = await sendCommand(client, { command: 'reset', seeds: [1] });
    expect(resetResponse.status).toBe('error');
    expect(resetResponse.error).toContain('worker pool is in failed state');
    expect(sessions().has(sessionKey)).toBe(false);
  });

  it('transient per-request errors do NOT drop a healthy session', { timeout: 60000 }, async () => {
    const initResponse = await init();
    expect(initResponse.status).toBe('ok');
    expect(sessions().has(sessionKey)).toBe(true);

    // A wrong-sized action batch is rejected before touching the pool: the
    // pool stays ready, so the session must remain mapped.
    const badStep = await sendCommand(client, { command: 'step', actions: [0, 0] });
    expect(badStep.status).toBe('error');
    expect(badStep.error).toContain('expected 1 action for 1 environment, got 2');
    expect(sessions().has(sessionKey)).toBe(true);
    expect((sessions().get(sessionKey).pool as any).isFailed()).toBe(false);

    // The session is still fully usable.
    const stepResponse = await sendCommand(client, { command: 'step', actions: [0] });
    expect(stepResponse.status).toBe('ok');
  });

  it(
    'the reaper proactively drops an asynchronously failed session without waiting for idle or a retry',
    { timeout: 60000 },
    async () => {
      const initResponse = await init();
      expect(initResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);

      // A healthy, non-idle session must survive a reap pass untouched: only
      // failed pools get proactive eviction.
      await (bridge as any).reapExpiredSessions();
      expect(sessions().has(sessionKey)).toBe(true);

      // Async failure between requests (worker crash/exit): no request ever
      // arrives to trigger the reactive drop, yet the cap slot must be freed
      // by the next reap pass instead of waiting out the 5-minute idle reap.
      const session = sessions().get(sessionKey);
      await (session.pool as any).failPool(new Error('worker exited unexpectedly between requests'));

      await (bridge as any).reapExpiredSessions();
      expect(sessions().has(sessionKey)).toBe(false);

      // The freed slot serves a fresh init right away.
      const reinitResponse = await init();
      expect(reinitResponse.status).toBe('ok');
    },
  );
});

describe('IpcBridge recovers sharing clients from a dead adopted host pool (issue #400 review)', () => {
  /**
   * Spin up a bridge that hosts an adopted env-owned WorkerPool and connect a
   * DEALER client to it. Returns everything needed to drive the scenario;
   * callers must close the client/bridge afterwards.
   */
  async function startHostBridge(
    routingId: string,
    port: number,
    adoptOptions: { onHostPoolFailed?: (pool: WorkerPool) => void } = {},
  ): Promise<{ bridge: IpcBridge; client: zmq.Dealer; pool: WorkerPool }> {
    const pool = new WorkerPool();
    await pool.init(1, {}, false);
    const bridge = new IpcBridge({ server: { port } } as any);
    bridge.adoptPool(pool, 1, { config: {}, useSharedMemory: false, ...adoptOptions });
    // Rejection handler required: a bind failure must surface via
    // bridge.ready below, not as a process-killing unhandled rejection (#252).
    void bridge.start().catch(() => {
      /* bind failures surface via bridge.ready */
    });

    const client = new zmq.Dealer({ routingId });
    await client.connect(`tcp://127.0.0.1:${port}`);
    await bridge.ready;
    return { bridge, client, pool };
  }

  it(
    'a failed request on the host pool recovers the bridge: un-adoption lets a fresh init rebuild a working pool',
    { timeout: 60000 },
    async () => {
      const portManager = new PortManager({ startPort: 16300, endPort: 16349 });
      const port = portManager.allocate();
      const onHostPoolFailed = vi.fn();
      const { bridge, client, pool } = await startHostBridge('hostclient', port, { onHostPoolFailed });
      try {
        // The reaper must be armed in host mode too (BonkEnv adopts before
        // start()): it drives proactive host-pool recovery and keeps reaping
        // client sessions after a recovery un-adopts the host pool.
        expect((bridge as any).sessionReapTimer).toBeDefined();

        // Shared client adopts the host session via a matching-count init.
        const initResponse = await sendCommand(client, { command: 'init', numEnvs: 1 });
        expect(initResponse.status).toBe('ok');

        // Kill the adopted pool asynchronously, exactly as a worker exit/error
        // event would between requests. Recovery must not be silent: the
        // replacement is logged loudly and the owner hook fires with the
        // dead pool.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let stepResponse: any;
        let warnedAboutReplacement = false;
        try {
          await (pool as any).failPool(new Error('host worker exited between requests'));
          stepResponse = await sendCommand(client, { command: 'step', actions: [0] });
          // Read the recorded calls before mockRestore clears them.
          warnedAboutReplacement = warnSpy.mock.calls.some((call) =>
            String(call[0]).includes('Adopted host pool failed'),
          );
        } finally {
          warnSpy.mockRestore();
        }
        expect(stepResponse.status).toBe('error');
        expect(stepResponse.error).toContain('worker pool is in failed state');

        // Reactive recovery flipped the adoption off instead of leaving every
        // future request wedged on the corpse.
        expect((bridge as any)._hostPool).toBe(false);
        expect((bridge as any).localSession.initialized).toBe(false);

        expect(warnedAboutReplacement).toBe(true);

        // The owner is notified with the dead pool so its retained reference
        // being orphaned is never silent, and the bridge swapped in a rebuilt
        // pool rather than leaving clients pinned to the corpse.
        expect(onHostPoolFailed).toHaveBeenCalledTimes(1);
        expect(onHostPoolFailed).toHaveBeenCalledWith(pool);
        expect((bridge as any).localSession.pool).not.toBe(pool);

        // A plain re-init rebuilds a fresh bridge-owned pool: no process
        // restart required, and the rebuilt pool actually serves steps.
        const reinitResponse = await sendCommand(client, { command: 'init', numEnvs: 1 });
        expect(reinitResponse.status).toBe('ok');
        const stepOk = await sendCommand(client, { command: 'step', actions: [0] });
        expect(stepOk.status).toBe('ok');
      } finally {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        try {
          await bridge.close();
        } catch {
          /* ignore */
        }
        portManager.release(port);
      }
    },
  );

  it('the reaper proactively recovers a dead host pool without waiting for a request', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: 16350, endPort: 16399 });
    const port = portManager.allocate();
    const { bridge, client, pool } = await startHostBridge('hostclient2', port);
    try {
      // Reaper armed in host mode: no request arrives after the async failure
      // below, so only the timer-driven reaper could notice and recover.
      expect((bridge as any).sessionReapTimer).toBeDefined();

      const initResponse = await sendCommand(client, { command: 'init', numEnvs: 1 });
      expect(initResponse.status).toBe('ok');

      // No request arrives after the async failure: only the reaper can
      // notice and recover.
      await (pool as any).failPool(new Error('host worker exited between requests'));
      await (bridge as any).reapExpiredSessions();

      expect((bridge as any)._hostPool).toBe(false);
      expect((bridge as any).localSession.initialized).toBe(false);

      // Sharing clients recover through a plain re-init afterwards.
      const reinitResponse = await sendCommand(client, { command: 'init', numEnvs: 1 });
      expect(reinitResponse.status).toBe('ok');
      const stepOk = await sendCommand(client, { command: 'step', actions: [0] });
      expect(stepOk.status).toBe('ok');
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      try {
        await bridge.close();
      } catch {
        /* ignore */
      }
      portManager.release(port);
    }
  });
});

describe('IpcBridge keeps a healthy session on a validation-only re-init rejection (issue #440)', () => {
  let bridge: IpcBridge;
  let client: zmq.Dealer;
  let portManager: PortManager;
  let port: number;
  // The bridge keys sessions by the client's ZMQ routing identity in hex.
  const sessionKey = Buffer.from('reinit440', 'utf8').toString('hex');

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 16400, endPort: 16499 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
    // Rejection handler required: a bind failure must surface via
    // bridge.ready below, not as a process-killing unhandled rejection (#252).
    void bridge.start().catch(() => {
      /* bind failures surface via bridge.ready */
    });

    client = new zmq.Dealer({ routingId: 'reinit440' });
    await client.connect(`tcp://127.0.0.1:${port}`);
    await bridge.ready;
  }, 30000);

  afterAll(async () => {
    try {
      client.close();
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

  function sessions(): Map<string, any> {
    return (bridge as any).sessions as Map<string, any>;
  }

  function init(config: Record<string, unknown> = {}): Promise<any> {
    return sendCommand(client, { command: 'init', numEnvs: 1, useSharedMemory: true, config });
  }

  it(
    'a re-init rejected by pre-teardown config validation keeps the session and pool serving',
    { timeout: 60000 },
    async () => {
      const initResponse = await init({ seed: 7 });
      expect(initResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);

      // Advance the episode and record the per-step tick delta so preserved
      // episode state is observable regardless of the configured frameSkip.
      let tickBefore = 0;
      let delta = 1;
      for (let i = 0; i < 3; i++) {
        const stepResponse = await sendCommand(client, { command: 'step', actions: [1] });
        expect(stepResponse.status).toBe('ok');
        const tick = stepResponse.data[0].info.tick;
        if (i === 1) delta = tick - tickBefore;
        tickBefore = tick;
      }

      // One out-of-range opponent count (camelCase and snake_case spellings)
      // must be a per-request input error: labeled reply, nothing torn down.
      for (const config of [{ numOpponents: MAX_OPPONENTS + 1 }, { num_opponents: MAX_OPPONENTS + 1 }]) {
        const badReinit = await init(config);
        expect(badReinit.status).toBe('error');
        expect(badReinit.error).toContain(`Invalid numOpponents ${MAX_OPPONENTS + 1}`);
      }

      // The session survives with its still-ready pool.
      expect(sessions().has(sessionKey)).toBe(true);
      const session = sessions().get(sessionKey);
      expect(session.pool.isFailed()).toBe(false);

      // The same environment keeps serving and the episode continues
      // exactly where it left off.
      const stepAfter = await sendCommand(client, { command: 'step', actions: [0] });
      expect(stepAfter.status).toBe('ok');
      expect(stepAfter.data[0].info.tick).toBe(tickBefore + delta);
      const resetAfter = await sendCommand(client, { command: 'reset', seeds: [7] });
      expect(resetAfter.status).toBe('ok');
    },
  );

  it(
    'a genuinely failing re-init (post-teardown worker failure) still evicts the session',
    { timeout: 60000 },
    async () => {
      // Replaces the healthy session from the previous test with a fresh pool.
      const initResponse = await init({});
      expect(initResponse.status).toBe('ok');
      expect(sessions().has(sessionKey)).toBe(true);

      // frameSkip 0 passes the pool-level pre-teardown validation but fails
      // during worker env construction AFTER closeInternal() tore the old
      // workers down (#393): failPool runs, so eviction stays correct here.
      const badInit = await init({ frameSkip: 0 });
      expect(badInit.status).toBe('error');
      expect(badInit.error).toContain('Invalid frameSkip 0');

      expect(sessions().has(sessionKey)).toBe(false);
      const stepAfter = await sendCommand(client, { command: 'step', actions: [0] });
      expect(stepAfter.status).toBe('error');
      expect(stepAfter.error).toBe('Worker pool not initialized');

      // A plain re-init from the same identity recovers cleanly.
      const recovery = await init({});
      expect(recovery.status).toBe('ok');
      const stepOk = await sendCommand(client, { command: 'step', actions: [0] });
      expect(stepOk.status).toBe('ok');
    },
  );
});
