import * as zmq from "zeromq";
import { WorkerPool } from "../core/worker-pool";
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from "../telemetry/profiler";
import { getConfig, type AppConfig, type DeepPartial, deepMerge } from '../config/config-loader';

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

export class IpcBridge {
    private sock: zmq.Router;
    private pool: WorkerPool;
    private port: number;
    private stepCount: number = 0;
    private _closed: boolean = false;
    private _initialized: boolean = false;
    private _shouldClose: boolean = false;

    constructor(config?: DeepPartial<AppConfig>) {
        this.port = config?.server?.port ?? getConfig().server.port;
        this.sock = new zmq.Router();
        this.pool = new WorkerPool();

        // Create a wrapped send function for telemetry (can't overwrite the built-in send property in newer ZeroMQ)
        this._wrappedSend = wrap(TelemetryIndices.ZMQ_SEND, this.sock.send.bind(this.sock));
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

    async handleRequest(identity: Buffer, rawMsg: string) {
        let response: any;
        // Step responses are serialized eagerly so the borrowed pool graph is
        // consumed before the telemetry branch awaits worker replies.
        let serialized: string | null = null;
        try {
            const payload = parseJson(rawMsg);
            const command = payload.command;

            if (command === "init") {
                const numEnvs = payload.numEnvs;
                if (typeof numEnvs !== 'number' || numEnvs < 1) {
                    response = { status: "error", error: "Invalid numEnvs: must be a positive number" };
                } else {
                    const useSharedMemory = payload.useSharedMemory;
                    const envDefaults = getConfig().environment;
                    const mergedConfig = deepMerge(envDefaults as any, payload.config || {});
                    console.log(`[IPC] Init request: numEnvs=${numEnvs}, config=${JSON.stringify(mergedConfig)}, useSharedMemory=${useSharedMemory}`);
                    await this.pool.init(numEnvs, mergedConfig, useSharedMemory);
                    this._initialized = true;
                    response = { status: "ok" };
                }
            } else if (command === "reset") {
                if (!this._initialized) {
                    response = { status: "error", error: "Worker pool not initialized" };
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
                        globalProfiler.recordMemory();

                        const telemetryEnabled = require('../telemetry/telemetry-controller').isTelemetryEnabled();
                        if (telemetryEnabled) {
                            const snapshots = await this.pool.getTelemetrySnapshots();
                            setLatestWorkerTelemetry(snapshots);
                            globalProfiler.report(5000);
                        }
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

        try {
            await this._wrappedSend([identity, serialized ?? JSON.stringify(response)]);
        } catch (sendError) {
            console.error("[IPC] Error sending response:", sendError);
        }

        if (this._shouldClose) {
            this._shouldClose = false;
            await this.close();
        }
    }

    /**
     * Initialize the environment pool directly (bypassing IPC).
     * Used by BonkEnv for programmatic control.
     */
    async initEnv(numEnvs: number, config: any = {}, useSharedMemory?: boolean): Promise<void> {
        await this.pool.init(numEnvs, config, useSharedMemory);
        this._initialized = true;
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
