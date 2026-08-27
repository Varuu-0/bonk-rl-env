/**
 * ipc-bridge-restart.test.ts — regression coverage for issue #263
 *
 * IpcBridge.close() permanently destroys the ZMQ ROUTER socket, but both the
 * code and the docs treat a later start() on the same instance as a
 * supported restart ("a later `start()` restarts clean"). Previously that
 * restart deterministically failed with the opaque `Socket is closed`
 * (libzmq sockets can never be re-bound after close()). This test proves the
 * documented lifecycle end to end: start → DEALER round-trip → close → start
 * the SAME instance again → a fresh DEALER round-trip succeeds, with
 * `bridge.ready` re-armed to reflect the new bind — and that a restart whose
 * bind fails once still recovers on retry (ready resolves for the live bind).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge can be restarted after close() (issue #263)', () => {
  let bridge: IpcBridge;
  let portManager: PortManager;
  let port: number;

  beforeAll(async () => {
    portManager = new PortManager({ startPort: 15800, endPort: 15899 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
  }, 30000);

  afterAll(async () => {
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    portManager.release(port);
  }, 10000);

  /**
   * Connect a fresh DEALER client (as the Python client does) to the
   * bridge's port and complete an `init` → `reset` round-trip. The reset
   * observation length proves the response came from a live pool served by
   * the currently-bound ROUTER socket.
   */
  async function roundTrip(numEnvs: number): Promise<void> {
    const client = new zmq.Dealer();
    try {
      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 100));

      const sendCommand = async (cmd: object): Promise<any> => {
        await client.send(JSON.stringify(cmd));
        const [response] = await client.receive();
        return JSON.parse(response.toString());
      };

      const init = await sendCommand({ command: 'init', numEnvs, useSharedMemory: false });
      expect(init.status).toBe('ok');

      const reset = await sendCommand({ command: 'reset', seeds: Array.from({ length: numEnvs }, (_, i) => i + 1) });
      expect(reset.status).toBe('ok');
      expect(reset.data.observation).toHaveLength(numEnvs);
    } finally {
      client.close();
    }
  }

  /**
   * Wait until the bridge's port is bindable again. The closed listener
   * releases it asynchronously, so poll with a throwaway ROUTER and await
   * that probe's explicit unbind before allowing the follow-up bind.
   * Only port contention (EADDRINUSE) is transient — any other bind/unbind
   * failure is a real error and propagates immediately instead of burning
   * the deadline in a misleading retry storm. `deadline` is an absolute
   * timestamp so a caller can share one bounded budget across a loop of
   * probes rather than multiplying a per-probe timeout.
   */
  async function waitForPortFree(deadline = Date.now() + 5000): Promise<void> {
    const endpoint = `tcp://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      const probe = new zmq.Router();
      let bound = false;
      let unbound = false;
      try {
        await probe.bind(endpoint);
        bound = true;
        await probe.unbind(endpoint);
        unbound = true;
        return;
      } catch (err) {
        if (!isEaddrInUse(err)) {
          throw err;
        }
      } finally {
        if (bound && !unbound) {
          try {
            await probe.unbind(endpoint);
          } catch {
            /* close below */
          }
        }
        probe.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`port ${port} did not become free`);
  }

  /**
   * A bind on a held port rejects with EADDRINUSE (errno 98); anything else
   * (e.g. a broken ZMQ context or an invalid endpoint) is not contention and
   * must not be treated as retryable.
   */
  function isEaddrInUse(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE';
  }

  it('leaves the probe endpoint immediately rebindable (#327)', async () => {
    const endpoint = `tcp://127.0.0.1:${port}`;

    // One shared deadline bounds the whole loop instead of a fresh 5s
    // per-iteration budget: 50 iterations × 5s ≈ 250s would outlive the 60s
    // test timeout and surface a slow-release regression as an opaque
    // timeout instead of the explicit "did not become free" error. The 15s
    // budget is far above the loop's normal ~50ms-per-iteration cost, so a
    // passing run finishes well before it.
    const deadline = Date.now() + 15000;

    for (let attempt = 0; attempt < 50; attempt++) {
      await waitForPortFree(deadline);

      const retry = new zmq.Router();
      let bound = false;
      try {
        await retry.bind(endpoint);
        bound = true;
      } finally {
        try {
          if (bound) await retry.unbind(endpoint);
        } finally {
          retry.close();
        }
      }
    }
  }, 60000);

  it('start → close → start serves fresh DEALER round-trips on the same instance', async () => {
    // First serve cycle. start() only exits on close(), so never await it
    // directly; keep the promise referenced and surface bind failures via
    // bridge.ready (an unhandled serve rejection would crash the worker).
    const readyBeforeFirstStart = bridge.ready;
    const serve1 = bridge.start();
    serve1.catch(() => {});
    await bridge.ready;
    expect(bridge.isClosed()).toBe(false);
    await roundTrip(1);

    // Full shutdown: the socket is destroyed here, so a restart must
    // recreate it from scratch.
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    await serve1; // the first serve loop exits once the socket is closed

    // Restart the same instance (the documented "later start() + restart").
    const serve2 = bridge.start();
    serve2.catch(() => {});
    // `ready` must be re-armed for the new serve cycle: awaiting it below
    // reflects the re-bound socket, not the already-resolved first bind.
    expect(bridge.ready).not.toBe(readyBeforeFirstStart);
    await bridge.ready;
    expect(bridge.isClosed()).toBe(false);
    await roundTrip(1);

    // Second cycle must shut down the same way.
    await bridge.close();
    expect(bridge.isClosed()).toBe(true);
    await serve2;
  }, 60000);

  it('recovers when a restart bind fails once: ready rejects, then resolves on retry', async () => {
    // First serve cycle + full shutdown so the socket is destroyed.
    const serve1 = bridge.start();
    serve1.catch(() => {});
    await bridge.ready;
    await bridge.close();
    await serve1;

    // Occupy the port so the restart's bind deterministically fails once.
    // The listener is closed in `finally` so a failed assertion can never
    // leave the port bound for the rest of the suite.
    const blocker = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', resolve);
      });

      const serve2 = bridge.start();
      serve2.catch(() => {}); // the bind failure surfaces via bridge.ready
      await expect(bridge.ready).rejects.toThrow();
      expect(bridge.isClosed()).toBe(true);

      // Release the port; the retry must re-arm ready and bind fresh.
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await waitForPortFree();

      const serve3 = bridge.start();
      serve3.catch(() => {});
      await expect(bridge.ready).resolves.toBeUndefined();
      expect(bridge.isClosed()).toBe(false);

      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await serve3;
    } finally {
      // The success path already closed the listener above; only close here
      // if an assertion failed while it was still listening, so a redundant
      // close (which rejects with ERR_SERVER_NOT_RUNNING) is a true no-op.
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60000);
});

