/**
 * Layer 6: Long-Running Stability
 *
 * Stress-tests sustained performance over 100K steps to eliminate
 * JIT warmup noise and capture GC pressure effects, memory stability,
 * and throughput variance. Reports coefficient of variation (CV) to
 * quantify performance stability.
 *
 * Layer: 6 — Stability
 * Run:   npx tsx benchmarks/layer6-stability.ts
 */

import { BonkEnvironment } from '../src/core/environment';
import { WorkerPool } from '../src/core/worker-pool';
import {
    BenchmarkResult,
    BenchmarkSuite,
    BenchmarkMetric,
    createSuite,
    recordResult,
    finalizeSuite,
    emitSuite,
    formatSuiteSummary,
} from '../src/utils/bench-report';

const STEPS = 100_000;
const WARMUP = 2_000;
const REPORT_INTERVAL = 10_000;

interface SegmentResult {
    steps: number;
    elapsedMs: number;
    sps: number;
}

function benchNativeStability(): BenchmarkResult {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });
    env.reset();

    for (let i = 0; i < WARMUP; i++) env.step(0);

    const segments: SegmentResult[] = [];
    let totalStart = performance.now();
    let segmentStart = totalStart;

    for (let i = 0; i < STEPS; i++) {
        env.step(0);
        if ((i + 1) % REPORT_INTERVAL === 0) {
            const now = performance.now();
            const segElapsed = now - segmentStart;
            const segSps = REPORT_INTERVAL / (segElapsed / 1000);
            segments.push({ steps: REPORT_INTERVAL, elapsedMs: segElapsed, sps: segSps });
            segmentStart = now;
        }
    }

    const totalElapsed = performance.now() - totalStart;
    const overallSps = STEPS / (totalElapsed / 1000);
    const segSpsValues = segments.map(s => s.sps);
    const avgSegSps = segSpsValues.reduce((a, b) => a + b, 0) / segSpsValues.length;
    const minSegSps = Math.min(...segSpsValues);
    const maxSegSps = Math.max(...segSpsValues);
    const stdDev = Math.sqrt(segSpsValues.reduce((sum, v) => sum + (v - avgSegSps) ** 2, 0) / segSpsValues.length);
    const cv = (stdDev / avgSegSps) * 100;

    if (global.gc) global.gc();

    const metrics: BenchmarkMetric[] = [
        { label: 'Overall SPS', value: Math.round(overallSps), unit: 'steps/sec' },
        { label: 'Avg segment SPS', value: Math.round(avgSegSps), unit: 'steps/sec' },
        { label: 'Min segment SPS', value: Math.round(minSegSps), unit: 'steps/sec' },
        { label: 'Max segment SPS', value: Math.round(maxSegSps), unit: 'steps/sec' },
        { label: 'Std deviation', value: Math.round(stdDev), unit: 'steps/sec' },
        { label: 'CV', value: +cv.toFixed(1), unit: '%' },
        { label: 'Avg step time', value: +((1 / overallSps) * 1_000_000).toFixed(1), unit: 'us' },
        { label: 'Steps', value: STEPS, unit: '' },
    ];

    return {
        layer: 6,
        name: `Native env stability (${(STEPS / 1000).toFixed(0)}K steps)`,
        passed: cv < 10,
        status: cv < 10 ? 'PASS' : 'FAIL',
        durationMs: totalElapsed,
        metrics,
    };
}

async function benchPoolStability(numEnvs: number): Promise<BenchmarkResult> {
    const pool = new WorkerPool();
    await pool.init(numEnvs, {}, true);
    await pool.reset();

    const actions: any[] = [];
    for (let i = 0; i < numEnvs; i++) {
        actions.push({ left: false, right: true, up: false, down: false, heavy: false, grapple: false });
    }

    for (let i = 0; i < Math.min(WARMUP, 500); i++) {
        await pool.step(actions);
    }

    const segments: SegmentResult[] = [];
    let totalStart = performance.now();
    let segmentStart = totalStart;

    for (let i = 0; i < STEPS; i++) {
        await pool.step(actions);
        if ((i + 1) % REPORT_INTERVAL === 0) {
            const now = performance.now();
            const segElapsed = now - segmentStart;
            const segSps = REPORT_INTERVAL / (segElapsed / 1000);
            segments.push({ steps: REPORT_INTERVAL, elapsedMs: segElapsed, sps: segSps });
            segmentStart = now;
        }
    }

    const totalElapsed = performance.now() - totalStart;
    const overallSps = STEPS / (totalElapsed / 1000);
    const overallEnvSps = overallSps * numEnvs;
    const segSpsValues = segments.map(s => s.sps);
    const avgSegSps = segSpsValues.reduce((a, b) => a + b, 0) / segSpsValues.length;
    const stdDev = Math.sqrt(segSpsValues.reduce((sum, v) => sum + (v - avgSegSps) ** 2, 0) / segSpsValues.length);
    const cv = (stdDev / avgSegSps) * 100;

    pool.close();
    if (global.gc) global.gc();

    return {
        layer: 6,
        name: `WorkerPool stability N=${numEnvs} (${(STEPS / 1000).toFixed(0)}K steps)`,
        passed: cv < 15,
        status: cv < 15 ? 'PASS' : 'FAIL',
        durationMs: totalElapsed,
        metrics: [
            { label: 'SPS (per-env)', value: Math.round(overallSps), unit: 'steps/sec' },
            { label: 'Env-SPS (aggregate)', value: Math.round(overallEnvSps), unit: 'env-steps/sec' },
            { label: 'SPM (aggregate)', value: Math.round(overallEnvSps * 60), unit: 'env-steps/min' },
            { label: 'CV', value: +cv.toFixed(1), unit: '%' },
            { label: 'Total env-steps', value: STEPS * numEnvs, unit: '' },
        ],
    };
}

async function main(): Promise<void> {
    const suiteStart = performance.now();
    const suite = createSuite(6, 'Stability', 'Long-running throughput variance and GC pressure');

    recordResult(suite, benchNativeStability());

    for (const n of [1, 4, 8]) {
        try {
            const result = await benchPoolStability(n);
            recordResult(suite, result);
        } catch (e: any) {
            recordResult(suite, {
                layer: 6,
                name: `WorkerPool stability N=${n}`,
                passed: false,
                status: 'ERROR',
                durationMs: 0,
                metrics: [],
                error: e.message,
            });
        }
        await new Promise(r => setTimeout(r, 500));
    }

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer6.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
