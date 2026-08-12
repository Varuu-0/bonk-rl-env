import { parentPort } from 'worker_threads';
import { BonkEnvironment, Action, Observation, StepResult } from './environment';
import { SharedMemoryManager } from '../ipc/shared-memory';

// Type for SharedArrayBuffer (available in Node.js >= 9.1.0)
declare const SharedArrayBuffer: any;

if (!parentPort) {
    throw new Error('This file must be run as a worker thread.');
}

import { globalProfiler, TelemetryBuffer } from '../telemetry/profiler';

let envs: BonkEnvironment[] = [];
let stepCounter = 0;
let sharedMem: SharedMemoryManager | null = null;
let numEnvs = 0;
let globalOffset = 0;
let syncCompleted: Int32Array | null = null;
let syncWorkerIndex = 0;

const WORKER_COMPLETE = 1;
const WORKER_ERROR = -1;

function signalSyncCompleted(status: number = WORKER_COMPLETE) {
    if (!syncCompleted) return;
    Atomics.store(syncCompleted, syncWorkerIndex + 1, status);
    Atomics.add(syncCompleted, 0, 1);
    Atomics.notify(syncCompleted, 0, 1);
}

/**
 * Converts an Observation to a flat number array for shared memory storage.
 * Layout: playerX, playerY, playerVelX, playerVelY, playerAngle,
 * playerAngularVel, playerIsHeavy (0-6), first opponent block (7-12:
 * x, y, velX, velY, isHeavy, alive), arenaHalfWidth (13), arenaHalfHeight
 * (14), tick (15), then one 6-float block per additional opponent (16+).
 * The buffer is sized for the configured opponent count at init.
 */
// Pre-allocated buffer for zero-allocation observation conversion
let _obsBuffer = new Float32Array(16);
let _obsNumOpponents = 1;
// Pre-allocated per-env dynamic info floats (aiAlive, opponentsAlive,
// scoreBlue, scoreRed) written into the SAB info region.
const _infoBuffer = new Float32Array(4);

function observationToArray(obs: Observation): Float32Array {
    _obsBuffer[0] = obs.playerX;
    _obsBuffer[1] = obs.playerY;
    _obsBuffer[2] = obs.playerVelX;
    _obsBuffer[3] = obs.playerVelY;
    _obsBuffer[4] = obs.playerAngle;
    _obsBuffer[5] = obs.playerAngularVel;
    _obsBuffer[6] = obs.playerIsHeavy ? 1 : 0;

    // The opponent count is fixed per config and every reset spawns exactly
    // that many, so each block is rewritten on every call (blocks beyond the
    // live count stay zero because the buffer is fresh and never had values
    // written into them).
    const numOpponents = Math.min(obs.opponents.length, _obsNumOpponents);
    for (let i = 0; i < numOpponents; i++) {
        const opp = obs.opponents[i];
        const base = i === 0 ? 7 : 16 + 6 * (i - 1);
        _obsBuffer[base] = opp.x;
        _obsBuffer[base + 1] = opp.y;
        _obsBuffer[base + 2] = opp.velX;
        _obsBuffer[base + 3] = opp.velY;
        _obsBuffer[base + 4] = opp.isHeavy ? 1 : 0;
        _obsBuffer[base + 5] = opp.alive ? 1 : 0;
    }

    _obsBuffer[13] = obs.arenaHalfWidth;
    _obsBuffer[14] = obs.arenaHalfHeight;
    _obsBuffer[15] = obs.tick;
    return _obsBuffer;
}

function observationFastToArray(env: BonkEnvironment): Float32Array {
    return env.getObservationFast();
}

/**
 * Canonical transport precision (issue #236): observations and rewards are
 * published as IEEE-754 Float32 in every transport. The shared-memory path
 * quantizes by construction (the SAB observation/reward records are
 * Float32Array views filled from the Float32 _obsBuffer and storage), so
 * message-passing replies quantize here with Math.fround (identical
 * round-to-nearest-even) to make both transports bit-identical for the same
 * (seed, actions). This is the transport contract we ship to all consumers:
 * the shared-memory transport is the default and its Float32 values are what
 * the pool has always returned; message-mode previously returning raw Float64
 * values was the observable inconsistency being fixed, not a downgrade of a
 * consumed precision. Downstream clients already operate at Float32: the
 * Python client declares a `Box(..., dtype=np.float32)` observation space and
 * converts every observation into float32 numpy arrays
 * (python/envs/bonk_env.py), and its reward-dtype tests accept float32.
 * No first-party consumer does exact-Float64 comparisons on rewards.
 *
 * A fresh observation object is returned and the input is never mutated, so
 * physics-visible state can never be affected even if a future environment
 * caches or reuses observation objects. Boolean/flag fields and the integer
 * tick are exact in Float32 and are copied through untouched.
 */
