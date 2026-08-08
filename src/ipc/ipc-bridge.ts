import * as zmq from "zeromq";
import * as net from "net";
import { WorkerPool } from "../core/worker-pool";
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from "../telemetry/profiler";
import { isTelemetryEnabled as isTelemetryControllerEnabled, getTelemetryController } from '../telemetry/telemetry-controller';
import { getConfig, type AppConfig, type DeepPartial, mergeEnvironmentConfig } from '../config/config-loader';

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

export class IpcBridge {
    private sock: zmq.Router;
    private pool: WorkerPool;
    private port: number;
    private bindAddress: string;
    private stepCount: number = 0;
    private _closed: boolean = false;
    private _initialized: boolean = false;
    private _numEnvs: number = 0;
    private _shouldClose: boolean = false;
    // Single-flight guard covering the entire post-step telemetry unit
    // (snapshot fetch through report). Prevents overlapping snapshot fetches
    // or duplicate reports when a second boundary step arrives during the
    // async fetch (issue #237). Re-armed in `finally` so a failed/slow fetch
    // can never leak the guard and silently disable future reports.
    private telemetryInFlight: boolean = false;

    constructor(config?: DeepPartial<AppConfig>) {
        this.port = config?.server?.port ?? getConfig().server.port;
        this.bindAddress = IpcBridge.normalizeBindAddress(config?.server?.bindAddress ?? getConfig().server.bindAddress);
        this.sock = new zmq.Router();
        this.pool = new WorkerPool();

        // Create a wrapped send function for telemetry (can't overwrite the built-in send property in newer ZeroMQ)
        this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));
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

    // Wrapped send function for telemetry
    private _wrappedSend: Function;

    async start() {
        const addr = `tcp://${this.bindAddress}:${this.port}`;
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

    async handleRequest(identity: Buffer, rawMsg: string) {
        let response: any;
        // Step responses are serialized eagerly so the borrowed pool graph is
        // consumed before the telemetry branch awaits worker replies.
        let serialized: string | null = null;
        // True once the step reply was transmitted eagerly ahead of the
        // post-step telemetry block, so the trailing send below is skipped.
        let replied = false;
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
                    await this.pool.init(numEnvs, mergedConfig, useSharedMemory);
                    this._initialized = true;
                    this._numEnvs = numEnvs;
                    response = { status: "ok" };
                }
            } else if (command === "reset") {
                if (!this._initialized) {
                    response = { status: "error", error: "Worker pool not initialized" };
                } else if (payload.seeds !== undefined && !Array.isArray(payload.seeds)) {
                    response = { status: "error", error: "Invalid seeds: must be an array" };
                } else if (payload.seeds !== undefined && payload.seeds.length > this._numEnvs) {
                    // Reject an over-long seed batch before any pool state is
                    // touched, mirroring the pool-level check: surplus seeds
                    // would otherwise be silently dropped in both transports.
                    // Short seed lists stay legal (tail envs reset unseeded).
                    const n = this._numEnvs;
                    response = {
                        status: "error",
                        error: `Invalid seeds: expected at most ${n} seed${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${payload.seeds.length}`,
                    };
                } else {
                    console.log(`[IPC] Reset request: seeds=${payload.seeds ? payload.seeds.length : 0}`);
                    // JSON serialization below is the ownership boundary, so
                    // avoid an otherwise redundant snapshot allocation here.
                    const obs = await this.pool.reset(payload.seeds, { ownership: 'borrowed' });
                    console.log(`[IPC] Reset response: obs is ${Array.isArray(obs) ? 'array of length ' + obs.length : obs}`);
                    response = {
                        status: "ok",
                        data: {
                            observation: obs
                        }
                    };
                }
            } else if (command === "step") {
                const actions = payload.actions;
                if (!Array.isArray(actions)) {
                    response = { status: "error", error: "Invalid actions: must be an array" };
                } else if (actions.length === 0) {
                    response = { status: "error", error: "Invalid actions: array cannot be empty" };
                } else if (!this._initialized) {
                    response = { status: "error", error: "Worker pool not initialized" };
                } else if (actions.length !== this._numEnvs) {
                    // Reject a wrong-sized batch before any pool state is
                    // touched, mirroring the Python client's exact-count
                    // check. A short array must not reach the pool as an
                    // encoding error that could fail it in shared-memory mode.
                    const n = this._numEnvs;
                    response = {
                        status: "error",
                        error: `Invalid actions: expected ${n} action${n === 1 ? '' : 's'} for ${n} environment${n === 1 ? '' : 's'}, got ${actions.length}`,
                    };
                } else {
                    // Requests are serialized by the server loop, and the
                    // borrowed graph below is only valid until the next pool
                    // call, so serialize it before the telemetry branch awaits.
                    const results = await this.pool.step(actions, { ownership: 'borrowed' });

                    // JSON.stringify is the ownership boundary: it consumes the
                    // borrowed `_convertedResults` graph immediately, before any
                    // await in the telemetry branch below could let another
                    // request (or a future pool reset/step there) mutate it.
                    serialized = JSON.stringify({ status: "ok", data: results });

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
                        void this.runPostStepTelemetry();
                    }
                }
            } else if (command === "close") {
                if (payload.shutdown === true) {
                    // Full server shutdown: close the Router after replying.
                    response = { status: "ok" };
                    this._shouldClose = true;
                } else {
                    // Session close (default): free the client's env state but
                    // keep the server listening so other envs/tests on the same
                    // server keep working.
                    await this.pool.close();
                    this._initialized = false;
                    this._numEnvs = 0;
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
     * Best-effort post-step telemetry: memory gauge, worker snapshot fetch,
     * and the interval report. Detached from the request path — it never
     * affects the step reply and cannot stall the ZMQ loop (issue #229).
     * Errors are caught and logged so a telemetry failure is never reported
     * as a step failure or discards an already-serialized reply (issue
     * #185); a message-mode snapshot timeout still fails the pool per
     * worker-pool semantics, surfacing on the next request.
     */
    private async runPostStepTelemetry(): Promise<void> {
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
                const snapshots = await this.pool.getTelemetrySnapshots();
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
        await this.pool.init(numEnvs, config, useSharedMemory);
        this._initialized = true;
        this._numEnvs = numEnvs;
    }

    /**
     * Reset the environment directly (bypassing IPC).
     * Used by BonkEnv for programmatic control.
     */
    async resetEnv(seeds?: number[]): Promise<any[]> {
        return this.pool.reset(seeds);
    }

    /**
     * Step the environment directly (bypassing IPC).
     * Used by BonkEnv for programmatic control.
     */
    async stepEnv(actions: any[]): Promise<any[]> {
        return this.pool.step(actions);
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

    async close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._initialized = false;
        
        // Close the socket to break out of the for await loop
        try {
            this.sock.close();
        } catch (e) {
            // Ignore close errors
        }
        
        await this.pool.close();
    }
}
