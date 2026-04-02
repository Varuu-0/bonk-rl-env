/**
 * Layer 3: Single-Thread Environment Throughput
 *
 * Measures BonkEnvironment.step() which includes physics tick,
 * observation extraction, reward calculation, action decoding,
 * and frame skip logic. No worker threads or IPC overhead.
 *
 * Layer: 3 — Environment
 * Run:   npx tsx benchmarks/layer3-environment.ts
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

const STEPS = 2_000;
const WARMUP = 50;

function benchEnvironmentStep(): BenchmarkResult {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });
    env.reset();

    for (let i = 0; i < WARMUP; i++) {
        env.step(Math.floor(Math.random() * 64));
    }

    const start = performance.now();
    for (let i = 0; i < STEPS; i++) {
        env.step(Math.floor(Math.random() * 64));
    }
    const elapsed = performance.now() - start;
    const sps = STEPS / (elapsed / 1000);
    const usPerStep = (elapsed / STEPS) * 1000;

    return {
        layer: 3,
        name: 'BonkEnvironment.step() (1 AI + 1 opponent)',
        passed: sps > 15_000,
        status: sps > 15_000 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
            { label: 'Avg step time', value: +usPerStep.toFixed(1), unit: 'us' },
            { label: 'Steps', value: STEPS, unit: '' },
        ],
    };
}

function benchEnvironmentWithFrameSkip(): BenchmarkResult {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
    env.reset();

    for (let i = 0; i < WARMUP; i++) {
        env.step(Math.floor(Math.random() * 64));
    }

    const start = performance.now();
    for (let i = 0; i < STEPS; i++) {
        env.step(Math.floor(Math.random() * 64));
    }
    const elapsed = performance.now() - start;
    const sps = STEPS / (elapsed / 1000);
    const usPerStep = (elapsed / STEPS) * 1000;

    return {
        layer: 3,
        name: 'BonkEnvironment.step() (frameSkip=3)',
        passed: sps > 20_000,
        status: sps > 20_000 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
            { label: 'Avg step time', value: +usPerStep.toFixed(1), unit: 'us' },
            { label: 'Steps', value: STEPS, unit: '' },
        ],
    };
}

function main(): void {
    const suiteStart = performance.now();
    const suite = createSuite(3, 'Environment', 'BonkEnvironment step throughput (no IPC)');

    recordResult(suite, benchEnvironmentStep());
    recordResult(suite, benchEnvironmentWithFrameSkip());

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer3.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main();
