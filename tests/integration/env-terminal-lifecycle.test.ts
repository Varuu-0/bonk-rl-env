/**
 * env-terminal-lifecycle.test.ts — Regression coverage for issues #197,
 * #222 and #228, which share the environment's terminal state machine:
 *
 *   #197 — A maxTicks-truncated (or death-terminated) episode must settle:
 *          after done, the environment keeps reporting the recorded terminal
 *          cause (never inverted) and never advances physics until an
 *          explicit reset().
 *   #222 — The terminal step result must be internally consistent:
 *          observation.tick === info.tick on the done step in both
 *          transports (it was always 0 before — the post-auto-reset fresh
 *          episode — while info.tick reported the ended episode's tick).
 *   #228 — With frameSkip > 1 the terminal done result must be held for the
 *          remainder of the frame-skip cycle before the worker auto-resets,
 *          so the caller's action cycle stays aligned and a fresh episode
 *          only appears after the cycle boundary. Covered at every cycle
 *          alignment: episode ending at the cycle start, mid-cycle, and
 *          exactly on the boundary (maxTicks % frameSkip === 0).
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

const lethalMap: MapDef = {
  name: 'terminal-lifecycle-lethal',
  spawnPoints: { team_blue: { x: 0, y: -300 }, team_red: { x: 200, y: -100 } },
  bodies: [
    { name: 'lethal', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true, isLethal: true },
  ],
};

// Spawns the AI beyond the 850-unit death circle, so it dies on the very
// first tick (the position used by worker-pool-termination-flags.test.ts).
const deathAtTickOneMap: MapDef = {
  name: 'death_at_tick_one',
  spawnPoints: { team_blue: { x: 900, y: 0 }, team_red: { x: 200, y: -100 } },
  bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
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

      const first = env.step(0);
      expect(first.done).toBe(false);
      expect('terminal_observation' in first.info).toBe(false);

      const second = env.step(0);
      expect(second.done).toBe(false);
      expect('terminal_observation' in second.info).toBe(false);

      // tick 3 = maxTicks: truncation reported exactly once with the correct
      // cause (truncated, never terminated).
      const done = env.step(0);
      expect(done.done).toBe(true);
      expect(done.truncated).toBe(true);
      expect(done.info.terminated).toBe(false);
      expect(done.observation.tick).toBe(3);
      expect(done.info.tick).toBe(3);
      expect(done.info.terminal_observation).toEqual(done.observation);
      expect(done.info.terminal_observation.tick).toBe(done.info.tick);

      // Well past maxTicks: the episode stays settled — same flags, no
      // physics advance, no step ever inverts truncation into termination.
      for (let i = 0; i < 12; i++) {
        const res = env.step(0);
        expect(res.done).toBe(true);
        expect(res.truncated).toBe(true);
        expect(res.info.terminated).toBe(false);
        expect(res.observation.tick).toBe(3);
        expect(res.info.tick).toBe(3);
        expect(res.info.terminal_observation).toEqual(res.observation);
        expect(res.info.terminal_observation.tick).toBe(res.info.tick);
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

  it('direct environment replays a death termination without inverting it into a truncation', () => {
    const env = new BonkEnvironment({
      mapData: lethalMap,
      maxTicks: 400,
      frameSkip: 4,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      env.reset(42);

      let death: ReturnType<typeof env.step> | null = null;
      for (let i = 0; i < 300; i++) {
        const res = env.step(0);
        if (res.done) {
          death = res;
          break;
        }
      }
      expect(death).not.toBeNull();
      expect(death!.truncated).toBe(false);
      expect(death!.info.terminated).toBe(true);
      const deathTick = death!.info.tick;
      expect(death!.info.terminal_observation).toEqual(death!.observation);
      expect(death!.info.terminal_observation.tick).toBe(deathTick);

      // Forward from the death: the tail must keep replaying the recorded
      // death cause (truncated=false / terminated=true) with the tick frozen
      // — never inverting the termination into a truncation and never
      // advancing physics past the death tick.
      for (let i = 0; i < 12; i++) {
        const res = env.step(0);
        expect(res.done).toBe(true);
        expect(res.truncated).toBe(false);
        expect(res.info.terminated).toBe(true);
        expect(res.info.tick).toBe(deathTick);
        expect(res.observation.tick).toBe(deathTick);
        expect(res.info.terminal_observation).toEqual(res.observation);
        expect(res.info.terminal_observation.tick).toBe(res.info.tick);
        expect(res.reward).toBe(0);
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

  // The hold serves the remainder of the current action cycle, so its
  // length depends on where in the cycle the episode ends. These two cases
  // pin the alignment semantics: mid-cycle truncation holds for the rest of
  // the cycle, boundary-aligned truncation holds only its own step.
  const runMidCycleTruncation = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      // maxTicks=6 lands on tick 6, the second tick of the 5-8 cycle, so
      // the hold covers ticks 6-8 (3 done steps) before the cycle boundary.
      await pool.init(
        1,
        { mapData: boxMap, maxTicks: 6, frameSkip: 4, numOpponents: 0, randomOpponent: false },
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

      for (let i = 0; i < 5; i++) {
        expect(steps[i].done).toBe(false);
        expect(steps[i].obsTick).toBe(i + 1);
        expect(steps[i].infoTick).toBe(i + 1);
      }
      for (let i = 5; i < 8; i++) {
        expect(steps[i].done).toBe(true);
        expect(steps[i].truncated).toBe(true);
        expect(steps[i].obsTick).toBe(6);
        expect(steps[i].infoTick).toBe(6);
      }
      expect(steps[8].done).toBe(false);
      expect(steps[8].obsTick).toBe(1);
      expect(steps[8].infoTick).toBe(1);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode holds a mid-cycle truncation until the cycle boundary', async () => {
    if (!WorkerPool.isSupported()) return;
    await runMidCycleTruncation(true);
  });

  it('message-passing mode holds a mid-cycle truncation until the cycle boundary', async () => {
    await runMidCycleTruncation(false);
  });

  const runBoundaryAlignedTruncation = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      // maxTicks=4 is a multiple of frameSkip, so the episode ends exactly
      // on the cycle boundary: the hold window contains only the terminal
      // step itself, and the fresh episode starts at the next boundary.
      await pool.init(
        1,
        { mapData: boxMap, maxTicks: 4, frameSkip: 4, numOpponents: 0, randomOpponent: false },
        useSharedMemory,
      );
      await pool.reset([1]);

      const steps: Array<{ done: boolean; truncated: boolean; infoTick: number; obsTick: number }> = [];
      for (let i = 1; i <= 6; i++) {
        const [res] = await pool.step([0]);
        steps.push({
          done: res.done,
          truncated: res.truncated,
          infoTick: res.info.tick,
          obsTick: res.observation.tick,
        });
      }

      for (let i = 0; i < 3; i++) {
        expect(steps[i].done).toBe(false);
        expect(steps[i].obsTick).toBe(i + 1);
        expect(steps[i].infoTick).toBe(i + 1);
      }
      expect(steps[3].done).toBe(true);
      expect(steps[3].truncated).toBe(true);
      expect(steps[3].obsTick).toBe(4);
      expect(steps[3].infoTick).toBe(4);
      expect(steps[4].done).toBe(false);
      expect(steps[4].obsTick).toBe(1);
      expect(steps[4].infoTick).toBe(1);
      expect(steps[5].done).toBe(false);
      expect(steps[5].obsTick).toBe(2);
      expect(steps[5].infoTick).toBe(2);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode emits a single done for a boundary-aligned truncation', async () => {
    if (!WorkerPool.isSupported()) return;
    await runBoundaryAlignedTruncation(true);
  });

  it('message-passing mode emits a single done for a boundary-aligned truncation', async () => {
    await runBoundaryAlignedTruncation(false);
  });

  const runDeathHold = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(
        1,
        { mapData: deathAtTickOneMap, maxTicks: 100, frameSkip: 4, numOpponents: 1 },
        useSharedMemory,
      );
      await pool.reset([42]);

      // The AI dies on tick 1 of every episode, so every cycle reports 4
      // terminal steps (death + 3 hold). The death cause must be replayed —
      // terminated=true, truncated=false — and observation/info must stay
      // aligned on each done step. 8 steps = two full death cycles.
      for (let i = 1; i <= 8; i++) {
        const [res] = await pool.step([0]);
        expect(res.done).toBe(true);
        expect(res.truncated).toBe(false);
        expect(res.terminated).toBe(true);
        expect(res.info.terminated).toBe(true);
        expect(res.info.tick).toBe(1);
        expect(res.observation.tick).toBe(1);
      }
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode replays a death termination through the hold without inversion', async () => {
    if (!WorkerPool.isSupported()) return;
    await runDeathHold(true);
  });

  it('message-passing mode replays a death termination through the hold without inversion', async () => {
    await runDeathHold(false);
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
