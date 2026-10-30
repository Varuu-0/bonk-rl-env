/**
 * Worker-pool transport parity for explicit non-Classic room modes
 * (`nativeMode` ar/ard/v): the message and shared-memory transports must carry
 * the room mode and produce full public step graphs identical to the direct
 * public BonkEnvironment, exactly like the Classic replay evidence.
 *
 * This is direct-vs-pool API evidence for the public environment surface, not
 * independent native-physics fidelity (that is the pinned original
 * differential comparator's job).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BonkEnvironment, type Action, type EnvironmentConfig, type StepResult } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';
import type { PlayerInput } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';

const MAP_PATH = path.join(process.cwd(), 'maps', 'training-platform.json');
const MODES = ['ar', 'ard', 'v'] as const;
const LANES = 2;
const CALLS = 96;
const MAX_TICKS = 10000;
const BASE_SEED = 11;
const NATIVE_INFO_KEYS = ['native', 'nativeMode', 'nativePhase', 'nativeRoundTick'];

function rawMap(): NativeMap {
  // Fresh JSON data for every environment; no direct/pool fixture mutation can
  // hide the raw native map selection.
  return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as NativeMap;
}

function objectAction(bits: number): PlayerInput {
  return {
    left: (bits & 1) !== 0,
    right: (bits & 2) !== 0,
    up: (bits & 4) !== 0,
    down: (bits & 8) !== 0,
    heavy: (bits & 16) !== 0,
    grapple: (bits & 32) !== 0,
  };
}

// Arrow-family action2 (bit 5) is legal in ar/ard; VTOL keeps it clear so the
// same stream stays valid across every mode under test.
function actionAt(mode: (typeof MODES)[number], lane: number, call: number): Action {
  const stream = [0, 2, 32, 2, 0];
  const bits = stream[call % stream.length];
  const action: Action = (call + lane) % 2 === 0 ? objectAction(bits) : bits;
  if (mode === 'v') {
    // VTOL rejects bit 5; keep the same stream legal by clearing it.
    return typeof action === 'number' ? action & ~32 : { ...action, grapple: false };
  }
  return action;
}

function makeConfig(mode: (typeof MODES)[number]): EnvironmentConfig {
  return {
    mapData: rawMap(),
    nativeMode: mode,
    numOpponents: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: MAX_TICKS,
    frameSkip: 1,
    countdownTicks: 60,
    seed: BASE_SEED,
    verboseTelemetry: false,
  } as EnvironmentConfig;
}

type ReplayNode = { path: string; value: unknown };
type Replay = { nodes: ReplayNode[] };

function normalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite public value: ${value}`);
    return Math.fround(value);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalize(child)]),
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

function replayDirect(mode: (typeof MODES)[number]): Replay[] {
  const envs = Array.from(
    { length: LANES },
    (_, lane) => new BonkEnvironment({ ...makeConfig(mode), seed: BASE_SEED + lane }),
  );
  try {
    const states = envs.map((env, lane) => ({
      previousDone: false,
      nodes: [{ path: 'reset[0]', value: normalize(env.reset(BASE_SEED + lane)) }] as ReplayNode[],
    }));
    for (let call = 0; call < CALLS; call++) {
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const action = actionAt(mode, lane, call);
        const result = envs[lane].step(action);
        const hold = state.previousDone && result.done;
        addStep(state.nodes, `episode.${hold ? 'hold' : 'step'}[${call}]`, result);
        state.previousDone = result.done;
        if (result.done && !envs[lane].isTerminalHoldActive()) envs[lane].reset();
      }
    }
    return states.map(({ nodes }) => ({ nodes }));
  } finally {
    for (const env of envs) env.close();
  }
}

async function replayPool(mode: (typeof MODES)[number], useSharedMemory: boolean): Promise<Replay[]> {
  const pool = new WorkerPool(1);
  try {
    await pool.init(LANES, { ...makeConfig(mode), seed: BASE_SEED }, useSharedMemory);
    expect(pool.isUsingSharedMemory()).toBe(useSharedMemory);
    const reset = await pool.reset(Array.from({ length: LANES }, (_, lane) => BASE_SEED + lane));
    const states = reset.map((observation) => ({
      previousDone: false,
      nodes: [{ path: 'reset[0]', value: normalize(observation) }] as ReplayNode[],
    }));
    for (let call = 0; call < CALLS; call++) {
      const actions = Array.from({ length: LANES }, (_, lane) => actionAt(mode, lane, call));
      const results = (await pool.step(actions)) as StepResult[];
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const result = results[lane];
        const hold = state.previousDone && result.done;
        addStep(state.nodes, `episode.${hold ? 'hold' : 'step'}[${call}]`, result);
        state.previousDone = result.done;
      }
    }
    return states.map(({ nodes }) => ({ nodes }));
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

describe('worker-pool transport parity for explicit native room modes ar/ard/v', () => {
  beforeEach(() => {
    // Suppress only console.log; warnings/errors stay loud. The runner's
    // --silent flag covers child threads.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(MODES)(
    '%s full public graphs match direct for both transports',
    async (mode) => {
      const baseline = replayDirect(mode);
      const failures: string[] = [];
      for (const useSharedMemory of [false, true]) {
        if (useSharedMemory && !WorkerPool.isSupported()) continue;
        const actual = await replayPool(mode, useSharedMemory);
        const label = `mode=${mode} shared=${useSharedMemory}`;
        // No key filtering or missing-field fallback: native-mode info fields are
        // required public graph content, not optional transport metadata.
        for (let lane = 0; lane < LANES; lane++) {
          const count = Math.min(actual[lane].nodes.length, baseline[lane].nodes.length);
          if (actual[lane].nodes.length !== baseline[lane].nodes.length) {
            failures.push(
              `${label} lane=${lane}: graph length ${actual[lane].nodes.length} !== ${baseline[lane].nodes.length}`,
            );
          }
          for (let node = 0; node < count; node++) {
            const pathDifference = firstDifference(
              baseline[lane].nodes[node].path,
              actual[lane].nodes[node].path,
              'event',
            );
            if (pathDifference) failures.push(`${label} lane=${lane} node=${node} ${pathDifference}`);
            const difference = firstDifference(baseline[lane].nodes[node].value, actual[lane].nodes[node].value);
            if (difference) {
              failures.push(
                `${label} lane=${lane} first graph mismatch node=${node} (${baseline[lane].nodes[node].path}), ${difference}`,
              );
              break; // One reduced mismatch per lane, not thousands of full dumps.
            }
          }
        }
      }
      expect(failures).toEqual([]);
    },
    60000,
  );

  it('both transports expose identical native mode info fields', async () => {
    // Regression receipt: the message and shared transports must both carry
    // the room mode, not just the Classic 'b' default.
    for (const mode of MODES) {
      const message = await replayPool(mode, false);
      const shared = WorkerPool.isSupported() ? await replayPool(mode, true) : null;
      const messageInfo = (message[0].nodes[1].value as any).info;
      for (const key of NATIVE_INFO_KEYS) {
        expect(messageInfo).toHaveProperty(key);
        expect(messageInfo[key]).toBe(key === 'nativeMode' ? mode : messageInfo[key]);
      }
      expect(messageInfo.nativeMode).toBe(mode);
      if (shared) {
        const sharedInfo = (shared[0].nodes[1].value as any).info;
        for (const key of NATIVE_INFO_KEYS) {
          expect(sharedInfo).toHaveProperty(key, messageInfo[key]);
        }
        expect(sharedInfo.nativeMode).toBe(mode);
      }
    }
  });
});
