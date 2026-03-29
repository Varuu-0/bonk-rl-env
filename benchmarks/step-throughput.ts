import { WorkerPool } from '../src/core/worker-pool';

async function main() {
  const envCounts = [1, 2, 4, 8, 16];
  const STEPS = 2000;
  const WARMUP = 100;

  console.log('=== WorkerPool Step Throughput Benchmark ===');
  console.log(`Steps per config: ${STEPS} (+ ${WARMUP} warmup)`);
  console.log('');

  for (const numEnvs of envCounts) {
    const pool = new WorkerPool(1);
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

    console.log(`N=${String(numEnvs).padStart(2)} | SPS: ${String(Math.round(sps)).padStart(7)} | Env-SPS: ${String(Math.round(envSPS)).padStart(8)} | Duration: ${(elapsed/1000).toFixed(2)}s`);

    pool.close();
    // Small cooldown
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('');
  console.log('=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
