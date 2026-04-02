/**
 * Layer 1: Primitive Operation Latencies
 *
 * Measures the raw cost of individual Atomics operations, TypedArray
 * copies, and object allocation patterns that underpin the entire
 * shared-memory IPC stack. These are not throughput benchmarks — they
 * are latency probes for building accurate cost models.
 *
 * Layer: 1 — Primitives
 * Run:   npx tsx benchmarks/layer1-primitives.ts
 */

import {
    BenchmarkResult,
    BenchmarkSuite,
    createSuite,
    recordResult,
    finalizeSuite,
    emitSuite,
    formatSuiteSummary,
} from '../src/utils/bench-report';

const ITERATIONS = 100_000;

function benchAtomicsWaitNoBlock(): BenchmarkResult {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 1;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.wait(arr, 0, 0);
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / ITERATIONS) * 1000;

    return {
        layer: 1,
        name: 'Atomics.wait (non-blocking)',
        passed: us < 10,
        status: us < 10 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: ITERATIONS, unit: 'ops' },
        ],
    };
}

function benchAtomicsStore(): BenchmarkResult {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.store(arr, 0, i);
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / ITERATIONS) * 1000;

    return {
        layer: 1,
        name: 'Atomics.store',
        passed: us < 1,
        status: us < 1 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: ITERATIONS, unit: 'ops' },
        ],
    };
}

function benchAtomicsLoad(): BenchmarkResult {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 42;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.load(arr, 0);
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / ITERATIONS) * 1000;

    return {
        layer: 1,
        name: 'Atomics.load',
        passed: us < 1,
        status: us < 1 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: ITERATIONS, unit: 'ops' },
        ],
    };
}

function benchAtomicsNotify(): BenchmarkResult {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 1;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.notify(arr, 0, 1);
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / ITERATIONS) * 1000;

    return {
        layer: 1,
        name: 'Atomics.notify',
        passed: us < 10,
        status: us < 10 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: ITERATIONS, unit: 'ops' },
        ],
    };
}

function benchTypedArraySet(): BenchmarkResult {
    const sizes = [1, 16, 64, 512, 4096];
    const src = new Uint8Array(4096);
    const dst = new Uint8Array(4096);
    const results: { size: number; us: number }[] = [];

    for (const size of sizes) {
        const s = src.subarray(0, size);
        const d = dst.subarray(0, size);
        const iters = 100_000;
        const start = performance.now();
        for (let i = 0; i < iters; i++) {
            d.set(s);
        }
        const elapsed = performance.now() - start;
        results.push({ size, us: (elapsed / iters) * 1000 });
    }

    const avgUs = results.reduce((s, r) => s + r.us, 0) / results.length;

    return {
        layer: 1,
        name: 'TypedArray.set (memcpy)',
        passed: avgUs < 5,
        status: avgUs < 5 ? 'PASS' : 'FAIL',
        durationMs: results.reduce((s, r) => s + r.us * 100_000 / 1000, 0),
        metrics: results.map(r => ({
            label: `set(${r.size})`,
            value: +r.us.toFixed(3),
            unit: 'us',
        })),
    };
}

function benchObjectAlloc(): BenchmarkResult {
    const iters = 100_000;
    const results: any[] = [];

    const start = performance.now();
    for (let i = 0; i < iters; i++) {
        results.push({
            playerX: 1, playerY: 2, playerVelX: 3, playerVelY: 4,
            playerAngle: 5, playerAngularVel: 6, playerIsHeavy: false,
            opponents: [{ x: 7, y: 8, velX: 9, velY: 10, isHeavy: false, alive: true }],
            tick: 11,
        });
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / iters) * 1000;
    results.length = 0;

    return {
        layer: 1,
        name: 'Object alloc (observation-like)',
        passed: us < 1,
        status: us < 1 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: iters, unit: 'ops' },
        ],
    };
}

