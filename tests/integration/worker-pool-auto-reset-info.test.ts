import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BonkEnvironment, type StepResult } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';

const boxMap: MapDef = {
  name: 'auto-reset-observability-box',
  spawnPoints: {
    team_blue: { x: -200, y: -100 },
    team_red: { x: 200, y: -100 },
  },
  bodies: [
    { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
    { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
    { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
  ],
};

const LANES = 5;
const CALLS = 7;

function nativeMap() {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'maps', 'training-platform.json'), 'utf8'));
}

function stepDirect(frameSkip: 1 | 3, mapData: MapDef | ReturnType<typeof nativeMap>, seed = 19): StepResult[] {
  const env = new BonkEnvironment({ mapData, maxTicks: 1, frameSkip, seed, randomOpponent: false });
  try {
    env.reset(seed);
    return Array.from({ length: CALLS }, () => {
      const result = env.step(0);
      if (result.done && !env.isTerminalHoldActive()) env.reset();
      // Match the pool's canonical Float32 transport precision without
      // dropping any public result or info keys.
      return JSON.parse(JSON.stringify(result), (_key, value) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.fround(value) : value,
      );
    });
  } finally {
    env.close();
  }
}

async function stepPool(
  frameSkip: 1 | 3,
  mapData: MapDef | ReturnType<typeof nativeMap>,
  workers: number,
  shared: boolean,
  ownership: 'owned' | 'borrowed',
): Promise<StepResult[][]> {
  const pool = new WorkerPool(workers);
  try {
    await pool.init(LANES, { mapData, maxTicks: 1, frameSkip, seed: 19, randomOpponent: false }, shared);
    expect(pool.isUsingSharedMemory()).toBe(shared);
    await pool.reset(Array.from({ length: LANES }, (_, lane) => 19 + lane));
    const steps: StepResult[][] = [];
    for (let call = 0; call < CALLS; call++) {
      const results = (await pool.step(new Array(LANES).fill(0), { ownership })) as StepResult[];
      steps.push(results.map((result) => structuredClone(result)));
    }

    // Reset consumes/overwrites the seed words used as step metadata. Repeated
    // resets and steps must not leak a previous batch's boundary flags.
    await pool.reset([91]);
    await pool.reset(Array.from({ length: LANES }, (_, lane) => 19 + lane));
    const afterReset = (await pool.step(new Array(LANES).fill(0), { ownership })) as StepResult[];
    steps.push(afterReset.map((result) => structuredClone(result)));
    return steps;
  } finally {
    await pool.close();
  }
}

function boundarySummary(results: StepResult[]) {
  return results.map((result) => ({
    observationTick: result.observation.tick,
    reward: result.reward,
    done: result.done,
    truncated: result.truncated,
    terminated: result.terminated,
    infoTick: result.info.tick,
    infoTerminated: result.info.terminated,
    autoResetAfter: result.info.autoResetAfter,
  }));
}

describe('authoritative pooled auto-reset observability', () => {
  it.each([false, true])(
    'legacy maxTicks=1 exposes the actual reset boundary (shared=%s)',
    async (shared) => {
      if (shared && !WorkerPool.isSupported()) return;
      const direct: Record<number, ReturnType<typeof boundarySummary>> = {};
      for (const frameSkip of [1, 3] as const) {
        const results = stepDirect(frameSkip, boxMap);
        direct[frameSkip] = boundarySummary(results);
        expect(results.map((result) => result.info.autoResetAfter)).toEqual(
          frameSkip === 1
            ? [true, true, true, true, true, true, true]
            : [false, false, true, false, false, true, false],
        );
        // maxTicks=1 still makes the old public result fields look identical;
        // only the new authoritative flag distinguishes the hold cadence.
        expect(
          results.map((result) => [result.observation.tick, result.done, result.truncated, result.info.tick]),
        ).toEqual(Array.from({ length: CALLS }, () => [1, true, true, 1]));
      }

      for (const workers of [1, 2, 4]) {
        for (const ownership of ['owned', 'borrowed'] as const) {
          for (const frameSkip of [1, 3] as const) {
            const steps = await stepPool(frameSkip, boxMap, workers, shared, ownership);
            for (let call = 0; call < steps.length; call++) {
              for (let lane = 0; lane < LANES; lane++) {
                const result = steps[call][lane];
                expect(typeof result.info.autoResetAfter).toBe('boolean');
                expect(result.info.autoResetAfter).toBe(direct[frameSkip][call % CALLS].autoResetAfter);
                expect(boundarySummary([result])[0]).toEqual(direct[frameSkip][call % CALLS]);
              }
            }
          }
        }
      }
    },
    30000,
  );

  it.each([false, true])(
    'native full results retain direct parity across an explicit reset (shared=%s)',
    async (shared) => {
      if (shared && !WorkerPool.isSupported()) return;
      const direct: Record<number, StepResult[][]> = {};
      for (const frameSkip of [1, 3] as const) {
        direct[frameSkip] = Array.from({ length: LANES }, (_, lane) => stepDirect(frameSkip, nativeMap(), 19 + lane));
      }

      for (const workers of [1, 2, 4]) {
        for (const frameSkip of [1, 3] as const) {
          const steps = await stepPool(frameSkip, nativeMap(), workers, shared, 'owned');
          for (let call = 0; call < steps.length; call++) {
            for (let lane = 0; lane < LANES; lane++) {
              expect(steps[call][lane]).toEqual(direct[frameSkip][lane][call % CALLS]);
            }
          }
        }
      }
    },
    30000,
  );
});
