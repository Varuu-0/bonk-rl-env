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

export interface ResultOwnershipOptions {
    /**
     * `owned` returns caller-owned snapshots that remain stable across later
     * calls. `borrowed` exposes the shared-memory extraction pools and is only
     * valid until the next reset or step.
     *
     * Only the shared-memory transport is affected: message-passing results
     * are structured-cloned by the worker transport and are always
     * caller-owned, so the option is a no-op there (accepted for a symmetric
     * API).
     */
    ownership?: 'owned' | 'borrowed';
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
    // Shared-memory observation layout: 7 player floats + 6 per opponent +
    // 2 arena + 1 tick, with additional opponents appended after the tick.
    private _obsNumOpponents: number = 1;
    private _obsFloatsPerEnv: number = 16;

    // Pre-allocated finished buffer for step/reset
    private _finished: Uint8Array = new Uint8Array(0);

    // Pre-allocated return times buffer (avoids per-step array allocation)
    private _returnTimes: BigUint64Array = new BigUint64Array(0);

    // Pre-allocated result objects pool (avoids per-step object allocation)
    private _resultPool: any[] = [];
    private _convertedResults: any[] = [];

    // Shared sync buffer for completion counter (all workers share this)
    private _syncBuffer: SharedArrayBuffer | null = null;

    // Static info fields (frameSkip, capZones, aiTeam) per global env index,
    // transported once at init from each worker's environments. The dynamic
    // info fields (aiAlive, opponentsAlive, scoreBlue, scoreRed) arrive as
    // per-env SAB floats on every step, so shared-memory steps stay
    // zero-message.
    private _sharedStaticInfos: any[] = [];

    private state: WorkerPoolState = 'idle';
    private failure: Error | null = null;
    private cleanupPromise: Promise<void> | null = null;

    constructor(private numWorkers: number = getConfig().workerPool.numWorkers) {
    }

