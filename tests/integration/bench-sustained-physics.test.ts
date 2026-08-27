/**
 * bench-sustained-physics.test.ts — Regression coverage for issues #421/#461.
 *
 * The native benchmarks (layer3/layer5/layer6) originally stepped a
 * BonkEnvironment while ignoring `done`: once an episode ends the
 * environment settles into a terminal state that replays its recorded
 * result with zero physics work until an explicit reset() (#197), so
 * ~95-99% of a long measurement loop never touched Box2D and reported
 * SPS was fiction up to ~300x above sustained physics throughput.
 *
 * These tests pin the fix's invariants on the real environment using the
 * bench loop shape (default-style config, long horizon, warmup + measured
 * window):
 *
 *   - an ignored-done loop provably freezes on the terminal tick (the
 *     defect any future benchmark regression would reintroduce);
 *   - the stepLive() measurement loop keeps every counted step on the
 *     physics path: info.tick strictly advances between consecutive
 *     measured steps except across an episode restart;
 *   - every done report produces exactly one reset (zero unhandled
 *     terminal results), for truncation and natural-death endings;
 *   - with frameSkip > 1 the terminal-hold replay steps are excluded from
 *     the live count instead of diluting the measurement.
 *
 * The #461 variant pins the layer5 reset-cycles loop specifically: that
 * loop calls an explicit env.reset() at the top of every fixed window, and
 * the outer reset hid mid-window freezes from any per-cycle accounting —
 * a raw loop still spent the post-death tail of each window replaying the
 * settled terminal result. The fixed shape must provably start every
 * window on the physics path (first stepLive returns tick 1, live) and
 * keep every counted step on the physics path across all windows.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';
import { stepLive } from '../../src/utils/bench-report';

const boxMap: MapDef = {
  name: 'bench-sustained-box',
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

// Spawns the AI above a lethal floor so the episode ends by natural
// termination (terminated=true) well before maxTicks — the shape the
// default map exhibits at tick ~44 (#421).
const lethalMap: MapDef = {
  name: 'bench-sustained-lethal',
  spawnPoints: { team_blue: { x: 0, y: -300 }, team_red: { x: 200, y: -100 } },
  bodies: [{ name: 'lethal', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true, isLethal: true }],
};

/** One measured step of a replica bench loop: stepLive classification plus the step's tick. */
type StepRecord = { live: boolean; reset: boolean; done: boolean; tick: number };

