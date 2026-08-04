/**
 * Layer 4: Worker Pool Shared Memory Throughput
 *
 * Measures WorkerPool.step() with SharedArrayBuffer IPC across exact
 * worker counts. Each worker owns one environment so aggregate throughput
 * exposes scaling without changing the amount of work assigned per worker.
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

const STEPS_PER_SAMPLE = 2_000;
const WARMUP_STEPS = 250;
const WORKER_COUNTS = [1, 2, 4, 8];
const SAMPLE_ORDERS = [
    [1, 2, 4, 8],
    [2, 4, 8, 1],
    [4, 8, 1, 2],
    [8, 1, 2, 4],
    [8, 4, 2, 1],
    [4, 2, 1, 8],
    [2, 1, 8, 4],
    [1, 8, 4, 2],
];
const BENCH_CONFIG = {
    verboseTelemetry: false,
    numOpponents: 1,
    frameSkip: 1,
};

function quantile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function measureSample(numWorkers: number): Promise<number> {
    const pool = new WorkerPool(numWorkers);
    try {
        await pool.init(numWorkers, BENCH_CONFIG, true);
        if (!pool.isUsingSharedMemory()) {
            throw new Error('SharedArrayBuffer mode unavailable');
        }
        await pool.reset(Array.from({ length: numWorkers }, (_, index) => index + 1));
        const actions = new Array(numWorkers).fill(0);

        for (let i = 0; i < WARMUP_STEPS; i++) {
            await pool.step(actions);
        }

        const start = performance.now();
        for (let i = 0; i < STEPS_PER_SAMPLE; i++) {
            await pool.step(actions);
        }
        return (performance.now() - start) / STEPS_PER_SAMPLE;
    } finally {
        await pool.close();
    }
}

function createResult(numWorkers: number, latenciesMs: number[], baselineEnvSps: number): BenchmarkResult {
    const medianLatencyMs = quantile(latenciesMs, 0.5);
    const batchSps = 1_000 / medianLatencyMs;
    const envSps = batchSps * numWorkers;
    const passed = numWorkers === 1
        ? batchSps > 2_000
        : baselineEnvSps > 0 && envSps >= baselineEnvSps * 0.9;

    return {
        layer: 4,
        name: `WorkerPool.step() N=${numWorkers}`,
        passed,
        status: passed ? 'PASS' : 'FAIL',
        durationMs: latenciesMs.reduce((sum, latency) => sum + latency * STEPS_PER_SAMPLE, 0),
        metrics: [
            { label: 'Batch SPS', value: Math.round(batchSps), unit: 'batches/sec' },
            { label: 'Env-SPS (aggregate)', value: Math.round(envSps), unit: 'env-steps/sec' },
            { label: 'Median latency', value: +medianLatencyMs.toFixed(3), unit: 'ms' },
            { label: 'P25 latency', value: +quantile(latenciesMs, 0.25).toFixed(3), unit: 'ms' },
            { label: 'P75 latency', value: +quantile(latenciesMs, 0.75).toFixed(3), unit: 'ms' },
            { label: 'Workers', value: numWorkers, unit: '' },
            { label: 'Envs per worker', value: 1, unit: '' },
            { label: 'Samples', value: latenciesMs.length, unit: '' },
            { label: 'Steps per sample', value: STEPS_PER_SAMPLE, unit: '' },
        ],
    };
}

async function main(): Promise<void> {
    const suiteStart = performance.now();
    const suite = createSuite(4, 'Worker Pool', 'SharedArrayBuffer IPC scaling across exact worker counts');
    const samples = new Map<number, number[]>(WORKER_COUNTS.map(count => [count, []]));
    const errors = new Map<number, string>();

    for (const order of SAMPLE_ORDERS) {
        for (const numWorkers of order) {
            if (errors.has(numWorkers)) continue;
            try {
                samples.get(numWorkers)!.push(await measureSample(numWorkers));
            } catch (e: any) {
                errors.set(numWorkers, e instanceof Error ? e.message : String(e));
            }
        }
    }

    const baselineLatencies = samples.get(1)!;
    const baselineEnvSps = baselineLatencies.length === SAMPLE_ORDERS.length
        ? 1_000 / quantile(baselineLatencies, 0.5)
        : 0;

    for (const numWorkers of WORKER_COUNTS) {
        const error = errors.get(numWorkers);
        if (errors.has(numWorkers) || (numWorkers !== 1 && baselineEnvSps === 0)) {
            recordResult(suite, {
                layer: 4,
                name: `WorkerPool.step() N=${numWorkers}`,
                passed: false,
                status: 'ERROR',
                durationMs: 0,
                metrics: [],
                error: error || 'N=1 baseline unavailable',
            });
        } else {
            recordResult(suite, createResult(numWorkers, samples.get(numWorkers)!, baselineEnvSps));
        }
    }

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer4.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