    private initObsPool(totalEnvs: number): void {
        this._obsPool = [];
        this._terminalObsPool = [];
        const numOpponents = this._obsNumOpponents;
        for (let i = 0; i < totalEnvs; i++) {
            const createTemplate = () => ({
                playerX: 0,
                playerY: 0,
                playerVelX: 0,
                playerVelY: 0,
                playerAngle: 0,
                playerAngularVel: 0,
                playerIsHeavy: false,
                opponents: Array.from({ length: numOpponents }, () => ({
                    x: 0,
                    y: 0,
                    velX: 0,
                    velY: 0,
                    isHeavy: false,
                    alive: false,
                })),
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

        // The shared-memory observation layout is sized from the configured
        // opponent count (mirroring BonkEnvironment's normalization) so every
        // opponent's state fits in the per-env record. All writers and
        // readers (this pool, the workers, the SharedMemoryManager) derive
        // the same layout from the same config object.
        const numOpponents = SharedMemoryManager.normalizeNumOpponents(config?.numOpponents);
        this._obsNumOpponents = numOpponents;
        this._obsFloatsPerEnv = 16 + 6 * Math.max(0, numOpponents - 1);

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
                        const shm = new SharedMemoryManager(numEnvs, this.ringSize, undefined, numOpponents);
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

            // Cache the static info fields (frameSkip, capZones, aiTeam) the
            // workers shipped at init, keyed by global env index. These are
            // constant per environment; only the dynamic info fields travel
            // per step.
            this._sharedStaticInfos = [];
            if (this.useSharedMemory) {
                let globalIdx = 0;
                for (let i = 0; i < this.workers.length; i++) {
                    // sendMessage resolves with the worker's reply data
                    // ({ mode, staticInfos } in shared mode).
                    const staticInfos = results[i]?.staticInfos ?? [];
                    for (let j = 0; j < this.workerEnvs[i]; j++) {
                        this._sharedStaticInfos[globalIdx] = staticInfos[j] ?? {};
                        globalIdx++;
                    }
                }
            }

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

    private allocateMessageId(): number {
        const liveCallbacks = this.callbacks.size;
        // Defensive invariant: a free uint32 id always exists below, so this
        // guard can never fire unless the callback map holds 2^32 entries.
        if (liveCallbacks >= 0x100000000) {
            throw new Error('WorkerPool message ID space exhausted');
        }

        // Probe `liveCallbacks + 1` distinct uint32 ids while only
        // `liveCallbacks` can be occupied, so a free id is guaranteed to be
        // found (pigeonhole principle) and a live callback is never overwritten.
        // The map is bounded in practice by in-flight messages because replies
        // and 30s timeouts both delete their callback entry.
        let id = this.msgId >>> 0;
        for (let attempt = 0; attempt <= liveCallbacks; attempt++) {
            this.msgId = (id + 1) >>> 0;
            if (!this.callbacks.has(id)) return id;
            id = this.msgId;
        }

        // Unreachable; kept as a defensive guard for future allocator changes.
        throw new Error('WorkerPool could not allocate a message ID');
    }

    private sendMessage(worker: Worker, msg: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.allocateMessageId();
            // Set a timeout to reject if no response
            const timeout = setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    console.error(`[WorkerPool] Message ${id} timed out`);
                    const err = new Error(`Message ${id} timed out`) as Error & { code?: string };
                    // A timed-out reply means the worker is hung/unreachable,
                    // which is distinct from an error reply from a live worker.
                    err.code = 'WORKER_TIMEOUT';
                    reject(err);
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

    /**
     * Reset all environments. Results are caller-owned by default.
     * Borrowed results must be consumed before the next reset or step and must
     * not be retained or mutated.
     *
     * Message-passing mode always returns caller-owned results; `ownership`
     * only affects the shared-memory extraction path.
     */
    async reset(seeds?: number[], options: ResultOwnershipOptions = {}): Promise<any[]> {
        this.assertReady('reset');

        // Validate the seed batch before touching any worker state. An
        // over-long seed array would otherwise be silently truncated by the
        // per-worker slices below, dropping the surplus seeds with no error in
        // either transport (the over-long mirror of the short-batch defects
        // #191/#207). Short seed lists remain legal: they reset the tail
        // environments unseeded, the documented #183 semantics pinned by
        // worker-pool-stale-seeds.test.ts.
        const totalEnvs = this.totalEnvs();
        if (seeds !== undefined && !Array.isArray(seeds)) {
            throw new Error(`Invalid seed batch: expected an array of seeds, got ${typeof seeds}`);
        }
        if (seeds !== undefined && seeds.length > totalEnvs) {
            const received = seeds.length;
            throw new Error(
                `Invalid seed batch: expected at most ${totalEnvs} seed${totalEnvs === 1 ? '' : 's'} for ${totalEnvs} environment${totalEnvs === 1 ? '' : 's'}, got ${received}`,
            );
        }

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
                        const observation = this.extractObservation(res.observations, j, globalEnvIdx);
                        observations.push(options.ownership === 'borrowed'
                            ? observation
                            : this.snapshotObservation(observation));
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
            // Message-passing results are already caller-owned structured clones,
            // so the ownership option only affects the shared-memory extraction
            // path above.
            const results = await this.settleMessageBatch(promises);
            return results.flat();
        } catch (error) {
            if (this.state === 'closed') {
                throw error;
            }
            const failure = this.createFailure('reset', error);
            // Shared-memory batches can corrupt or desync the pool, so any
            // failure there is fatal. In message mode an error reply from a
            // live worker is transient and must not kill the pool, but a
            // timeout means the worker is hung/unreachable: fail so callers
            // re-init instead of waiting out the full timeout on every call.
            if (this.useSharedMemory || this.isWorkerTimeout(error)) {
                await this.failPool(failure);
            }
            throw failure;
        }
    }

    /**
     * Step all environments. Results are caller-owned by default.
     * Borrowed results preserve the zero-allocation extraction path but the
     * entire returned graph is invalidated by the next reset or step.
     *
     * Message-passing mode always returns caller-owned structured clones, so
     * `ownership` is a no-op there (accepted for a symmetric API).
     */
    async step(actions: any[], options: ResultOwnershipOptions = {}): Promise<any[]> {
        this.assertReady('step');
        // Validate the batch before touching any worker state. A short or
        // over-long action array is a per-request input error in both
        // transports (mirroring the Python client's exact-count check) and
        // must never fail or desync the pool.
        const totalEnvs = this.totalEnvs();
        if (!Array.isArray(actions) || actions.length !== totalEnvs) {
            const received = Array.isArray(actions) ? actions.length : typeof actions;
            throw new Error(
                `Invalid action batch: expected ${totalEnvs} action${totalEnvs === 1 ? '' : 's'} for ${totalEnvs} environment${totalEnvs === 1 ? '' : 's'}, got ${received}`,
            );
        }
        try {
            // Shared memory mode honors `ownership`; message-passing mode always
            // returns caller-owned structured clones.
            if (this.useSharedMemory) {
                return await this.stepSharedMemory(actions, options);
            }
            return await this.stepMessagePassing(actions, options);
        } catch (error) {
            if (this.state === 'closed') {
                throw error;
            }
            const failure = this.createFailure('step', error);
            // Failure policy is failure-class-aware. Message-mode error
            // replies from live workers are transient and must not kill the
            // pool. In shared mode, only failures that can plausibly corrupt
            // or desync the pool are fatal (worker timeout/crash/exit,
            // worker-reported errors, errors after signals were issued); a
            // pre-signal encoding error leaves the pool untouched and is
            // treated as a transient per-request error, exactly like message
            // mode.
            if (this.isWorkerTimeout(error) || (this.useSharedMemory && !this.isActionEncodeError(error))) {
                await this.failPool(failure);
            }
            throw failure;
        }
    }

    /**
     * Step using shared memory (zero-copy IPC)
     * Writes actions to shared memory, signals workers, and waits for results
     */
    private async stepSharedMemory(actions: any[], options: ResultOwnershipOptions): Promise<any[]> {
        const batchStart = process.hrtime.bigint();
        this._returnTimes.fill(BigInt(0));
        const returnTimes = this._returnTimes;

        // Phase 1 — encode every action into the per-worker buffers before any
        // worker is signalled. An encoding failure (e.g. a null entry) is a
        // per-request input error: no command has been sent, so the pool is
        // untouched and the caller may retry. It is tagged so step() can treat
        // it as transient rather than failing the pool.
        let actionIdx = 0;
        try {
            for (let i = 0; i < this.workers.length; i++) {
                const wEnvs = this.workerEnvs[i];

                const encodedActions = this.actionBufferPool[i];
                for (let j = 0; j < wEnvs; j++) {
                    encodedActions[j] = this.encodeAction(actions[actionIdx + j]);
                }
                actionIdx += wEnvs;
            }
        } catch (error) {
            const tagged = error instanceof Error ? error : new Error(String(error));
            (tagged as Error & { code?: string }).code = 'ACTION_ENCODE';
            throw tagged;
        }

        // Phase 2 — signal all workers and wait for results without blocking
        // worker event delivery. From here on any failure may have left worker
        // state inconsistent, so the step() handler treats it as fatal.
        const completedArr = this.prepareSharedBatch();

        for (let i = 0; i < this.workers.length; i++) {
            const shm = this.requireSharedMemoryManager(i);
            shm.writeActionsQuiet(this.actionBufferPool[i]);
            shm.sendCommand(0); // STEP command (also notifies worker)
        }

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
            const terminated = rawResults.terminated;
            const ticks = rawResults.ticks;
            const terminalObs = rawResults.terminalObservations;
            const hasTerminalObs = rawResults.hasTerminalObs;
            const infoArr = rawResults.info;

            // Extract results for each environment in this worker
            for (let j = 0; j < wEnvs; j++) {
                const resultIdx = actionIdx + j;
                const resultObj = this._resultPool[resultIdx];
                const done = dones[j] === 1;
                const trunc = truncated[j] === 1;
                // The worker's per-env terminated flag is the environment's
                // own info.terminated (a death on the maxTicks boundary
                // reports both flags, #208); reconstructing it as
                // done && !trunc would turn that death into a pure
                // truncation. Fall back to the reconstruction only when the
                // flag array is absent (e.g. mocked managers).
                const term = terminated ? terminated[j] === 1 : done && !trunc;

                // Reassemble the info contract on the pooled info object: the
                // static fields (frameSkip, capZones, aiTeam) were cached at
                // init, and the dynamic fields arrive as per-env SAB floats.
                // tick/terminated come from the SAB scalars, and the terminal
                // observation is re-extracted from the SAB so the pooled
                // graph stays self-contained. The result matches the
                // message-passing info dictionary exactly.
                const staticInfo = this._sharedStaticInfos[resultIdx] ?? {};
                Object.assign(resultObj.info, staticInfo, {
                    aiAlive: infoArr[j * 4 + 0] === 1,
                    opponentsAlive: infoArr[j * 4 + 1],
                    scoreBlue: infoArr[j * 4 + 2],
                    scoreRed: infoArr[j * 4 + 3],
                });
                resultObj.observation = this.extractObservation(obs, j, resultIdx);
                resultObj.reward = rewards[j];
                resultObj.done = done;
                resultObj.truncated = trunc;
                resultObj.terminated = term;
                resultObj.info.tick = ticks[j];
                resultObj.info.terminated = term;
                if (hasTerminalObs[j] === 1) {
                    resultObj.info.terminal_observation = this.extractObservation(
                        terminalObs, j, resultIdx, this._terminalObsPool,
                    );
                } else {
                    // Remove the key instead of assigning undefined: the info
                    // object is pooled per environment and reused for every
                    // step, so assigning `undefined` would keep the key on the
                    // object forever (`'terminal_observation' in info` stays
                    // true on non-terminal steps). Message-passing results
                    // build a fresh info per step and never carry the key
                    // when the episode did not end.
                    delete resultObj.info.terminal_observation;
                }
                this._convertedResults.push(resultObj);
            }
            actionIdx += wEnvs;
        }

        if (options.ownership === 'borrowed') {
            return this._convertedResults;
        }

        const ownedResults = new Array(this._convertedResults.length);
        for (let i = 0; i < this._convertedResults.length; i++) {
            ownedResults[i] = this.snapshotResult(this._convertedResults[i]);
        }
        return ownedResults;
    }

    /**
     * Step using message passing (fallback mode).
     *
     * Results are structured-cloned by the worker transport, so they are
     * already caller-owned in both `owned` and `borrowed` modes. `options` is
     * accepted for API symmetry with the shared-memory path and has no effect
     * on allocation or retention semantics here.
     */
    private async stepMessagePassing(actions: any[], options: ResultOwnershipOptions): Promise<any[]> {
        // Encode the whole batch before any worker is signalled, mirroring
        // the shared-memory path's phase-1 encoding. A full-length batch that
        // contains e.g. `undefined` would otherwise throw inside a worker
        // mid-slice: that worker's earlier environments would already have
        // advanced while the pool stays ready, leaving the batch partially
        // executed and every later step desynced (#207). The ACTION_ENCODE
        // label marks this as a per-request input error with the pool
        // untouched, exactly like the shared-memory transport. The encoded
        // numbers are dispatched directly, so the worker decodes them instead
        // of re-validating the raw entries.
        const encodedActions = new Array<number>(actions.length);
        try {
            for (let i = 0; i < actions.length; i++) {
                encodedActions[i] = this.encodeAction(actions[i]);
            }
        } catch (error) {
            const tagged = error instanceof Error ? error : new Error(String(error));
            (tagged as Error & { code?: string }).code = 'ACTION_ENCODE';
            throw tagged;
        }

        const batchStart = process.hrtime.bigint();
        const returnTimes: bigint[] = [];

        const promises = [];
        let actionIdx = 0;
        for (let i = 0; i < this.workers.length; i++) {
            const wEnvs = this.workerEnvs[i];
            const wActions = encodedActions.slice(actionIdx, actionIdx + wEnvs);

            const p = this.sendMessage(this.workers[i], { type: 'step', actions: wActions })
                .then(data => {
                    returnTimes.push(process.hrtime.bigint());
                    return data;
                });

            promises.push(p);
            actionIdx += wEnvs;
        }

        const results = await this.settleMessageBatch(promises);
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

        // Normalize termination flags in place (no per-result spreads). The
        // environment's own info.terminated is authoritative: a death on the
        // same tick maxTicks is reached reports terminated=true AND
        // truncated=true, and reconstructing terminated as done && !truncated
        // would destroy the death signal (#208). The reconstruction is only a
        // fill-in for worker results that omitted the flag. Both fields are
        // assigned from the same value so they cannot diverge, matching the
        // SAB path.
        const flat = results.flat();
        for (const result of flat) {
            const envTerminated = result.info ? result.info.terminated : undefined;
            const terminated = envTerminated !== undefined
                ? Boolean(envTerminated)
                : Boolean(result.done && !result.truncated);
            result.terminated = terminated;
            if (result.info) {
                result.info.terminated = terminated;
            }
        }
        return flat;
    }

    /**
     * Encodes a PlayerInput action to a number for shared memory storage
     * Uses bit flags: left=1, right=2, up=4, down=8, heavy=16, grapple=32
     *
     * Null/undefined or otherwise malformed entries throw a labeled error
     * instead of failing with an unlabelled TypeError, so callers can tell a
     * bad request apart from a pool failure.
     */
    private encodeAction(action: PlayerInput | number): number {
        if (typeof action === 'number') {
            return action; // Already encoded
        }
        if (action === null || typeof action !== 'object') {
            throw new Error(
                `Invalid action: expected a PlayerInput object or an encoded number, got ${action === null ? 'null' : typeof action}`,
            );
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
     * Deep-copies a pooled observation/result graph so the caller owns every
     * nested mutable field and buffer.
     *
     * Supported value contract: primitives; plain objects; arrays; Date,
     * RegExp, Map, Set; typed arrays; Node Buffers (copied byte-for-byte via
     * `Buffer.from`, because `Buffer.prototype.slice` aliases the source
     * memory); DataView; ArrayBuffer; and SharedArrayBuffer-backed views
     * (re-sliced into owned buffers, unlike `structuredClone`, which shares
     * SABs). Other exotic structured-cloneable values (Error, URL, Blob, ...)
     * are outside the contract: the pooled observation/result graphs are plain
     * data, and such members degrade to `{}`.
     *
     * Plain objects and arrays preserve shared references and cycles via the
     * `seen` map. Buffer, Date, RegExp, Map, Set, typed-array, DataView,
     * ArrayBuffer, and SAB members are copied per occurrence (each occurrence
     * gets an independent copy). A self-referential Map/Set resolves its
     * back-reference to the in-progress copy instead of recursing, so
     * self-referential Map/Set graphs terminate.
     */
    private deepCopy(value: any, seen: Map<any, any> = new Map()): any {
        if (value === null || typeof value !== 'object') return value;

        if (value instanceof Date) return new Date(value.getTime());
        if (value instanceof RegExp) return new RegExp(value.source, value.flags);
        if (value instanceof Map) {
            const inProgress = seen.get(value);
            if (inProgress) return inProgress;
            const copy = new Map();
            seen.set(value, copy);
            for (const [k, v] of value) copy.set(k, this.deepCopy(v, seen));
            seen.delete(value);
            return copy;
        }
        if (value instanceof Set) {
            const inProgress = seen.get(value);
            if (inProgress) return inProgress;
            const copy = new Set();
            seen.set(value, copy);
            for (const v of value) copy.add(this.deepCopy(v, seen));
            seen.delete(value);
            return copy;
        }
        if (ArrayBuffer.isView(value)) {
            if (value instanceof DataView) {
                return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
            }
            const bufferCtor = (globalThis as any).Buffer;
            if (bufferCtor && value instanceof bufferCtor) {
                // Node Buffer#slice aliases the source memory, so copy the
                // bytes into a fresh Buffer instead of slicing.
                return bufferCtor.from(value);
            }
            // TypedArray#slice copies into a fresh buffer, so
            // SharedArrayBuffer-backed views become owned rather than sharing
            // the pool's SAB.
            return (value as any).slice();
        }
        if (value instanceof ArrayBuffer) {
            return value.slice(0);
        }
        const sabCtor = (globalThis as any).SharedArrayBuffer;
        if (sabCtor && value instanceof sabCtor) {
            return value.slice(0);
        }

        const cached = seen.get(value);
        if (cached) return cached;
        const copy: any = Array.isArray(value) ? [] : {};
        seen.set(value, copy);
        for (const key of Object.keys(value)) {
            copy[key] = this.deepCopy(value[key], seen);
        }
        return copy;
    }

    /**
     * Materializes a caller-owned snapshot of a pooled observation/result
     * graph. Delegates to {@link deepCopy}, which copies every nested buffer
     * (including SharedArrayBuffer-backed views) instead of sharing them as
     * `structuredClone` would.
     */
    private snapshotCopy(value: any): any {
        return this.deepCopy(value);
    }

    /**
     * Copies a pooled observation graph so the caller owns every nested
     * mutable field (the `opponents` array and its objects today, and any
     * nested objects `extractObservation` adds later). The structural guard in
     * worker-pool-sharedmem-regression.test.ts fails if a nested field aliases
     * a pooled template.
     */
    private snapshotObservation(observation: any): any {
        return this.snapshotCopy(observation);
    }

    private snapshotResult(result: any): any {
        return this.snapshotCopy(result);
    }

    /**
     * Extracts observation data from shared memory Float32Array
     * @param obs Float32Array containing all observations
     * @param sabIdx Worker-local index for SAB float offset
     * @param poolIdx Global env index for _obsPool template
     */
    private extractObservation(obs: Float32Array, sabIdx: number, poolIdx: number, pool = this._obsPool): any {
        const offset = sabIdx * this._obsFloatsPerEnv;
        const template = pool[poolIdx];
        if (!template) {
            const opponents = [];
            for (let i = 0; i < this._obsNumOpponents; i++) {
                const base = i === 0 ? 7 : 16 + 6 * (i - 1);
                opponents.push({
                    x: obs[offset + base + 0],
                    y: obs[offset + base + 1],
                    velX: obs[offset + base + 2],
                    velY: obs[offset + base + 3],
                    isHeavy: obs[offset + base + 4] === 1,
                    alive: obs[offset + base + 5] === 1,
                });
            }
            return {
                playerX: obs[offset + 0],
                playerY: obs[offset + 1],
                playerVelX: obs[offset + 2],
                playerVelY: obs[offset + 3],
                playerAngle: obs[offset + 4],
                playerAngularVel: obs[offset + 5],
                playerIsHeavy: obs[offset + 6] === 1,
                opponents,
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

        for (let i = 0; i < template.opponents.length; i++) {
            const opp = template.opponents[i];
            const base = i === 0 ? 7 : 16 + 6 * (i - 1);
            opp.x = obs[offset + base + 0];
            opp.y = obs[offset + base + 1];
            opp.velX = obs[offset + base + 2];
            opp.velY = obs[offset + base + 3];
            opp.isHeavy = obs[offset + base + 4] === 1;
            opp.alive = obs[offset + base + 5] === 1;
        }

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
        const settled = await Promise.allSettled(promises);
        const hungWorker = settled.find(r => r.status === 'rejected' && this.isWorkerTimeout(r.reason));
        if (hungWorker) {
            const failure = this.createFailure('telemetry', (hungWorker as { reason: Error }).reason);
            // In shared mode workers block in Atomics.wait and never service
            // GET_TELEMETRY, so that timeout is expected and recoverable. In
            // message mode a timeout means the worker is hung/unreachable:
            // fail so callers re-init instead of burning the full timeout on
            // every snapshot.
            if (!this.useSharedMemory) {
                await this.failPool(failure);
            }
            throw failure;
        }
        const firstRejection = settled.find(r => r.status === 'rejected');
        if (firstRejection) {
            throw (firstRejection as { reason: Error }).reason;
        }
        return settled.map(r => (r as { value: any }).value) as BigUint64Array[];
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

    private isWorkerTimeout(error: unknown): boolean {
        return (error as { code?: string })?.code === 'WORKER_TIMEOUT';
    }

    /**
     * True when the error was thrown while encoding actions, before any worker
     * was signalled. Such errors leave the shared-memory pool untouched and are
     * transient per-request failures rather than pool-fatal ones.
     */
    private isActionEncodeError(error: unknown): boolean {
        return (error as { code?: string })?.code === 'ACTION_ENCODE';
    }

    private totalEnvs(): number {
        return this.workerEnvs.reduce((sum, n) => sum + n, 0);
    }

    /**
     * Settles a message-mode batch, preferring a hung-worker timeout over any
     * live-worker error reply that happened to reject first. Promise.all would
     * swallow the later timeout once the batch has settled, leaving the pool
     * ready with an unreachable worker; waiting for every worker keeps the
     * tagged timeout visible so the caller can fail the pool.
     */
    private async settleMessageBatch(promises: Promise<any>[]): Promise<any[]> {
        const settled = await Promise.allSettled(promises);
        const hungWorker = settled.find(r => r.status === 'rejected' && this.isWorkerTimeout(r.reason));
        if (hungWorker) {
            throw (hungWorker as { reason: Error }).reason;
        }
        const firstRejection = settled.find(r => r.status === 'rejected');
        if (firstRejection) {
            throw (firstRejection as { reason: Error }).reason;
        }
        return settled.map(r => (r as { value: any }).value);
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

        this._sharedStaticInfos = [];

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
