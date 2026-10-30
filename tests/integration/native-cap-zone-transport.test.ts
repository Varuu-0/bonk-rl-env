/**
 * Full native dynamic-info transport coverage for authored capture zones.
 * Direct/public results are the oracle; every transport/result key is compared.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BonkEnvironment, type EnvironmentConfig, type StepResult } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';
import type { PlayerInput } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';
import { SHARED_INFO_FLOATS_PER_ENV, SharedMemoryManager } from '../../src/ipc/shared-memory';
import {
  NATIVE_CAP_ZONE_FIELDS,
  decodeNativePhase,
  encodeNativePhase,
  sharedInfoFloatsPerEnv,
} from '../../src/ipc/native-info-codec';

// Canonical scenario data from validation/native/compare-dynamic-classic-native.cjs.
// Reproduce only its fixture builder here: requiring that CommonJS oracle from
// Vitest would also require its standalone native-oracle TypeScript loader.
function scenario(name: ScenarioName): NativeMap {
  const fixtureShape = (sh: number) => ({
    sh,
    n: `f${sh}`,
    fr: null,
    fp: null,
    re: null,
    de: null,
    f: 0xabcdef,
    d: false,
    np: false,
    ng: false,
    ig: false,
  });
  const box = (c: [number, number], w: number, h: number) => ({ type: 'bx' as const, c, a: 0, w, h, sk: false });
  const body = (type: 's' | 'k' | 'd', p: [number, number], fx: number[], extra: Record<string, unknown> = {}) => ({
    s: {
      type,
      n: `b${fx[0]}`,
      fric: 0.5,
      fricp: false,
      re: 0.2,
      de: 1,
      ld: 0,
      ad: 0,
      fr: false,
      bu: false,
      f_c: 1,
      f_p: true,
      f_1: true,
      f_2: true,
      f_3: true,
      f_4: true,
    },
    p,
    a: 0,
    lv: [0, 0] as [number, number],
    av: 0,
    cf: { x: 0, y: 0, ct: 0, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    fx,
    ...extra,
  });
  const spawn = (x: number, y: number, n: string) => ({
    x,
    y,
    xv: 0,
    yv: 0,
    priority: 1,
    r: true,
    f: true,
    b: true,
    gr: false,
    ye: false,
    n,
  });
  const map = {
    v: 15,
    s: { re: false, nc: false, fl: false, pq: 1, gd: 25 },
    physics: { ppm: 10, shapes: [], fixtures: [], bodies: [], joints: [], bro: [] },
    spawns: [],
    capZones: [],
    m: { ...METADATA },
  } as unknown as NativeMap;
  const physics = map.physics;
  if (name === 'moving-platform') {
    physics.shapes.push(box([0, 0], 400, 20));
    physics.fixtures.push(fixtureShape(0));
    physics.bodies.push(body('k', [0, 0], [0], { lv: [10, 0] }));
    map.spawns.push(spawn(-50, -30, 'left'), spawn(50, -30, 'right'));
  } else if (name === 'timed-capture') {
    physics.shapes.push(box([0, 0], 400, 400), box([-300, 0], 100, 20));
    physics.fixtures.push(fixtureShape(0), fixtureShape(1));
    physics.bodies.push(body('s', [0, 0], [0, 1]));
    map.spawns.push(spawn(0, -100, 'owner'), spawn(-300, -100, 'other'));
    map.capZones.push({ n: 'timed', ty: 1, l: 1, i: 0 });
    map.s.fl = true;
    map.s.re = true;
  } else {
    physics.shapes.push(box([0, 0], 100, 10), box([0, 0], 10, 10), box([-250, 0], 100, 20));
    physics.fixtures.push(fixtureShape(0), fixtureShape(1), fixtureShape(2));
    physics.bodies.push(body('s', [0, 0], [0, 2]), body('d', [0, -10], [1]));
    map.spawns.push(spawn(-100, -100, 'loser'), spawn(-250, -30, 'winner'));
    map.capZones.push({ n: 'goal', ty: 2, l: 10, i: 0 });
    map.s.re = true;
  }
  physics.bro = physics.bodies.map((_, index) => index);
  return map;
}
const METADATA = (
  JSON.parse(readFileSync(path.join(process.cwd(), 'maps/training-platform.json'), 'utf8')) as NativeMap
).m;
const LANES = 5;
const CALLS = 148;
const SEED = 23;
const INTEGER_FIELDS = new Set(['tick', 'nativeRoundTick', 'opponentsAlive', 'scoreBlue', 'scoreRed', 'index', 'type']);

type ScenarioName = 'moving-platform' | 'timed-capture' | 'instant-goal';
type Node = { path: string; value: unknown };
type Coverage = {
  zones: number;
  phases: string[];
  changingCaptures: number;
  terminalHolds: number;
  explicitResets: number;
};
type Replay = { nodes: Node[]; coverage: Coverage };

function fixture(name: ScenarioName, zoneCount: number): NativeMap {
  const map = scenario(name);
  // scenario() is also consumed by the standalone native differential, whose
  // minimal metadata predates the strict public JSON loader. Fill only the
  // required public metadata; physics, spawns and authored zones stay canonical.
  map.m = { ...METADATA };
  if (name === 'instant-goal' && zoneCount === 2) {
    // Keep the second sensor at its own dynamic fixture/body origin rather
    // than aliasing the first fixture. This is an authored two-zone map.
    map.capZones.push({ ...map.capZones[0], n: 'second-goal', i: 1 });
  }
  if (map.capZones.length !== zoneCount) throw new Error(`Fixture ${name} did not produce ${zoneCount} zones`);
  return map;
}

function config(name: ScenarioName, zoneCount: number, frameSkip: 1 | 3): EnvironmentConfig {
  return {
    mapData: fixture(name, zoneCount),
    numOpponents: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: 400,
    frameSkip,
    verboseTelemetry: false,
  } as EnvironmentConfig;
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

function action(lane: number, call: number): PlayerInput | number {
  const bits = lane % 2 === 0 ? 0 : call % 3 === 0 ? 4 : 0;
  return (lane + call) % 2 === 0 ? bits : objectAction(bits);
}

function normalize(value: unknown, key = ''): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite value at ${key}`);
    return INTEGER_FIELDS.has(key) ? value : Math.fround(value);
  }
  if (Array.isArray(value)) return value.map((child, index) => normalize(child, `${key}[${index}]`));
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

function addResult(nodes: Node[], path: string, result: StepResult): void {
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

function recordCapture(coverage: Coverage, result: StepResult, previousDone: boolean): void {
  const zones = result.info.nativeCapZones;
  expect(Array.isArray(zones)).toBe(true);
  coverage.zones = zones.length;
  if (!coverage.phases.includes(result.info.nativePhase)) coverage.phases.push(result.info.nativePhase);
  const serialized = JSON.stringify(zones);
  if (serialized !== (coverage as any).lastCapture) {
    if ((coverage as any).lastCapture !== undefined) coverage.changingCaptures++;
    (coverage as any).lastCapture = serialized;
  }
  if (previousDone && result.done) coverage.terminalHolds++;
  for (const zone of zones) expect(Object.keys(zone).sort()).toEqual([...NATIVE_CAP_ZONE_FIELDS].sort());
}

function newCoverage(): Coverage {
  return { zones: 0, phases: [], changingCaptures: 0, terminalHolds: 0, explicitResets: 1 };
}

function replayDirect(name: ScenarioName, zoneCount: number, frameSkip: 1 | 3): Replay[] {
  const envs = Array.from(
    { length: LANES },
    (_, lane) => new BonkEnvironment({ ...config(name, zoneCount, frameSkip), seed: SEED + lane }),
  );
  try {
    const states = envs.map((env, lane) => ({
      previousDone: false,
      coverage: newCoverage(),
      nodes: [{ path: 'reset[0]', value: normalize(env.reset(SEED + lane)) }] as Node[],
    }));
    for (let call = 0; call < CALLS; call++) {
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        const result = envs[lane].step(action(lane, call));
        addResult(state.nodes, `call[${call}]`, result);
        recordCapture(state.coverage, result, state.previousDone);
        state.previousDone = result.done;
        if (result.done && !envs[lane].isTerminalHoldActive()) envs[lane].reset();
      }
    }
    // Exercise an explicit reset after terminal/hold/restart results too.
    for (let lane = 0; lane < LANES; lane++) {
      states[lane].nodes.push({ path: 'reset[explicit]', value: normalize(envs[lane].reset(SEED + lane)) });
      states[lane].coverage.explicitResets++;
    }
    return states.map(({ nodes, coverage }) => ({ nodes, coverage }));
  } finally {
    for (const env of envs) env.close();
  }
}

async function replayPool(
  name: ScenarioName,
  zoneCount: number,
  frameSkip: 1 | 3,
  workers: number,
  shared: boolean,
): Promise<Replay[]> {
  const pool = new WorkerPool(workers);
  try {
    await pool.init(LANES, { ...config(name, zoneCount, frameSkip), seed: SEED }, shared);
    const initial = await pool.reset(Array.from({ length: LANES }, (_, lane) => SEED + lane));
    const states = initial.map((observation) => ({
      previousDone: false,
      coverage: newCoverage(),
      nodes: [{ path: 'reset[0]', value: normalize(observation) }] as Node[],
    }));
    for (let call = 0; call < CALLS; call++) {
      const results = (await pool.step(Array.from({ length: LANES }, (_, lane) => action(lane, call)))) as StepResult[];
      for (let lane = 0; lane < LANES; lane++) {
        const state = states[lane];
        addResult(state.nodes, `call[${call}]`, results[lane]);
        recordCapture(state.coverage, results[lane], state.previousDone);
        state.previousDone = results[lane].done;
      }
    }
    const reset = await pool.reset(Array.from({ length: LANES }, (_, lane) => SEED + lane));
    for (let lane = 0; lane < LANES; lane++) {
      states[lane].nodes.push({ path: 'reset[explicit]', value: normalize(reset[lane]) });
      states[lane].coverage.explicitResets++;
    }
    return states.map(({ nodes, coverage }) => ({ nodes, coverage }));
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
  )
    return `${path}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`;
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (!(key in left) || !(key in right)) {
      return `${path}.${key}: expected=${key in left ? JSON.stringify(left[key]) : '<missing>'}, actual=${key in right ? JSON.stringify(right[key]) : '<missing>'}`;
    }
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function compare(actual: Replay, expected: Replay, label: string): string[] {
  const failures: string[] = [];
  const count = Math.min(actual.nodes.length, expected.nodes.length);
  if (actual.nodes.length !== expected.nodes.length) failures.push(`${label}: node count differs`);
  for (let index = 0; index < count; index++) {
    const difference = firstDifference(expected.nodes[index].value, actual.nodes[index].value);
    if (difference) {
      failures.push(`${label}: node=${index} ${expected.nodes[index].path}: ${difference}`);
      break;
    }
  }
  const coverage = firstDifference(expected.coverage, actual.coverage, 'coverage');
  if (coverage) failures.push(`${label}: ${coverage}`);
  return failures;
}

describe('native capture shared-memory layout', () => {
  it('retains the zero-zone layout and isolates authored records by lane', () => {
    const legacy = new SharedMemoryManager(2, 16);
    const capture = new SharedMemoryManager(2, 16, undefined, 1, 2);
    const reopened = new SharedMemoryManager(2, 16, capture.getBuffer(), 1, 2);
    try {
      expect(legacy.getBuffer().byteLength).toBe(SharedMemoryManager.calculateBufferSize(2, 16));
      expect(legacy.getInfoFloats()).toBe(7);
      expect(capture.getBuffer().byteLength).toBe(SharedMemoryManager.calculateBufferSize(2, 16, 1, 2));
      expect(capture.getInfoFloats()).toBe(sharedInfoFloatsPerEnv(2));
      expect(capture.getBuffer().byteLength - legacy.getBuffer().byteLength).toBe(2 * 2 * 7 * 4);
      capture.writeInfo(0, [1, 1, 2, 3, 1, 101, 2]);
      capture.writeNativeCapZones(0, [
        { ty: 1, p: 0.1, l: 30, i: 0, o: -1, ot: -1, f: -1 },
        { ty: 2, p: 0.2, l: 300, i: 1, o: 2, ot: 2, f: 20 },
      ]);
      capture.writeInfo(1, [0, 1, 4, 5, 1, 202, 3]);
      capture.writeNativeCapZones(1, [
        { ty: 3, p: 0.3, l: 40, i: 2, o: 3, ot: 3, f: 4 },
        { ty: 4, p: 0.4, l: 50, i: 3, o: 4, ot: 4, f: 5 },
      ]);
      const info = reopened.readResults().info;
      expect(Array.from(info.subarray(0, capture.getInfoFloats()))).toEqual([
        1,
        1,
        2,
        3,
        1,
        101,
        2,
        1,
        Math.fround(0.1),
        30,
        0,
        -1,
        -1,
        -1,
        2,
        Math.fround(0.2),
        300,
        1,
        2,
        2,
        20,
      ]);
      expect(Array.from(info.subarray(capture.getInfoFloats(), 2 * capture.getInfoFloats()))).toEqual([
        0,
        1,
        4,
        5,
        1,
        202,
        3,
        3,
        Math.fround(0.3),
        40,
        2,
        3,
        3,
        4,
        4,
        Math.fround(0.4),
        50,
        3,
        4,
        4,
        5,
      ]);
      reopened.writeInfo(0, [1, 0, 6, 7, 1, 303, 4]);
      expect(
        Array.from(info.subarray(capture.getInfoFloats(), capture.getInfoFloats() + SHARED_INFO_FLOATS_PER_ENV)),
      ).toEqual([0, 1, 4, 5, 1, 202, 3]);
      expect(() => capture.writeNativeCapZones(0, [])).toThrow('expected 2 native cap zones');
      expect(() =>
        capture.writeNativeCapZones(0, [{ ty: 1 }, { ty: 2, p: 0, l: 1, i: 1, o: -1, ot: -1, f: -1 }]),
      ).toThrow('exactly');
      expect(() => new SharedMemoryManager(2, 16, legacy.getBuffer(), 1, 2)).toThrow('incompatible buffer size');
    } finally {
      reopened.dispose();
      capture.dispose();
      legacy.dispose();
    }
  });

  it('round-trips every native phase and rejects unknown values', () => {
    for (const phase of ['countdown', 'active', 'round-result', 'match-result'] as const) {
      expect(decodeNativePhase(encodeNativePhase(phase))).toBe(phase);
    }
    expect(() => encodeNativePhase('approximation')).toThrow('unsupported nativePhase');
    expect(() => decodeNativePhase(0)).toThrow('unsupported nativePhase code');
    expect(() => sharedInfoFloatsPerEnv(-1)).toThrow('nonnegative safe integer');
  });
});

describe('raw dynamic Classic nativeCapZones full replay', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['moving-platform', 0],
    ['timed-capture', 1],
    ['instant-goal', 2],
  ] as const)(
    '%s with %i zones matches every direct result for FS1/3, both transports and 1/2/4 workers',
    async (name, zoneCount) => {
      const failures: string[] = [];
      for (const frameSkip of [1, 3] as const) {
        const expected = replayDirect(name, zoneCount, frameSkip);
        expect(expected[0].coverage.zones).toBe(zoneCount);
        expect(expected[0].coverage.phases).toContain('countdown');
        if (zoneCount > 0) expect(expected[0].coverage.phases).toContain('round-result');
        expect(expected[0].coverage.phases).toContain('active');
        if (zoneCount === 1) {
          expect(expected[0].coverage.phases).toContain('active');
          expect(expected[0].coverage.changingCaptures).toBeGreaterThan(20);
        }
        if (frameSkip === 3 && zoneCount > 0) expect(expected[0].coverage.terminalHolds).toBeGreaterThan(0);
        for (const shared of [false, true]) {
          if (shared && !WorkerPool.isSupported()) continue;
          for (const workers of [1, 2, 4]) {
            const actual = await replayPool(name, zoneCount, frameSkip, workers, shared);
            for (let lane = 0; lane < LANES; lane++) {
              failures.push(
                ...compare(
                  actual[lane],
                  expected[lane],
                  `${name} FS${frameSkip} shared=${shared} workers=${workers} lane=${lane}`,
                ),
              );
            }
          }
        }
      }
      expect(failures).toEqual([]);
    },
    60000,
  );

  it('reuses capture objects only for borrowed results and deep-copies owned results', async () => {
    if (!WorkerPool.isSupported()) return;
    const pool = new WorkerPool(2);
    try {
      await pool.init(LANES, { ...config('timed-capture', 1, 1), seed: SEED }, true);
      await pool.reset(Array.from({ length: LANES }, (_, lane) => SEED + lane));
      const first = await pool.step(
        Array.from({ length: LANES }, () => 0),
        { ownership: 'borrowed' },
      );
      const firstZones = first.map((result: StepResult) => result.info.nativeCapZones);
      const firstZoneObjects = firstZones.map((zones: any[]) => zones[0]);
      expect(new Set(firstZones).size).toBe(LANES);
      expect(new Set(firstZoneObjects).size).toBe(LANES);
      const second = await pool.step(
        Array.from({ length: LANES }, () => 0),
        { ownership: 'borrowed' },
      );
      for (let lane = 0; lane < LANES; lane++) {
        expect(second[lane].info.nativeCapZones).toBe(firstZones[lane]);
        expect(second[lane].info.nativeCapZones[0]).toBe(firstZoneObjects[lane]);
        expect(second[lane].info.nativeCapZones[0]).not.toBe(firstZones[(lane + 1) % LANES][0]);
      }
      const owned = await pool.step(Array.from({ length: LANES }, () => 0));
      const ownedSnapshot = structuredClone(owned);
      await pool.step(
        Array.from({ length: LANES }, () => 0),
        { ownership: 'borrowed' },
      );
      expect(owned).toEqual(ownedSnapshot);
      for (let lane = 0; lane < LANES; lane++) {
        expect(owned[lane].info.nativeCapZones).not.toBe(firstZones[lane]);
        expect(owned[lane].info.nativeCapZones[0]).not.toBe(firstZoneObjects[lane]);
      }
    } finally {
      await pool.close();
    }
  });
});
