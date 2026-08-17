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
const MAX_ATTEMPTS = 3;
const WORKER_COUNTS = [1, 2, 4, 8, 16];
const SAMPLE_ORDERS = [
  [1, 2, 4, 8, 16],
  [2, 4, 8, 16, 1],
  [4, 8, 16, 1, 2],
  [8, 16, 1, 2, 4],
  [16, 1, 2, 4, 8],
  [16, 8, 4, 2, 1],
  [8, 4, 2, 1, 16],
  [4, 2, 1, 16, 8],
  [2, 1, 16, 8, 4],
  [1, 16, 8, 4, 2],
];
const MIN_SAMPLES_PER_COUNT = SAMPLE_ORDERS.length / 2;
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

/**
 * Deterministic pseudo-random action workload. A fixed-seed LCG keeps the
 * exact action sequence reproducible across runs while exercising more than
 * the idle action.
 */
function makeActions(numWorkers: number): number[] {
  let state = (0x0bad5eed + numWorkers * 0x9e3779b9) >>> 0;
  const actions = new Array<number>(numWorkers);
  for (let i = 0; i < numWorkers; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    actions[i] = state % 64;
  }
  return actions;
}

async function createPool(numWorkers: number): Promise<WorkerPool> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pool = new WorkerPool(numWorkers);
    try {
      await pool.init(numWorkers, BENCH_CONFIG, true);
      if (!pool.isUsingSharedMemory()) {
        throw new Error('SharedArrayBuffer mode unavailable');
      }
      return pool;
    } catch (e) {
      lastError = e;
      try {
        await pool.close();
      } catch {
        // preserve the original error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Returns per-step latencies (ms) for STEPS_PER_SAMPLE measured steps.
 * Warmup is excluded; the caller resets the pool to a deterministic state
 * before each sample.
 */
async function measureSample(pool: WorkerPool, actions: number[]): Promise<number[]> {
  const seeds = actions.map((_, index) => index + 1);
  await pool.reset(seeds, { ownership: 'borrowed' });

  for (let i = 0; i < WARMUP_STEPS; i++) {
    await pool.step(actions, { ownership: 'borrowed' });
  }

  const stepLatencies = new Array<number>(STEPS_PER_SAMPLE);
  let prev = performance.now();
  for (let i = 0; i < STEPS_PER_SAMPLE; i++) {
    await pool.step(actions, { ownership: 'borrowed' });
    const now = performance.now();
    stepLatencies[i] = now - prev;
    prev = now;
  }
  return stepLatencies;
}

function createResult(numWorkers: number, samples: number[][], baselineEnvSps: number): BenchmarkResult {
  const latenciesMs = samples.flat();
  const medianLatencyMs = quantile(latenciesMs, 0.5);
  const batchSps = 1_000 / medianLatencyMs;
  const envSps = batchSps * numWorkers;
  const passed = numWorkers === 1 ? batchSps > 2_000 : baselineEnvSps > 0 && envSps >= baselineEnvSps * 0.9;

  return {
    layer: 4,
    name: `WorkerPool.step() N=${numWorkers}`,
    passed,
    status: passed ? 'PASS' : 'FAIL',
    durationMs: latenciesMs.reduce((sum, latency) => sum + latency, 0),
    metrics: [
      { label: 'Batch SPS', value: Math.round(batchSps), unit: 'batches/sec' },
      { label: 'Env-SPS (aggregate)', value: Math.round(envSps), unit: 'env-steps/sec' },
      { label: 'Median latency', value: +medianLatencyMs.toFixed(3), unit: 'ms' },
      { label: 'P25 latency', value: +quantile(latenciesMs, 0.25).toFixed(3), unit: 'ms' },
      { label: 'P75 latency', value: +quantile(latenciesMs, 0.75).toFixed(3), unit: 'ms' },
      { label: 'Workers', value: numWorkers, unit: '' },
      { label: 'Envs per worker', value: 1, unit: '' },
      { label: 'Samples', value: samples.length, unit: '' },
      { label: 'Steps per sample', value: STEPS_PER_SAMPLE, unit: '' },
    ],
  };
}

async function main(): Promise<void> {
  const suiteStart = performance.now();
  const suite = createSuite(4, 'Worker Pool', 'SharedArrayBuffer IPC scaling across exact worker counts');
  const samples = new Map<number, number[][]>(WORKER_COUNTS.map((count) => [count, []]));
  const errors = new Map<number, string>();
  const pools = new Map<number, WorkerPool>();

  try {
    for (const numWorkers of WORKER_COUNTS) {
      try {
        pools.set(numWorkers, await createPool(numWorkers));
      } catch (e: any) {
        errors.set(numWorkers, `pool init failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const order of SAMPLE_ORDERS) {
      for (const numWorkers of order) {
        if (errors.has(numWorkers)) continue;
        const pool = pools.get(numWorkers)!;
        const actions = makeActions(numWorkers);
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          try {
            samples.get(numWorkers)!.push(await measureSample(pool, actions));
            lastError = undefined;
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (lastError !== undefined) {
          // Drop only this sample; earlier samples stay retained and
          // later orders keep collecting for this worker count.
          console.warn(
            `[Layer 4] N=${numWorkers} sample dropped after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          );
        }
      }
    }
  } finally {
    for (const pool of pools.values()) {
      await pool.close();
    }
  }

  const baselineLatencies = samples.get(1)!;
  const baselineUnderpowered = baselineLatencies.length < MIN_SAMPLES_PER_COUNT;
  const baselineEnvSps = !baselineUnderpowered ? 1_000 / quantile(baselineLatencies.flat(), 0.5) : 0;

  for (const numWorkers of WORKER_COUNTS) {
    const retainedSamples = samples.get(numWorkers)!.length;
    if (errors.has(numWorkers)) {
      recordResult(suite, {
        layer: 4,
        name: `WorkerPool.step() N=${numWorkers}`,
        passed: false,
        status: 'ERROR',
        durationMs: 0,
        metrics: [],
        error: errors.get(numWorkers)!,
      });
    } else if (retainedSamples < MIN_SAMPLES_PER_COUNT) {
      recordResult(suite, {
        layer: 4,
        name: `WorkerPool.step() N=${numWorkers}`,
        passed: false,
        status: 'ERROR',
        durationMs: 0,
        metrics: [],
        error: `only ${retainedSamples}/${SAMPLE_ORDERS.length} samples retained for N=${numWorkers}`,
      });
    } else if (baselineUnderpowered && numWorkers !== 1) {
      recordResult(suite, {
        layer: 4,
        name: `WorkerPool.step() N=${numWorkers}`,
        passed: false,
        status: 'ERROR',
        durationMs: 0,
        metrics: [],
        error: `N=1 baseline underpowered (${baselineLatencies.length}/${SAMPLE_ORDERS.length} samples) — scaling gate not evaluated`,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
