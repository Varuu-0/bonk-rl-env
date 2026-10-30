/**
 * Raw-native-map WorkerPool replay against the CURRENT public environment.
 * This is direct-vs-pool API evidence, not independent native-physics fidelity.
 *
 * The direct oracle mirrors applyStepAutoReset only after the terminal hold is
 * complete. Initial explicit resets, advancing results, terminal holds, and
 * episode boundaries are compared; no fictitious auto-reset observation is
 * inserted into the public step result stream.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, EnvironmentConfig, StepResult } from '../../src/core/environment';
import { BonkEnvironment } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';
import type { PlayerInput } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';

const MAP_PATH = path.join(process.cwd(), 'maps', 'training-platform.json');
const LANES = 5;
const CALLS = 224;
const MAX_TICKS = 197;
const BASE_SEED = 11;
const WORKER_LAYOUTS = [1, 2, 4] as const;
const ACTION_STREAMS = [[0], [2], [0, 2, 2, 2, 16], [1], [4]] as const;
const NATIVE_INFO_KEYS = ['native', 'nativeMode', 'nativePhase', 'nativeRoundTick'];

function rawMap(): NativeMap {
  // Fresh JSON data for every environment; no direct/pool fixture mutation or
  // normalized MapDef substitution can hide the raw native map selection.
  return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as NativeMap;
}

function objectAction(bits: number): PlayerInput {
  return {
    left: (bits & 1) !== 0,
    right: (bits & 2) !== 0,
    up: (bits & 4) !== 0,
    down: (bits & 8) !== 0,
    heavy: (bits & 16) !== 0,
    grapple: false,
  };
}

function actionAt(lane: number, call: number): Action {
  const stream = ACTION_STREAMS[lane];
  const bits = stream[call % stream.length];
  // Every lane uses both forms. The object form is complete, not a partial
  // input whose omitted fields could conceal a direct/pool encoding difference.
  return (call + lane) % 2 === 0 ? objectAction(bits) : bits;
}

function makeConfig(frameSkip: 1 | 3): EnvironmentConfig {
  return {
    mapData: rawMap(),
    numOpponents: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: MAX_TICKS,
    frameSkip,
    verboseTelemetry: false,
  } as EnvironmentConfig;
}

type ReplayNode = { path: string; value: unknown };
type Stats = {
  publicSteps: number;
  advancingSteps: number;
  terminalHolds: number;
  naturalDeaths: number;
  pureTruncations: number;
  restarts: number;
  objectActions: number;
  numberActions: number;
};
type Replay = { nodes: ReplayNode[]; stats: Stats };

function emptyStats(): Stats {
  return {
    publicSteps: 0,
    advancingSteps: 0,
    terminalHolds: 0,
    naturalDeaths: 0,
    pureTruncations: 0,
    restarts: 0,
    objectActions: 0,
    numberActions: 0,
  };
}

const INTEGER_INFO_KEYS = new Set([
  'tick',
  'nativeRoundTick',
  'opponentsAlive',
  'scoreBlue',
  'scoreRed',
  'index',
  'type',
]);

/** Normalize only numeric transport precision; retain every public info key. */
function normalize(value: unknown, key = ''): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite public value at ${key}: ${value}`);
    return INTEGER_INFO_KEYS.has(key) ? value : Math.fround(value);
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

function recordResult(stats: Stats, result: StepResult, action: Action, hold: boolean): void {
  stats.publicSteps++;
  if (typeof action === 'number') stats.numberActions++;
  else stats.objectActions++;
  if (hold) stats.terminalHolds++;
  else {
    stats.advancingSteps++;
    if (result.done) {
      if (result.terminated) stats.naturalDeaths++;
      if (result.truncated && !result.terminated) stats.pureTruncations++;
    }
  }
}

function replayDirect(frameSkip: 1 | 3, perturbNeighbor = false): Replay[] {
  const envs = Array.from(
    { length: LANES },
    (_, lane) => new BonkEnvironment({ ...makeConfig(frameSkip), seed: BASE_SEED + lane }),
  );
  try {
    const states = envs.map((env, lane) => ({
      episode: 0,
      previousDone: false,
      stats: emptyStats(),
      nodes: [{ path: 'reset[0]', value: normalize(env.reset(BASE_SEED + lane)) }] as ReplayNode[],
    }));
    for (let call = 0; call < CALLS; call++) {
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        let action = actionAt(lane, call);
        if (perturbNeighbor && lane === 1 && call >= 70 && call < 90) {
          action = objectAction(31 - ACTION_STREAMS[lane][call % ACTION_STREAMS[lane].length]);
        }
        const result = envs[lane].step(action);
        const restart = state.previousDone && !result.done;
        const hold = state.previousDone && result.done;
        recordResult(state.stats, result, action, hold);
        addStep(state.nodes, `episode[${state.episode}].${hold ? 'hold' : 'step'}[${call}]`, result);
        if (restart) {
          state.stats.restarts++;
          state.episode++;
        }
        state.previousDone = result.done;
        if (result.done && !envs[lane].isTerminalHoldActive()) envs[lane].reset();
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
  perturbNeighbor = false,
): Promise<Replay[]> {
  const pool = new WorkerPool(workers);
  try {
    // This init executes src/core/worker-loader.js (tsx/cjs -> worker.ts) in
    // every real worker, rather than mocking Worker or importing worker.ts here.
    await pool.init(LANES, { ...makeConfig(frameSkip), seed: BASE_SEED }, useSharedMemory);
    expect(pool.isUsingSharedMemory()).toBe(useSharedMemory);
    const reset = await pool.reset(Array.from({ length: LANES }, (_, lane) => BASE_SEED + lane));
    const states = reset.map((observation) => ({
      episode: 0,
      previousDone: false,
      stats: emptyStats(),
      nodes: [{ path: 'reset[0]', value: normalize(observation) }] as ReplayNode[],
    }));
    for (let call = 0; call < CALLS; call++) {
      const actions = Array.from({ length: LANES }, (_, lane) => {
        if (perturbNeighbor && lane === 1 && call >= 70 && call < 90) {
          return objectAction(31 - ACTION_STREAMS[lane][call % ACTION_STREAMS[lane].length]);
        }
        return actionAt(lane, call);
      });
      const results = (await pool.step(actions)) as StepResult[];
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const result = results[lane];
        const hold = state.previousDone && result.done;
        recordResult(state.stats, result, actions[lane], hold);
        addStep(state.nodes, `episode[${state.episode}].${hold ? 'hold' : 'step'}[${call}]`, result);
        if (state.previousDone && !result.done) {
          state.stats.restarts++;
          state.episode++;
        }
        state.previousDone = result.done;
      }
    }
    const replay = states.map(({ nodes, stats }) => ({ nodes, stats }));
    await pool.close();
    await pool.close();
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
    if (!(key in left) || !(key in right)) {
      return `${path}.${key}: expected=${key in left ? JSON.stringify(left[key]) : '<missing>'}, actual=${
        key in right ? JSON.stringify(right[key]) : '<missing>'
      }`;
    }
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function compareReplay(actual: Replay, expected: Replay, label: string): string[] {
  const failures: string[] = [];
  const statsDifference = firstDifference(expected.stats, actual.stats, 'stats');
  if (statsDifference) failures.push(`${label}: ${statsDifference}`);
  const count = Math.min(actual.nodes.length, expected.nodes.length);
  if (actual.nodes.length !== expected.nodes.length) {
    failures.push(`${label}: graph length ${actual.nodes.length} !== ${expected.nodes.length}`);
  }
  for (let node = 0; node < count; node++) {
    const pathDifference = firstDifference(expected.nodes[node].path, actual.nodes[node].path, 'event');
    if (pathDifference) failures.push(`${label}: node=${node} ${pathDifference}`);
    const difference = firstDifference(expected.nodes[node].value, actual.nodes[node].value);
    if (difference) {
      failures.push(`${label}: first graph mismatch node=${node} (${expected.nodes[node].path}), ${difference}`);
      break; // One reduced mismatch per lane, not thousands of full graph dumps.
    }
  }
  return failures;
}

function expectCoverage(replays: Replay[], frameSkip: 1 | 3): void {
  const total = replays.reduce((sum, replay) => {
    for (const key of Object.keys(sum) as Array<keyof Stats>) sum[key] += replay.stats[key];
    return sum;
  }, emptyStats());
  expect(total).toEqual({
    publicSteps: 1120,
    advancingSteps: frameSkip === 1 ? 1120 : 1116,
    terminalHolds: frameSkip === 1 ? 0 : 4,
    naturalDeaths: 2,
    pureTruncations: 3,
    restarts: 5,
    objectActions: 560,
    numberActions: 560,
  });
  expect(replays.filter((replay) => replay.stats.naturalDeaths > 0)).toHaveLength(2);
  expect(replays.filter((replay) => replay.stats.pureTruncations > 0)).toHaveLength(3);
  for (const replay of replays) {
    for (const node of replay.nodes) {
      if (node.path.startsWith('reset')) continue;
      const info = (node.value as any).info;
      expect(info.native).toBe(true);
      expect(info.nativeMode).toBe('b');
      expect(typeof info.nativePhase).toBe('string');
      expect(Number.isInteger(info.nativeRoundTick)).toBe(true);
    }
  }
}

describe('raw native training-platform WorkerPool replay (public API evidence)', () => {
  beforeEach(() => {
    // There is no silent worker init/reset option; suppress only console.log,
    // never warnings/errors. The runner's --silent flag covers child threads.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([1, 3] as const)(
    'frameSkip=%i full public graphs match direct for both transports and 1/2/4 workers',
    async (frameSkip) => {
      const baseline = replayDirect(frameSkip);
      expectCoverage(baseline, frameSkip);
      const failures: string[] = [];
      for (const useSharedMemory of [false, true]) {
        if (useSharedMemory && !WorkerPool.isSupported()) continue;
        for (const workers of WORKER_LAYOUTS) {
          const actual = await replayPool(frameSkip, workers, useSharedMemory);
          const label = `frameSkip=${frameSkip} shared=${useSharedMemory} workers=${workers}`;
          // No key filtering or missing-field fallback: native-only info fields
          // are required public graph content, not optional transport metadata.
          for (let lane = 0; lane < LANES; lane++) {
            failures.push(...compareReplay(actual[lane], baseline[lane], `${label} lane=${lane}`));
          }
        }
      }
      expect(failures).toEqual([]);
    },
    60000,
  );

  it.each([1, 3] as const)('frameSkip=%i direct neighbor perturbation leaves other lanes unchanged', (frameSkip) => {
    const baseline = replayDirect(frameSkip);
    const perturbed = replayDirect(frameSkip, true);
    const failures: string[] = [];
    for (const lane of [0, 2, 3, 4]) {
      failures.push(...compareReplay(perturbed[lane], baseline[lane], `direct lane=${lane}`));
    }
    expect(firstDifference(perturbed[1].nodes, baseline[1].nodes)).not.toBeNull();
    expect(failures).toEqual([]);
  });

  it.each([false, true])('shared=%s neighbor perturbation leaves other lanes unchanged', async (shared) => {
    if (shared && !WorkerPool.isSupported()) return;
    const baseline = await replayPool(3, 2, shared);
    const perturbed = await replayPool(3, 2, shared, true);
    const failures: string[] = [];
    for (const lane of [0, 2, 3, 4]) {
      failures.push(...compareReplay(perturbed[lane], baseline[lane], `shared=${shared} lane=${lane}`));
    }
    expect(firstDifference(perturbed[1].nodes, baseline[1].nodes)).not.toBeNull();
    expect(failures).toEqual([]);
  });

  it('both transports expose identical native info fields', async () => {
    // Regression receipt for the former reduced first-step transport mismatch.
    // The full graph tests above independently require all four fields.
    const message = await replayPool(1, 1, false);
    const shared = await replayPool(1, 1, true);
    const messageInfo = (message[0].nodes[1].value as any).info;
    const sharedInfo = (shared[0].nodes[1].value as any).info;
    for (const key of NATIVE_INFO_KEYS) {
      expect(messageInfo).toHaveProperty(key);
      expect(sharedInfo).toHaveProperty(key, messageInfo[key]);
    }
    expect(sharedInfo.nativePhase).toBe('countdown');
    expect(sharedInfo.nativeRoundTick).toBe(1);
  });
});
