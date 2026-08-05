/**
 * env-terminal-lifecycle.test.ts — Regression coverage for issues #197,
 * #222 and #228, which share the environment's terminal state machine:
 *
 *   #197 — A maxTicks-truncated episode must settle: after done, the
 *          environment keeps reporting the recorded terminal cause
 *          (truncated=true / info.terminated=false) and never advances
 *          physics past maxTicks until an explicit reset().
 *   #222 — The terminal step result must be internally consistent:
 *          observation.tick === info.tick on the done step in both
 *          transports (it was always 0 before — the post-auto-reset fresh
 *          episode — while info.tick reported the ended episode's tick).
 *   #228 — With frameSkip > 1 the terminal done result must be held for the
 *          full frame-skip window before the worker auto-resets, so the
 *          caller's action cycle stays aligned and a fresh episode only
 *          appears after the cycle boundary.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { WorkerPool } from '../../src/core/worker-pool';
import type { MapDef } from '../../src/core/physics-engine';

const boxMap: MapDef = {
  name: 'terminal-lifecycle-box',
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

describe('maxTicks-truncated episodes settle (issue #197)', () => {
  it('direct environment freezes at maxTicks with stable flags until reset', () => {
    const env = new BonkEnvironment({
      mapData: boxMap,
      maxTicks: 3,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      env.reset(42);

      expect(env.step(0).done).toBe(false);
      expect(env.step(0).done).toBe(false);

      // tick 3 = maxTicks: truncation reported exactly once with the correct
      // cause (truncated, never terminated).
      const done = env.step(0);
      expect(done.done).toBe(true);
      expect(done.truncated).toBe(true);
      expect(done.info.terminated).toBe(false);
      expect(done.observation.tick).toBe(3);
      expect(done.info.tick).toBe(3);

      // Well past maxTicks: the episode stays settled — same flags, no
      // physics advance, no step ever inverts truncation into termination.
      for (let i = 0; i < 12; i++) {
        const res = env.step(0);
        expect(res.done).toBe(true);
        expect(res.truncated).toBe(true);
        expect(res.info.terminated).toBe(false);
        expect(res.observation.tick).toBe(3);
        expect(res.info.tick).toBe(3);
        expect(res.reward).toBe(0);
      }

      // An explicit reset ends the terminal state.
      env.reset(42);
      const fresh = env.step(0);
      expect(fresh.done).toBe(false);
      expect(fresh.observation.tick).toBe(1);
    } finally {
      env.close();
    }
  });

  it('direct environment settles with frameSkip > 1 after the hold window', () => {
    const env = new BonkEnvironment({
      mapData: boxMap,
      maxTicks: 5,
      frameSkip: 4,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      env.reset(42);

      const observed: Array<{ step: number; done: boolean; truncated: boolean; terminated: boolean; tick: number }> = [];
      for (let i = 1; i <= 20; i++) {
        const res = env.step(0);
        observed.push({
          step: i,
          done: res.done,
          truncated: res.truncated,
          terminated: res.info.terminated,
          tick: res.info.tick,
        });
      }

      // Steps 1-4 run; step 5 ends (truncated); steps 6-8 hold; steps 9+
      // stay idle — the flags and tick never change and never invert.
      for (const o of observed) {
        if (o.step <= 4) {
          expect(o.done).toBe(false);
        } else {
          expect(o.done).toBe(true);
          expect(o.truncated).toBe(true);
          expect(o.terminated).toBe(false);
          expect(o.tick).toBe(5);
        }
      }
    } finally {
      env.close();
    }
  });
});

describe('frame_skip terminal hold survives auto-reset (issue #228)', () => {
  const runHold = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(
        1,
        { mapData: boxMap, maxTicks: 5, frameSkip: 4, numOpponents: 0, randomOpponent: false },
        useSharedMemory,
      );
      await pool.reset([1]);

      const steps: Array<{ done: boolean; truncated: boolean; infoTick: number; obsTick: number }> = [];
      for (let i = 1; i <= 9; i++) {
        const [res] = await pool.step([0]);
        steps.push({
          done: res.done,
          truncated: res.truncated,
          infoTick: res.info.tick,
          obsTick: res.observation.tick,
        });
      }

      // Steps 1-4 run; step 5 ends (truncated); steps 6-8 hold the done
      // result for the rest of the frame-skip window; step 9 is the fresh
      // episode's first tick. The terminal observation is never silently
      // dropped by the pool's auto-reset.
      for (let i = 0; i < 4; i++) {
        expect(steps[i].done).toBe(false);
        expect(steps[i].obsTick).toBe(i + 1);
        expect(steps[i].infoTick).toBe(i + 1);
      }
      for (let i = 4; i < 8; i++) {
        expect(steps[i].done).toBe(true);
        expect(steps[i].truncated).toBe(true);
        expect(steps[i].obsTick).toBe(5);
        expect(steps[i].infoTick).toBe(5);
      }
      expect(steps[8].done).toBe(false);
      expect(steps[8].obsTick).toBe(1);
      expect(steps[8].infoTick).toBe(1);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode reports the full terminal hold before auto-reset', async () => {
    if (!WorkerPool.isSupported()) return;
    await runHold(true);
  });

  it('message-passing mode reports the full terminal hold before auto-reset', async () => {
    await runHold(false);
  });
});

describe('terminal-step observation tick matches info tick (issue #222)', () => {
  const runParity = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(
        1,
        { mapData: boxMap, maxTicks: 3, numOpponents: 0, randomOpponent: false },
        useSharedMemory,
      );
      await pool.reset([1]);

      let steps = 0;
      let doneResult: any = null;
      for (let i = 1; i <= 10; i++) {
        const [res] = await pool.step([0]);
        steps = i;
        // The invariant holds on every step, terminal included: observation
        // and info describe the same state/transition.
        expect(res.observation.tick).toBe(res.info.tick);
        if (res.done) {
          doneResult = res;
          break;
        }
      }

      expect(doneResult).not.toBeNull();
      expect(steps).toBe(3);
      expect(doneResult.info.tick).toBe(3);
      expect(doneResult.observation.tick).toBe(3);
      expect(doneResult.info.terminal_observation.tick).toBe(3);

      // The next step is the fresh episode, again internally consistent.
      const [fresh] = await pool.step([0]);
      expect(fresh.done).toBe(false);
      expect(fresh.observation.tick).toBe(1);
      expect(fresh.info.tick).toBe(1);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: observation.tick === info.tick on the terminal step', async () => {
    if (!WorkerPool.isSupported()) return;
    await runParity(true);
  });

  it('message-passing mode: observation.tick === info.tick on the terminal step', async () => {
    await runParity(false);
  });
});