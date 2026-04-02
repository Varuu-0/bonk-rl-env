/**
 * Long-Running Throughput Benchmark
 * Tests sustained performance over 100K steps to eliminate JIT warmup noise
 * and capture GC pressure effects, memory stability, and long-term throughput.
 */
import { BonkEnvironment } from '../src/core/environment';
import { WorkerPool } from '../src/core/worker-pool';

const STEPS = 100_000;
const WARMUP = 2_000;
const REPORT_INTERVAL = 10_000;

const origWarn = console.warn;
console.warn = (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0].includes('Could not load')) return;
    origWarn(...args);
};

interface SegmentResult {
    steps: number;
    elapsedMs: number;
    sps: number;
}

function runNativeBenchmark(): void {
    console.log('\n=== NATIVE ENVIRONMENT BENCHMARK (100K steps) ===');
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });
    console.warn = origWarn;

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
            const cumSps = (i + 1) / ((now - totalStart) / 1000);
            console.log(`  [${((i + 1) / 1000).toFixed(0)}K] Segment: ${segSps.toFixed(0)} SPS | Cumulative: ${cumSps.toFixed(0)} SPS`);
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

    console.log(`\n--- NATIVE SUMMARY ---`);
    console.log(`  Total steps: ${STEPS.toLocaleString()}`);
    console.log(`  Total duration: ${(totalElapsed / 1000).toFixed(2)}s`);
    console.log(`  Overall SPS: ${overallSps.toFixed(0)}`);
    console.log(`  Avg segment SPS: ${avgSegSps.toFixed(0)}`);
    console.log(`  Min segment SPS: ${minSegSps.toFixed(0)}`);
    console.log(`  Max segment SPS: ${maxSegSps.toFixed(0)}`);
    console.log(`  Std deviation: ${stdDev.toFixed(0)} (${cv.toFixed(1)}% CV)`);
    console.log(`  Avg step time: ${((1 / overallSps) * 1_000_000).toFixed(1)} us`);

    if (global.gc) global.gc();
}

async function runPoolBenchmark(numEnvs: number): Promise<void> {
    console.log(`\n=== WORKER POOL BENCHMARK (N=${numEnvs}, ${STEPS.toLocaleString()} steps) ===`);
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
            const segEnvSps = segSps * numEnvs;
            segments.push({ steps: REPORT_INTERVAL, elapsedMs: segElapsed, sps: segSps });
            const cumSps = (i + 1) / ((now - totalStart) / 1000);
            console.log(`  [${((i + 1) / 1000).toFixed(0)}K] SPS: ${segSps.toFixed(0)} | Env-SPS: ${segEnvSps.toFixed(0)} | Cumulative: ${(cumSps * numEnvs).toFixed(0)} Env-SPS`);
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

    console.log(`\n--- POOL N=${numEnvs} SUMMARY ---`);
    console.log(`  Total env-steps: ${(STEPS * numEnvs).toLocaleString()}`);
    console.log(`  Duration: ${(totalElapsed / 1000).toFixed(2)}s`);
    console.log(`  SPS (per-env): ${overallSps.toFixed(0)}`);
    console.log(`  Env-SPS (aggregate): ${overallEnvSps.toFixed(0)}`);
    console.log(`  SPM (aggregate): ${(overallEnvSps * 60).toFixed(0)}`);
    console.log(`  Stability (CV): ${cv.toFixed(1)}%`);
    console.log(`  Avg step time: ${(totalElapsed / STEPS).toFixed(3)} ms`);

    pool.close();
    if (global.gc) global.gc();
}

async function main() {
    runNativeBenchmark();

    const poolConfigs = [1, 4, 8, 16];
    for (const n of poolConfigs) {
        await runPoolBenchmark(n);
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n=== 100K BENCHMARK COMPLETE ===');
}

main().catch(e => {
    console.error('Benchmark failed:', e);
    process.exit(1);
});
