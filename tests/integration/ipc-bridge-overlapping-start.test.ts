/**
 * ipc-bridge-overlapping-start.test.ts — regression coverage for issue #418
 *
 * IpcBridge.start() had no overlapping-call guard: a second start() while a
 * serve cycle was live re-ran the bind on the shared ROUTER, and its
 * EADDRINUSE cleanup closed the socket OUT FROM UNDER the healthy first
 * cycle — every later client request hung forever, isClosed() kept reporting
 * false, and even close() wedged (unbind on the destroyed socket). The guard
 * added with this suite rejects an overlapping start() fast, before any
 * state mutation, so the running bridge keeps serving untouched. Cycles
 * whose shutdown is already owned by close() (in-flight closePromise) or
 * whose transport is already destroyed keep using the #316/#263
 * serialization paths instead of being rejected.
 *
 * The second describe (issue #478) covers the close-during-bind admission
 * window: a start() admitted behind an in-flight close whose previous
 * cycle's native bind is still unwinding must serialize on that unwind
 * instead of racing libzmq's delayed-close state, and the cut-off outcome
 * must settle bridge.ready distinguishably (BridgeClosedDuringStart) and
 * re-arm it recoverably instead of draining it with the opaque EBUSY text
 * ("Socket is blocked by a bind or unbind operation") — which left
 * bridge.ready permanently rejected with no listener on the port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

// 17211-17310 is reserved for this suite. Every other ipc-bridge suite owns
// a disjoint band: bonk-env-ipc-server.test.ts spreads 16400-17010 via
// offsets from IPC_SERVER_TEST_START, ipc-bridge-failed-session.test.ts
// reserves 17100-17199, and earlier bands are claimed by older suites —
// vitest forks run in parallel, so ranges must not overlap.
describe('IpcBridge overlapping start() calls (issue #418)', () => {
  let portManager: PortManager;
  let port: number;

  beforeAll(() => {
    portManager = new PortManager({ startPort: 17211, endPort: 17310 });
    port = portManager.allocate();
  });

  afterAll(() => {
    portManager.release(port);
  }, 10000);

  /**
   * Return the rejection reason of `promise`, or fail if it resolves.
   */
  async function rejectOf(promise: Promise<unknown>): Promise<any> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected promise to reject');
  }

  /**
   * Fresh DEALER client round-trip (as the Python client does): connect,
   * `init`, await the reply. Bounded receive/send timeouts turn the #418
   * symptom — a silently dead listener that hangs every request — into a
   * fast, diagnosable failure instead of a suite-wide timeout.
   */
  async function roundTripInitStatus(): Promise<string> {
    const client = new zmq.Dealer({ receiveTimeout: 5000, sendTimeout: 5000 });
    try {
      await client.connect(`tcp://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 100));
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const [reply] = await client.receive();
      return JSON.parse(reply.toString()).status;
    } finally {
      client.close();
    }
  }

  /**
   * Wait until the bridge's port is bindable again after close(), using the
   * same throwaway-ROUTER probe as the restart suite: libzmq releases the
   * listener asynchronously, so poll instead of assuming immediate release.
   */
  async function waitForPortFree(deadline = Date.now() + 5000): Promise<void> {
    const endpoint = `tcp://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      const probe = new zmq.Router();
      let bound = false;
      try {
        await probe.bind(endpoint);
        bound = true;
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'EADDRINUSE') {
          throw err;
        }
      } finally {
        if (bound) {
          try {
            await probe.unbind(endpoint);
          } catch {
            /* best-effort probe teardown */
          }
        }
        probe.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`port ${port} did not become free`);
  }

  it('a start() while serving rejects fast and leaves the live serve cycle untouched', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const sockBefore = (bridge as any).sock;
    try {
      // First serve cycle: never awaited directly (it only exits on
      // close()); bind failures surface via ready/round-trips below.
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      // The live cycle's readiness signal must be captured BEFORE the
      // overlap: the guard must reject without re-arming/swapping it.
      const liveReady = bridge.ready;

      // Overlapping call: fails fast with a clear, programmatically
      // distinguishable error...
      const overlapErr = await rejectOf(bridge.start());
      expect(overlapErr.name).toBe('BridgeOverlappingStart');
      expect(overlapErr.message).toMatch(/already running/);

      // ...WITHOUT touching the running instance's transport or state:
      // same, still-open ROUTER handle; readiness signal not swapped;
      // truthful isClosed().
      expect((bridge as any).sock).toBe(sockBefore);
      expect((bridge as any).sock.closed).toBe(false);
      expect(bridge.ready).toBe(liveReady);
      expect(bridge.isClosed()).toBe(false);

      // The ORIGINAL serve loop still answers requests.
      expect(await roundTripInitStatus()).toBe('ok');

      // The documented recovery path works normally afterwards: close()
      // resolves (no "Socket is closed" wedge), reports closed, and the
      // first serve promise settles.
      await expect(bridge.close()).resolves.toBeUndefined();
      expect(bridge.isClosed()).toBe(true);
      await serve1;
      await waitForPortFree();
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('close() and start() issued back-to-back still serialize a live cycle into a clean restart (#316 pattern)', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    const sockFirst = (bridge as any).sock;
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(await roundTripInitStatus()).toBe('ok');

      // Racy-but-supported pattern: close() and the restart's start() are
      // issued back-to-back WITHOUT awaiting the old serve promise. The
      // shutdown owns the old cycle's cancellation, so the restart must
      // serialize behind the in-flight closePromise (previousClose await +
      // transport recreation) instead of being rejected as an overlap.
      const closePromise = bridge.close();
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await closePromise;
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);

      // The restart recreated the transport and the new cycle answers.
      expect((bridge as any).sock).not.toBe(sockFirst);
      expect((bridge as any).sock.closed).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      // The old loop drained once its socket was destroyed.
      await serve1;

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('two start() calls during an unsettled close(): exactly one wins and serves; the loser rejects with a typed error', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(await roundTripInitStatus()).toBe('ok');
      const servingSock = (bridge as any).sock;

      // close() and TWO restarts issued back-to-back WITHOUT awaiting the
      // old cycle. The drain admits both, but they race for one transport:
      // both recreate the closed ROUTER and both bind — the losing bind's
      // failed-bind cleanup would close the shared handle out from under
      // the winner, the original #418 kill (review finding). Exactly one
      // admitted caller (the first to drain — serve2) takes the transport;
      // serve3 must be superseded and reject cleanly before touching the
      // socket.
      const closePromise = bridge.close();
      const serve2 = bridge.start();
      const serve3 = bridge.start();
      serve2.catch(() => {});
      serve3.catch(() => {});
      await closePromise;

      // The superseded caller rejects promptly with the typed error...
      const loserErr = await rejectOf(serve3);
      expect(loserErr.name).toBe('BridgeOverlappingStart');
      expect(loserErr.message).toMatch(/superseded|already running/);

      // ...while the winner's cycle is still active (settles only on
      // close()), the winner bound a fresh ROUTER and serves round-trips,
      // and isClosed() stays truthful throughout.
      let winnerSettled = false;
      serve2.then(
        () => {
          winnerSettled = true;
        },
        () => {
          winnerSettled = true;
        },
      );
      expect(winnerSettled).toBe(false);

      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect((bridge as any).sock).not.toBe(servingSock);
      expect((bridge as any).sock.closed).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
      await serve1; // the old draining cycle also settles
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a start() after a superseded loser rejects at entry and never strands bridge.ready (slot-clear ownership)', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(await roundTripInitStatus()).toBe('ok');

      // Drain race with a superseded loser: serve2 wins admission, serve3 is
      // the last _serveCycle writer and rejects. Regression: the loser's
      // finally used to clear _serveCycle purely because it matched ITS OWN
      // (last-written) promise — clearing it out from under the serving
      // winner. A later start() then bypassed the entry guard, re-armed
      // bridge.ready to a promise nothing settles, and failed at the
      // admission claim — stranding standalone `await bridge.ready` callers.
      const closePromise = bridge.close();
      const serve2 = bridge.start();
      const serve3 = bridge.start();
      serve2.catch(() => {});
      serve3.catch(() => {});
      await closePromise;

      const loserErr = await rejectOf(serve3);
      expect(loserErr.name).toBe('BridgeOverlappingStart');
      await bridge.ready;
      expect(await roundTripInitStatus()).toBe('ok');

      // The winner re-registers itself as the retained serve-cycle slot when
      // it claims admission; the loser (last _serveCycle writer) must never
      // leave the slot naming its own settled promise. Probe the slot with a
      // macrotask gap (unambiguous vs two pre-settled race arms): the
      // winner's live cycle is still PENDING (timer wins), a superseded
      // loser's dead cycle would reject before the timer fires.
      const slotState = await Promise.race([
        (bridge as any)._serveCycle.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-pending'), 250)),
      ]);
      expect(slotState).toBe('still-pending');

      // A further start() while the winner serves must be rejected at the
      // ENTRY guard (slot still truthy), not after re-arming ready, and the
      // winner's readiness signal must be untouched and promptly settled.
      const winnerReady = bridge.ready;
      const lateErr = await rejectOf(bridge.start());
      expect(lateErr.name).toBe('BridgeOverlappingStart');
      expect(bridge.ready).toBe(winnerReady);
      const readyOutcome = await Promise.race([
        bridge.ready.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<string>((r) => setTimeout(() => r('STILL PENDING'), 1500)),
      ]);
      expect(readyOutcome).toBe('resolved');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
      await serve1;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a restart issued before the drained cycle settles is not rejected as an overlap (#263 pattern)', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      // serve1 may still be unwinding here, but its transport is already
      // destroyed, so the restart must proceed via transport recreation
      // instead of being rejected as an overlapping start.
      const sockDrained = (bridge as any).sock;
      expect(sockDrained.closed).toBe(true);

      const serve2 = bridge.start();
      serve2.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect((bridge as any).sock).not.toBe(sockDrained);
      expect(await roundTripInitStatus()).toBe('ok');

      await serve1;
      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('the guard clears when a cycle settles, so restart-after-overlap still works', async () => {
    const bridge = new IpcBridge({ server: { port } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      await bridge.ready;

      // Overlap rejected while cycle 1 is live...
      const overlapErr = await rejectOf(bridge.start());
      expect(overlapErr.name).toBe('BridgeOverlappingStart');
      await bridge.close();
      await serve1;

      // ...but its rejection must not leak the guard: a genuine restart of
      // the same instance (#263 flow) binds and serves again.
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve2;
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);

  it('a failed (bind-error) attempt clears the guard so an immediate retry can start', async () => {
    // Occupy the port so the first attempt fails its bind like the #326/#435
    // retry flows; the guard must clear when that attempt rejects.
    const blocker = net.createServer();
    let bridge: IpcBridge | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', resolve);
      });

      bridge = new IpcBridge({ server: { port } } as any);
      const earlyReady = bridge.ready;
      await expect(bridge.start()).rejects.toThrow(); // EADDRINUSE class
      expect(
        await Promise.race([
          earlyReady.then(
            () => 'resolved',
            () => 'rejected',
          ),
          new Promise<string>((r) => setTimeout(() => r('hung'), 1500)),
        ]),
      ).toBe('rejected');
      expect(bridge.isClosed()).toBe(false);

      // Release the port; the retry must be allowed to run (guard cleared)
      // and reach a healthy serving state.
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await waitForPortFree();

      const serveRetry = bridge.start();
      serveRetry.catch(() => {});
      await bridge.ready;
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatus()).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serveRetry;
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      if (bridge && !bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 60000);
});

/**
 * Regression coverage for issue #478: IpcBridge.start() admitted during the
 * close-during-bind window. libzmq (node-zeromq v6) processes a Close()
 * issued during an in-flight native bind by ONLY marking a delayed-close
 * request — the socket stays open and Bind()-blocked until that op settles,
 * and `sock.closed` (State::Closed) still reads false. A restart admitted by
 * the drain-window exemption used to rebind immediately, lose the race, and
 * drain the freshly re-armed bridge.ready with libzmq's opaque EBUSY text —
 * a permanently poisoned readiness signal with no serving socket. The fix
 * serializes the restart on the previous transport's unwind and classifies
 * any leftover EBUSY as BridgeClosedDuringStart with a recoverable re-arm.
 *
 * Ports 17212-17310 belong to this file's suites (17211 is the #418
 * describe's fixed allocation); the bands stay disjoint from every other
 * ipc-bridge suite (see the band comment above).
 */
describe('IpcBridge start() during the close-during-bind unwind window (issue #478)', () => {
  let portManager: PortManager;

  beforeAll(() => {
    portManager = new PortManager({ startPort: 17212, endPort: 17310 });
  });

  afterAll(() => {
    portManager.releaseAll();
  }, 10000);

  /**
   * Bounded settlement probe: resolves 'resolved'/'rejected' when the
   * promise settles within `ms`, or 'pending' — the pre-fix symptom was a
   * TERMINAL rejection, the post-fix contract is settle-within-deadline.
   */
  async function settleWithin(promise: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'pending'> {
    return Promise.race([
      promise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
    ]);
  }

  async function rejectOf(promise: Promise<unknown>): Promise<any> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected promise to reject');
  }

  /** DEALER round-trip bound to an explicit port (see #418 helper above). */
  async function roundTripInitStatusOn(targetPort: number): Promise<string> {
    const client = new zmq.Dealer({ receiveTimeout: 5000, sendTimeout: 5000 });
    try {
      await client.connect(`tcp://127.0.0.1:${targetPort}`);
      await new Promise((r) => setTimeout(r, 100));
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const [reply] = await client.receive();
      return JSON.parse(reply.toString()).status;
    } finally {
      client.close();
    }
  }

  /** Port-free probe for an explicit port (see #418 helper above). */
  async function waitPortFree(targetPort: number, deadline = Date.now() + 5000): Promise<void> {
    const endpoint = `tcp://127.0.0.1:${targetPort}`;
    while (Date.now() < deadline) {
      const probe = new zmq.Router();
      let bound = false;
      try {
        await probe.bind(endpoint);
        bound = true;
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'EADDRINUSE') {
          throw err;
        }
      } finally {
        if (bound) {
          try {
            await probe.unbind(endpoint);
          } catch {
            /* best-effort probe teardown */
          }
        }
        probe.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`port ${targetPort} did not become free`);
  }

  /**
   * Non-throwing bindability probe: true when a throwaway ROUTER can bind
   * the endpoint right now, false while any listener (including one
   * mid-unwind) still owns the port.
   */
  async function portBindable(targetPort: number): Promise<boolean> {
    const endpoint = `tcp://127.0.0.1:${targetPort}`;
    const probe = new zmq.Router();
    let bound = false;
    try {
      await probe.bind(endpoint);
      bound = true;
      return true;
    } catch {
      return false;
    } finally {
      if (bound) {
        try {
          await probe.unbind(endpoint);
        } catch {
          /* best-effort probe teardown */
        }
        probe.close();
      } else {
        probe.close();
      }
    }
  }

  it('a start() admitted during the bind-unwind window fails cleanly and the next start() settles bridge.ready', async () => {
    const testPort = portManager.allocate();
    const bridge = new IpcBridge({ server: { port: testPort } } as any);
    const sockFirst = (bridge as any).sock;
    try {
      // The exact #478 shape: close() fires while the first bind is still
      // in flight (ready is never awaited first), and a new start() is
      // admitted by the drain-window exemption before the old transport
      // finished unwinding.
      const serve1 = bridge.start();
      serve1.catch(() => {});
      const closePromise = bridge.close();
      const serve2 = bridge.start();
      serve2.catch(() => {});
      await closePromise;

      // serve1 is the cancelled cycle: the canonical, distinguishable
      // identity — NEVER the opaque libzmq text that used to escape here.
      const err1 = await rejectOf(serve1);
      expect(err1.name).toBe('BridgeClosedDuringStart');
      expect(String(err1?.message ?? err1)).not.toMatch(/blocked by a bind or unbind/i);

      // The window's exposed signal must SETTLE (never pending forever):
      // it resolves when the restarted cycle's bind lands, or rejects with
      // the same typed cut-off identity in the pathological arm. Pre-fix
      // it drained TERMINALLY with the opaque EBUSY error and no listener.
      const windowReady = bridge.ready;
      const windowOutcome = await settleWithin(windowReady, 45000);
      expect(windowOutcome).not.toBe('pending');
      if (windowOutcome === 'rejected') {
        const windowErr = await windowReady.catch((e) => e);
        expect(windowErr?.name).toBe('BridgeClosedDuringStart');
        expect(String(windowErr?.message ?? windowErr)).not.toMatch(/blocked by a bind or unbind/i);
      }

      // THE next start(): re-points readiness synchronously and its bind
      // outcome resolves it. Observe the window's DISPOSITION first:
      // EITHER the admitted restart recovers (its bind lands ⇒ readiness
      // re-points and resolves — typically within the unwind, long before
      // any bound) OR it settles with the typed cut-off identity (the
      // budget-expiry arm under extreme load). While the cycle still winds
      // the transport admission is held, so an eager start() would
      // supersede against it — hence the single observe loop. An opaque
      // EBUSY escape fails the identity assertions below either way.
      let recovered = false;
      let settled = false;
      let serve3: Promise<void> | null = null;
      const observeDeadline = Date.now() + 240000;
      while (!recovered && !settled && Date.now() < observeDeadline) {
        if ((await settleWithin(bridge.ready, 1000)) === 'resolved') {
          recovered = true;
          break;
        }
        if ((await settleWithin(serve2, 0)) !== 'pending') {
          settled = true;
        }
      }
      if (settled) {
        const windowErr = await bridge.ready.catch((e) => e);
        expect(windowErr?.name).toBe('BridgeClosedDuringStart');
        expect(String(windowErr?.message ?? windowErr)).not.toMatch(/blocked by a bind or unbind/i);
        for (let attempt = 0; attempt < 3; attempt++) {
          serve3 = bridge.start();
          serve3.catch(() => {});
          const r = await settleWithin(bridge.ready, 240000);
          if (r === 'resolved') {
            recovered = true;
            break;
          }
          const recoveryErr = await bridge.ready.catch((e) => e);
          expect(recoveryErr?.name).toBe('BridgeClosedDuringStart');
          expect(String(recoveryErr?.message ?? recoveryErr)).not.toMatch(/blocked by a bind or unbind/i);
          await serve3.catch(() => {});
        }
      }
      expect(recovered).toBe(true);

      expect(bridge.isClosed()).toBe(false);
      expect((bridge as any).sock).not.toBe(sockFirst);
      expect((bridge as any).sock.closed).toBe(false);
      expect(await roundTripInitStatusOn(testPort)).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await (serve3 ?? serve2);
      await waitPortFree(testPort);
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 300000);

  it('the close-during-bind window never poisons bridge.ready: it settles distinguishably and the instance stays restartable', async () => {
    const testPort = portManager.allocate();
    const bridge = new IpcBridge({ server: { port: testPort } } as any);
    try {
      const serve1 = bridge.start();
      serve1.catch(() => {});
      const closePromise = bridge.close(); // close during the first bind's flight
      const serve2 = bridge.start(); // admitted mid-unwind (#478 window)
      serve2.catch(() => {});

      await closePromise;
      // The exposed signal during the window must SETTLE within a bounded
      // deadline. Pre-fix it ended up terminally rejected with the opaque
      // EBUSY error and no listener ("permanently poisoned"); post-fix it
      // settles with the distinguishable cut-off identity — while the
      // admitted restart may still recover and bind behind it.
      const windowReady = bridge.ready;
      const windowOutcome = await settleWithin(windowReady, 45000);
      expect(windowOutcome).not.toBe('pending');
      const windowErr = windowOutcome === 'rejected' ? await windowReady.catch((e) => e) : null;
      expect(windowErr === null || windowErr?.name === 'BridgeClosedDuringStart').toBe(true);
      expect(windowErr === null || !/blocked by a bind or unbind/i.test(String(windowErr?.message ?? windowErr))).toBe(
        true,
      );

      // Observe the window's DISPOSITION with the same single-loop design
      // as the test above: the admitted restart either recovers (readiness
      // re-points and resolves) or settles with the typed cut-off identity
      // (the pathological budget-expiry arm). Pre-fix the signal stayed
      // terminally rejected with the opaque EBUSY error and no listener —
      // the never-pending-forever pin below is what that arm broke.
      let settled = false;
      const observeDeadline = Date.now() + 240000;
      while (!settled && Date.now() < observeDeadline) {
        if ((await settleWithin(bridge.ready, 1000)) === 'resolved') {
          break;
        }
        if ((await settleWithin(serve2, 0)) !== 'pending') {
          settled = true;
        }
      }
      const windowSel = await settleWithin(bridge.ready, 1000);
      expect(windowSel).not.toBe('pending');
      if (windowSel === 'rejected') {
        const windowErr = await bridge.ready.catch((e) => e);
        expect(windowErr?.name).toBe('BridgeClosedDuringStart');
        expect(String(windowErr?.message ?? windowErr)).not.toMatch(/blocked by a bind or unbind/i);
      }

      // Drain to a definite physical state (both arms): close() offered
      // before a recovering bind lands is a documented no-op because
      // _closed is still set, so keep offering until the port actually
      // releases.
      const drainDeadline = Date.now() + 60000;
      let drained = false;
      while (!drained && Date.now() < drainDeadline) {
        await bridge.close().catch(() => {});
        if (await portBindable(testPort)) {
          drained = true;
        } else {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      expect(drained).toBe(true);
      await serve2.catch(() => {});

      // Recovery: the SAME instance must be fully restartable — the pre-fix
      // bridge could not be trusted again without a new instance. After the
      // drain above every window cycle has settled, so the retry starts
      // race for nothing; escape hatches keep the identity pin exact.
      let serve3: Promise<void> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        serve3 = bridge.start();
        serve3.catch(() => {});
        const r = await settleWithin(bridge.ready, 240000);
        if (r === 'resolved') break;
        const recoveryErr = await bridge.ready.catch((e) => e);
        expect(recoveryErr?.name).toBe('BridgeClosedDuringStart');
        expect(String(recoveryErr?.message ?? recoveryErr)).not.toMatch(/blocked by a bind or unbind/i);
        await serve3.catch(() => {});
      }
      expect((await settleWithin(bridge.ready, 60000)) === 'resolved').toBe(true);
      expect(bridge.isClosed()).toBe(false);
      expect(await roundTripInitStatusOn(testPort)).toBe('ok');

      await expect(bridge.close()).resolves.toBeUndefined();
      await serve3;
      await waitPortFree(testPort);
    } finally {
      if (!bridge.isClosed()) await bridge.close().catch(() => {});
    }
  }, 240000);
});
