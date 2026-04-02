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
    private _stepCount: number = 0;

    // Pre-allocated observation templates for zero-GC extraction
    private _obsPool: any[] = [];
    private _obsPoolSize: number = 0;

    // Pre-allocated finished buffer for step/reset
    private _finished: Uint8Array = new Uint8Array(0);

    // Pre-allocated return times buffer (avoids per-step array allocation)
    private _returnTimes: BigUint64Array = new BigUint64Array(0);

    // Pre-allocated result objects pool (avoids per-step object allocation)
    private _resultPool: any[] = [];
    private _convertedResults: any[] = [];

    // Shared sync buffer for completion counter (all workers share this)
    private _syncBuffer: SharedArrayBuffer | null = null;

    constructor(private numWorkers: number = Math.min(os.cpus().length, 8)) {
    }

    private initObsPool(totalEnvs: number): void {
        this._obsPool = [];
        for (let i = 0; i < totalEnvs; i++) {
            this._obsPool.push({
                playerX: 0,
                playerY: 0,
                playerVelX: 0,
                playerVelY: 0,
                playerAngle: 0,
                playerAngularVel: 0,
                playerIsHeavy: false,
                opponents: [{
                    x: 0,
                    y: 0,
                    velX: 0,
                    velY: 0,
                    isHeavy: false,
                    alive: false,
                }],
                tick: 0,
            });
        }
        this._obsPoolSize = totalEnvs;
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

        // Create shared sync buffer for completion counter
        this._syncBuffer = new SharedArrayBuffer(4);

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
                        ringSize: this.ringSize,
                        syncBuffer: this._syncBuffer!
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

        // Pre-allocate observation pool and finished buffer
        this.initObsPool(totalEnvs);
        this._finished = new Uint8Array(this.workers.length);

        // Pre-allocate return times buffer
        this._returnTimes = new BigUint64Array(this.workers.length);

        // Pre-allocate result objects pool
        this._resultPool = [];
        for (let i = 0; i < totalEnvs; i++) {
            this._resultPool.push({
                observation: null,
                reward: 0,
                done: false,
                truncated: false,
                info: { tick: 0 }
            });
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

            // Reset shared completion counter before signaling workers
            const completedArr = new Int32Array(this._syncBuffer!);
            Atomics.store(completedArr, 0, 0);

            for (let i = 0; i < this.workers.length; i++) {
                const wEnvs = this.workerEnvs[i];
                const wSeeds = seeds ? seeds.slice(seedIdx, seedIdx + wEnvs) : new Array(wEnvs).fill(0);
                seedIdx += wEnvs;

                const shm = this.sharedMemManagers[i]!;
                shm.writeSeeds(wSeeds);
                shm.sendCommand(1); // RESET command
            }

            // 2. Wait for reset completion using shared completion counter
            const timeoutMs = 30000;
            const startTime = Date.now();
            const finished = this._finished;
            finished.fill(0);  // Reset from previous step

            // First pass: check if any workers already done
            for (let i = 0; i < this.workers.length; i++) {
                if (this.sharedMemManagers[i]!.isResultsReady()) {
                    this.sharedMemManagers[i]!.consumeResultsSignal();
                    finished[i] = 1;
                }
            }

            // Wait for ALL workers to complete using shared completion counter
            {
                const numWorkers = this.workers.length;
                let waitVal = Atomics.load(completedArr, 0);
                while (waitVal < numWorkers) {
                    const elapsed = Date.now() - startTime;
                    const remaining = Math.max(1, timeoutMs - elapsed);
                    Atomics.wait(completedArr, 0, waitVal, remaining);
                    waitVal = Atomics.load(completedArr, 0);
                    if (Date.now() - startTime >= timeoutMs) break;
                }
            }

            // All workers done — consume their signals
            for (let i = 0; i < this.workers.length; i++) {
                if (finished[i]) continue;
                const shm = this.sharedMemManagers[i]!;
                try {
                    shm.consumeResultsSignal();
                } catch (e: any) {
                    console.warn(`[WorkerPool] reset: worker ${i} failed during consume:`, e.message);
                }
                finished[i] = 1;
            }

            // 3. Extract observations
            const observations: any[] = [];
            for (let i = 0; i < this.workers.length; i++) {
                const wEnvs = this.workerEnvs[i];
                try {
                    const res = this.sharedMemManagers[i]!.readResults();
                    for (let j = 0; j < wEnvs; j++) {
                        observations.push(this.extractObservation(res.observations, j));
                    }
                } catch (e: any) {
                    console.warn(`[WorkerPool] reset: worker ${i} failed to read results:`, e.message);
                    // Push zeroed observations so the array length stays consistent
                    for (let j = 0; j < wEnvs; j++) {
                        observations.push(null);
                    }
                }
            }
            return observations;
        }

        const promises = [];
        let seedIdx = 0;
        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const wSeeds = seeds ? seeds.slice(seedIdx, seedIdx + wEnvs) : undefined;
            promises.push(
                this.sendMessage(this.workers[i], { type: 'reset', seeds: wSeeds })
                    .catch(e => {
                        console.warn(`[WorkerPool] reset: worker ${i} failed:`, e.message);
                        return new Array(wEnvs).fill(null);
                    })
            );
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
        this._returnTimes.fill(BigInt(0));
        const returnTimes = this._returnTimes;

        // 1. Encode actions and signal all workers in parallel
        let actionIdx = 0;

        // Reset shared completion counter before signaling workers
        const completedArr = new Int32Array(this._syncBuffer!);
        Atomics.store(completedArr, 0, 0);

        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];

            const encodedActions = this.actionBufferPool[i];
            for (let j = 0; j < wEnvs; j++) {
                encodedActions[j] = this.encodeAction(actions[actionIdx + j]);
            }
            actionIdx += wEnvs;

            const shm = this.sharedMemManagers[i]!;
            shm.writeActionsQuiet(encodedActions);
            shm.sendCommand(0); // STEP command (also notifies worker)
        }

        // 2. Wait for results from all workers using Atomics.wait (no polling overhead)
        const timeoutMs = 5000;
        const startTime = Date.now();
        const finished = this._finished;
        finished.fill(0);  // Reset from previous step

        // First pass: check if any workers already done (non-blocking)
        for (let i = 0; i < this.workers.length; i++) {
            const shm = this.sharedMemManagers[i]!;
            if (shm.isResultsReady()) {
                shm.consumeResultsSignal();
                returnTimes[i] = process.hrtime.bigint();
                finished[i] = 1;
            }
        }

        // Wait for ALL workers to complete using shared completion counter
        {
            const numWorkers = this.workers.length;
            let waitVal = Atomics.load(completedArr, 0);
            while (waitVal < numWorkers) {
                const elapsed = Date.now() - startTime;
                const remaining = Math.max(1, timeoutMs - elapsed);
                Atomics.wait(completedArr, 0, waitVal, remaining);
                waitVal = Atomics.load(completedArr, 0);
                if (Date.now() - startTime >= timeoutMs) break;
            }
        }

        // All workers done — consume their signals
        for (let i = 0; i < this.workers.length; i++) {
            if (finished[i]) continue;
            const shm = this.sharedMemManagers[i]!;
            shm.consumeResultsSignal();
            returnTimes[i] = process.hrtime.bigint();
            finished[i] = 1;
        }

        const batchEnd = process.hrtime.bigint();

        // Record Batch Latency (only every 100 steps to reduce overhead)
        this._stepCount = (this._stepCount || 0) + 1;
        if (this._stepCount % 100 === 0) {
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
        }

        // Convert shared memory results to observation objects
        this._convertedResults.length = 0;
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
                const resultIdx = actionIdx + j;
                const resultObj = this._resultPool[resultIdx];
                resultObj.observation = this.extractObservation(obs, j);
                resultObj.reward = rewards[j];
                resultObj.done = dones[j] === 1;
                resultObj.truncated = truncated[j] === 1;
                resultObj.info.tick = ticks[j];
                this._convertedResults.push(resultObj);
            }
        }

        return this._convertedResults;
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
        const template = this._obsPool[idx];
        if (!template) {
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
                    alive: obs[offset + 12] === 1,
                }],
                tick: obs[offset + 13],
            };
        }

        template.playerX = obs[offset + 0];
        template.playerY = obs[offset + 1];
        template.playerVelX = obs[offset + 2];
        template.playerVelY = obs[offset + 3];
        template.playerAngle = obs[offset + 4];
        template.playerAngularVel = obs[offset + 5];
        template.playerIsHeavy = obs[offset + 6] === 1;

        const opp = template.opponents[0];
        opp.x = obs[offset + 7];
        opp.y = obs[offset + 8];
        opp.velX = obs[offset + 9];
        opp.velY = obs[offset + 10];
        opp.isHeavy = obs[offset + 11] === 1;
        opp.alive = obs[offset + 12] === 1;

        template.tick = obs[offset + 13];

        return template;
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
