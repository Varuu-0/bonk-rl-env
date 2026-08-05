import * as zmq from "zeromq";
import { WorkerPool } from "../core/worker-pool";
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from "../telemetry/profiler";
import { isTelemetryEnabled as isTelemetryControllerEnabled } from '../telemetry/telemetry-controller';
import { getConfig, type AppConfig, type DeepPartial, mergeEnvironmentConfig } from '../config/config-loader';

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

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
}

export class IpcBridge {
    private sock: zmq.Router;
    private port: number;
    private stepCount: number = 0;
    private _closed: boolean = false;
    private _shouldClose: boolean = false;
    private readonly maxClientSessions: number;

    // Worker pools are owned per client: keyed by the ZMQ routing identity of
    // the client that called `init` (issue #193).
    private sessions: Map<string, PoolSession> = new Map();
    // Identities that have called `init` (and whose session may have since
    // been closed). A registered identity must never silently fall back to
    // another client's pool after closing its own session — only identities
    // that never called `init` fall back to the local/bypass session.
    private registeredIdentities: Set<string> = new Set();
    // Bypass/local session for initEnv/resetEnv/stepEnv. IPC requests from an
    // identity that never called `init` fall back to this session, so
    // programmatic init followed by IPC reset/step keeps working.
    private localSession: PoolSession;

