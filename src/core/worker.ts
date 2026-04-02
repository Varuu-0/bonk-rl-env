import { parentPort } from 'worker_threads';
import { BonkEnvironment, Action, Observation } from './environment';
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

function signalSyncCompleted() {
    if (syncCompleted) {
        Atomics.add(syncCompleted, 0, 1);
        Atomics.notify(syncCompleted, 0, 1);
    }
}

/**
 * Converts an Observation to a flat number array for shared memory storage
 * Uses 14 values: playerX, playerY, playerVelX, playerVelY, playerAngle, 
 * playerAngularVel, playerIsHeavy, opponentX, opponentY, opponentVelX, 
 * opponentVelY, opponentIsHeavy, opponentAlive, tick
 */
// Pre-allocated buffer for zero-allocation observation conversion
const _obsBuffer = new Float32Array(14);

function observationToArray(obs: Observation): Float32Array {
    const opp = obs.opponents[0];
    _obsBuffer[0] = obs.playerX;
    _obsBuffer[1] = obs.playerY;
    _obsBuffer[2] = obs.playerVelX;
    _obsBuffer[3] = obs.playerVelY;
    _obsBuffer[4] = obs.playerAngle;
    _obsBuffer[5] = obs.playerAngularVel;
    _obsBuffer[6] = obs.playerIsHeavy ? 1 : 0;
    if (opp) {
        _obsBuffer[7] = opp.x;
        _obsBuffer[8] = opp.y;
        _obsBuffer[9] = opp.velX;
        _obsBuffer[10] = opp.velY;
        _obsBuffer[11] = opp.isHeavy ? 1 : 0;
        _obsBuffer[12] = opp.alive ? 1 : 0;
    } else {
        _obsBuffer[7] = 0;
        _obsBuffer[8] = 0;
        _obsBuffer[9] = 0;
        _obsBuffer[10] = 0;
        _obsBuffer[11] = 0;
        _obsBuffer[12] = 0;
    }
    _obsBuffer[13] = obs.tick;
    return _obsBuffer;
}

function observationFastToArray(env: BonkEnvironment): Float32Array {
    return env.getObservationFast();
}

parentPort.on('message', (msg) => {
    try {
        if (msg.type === 'init') {
            const numEnvsParam = msg.numEnvs;
            const config = msg.config || {};
            envs = [];
            for (let i = 0; i < numEnvsParam; i++) {
                envs.push(new BonkEnvironment(config));
            }
            numEnvs = numEnvsParam;
            globalOffset = msg.startId || 0;

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
                    msg.sharedBuffer as SharedArrayBuffer
                );
                if (msg.syncBuffer) {
                    syncCompleted = new Int32Array(msg.syncBuffer);
                }
                parentPort!.postMessage({
                    id: msg.id,
                    status: 'ok',
                    data: { mode: 'shared' }  // Include mode in data for compatibility
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
            parentPort!.postMessage({
                id: msg.id,
                status: 'ok',
                data: obs
            });
        } else if (msg.type === 'step') {
            // Handle step with message passing (fallback mode)
            const actions: Action[] = msg.actions;

            const results = envs.map((env, i) => {
                const res = env.step(actions[i]);
                if (res.done) {
                    res.info.terminal_observation = res.observation;
                    res.observation = env.reset();
                }
                return res;
            });

            stepCounter++;
            if (stepCounter % 1000 === 0) {
                globalProfiler.recordMemory();
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
            const results = envs.map((env, i) => {
                const res = env.step(actions[i]);
                if (res.done) {
                    res.info.terminal_observation = res.observation;
                    res.observation = env.reset();
                }
                return res;
            });

            stepCounter++;
            if (stepCounter % 100 === 0) {
                globalProfiler.recordMemory();
            }

            // Write results directly to shared memory
            if (sharedMem) {
                results.forEach((res, i) => {
                    sharedMem!.writeObservation(i, observationFastToArray(envs[i]));
                    sharedMem!.writeReward(i, res.reward);
                    sharedMem!.writeDone(i, res.done ? 1 : 0);
                    sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                    sharedMem!.writeTick(i, res.info.tick || stepCounter);
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
                        const obs = envs.map((env, i) => env.reset(seedsView[i] || undefined));

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

                        const results = envs.map((env, i) => {
                            const res = env.step(actions[i]);
                            if (res.done) {
                                res.info.terminal_observation = res.observation;
                                res.observation = env.reset();
                            }
                            return res;
                        });

                        stepCounter++;
                        if (verbose && stepCounter % 1000 === 0) {
                            globalProfiler.recordMemory();
                        }

                        results.forEach((res, i) => {
                            sharedMem!.writeObservation(i, observationFastToArray(envs[i]));
                            sharedMem!.writeReward(i, res.reward);
                            sharedMem!.writeDone(i, res.done ? 1 : 0);
                            sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                            sharedMem!.writeTick(i, res.info.tick || stepCounter);
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
