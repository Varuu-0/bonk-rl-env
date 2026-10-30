/**
 * Legacy/public API determinism evidence — NOT native-physics fidelity.
 *
 * Replays identical explicit action streams through the current public
 * BonkEnvironment and WorkerPool APIs. Direct and worker lifecycle semantics
 * differ: direct stays terminal until reset(), whereas the worker resets
 * after serving the frame-skip terminal hold. The comparison therefore uses
 * one normalized result/reset graph, not raw call-by-call direct terminal
 * no-ops pretending to be more gameplay.
 *
 * Coverage: five unevenly distributed lanes, 224 calls/lane (1120 calls per
 * configuration), worker layouts 1/2/4, both transports, frameSkip 1/3,
 * natural deaths, truncation, terminal holds, and neighbor perturbation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import type { EnvironmentConfig, StepResult } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';

const LANES = 5;
const CALLS_PER_LANE = 224;
const MAX_TICKS = 137;
const BASE_SEED = 11;
const WORKER_LAYOUTS = [1, 2, 4] as const;
const ACTION_STREAMS = [[0], [2], [0, 2, 2, 2, 16], [1], [4]] as const;

const replayMap: MapDef = {
  name: 'legacy-public-determinism-arena',
  spawnPoints: { team_blue: { x: -200, y: -100 }, team_red: { x: -350, y: -100 } },
  bodies: [
    { name: 'safe-floor', type: 'rect', x: -250, y: 200, width: 500, height: 30, static: true },
    { name: 'lethal-floor', type: 'rect', x: 250, y: 200, width: 500, height: 30, static: true, isLethal: true },
    { name: 'left-wall', type: 'rect', x: -500, y: -50, width: 30, height: 500, static: true },
    { name: 'right-wall', type: 'rect', x: 500, y: -50, width: 30, height: 500, static: true },
    { name: 'ceiling', type: 'rect', x: 0, y: -300, width: 1000, height: 30, static: true },
  ],
};

type ReplayNode = { path: string; value: unknown };
type Replay = {
  nodes: ReplayNode[];
  stats: {
    publicSteps: number;
    advancedSteps: number;
    terminalHolds: number;
    naturalDeaths: number;
    pureTruncations: number;
    restarts: number;
  };
};

/** Canonical transport precision: direct Float64 -> the public Float32 contract. */
function normalize(value: unknown, key = ''): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite public value at ${key}: ${value}`);
    if (key === 'reward') return Math.fround(value);
    const isInteger =
      key === 'tick' ||
      key === 'opponentsAlive' ||
      key === 'scoreBlue' ||
      key === 'scoreRed' ||
      key === 'index' ||
      key === 'type';
    return isInteger ? value : Math.fround(value);
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

function addStep(nodes: ReplayNode[], path: string, result: StepResult): void {
  nodes.push({
    path,
    value: normalize({
      observation: result.observation,
      reward: result.reward,
      done: result.done,
      truncated: result.truncated,
      terminated: result.terminated,
      info: result.info,
    }),
  });
}

function makeConfig(frameSkip: 1 | 3): EnvironmentConfig {
  return {
    mapData: replayMap,
    numOpponents: 1,
    randomOpponent: false,
    maxTicks: MAX_TICKS,
    frameSkip,
    verboseTelemetry: false,
  } as EnvironmentConfig;
}

function emptyStats(): Replay['stats'] {
  return { publicSteps: 0, advancedSteps: 0, terminalHolds: 0, naturalDeaths: 0, pureTruncations: 0, restarts: 0 };
}

function recordOutcome(stats: Replay['stats'], result: StepResult, hold: boolean): void {
  stats.publicSteps++;
  if (hold) stats.terminalHolds++;
  else stats.advancedSteps++;
  if (result.done && !hold) {
    if (result.terminated) stats.naturalDeaths++;
    if (result.truncated && !result.terminated) stats.pureTruncations++;
  }
}

function replayDirect(frameSkip: 1 | 3, perturbNeighbor: boolean): Replay[] {
  const envs = Array.from({ length: LANES }, (_, lane) => {
    const config = makeConfig(frameSkip);
    return new BonkEnvironment({ ...config, seed: BASE_SEED + lane });
  });
  try {
    const states = envs.map((env, lane) => ({
      episode: 0,
      previousDone: false,
      stats: emptyStats(),
      nodes: [
        {
          path: 'reset[0]',
          value: normalize(env.reset(BASE_SEED + lane)),
        },
      ] as ReplayNode[],
    }));
    for (let step = 0; step < CALLS_PER_LANE; step++) {
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const pattern = ACTION_STREAMS[lane];
        let action: number = pattern[step % pattern.length];
        // Direct and pooled drivers consume the same public call index and
        // the same encoded action at every index. Object snapshots are not
        // needed here because both public surfaces encode integers by value.
        if (perturbNeighbor && lane === 1 && step >= 70 && step < 90) action = 63 - action;
        const result = envs[lane].step(action);
        const restart = state.previousDone && !result.done;
        const hold = state.previousDone && result.done;
        recordOutcome(state.stats, result, hold);
        addStep(state.nodes, `episode[${state.episode}].${hold ? 'hold' : 'step'}[${step}]`, result);
        if (restart) {
          state.stats.restarts++;
          state.episode++;
        }
        state.previousDone = result.done;
        if (result.done && !envs[lane].isTerminalHoldActive()) {
          // Match applyStepAutoReset: the last held terminal result is returned
          // before reset, and its observation remains the old terminal state.
          // Auto-reset seed/reset-observation edges are not exposed by step().
          envs[lane].reset();
        }
      }
    }
    return states.map(({ nodes, stats }) => ({ nodes, stats }));
  } finally {
    for (const env of envs) env.close();
  }
}

async function replayPool(
  frameSkip: 1 | 3,
  workers: number,
  useSharedMemory: boolean,
  perturbNeighbor: boolean,
): Promise<Replay[]> {
  const pool = new WorkerPool(workers);
  try {
    await pool.init(LANES, { ...makeConfig(frameSkip), seed: BASE_SEED }, useSharedMemory);
    if (useSharedMemory) expect(pool.isUsingSharedMemory()).toBe(true);
    const reset = await pool.reset(Array.from({ length: LANES }, (_, lane) => BASE_SEED + lane));
    const states = reset.map((observation) => ({
      episode: 0,
      previousDone: false,
      stats: emptyStats(),
      nodes: [{ path: 'reset[0]', value: normalize(observation) }] as ReplayNode[],
    }));
    for (let step = 0; step < CALLS_PER_LANE; step++) {
      const actions = ACTION_STREAMS.map((pattern, lane) => {
        let action: number = pattern[step % pattern.length];
        if (perturbNeighbor && lane === 1 && step >= 70 && step < 90) action = 63 - action;
        return action;
      });
      const results = (await pool.step(actions)) as StepResult[];
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const result = results[lane];
        const hold = state.previousDone && result.done;
        recordOutcome(state.stats, result, hold);
        addStep(state.nodes, `episode[${state.episode}].${hold ? 'hold' : 'step'}[${step}]`, result);
        if (state.previousDone && !result.done) {
          state.stats.restarts++;
          state.episode++;
        }
        state.previousDone = result.done;
      }
    }
    const replay = states.map(({ nodes, stats }) => ({ nodes, stats }));
    await pool.close();
    await pool.close(); // Public close is idempotent and releases every worker.
    await expect(pool.step(new Array(LANES).fill(0))).rejects.toThrow('worker pool is closed');
    return replay;
  } finally {
    await pool.close();
  }
}

function firstDifference(expected: unknown, actual: unknown, path = 'result'): string | null {
  if (Object.is(expected, actual)) return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return `${path}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`;
  }
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (!(key in left) || !(key in right)) return `${path}.${key}: key presence differs`;
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function expectSameReplay(actual: Replay, expected: Replay, label: string): void {
  expect(actual.stats, `${label}: event counts`).toEqual(expected.stats);
  const left = actual.nodes;
  const right = expected.nodes;
  expect(left.length, `${label}: graph length`).toBe(right.length);
  const count = Math.min(left.length, right.length);
  for (let node = 0; node < count; node++) {
    const difference = firstDifference(left[node].value, right[node].value);
    expect(
      difference,
      `${label}: first mismatch node=${node} (${right[node].path}), path=${left[node].path}`,
    ).toBeNull();
    expect(left[node].path, `${label}: node=${node} event identity`).toBe(right[node].path);
  }
}

function expectMeaningfulCoverage(replays: Replay[], frameSkip: 1 | 3): void {
  const total = replays.reduce(
    (sum, replay) => ({
      publicSteps: sum.publicSteps + replay.stats.publicSteps,
      advancedSteps: sum.advancedSteps + replay.stats.advancedSteps,
      terminalHolds: sum.terminalHolds + replay.stats.terminalHolds,
      naturalDeaths: sum.naturalDeaths + replay.stats.naturalDeaths,
      pureTruncations: sum.pureTruncations + replay.stats.pureTruncations,
      restarts: sum.restarts + replay.stats.restarts,
    }),
    emptyStats(),
  );
  expect(total.publicSteps).toBe(1120);
  expect(total.advancedSteps).toBe(frameSkip === 1 ? 1120 : 1102);
  expect(total.naturalDeaths).toBe(16);
  expect(total.pureTruncations).toBe(2);
  expect(total.restarts).toBe(18);
  expect(total.terminalHolds).toBe(frameSkip === 3 ? 18 : 0);
  // Specifically guard cross-lane evidence, rather than letting one busy lane
  // satisfy all the aggregate counters.
  expect(replays.filter((replay) => replay.stats.naturalDeaths > 0)).toHaveLength(3);
  expect(replays.filter((replay) => replay.stats.pureTruncations > 0)).toHaveLength(2);
}

describe('legacy/public direct-vs-batch deterministic replay (not native parity)', () => {
  beforeEach(() => {
    // Current workers have no silent-init/reset option; contain only their
    // known startup/reset logs without hiding warnings, errors, or failures.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([1, 3] as const)('frameSkip=%i survives neighbor perturbation in direct mode', (frameSkip) => {
    const baseline = replayDirect(frameSkip, false);
    const perturbed = replayDirect(frameSkip, true);
    for (const lane of [0, 2, 3, 4]) expectSameReplay(perturbed[lane], baseline[lane], `direct lane ${lane}`);
    expect(firstDifference(perturbed[1].nodes, baseline[1].nodes)).not.toBeNull();
  });

  it.each([false, true])('sharedMemory=%s preserves isolated results under neighbor perturbation', async (shared) => {
    if (shared && !WorkerPool.isSupported()) return;
    const baseline = await replayPool(3, 2, shared, false);
    const perturbed = await replayPool(3, 2, shared, true);
    for (const lane of [0, 2, 3, 4]) {
      expectSameReplay(perturbed[lane], baseline[lane], `isolation shared=${shared} lane=${lane}`);
    }
    expect(firstDifference(perturbed[1].nodes, baseline[1].nodes)).not.toBeNull();
  });

  it.each([1, 3] as const)(
    'frameSkip=%i matches direct across both transports and worker layouts 1/2/4',
    async (frameSkip) => {
      const baseline = replayDirect(frameSkip, false);
      expectMeaningfulCoverage(baseline, frameSkip);
      for (const useSharedMemory of [false, true]) {
        if (useSharedMemory && !WorkerPool.isSupported()) continue;
        for (const workers of WORKER_LAYOUTS) {
          const actual = await replayPool(frameSkip, workers, useSharedMemory, false);
          expectMeaningfulCoverage(actual, frameSkip);
          for (let lane = 0; lane < LANES; lane++) {
            expectSameReplay(
              actual[lane],
              baseline[lane],
              `frameSkip=${frameSkip} shared=${useSharedMemory} workers=${workers} lane=${lane}`,
            );
          }
        }
      }
    },
    60000,
  );
});
