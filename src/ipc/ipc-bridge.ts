import * as zmq from 'zeromq';
import * as net from 'net';
import { WorkerPool, MAX_NUM_ENVS } from '../core/worker-pool';
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from '../telemetry/profiler';
import {
  isTelemetryEnabled as isTelemetryControllerEnabled,
  getTelemetryController,
} from '../telemetry/telemetry-controller';
import {
  getConfig,
  type AppConfig,
  type DeepPartial,
  resolveEnvironmentConfig,
  DEFAULT_MAX_CLIENT_SESSIONS,
  mergeEngineSections,
} from '../config/config-loader';

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;
const CLIENT_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_SESSION_REAP_INTERVAL_MS = 60 * 1000;
// Distinct error for a pre-init identity denied the local/bypass pool because
// it is pinned to another identity; keeps the denial debuggable instead of
// masquerading as an uninitialized pool (issue #270).
const LOCAL_SESSION_PINNED_ERROR = 'Local pool is pinned to another identity';

/**
 * Per-client session state. Each ZMQ routing identity that calls `init` owns
 * its own WorkerPool (and its own environment count and initialization flag),
 * so one client's `init` re-creates only its own pool and one client's session
 * `close` only tears down its own pool — other clients' episodes are never
 * silently reset or broken (issue #193).
 */
interface PoolSession {
  pool: WorkerPool;
  initialized: boolean;
  numEnvs: number;
  lastActivityAt: number;
  activeRequests: number;
}

interface IpcSocketOptions {
  sendHighWaterMark: number;
  receiveHighWaterMark: number;
  tcpKeepalive: number;
  linger: number;
  backlog: number;
}

const MAX_ZMQ_OPTION = 0x7fffffff;
const INTEGER_NUMERIC_RE = /^[+-]?\d+$/;

export class IpcBridge {
  private sock: zmq.Router;
  private port: number;
  private bindAddress: string;
  private stepCount: number = 0;
  private _closed: boolean = false;
  private _shouldClose: boolean = false;
  private readonly maxClientSessions: number;
  private readonly socketOptions: IpcSocketOptions;
  private sessionReapTimer?: ReturnType<typeof setInterval>;
  private sessionReapInProgress?: Promise<void>;

  // Worker pools are owned per client: keyed by the ZMQ routing identity of
  // the client that called `init` (issue #193).
  private sessions: Map<string, PoolSession> = new Map();
  // Before the first IPC `init`, a caller can use the local/bypass pool that
  // was initialized programmatically. Once client-session mode starts,
  // unknown identities must initialize their own session instead of silently
  // inheriting that local pool. This retains loud failures for closed,
  // rejected, and reaped sessions without retaining every identity forever.
  private allowLocalSessionFallback: boolean = true;
  // A programmatic caller that successfully used the local pool before IPC
  // session mode began keeps that pool. There is only one local pool, so one
  // routing identity is sufficient and remains bounded. It is the only
  // identity allowed to use the local pool once session mode has engaged.
  // The pin is committed only when the first fallback request actually
  // succeeds, so a transient identity sending an invalid request cannot
  // lock out the real caller (issue #270).
  private localSessionIdentity?: string;
  // Bypass/local session for initEnv/resetEnv/stepEnv. Before IPC
  // client-session mode begins, requests can use it so programmatic init
  // followed by IPC reset/step keeps working.
  private localSession: PoolSession;
  // An adopted pool belongs to its enclosing BonkEnv. In this mode every
  // client routes to the same initialized host session; standalone bridges
  // continue to give each client its own pool (issues #193 and #223).
  private _hostPool: boolean = false;
  private _hostConfig: any = null;
  private _hostUseSharedMemory: boolean | undefined = undefined;
  // Owner callback invoked when an adopted pool fails and the bridge rebuilds
  // a fresh pool for IPC clients (see adoptPool / recoverFailedHostPool).
  private _onHostPoolFailed?: (pool: WorkerPool) => void;
  private _boundResolve: (() => void) | null = null;
  private _boundReject: ((reason?: any) => void) | null = null;
  private boundEndpoint: string | null = null;
  private closePromise: Promise<void> | null = null;

  // Current bind signal for this serve cycle. Replaced on every start()
  // (see rearmReady) so a restart after close() resolves/rejects a fresh
  // promise instead of the stale, already-resolved first-bind one (#263).
  private _ready: Promise<void> = new Promise<void>((resolve, reject) => {
    this._boundResolve = resolve;
    this._boundReject = reject;
  });

  /**
   * Resolves once the current serve cycle's ZMQ Router socket is bound and
   * accepting connections, and rejects if the bind fails. Embedders that
   * drive the serve loop without awaiting start() (which only exits on
   * close()) can await this to know when the advertised port is actually
   * reachable. Re-armed per start(), so awaiting it after a close() +
   * start() restart reflects the new bind (issue #263).
   */
  get ready(): Promise<void> {
    return this._ready;
  }

  /**
   * Replace the one-shot `ready` signal with a fresh promise for the next
   * serve cycle. A ZMQ bind can only settle a promise once, so a restart
   * after close() must observe a new promise (issue #263). The rejection is
   * swallowed for the same reason as in the constructor: consumers such as
   * src/server.ts never await ready, so a bind failure must not surface as
   * an unhandled rejection.
   */
  private rearmReady(): void {
    this._ready = new Promise<void>((resolve, reject) => {
      this._boundResolve = resolve;
      this._boundReject = reject;
    });
    this._ready.catch(() => {});
  }
  // Single-flight guard covering the entire post-step telemetry unit
  // (snapshot fetch through report). Prevents overlapping snapshot fetches
  // or duplicate reports when a second boundary step arrives during the
  // async fetch (issue #237). Re-armed in `finally` so a failed/slow fetch
  // can never leak the guard and silently disable future reports.
  private telemetryInFlight: boolean = false;

