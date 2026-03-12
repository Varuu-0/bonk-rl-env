import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { globalProfiler } from '../telemetry/profiler';
import { SharedMemoryManager } from '../ipc/shared-memory';

/**
 * Player input action interface for encoding to shared memory
 */
interface PlayerInput {
    left?: boolean;
    right?: boolean;
    up?: boolean;
    down?: boolean;
    heavy?: boolean;
    grapple?: boolean;
}

/**
 * Observation data structure extracted from shared memory
 */
interface SharedObservation {
    playerX: number;
    playerY: number;
    playerVelX: number;
    playerVelY: number;
    playerAngle: number;
    playerAngularVel: number;
    playerIsHeavy: number;
    opponentX: number;
    opponentY: number;
    opponentVelX: number;
    opponentVelY: number;
    opponentIsHeavy: number;
    opponentAlive: number;
    tick: number;
}

export class WorkerPool {
    private workers: Worker[] = [];
    private workerEnvs: number[] = [];
    private callbacks: Map<number, { resolve: Function, reject: Function }> = new Map();
    private msgId = 0;

    // Shared memory state
    private sharedMemManagers: (SharedMemoryManager | null)[] = [];
    private useSharedMemory: boolean = false;
    private ringSize: number = 16;

    // Buffer pool for encoding actions (avoids per-step allocation)
    private actionBufferPool: Uint8Array[] = [];
    private maxEnvsPerWorker: number = 0;

    constructor(private numWorkers: number = Math.min(os.cpus().length, 8)) {
    }

