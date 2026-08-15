import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

describe('BonkEnvironment frameSkip validation (#393)', () => {
  it('rejects NaN frameSkip (would freeze action input)', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: NaN }))
      .toThrow(/Invalid frameSkip NaN: expected an integer in \[1, 100\]/);
  });

  it('rejects frameSkip 0 (would disable the terminal hold)', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: 0 }))
      .toThrow(/Invalid frameSkip 0: expected an integer in \[1, 100\]/);
  });

  it('rejects negative frameSkip', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: -1 }))
      .toThrow(/Invalid frameSkip -1: expected an integer in \[1, 100\]/);
  });

  it('rejects fractional frameSkip (would widen the terminal-hold window)', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: 2.5 }))
      .toThrow(/Invalid frameSkip 2.5: expected an integer in \[1, 100\]/);
  });

  it('rejects non-finite frameSkip', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: Infinity }))
      .toThrow(/Invalid frameSkip Infinity: expected an integer in \[1, 100\]/);
  });

  it('rejects absurdly large frameSkip past the MAX_FRAME_SKIP cap', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: 101 }))
      .toThrow(/Invalid frameSkip 101: expected an integer in \[1, 100\]/);
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: 1e9 }))
      .toThrow(/Invalid frameSkip 1000000000: expected an integer in \[1, 100\]/);
  });

  it('rejects non-numeric frameSkip', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frameSkip: 'four' as any }))
      .toThrow(/Invalid frameSkip four: expected an integer in \[1, 100\]/);
  });

  it('rejects snake_case frame_skip 0 through the alias', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frame_skip: 0 } as any))
      .toThrow(/Invalid frameSkip 0: expected an integer in \[1, 100\]/);
  });

  it('rejects fractional snake_case frame_skip through the alias', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, frame_skip: 2.5 } as any))
      .toThrow(/Invalid frameSkip 2.5: expected an integer in \[1, 100\]/);
  });

  it('accepts a positive integer frameSkip', () => {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 4 });
    expect((env as any).config.frameSkip).toBe(4);
    env.close();
  });

  it('accepts the MAX_FRAME_SKIP boundary and integral floats (Python transport parity)', () => {
    const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 100 });
    expect((env as any).config.frameSkip).toBe(100);
    env.close();
    const envFloat = new BonkEnvironment({ numOpponents: 1, frameSkip: 4.0 });
    expect((envFloat as any).config.frameSkip).toBe(4);
    envFloat.close();
  });

  it('accepts a positive snake_case frame_skip through the alias', () => {
    const env = new BonkEnvironment({ numOpponents: 1, frame_skip: 3 } as any);
    expect((env as any).config.frameSkip).toBe(3);
    env.close();
  });

  it('falls back to the documented 1 default when frameSkip is unset', () => {
    const env = new BonkEnvironment({ numOpponents: 1 });
    expect((env as any).config.frameSkip).toBe(1);
    env.close();
  });

  it('serves exactly frameSkip consecutive done steps for one truncated episode', () => {
    const env = new BonkEnvironment({
      numOpponents: 0,
      randomOpponent: false,
      seed: 1,
      maxTicks: 1,
      frameSkip: 3,
    });
    let doneSteps = 0;
    let holdEnded = false;
    for (let i = 0; i < 6; i++) {
      const res = env.step(0);
      if (res.done) {
        doneSteps++;
      }
      if (res.done && !env.isTerminalHoldActive()) {
        holdEnded = true;
        break;
      }
    }
    expect(doneSteps).toBe(3);
    expect(holdEnded).toBe(true);
    env.close();
  });
});