function quantizeObservation(obs: Observation): Observation {
    return {
        playerX: Math.fround(obs.playerX),
        playerY: Math.fround(obs.playerY),
        playerVelX: Math.fround(obs.playerVelX),
        playerVelY: Math.fround(obs.playerVelY),
        playerAngle: Math.fround(obs.playerAngle),
        playerAngularVel: Math.fround(obs.playerAngularVel),
        playerIsHeavy: obs.playerIsHeavy,
        opponents: obs.opponents.map(opp => ({
            x: Math.fround(opp.x),
            y: Math.fround(opp.y),
            velX: Math.fround(opp.velX),
            velY: Math.fround(opp.velY),
            isHeavy: opp.isHeavy,
            alive: opp.alive,
        })),
        arenaHalfWidth: Math.fround(obs.arenaHalfWidth),
        arenaHalfHeight: Math.fround(obs.arenaHalfHeight),
        tick: obs.tick,
    };
}

/**
 * Applies the per-env auto-reset rule for a step result. The terminal
 * observation is always captured on a done step. The environment itself is
 * reset only once its frame-skip terminal hold window has been served: with
 * frameSkip > 1 the env keeps returning done for the whole window, so an
 * unconditional reset on the first done step would discard the hold and
 * surface a fresh episode one step after the terminal one (#228). On the
 * reset step the result keeps the ended episode's observation, so the
 * returned graph stays internally consistent (observation.tick aligns with
 * info.tick, and the fresh episode's observation only appears on the next
 * step, #222).
 */
function applyStepAutoReset(env: BonkEnvironment, res: StepResult): StepResult {
    if (!res.done) return res;
    res.info.terminal_observation = res.observation;
    if (!env.isTerminalHoldActive()) {
        const terminalObservation = res.observation;
        env.reset();
        res.observation = terminalObservation;
    }
    return res;
}

