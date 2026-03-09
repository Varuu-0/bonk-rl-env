import { parentPort } from 'worker_threads';
import { BonkEnvironment, Action, Observation } from './environment';
import { SharedMemoryManager } from './shared-memory';

// Type for SharedArrayBuffer (available in Node.js >= 9.1.0)
declare const SharedArrayBuffer: any;

if (!parentPort) {
    throw new Error('This file must be run as a worker thread.');
}

import { globalProfiler, TelemetryBuffer } from './profiler';

let envs: BonkEnvironment[] = [];
let stepCounter = 0;
let sharedMem: SharedMemoryManager | null = null;
let numEnvs = 0;

/**
 * Converts an Observation to a flat number array for shared memory storage
 * Uses 14 values: playerX, playerY, playerVelX, playerVelY, playerAngle, 
 * playerAngularVel, playerIsHeavy, opponentX, opponentY, opponentVelX, 
 * opponentVelY, opponentIsHeavy, opponentAlive, tick
 */
function observationToArray(obs: Observation): number[] {
    const opp = obs.opponents[0] || { x: 0, y: 0, velX: 0, velY: 0, isHeavy: false, alive: false };
    return [
        obs.playerX,
        obs.playerY,
        obs.playerVelX,
        obs.playerVelY,
        obs.playerAngle,
        obs.playerAngularVel,
        obs.playerIsHeavy ? 1 : 0,
        opp.x,
        opp.y,
        opp.velX,
        opp.velY,
        opp.isHeavy ? 1 : 0,
        opp.alive ? 1 : 0,
        obs.tick
    ];
}

parentPort.on('message', (msg) => {
    try {
        console.log(`[Worker] Received message: ${JSON.stringify(msg).substring(0, 100)}`);
        if (msg.type === 'init') {
            const numEnvsParam = msg.numEnvs;
            const config = msg.config || {};
            envs = [];
            for (let i = 0; i < numEnvsParam; i++) {
                envs.push(new BonkEnvironment(config));
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
                    msg.sharedBuffer as SharedArrayBuffer
                );
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
            if (stepCounter % 100 === 0) {
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

            // Read actions from shared memory as Uint8Array
            const actionBytes = sharedMem.readActions(sharedMem.readActionSlot());
            const actions: Action[] = Array.from(actionBytes);

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
                    sharedMem!.writeObservation(i, observationToArray(res.observation));
                    sharedMem!.writeReward(i, res.reward);
                    sharedMem!.writeDone(i, res.done ? 1 : 0);
                    sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                    sharedMem!.writeTick(i, res.info.tick || stepCounter);
                });

                // Signal main thread that results are ready
                sharedMem.signalMainReady();

                // Signal that worker has consumed the actions
                sharedMem.signalWorkerConsumed();

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
                while (true) {
                    // Wait for main to signal new actions are available
                    const waitResult = sharedMem.waitForActions();

                    if (waitResult === 'timed-out') {
                        if (verbose) {
                            parentPort!.postMessage({
                                id: msg.id,
                                status: 'timeout',
                                mode: 'shared'
                            });
                        }
                        break;
                    }

                    // Read actions and process
                    const actionBytes = sharedMem.readActions(sharedMem.readActionSlot());
                    const actions: Action[] = Array.from(actionBytes);

                    const results = envs.map((env, i) => {
                        const res = env.step(actions[i]);
                        if (res.done) {
                            res.info.terminal_observation = res.observation;
                            res.observation = env.reset();
                        }
                        return res;
                    });

                    stepCounter++;
                    if (verbose && stepCounter % 100 === 0) {
                        globalProfiler.recordMemory();
                    }

                    // Write results to shared memory
                    results.forEach((res, i) => {
                        sharedMem!.writeObservation(i, observationToArray(res.observation));
                        sharedMem!.writeReward(i, res.reward);
                        sharedMem!.writeDone(i, res.done ? 1 : 0);
                        sharedMem!.writeTruncated(i, res.truncated ? 1 : 0);
                        sharedMem!.writeTick(i, res.info.tick || stepCounter);
                    });

                    // Signal main thread results are ready
                    sharedMem.signalMainReady();

                    // Signal worker consumed actions
                    sharedMem.signalWorkerConsumed();

                    // Only send postMessage if verbose telemetry is enabled
                    if (verbose) {
                        parentPort!.postMessage({
                            id: msg.id,
                            status: 'ok',
                            mode: 'shared',
                            telemetry: {
                                tick: stepCounter
                            }
                        });
                    }
                }
            } else {
                parentPort!.postMessage({
                    id: msg.id,
                    status: 'error',
                    error: 'Shared memory not initialized'
                });
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
