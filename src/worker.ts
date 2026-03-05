import { parentPort } from 'worker_threads';
import { BonkEnvironment, Action } from './environment';

if (!parentPort) {
    throw new Error('This file must be run as a worker thread.');
}

import { globalProfiler } from './profiler';

let envs: BonkEnvironment[] = [];
let stepCounter = 0;

parentPort.on('message', (msg) => {
    try {
        if (msg.type === 'init') {
            const numEnvs = msg.numEnvs;
            const config = msg.config || {};
            envs = [];
            for (let i = 0; i < numEnvs; i++) {
                envs.push(new BonkEnvironment(config));
            }
            parentPort!.postMessage({ id: msg.id, status: 'ok' });
        } else if (msg.type === 'reset') {
            const seeds: number[] | undefined = msg.seeds;
            const obs = envs.map((env, i) => env.reset(seeds ? seeds[i] : undefined));
            parentPort!.postMessage({ id: msg.id, status: 'ok', data: obs });
        } else if (msg.type === 'step') {
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
                    heapUsed: process.memoryUsage().heapUsed,
                    tick: stepCounter
                }
            });
        }
    } catch (err: any) {
        parentPort!.postMessage({ id: msg.id, status: 'error', error: err.message });
    }
});