describe('issue #421: sustained benchmark measurement keeps episodes live', () => {
  it('a loop that ignores done never advances past the terminal tick (defect pin)', () => {
    const env = new BonkEnvironment({
      mapData: lethalMap,
      maxTicks: 10_000,
      frameSkip: 1,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      env.reset(42);

      let terminalTick = -1;
      for (let i = 0; i < 500; i++) {
        const res = env.step(0);
        if (res.done) {
          terminalTick = res.info.tick;
          break;
        }
      }
      expect(terminalTick).toBeGreaterThan(0);

      // Exactly the behavior that inflated the old benchmarks: every
      // further step replays the same terminal state, no physics.
      for (let i = 0; i < 25; i++) {
        const res = env.step(0);
        expect(res.done).toBe(true);
        expect(res.info.tick).toBe(terminalTick);
        expect(res.observation.tick).toBe(terminalTick);
      }
    } finally {
      env.close();
    }
  });

  const runSustainedLoop = (
    mapData: MapDef,
    config: { maxTicks: number; frameSkip: number },
    measuredSteps: number,
  ): StepRecord[] => {
    const env = new BonkEnvironment({
      mapData,
      ...config,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      env.reset(42);
      // Warmup like the benches, resetting through any early end.
      for (let i = 0; i < 50; i++) stepLive(env, Math.floor((i * 13) % 64));

      const records: StepRecord[] = [];
      for (let i = 0; i < measuredSteps; i++) {
        const outcome = stepLive(env, Math.floor((i * 29) % 64));
        records.push({
          live: outcome.live,
          reset: outcome.reset,
          done: outcome.result.done,
          tick: outcome.result.info.tick,
        });
      }
      return records;
    } finally {
      env.close();
    }
  };

  it('every measured step advances physics across repeated truncated episodes', () => {
    // maxTicks=25 with frameSkip=1: deterministic episode boundary every
    // 25 ticks — the loop crosses four full episodes.
    const records = runSustainedLoop(boxMap, { maxTicks: 25, frameSkip: 1 }, 100);

    const dones = records.filter((r) => r.done).length;
    const resets = records.filter((r) => r.reset).length;
    expect(dones).toBe(4);
    // Zero unhandled terminal results: every done report restarted the
    // episode, so all 100 measured steps ran physics.
    expect(resets).toBe(dones);
    expect(records.every((r) => r.live)).toBe(true);

    // info.tick strictly advances between consecutive measured steps,
    // except exactly at an episode restart (fresh episode starts at 1).
    expect(records[0].tick).toBe(1);
    for (let i = 1; i < records.length; i++) {
      if (records[i - 1].reset) {
        expect(records[i].tick).toBe(1);
      } else {
        expect(records[i].tick).toBe(records[i - 1].tick + 1);
      }
    }
  });

  it('every measured step advances physics across natural terminations', () => {
    // Natural death (terminated=true) instead of truncation — what the
    // default map produces at tick ~44. The loop must ride through
    // arbitrarily many deaths without a single idle step.
    const records = runSustainedLoop(lethalMap, { maxTicks: 10_000, frameSkip: 1 }, 150);

    const dones = records.filter((r) => r.done).length;
    const resets = records.filter((r) => r.reset).length;
    expect(dones).toBeGreaterThanOrEqual(1);
    expect(resets).toBe(dones);
    expect(records.every((r) => r.live)).toBe(true);

    let restarts = 0;
    for (let i = 1; i < records.length; i++) {
      if (records[i - 1].reset) {
        expect(records[i].tick).toBe(1);
        restarts++;
      } else {
        expect(records[i].tick).toBe(records[i - 1].tick + 1);
      }
    }
    // Every reset except possibly a trailing one (which has no follower in
    // the measured window) is followed by a fresh episode at tick 1.
    const trailingResets = records[records.length - 1].reset ? 1 : 0;
    expect(restarts).toBe(resets - trailingResets);
  });

  it('excludes frame-skip terminal-hold replay steps from the live count', () => {
    // frameSkip=3, maxTicks=7: the terminal done is held for the rest of
    // its action cycle before the restart (#228). Those replay steps run
    // no physics, report the frozen terminal tick, and must not be
    // counted as live measurement steps.
    const records = runSustainedLoop(boxMap, { maxTicks: 7, frameSkip: 3 }, 30);

    const dones = records.filter((r) => r.done).length;
    const resets = records.filter((r) => r.reset).length;
    const holds = records.filter((r) => !r.live).length;
    expect(dones).toBeGreaterThan(0);
    // Each episode reports several done results (terminal + hold
    // replays) but exactly one restart.
    expect(resets).toBeGreaterThanOrEqual(1);
    expect(resets).toBeLessThanOrEqual(dones);
    expect(holds).toBeGreaterThan(0);
    expect(records.length - holds).toBeGreaterThan(0); // some live work

    let restarts = 0;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      // Every excluded step is part of the episode's terminal window:
      // either the terminal step itself or a frozen replay of it. A
      // replay that follows another excluded step repeats its tick.
      if (!record.live) {
        expect(record.done).toBe(true);
        if (i > 0 && !records[i - 1].live && !records[i - 1].reset) {
          expect(record.tick).toBe(records[i - 1].tick);
        }
      }
      if (record.reset) {
        expect(record.done).toBe(true);
      }
      if (i > 0 && records[i - 1].reset) {
        expect(record.tick).toBe(1);
        restarts++;
      } else if (i > 0 && record.reset) {
        // The restart call replays the frozen terminal tick before
        // resetting (worker-parity terminal result on that step).
        expect(record.tick).toBe(records[i - 1].tick);
      } else if (i > 0 && record.live) {
        expect(record.tick).toBe(records[i - 1].tick + 1);
      }
    }
    // Every reset except possibly a trailing one (which has no follower in
    // the measured window) is followed by a fresh episode at tick 1.
    const trailingResets = records[records.length - 1].reset ? 1 : 0;
    expect(restarts).toBe(resets - trailingResets);
  });
});

describe('issue #461: reset-cycles loop keeps episodes live across reset windows', () => {
  // Small replica of the layer5 benchResetCycles loop shape (#461): an
  // explicit env.reset() at the top of every fixed window, then a fixed
  // step count inside it. 150-step windows match the #421 horizon proven
  // to contain natural deaths on this map — the same shape the bench's
  // 100-step windows hit on the default map (episode dies at ~tick 44).
  const WINDOWS = 4;
  const STEPS_PER_WINDOW = 150;

  const runResetCyclesLoop = (mode: 'stepLive' | 'raw'): StepRecord[] => {
    const env = new BonkEnvironment({
      mapData: lethalMap,
      maxTicks: 10_000,
      frameSkip: 1,
      numOpponents: 0,
      randomOpponent: false,
      seed: 42,
    });
    try {
      const records: StepRecord[] = [];
      for (let w = 0; w < WINDOWS; w++) {
        env.reset();
        for (let i = 0; i < STEPS_PER_WINDOW; i++) {
          if (mode === 'stepLive') {
            const outcome = stepLive(env, 0);
            records.push({
              live: outcome.live,
              reset: outcome.reset,
              done: outcome.result.done,
              tick: outcome.result.info.tick,
            });
          } else {
            const res = env.step(0);
            records.push({ live: false, reset: false, done: res.done, tick: res.info.tick });
          }
        }
      }
      return records;
    } finally {
      env.close();
    }
  };

  it('the raw loop freezes for the post-death tail of every window (defect pin)', () => {
    const records = runResetCyclesLoop('raw');
    for (let w = 0; w < WINDOWS; w++) {
      const window = records.slice(w * STEPS_PER_WINDOW, (w + 1) * STEPS_PER_WINDOW);
      // The outer reset starts the window on the physics path...
      expect(window[0].tick).toBe(1);
      // ...but the episode dies well inside the window and every
      // remaining step replays the settled terminal result with zero
      // physics work — the mid-window freeze the outer reset hid (#461).
      const terminalRecords = window.filter((r) => r.done);
      expect(terminalRecords.length).toBeGreaterThan(0);
      const terminalTick = terminalRecords[0].tick;
      expect(terminalTick).toBeLessThan(STEPS_PER_WINDOW);
      expect(terminalRecords.every((r) => r.tick === terminalTick)).toBe(true);
      expect(window[window.length - 1].tick).toBe(terminalTick);
    }
  });

  it('the stepLive replica keeps every counted step on the physics path across all windows', () => {
    const records = runResetCyclesLoop('stepLive');
    // frameSkip=1: stepLive resets on the final report of each ended
    // episode, so every counted step is live and the SPS numerator
    // tracks real Box2D work instead of no-op replays (#461).
    expect(records.every((r) => r.live)).toBe(true);
    expect(records.filter((r) => r.reset).length).toBe(records.filter((r) => r.done).length);
    // The outer reset at each window top provably restarts on the physics
    // path: the first counted step of every window reports tick 1, live.
    for (let w = 0; w < WINDOWS; w++) {
      const first = records[w * STEPS_PER_WINDOW];
      expect(first.tick).toBe(1);
      expect(first.live).toBe(true);
    }
    // Every counted step advances Box2D: tick +1 between consecutive steps
    // except across an episode restart — either the previous step was a
    // stepLive reset or it was the last step of a window, whose outer
    // env.reset() truncated the in-progress episode (#461's outer-reset
    // cycle).
    for (let i = 1; i < records.length; i++) {
      if (records[i - 1].reset || i % STEPS_PER_WINDOW === 0) {
        expect(records[i].tick).toBe(1);
      } else {
        expect(records[i].tick).toBe(records[i - 1].tick + 1);
      }
    }
    // Each window contains at least one natural death — the #461 bug
    // class the fixed shape provably never hits (see the defect pin
    // above: a raw loop spends that tail frozen).
    for (let w = 0; w < WINDOWS; w++) {
      const window = records.slice(w * STEPS_PER_WINDOW, (w + 1) * STEPS_PER_WINDOW);
      expect(window.some((r) => r.done)).toBe(true);
    }
  });
});
