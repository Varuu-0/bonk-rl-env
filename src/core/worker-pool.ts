import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { globalProfiler } from '../telemetry/profiler';
import { SharedMemoryManager } from '../ipc/shared-memory';
import { getConfig } from '../config/config-loader';
import type { PlayerInput } from './physics-engine';
import { ARENA_HALF_WIDTH, ARENA_HALF_HEIGHT, SCALE } from './physics-engine';

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

type WorkerPoolState = 'idle' | 'initializing' | 'ready' | 'failed' | 'closed';

const SYNC_COMPLETED_INDEX = 0;
const SYNC_STATUS_OFFSET = 1;
const WORKER_IDLE = 0;
const WORKER_COMPLETE = 1;
const WORKER_ERROR = -1;

export class WorkerPool {
    private workers: Worker[] = [];
    private workerEnvs: number[] = [];
    private callbacks: Map<number, {
        resolve: Function;
        reject: Function;
        timeout: ReturnType<typeof setTimeout>;
    }> = new Map();
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
    // Terminal observations must not reuse the live-observation templates.
    private _terminalObsPool: any[] = [];
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

    private state: WorkerPoolState = 'idle';
    private failure: Error | null = null;
    private cleanupPromise: Promise<void> | null = null;

    constructor(private numWorkers: number = getConfig().workerPool.numWorkers) {
    }

    private initObsPool(totalEnvs: number): void {
        this._obsPool = [];
        this._terminalObsPool = [];
        for (let i = 0; i < totalEnvs; i++) {
            const createTemplate = () => ({
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
                arenaHalfWidth: ARENA_HALF_WIDTH * SCALE,
                arenaHalfHeight: ARENA_HALF_HEIGHT * SCALE,
                tick: 0,
            });
            this._obsPool.push(createTemplate());
            this._terminalObsPool.push(createTemplate());
        }
        this._obsPoolSize = totalEnvs;
    }

    async init(totalEnvs: number, config: any = {}, useSharedMemory?: boolean) {
        await this.close(); // Clean up existing if re-initialized
        this.state = 'initializing';
        this.failure = null;

        // Determine if we should use shared memory
        const sharedMemorySupported = SharedMemoryManager.isSupported();
        this.useSharedMemory = useSharedMemory !== undefined ? useSharedMemory : (getConfig().workerPool.useSharedMemory && sharedMemorySupported);

        // Set default ring size
        this.ringSize = getConfig().workerPool.ringBufferSize;

        // Ensure we don't start more workers than environment instances
        const activeWorkers = Math.min(this.numWorkers, totalEnvs);

        try {
            // Index 0 is the wake counter; each worker also owns a status slot.
            this._syncBuffer = this.useSharedMemory
                ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (activeWorkers + SYNC_STATUS_OFFSET))
                : null;

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
                    const workerIndex = this.workers.length;
                    this.workers.push(worker);
                    this.workerEnvs.push(numEnvs);

                    worker.on('message', (msg) => {
                        const cb = this.callbacks.get(msg.id);
                        if (cb) {
                            this.callbacks.delete(msg.id);
                            clearTimeout(cb.timeout);
                            if (msg.status === 'error') cb.reject(new Error(msg.error));
                            else cb.resolve(msg.data);
                        } else if (msg.status === 'error') {
                            this.handleWorkerFailure(worker, workerIndex, new Error(msg.error));
                        }
                    });

                    worker.on('error', (err) => {
                        this.handleWorkerFailure(worker, workerIndex, err);
                    });
                    worker.on('exit', (code: number) => {
                        if (this.workers[workerIndex] === worker) {
                            this.handleWorkerFailure(
                                worker,
                                workerIndex,
                                new Error(`Worker ${workerIndex} exited unexpectedly with code ${code}`),
                            );
                        }
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
                            workerIndex,
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
                    terminated: false,
                    info: { tick: 0 }
                });
            }

