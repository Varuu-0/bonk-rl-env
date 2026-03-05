import * as zmq from "zeromq";
import { WorkerPool } from "./worker-pool";
import { globalProfiler, wrap, TelemetryIndices } from "./profiler";

// Pre-wrapped JSON.parse for telemetry on bridge deserialization.
const parseJson = wrap(TelemetryIndices.JSON_PARSE, JSON.parse) as (text: string) => any;

export class IpcBridge {
    private sock: zmq.Router;
    private pool: WorkerPool;
    private port: number;
    private stepCount: number = 0;

    constructor(port: number = 5555) {
        this.port = port;
        this.sock = new zmq.Router();
        this.pool = new WorkerPool();

        // Wrap the underlying ZMQ send with telemetry.
        const originalSend = this.sock.send;
        this.sock.send = wrap(TelemetryIndices.ZMQ_SEND, originalSend.bind(this.sock)) as any;
    }

    async start() {
        const addr = `tcp://127.0.0.1:${this.port}`;
        await this.sock.bind(addr);
        console.log(`[IPC] Bound ZMQ Router socket to ${addr}`);

        // Wait for incoming requests from Python
        for await (const frames of this.sock) {
            const identity = frames[0];
            const msg = frames[frames.length - 1];
            await this.handleRequest(identity, msg.toString());
        }
    }

    private async handleRequest(identity: Buffer, rawMsg: string) {
        let response: any;
        try {
            const payload = parseJson(rawMsg);
            const command = payload.command;

            if (command === "init") {
                await this.pool.init(payload.numEnvs, payload.config);
                response = { status: "ok" };
            } else if (command === "reset") {
                const obs = await this.pool.reset(payload.seeds);
                response = {
                    status: "ok",
                    data: {
                        observation: obs
                    }
                };
            } else if (command === "step") {
                globalProfiler.start('bridge_step_total');
                const results = await this.pool.step(payload.actions);

                this.stepCount++;
                globalProfiler.tick();

                if (this.stepCount % 5000 === 0) {
                    globalProfiler.recordMemory();
                    globalProfiler.report(5000);
                }

                response = {
                    status: "ok",
                    data: results
                };
                globalProfiler.end('bridge_step_total');
            } else {
                response = { status: "error", error: `Unknown command: ${command}` };
            }
        } catch (e: any) {
            console.error("[IPC] Error handling request:", e);
            response = { status: "error", error: e.message };
        }

        try {
            await this.sock.send([identity, JSON.stringify(response)]);
        } catch (sendError) {
            console.error("[IPC] Error sending response:", sendError);
        }
    }

    async close() {
        this.pool.close();
        this.sock.close();
    }
}
