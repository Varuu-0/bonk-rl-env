import { WorkerPool } from '../src/core/worker-pool';

async function main() {
    const envCounts = [1, 2, 4, 8, 16, 32, 64, 128];
    const STEPS = 40000;
    const WARMUP = 100;

    console.log('=== WorkerPool 40K Step Throughput Benchmark ===');
    console.log(`Steps per config: ${STEPS} (+ ${WARMUP} warmup)`);
    console.log(`Shared Memory: enabled`);
    console.log('');

    const results: { n: number; sps: number; envSps: number; duration: number; latencyMs: number }[] = [];

    for (const numEnvs of envCounts) {
        try {
            const pool = new WorkerPool(Math.min(numEnvs, 8));
            await pool.init(numEnvs, {}, true);
            await pool.reset();

            // Build action arrays
            const actions: number[] = [];
            for (let i = 0; i < numEnvs; i++) {
                actions.push(Math.floor(Math.random() * 64));
            }

            // Warmup
            for (let i = 0; i < WARMUP; i++) {
                await pool.step(actions);
            }

            // Benchmark
            const start = performance.now();
            for (let i = 0; i < STEPS; i++) {
                await pool.step(actions);
            }
            const elapsed = performance.now() - start;

            const sps = STEPS / (elapsed / 1000);
            const totalEnvSteps = STEPS * numEnvs;
            const envSPS = totalEnvSteps / (elapsed / 1000);
            const latencyMs = elapsed / STEPS;

            results.push({ n: numEnvs, sps, envSps: envSPS, duration: elapsed / 1000, latencyMs });

            console.log(
                `N=${String(numEnvs).padStart(3)} | ` +
                `SPS: ${String(Math.round(sps)).padStart(8)} | ` +
                `Env-SPS: ${String(Math.round(envSPS)).padStart(10)} | ` +
                `Duration: ${(elapsed / 1000).toFixed(2).padStart(7)}s | ` +
                `Latency: ${latencyMs.toFixed(3).padStart(8)}ms`
            );

            pool.close();
            // Cooldown between configs
            await new Promise(r => setTimeout(r, 1000));
        } catch (e: any) {
            console.log(`N=${String(numEnvs).padStart(3)} | ERROR: ${e.message}`);
        }
    }

    // Summary table
    console.log('');
    console.log('=== Summary ===');
    console.log('N     | SPS        | Env-SPS     | Duration   | Latency');
    console.log('------+------------+-------------+------------+----------');
    for (const r of results) {
        console.log(
            `${String(r.n).padStart(5)} | ${Math.round(r.sps).toString().padStart(10)} | ${Math.round(r.envSps).toString().padStart(11)} | ${r.duration.toFixed(2).padStart(8)}s  | ${r.latencyMs.toFixed(3).padStart(8)}ms`
        );
    }

    // Scaling analysis
    if (results.length >= 2) {
        const baseline = results[0];
        console.log('');
        console.log('=== Scaling Analysis ===');
        for (const r of results) {
            const speedup = r.envSps / baseline.envSps;
            const efficiency = (speedup / r.n) * 100;
            console.log(
                `N=${String(r.n).padStart(3)} | Speedup: ${speedup.toFixed(2)}x | Efficiency: ${efficiency.toFixed(1)}%`
            );
        }
    }

    console.log('');
    console.log('=== Done ===');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
