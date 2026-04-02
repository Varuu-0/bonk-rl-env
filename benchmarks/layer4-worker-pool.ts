/**
 * Layer 4: Worker Pool Shared Memory Throughput
 *
 * Measures WorkerPool.step() with SharedArrayBuffer IPC across
 * varying environment counts. This is the TypeScript-side
 * multi-env path — main thread dispatches actions to N workers
 * via shared memory and collects results via Atomics.
 *
 * Layer: 4 — Worker Pool
 * Run:   npx tsx benchmarks/layer4-worker-pool.ts
 */

import { WorkerPool } from '../src/core/worker-pool';
import {
    BenchmarkResult,
    BenchmarkSuite,
    createSuite,
    recordResult,
    finalizeSuite,
    emitSuite,
    formatSuiteSummary,
} from '../src/utils/bench-report';

const STEPS = 2_000;
const WARMUP = 100;
const ENV_COUNTS = [1, 2, 4, 8, 16];

async function benchWorkerPool(numEnvs: number): Promise<BenchmarkResult> {
    const pool = new WorkerPool();
    await pool.init(numEnvs, {}, true);
    await pool.reset();

    const actions: number[] = [];
    for (let i = 0; i < numEnvs; i++) {
        actions.push(Math.floor(Math.random() * 64));
    }

    for (let i = 0; i < WARMUP; i++) {
        await pool.step(actions);
    }

    const start = performance.now();
    for (let i = 0; i < STEPS; i++) {
        await pool.step(actions);
    }
    const elapsed = performance.now() - start;
    const sps = STEPS / (elapsed / 1000);
    const envSps = sps * numEnvs;
    const msPerStep = elapsed / STEPS;

    pool.close();
    await new Promise(r => setTimeout(r, 200));

    return {
        layer: 4,
        name: `WorkerPool.step() N=${numEnvs}`,
        passed: sps > 2_000,
        status: sps > 2_000 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'SPS (per-env)', value: Math.round(sps), unit: 'steps/sec' },
            { label: 'Env-SPS (aggregate)', value: Math.round(envSps), unit: 'env-steps/sec' },
            { label: 'Latency', value: +msPerStep.toFixed(3), unit: 'ms' },
            { label: 'Envs', value: numEnvs, unit: '' },
            { label: 'Steps', value: STEPS, unit: '' },
        ],
    };
}

async function main(): Promise<void> {
    const suiteStart = performance.now();
    const suite = createSuite(4, 'Worker Pool', 'SharedArrayBuffer IPC throughput across env counts');

    for (const n of ENV_COUNTS) {
        try {
            const result = await benchWorkerPool(n);
            recordResult(suite, result);
        } catch (e: any) {
            recordResult(suite, {
                layer: 4,
                name: `WorkerPool.step() N=${n}`,
                passed: false,
                status: 'ERROR',
                durationMs: 0,
                metrics: [],
                error: e.message,
            });
        }
    }

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer4.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
