import * as zmq from "zeromq";
import { BonkEnvironment, Action } from "./environment";

export class IpcBridge {
    private sock: zmq.Reply;
    private env: BonkEnvironment;
    private port: number;

    constructor(env: BonkEnvironment, port: number = 5555) {
        this.env = env;
        this.port = port;
        this.sock = new zmq.Reply();
    }

    async start() {
        const addr = `tcp://127.0.0.1:${this.port}`;
        await this.sock.bind(addr);
        console.log(`[IPC] Bound ZMQ Reply socket to ${addr}`);

        // Wait for incoming requests from Python
        for await (const [msg] of this.sock) {
            await this.handleRequest(msg.toString());
        }
    }

    private async handleRequest(rawMsg: string) {
        let response: any;
        try {
            const payload = JSON.parse(rawMsg);
            const command = payload.command;

            if (command === "reset") {
                const obs = this.env.reset();
                response = {
                    status: "ok",
                    data: {
                        observation: obs
                    }
                };
            } else if (command === "step") {
                const action: Action = payload.action;
                const result = this.env.step(action);
                response = {
                    status: "ok",
                    data: result
                };
            } else {
                response = { status: "error", error: `Unknown command: ${command}` };
            }
        } catch (e: any) {
            console.error("[IPC] Error handling request:", e);
            response = { status: "error", error: e.message };
        }

        try {
            await this.sock.send(JSON.stringify(response));
        } catch (sendError) {
            console.error("[IPC] Error sending response:", sendError);
        }
    }

    async close() {
        this.sock.close();
    }
}