function benchObjectMutate(): BenchmarkResult {
    const iters = 100_000;
    const template: any = {
        playerX: 0, playerY: 0, playerVelX: 0, playerVelY: 0,
        playerAngle: 0, playerAngularVel: 0, playerIsHeavy: false,
        opponents: [{ x: 0, y: 0, velX: 0, velY: 0, isHeavy: false, alive: false }],
        tick: 0,
    };

    const start = performance.now();
    for (let i = 0; i < iters; i++) {
        template.playerX = i;
        template.playerY = i * 2;
        template.playerVelX = i * 3;
        template.playerVelY = i * 4;
        template.playerAngle = i * 5;
        template.playerAngularVel = i * 6;
        template.opponents[0].x = i * 7;
        template.opponents[0].y = i * 8;
        template.tick = i;
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / iters) * 1000;

    return {
        layer: 1,
        name: 'Object mutate (pre-allocated)',
        passed: us < 0.5,
        status: us < 0.5 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: iters, unit: 'ops' },
        ],
    };
}

function benchSendCommandCycle(): BenchmarkResult {
    const sab = new SharedArrayBuffer(8);
    const cmd = new Int32Array(sab, 0, 1);
    const workerReady = new Int32Array(sab, 4, 1);
    const iters = 100_000;

    const start = performance.now();
    for (let i = 0; i < iters; i++) {
        Atomics.store(cmd, 0, 1);
        Atomics.store(cmd, 0, 0);
        Atomics.notify(workerReady, 0, 1);
    }
    const elapsed = performance.now() - start;
    const us = (elapsed / iters) * 1000;

    return {
        layer: 1,
        name: 'sendCommand cycle (store+store+notify)',
        passed: us < 1,
        status: us < 1 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Latency', value: +us.toFixed(3), unit: 'us' },
            { label: 'Iterations', value: iters, unit: 'ops' },
        ],
    };
}

function benchAtomicsWaitBlocking(): BenchmarkResult {
    const { Worker } = require('worker_threads');
    const iters = 500;

    const pingSab = new SharedArrayBuffer(4);
    const pongSab = new SharedArrayBuffer(4);
    const ping = new Int32Array(pingSab);
    const pong = new Int32Array(pongSab);

    const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', (data) => {
            const ping = new Int32Array(data.pingSab);
            const pong = new Int32Array(data.pongSab);
            for (let i = 0; i < ${iters}; i++) {
                Atomics.wait(ping, 0, 0);
                Atomics.store(pong, 0, 1);
                Atomics.notify(pong, 0, 1);
                Atomics.store(ping, 0, 0);
            }
            process.exit(0);
        });
    `;

    try {
        const w = new Worker(workerCode, { eval: true });
        w.postMessage({ pingSab, pongSab });

        const warmup = performance.now();
        while (performance.now() - warmup < 100) {}

        let totalWait = 0;
        const allStart = performance.now();
        for (let i = 0; i < iters; i++) {
            Atomics.store(ping, 0, 1);
            Atomics.notify(ping, 0, 1);
            const ws = performance.now();
            Atomics.wait(pong, 0, 0, 5000);
            totalWait += performance.now() - ws;
            Atomics.store(pong, 0, 0);
        }
        const allElapsed = performance.now() - allStart;
        const us = (totalWait / iters) * 1000;

        w.terminate();

        return {
            layer: 1,
            name: 'Atomics.wait blocking (ping-pong)',
            passed: us < 200_000,
            status: us < 200_000 ? 'PASS' : 'FAIL',
            durationMs: allElapsed,
            metrics: [
                { label: 'Avg round-trip', value: +us.toFixed(1), unit: 'us' },
                { label: 'Iterations', value: iters, unit: 'ops' },
            ],
        };
    } catch (e: any) {
        return {
            layer: 1,
            name: 'Atomics.wait blocking (ping-pong)',
            passed: false,
            status: 'SKIP',
            durationMs: 0,
            metrics: [],
            error: e.message,
        };
    }
}

// ─── Main ─────────────────────────────────────────────────────────────

function main(): void {
    const suiteStart = performance.now();
    const suite = createSuite(1, 'Primitives', 'Atomics, TypedArray, and object allocation latencies');

    recordResult(suite, benchAtomicsWaitNoBlock());
    recordResult(suite, benchAtomicsStore());
    recordResult(suite, benchAtomicsLoad());
    recordResult(suite, benchAtomicsNotify());
    recordResult(suite, benchTypedArraySet());
    recordResult(suite, benchObjectAlloc());
    recordResult(suite, benchObjectMutate());
    recordResult(suite, benchSendCommandCycle());
    recordResult(suite, benchAtomicsWaitBlocking());

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer1.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main();
