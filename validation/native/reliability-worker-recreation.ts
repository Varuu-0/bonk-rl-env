import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { BonkEnvironment } from '../../src/core/environment';
import type { EnvironmentConfig, StepResult } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';
import { WorkerPool } from '../../src/core/worker-pool';

const LANES = 3;
const SEEDS = [41, 42, 43];
const REPLAY_STEPS = 20;
const CRASH_SETTLE_MS = 4000;
const ACTION_STREAMS = [[0, 2, 2, 16], [1], [4, 0]] as const;
const INTEGER_FIELDS = new Set(['tick', 'nativeRoundTick', 'opponentsAlive', 'scoreBlue', 'scoreRed', 'index', 'type']);

function rawMap(): NativeMap {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'maps', 'training-platform.json'), 'utf8')) as NativeMap;
}

function config(seed: number): EnvironmentConfig {
  return {
    mapData: rawMap(),
    numOpponents: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: 64,
    frameSkip: 3,
    seed,
    verboseTelemetry: false,
  } as EnvironmentConfig;
}

/** Compare public transports at their documented Float32 precision. */
function normalize(value: unknown, key = ''): unknown {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `Non-finite replay value at ${key}: ${value}`);
    return INTEGER_FIELDS.has(key) ? value : Math.fround(value);
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalize(entry, `${key}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        normalize(child, key ? `${key}.${childKey}` : childKey),
      ]),
    );
  }
  return value;
}

function actionAt(lane: number, step: number): number {
  const stream = ACTION_STREAMS[lane];
  return stream[step % stream.length];
}

function directReplay(): unknown[] {
  const envs = SEEDS.map((seed) => new BonkEnvironment(config(seed)));
  try {
    return envs.map((env, lane) => {
      const graph: unknown[] = [normalize(env.reset(SEEDS[lane]))];
      for (let step = 0; step < REPLAY_STEPS; step++) graph.push(normalize(env.step(actionAt(lane, step))));
      return graph;
    });
  } finally {
    for (const env of envs) env.close();
  }
}

/** Injection-only view of real Worker instances; no fake replacement or array. */
function realWorkers(pool: WorkerPool): Worker[] {
  return (pool as unknown as { workers: Worker[] }).workers;
}

function checkResidency(pool: WorkerPool, previousThreadIds: readonly number[] = []): number[] {
  const residency = pool.getWorkerResidency();
  assert.deepEqual(
    residency.map(({ numEnvs, startId }) => ({ numEnvs, startId })),
    [
      { numEnvs: 2, startId: 0 },
      { numEnvs: 1, startId: 2 },
    ],
  );
  const acknowledgedIds = residency.map(({ threadId }) => threadId);
  const actualIds = realWorkers(pool).map(({ threadId }) => threadId);
  assert.deepEqual(acknowledgedIds, actualIds);
  assert.equal(new Set(acknowledgedIds).size, 2);
  for (const threadId of acknowledgedIds) {
    assert(Number.isInteger(threadId) && threadId > 0);
    assert(!previousThreadIds.includes(threadId));
  }
  return acknowledgedIds;
}

async function poolReplay(pool: WorkerPool): Promise<unknown[]> {
  const reset = await pool.reset(SEEDS);
  const graphs = reset.map((observation) => [normalize(observation)]);
  for (let step = 0; step < REPLAY_STEPS; step++) {
    const results = (await pool.step(SEEDS.map((_, lane) => actionAt(lane, step)))) as StepResult[];
    assert.equal(results.length, LANES);
    results.forEach((result, lane) => {
      assert.equal(result.info.native, true);
      assert.equal(result.info.nativeMode, 'b');
      assert.equal(result.info.autoResetAfter, false);
      graphs[lane].push(normalize(result));
    });
  }
  return graphs;
}

async function crashDuringStep(pool: WorkerPool): Promise<number> {
  assert(realWorkers(pool)[0].threadId > 0);
  const pending = pool.step([47, 0, 0]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = process.hrtime.bigint();
  try {
    const outcome = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'timed-out' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timed-out' }), CRASH_SETTLE_MS);
      }),
    ]);
    assert.equal(outcome.status, 'rejected', 'a real worker crash must wake/reject the active step');
    if (outcome.status === 'rejected') {
      assert(outcome.error instanceof Error);
      assert.match(outcome.error.message, /Worker 0 failed: Worker 0 exited unexpectedly with code 86/);
    }
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(() => undefined);
  }
}

async function exercise(shared: boolean): Promise<Record<string, unknown>> {
  const pool = new WorkerPool(2);
  const crashes: number[] = [];
  const recreated: number[][] = [];
  try {
    await pool.init(LANES, config(SEEDS[0]), shared);
    assert.equal(pool.isUsingSharedMemory(), shared);
    let previousThreadIds = checkResidency(pool);
    await pool.reset(SEEDS);
    const expected = directReplay();

    for (let cycle = 0; cycle < 2; cycle++) {
      // The child was launched with the opt-in preload, so each real worker's
      // native step(47) exits with code 86 inside the active transport batch.
      await pool.reset();
      crashes.push(await crashDuringStep(pool));
      assert.equal(pool.isFailed(), true);
      assert.deepEqual(pool.getWorkerResidency(), []);
      await assert.rejects(pool.step([0, 0, 0]), /worker pool is in failed state/);

      // Explicit lifecycle recovery only; there is no automatic recovery claim.
      await pool.close();
      await pool.init(LANES, config(SEEDS[0]), shared);
      const ids = checkResidency(pool, previousThreadIds);
      recreated.push(ids);
      previousThreadIds = ids;
      assert.deepEqual(await poolReplay(pool), expected);
      assert.deepEqual(await poolReplay(pool), expected);
    }
    return {
      shared,
      crashes,
      recreated,
      replayStepsPerGraph: REPLAY_STEPS,
      replayComparisons: 4,
      nativeReplayComparisons: 4,
    };
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  if (WorkerPool.isSupported() !== true)
    throw new Error('SharedArrayBuffer is required for this native reliability receipt');
  const startedAt = process.hrtime.bigint();
  const cases = [await exercise(false), await exercise(true)];
  const receipt = {
    schemaVersion: 1,
    name: 'native-worker-failure-recreation',
    native: true,
    automaticRecovery: false,
    crashAction: 47,
    injectedExitCode: 86,
    crashSettleBudgetMs: CRASH_SETTLE_MS,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    cases,
  };
  // A single line lets the Vitest launcher include concise evidence on failure.
  writeSync(1, `NATIVE_RELIABILITY_RECEIPT ${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  writeSync(2, `${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
