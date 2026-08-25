/**
 * bench-sustained-physics.test.ts — Regression coverage for issue #421.
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
  ): Array<{ live: boolean; reset: boolean; done: boolean; tick: number }> => {
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

      const records: Array<{ live: boolean; reset: boolean; done: boolean; tick: number }> = [];
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
    // Every restart lands immediately after a handled termination.
    expect(restarts).toBe(resets);
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
    expect(restarts).toBe(resets);
  });
});
