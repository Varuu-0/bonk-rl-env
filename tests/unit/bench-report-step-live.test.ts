/**
 * bench-report-step-live.test.ts — Contract tests for the episode-aware
 * benchmark stepper (#421).
 *
 * Native benchmark loops must measure sustained *physics* throughput: once
 * an episode ends, a BonkEnvironment replays its terminal result with zero
 * physics work until an explicit reset() (#197), so a loop that ignores
 * done degenerates into timing no-op steps (issue #421). stepLive() is the
 * shared fix; these tests pin its contract against a scripted environment,
 * independent of Box2D timing or map specifics:
 *
 *   - live steps forward untouched results while the episode runs;
 *   - terminal-hold replay steps are reported NOT live and do not reset;
 *   - the final done step resets the environment and preserves the ended
 *     episode's observation (worker applyStepAutoReset parity);
 *   - across a full scripted run, every measured step is accounted as
 *     live-or-hold, and resets equal handled terminal reports.
 */
import { describe, it, expect } from 'vitest';
import { stepLive } from '../../src/utils/bench-report';
import type { Action, BonkEnvironment, Observation, StepResult } from '../../src/core/environment';

interface ScriptedEnv {
  step(action: Action): StepResult;
  isTerminalHoldActive(): boolean;
  reset(): void;
}

function asEnv(env: ScriptedEnv): BonkEnvironment {
  return env as unknown as BonkEnvironment;
}

function makeResult(overrides: Partial<StepResult>): StepResult {
  return {
    observation: { tick: 1 } as Observation,
    reward: 0,
    done: false,
    truncated: false,
    terminated: false,
    info: {},
    ...overrides,
  };
}

/**
 * Builds an env whose step() results come from `script` in order. Each entry
 * says whether that step reports done and whether the frame-skip terminal
 * hold is still active at that point (consulted by isTerminalHoldActive()
 * immediately after the step, exactly as stepLive does).
 */
function makeScriptedEnv(
  script: Array<{ done: boolean; holdActive: boolean }>,
): ScriptedEnv & { resets: number; actions: Action[] } {
  let cursor = 0;
  const env = {
    resets: 0,
    actions: [] as Action[],
    step(action: Action): StepResult {
      env.actions.push(action);
      const entry = script[cursor];
      cursor++;
      return makeResult({ done: entry.done, info: { tick: cursor } });
    },
    isTerminalHoldActive(): boolean {
      return script[cursor - 1].holdActive;
    },
    reset(): void {
      env.resets++;
    },
  };
  return env;
}

describe('stepLive contract (issue #421)', () => {
  it('forwards non-terminal steps untouched and marks them live', () => {
    const env = makeScriptedEnv([{ done: false, holdActive: false }]);
    const outcome = stepLive(asEnv(env), 7);
    expect(outcome.live).toBe(true);
    expect(outcome.reset).toBe(false);
    expect(outcome.result.done).toBe(false);
    expect(env.actions).toEqual([7]);
    expect(env.resets).toBe(0);
  });

  it('does not reset while the frame-skip terminal hold is being served', () => {
    // Episode ends on step 1; steps 2-3 replay the held done result
    // while the hold window drains. Mirrors worker behavior: no reset
    // mid-hold (#228); the restart lands on the final replay step.
    const env = makeScriptedEnv([
      { done: true, holdActive: true },
      { done: true, holdActive: true },
      { done: true, holdActive: false },
    ]);
    const first = stepLive(asEnv(env), 0);
    expect(first.result.done).toBe(true);
    expect(first.live).toBe(false);
    expect(first.reset).toBe(false);

    const second = stepLive(asEnv(env), 0);
    expect(second.live).toBe(false);
    expect(second.reset).toBe(false);
    expect(env.resets).toBe(0);

    const third = stepLive(asEnv(env), 0);
    expect(third.result.done).toBe(true);
    expect(third.live).toBe(true);
    expect(third.reset).toBe(true);
    expect(env.resets).toBe(1);
  });

  it('resets immediately on done when there is no hold window (frameSkip=1)', () => {
    const env = makeScriptedEnv([{ done: true, holdActive: false }]);
    const outcome = stepLive(asEnv(env), 0);
    expect(outcome.result.done).toBe(true);
    expect(outcome.live).toBe(true);
    expect(outcome.reset).toBe(true);
    expect(env.resets).toBe(1);
  });

  it('preserves the ended episode observation across the reset', () => {
    // Simulates the transport hazard applyStepAutoReset guards against:
    // reset() invalidates buffers the old observation aliased, so the
    // helper must hand back the pre-reset terminal observation (#222).
    const terminalObservation = { tick: 44 } as Observation;
    let invalidatedByReset = false;
    const env = makeScriptedEnv([{ done: true, holdActive: false }]);
    const rawStep = env.step.bind(env);
    env.step = (action: Action) => {
      const res = rawStep(action);
      res.observation = terminalObservation;
      return res;
    };
    const rawReset = env.reset.bind(env);
    env.reset = () => {
      invalidatedByReset = true;
      rawReset();
    };

    const outcome = stepLive(asEnv(env), 0);
    expect(outcome.reset).toBe(true);
    expect(invalidatedByReset).toBe(true);
    expect(outcome.result.observation).toEqual({ tick: 44 });
  });

  it('accounts a full scripted run with zero unhandled terminal results', () => {
    // One full episode with a frameSkip=3-style hold tail, then a fresh
    // episode: 4 live steps, done + 2 hold replays, restart, new step.
    const script = [
      { done: false, holdActive: false },
      { done: false, holdActive: false },
      { done: false, holdActive: false },
      { done: false, holdActive: false },
      { done: true, holdActive: true },
      { done: true, holdActive: true },
      { done: true, holdActive: false },
      { done: false, holdActive: false },
    ];
    const env = makeScriptedEnv(script);
    let liveSteps = 0;
    let resets = 0;
    let doneReports = 0;
    for (let i = 0; i < script.length; i++) {
      const outcome = stepLive(asEnv(env), 0);
      if (outcome.live) liveSteps++;
      if (outcome.reset) resets++;
      if (outcome.result.done) doneReports++;
    }
    // Every terminal report was followed by exactly one restart, and
    // only the two pure hold-replay steps were excluded from the count.
    expect(doneReports).toBe(3);
    expect(resets).toBe(1);
    expect(liveSteps).toBe(script.length - 2);
    expect(env.resets).toBe(resets);
  });
});
