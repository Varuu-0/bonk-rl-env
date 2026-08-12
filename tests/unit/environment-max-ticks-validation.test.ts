import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

describe('BonkEnvironment maxTicks validation (#266)', () => {
  it('rejects maxTicks 0', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, maxTicks: 0 }))
      .toThrow(/Invalid maxTicks 0: expected a positive integer/);
  });

  it('rejects negative maxTicks', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, maxTicks: -3 }))
      .toThrow(/Invalid maxTicks -3: expected a positive integer/);
  });

  it('rejects fractional maxTicks', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, maxTicks: 2.5 }))
      .toThrow(/Invalid maxTicks 2.5: expected a positive integer/);
  });

  it('rejects non-numeric maxTicks', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, maxTicks: 'five' as any }))
      .toThrow(/Invalid maxTicks five: expected a positive integer/);
  });

  it('rejects snake_case max_ticks 0 through the alias', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, max_ticks: 0 } as any))
      .toThrow(/Invalid maxTicks 0: expected a positive integer/);
  });

  it('rejects negative snake_case max_ticks', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, max_ticks: -1 } as any))
      .toThrow(/Invalid maxTicks -1: expected a positive integer/);
  });

  it('accepts a positive integer maxTicks', () => {
    const env = new BonkEnvironment({ numOpponents: 1, maxTicks: 5 });
    expect((env as any).config.maxTicks).toBe(5);
    env.close();
  });

  it('accepts a positive snake_case max_ticks through the alias', () => {
    const env = new BonkEnvironment({ numOpponents: 1, max_ticks: 3 } as any);
    expect((env as any).config.maxTicks).toBe(3);
    env.close();
  });

  it('falls back to the documented 900 default when maxTicks is unset', () => {
    const env = new BonkEnvironment({ numOpponents: 1 });
    expect((env as any).config.maxTicks).toBe(900);
    env.close();
  });
});
