/**
 * Layer 5: Memory Stability
 *
 * Monitors heap usage over a long-running step loop to detect
 * memory leaks and GC pressure. Runs BonkEnvironment for 50K
 * steps and reports heap growth, peak RSS, and GC effectiveness.
 *
 * Layer: 5 — Memory
 * Run:   npx tsx benchmarks/layer5-memory.ts
 */

import { BonkEnvironment } from '../src/core/environment';
import {
    BenchmarkResult,
    BenchmarkSuite,
    createSuite,
    recordResult,
    finalizeSuite,
    emitSuite,
    formatSuiteSummary,
} from '../src/utils/bench-report';

const STEPS = 50_000;
const WARMUP = 500;
const REPORT_INTERVAL = 10_000;

function getHeapMB(): number {
    return process.memoryUsage().heapUsed / 1024 / 1024;
}

function getRSSMB(): number {
    return process.memoryUsage().rss / 1024 / 1024;
}

function benchMemoryStability(): BenchmarkResult {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });
    env.reset();

    for (let i = 0; i < WARMUP; i++) {
        env.step(0);
    }

    // Force GC if available to get clean baseline
    if (global.gc) global.gc();
    const baselineHeap = getHeapMB();
    const baselineRSS = getRSSMB();

    const heapSnapshots: number[] = [baselineHeap];
    const rssSnapshots: number[] = [baselineRSS];

    const start = performance.now();
    for (let i = 0; i < STEPS; i++) {
        env.step(0);
        if ((i + 1) % REPORT_INTERVAL === 0) {
            heapSnapshots.push(getHeapMB());
            rssSnapshots.push(getRSSMB());
        }
    }
    const elapsed = performance.now() - start;

    if (global.gc) global.gc();
    const finalHeap = getHeapMB();
    const finalRSS = getRSSMB();

    const heapGrowth = finalHeap - baselineHeap;
    const peakHeap = Math.max(...heapSnapshots);
    const peakRSS = Math.max(...rssSnapshots);
    const sps = STEPS / (elapsed / 1000);

    const heapStable = heapGrowth < 5; // less than 5MB growth

    return {
        layer: 5,
        name: `Memory stability (${(STEPS / 1000).toFixed(0)}K steps)`,
        passed: heapStable,
        status: heapStable ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Baseline heap', value: +baselineHeap.toFixed(1), unit: 'MB' },
            { label: 'Final heap', value: +finalHeap.toFixed(1), unit: 'MB' },
            { label: 'Heap growth', value: +heapGrowth.toFixed(2), unit: 'MB' },
            { label: 'Peak heap', value: +peakHeap.toFixed(1), unit: 'MB' },
            { label: 'Peak RSS', value: +peakRSS.toFixed(1), unit: 'MB' },
            { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
            { label: 'Steps', value: STEPS, unit: '' },
        ],
    };
}

function benchResetCycles(): BenchmarkResult {
    const RESETS = 200;
    const STEPS_PER_RESET = 100;

    if (global.gc) global.gc();
    const baselineHeap = getHeapMB();

    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });

    const start = performance.now();
    for (let r = 0; r < RESETS; r++) {
        env.reset();
        for (let i = 0; i < STEPS_PER_RESET; i++) {
            env.step(0);
        }
    }
    const elapsed = performance.now() - start;

    if (global.gc) global.gc();
    const finalHeap = getHeapMB();
    const heapGrowth = finalHeap - baselineHeap;
    const totalSteps = RESETS * STEPS_PER_RESET;
    const sps = totalSteps / (elapsed / 1000);

    const heapStable = heapGrowth < 10;

    return {
        layer: 5,
        name: `Reset cycles (${RESETS} resets × ${STEPS_PER_RESET} steps)`,
        passed: heapStable,
        status: heapStable ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'Baseline heap', value: +baselineHeap.toFixed(1), unit: 'MB' },
            { label: 'Final heap', value: +finalHeap.toFixed(1), unit: 'MB' },
            { label: 'Heap growth', value: +heapGrowth.toFixed(2), unit: 'MB' },
            { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
            { label: 'Total steps', value: totalSteps, unit: '' },
            { label: 'Resets', value: RESETS, unit: '' },
        ],
    };
}

function main(): void {
    const suiteStart = performance.now();
    const suite = createSuite(5, 'Memory', 'Heap stability and reset cycle memory leaks');

    recordResult(suite, benchMemoryStability());
    recordResult(suite, benchResetCycles());

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer5.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main();