describe('IpcBridge ready capture order with real sockets (issue #435)', () => {
  let portManager: PortManager;
  let port: number;

  beforeAll(() => {
    // 16100-16199 is reserved for this suite: 15900-15999 belongs to
    // ipc-bridge-options.test.ts and vitest forks run in parallel, so an
    // overlap would make both suites race to bind the same port (#435 review).
    portManager = new PortManager({ startPort: 16100, endPort: 16199 });
    port = portManager.allocate();
  });

  afterAll(() => {
    portManager.release(port);
  }, 10000);

  /**
   * Bounded settle probe: resolves with how `promise` settled, or 'hung'
   * if it is still pending after `ms`. A 'hung' verdict is exactly the
   * silent #435 deadlock (an early-captured ready promise that never
   * settles), so tests assert an explicit outcome rather than awaiting bare.
   */
  async function settleOutcome(promise: Promise<void>, ms = 10000): Promise<string> {
    return Promise.race([
      promise.then(
        () => 'resolved',
        (e: any) => `rejected(${e?.code ?? e?.message ?? e})`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), ms)),
    ]);
  }

  it('a ready promise captured BEFORE start() resolves on a successful bind', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    // Capture the readiness signal before starting the serve loop — the
    // natural race-free embedder pattern that deadlocked before the fix.
    const earlyReady = bridge.ready;
    const serve = bridge.start();
    serve.catch(() => {});
    try {
      expect(await settleOutcome(earlyReady)).toBe('resolved');
      expect(bridge.isClosed()).toBe(false);

      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await serve;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a ready promise captured BEFORE start() rejects on a genuine EADDRINUSE bind failure', async () => {
    // Occupy the port so the bridge's bind deterministically fails with
    // libzmq's EADDRINUSE — the exact outcome class from issue #435.
    const blocker = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', resolve);
      });

      const bridge = new IpcBridge({ server: { port } } as any);
      const earlyReady = bridge.ready; // captured BEFORE start()
      await expect(bridge.start()).rejects.toThrow();
      // The early capture must reject with the SAME bind failure start()
      // surfaced — previously it stayed pending forever.
      expect(await settleOutcome(earlyReady)).toBe('rejected(EADDRINUSE)');
      expect(bridge.isClosed()).toBe(false);
      await bridge.close();
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60000);

  it('a ready promise captured AFTER start() settles with the same cycle outcome (order pin)', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const serve = bridge.start();
    serve.catch(() => {});
    try {
      const lateReady = bridge.ready;
      expect(await settleOutcome(lateReady)).toBe('resolved');

      // And on this same live socket, restart semantics stay pinned (#263):
      // close + start re-arms a fresh signal that also resolves.
      await bridge.close();
      await serve;
      const serve2 = bridge.start();
      serve2.catch(() => {});
      const restartedReady = bridge.ready;
      expect(restartedReady).not.toBe(lateReady);
      expect(await settleOutcome(restartedReady)).toBe('resolved');

      await bridge.close();
      await serve2;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);
});

