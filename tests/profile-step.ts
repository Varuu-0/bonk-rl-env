import { WorkerPool } from '../src/core/worker-pool';

async function profileStep(numEnvs: number) {
    const pool = new WorkerPool(Math.min(numEnvs, 8));
    await pool.init(numEnvs, {}, true);  // shared memory
    await pool.reset();

    const actions: number[] = new Array(numEnvs).fill(0);

    // Warmup
    for (let i = 0; i < 50; i++) await pool.step(actions);

    // Profile 500 steps
    const STEPS = 500;
    const timings = { writeActions: 0, signal: 0, wait: 0, readObs: 0, extract: 0, total: 0 };

    const totalStart = performance.now();
    for (let s = 0; s < STEPS; s++) {
        const start = performance.now();
        await pool.step(actions);
        timings.total += performance.now() - start;
    }
    const totalTime = timings.total;
    const sps = STEPS / (totalTime / 1000);
    const latencyMs = totalTime / STEPS;

    console.log(`N=${String(numEnvs).padStart(3)} | Total: ${(totalTime).toFixed(1).padStart(8)}ms | SPS: ${Math.round(sps).toString().padStart(7)} | Latency: ${latencyMs.toFixed(3)}ms`);

    pool.close();
}

async function main() {
    console.log('=== Step Timing Profile ===');
    for (const n of [1, 2, 4, 8, 16, 32]) {
        try {
            await profileStep(n);
        } catch (e: any) {
            console.log(`N=${n} ERROR: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('Done');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
