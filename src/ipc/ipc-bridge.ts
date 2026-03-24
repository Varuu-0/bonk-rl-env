import * as zmq from "zeromq";
import { WorkerPool } from "../core/worker-pool";
import { globalProfiler, wrap, TelemetryIndices, setLatestWorkerTelemetry } from "../telemetry/profiler";

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

export class IpcBridge {
    private sock: zmq.Router;
    private pool: WorkerPool;
    private port: number;
    private stepCount: number = 0;
    private _closed: boolean = false;

    constructor(port: number = 5555) {
        this.port = port;
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

    private async handleRequest(identity: Buffer, rawMsg: string) {
        let response: any;
        try {
            const payload = parseJson(rawMsg);
            const command = payload.command;

            if (command === "init") {
                const numEnvs = payload.numEnvs;
                if (typeof numEnvs !== 'number' || numEnvs < 1) {
                    response = { status: "error", error: "Invalid numEnvs: must be a positive number" };
                } else {
                    const useSharedMemory = payload.useSharedMemory;
                    console.log(`[IPC] Init request: numEnvs=${numEnvs}, config=${JSON.stringify(payload.config || {})}, useSharedMemory=${useSharedMemory}`);
                    await this.pool.init(numEnvs, payload.config || {}, useSharedMemory);
                    response = { status: "ok" };
                }
            } else if (command === "reset") {
                console.log(`[IPC] Reset request: seeds=${payload.seeds ? payload.seeds.length : 0}`);
                const obs = await this.pool.reset(payload.seeds);
                console.log(`[IPC] Reset response: obs is ${Array.isArray(obs) ? 'array of length ' + obs.length : obs}`);
                response = {
                    status: "ok",
                    data: {
                        observation: obs
                    }
                };
            } else if (command === "step") {
                const actions = payload.actions;
                if (!Array.isArray(actions)) {
                    response = { status: "error", error: "Invalid actions: must be an array" };
                } else if (actions.length === 0) {
                    response = { status: "error", error: "Invalid actions: array cannot be empty" };
                } else {
                    console.log(`[IPC] Step request: actions=${actions.length}`);
                    globalProfiler.start('bridge_step_total');
                    const results = await this.pool.step(actions);
                    console.log(`[IPC] Step response: results is ${Array.isArray(results) ? 'array of length ' + results.length : results}`);

                    this.stepCount++;
                    globalProfiler.tick();

                    if (this.stepCount % 5000 === 0) {
                        globalProfiler.recordMemory();

                        const config = require('../../config').default;
                        if (config.verboseTelemetry) {
                            const snapshots = await this.pool.getTelemetrySnapshots();
                            setLatestWorkerTelemetry(snapshots);
                            globalProfiler.report(5000);
                        }
                    }

                    response = {
                        status: "ok",
                        data: results
                    };
                    globalProfiler.end('bridge_step_total');
                }
            } else {
                response = { status: "error", error: `Unknown command: ${command}` };
            }
        } catch (e: any) {
            console.error("[IPC] Error handling request:", e);
            response = { status: "error", error: e.message };
        }

        try {
            const jsonStr = JSON.stringify(response);
            console.log(`[IPC] Sending response: ${jsonStr.substring(0, 200)}`);
            await this._wrappedSend([identity, jsonStr]);
        } catch (sendError) {
            console.error("[IPC] Error sending response:", sendError);
        }
    }

    /**
     * Initialize the environment pool directly (bypassing IPC).
     * Used by BonkEnv for programmatic control.
     */
    async initEnv(numEnvs: number, config: any = {}, useSharedMemory?: boolean): Promise<void> {
        await this.pool.init(numEnvs, config, useSharedMemory);
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
        
        // Close the socket to break out of the for await loop
        try {
            this.sock.close();
        } catch (e) {
            // Ignore close errors
        }
        
        this.pool.close();
    }
}