describe('IpcBridge close() during an in-flight restart bind (issue #431)', () => {
  let portManager: PortManager;
  let port: number;

  beforeAll(() => {
    // Observed port-band ownership across the ipc test suites (vitest forks
    // run in parallel, so two suites allocating the same port would race to
    // bind it). Bands here are NOT strictly per-suite: some are shared or
    // overlapping, e.g. 15700-15799 is used by e2e/bind-address/multiclient,
    // and ipc-bridge-failed-session's 16400-16449 overlaps bonk-env-ipc-server's
    // own 16400 base.
    //   15600-15699 ipc-bridge-dealer-socket
    //   15700-15799 ipc-bridge-e2e / bind-address / multiclient (shared)
    //   15800-15899 ipc-bridge-restart (ready-capture describe)
    //   15900-15999 ipc-bridge-options
    //   16000-16099 ipc-bridge-req-socket
    //   16100-16199 ipc-bridge-restart (restart-lifecycle describe)
    //   16200-16449 ipc-bridge-failed-session (16400-16449 overlaps bonk-env-ipc-server)
    //   16400-17010 bonk-env-ipc-server (IPC_SERVER_TEST_START = 16400, sparse bands)
    //   17100-17199 this #431 suite — chosen disjoint, above every band above
    portManager = new PortManager({ startPort: 17100, endPort: 17199 });
    port = portManager.allocate();
  });

  afterAll(() => {
    portManager.release(port);
  }, 10000);

  /**
   * Bounded settle probe (mirrors the #435 helper): resolves with how
   * `promise` settled so assertions observe an explicit outcome instead of
   * hanging on a wedged lifecycle.
   */
  async function settleOutcome(promise: Promise<unknown>, ms = 10000): Promise<string> {
    return Promise.race([
      promise.then(
        () => 'resolved',
        (e: any) => `rejected(${e?.name ?? e?.message ?? e})`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), ms)),
    ]);
  }

  /**
   * Poll until a throwaway TCP listener can bind the bridge's port, proving
   * nothing is serving on it. A resurrected bridge would hold the port and
   * every attempt would fail with EADDRINUSE until the deadline expires.
   * Mirrors the sibling #435 helper's discipline: only port contention
   * (EADDRINUSE) is transient — any other failure is a real error and
   * propagates immediately instead of burning the deadline in a misleading
   * retry storm.
   */
  async function waitForPortFree(deadline = Date.now() + 5000): Promise<void> {
    while (Date.now() < deadline) {
      const outcome = await new Promise<string>((resolve) => {
        const probe = net.createServer();
        probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'UNKNOWN'));
        probe.listen(port, '127.0.0.1', () => {
          probe.close(() => resolve('free'));
        });
      });
      if (outcome === 'free') return;
      if (outcome !== 'EADDRINUSE') {
        throw new Error(`port ${port} probe failed unexpectedly: ${outcome}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`port ${port} is still held by the bridge`);
  }

  /**
   * Run one healthy serve cycle (start → ready → full shutdown) so each
   * test begins from the closed state whose restart exposes the #431 race.
   */
  async function startAndShutdown(bridge: IpcBridge): Promise<void> {
    const serve = bridge.start();
    serve.catch(() => {});
    await bridge.ready;
    await bridge.close();
    await serve;
    expect(bridge.isClosed()).toBe(true);
  }

  it('an awaited close() racing a restart bind leaves the bridge permanently closed', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      await startAndShutdown(bridge);

      // Invoke the documented restart flow WITHOUT awaiting it, then race a
      // shutdown against its in-flight bind. start() reaches its bind await
      // synchronously, so this close() deterministically lands inside the
      // pre-bind window where _closed is still stale-true from cycle 1 —
      // exactly where close() used to resolve as a silent no-op (#431).
      const restart = bridge.start();
      const restartOutcome = restart.then(
        () => 'resolved',
        (e: any) => `rejected(${e?.name ?? e?.message ?? e})`,
      );
      await bridge.close();

      // The awaited shutdown must have performed the FULL teardown, not a
      // no-op: the bridge reports closed the moment close() resolves...
      expect(bridge.isClosed()).toBe(true);

      // ...and the pending restart must never resurrect serving: ready
      // settles without a bound server and start() settles with the same
      // cancelled-cycle outcome, mirroring #402's first-start close.
      expect(await settleOutcome(bridge.ready)).toBe('rejected(BridgeClosedDuringStart)');
      expect(await restartOutcome).toBe('rejected(BridgeClosedDuringStart)');

      // isClosed() STAYS true after the would-be bind window has long
      // passed, and nothing serves afterwards: an independent binder can
      // take the port.
      await waitForPortFree();
      expect(bridge.isClosed()).toBe(true);

      // The shutdown state is terminal until a NEW start() call; an
      // idempotent close() still resolves cleanly.
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a close() landing on a restart parked on an in-flight close cancels the parked cycle', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const serve = bridge.start();
    serve.catch(() => {});
    try {
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);

      // Fire a close() while the bridge is SERVING so its teardown is
      // genuinely in flight, then immediately initiate the restart, which
      // parks on that teardown — the documented #316 restart-during-close
      // window. start() reaches its previousClose await synchronously, so
      // the park is guaranteed before the next statement runs.
      const priorClose = bridge.close();
      const parkedRestart = bridge.start();
      const parkedOutcome = parkedRestart.then(
        () => 'resolved',
        (e: any) => `rejected(${e?.name ?? e?.message ?? e})`,
      );

      // ...then race a shutdown in while the restart is still parked. This
      // close must own the lifecycle: once it resolves, the parked cycle
      // must abort instead of re-binding behind the completed teardown.
      await bridge.close();
      await priorClose;

      // The awaited shutdown left the bridge fully closed, the parked
      // restart settled as a cancelled cycle (never a silent bind), and
      // ready settled with it.
      expect(bridge.isClosed()).toBe(true);
      expect(await settleOutcome(bridge.ready)).toBe('rejected(BridgeClosedDuringStart)');
      expect(await parkedOutcome).toBe('rejected(BridgeClosedDuringStart)');

      // Nothing serves afterwards and the closed state is terminal.
      await waitForPortFree();
      expect(bridge.isClosed()).toBe(true);
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
      await serve.catch(() => {});
    }
  }, 60000);

  it('a fresh start() succeeds after a close cancels a parked restart (no stuck state)', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const client = new zmq.Dealer();
    const serve = bridge.start();
    serve.catch(() => {});
    try {
      await bridge.ready;

      // Reproduce the park-window cancellation: close() while serving, park
      // a restart on the in-flight teardown, then a second close() cancels
      // the parked cycle.
      const priorClose = bridge.close();
      const parkedRestart = bridge.start();
      void parkedRestart.catch(() => {});
      await bridge.close();
      await priorClose;
      await expect(parkedRestart).rejects.toThrow('bridge was closed during start');
      expect(bridge.isClosed()).toBe(true);
      await waitForPortFree();

      // The cancellation must not leave stuck internal state (a leftover
      // parkedStart marker, a retained closePromise, or a stale _closed):
      // the documented restart flow works again, binding and serving a
      // DEALER round-trip on this same instance.
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);

      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 100));
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const [reply] = await client.receive();
      expect(JSON.parse(reply.toString()).status).toBe('ok');

      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await serve2;
    } finally {
      client.close();
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
      await serve.catch(() => {});
    }
  }, 60000);

  it('a fresh start() after the cancelled restart binds and serves again', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const client = new zmq.Dealer();
    try {
      // Cancel a restart mid-bind exactly like the core regression above.
      await startAndShutdown(bridge);
      const cancelled = bridge.start();
      void cancelled.catch(() => {});
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await expect(cancelled).rejects.toThrow('bridge was closed during start');

      // The documented restart flow still works once the dust settles:
      // a NEW start() call must bind and serve round-trips again.
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);

      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 100));
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const [reply] = await client.receive();
      expect(JSON.parse(reply.toString()).status).toBe('ok');

      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
      await serve2;
    } finally {
      client.close();
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);
});