  constructor(config?: DeepPartial<AppConfig>) {
    const loadedConfig = getConfig();
    this.port = config?.server?.port ?? loadedConfig.server.port;
    this.bindAddress = IpcBridge.normalizeBindAddress(config?.server?.bindAddress ?? loadedConfig.server.bindAddress);
    // A cap below 1 is meaningless: clamp so a bad config loudly enforces
    // a single concurrent session instead of rejecting every init. A
    // missing/non-finite value (e.g. a partial mock config, or empty
    // string env overrides) falls back to the loader-provided default
    // instead of producing NaN or clamping to 1, and numeric strings from
    // env-style configs are honored like real numbers. The cap is an
    // integer count of concurrent sessions, so a fractional value is
    // floored (1.5 → 1, 2.5 → 2) rather than silently relaxing the bound
    // by Math.ceil (issue #259).
    const rawCap: unknown = config?.server?.maxClientSessions ?? loadedConfig.server.maxClientSessions;
    const parsedCap = typeof rawCap === 'string' ? (rawCap.trim() === '' ? NaN : Number(rawCap)) : rawCap;
    this.maxClientSessions = Number.isFinite(parsedCap as number)
      ? Math.floor(Math.max(1, parsedCap as number))
      : DEFAULT_MAX_CLIENT_SESSIONS;

    const loadedIpc: Partial<AppConfig['ipc']> = (loadedConfig as Partial<AppConfig>).ipc ?? {};
    // socketType/serialization are loader-validated and documented, but the
    // wire contract IpcBridge serves is fixed at ROUTER + json. Alternate
    // values are parsed for forward compatibility and ignored here rather
    // than throwing during server.ts / bonk-env.ts initialization (which
    // would turn previously-ignored documented values into a startup crash).
    this.socketOptions = {
      sendHighWaterMark: IpcBridge.normalizeSocketOption(
        config?.ipc?.sndHwm ?? loadedIpc.sndHwm,
        1000,
        0,
        'ipc.sndHwm',
      ),
      receiveHighWaterMark: IpcBridge.normalizeSocketOption(
        config?.ipc?.rcvHwm ?? loadedIpc.rcvHwm,
        1000,
        0,
        'ipc.rcvHwm',
      ),
      tcpKeepalive: IpcBridge.normalizeSocketOption(
        config?.ipc?.tcpKeepalive ?? loadedIpc.tcpKeepalive,
        0,
        0,
        'ipc.tcpKeepalive',
        (value) => value === 0 || value === 1,
      ),
      linger: IpcBridge.normalizeSocketOption(config?.ipc?.lingerMs ?? loadedIpc.lingerMs, 1000, 0, 'ipc.lingerMs'),
      backlog: IpcBridge.normalizeSocketOption(
        config?.server?.zmqBacklog ?? loadedConfig.server.zmqBacklog,
        100,
        1,
        'server.zmqBacklog',
      ),
    };
    this.sock = this.createSocket();
    this.localSession = {
      pool: new WorkerPool(),
      initialized: false,
      numEnvs: 0,
      lastActivityAt: Date.now(),
      activeRequests: 0,
    };

    // Create a wrapped send function for telemetry (can't overwrite the built-in send property in newer ZeroMQ)
    this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));

    // The standalone server path awaits only bridge.start(). When the
    // bind fails, both start() and ready reject; mark ready's rejection
    // as handled so it cannot surface as an unhandled-rejection crash for
    // consumers (such as src/server.ts) that never await ready.
    this._ready.catch(() => {});
  }

  private static normalizeSocketOption(
    raw: unknown,
    fallback: number,
    minimum: number,
    name: string,
    predicate: (value: number) => boolean = (value) => value >= minimum,
  ): number {
    const value = typeof raw === 'string' ? (INTEGER_NUMERIC_RE.test(raw.trim()) ? Number(raw.trim()) : NaN) : raw;
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > MAX_ZMQ_OPTION || !predicate(value)) {
      throw new Error(`Invalid ${name}: expected a safe integer in the documented range`);
    }
    return value;
  }

  private createSocket(): zmq.Router {
    return new zmq.Router(this.socketOptions);
  }

  private markBound(): void {
    if (this._boundResolve) {
      this._boundResolve();
      this._boundResolve = null;
      this._boundReject = null;
    }
  }

  private markBindFailed(err: unknown): void {
    if (this._boundReject) {
      this._boundReject(err);
      this._boundResolve = null;
      this._boundReject = null;
    }
  }

  /**
   * The canonical error for a start() cancelled by a concurrent close():
   * rejected on BOTH the start() promise and the current ready signal so
   * awaiting callers observe one consistent outcome instead of a resolved
   * start wedged against a rejected ready (#402).
   */
  private closedDuringStartError(): Error {
    const err = new Error('bridge was closed during start');
    err.name = 'BridgeClosedDuringStart';
    return err;
  }

  /**
   * Normalize a configured bind address into a ZMQ endpoint-ready host.
   * Empty/whitespace values fall back to the loopback default; `*` (the
   * libzmq all-interfaces wildcard) passes through; bare IPv6 literals are
   * wrapped in the brackets the tcp:// endpoint syntax requires. Everything
   * else must be a valid IPv4 address, a valid IPv6 literal, or a DNS /
   * interface name (underscores tolerated, at least one alphanumeric
   * character) — malformed values (e.g. a host:port mistake, out-of-range
   * dotted-numeric octets, purely numeric or underscore-only labels) fail
   * loudly at construction instead of surfacing as an opaque bind() error
   * (issue #235).
   */
  private static normalizeBindAddress(raw: string | undefined): string {
    const addr = (raw ?? '').trim();
    if (addr.length === 0) {
      return '127.0.0.1';
    }
    if (addr === '*') {
      // libzmq wildcard: bind to all available interfaces.
      return addr;
    }
    let bare = addr;
    if (addr.startsWith('[') && addr.endsWith(']')) {
      bare = addr.slice(1, -1);
    }
    const ipKind = net.isIP(bare);
    if (ipKind === 6) {
      return `[${bare}]`;
    }
    if (ipKind === 4) {
      return bare;
    }
    // All-dotted-numeric values that net.isIP rejected (1.2.3.4.5,
    // 999.999.999.999) are malformed IPv4s, not hostnames.
    if (/^\d+(\.\d+)+$/.test(bare)) {
      throw new Error(`Invalid server.bindAddress "${raw}": not a valid IPv4 address.`);
    }
    // A purely numeric label (999, 12345) is neither an IP nor a usable
    // hostname for binding.
    if (/^\d+$/.test(bare)) {
      throw new Error(`Invalid server.bindAddress "${raw}": not a valid IPv4 address.`);
    }
    // DNS / interface name: `[a-zA-Z0-9_-]` labels joined by dots, with
    // at least one alphanumeric character so a bare `_`/`-` is rejected.
    // Anything else — semicolons, whitespace, a trailing :port — is also
    // rejected rather than silently producing an invalid bind endpoint.
    if (/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(bare) && /[a-zA-Z0-9]/.test(bare)) {
      return bare;
    }
    throw new Error(`Invalid server.bindAddress "${raw}": expected an IPv4/IPv6 address, hostname, or '*' (no port).`);
  }

  /**
   * The local/bypass worker pool (used by initEnv/resetEnv/stepEnv). In
   * host-pool mode this is the adopted BonkEnv pool.
   */
  get pool(): WorkerPool {
    return this.localSession.pool;
  }

  // Wrapped send function for telemetry
  private _wrappedSend: Function;

  async start() {
    // Re-arm `ready` before waiting for a prior close to finish. Callers
    // can read the new readiness promise immediately after invoking
    // start(), even while the previous socket is still unbinding.
    this.rearmReady();
    if (this.closePromise) {
      const previousClose = this.closePromise;
      try {
        await previousClose;
      } catch (error) {
        // A rejected close was already surfaced to that close()
        // caller. Never re-throw it here: a restart must still attempt
        // its fresh bind so the re-armed ready promise settles, instead
        // of hanging every bridge.ready awaiter forever and wedging
        // same-instance restarts on a stale rejection (#316).
        console.error('[IPC] Prior close failed; proceeding with restart:', error);
      } finally {
        if (this.closePromise === previousClose) {
          this.closePromise = null;
        }
      }
    }

    const addr = `tcp://${this.bindAddress}:${this.port}`;
    // A closed ZMQ socket is permanently destroyed and can never be
    // re-bound (bind() throws "Socket is closed"). Recreate the transport
    // so a later start() after close() binds a fresh ROUTER and serves
    // again (issue #263): re-wrap the send function on the new socket.
    if (this.sock.closed) {
      this.sock = this.createSocket();
      this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));
    }
    // Snapshot BEFORE awaiting bind: on a restart after close() (#263/#316)
    // _closed is still true from the previous cycle until the post-bind reset
    // below, so testing _closed alone would misclassify every genuine restart
    // bind failure (e.g. EADDRINUSE) as a cancelled start AND skip the #326
    // cleanup, leaking the freshly recreated Router. During a restart's
    // in-flight bind a concurrent close() is itself a no-op (the teardown
    // early-returns while _closed is set), so only a close that FLIPS _closed
    // during THIS cycle (first starts) or an externally destroyed socket
    // (sock.closed) is a cancellation; every other rejection here is genuine.
    const closedBeforeBind = this._closed;
    try {
      await this.sock.bind(addr);
    } catch (err) {
      // A concurrent close()/stopServer() can destroy the ROUTER while the
      // bind is still in flight: close() sees boundEndpoint === null, skips
      // unbind, and closes the socket synchronously. The pending native bind
      // then rejects with libzmq's opaque "Socket operation on non-socket"
      // (EBADF-equivalent) — an intentional shutdown misreported as a
      // startup failure (#402). Surface the same distinguishable error as
      // the post-bind guard below so start() and ready always agree and
      // library internals never leak to callers; the concurrent close()
      // already destroyed (or is destroying) the handle, so skip the #326
      // failed-bind cleanup here.
      if ((this._closed && !closedBeforeBind) || this.sock.closed) {
        const closedDuringStart = this.closedDuringStartError();
        this.markBindFailed(closedDuringStart);
        throw closedDuringStart;
      }
      this.markBindFailed(err);
      // A bind that never succeeded leaves the ROUTER handle open. Close
      // it for both first starts and restart attempts; a later start()
      // recreates a closed socket before retrying (issue #326).
      try {
        this.sock.close();
      } catch {
        // Preserve the original bind error if socket cleanup fails.
      }
      throw err;
    }
    // libzmq resolves wildcard binds to a concrete endpoint (for example,
    // tcp://0.0.0.0:<port>). Keep that resolved value because unbind()
    // requires the endpoint returned by lastEndpoint, not the original
    // tcp://*:<port> request.
    //
    // A concurrent close()/stopServer() can destroy the very ROUTER this
    // start() just bound: close() sees boundEndpoint === null, skips
    // unbind, and closes the socket synchronously while start() is
    // suspended at the bind await. Reading lastEndpoint on the destroyed
    // socket makes libzmq throw "Socket operation on non-socket"
    // (EBADF-equivalent), and because that happens outside the bind
    // try/catch above, start() would reject with an opaque error while
    // bridge.ready stayed pending forever (#402). On shutdown-during-start,
    // reject BOTH start() and ready with the same clear, distinguishable
    // error so awaiting callers observe one consistent outcome and the
    // cancelled cycle never claims it ever bound.
    if (this.sock.closed) {
      const closedDuringStart = this.closedDuringStartError();
      this.markBindFailed(closedDuringStart);
      throw closedDuringStart;
    }

    let endpoint: string;
    try {
      endpoint = this.sock.lastEndpoint ?? addr;
    } catch (err) {
      // Same snapshot discipline as the bind catch above: only a close that
      // flipped _closed during THIS cycle (or a destroyed socket) is a
      // cancellation; on a restart the stale _closed must not swallow a
      // genuine read failure (#402).
      if ((this._closed && !closedBeforeBind) || this.sock.closed) {
        const closedDuringStart = this.closedDuringStartError();
        this.markBindFailed(closedDuringStart);
        throw closedDuringStart;
      }
      this.markBindFailed(err);
      throw err;
    }

    // From here to markBound() there is no await, so no close() can
    // interleave: once the fresh (or recreated) ROUTER read its endpoint,
    // resetting _closed is the legitimate restart-after-close handoff, not
    // an un-close of a shutdown that happened in flight (#402, #263).
    this.boundEndpoint = endpoint;
    console.log(`[IPC] Bound ZMQ Router socket to ${addr}`);
    this._closed = false;
    // The reaper runs in every mode, including adopted-host mode. BonkEnv
    // adopts its pool before calling start(), so gating the timer on
    // !_hostPool would leave host-mode failure recovery unreachable and,
    // after a recovery un-adopts the host pool, would leave future client
    // sessions unreaped until process restart (#400 review).
    this.startSessionReaper();
    this.markBound();

    // Wait for incoming requests from Python
    try {
      for await (const frames of this.sock) {
        if (this._closed) break;
        const identity = frames[0];
        const msg = frames[frames.length - 1];
        // Exactly 3 frames with an empty middle frame is REQ's wire
        // signature ([identity, "", payload]): libzmq's REQ state
        // machine silently discards any reply that does not re-echo
        // that empty delimiter, so mirror the request envelope on
        // every reply (#410). Anything else — DEALER peers including
        // multi-frame payloads — keeps the plain [identity, payload].
        const reqEnvelope = frames.length === 3 && frames[1].length === 0;
        await this.handleRequest(identity, msg.toString(), { reqEnvelope });
      }
    } catch (err: any) {
      // Ignore errors during shutdown
      if (!this._closed) {
        console.error('[IPC] Error in server loop:', err);
      }
    }
  }

  /**
   * Resolve the pool a request should be routed to:
   * - an identity with an active session uses its own pool;
   * - after an IPC `init`, any identity without an active session gets no
   *   pool (reset/step fail loudly rather than borrowing another pool);
   * - before any IPC `init`, an identity can use the local/bypass session;
   *   an identity that used it while initialized retains that access after
   *   session mode begins, preserving an established programmatic caller.
   */
  private resolveSession(sessionKey: string): { session?: PoolSession; pinnedToOtherIdentity?: boolean } {
    // An adopted host pool is intentionally shared by all IPC identities.
    // It is already initialized by BonkEnv before the bridge starts, and
    // clients cannot own or reap child pools in this mode.
    if (this._hostPool) {
      return { session: this.localSession };
    }
    const session = this.sessions.get(sessionKey);
    if (session) {
      return { session };
    }
    // Only the single pinned programmatic caller may use the local pool
    // once IPC session mode has engaged; every other without a session
    // fails loudly rather than silently borrowing another pool.
    if (this.localSessionIdentity === sessionKey) {
      return { session: this.localSession };
    }
    if (this.allowLocalSessionFallback && this.localSession.initialized) {
      if (this.localSessionIdentity === undefined) {
        // Provisionally grant the local pool, but do not pin this
        // identity yet: the pin is committed only once the request
        // actually succeeds, so a transient identity sending an
        // invalid request cannot permanently lock out the real
        // programmatic caller (issue #270).
        return { session: this.localSession };
      }
      // First-wins: the local pool is already pinned to another
      // pre-init identity. Report a distinct signal so callers reject
      // loudly instead of appearing to have no pool at all.
      return { pinnedToOtherIdentity: true };
    }
    return this.allowLocalSessionFallback ? { session: this.localSession } : {};
  }

  /**
   * Commit the bypass pin for `sessionKey` after its request on the
   * local/bypass pool succeeded. The pin is intentionally committed only
   * on success: claiming it on request arrival would let a transient
   * identity with an invalid request lock out the real caller (issue #270).
   */
  private commitLocalSessionPin(sessionKey: string, session: PoolSession): void {
    if (session === this.localSession && this.allowLocalSessionFallback && this.localSessionIdentity === undefined) {
      this.localSessionIdentity = sessionKey;
    }
  }

  private startSessionReaper(): void {
    if (this.sessionReapTimer) {
      return;
    }
    this.sessionReapTimer = setInterval(() => {
      void this.reapExpiredSessions();
    }, CLIENT_SESSION_REAP_INTERVAL_MS);
    this.sessionReapTimer.unref?.();
  }

  private async reapExpiredSessions(now = Date.now()): Promise<void> {
    if (this.sessionReapInProgress) {
      return this.sessionReapInProgress;
    }

    const expiredSessions: PoolSession[] = [];
    for (const [sessionKey, session] of this.sessions) {
      // A pool that failed asynchronously (worker crash/exit or a post-signal
      // error between requests) can never serve again, so reap its session
      // proactively instead of holding the maxClientSessions slot until the
      // idle timeout or the next request's reactive drop. Healthy sessions
      // keep the idle-timeout policy, and an in-flight request keeps its
      // session alive until it settles (and runs its own reactive cleanup).
      const failed = session.pool.isFailed();
      if (session.activeRequests === 0 && (failed || now - session.lastActivityAt >= CLIENT_SESSION_IDLE_TIMEOUT_MS)) {
        // Remove before awaiting close so a returning client must
        // explicitly re-init rather than racing a closing pool.
        this.sessions.delete(sessionKey);
        expiredSessions.push(session);
      }
    }

    // The adopted HOST session is not in the sessions map, so the loop above
    // can never see it. A dead host pool wedges every sharing IPC client
    // forever ("worker pool is in failed state"), so the reaper performs the
    // same proactive recovery here that map sessions got above.
    if (this._hostPool && this.localSession.activeRequests === 0 && this.localSession.pool.isFailed()) {
      await this.recoverFailedHostPool();
    }

    const reaping = Promise.all(
      expiredSessions.map(async (session) => {
        try {
          await session.pool.close();
        } catch (error) {
          console.error('[IPC] Error closing idle client session:', error);
        }
      }),
    ).then(() => undefined);
    this.sessionReapInProgress = reaping;
    try {
      await reaping;
    } finally {
      this.sessionReapInProgress = undefined;
    }
  }

  private beginSessionRequest(session: PoolSession): void {
    session.activeRequests++;
    session.lastActivityAt = Date.now();
  }

  private endSessionRequest(session: PoolSession): void {
    session.activeRequests--;
    session.lastActivityAt = Date.now();
  }

  /**
   * Drop a client session whose WorkerPool was left in the failed state by a
   * step/reset (shared-memory timeout, worker crash/exit, or a post-signal
   * error). A pool that fails after init is as unusable as one that fails
   * during initialization, so mirror the init-failure cleanup: evict the
   * session and free its workers so a dead pool cannot hold a
   * maxClientSessions slot or fail every retry until the idle reaper.
   * Transient per-request errors (message-mode error replies, shared-mode
   * ACTION_ENCODE) leave the pool ready and never reach here. Session mode
   * stays engaged (the local/bypass fallback is not restored), matching the
   * init-failure rationale: evicting a client must never re-admit it to the
   * local/bypass pool.
   */
  private async dropFailedPoolSession(sessionKey: string, session: PoolSession): Promise<void> {
    if (session === this.localSession) {
      // An adopted host pool never enters the sessions map and the host owns
      // its lifecycle, so the map-based eviction below cannot apply — but a
      // failed host pool wedges every sharing IPC client forever. Recover
      // the bridge instead of leaving it pinned to a corpse. A non-host
      // local/bypass failure stays untouched: programmatic callers own that
      // lifecycle and may be driving it directly.
      if (this._hostPool) {
        await this.recoverFailedHostPool();
      }
      return;
    }
    if (this.sessions.get(sessionKey) !== session) {
      return;
    }
    if (!session.pool.isFailed()) {
      return;
    }
    this.sessions.delete(sessionKey);
    try {
      await session.pool.close();
    } catch (closeError) {
      console.error('[IPC] Error closing failed client session:', closeError);
    }
  }

  /**
   * Recover the bridge from an adopted HOST pool that failed after init
   * (worker timeout, crash/exit, or a post-signal error). The host session is
   * not in the sessions map, so neither the reactive map eviction nor the
   * idle reaper can free it: every sharing IPC client would fail forever with
   * "worker pool is in failed state" until the process restarts. A failed
   * pool's workers are already terminated by its own failure cleanup, so
   * closing it here cannot steal a live lifecycle from the host BonkEnv —
   * unlike close(), which must never close a healthy adopted pool. After
   * closing the corpse, un-adopt so the next matching-count init builds a
   * fresh bridge-owned pool and shared clients recover with a plain re-init.
   * The owner is notified through the onHostPoolFailed hook registered at
   * adoption (plus a loud log), so its retained reference being orphaned is
   * never silent. The stale check keeps concurrent recovery passes
   * idempotent: the reaper and a request's reactive cleanup can interleave
   * at await points, and only a pass that still observes the original pool
   * may flip the adoption state.
   */
  private async recoverFailedHostPool(): Promise<void> {
    const session = this.localSession;
    const pool = session.pool;
    if (!pool.isFailed()) {
      return;
    }
    try {
      await pool.close();
    } catch (closeError) {
      console.error('[IPC] Error closing failed host pool:', closeError);
    }
    if (session.pool !== pool) {
      // Another recovery pass (or a rebuild) got here first; do not clobber
      // whatever now occupies the host slot.
      return;
    }
    // Do not orphan the owner silently: BonkEnv keeps its own pool reference
    // for direct step()/reset()/getPool() use, and that reference now points
    // at a closed corpse while IPC clients get the rebuilt pool.
    console.warn(
      '[IPC] Adopted host pool failed; rebuilding a fresh bridge-owned pool for IPC clients. The owner retains the dead pool reference until it re-acquires or restarts.',
    );
    if (this._onHostPoolFailed) {
      try {
        this._onHostPoolFailed(pool);
      } catch (hookError) {
        console.error('[IPC] onHostPoolFailed handler threw:', hookError);
      }
    }
    session.initialized = false;
    session.numEnvs = 0;
    session.lastActivityAt = Date.now();
    this._hostPool = false;
    this._hostConfig = null;
    this._hostUseSharedMemory = undefined;
    this.localSessionIdentity = undefined;
    session.pool = new WorkerPool();
  }

  /**
   * Build the reply frames for a client. REQ peers require the empty
   * delimiter frame they sent to be echoed ([identity, "", payload]) or
   * their socket state machine silently drops the reply while the request
   * has already executed; DEALER peers take the plain [identity, payload]
   * pair (issue #410).
   */
  private replyFrames(identity: Buffer, payload: string, reqEnvelope: boolean): (Buffer | string)[] {
    return reqEnvelope ? [identity, '', payload] : [identity, payload];
  }

  async handleRequest(identity: Buffer, rawMsg: string, options: { reqEnvelope?: boolean } = {}) {
    const reqEnvelope = options.reqEnvelope ?? false;
    let response: any;
    // Step responses are serialized eagerly so the borrowed pool graph is
    // consumed before the telemetry branch awaits worker replies.
    let serialized: string | null = null;
    // True once the step reply was transmitted eagerly ahead of the
    // post-step telemetry block, so the trailing send below is skipped.
    let replied = false;
    // Sessions are keyed by the client's ZMQ routing identity so every
    // request is applied to that client's own pool only (issue #193).
    const sessionKey = identity.toString('hex');
    let activeSession: PoolSession | undefined;
    try {
      const payload = parseJson(rawMsg);
      const command = payload.command;

      if (command === 'init') {
        let numEnvs = payload.numEnvs;
        if (typeof numEnvs === 'string' && /^\d+$/.test(numEnvs)) {
          numEnvs = Number(numEnvs);
        }
        if (typeof numEnvs !== 'number' || !Number.isInteger(numEnvs) || numEnvs < 1) {
          response = { status: 'error', error: 'Invalid numEnvs: must be a positive integer' };
        } else if (numEnvs > MAX_NUM_ENVS) {
          // Reject oversized counts up front so one malformed init
          // request can never stall the serial serve loop: a pool
          // init for a huge count would hang message mode for the
          // full messageTimeoutMs or throw an opaque RangeError in
          // shared mode (#390). Naming the bound tells the client
          // immediately that numEnvs (not the worker) was invalid.
          response = {
            status: 'error',
            error: `Invalid numEnvs: expected an integer in [1, ${MAX_NUM_ENVS}], got ${numEnvs}`,
          };
        } else if (this._hostPool) {
          // The pool was adopted from an enclosing BonkEnv and is
          // already initialized with that env's numEnvs and config.
          // Never re-initialize it with client-default config (that
          // would discard the env-configured workers); accept an
          // init only when the requested env count matches.
          // A matching count must not silently discard settings the
          // env-owned pool cannot honor (#252): echo the effective
          // config/useSharedMemory so the client can detect any
          // divergence from what is actually serving. useSharedMemory
          // is transport-internal to this server's workers and never
          // changes the JSON contract, so a mismatched client value
          // (e.g. the Python BonkVecEnv's hardcoded `true` against a
          // `false` host) must NOT be a hard error — the client only
          // consumes the JSON replies and keeps working.
          if (numEnvs === this.localSession.numEnvs) {
            activeSession = this.localSession;
            this.beginSessionRequest(this.localSession);
            response = {
              status: 'ok',
              config: this._hostConfig ?? {},
              useSharedMemory: this._hostUseSharedMemory,
            };
          } else {
            response = {
              status: 'error',
              error: `Invalid init: this IPC server hosts ${this.localSession.numEnvs} environment(s), got ${numEnvs}`,
            };
          }
        } else {
          const useSharedMemory = payload.useSharedMemory;
          const payloadCfg = payload.config || {};
          // One spawn config carries environment defaults, reward
          // weights, and engine tuning from the IPC client (#217, #220).
          const mergedConfig = resolveEnvironmentConfig(payloadCfg);
          const engineSections = mergeEngineSections(payloadCfg);
          console.log(
            `[IPC] Init request: numEnvs=${numEnvs}, config=${JSON.stringify(mergedConfig)}, useSharedMemory=${useSharedMemory}`,
          );
          // This init only (re)creates this client's own pool; if the
          // client reinitializes, WorkerPool.init() tears down that
          // same session's previous pool and nothing else.
          let session = this.sessions.get(sessionKey);
          if (!session) {
            await this.reapExpiredSessions();
            session = this.sessions.get(sessionKey);
          }
          if (!session) {
            if (this.sessions.size >= this.maxClientSessions) {
              response = {
                status: 'error',
                error: `Too many active client sessions (max ${this.maxClientSessions}): close an existing session before initializing a new one`,
              };
            } else {
              session = {
                pool: new WorkerPool(),
                initialized: false,
                numEnvs: 0,
                lastActivityAt: Date.now(),
                activeRequests: 0,
              };
              this.sessions.set(sessionKey, session);
              // IPC clients are permanently isolated from the
              // local bypass pool once a session is owned. A
              // boolean mode flag avoids an unbounded tombstone
              // set for invalid clients.
              if (this.localSessionIdentity === sessionKey) {
                this.localSessionIdentity = undefined;
              }
              this.allowLocalSessionFallback = false;
            }
          }
          if (session) {
            activeSession = session;
            this.beginSessionRequest(session);
            try {
              await session.pool.init(numEnvs, { ...mergedConfig, ...engineSections }, useSharedMemory);
              session.initialized = true;
              session.numEnvs = numEnvs;
              response = { status: 'ok' };
            } catch (error) {
              // A pool that fails initialization is not
              // usable, so drop the session (whether it was
              // just created or is a re-init of an existing
              // one) and free its workers. Retaining an
              // invalidated existing session would let a
              // persistently failing init hold a client-cap
              // slot forever.
              if (this.sessions.get(sessionKey) === session) {
                this.sessions.delete(sessionKey);
                try {
                  await session.pool.close();
                } catch (closeError) {
                  console.error('[IPC] Error closing failed client session:', closeError);
                }
              }
              // The session map is empty again, but session
              // mode stays engaged (fallback is not
              // blanket-restored): evicting a client must
              // never re-admit it to the local/bypass pool.
              // Only the single pinned programmatic caller is
              // allowed there, and the bridge is not
              // deadlocked — a new identity can still init.
              throw error;
            }
          }
        }
      } else if (command === 'reset') {
        const resolution = this.resolveSession(sessionKey);
        const session = resolution.session;
        if (session) {
          activeSession = session;
          this.beginSessionRequest(session);
        }
        if (resolution.pinnedToOtherIdentity) {
          response = { status: 'error', error: LOCAL_SESSION_PINNED_ERROR };
        } else if (!session || !session.initialized) {
          response = { status: 'error', error: 'Worker pool not initialized' };
        } else if (payload.seeds !== undefined && !Array.isArray(payload.seeds)) {
          response = { status: 'error', error: 'Invalid seeds: must be an array' };
        } else if (payload.seeds !== undefined && payload.seeds.length > session.numEnvs) {
          // Reject an over-long seed batch before any pool state is
          // touched, mirroring the pool-level check: surplus seeds
          // would otherwise be silently dropped in both transports.
          // Short seed lists stay legal (tail envs reset unseeded).
          const n = session.numEnvs;
          response = {
            status: 'error',
            error: `Invalid seeds: expected at most ${n} seed${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${payload.seeds.length}`,
          };
        } else {
          console.log(`[IPC] Reset request: seeds=${payload.seeds ? payload.seeds.length : 0}`);
          // JSON serialization below is the ownership boundary, so
          // avoid an otherwise redundant snapshot allocation here.
          const obs = await session.pool.reset(payload.seeds, { ownership: 'borrowed' });
          this.commitLocalSessionPin(sessionKey, session);
          console.log(`[IPC] Reset response: obs is ${Array.isArray(obs) ? 'array of length ' + obs.length : obs}`);
          response = {
            status: 'ok',
            data: {
              observation: obs,
            },
          };
        }
      } else if (command === 'step') {
        const resolution = this.resolveSession(sessionKey);
        const session = resolution.session;
        if (session) {
          activeSession = session;
          this.beginSessionRequest(session);
        }
        const actions = payload.actions;
        if (resolution.pinnedToOtherIdentity) {
          response = { status: 'error', error: LOCAL_SESSION_PINNED_ERROR };
        } else if (!Array.isArray(actions)) {
          response = { status: 'error', error: 'Invalid actions: must be an array' };
        } else if (actions.length === 0) {
          response = { status: 'error', error: 'Invalid actions: array cannot be empty' };
        } else if (!session || !session.initialized) {
          response = { status: 'error', error: 'Worker pool not initialized' };
        } else if (actions.length !== session.numEnvs) {
          // Reject a wrong-sized batch before any pool state is
          // touched, mirroring the Python client's exact-count
          // check. A short array must not reach the pool as an
          // encoding error that could fail it in shared-memory mode.
          const n = session.numEnvs;
          response = {
            status: 'error',
            error: `Invalid actions: expected ${n} action${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${actions.length}`,
          };
        } else {
          // Requests are serialized by the server loop, and the
          // borrowed graph below is only valid until the next pool
          // call, so serialize it before the telemetry branch awaits.
          const results = await session.pool.step(actions, { ownership: 'borrowed' });
          this.commitLocalSessionPin(sessionKey, session);

          // JSON.stringify is the ownership boundary: it consumes the
          // borrowed `_convertedResults` graph immediately, before any
          // await in the telemetry branch below could let another
          // request (or a future pool reset/step there) mutate it.
          serialized = JSON.stringify({ status: 'ok', data: results });

          this.stepCount++;
          globalProfiler.tick();

          // Issue #237: the TelemetryController drives the report
          // cadence from the configured reportIntervalMs instead of
          // the old hardcoded 5000-step boundary.
          const reportDue = getTelemetryController().tick();
          if (reportDue && isTelemetryControllerEnabled()) {
            // Issue #229: the completed step's reply must be
            // transmitted before any best-effort telemetry work and
            // must never await it. A slow or failing snapshot fetch
            // (up to messageTimeoutMs in message mode) must not
            // delay this reply or stall the single-threaded ZMQ
            // loop. The telemetry block runs detached below and
            // catches its own errors (see #185).
            try {
              await this._wrappedSend(this.replyFrames(identity, serialized, reqEnvelope));
            } catch (sendError) {
              // A send failure must not fabricate a step-error
              // reply for a step that already executed — the
              // client would retry and double-step it (the #185
              // hazard). Log and send nothing, matching the
              // trailing send's failure handling.
              console.error('[IPC] Error sending response:', sendError);
            }
            serialized = null;
            replied = true;
            // Keep the session off the idle-reap list until its
            // detached snapshot task has settled.
            this.beginSessionRequest(session);
            void this.runPostStepTelemetry(session.pool).finally(() => {
              this.endSessionRequest(session);
            });
          }
        }
      } else if (command === 'close') {
        if (payload.shutdown === true) {
          // Full server shutdown: close the Router after replying.
          response = { status: 'ok' };
          this._shouldClose = true;
        } else if (this._hostPool) {
          // Session close on an adopted pool: the host BonkEnv owns
          // the pool's lifecycle, and the pool (plus its global init
          // state) is shared by every connected DEALER client. A
          // single client ending its session must NOT clear that
          // global initialization, or every other active client's
          // next reset/step would fail with "Worker pool not
          // initialized" while the adopted pool stays alive. Treat a
          // session close here as a no-op: the shared, env-configured
          // pool keeps serving the remaining clients.
          response = { status: 'ok' };
        } else {
          // Session close (default): free this client's env state but
          // keep the server listening so other envs/tests on the same
          // server keep working. Only this client's pool is closed;
          // every other session is untouched (issue #193).
          const session = this.sessions.get(sessionKey);
          if (session) {
            activeSession = session;
            this.beginSessionRequest(session);
            this.sessions.delete(sessionKey);
            await session.pool.close();
          }
          response = { status: 'ok' };
        }
      } else {
        response = { status: 'error', error: `Unknown command: ${command}` };
      }
    } catch (e: any) {
      console.error('[IPC] Error handling request:', e);
      // A step/reset failure that left the pool in the failed state
      // (worker timeout, crash/exit, post-signal error) is fatal to that
      // session, exactly like an init failure: drop the session and close
      // its pool so a dead pool cannot hold a client-cap slot or fail
      // every retry until the idle reaper. Transient per-request errors
      // leave the pool ready, so this conservatively only ever removes
      // sessions whose pool can no longer serve.
      if (activeSession) {
        await this.dropFailedPoolSession(sessionKey, activeSession);
      }
      response = { status: 'error', error: e.message };
      serialized = null;
    }

    try {
      if (!replied) {
        try {
          await this._wrappedSend(this.replyFrames(identity, serialized ?? JSON.stringify(response), reqEnvelope));
        } catch (sendError) {
          console.error('[IPC] Error sending response:', sendError);
        }
      }

      if (this._shouldClose) {
        this._shouldClose = false;
        await this.close();
      }
    } finally {
      if (activeSession) {
        this.endSessionRequest(activeSession);
      }
    }
  }

  /**
   * Best-effort post-step telemetry: memory gauge, worker snapshot fetch,
   * and the interval report. Detached from the request path — it never
   * affects the step reply and cannot stall the ZMQ loop (issue #229).
   * Errors are caught and logged so a telemetry failure is never reported
   * as a step failure or discards an already-serialized reply (issue #185).
   * Its message-mode snapshot timeout is non-fatal, so detached telemetry
   * cannot fail a pool while another request is using it.
   */
  private async runPostStepTelemetry(pool: WorkerPool): Promise<void> {
    // A boundary step can arrive while an earlier fetch→report is still
    // awaiting getTelemetrySnapshots. Guard the whole unit so the second
    // step is a no-op: otherwise two overlapping fetches would run and the
    // controller's reportInFlight guard (which only wraps the synchronous
    // emit) would not stop the duplicate snapshot fetch (issue #237).
    if (this.telemetryInFlight) return;
    this.telemetryInFlight = true;
    try {
      globalProfiler.recordMemory();

      if (isTelemetryControllerEnabled()) {
        // getTelemetrySnapshots is non-blocking in shared-memory mode
        // (workers blocked in Atomics.wait cannot service
        // GET_TELEMETRY, so the pool returns an empty set
        // immediately) and performs a bounded worker round-trip in
        // message mode.
        const snapshots = await pool.getTelemetrySnapshots({ failOnTimeout: false });
        setLatestWorkerTelemetry(snapshots);
        getTelemetryController().reportNow();
      }
    } catch (telemetryError) {
      console.error('[IPC] Telemetry error after step:', telemetryError);
    } finally {
      this.telemetryInFlight = false;
    }
  }

  /**
   * Initialize the environment pool directly (bypassing IPC).
   * Used by BonkEnv for programmatic control.
   */
  async initEnv(numEnvs: number, config: any = {}, useSharedMemory?: boolean): Promise<void> {
    if (!Number.isInteger(numEnvs) || numEnvs < 1) {
      throw new Error('Invalid numEnvs: must be a positive integer');
    }
    if (numEnvs > MAX_NUM_ENVS) {
      throw new Error(`Invalid numEnvs: expected an integer in [1, ${MAX_NUM_ENVS}], got ${numEnvs}`);
    }
    await this.localSession.pool.init(numEnvs, config, useSharedMemory);
    this.localSession.initialized = true;
    this.localSession.numEnvs = numEnvs;
  }

  /**
   * Adopt an already-initialized WorkerPool owned by an enclosing host
   * (e.g. a BonkEnv). The IPC server then serves those env-configured
   * workers instead of spawning its own, so external clients share the
   * env's numEnvs/config/useSharedMemory rather than getting default
   * workers. The host keeps owning the pool's lifecycle.
   *
   * If the adopted pool later FAILS after init, the bridge closes the corpse
   * and un-admits it: IPC clients recover by rebuilding a fresh
   * bridge-owned pool via a plain re-init. The owner's own pool reference is
   * then orphaned on the closed pool, so `onHostPoolFailed` (invoked with
   * the dead pool, before the replacement) lets the owner react — log,
   * invalidate its reference, or restart. An owner handler must not throw;
   * throws are logged and swallowed so recovery always completes.
   */
  adoptPool(
    pool: WorkerPool,
    numEnvs: number,
    options: { config?: any; useSharedMemory?: boolean; onHostPoolFailed?: (pool: WorkerPool) => void } = {},
  ): void {
    if (this._hostPool || this.localSession.initialized || this.sessions.size > 0) {
      throw new Error('Cannot adopt a pool after the bridge pool has been initialized');
    }
    this.localSession.pool = pool;
    this.localSession.initialized = true;
    this.localSession.numEnvs = numEnvs;
    this.localSession.lastActivityAt = Date.now();
    this._hostPool = true;
    this._onHostPoolFailed = options.onHostPoolFailed;
    // Remember the host env's effective config and useSharedMemory so a
    // matching-count client init can be validated/echoed instead of
    // silently discarding the client's settings on an env-owned pool (#252).
    this._hostConfig = options.config ?? null;
    this._hostUseSharedMemory = options.useSharedMemory;
  }

  /**
   * Reset the environment directly (bypassing IPC).
   * Used by BonkEnv for programmatic control.
   */
  async resetEnv(seeds?: number[]): Promise<any[]> {
    return this.localSession.pool.reset(seeds);
  }

  /**
   * Step the environment directly (bypassing IPC).
   * Used by BonkEnv for programmatic control.
   */
  async stepEnv(actions: any[]): Promise<any[]> {
    return this.localSession.pool.step(actions);
  }

  /**
   * Get the port number.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the configured bind address (network interface to bind the ZMQ socket to).
   */
  getBindAddress(): string {
    return this.bindAddress;
  }

  /**
   * Check if the bridge is closed.
   */
  isClosed(): boolean {
    return this._closed;
  }

  /**
   * Close the IPC server: unbind the advertised endpoint first so the port
   * is released before the socket is destroyed (libzmq tears its TCP
   * listener down asynchronously on close), then close every owned pool.
   * Single-flight: concurrent close() calls share the same in-flight
   * promise, and the retained reference is dropped the moment the teardown
   * settles so a rejected close can never wedge later close()/start()
   * attempts on a stale rejection (#316).
   */
  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this._closed) {
      return Promise.resolve();
    }
    this._closed = true;
    if (this.sessionReapTimer) {
      clearInterval(this.sessionReapTimer);
      this.sessionReapTimer = undefined;
    }
    // Reset the local/bypass session so a later start() + restart leaves
    // fallback requests failing with "Worker pool not initialized" instead
    // of leaking the closed pool's internal error.
    this.localSession.initialized = false;
    this.localSession.numEnvs = 0;
    this.allowLocalSessionFallback = true;
    this.localSessionIdentity = undefined;

    // Close every standalone client session. An adopted host pool belongs
    // to BonkEnv, which closes it after the bridge; closing it here would
    // let a bridge shutdown steal the host's lifecycle.
    const pools = [...this.sessions.values()].map((session) => session.pool);
    if (!this._hostPool) {
      pools.unshift(this.localSession.pool);
    }
    this.sessions.clear();

    // libzmq closes its TCP listener asynchronously when the socket is
    // destroyed. Unbind the endpoint explicitly and await that operation
    // before closing the socket so callers do not release/reuse a port
    // while the old listener is still alive (#316). boundEndpoint is only
    // cleared once the unbind actually succeeds: a failed unbind leaves
    // the port possibly bound, and discarding that state here would
    // re-introduce the very race this await prevents.
    const endpoint = this.boundEndpoint;

    const teardown = (async () => {
      let failure: { error: unknown } | null = null;

      if (endpoint) {
        try {
          await this.sock.unbind(endpoint);
          if (this.boundEndpoint === endpoint) {
            this.boundEndpoint = null;
          }
        } catch (error) {
          failure = { error };
        }
      }

      // Close the socket to break out of the for await loop. A bind that
      // failed in start() already closed the ROUTER handle, so skip the
      // redundant second close when this shutdown follows a failed start
      // (#326; server.ts calls close() to roll back, and start()'s catch
      // already released the socket). Preserve the existing best-effort
      // handling for socket close errors, but do not hide an unbind or
      // worker-pool failure from the caller.
      if (!this.sock.closed) {
        try {
          this.sock.close();
        } catch (error) {
          // Ignore close errors.
        }
      }

      try {
        await Promise.all(pools.map((pool) => pool.close()));
      } catch (error) {
        if (!failure) {
          failure = { error };
        }
      }

      if (failure) {
        throw failure.error;
      }
    })();

    // Retain the in-flight promise only until it settles: a settled
    // (including rejected) close must not stay referenced and wedge every
    // later close()/start() on the same stale outcome.
    this.closePromise = teardown.finally(() => {
      this.closePromise = null;
    });

    return this.closePromise;
  }
}