    constructor(config?: DeepPartial<AppConfig>) {
        this.port = config?.server?.port ?? getConfig().server.port;
        this.maxClientSessions = config?.server?.maxClientSessions ?? getConfig().server.maxClientSessions;
        this.sock = new zmq.Router();
        this.localSession = { pool: new WorkerPool(), initialized: false, numEnvs: 0 };

        // Create a wrapped send function for telemetry (can't overwrite the built-in send property in newer ZeroMQ)
        this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));
    }

    /**
     * The local/bypass worker pool (used by initEnv/resetEnv/stepEnv). Kept as
     * a property so programmatic callers that bypass IPC get the pool the
     * constructor always created.
     */
    get pool(): WorkerPool {
        return this.localSession.pool;
    }

    // Wrapped send function for telemetry
    private _wrappedSend: Function;

    async start() {
        const addr = `tcp://127.0.0.1:${this.port}`;
        await this.sock.bind(addr);
        console.log(`[IPC] Bound ZMQ Router socket to ${addr}`);
        this._closed = false;

        // Wait for incoming requests from Python
        try {
            for await (const frames of this.sock) {
                if (this._closed) break;
                const identity = frames[0];
                const msg = frames[frames.length - 1];
                await this.handleRequest(identity, msg.toString());
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
     * - an identity that called `init` before but closed its session gets no
     *   pool (its reset/step fail loudly — the "Worker pool not initialized"
     *   contract) and must NOT silently fall back to another client's pool;
     * - a brand-new identity that never called `init` falls back to the
     *   local/bypass session (preserving programmatic init + IPC reset/step).
     */
    private resolveSession(sessionKey: string): PoolSession | undefined {
        const session = this.sessions.get(sessionKey);
        if (session) {
            return session;
        }
        if (this.registeredIdentities.has(sessionKey)) {
            return undefined;
        }
        return this.localSession;
    }

    async handleRequest(identity: Buffer, rawMsg: string) {
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
        try {
            const payload = parseJson(rawMsg);
            const command = payload.command;

            if (command === "init") {
                let numEnvs = payload.numEnvs;
                if (typeof numEnvs === 'string' && /^\d+$/.test(numEnvs)) {
                    numEnvs = Number(numEnvs);
                }
                if (typeof numEnvs !== 'number' || !Number.isInteger(numEnvs) || numEnvs < 1) {
                    response = { status: "error", error: "Invalid numEnvs: must be a positive integer" };
                } else {
                    const useSharedMemory = payload.useSharedMemory;
                    const envDefaults = getConfig().environment;
                    const mergedConfig = mergeEnvironmentConfig(envDefaults as any, payload.config || {});
                    console.log(`[IPC] Init request: numEnvs=${numEnvs}, config=${JSON.stringify(mergedConfig)}, useSharedMemory=${useSharedMemory}`);
                    // This init only (re)creates this client's own pool; if the
                    // client reinitializes, WorkerPool.init() tears down that
                    // same session's previous pool and nothing else.
                    let session = this.sessions.get(sessionKey);
                    if (!session) {
                        if (this.sessions.size >= this.maxClientSessions) {
                            // Bounds worker accumulation from clients that
                            // disconnect without a session `close`. Rejecting
                            // loudly beats silently evicting a live session.
                            response = {
                                status: "error",
                                error: `Too many active client sessions (max ${this.maxClientSessions}): close an existing session before initializing a new one`,
                            };
                        } else {
                            session = { pool: new WorkerPool(), initialized: false, numEnvs: 0 };
                            this.sessions.set(sessionKey, session);
                            this.registeredIdentities.add(sessionKey);
                        }
                    }
                    if (session) {
                        await session.pool.init(numEnvs, mergedConfig, useSharedMemory);
                        session.initialized = true;
                        session.numEnvs = numEnvs;
                        response = { status: "ok" };
                    }
                }
            } else if (command === "reset") {
                const session = this.resolveSession(sessionKey);
                if (!session || !session.initialized) {
                    response = { status: "error", error: "Worker pool not initialized" };
                } else if (payload.seeds !== undefined && !Array.isArray(payload.seeds)) {
                    response = { status: "error", error: "Invalid seeds: must be an array" };
                } else if (payload.seeds !== undefined && payload.seeds.length > session.numEnvs) {
                    // Reject an over-long seed batch before any pool state is
                    // touched, mirroring the pool-level check: surplus seeds
                    // would otherwise be silently dropped in both transports.
                    // Short seed lists stay legal (tail envs reset unseeded).
                    const n = session.numEnvs;
                    response = {
                        status: "error",
                        error: `Invalid seeds: expected at most ${n} seed${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${payload.seeds.length}`,
                    };
                } else {
                    console.log(`[IPC] Reset request: seeds=${payload.seeds ? payload.seeds.length : 0}`);
                    // JSON serialization below is the ownership boundary, so
                    // avoid an otherwise redundant snapshot allocation here.
                    const obs = await session.pool.reset(payload.seeds, { ownership: 'borrowed' });
                    console.log(`[IPC] Reset response: obs is ${Array.isArray(obs) ? 'array of length ' + obs.length : obs}`);
                    response = {
                        status: "ok",
                        data: {
                            observation: obs
                        }
                    };
                }
            } else if (command === "step") {
                const session = this.resolveSession(sessionKey);
                const actions = payload.actions;
                if (!Array.isArray(actions)) {
                    response = { status: "error", error: "Invalid actions: must be an array" };
                } else if (actions.length === 0) {
                    response = { status: "error", error: "Invalid actions: array cannot be empty" };
                } else if (!session || !session.initialized) {
                    response = { status: "error", error: "Worker pool not initialized" };
                } else if (actions.length !== session.numEnvs) {
                    // Reject a wrong-sized batch before any pool state is
                    // touched, mirroring the Python client's exact-count
                    // check. A short array must not reach the pool as an
                    // encoding error that could fail it in shared-memory mode.
                    const n = session.numEnvs;
                    response = {
                        status: "error",
                        error: `Invalid actions: expected ${n} action${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${actions.length}`,
                    };
                } else {
                    // Requests are serialized by the server loop, and the
                    // borrowed graph below is only valid until the next pool
                    // call, so serialize it before the telemetry branch awaits.
                    const results = await session.pool.step(actions, { ownership: 'borrowed' });

                    // JSON.stringify is the ownership boundary: it consumes the
                    // borrowed `_convertedResults` graph immediately, before any
                    // await in the telemetry branch below could let another
                    // request (or a future pool reset/step there) mutate it.
                    serialized = JSON.stringify({ status: "ok", data: results });

                    this.stepCount++;
                    globalProfiler.tick();

                    if (this.stepCount % 5000 === 0) {
                        // Issue #229: the completed step's reply must be
                        // transmitted before any best-effort telemetry work and
                        // must never await it. A slow or failing snapshot fetch
                        // (up to messageTimeoutMs in message mode) must not
                        // delay this reply or stall the single-threaded ZMQ
                        // loop. The telemetry block runs detached below and
                        // catches its own errors (see #185).
                        try {
                            await this._wrappedSend([identity, serialized]);
                        } catch (sendError) {
                            // A send failure must not fabricate a step-error
                            // reply for a step that already executed — the
                            // client would retry and double-step it (the #185
                            // hazard). Log and send nothing, matching the
                            // trailing send's failure handling.
                            console.error("[IPC] Error sending response:", sendError);
                        }
                        serialized = null;
                        replied = true;
                        void this.runPostStepTelemetry(session.pool);
                    }
                }
            } else if (command === "close") {
                if (payload.shutdown === true) {
                    // Full server shutdown: close the Router after replying.
                    response = { status: "ok" };
                    this._shouldClose = true;
                } else {
                    // Session close (default): free this client's env state but
                    // keep the server listening so other envs/tests on the same
                    // server keep working. Only this client's pool is closed;
                    // every other session is untouched (issue #193).
                    const session = this.sessions.get(sessionKey);
                    if (session) {
                        await session.pool.close();
                        this.sessions.delete(sessionKey);
                    }
                    response = { status: "ok" };
                }
            } else {
                response = { status: "error", error: `Unknown command: ${command}` };
            }
        } catch (e: any) {
            console.error("[IPC] Error handling request:", e);
            response = { status: "error", error: e.message };
            serialized = null;
        }

        if (!replied) {
            try {
                await this._wrappedSend([identity, serialized ?? JSON.stringify(response)]);
            } catch (sendError) {
                console.error("[IPC] Error sending response:", sendError);
            }
        }

        if (this._shouldClose) {
            this._shouldClose = false;
            await this.close();
        }
    }

    /**
     * Best-effort post-step telemetry: memory gauges, worker snapshot fetch,
     * and the heatmap report. Detached from the request path — it never
     * affects the step reply and cannot stall the ZMQ loop (issue #229).
     * Errors are caught and logged so a telemetry failure is never reported
     * as a step failure or discards an already-serialized reply (issue
     * #185); a message-mode snapshot timeout still fails the pool per
     * worker-pool semantics, surfacing on the next request.
     */
    private async runPostStepTelemetry(pool: WorkerPool): Promise<void> {
        try {
            globalProfiler.recordMemory();

            if (isTelemetryControllerEnabled()) {
                // getTelemetrySnapshots is non-blocking in shared-memory mode
                // (workers blocked in Atomics.wait cannot service
                // GET_TELEMETRY, so the pool returns an empty set
                // immediately) and performs a bounded worker round-trip in
                // message mode.
                const snapshots = await pool.getTelemetrySnapshots();
                setLatestWorkerTelemetry(snapshots);
                globalProfiler.report(5000);
            }
        } catch (telemetryError) {
            console.error('[IPC] Telemetry error after step:', telemetryError);
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
        await this.localSession.pool.init(numEnvs, config, useSharedMemory);
        this.localSession.initialized = true;
        this.localSession.numEnvs = numEnvs;
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
     * Check if the bridge is closed.
     */
    isClosed(): boolean {
        return this._closed;
    }

    async close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        // Reset the local/bypass session so a later start() + restart leaves
        // unregistered identities failing with "Worker pool not initialized"
        // instead of leaking the closed pool's internal error.
        this.localSession.initialized = false;
        this.localSession.numEnvs = 0;

        // Close every per-client session pool and the local/bypass pool. A
        // client's own session `close` only ever removed that session, so the
        // rest of the pools are cleaned up here on full server shutdown.
        const pools = [this.localSession.pool, ...[...this.sessions.values()].map(session => session.pool)];
        this.sessions.clear();
        this.registeredIdentities.clear();

        // Close the socket to break out of the for await loop
        try {
            this.sock.close();
        } catch (e) {
            // Ignore close errors
        }

        await Promise.all(pools.map(pool => pool.close()));
    }
}
