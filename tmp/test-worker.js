const { Worker } = require('worker_threads');
const path = require('path');

const workerPath = 'c:/Users/varun/Desktop/Projects/manifold-server/src/core/worker-loader.js';
console.log('Starting worker from:', workerPath);

const worker = new Worker(workerPath);

worker.on('message', (msg) => {
    console.log('Worker message:', msg);
    // Init response doesn't have type 'init', it just has status 'ok' and mode data
    if (msg.status === 'ok' && msg.data && msg.data.mode) {
        console.log('Init OK, sending step...');
        worker.postMessage({
            type: 'step',
            id: 1,
            actions: [0] // One env, action 0
        });
    } else if (msg.status === 'ok' && Array.isArray(msg.data)) {
        console.log('Step OK! Result:', JSON.stringify(msg.data[0]).substring(0, 100) + '...');
        process.exit(0);
    }
});

worker.on('error', (err) => {
    console.error('Worker error:', err);
    process.exit(1);
});

worker.on('exit', (code) => {
    if (code !== 0) {
        process.exit(code);
    }
});

console.log('Sending init...');
worker.postMessage({
    type: 'init',
    numEnvs: 1
});

setTimeout(() => {
    console.log('Timeout! Worker did not respond in 10s');
    worker.terminate();
    process.exit(1);
}, 10000);