            // Workers initialized with shared buffers cannot safely switch protocols in place.
            if (this.useSharedMemory) {
                const unsupportedWorker = results.findIndex((r: any) => !r || r.mode !== 'shared');
                if (unsupportedWorker !== -1) {
                    throw new Error(`Worker ${unsupportedWorker} did not initialize in shared-memory mode`);
                }
                console.log('[WorkerPool] All workers successfully initialized with SharedArrayBuffer');
            } else {
                console.log('[WorkerPool] Shared memory optimization is disabled (either not supported or explicitly turned off)');
            }

            this.state = 'ready';
        } catch (error) {
            const failure = this.createFailure('initialization', error);
            await this.failPool(failure);
            throw failure;
        }
    }

    private sendMessage(worker: Worker, msg: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            // Set a timeout to reject if no response
            const timeout = setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    console.error(`[WorkerPool] Message ${id} timed out`);
                    reject(new Error(`Message ${id} timed out`));
                }
            }, getConfig().workerPool.messageTimeoutMs);
            this.callbacks.set(id, { resolve, reject, timeout });
            try {
                worker.postMessage({ id, ...msg });
            } catch (error) {
                clearTimeout(timeout);
                this.callbacks.delete(id);
                reject(error);
            }
        });
    }

    async reset(seeds?: number[]): Promise<any[]> {
        this.assertReady('reset');

        if (this.useSharedMemory && seeds) {
            for (const seed of seeds) {
                if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFE) {
                    throw new Error(`Seed ${seed} out of supported range [0, 4294967294] for shared-memory reset`);
                }
            }
        }

        try {
            if (this.useSharedMemory) {
                // 1. Send reset command to all workers
                let seedIdx = 0;

                const completedArr = this.prepareSharedBatch();

                for (let i = 0; i < this.workers.length; i++) {
                    const wEnvs = this.workerEnvs[i];
                    // SAB transport encodes "no seed" as 0 and real seeds as seed+1.
                    const wSeeds = seeds
                        ? seeds.slice(seedIdx, seedIdx + wEnvs).map(seed => seed + 1)
                        : new Array(wEnvs).fill(0);
                    seedIdx += wEnvs;

                    const shm = this.requireSharedMemoryManager(i);
                    shm.writeSeeds(wSeeds);
                    shm.sendCommand(1); // RESET command
                }

                // 2. Wait for reset completion using shared completion counter
                await this.waitForSharedCompletion(
                    completedArr,
                    'reset',
                    getConfig().workerPool.messageTimeoutMs,
                );

                // All workers done — consume their signals
                for (let i = 0; i < this.workers.length; i++) {
                    const shm = this.requireSharedMemoryManager(i);
                    if (!shm.isResultsReady()) {
                        throw new Error(`Worker ${i} completed reset without publishing results`);
                    }
                    shm.consumeResultsSignal();
                }

                // 3. Extract observations
                const observations: any[] = [];
                let globalEnvIdx = 0;
                for (let i = 0; i < this.workers.length; i++) {
                    const wEnvs = this.workerEnvs[i];
                    const res = this.requireSharedMemoryManager(i).readResults();
                    for (let j = 0; j < wEnvs; j++) {
                        observations.push(this.extractObservation(res.observations, j, globalEnvIdx));
                        globalEnvIdx++;
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
        } catch (error) {
            if (this.state === 'closed') {
                throw error;
            }
            const failure = this.createFailure('reset', error);
            // Shared-memory batches can corrupt or desync the pool, so any
            // failure there is fatal. Message-passing failures are transient
            // (a worker error reply or a slow worker) and must not kill the
            // whole pool: callers can retry without a full re-init().
            if (this.useSharedMemory) {
                await this.failPool(failure);
            }
            throw failure;
        }
    }

    async step(actions: any[]): Promise<any[]> {
        this.assertReady('step');
        try {
            // Use shared memory mode if enabled
            if (this.useSharedMemory) {
                return await this.stepSharedMemory(actions);
            }
            return await this.stepMessagePassing(actions);
        } catch (error) {
            if (this.state === 'closed') {
                throw error;
            }
            const failure = this.createFailure('step', error);
            // Shared-memory batches can corrupt or desync the pool, so any
            // failure there is fatal. Message-passing failures are transient
            // (a worker error reply or a slow worker) and must not kill the
            // whole pool: callers can retry without a full re-init().
            if (this.useSharedMemory) {
                await this.failPool(failure);
            }
            throw failure;
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

        const completedArr = this.prepareSharedBatch();

        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];

            const encodedActions = this.actionBufferPool[i];
            for (let j = 0; j < wEnvs; j++) {
                encodedActions[j] = this.encodeAction(actions[actionIdx + j]);
            }
            actionIdx += wEnvs;

            const shm = this.requireSharedMemoryManager(i);
            shm.writeActionsQuiet(encodedActions);
            shm.sendCommand(0); // STEP command (also notifies worker)
        }

        // 2. Wait for results from all workers without blocking worker event delivery.
        const finished = this._finished;
        finished.fill(0);  // Reset from previous step

        // First pass: check if any workers already done (non-blocking)
        for (let i = 0; i < this.workers.length; i++) {
            const shm = this.requireSharedMemoryManager(i);
            if (shm.isResultsReady()) {
                shm.consumeResultsSignal();
                returnTimes[i] = process.hrtime.bigint();
                finished[i] = 1;
            }
        }

        await this.waitForSharedCompletion(
            completedArr,
            'step',
            getConfig().workerPool.stepTimeoutMs,
        );

        // All workers done — consume their signals
        for (let i = 0; i < this.workers.length; i++) {
            if (finished[i]) continue;
            const shm = this.requireSharedMemoryManager(i);
            if (!shm.isResultsReady()) {
                throw new Error(`Worker ${i} completed step without publishing results`);
            }
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
            const terminalObs = rawResults.terminalObservations;
            const hasTerminalObs = rawResults.hasTerminalObs;

            // Extract results for each environment in this worker
            for (let j = 0; j < wEnvs; j++) {
                const resultIdx = actionIdx + j;
                const resultObj = this._resultPool[resultIdx];
                const done = dones[j] === 1;
                const trunc = truncated[j] === 1;
                resultObj.observation = this.extractObservation(obs, j, resultIdx);
                resultObj.reward = rewards[j];
                resultObj.done = done;
                resultObj.truncated = trunc;
                resultObj.terminated = done && !trunc;
                resultObj.info.tick = ticks[j];
                resultObj.info.terminated = done && !trunc;
                if (hasTerminalObs[j] === 1) {
                    resultObj.info.terminal_observation = this.extractObservation(
                        terminalObs, j, resultIdx, this._terminalObsPool,
                    );
                } else {
                    resultObj.info.terminal_observation = undefined;
                }
                this._convertedResults.push(resultObj);
            }
            actionIdx += wEnvs;
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

        // Normalize termination flags in place (no per-result spreads) so
        // message mode reports the same values as the SAB path: a truncation
        // is never a natural termination, in both modes.
        const flat = results.flat();
        for (const result of flat) {
            const terminated = Boolean(result.done && !result.truncated);
            result.terminated = result.terminated ?? terminated;
            if (result.info) {
                result.info.terminated = terminated;
            }
        }
        return flat;
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
     * @param sabIdx Worker-local index for SAB float offset
     * @param poolIdx Global env index for _obsPool template
     */
    private extractObservation(obs: Float32Array, sabIdx: number, poolIdx: number, pool = this._obsPool): any {
        const offset = sabIdx * 16;
        const template = pool[poolIdx];
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
                arenaHalfWidth: obs[offset + 13],
                arenaHalfHeight: obs[offset + 14],
                tick: obs[offset + 15],
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

        template.arenaHalfWidth = obs[offset + 13];
        template.arenaHalfHeight = obs[offset + 14];
        template.tick = obs[offset + 15];

        return template;
    }

    /**
     * Request telemetry snapshots from all workers.
     * Each worker returns a copy of its local TelemetryBuffer.
     */
    async getTelemetrySnapshots(): Promise<BigUint64Array[]> {
        this.assertReady('get telemetry');
        const promises = [];
        for (let i = 0; i < this.workers.length; i++) {
            promises.push(this.sendMessage(this.workers[i], { type: 'GET_TELEMETRY' }));
        }
        const snapshots = await Promise.all(promises);
        return snapshots as BigUint64Array[];
    }

    async close() {
        this.state = 'closed';
        this.failure = null;
        this.wakeSharedWaiters();
        await this.cleanup(new Error('Worker pool closed'));
        this.useSharedMemory = false;
    }

    private assertReady(operation: string): void {
        if (this.state === 'failed') {
            throw new Error(`Cannot ${operation}: worker pool is in failed state (${this.failure?.message ?? 'unknown failure'})`);
        }
        if (this.state !== 'ready') {
            throw new Error(`Cannot ${operation}: worker pool is ${this.state}`);
        }
    }

    private createFailure(operation: string, cause: unknown): Error {
        const causeError = cause instanceof Error ? cause : new Error(String(cause));
        if (this.state === 'failed' && this.failure) {
            return this.failure;
        }
        const failure = new Error(`Worker pool ${operation} failed: ${causeError.message}`);
        (failure as any).cause = causeError;
        return failure;
    }

    private requireSharedMemoryManager(workerIndex: number): SharedMemoryManager {
        const shm = this.sharedMemManagers[workerIndex];
        if (!shm) {
            throw new Error(`Shared memory manager not initialized for worker ${workerIndex}`);
        }
        return shm;
    }

    private prepareSharedBatch(): Int32Array {
        if (!this._syncBuffer) {
            throw new Error('Shared completion state is not initialized');
        }
        const sync = new Int32Array(this._syncBuffer);
        Atomics.store(sync, SYNC_COMPLETED_INDEX, 0);
        for (let i = 0; i < this.workers.length; i++) {
            Atomics.store(sync, SYNC_STATUS_OFFSET + i, WORKER_IDLE);
        }
        return sync;
    }

    private async waitForSharedCompletion(sync: Int32Array, operation: string, timeoutMs: number): Promise<void> {
        const startedAt = Date.now();
        const numWorkers = this.workers.length;

        while (true) {
            if (this.state === 'failed' && this.failure) {
                throw this.failure;
            }
            if (this.state !== 'ready') {
                throw new Error(`Shared-memory ${operation} interrupted because worker pool is ${this.state}`);
            }

            const failedWorker = this.findWorkerWithStatus(sync, WORKER_ERROR);
            if (failedWorker !== -1) {
                throw new Error(`Worker ${failedWorker} reported an error during shared-memory ${operation}`);
            }

            const completed = Atomics.load(sync, SYNC_COMPLETED_INDEX);
            if (completed >= numWorkers) {
                break;
            }

            const remaining = timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) {
                throw this.createSharedTimeout(operation, sync, timeoutMs);
            }

            const waiter = (Atomics as any).waitAsync(sync, SYNC_COMPLETED_INDEX, completed, remaining);
            const waitResult = waiter.async ? await waiter.value : waiter.value;
            if (waitResult === 'timed-out') {
                throw this.createSharedTimeout(operation, sync, timeoutMs);
            }
        }

        const incompleteWorkers: number[] = [];
        for (let i = 0; i < numWorkers; i++) {
            if (Atomics.load(sync, SYNC_STATUS_OFFSET + i) !== WORKER_COMPLETE) {
                incompleteWorkers.push(i);
            }
        }
        if (incompleteWorkers.length > 0) {
            throw new Error(
                `Shared-memory ${operation} completion was invalid for worker(s) ${incompleteWorkers.join(', ')}`,
            );
        }
    }

    private createSharedTimeout(operation: string, sync: Int32Array, timeoutMs: number): Error {
        const pendingWorkers: number[] = [];
        for (let i = 0; i < this.workers.length; i++) {
            if (Atomics.load(sync, SYNC_STATUS_OFFSET + i) !== WORKER_COMPLETE) {
                pendingWorkers.push(i);
            }
        }
        return new Error(
            `Shared-memory ${operation} timed out after ${timeoutMs}ms waiting for worker(s) ${pendingWorkers.join(', ')}`,
        );
    }

    private findWorkerWithStatus(sync: Int32Array, status: number): number {
        for (let i = 0; i < this.workers.length; i++) {
            if (Atomics.load(sync, SYNC_STATUS_OFFSET + i) === status) {
                return i;
            }
        }
        return -1;
    }

    private handleWorkerFailure(worker: Worker, workerIndex: number, error: Error): void {
        if (this.workers[workerIndex] !== worker || this.state === 'closed' || this.state === 'failed') {
            return;
        }
        const failure = new Error(`Worker ${workerIndex} failed: ${error.message}`);
        (failure as any).cause = error;
        this.recordSharedWorkerFailure(workerIndex);
        void this.failPool(failure);
    }

    private recordSharedWorkerFailure(workerIndex: number): void {
        if (!this._syncBuffer) return;
        const sync = new Int32Array(this._syncBuffer);
        const statusIndex = SYNC_STATUS_OFFSET + workerIndex;
        const previous = Atomics.exchange(sync, statusIndex, WORKER_ERROR);
        if (previous === WORKER_IDLE) {
            Atomics.add(sync, SYNC_COMPLETED_INDEX, 1);
        }
        Atomics.notify(sync, SYNC_COMPLETED_INDEX);
    }

    private wakeSharedWaiters(): void {
        if (!this._syncBuffer) return;
        const sync = new Int32Array(this._syncBuffer);
        Atomics.add(sync, SYNC_COMPLETED_INDEX, Math.max(1, this.workers.length));
        Atomics.notify(sync, SYNC_COMPLETED_INDEX);
    }

    private async failPool(error: Error): Promise<void> {
        if (this.state !== 'failed') {
            this.state = 'failed';
            this.failure = error;
            this.wakeSharedWaiters();
        }
        await this.cleanup(this.failure ?? error);
    }

    private cleanup(callbackError: Error): Promise<void> {
        if (this.cleanupPromise) {
            return this.cleanupPromise;
        }

        for (const callback of this.callbacks.values()) {
            clearTimeout(callback.timeout);
            callback.reject(callbackError);
        }
        this.callbacks.clear();

        const workers = this.workers;
        const sharedMemManagers = this.sharedMemManagers;
        this.workers = [];
        this.workerEnvs = [];
        this.sharedMemManagers = [];
        this.actionBufferPool = [];
        this._obsPool = [];
        this._terminalObsPool = [];
        this._obsPoolSize = 0;
        this._finished = new Uint8Array(0);
        this._returnTimes = new BigUint64Array(0);
        this._resultPool = [];
        this._convertedResults = [];
        this.maxEnvsPerWorker = 0;

        const cleanupPromise = (async () => {
            try {
                await Promise.all(workers.map(async worker => {
                    try {
                        await worker.terminate();
                    } catch {
                        // Continue terminating and disposing the rest of the pool.
                    }
                }));
                for (const shm of sharedMemManagers) {
                    try {
                        shm?.dispose();
                    } catch {
                        // Continue disposing the rest of the pool.
                    }
                }
            } finally {
                this._syncBuffer = null;
                this.cleanupPromise = null;
            }
        })();
        this.cleanupPromise = cleanupPromise;
        return cleanupPromise;
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