    async init(totalEnvs: number, config: any = {}, useSharedMemory?: boolean) {
        this.close(); // Clean up existing if re-initialized
        this.workers = [];
        this.workerEnvs = [];
        this.sharedMemManagers = [];

        // Determine if we should use shared memory
        const sharedMemorySupported = SharedMemoryManager.isSupported();
        this.useSharedMemory = useSharedMemory !== undefined ? useSharedMemory : sharedMemorySupported;

        // Set default ring size
        this.ringSize = 16;

        // Ensure we don't start more workers than environment instances
        const activeWorkers = Math.min(this.numWorkers, totalEnvs);

        const baseEnvsPerWorker = Math.floor(totalEnvs / activeWorkers);
        let remainder = totalEnvs % activeWorkers;

        const promises = [];
        let currentStartId = 0;
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

                // Initialize shared memory if enabled
                if (this.useSharedMemory) {
                    const shm = new SharedMemoryManager(numEnvs, this.ringSize);
                    this.sharedMemManagers.push(shm);

                    // Send init and wait for it
                    const initPromise = this.sendMessage(worker, {
                        type: 'init',
                        numEnvs,
                        startId: currentStartId,
                        config,
                        sharedBuffer: shm.getBuffer(),
                        ringSize: this.ringSize
                    }).then(res => {
                        // After successful init, trigger the wait-for-action loop
                        worker.postMessage({ type: 'wait-for-action', config });
                        return res;
                    });

                    promises.push(initPromise);
                } else {
                    this.sharedMemManagers.push(null);
                    promises.push(this.sendMessage(worker, { type: 'init', numEnvs, startId: currentStartId, config }));
                }
                currentStartId += numEnvs;
            }
        }

        // Wait for all workers to initialize
        const results = await Promise.all(promises);

        // Initialize buffer pool based on max environments per worker
        this.maxEnvsPerWorker = Math.max(...this.workerEnvs);
        for (let i = 0; i < this.workers.length; i++) {
            this.actionBufferPool.push(new Uint8Array(this.workerEnvs[i]));
        }

        // Check if workers actually support shared memory mode
        if (this.useSharedMemory) {
            const allSupportShared = results.every((r: any) => r && r.mode === 'shared');
            if (!allSupportShared) {
                console.warn('[WorkerPool] Some workers did not support shared memory, falling back to message passing');
                results.forEach((r: any, idx: number) => {
                    if (!r || r.mode !== 'shared') {
                        console.warn(`  - Worker ${idx} returned mode: ${r ? r.mode : 'undefined'}`);
                    }
                });
                this.useSharedMemory = false;
            } else {
                console.log('[WorkerPool] All workers successfully initialized with SharedArrayBuffer');
            }
        } else {
            console.log('[WorkerPool] Shared memory optimization is disabled (either not supported or explicitly turned off)');
        }
    }

    private sendMessage(worker: Worker, msg: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.callbacks.set(id, { resolve, reject });
            // Set a timeout to reject if no response
            const timeout = setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    console.error(`[WorkerPool] Message ${id} timed out`);
                    reject(new Error(`Message ${id} timed out`));
                }
            }, 30000);  // 30 second timeout for init/other messages
            worker.postMessage({ id, ...msg });
        });
    }

    async reset(seeds?: number[]): Promise<any[]> {
        if (this.useSharedMemory) {
            // 1. Send reset command to all workers
            let seedIdx = 0;
            for (let i = 0; i < this.workers.length; i++) {
                const wEnvs = this.workerEnvs[i];
                const wSeeds = seeds ? seeds.slice(seedIdx, seedIdx + wEnvs) : new Array(wEnvs).fill(0);
                seedIdx += wEnvs;

                const shm = this.sharedMemManagers[i]!;
                shm.writeSeeds(wSeeds);
                shm.sendCommand(1); // RESET command
            }

            // 2. Poll for reset completion
            const timeoutMs = 30000;
            const startTime = Date.now();
            let workersRemaining = this.workers.length;
            const finished = new Uint8Array(this.workers.length);

            while (workersRemaining > 0) {
                for (let i = 0; i < this.workers.length; i++) {
                    if (finished[i]) continue;
                    if (this.sharedMemManagers[i]!.isResultsReady()) {
                        this.sharedMemManagers[i]!.consumeResultsSignal();
                        finished[i] = 1;
                        workersRemaining--;
                    }
                }
                if (workersRemaining > 0) {
                    if ((Date.now() - startTime) > timeoutMs) {
                        throw new Error('Timeout waiting for worker reset');
                    }
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
            }

            // 3. Extract observations
            const observations: any[] = [];
            for (let i = 0; i < this.workers.length; i++) {
                const wEnvs = this.workerEnvs[i];
                const res = this.sharedMemManagers[i]!.readResults();
                for (let j = 0; j < wEnvs; j++) {
                    observations.push(this.extractObservation(res.observations, j));
                }
            }
            return observations;
        }

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
        // Use shared memory mode if enabled
        if (this.useSharedMemory) {
            return this.stepSharedMemory(actions);
        } else {
            return this.stepMessagePassing(actions);
        }
    }

    /**
     * Step using shared memory (zero-copy IPC)
     * Writes actions to shared memory, signals workers, and waits for results
     */
    private async stepSharedMemory(actions: any[]): Promise<any[]> {
        const batchStart = process.hrtime.bigint();
        const returnTimes: bigint[] = new Array(this.workers.length).fill(BigInt(0));

        // 1. Encode actions and signal all workers in parallel
        let actionIdx = 0;
        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const wActions = actions.slice(actionIdx, actionIdx + wEnvs);
            actionIdx += wEnvs;

            const encodedActions = this.actionBufferPool[i];
            for (let j = 0; j < wActions.length; j++) {
                encodedActions[j] = this.encodeAction(wActions[j]);
            }

            const shm = this.sharedMemManagers[i]!;
            shm.writeActionsQuiet(encodedActions);
            shm.sendCommand(0); // STEP command (also notifies worker)
        }

        // 2. Poll for results from all workers in parallel (Busy-wait with timeout)
        const timeoutMs = 5000;
        const startTime = Date.now();
        let workersRemaining = this.workers.length;
        const finished = new Uint8Array(this.workers.length);

        while (workersRemaining > 0) {
            for (let i = 0; i < this.workers.length; i++) {
                if (finished[i]) continue;

                const shm = this.sharedMemManagers[i]!;
                if (shm.isResultsReady()) {
                    shm.consumeResultsSignal();
                    returnTimes[i] = process.hrtime.bigint();
                    finished[i] = 1;
                    workersRemaining--;
                }
            }

            if (workersRemaining > 0) {
                if ((Date.now() - startTime) > timeoutMs) {
                    throw new Error(`Timeout waiting for workers: ${Array.from(finished).map((f, i) => f ? '' : i).filter(v => v !== '').join(',')}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }

        const batchEnd = process.hrtime.bigint();

        // Record Batch Latency
        const totalMs = Number(batchEnd - batchStart) / 1_000_000;
        globalProfiler.gauge('Batch Latency (ms)', totalMs);
        globalProfiler.gauge('Shared Memory Step (ms)', totalMs);

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

        // Convert shared memory results to observation objects
        const convertedResults: any[] = [];
        actionIdx = 0;

        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const shm = this.sharedMemManagers[i];

            if (!shm) {
                throw new Error(`Shared memory manager not initialized for worker ${i}`);
            }

            // Read results from shared memory
            const rawResults = shm.readResults();
            const obs = rawResults.observations;
            const rewards = rawResults.rewards;
            const dones = rawResults.dones;
            const truncated = rawResults.truncated;
            const ticks = rawResults.ticks;

            // Extract results for each environment in this worker
            for (let j = 0; j < wEnvs; j++) {
                convertedResults.push({
                    observation: this.extractObservation(obs, j),
                    reward: rewards[j],
                    done: dones[j] === 1,
                    truncated: truncated[j] === 1,
                    info: { tick: ticks[j] }
                });
            }
        }

        return convertedResults;
    }

    /**
     * Step using message passing (fallback mode)
     */
    private async stepMessagePassing(actions: any[]): Promise<any[]> {
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
        globalProfiler.gauge('Message Passing Step (ms)', totalMs);

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
     * Encodes a PlayerInput action to a number for shared memory storage
     * Uses bit flags: left=1, right=2, up=4, down=8, heavy=16, grapple=32
     */
    private encodeAction(action: PlayerInput | number): number {
        if (typeof action === 'number') {
            return action; // Already encoded
        }
        let encoded = 0;
        if (action.left) encoded |= 1;
        if (action.right) encoded |= 2;
        if (action.up) encoded |= 4;
        if (action.down) encoded |= 8;
        if (action.heavy) encoded |= 16;
        if (action.grapple) encoded |= 32;
        return encoded;
    }

    /**
     * Extracts observation data from shared memory Float32Array
     * @param obs Float32Array containing all observations
     * @param idx Environment index
     */
    private extractObservation(obs: Float32Array, idx: number): any {
        const offset = idx * 14;
        return {
            playerX: obs[offset + 0],
            playerY: obs[offset + 1],
            playerVelX: obs[offset + 2],
            playerVelY: obs[offset + 3],
            playerAngle: obs[offset + 4],
            playerAngularVel: obs[offset + 5],
            playerIsHeavy: obs[offset + 6] === 1,
            opponents: [{
                x: obs[offset + 7],
                y: obs[offset + 8],
                velX: obs[offset + 9],
                velY: obs[offset + 10],
                isHeavy: obs[offset + 11] === 1,
                alive: obs[offset + 12] === 1
            }],
            tick: obs[offset + 13]
        };
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

        // Properly dispose of SharedMemoryManager instances to prevent memory leaks
        for (const shm of this.sharedMemManagers) {
            if (shm) {
                shm.dispose();
            }
        }

        this.workers = [];
        this.workerEnvs = [];
        this.sharedMemManagers = [];
        this.actionBufferPool = [];
    }

    /**
     * Checks if SharedArrayBuffer is supported in the current environment
     */
    static isSupported(): boolean {
        return SharedMemoryManager.isSupported();
    }

    /**
     * Returns whether shared memory mode is currently enabled
     */
    isUsingSharedMemory(): boolean {
        return this.useSharedMemory;
    }
}
