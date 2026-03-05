import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { globalProfiler } from './profiler';

export class WorkerPool {
    private workers: Worker[] = [];
    private workerEnvs: number[] = [];
    private callbacks: Map<number, { resolve: Function, reject: Function }> = new Map();
    private msgId = 0;

    constructor(private numWorkers: number = os.cpus().length) {
    }

    async init(totalEnvs: number, config: any = {}) {
        this.close(); // Clean up existing if re-initialized
        this.workers = [];
        this.workerEnvs = [];

        // Ensure we don't start more workers than environment instances
        const activeWorkers = Math.min(this.numWorkers, totalEnvs);

        const baseEnvsPerWorker = Math.floor(totalEnvs / activeWorkers);
        let remainder = totalEnvs % activeWorkers;

        const promises = [];
        for (let i = 0; i < activeWorkers; i++) {
            const numEnvs = baseEnvsPerWorker + (remainder > 0 ? 1 : 0);
            remainder--;

            if (numEnvs > 0) {
                const workerPath = path.join(__dirname, 'worker-loader.js');

                const worker = new Worker(workerPath);
                this.workers.push(worker);
                this.workerEnvs.push(numEnvs);

                worker.on('message', (msg) => {
                    const cb = this.callbacks.get(msg.id);
                    if (cb) {
                        this.callbacks.delete(msg.id);
                        if (msg.status === 'error') cb.reject(new Error(msg.error));
                        else cb.resolve(msg.data);
                    }
                });

                worker.on('error', (err) => {
                    console.error(`[WorkerPool] Worker error: ${err}`);
                });

                promises.push(this.sendMessage(worker, { type: 'init', numEnvs, config }));
            }
        }
        await Promise.all(promises);
    }

    private sendMessage(worker: Worker, msg: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.callbacks.set(id, { resolve, reject });
            worker.postMessage({ id, ...msg });
        });
    }

    async reset(seeds?: number[]): Promise<any[]> {
        const promises = [];
        let seedIdx = 0;
        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const wSeeds = seeds ? seeds.slice(seedIdx, seedIdx + wEnvs) : undefined;
            promises.push(this.sendMessage(this.workers[i], { type: 'reset', seeds: wSeeds }));
            seedIdx += wEnvs;
        }
        const results = await Promise.all(promises);
        return results.flat();
    }

    async step(actions: any[]): Promise<any[]> {
        const batchStart = process.hrtime.bigint();
        const returnTimes: bigint[] = [];

        const promises = [];
        let actionIdx = 0;
        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const wActions = actions.slice(actionIdx, actionIdx + wEnvs);

            const p = this.sendMessage(this.workers[i], { type: 'step', actions: wActions })
                .then(data => {
                    returnTimes.push(process.hrtime.bigint());
                    return data;
                });

            promises.push(p);
            actionIdx += wEnvs;
        }

        const results = await Promise.all(promises);
        const batchEnd = process.hrtime.bigint();

        // Record Batch Latency
        const totalMs = Number(batchEnd - batchStart) / 1_000_000;
        globalProfiler.gauge('Batch Latency (ms)', totalMs);

        // Record Sync Gap (Max - Min return time)
        if (returnTimes.length > 1) {
            let min = returnTimes[0];
            let max = returnTimes[0];
            for (const t of returnTimes) {
                if (t < min) min = t;
                if (t > max) max = t;
            }
            const gapMs = Number(max - min) / 1_000_000;
            globalProfiler.gauge('Sync Gap (ms)', gapMs);
        }

        return results.flat();
    }

    /**
     * Request telemetry snapshots from all workers.
     * Each worker returns a copy of its local TelemetryBuffer.
     */
    async getTelemetrySnapshots(): Promise<BigUint64Array[]> {
        const promises = [];
        for (let i = 0; i < this.workers.length; i++) {
            promises.push(this.sendMessage(this.workers[i], { type: 'GET_TELEMETRY' }));
        }
        const snapshots = await Promise.all(promises);
        return snapshots as BigUint64Array[];
    }

    close() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.workerEnvs = [];
    }
}