parentPort.on('message', (msg) => {
    try {
        if (msg.type === 'init') {
            const numEnvsParam = msg.numEnvs;
            const config = msg.config || {};
            // The global env index base must be assigned BEFORE the env loop:
            // construction seeds are derived from it, and workers k ≥ 1 would
            // otherwise reuse the previous/zero offset and duplicate worker 0's
            // streams (review of #200).
            globalOffset = msg.startId || 0;
            // Size the shared-memory observation buffer and manager for the
            // configured opponent count so all opponents are transported.
            // The documented snake_case num_opponents alias resolves here
            // exactly as it does in BonkEnvironment, so a snake_case-only
            // config sizes the buffer for every spawned opponent instead of
            // the default 1, which would overflow the SAB record on the
            // first non-terminal step (#262).
            _obsNumOpponents = SharedMemoryManager.normalizeNumOpponents(
                config.numOpponents ?? (config as any)?.num_opponents,
            );
            _obsBuffer = new Float32Array(16 + 6 * Math.max(0, _obsNumOpponents - 1));
            envs = [];
            for (let i = 0; i < numEnvsParam; i++) {
                // Each global environment gets its own deterministic
                // construction seed: the configured seed (the loader default 0
                // is now honored, #200) plus the global env index. Pooled
                // environments therefore never all share an identical PRNG
                // stream, while every environment's construction stream stays
                // reproducible for the same config. The worker's later reset()
                // with per-env seeds overrides this stream exactly as before.
                envs.push(new BonkEnvironment({ ...config, seed: (config.seed ?? 0) + globalOffset + i }));
            }
            numEnvs = numEnvsParam;

            // If sharedBuffer is provided and is a valid SharedArrayBuffer, initialize SharedMemoryManager
            // Note: When passed via postMessage, SharedArrayBuffer becomes an empty object.
            // We check for 'byteLength' property which real SharedArrayBuffers have.
            const isValidSharedBuffer = msg.sharedBuffer && typeof msg.sharedBuffer.byteLength === 'number';
            console.log(`[Worker] Init: sharedBuffer valid = ${isValidSharedBuffer}, byteLength = ${msg.sharedBuffer?.byteLength}`);
            if (isValidSharedBuffer) {
                console.log(`[Worker] Using shared memory mode`);
                const ringSize = msg.ringSize || 16;
                sharedMem = new SharedMemoryManager(
                    numEnvsParam,
                    ringSize,
                    msg.sharedBuffer as SharedArrayBuffer,
                    _obsNumOpponents
                );
                if (msg.syncBuffer) {
                    syncCompleted = new Int32Array(msg.syncBuffer);
                    syncWorkerIndex = msg.workerIndex ?? 0;
                }
                parentPort!.postMessage({
                    id: msg.id,
                    status: 'ok',
                    data: {
                        mode: 'shared',  // Include mode in data for compatibility
                        // Static info fields (frameSkip, capZones, aiTeam) are
                        // constant per environment; transport them once here
                        // instead of per step.
                        staticInfos: envs.map(env => env.getStaticInfo()),
                    }
                });
            } else {
                console.log(`[Worker] Using message passing mode`);
                parentPort!.postMessage({
                    id: msg.id,
                    status: 'ok',
                    data: { mode: 'message' }  // Include mode in data for compatibility
                });
            }
        } else if (msg.type === 'reset') {
            console.log(`[Worker] Processing reset with seeds: ${msg.seeds}`);
            const seeds: number[] | undefined = msg.seeds;
            const obs = envs.map((env, i) => env.reset(seeds ? seeds[i] : undefined));
            console.log(`[Worker] Reset completed, obs: ${JSON.stringify(obs).substring(0, 100)}`);

            // If using shared memory, write observations to it as well
            if (sharedMem) {
                obs.forEach((o, i) => sharedMem!.writeObservation(i, observationToArray(o)));
                sharedMem.signalMainReady();
                signalSyncCompleted();
            }
            // Always include observation data in the response (shared memory is for step(), not reset())
            obs.forEach((o, i) => { obs[i] = quantizeObservation(o); });
            parentPort!.postMessage({
                id: msg.id,
                status: 'ok',
                data: obs
            });
        } else if (msg.type === 'step') {
            // Handle step with message passing (fallback mode)
            const actions: Action[] = msg.actions;

            const results = envs.map((env, i) => applyStepAutoReset(env, env.step(actions[i])));

            stepCounter++;
            if (stepCounter % 1000 === 0) {
                globalProfiler.recordMemory();
            }

            // Canonical transport precision (issue #236): the shared-memory
            // path stores observations and rewards as Float32, so message
            // replies quantize to the same precision for bit-identical
            // (seed, actions) replay across transports. On terminal steps the
            // terminal observation is a distinct object from the post-reset
            // observation, so both are quantized.
            for (const res of results) {
                res.observation = quantizeObservation(res.observation);
                if (res.info.terminal_observation) {
                    res.info.terminal_observation = quantizeObservation(res.info.terminal_observation);
                }
                res.reward = Math.fround(res.reward);
            }

            parentPort!.postMessage({
                id: msg.id,
                status: 'ok',
                data: results,
                telemetry: {
                    tick: stepCounter
                }
            });
        } else if (msg.type === 'step-shared') {
            // Handle step using shared memory (zero-copy mode)
            if (!sharedMem) {
                parentPort!.postMessage({
                    id: msg.id,
                    status: 'error',
                    error: 'Shared memory not initialized for step-shared mode'
                });
                return;
            }

            // Read actions from shared memory as Uint8Array (indexed directly)
            const actions = sharedMem.readActions(sharedMem.readActionSlot());

            // Process environments
            const results = envs.map((env, i) => applyStepAutoReset(env, env.step(actions[i])));

            stepCounter++;
            if (stepCounter % 100 === 0) {
                globalProfiler.recordMemory();
            }

            // Write results directly to shared memory
            if (sharedMem) {
                results.forEach((res, i) => {
                    if (res.done) {
                        sharedMem!.writeTerminalObservation(i, observationToArray(res.info.terminal_observation));
                        sharedMem!.writeHasTerminalObs(i, 1);
                    } else {
                        sharedMem!.writeHasTerminalObs(i, 0);
                    }
                    // The observation region must describe the same episode
                    // as info.tick: on a done step the environment may
                    // already have been auto-reset (hold complete), so write
                    // the result's terminal observation instead of the next
                    // episode's fresh spawn (#222).
                    sharedMem!.writeObservation(i, res.done ? observationToArray(res.observation) : observationFastToArray(envs[i]));
                    sharedMem!.writeReward(i, res.reward);
                    sharedMem!.writeDone(i, res.done ? 1 : 0);
                    sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                    sharedMem!.writeTerminated(i, res.info.terminated ? 1 : 0);
                    sharedMem!.writeTick(i, res.info.tick || stepCounter);
                    // Dynamic info fields travel as SAB floats; the static
                    // fields were shipped once at init.
                    _infoBuffer[0] = res.info.aiAlive ? 1 : 0;
                    _infoBuffer[1] = res.info.opponentsAlive;
                    _infoBuffer[2] = res.info.scoreBlue;
                    _infoBuffer[3] = res.info.scoreRed;
                    sharedMem!.writeInfo(i, _infoBuffer);
                });

                // Signal that worker has consumed the actions
                sharedMem.signalWorkerConsumed();

                // Signal main thread that results are ready
                sharedMem.signalMainReady();

                parentPort!.postMessage({
                    id: msg.id,
                    status: 'ok',
                    mode: 'shared',
                    telemetry: {
                        tick: stepCounter
                    }
                });
            }
        } else if (msg.type === 'wait-for-action') {
            const config = msg.config || {};
            const verbose = config.verboseTelemetry ?? false;

            if (sharedMem) {
                try {
                while (true) {
                    // Wait for main to signal
                    const waitResult = sharedMem.waitForActions();

                    if (waitResult === 'timed-out') {
                        // Always notify parent about timeout and break the loop
                        parentPort!.postMessage({ id: msg.id, status: 'timeout' });
                        break;
                    }

                    // Check which command was sent
                    const cmd = sharedMem.readCommand();

                    if (cmd === 1) {
                        // RESET COMMAND
                        const seedsView = sharedMem.readSeeds();
                        const obs = envs.map((env, i) => {
                            const s = seedsView[i];
                            return env.reset(s === 0 ? undefined : s - 1);
                        });

                        obs.forEach((o, i) => sharedMem!.writeObservation(i, observationToArray(o)));

                        sharedMem.signalWorkerConsumed();
                        sharedMem.signalMainReady();
                        signalSyncCompleted();

                        if (verbose) {
                            parentPort!.postMessage({ id: msg.id, status: 'reset-ok' });
                        }
                    } else {
                        // STEP COMMAND (Default or 0)
                        const actionSlot = sharedMem.readActionSlot();
                        const actions = sharedMem.getActionsView(actionSlot);

                        const results = envs.map((env, i) => applyStepAutoReset(env, env.step(actions[i])));

                        stepCounter++;
                        if (verbose && stepCounter % 1000 === 0) {
                            globalProfiler.recordMemory();
                        }

                        results.forEach((res, i) => {
                            if (res.done) {
                                sharedMem!.writeTerminalObservation(i, observationToArray(res.info.terminal_observation));
                                sharedMem!.writeHasTerminalObs(i, 1);
                            } else {
                                sharedMem!.writeHasTerminalObs(i, 0);
                            }
                            // The observation region must describe the same
                            // episode as info.tick: on a done step the
                            // environment may already have been auto-reset
                            // (hold complete), so write the result's terminal
                            // observation instead of the next episode's fresh
                            // spawn (#222).
                            sharedMem!.writeObservation(i, res.done ? observationToArray(res.observation) : observationFastToArray(envs[i]));
                            sharedMem!.writeReward(i, res.reward);
                            sharedMem!.writeDone(i, res.done ? 1 : 0);
                            sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                            sharedMem!.writeTerminated(i, res.info.terminated ? 1 : 0);
                            sharedMem!.writeTick(i, res.info.tick || stepCounter);
                            // Dynamic info fields travel as SAB floats; the
                            // static fields were shipped once at init. This
                            // keeps the shared-memory step zero-message (no
                            // per-step postMessage).
                            _infoBuffer[0] = res.info.aiAlive ? 1 : 0;
                            _infoBuffer[1] = res.info.opponentsAlive;
                            _infoBuffer[2] = res.info.scoreBlue;
                            _infoBuffer[3] = res.info.scoreRed;
                            sharedMem!.writeInfo(i, _infoBuffer);
                        });

                        sharedMem.signalWorkerConsumed();
                        sharedMem.signalMainReady();
                        signalSyncCompleted();

                        if (verbose) {
                            parentPort!.postMessage({
                                id: msg.id,
                                status: 'ok',
                                mode: 'shared',
                                telemetry: { tick: stepCounter }
                            });
                        }
                    }
                }
                } catch (e: any) {
                    console.error(`[Worker ${globalOffset}] wait-for-action crashed:`, e.message, e.stack);
                    signalSyncCompleted(WORKER_ERROR);
                    parentPort!.postMessage({ id: msg.id, status: 'error', error: `worker-loop-crash: ${e.message}` });
                }
            } else {
                parentPort!.postMessage({ id: msg.id, status: 'error', error: 'Shared memory not initialized' });
            }
        } else if (msg.type === 'GET_TELEMETRY') {
            // Return a thread-safe snapshot of this worker's telemetry buffer.
            const snapshot = TelemetryBuffer.slice();
            parentPort!.postMessage({
                id: msg.id,
                status: 'ok',
                data: snapshot,
            });
        }
    } catch (err: any) {
        parentPort!.postMessage({ id: msg.id, status: 'error', error: err.message });
    }
});
