import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

/**
 * Regression tests for #399: BonkEnvironment.step() must hold the action that
 * begins a frame-skip cycle BY VALUE, so a caller that reuses one mutable
 * PlayerInput dict and edits it between step() calls cannot retroactively
 * change the inputs applied on ticks 2..N of the cycle. The suite also pins
 * that the hold exists at all: intermediate ticks must ignore their own
 * step() argument entirely.
 */
describe('frameSkip hold must snapshot the action', () => {
  function runBranch(mutate: boolean, frameSkip: number, ignoredArg: unknown = 0, startWithLeft = true): any[] {
    const env = new BonkEnvironment({
      frameSkip,
      numOpponents: 0,
      randomOpponent: false,
      seed: 7,
      maxTicks: 200,
    } as any);
    try {
      env.reset();
      const action = {
        left: startWithLeft,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      };
      // Cycle start: hold `left` for `frameSkip` ticks.
      env.step(action as any);
      if (mutate) {
        // Caller reuses and mutates the same dict between step() calls.
        action.left = false;
        action.right = true;
      }
      // Remaining ticks of the cycle: the argument is ignored, the held
      // action must be applied.
      const observations: any[] = [];
      for (let tick = 1; tick < frameSkip; tick++) {
        const result = env.step(ignoredArg as any);
        observations.push((result as any).observation);
      }
      return observations;
    } finally {
      env.close();
    }
  }

  function assertHoldByValue(frameSkip: number): void {
    const control = runBranch(false, frameSkip);
    const aliased = runBranch(true, frameSkip);
    // Same seed, same per-call action values — a correct hold must produce
    // bit-identical observations on every tick served from the snapshot.
    expect(JSON.stringify(aliased)).toEqual(JSON.stringify(control));
  }

  it('mutating a reused action dict must not change the held action (frameSkip=2)', () => {
    assertHoldByValue(2);
  });

  it('held inputs apply on the intermediate tick (frameSkip=3)', () => {
    assertHoldByValue(3);
  });

  it('intermediate ticks hold the cycle-start input and ignore their argument (frameSkip=3)', () => {
    // Pin both aspects of the contract: a held-left cycle differs from an
    // all-false cycle, while valid sentinel actions passed on intermediate
    // ticks must leave the held-left physics unchanged.
    const heldLeft = runBranch(false, 3, 0);
    expect(JSON.stringify(heldLeft)).not.toEqual(JSON.stringify(runBranch(false, 3, 0, false)));
    expect(JSON.stringify(runBranch(false, 3, 63))).toEqual(JSON.stringify(heldLeft));
    expect(
      JSON.stringify(
        runBranch(false, 3, {
          right: true,
          up: true,
          heavy: true,
          grapple: true,
        }),
      ),
    ).toEqual(JSON.stringify(heldLeft));
  });
});
