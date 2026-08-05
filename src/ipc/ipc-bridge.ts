import * as zmq from "zeromq";
import { WorkerPool } from "../core/worker-pool";
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from "../telemetry/profiler";
import { isTelemetryEnabled as isTelemetryControllerEnabled } from '../telemetry/telemetry-controller';
import { getConfig, type AppConfig, type DeepPartial, mergeEnvironmentConfig } from '../config/config-loader';

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

export class IpcBridge {
    private sock: zmq.Router;
    private pool: WorkerPool;
    private port: number;
    private stepCount: number = 0;
    private _closed: boolean = false;
    private _initialized: boolean = false;
    private _numEnvs: number = 0;
    private _shouldClose: boolean = false;
    private _boundResolve: (() => void) | null = null;
    private _boundReject: ((reason?: any) => void) | null = null;

    /**
     * Resolves once the ZMQ Router socket is bound and accepting connections,
     * and rejects if the bind fails. Embedders that drive the serve loop
     * without awaiting start() (which only exits on close()) can await this
     * to know when the advertised port is actually reachable.
     */
    readonly ready: Promise<void> = new Promise<void>((resolve, reject) => {
        this._boundResolve = resolve;
        this._boundReject = reject;
    });

    constructor(config?: DeepPartial<AppConfig>) {
        this.port = config?.server?.port ?? getConfig().server.port;
        this.sock = new zmq.Router();
        this.pool = new WorkerPool();

        // Create a wrapped send function for telemetry (can't overwrite the built-in send property in newer ZeroMQ)
        this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));

        // The standalone server path awaits only bridge.start(). When the
        // bind fails, both start() and ready reject; mark ready's rejection
        // as handled so it cannot surface as an unhandled-rejection crash for
        // consumers (such as src/server.ts) that never await ready.
        this.ready.catch(() => {});
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

    // Wrapped send function for telemetry
    private _wrappedSend: Function;

    async start() {
        const addr = `tcp://127.0.0.1:${this.port}`;
        try {
            await this.sock.bind(addr);
        } catch (err) {
            this.markBindFailed(err);
            throw err;
        }
        console.log(`[IPC] Bound ZMQ Router socket to ${addr}`);
        this._closed = false;
        this.markBound();

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
     * Best-effort post-step telemetry: memory gauges, worker snapshot fetch,
     * and the heatmap report. Detached from the request path — it never
     * affects the step reply and cannot stall the ZMQ loop (issue #229).
     * Errors are caught and logged so a telemetry failure is never reported
     * as a step failure or discards an already-serialized reply (issue
     * #185); a message-mode snapshot timeout still fails the pool per
     * worker-pool semantics, surfacing on the next request.
     */
    private async runPostStepTelemetry(): Promise<void> {
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
