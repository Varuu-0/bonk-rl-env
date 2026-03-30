import { WorkerPool } from '../src/core/worker-pool';

async function benchPhases(numEnvs: number, steps: number) {
    const pool = new WorkerPool(Math.min(numEnvs, 8));
    await pool.init(numEnvs, {}, true);
    await pool.reset();

    const actions: number[] = new Array(numEnvs).fill(0);

    // Warmup
    for (let i = 0; i < 20; i++) await pool.step(actions);

    // Time individual phases by wrapping stepSharedMemory
    // We can't easily instrument internals, but we can measure total step time
    // and compare with theoretical minimum

    const t0 = performance.now();
    for (let i = 0; i < steps; i++) {
        await pool.step(actions);
    }
    const totalTime = performance.now() - t0;
    const perStep = totalTime / steps;
    const sps = steps / (totalTime / 1000);
    const envSps = sps * numEnvs;

    // Theoretical minimum: each env needs ~38μs of physics
    // With W workers: per-step minimum = (N/W) * 38μs
    const W = Math.min(numEnvs, 8);
    const theoreticalMin = (numEnvs / W) * 38;  // μs
    const poolOverhead = perStep * 1000 - theoreticalMin;
    const overheadPct = (poolOverhead / (perStep * 1000)) * 100;

    console.log(
        `N=${String(numEnvs).padStart(3)} | ` +
        `SPS: ${Math.round(sps).toString().padStart(7)} | ` +
        `Env-SPS: ${Math.round(envSps).toString().padStart(9)} | ` +
        `Per-step: ${(perStep * 1000).toFixed(1).padStart(7)}μs | ` +
        `Physics min: ${theoreticalMin.toFixed(1).padStart(6)}μs | ` +
        `Pool overhead: ${poolOverhead.toFixed(1).padStart(7)}μs (${overheadPct.toFixed(1)}%)`
    );

    pool.close();
}

async function main() {
    console.log('=== Pool Phase Breakdown ===');
    console.log('Physics per env: ~38μs | Workers: min(N, 8)');
    console.log('');
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128]) {
        try {
            await benchPhases(n, 2000);
        } catch (e: any) {
            console.log(`N=${n} ERROR: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('\nDone');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
