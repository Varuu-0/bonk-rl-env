import { parentPort } from 'worker_threads';
import { BonkEnvironment, Action } from './environment';

if (!parentPort) {
    throw new Error('This file must be run as a worker thread.');
}

let envs: BonkEnvironment[] = [];

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
            parentPort!.postMessage({ id: msg.id, status: 'ok', data: results });
        }
    } catch (err: any) {
        parentPort!.postMessage({ id: msg.id, status: 'error', error: err.message });
    }
});
