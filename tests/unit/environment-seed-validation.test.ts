/**
 * environment-seed-validation.test.ts — Regression coverage for issue #460
 *
 * BonkEnvironment.reset(seed) and the constructor seed slot previously
 * forwarded any number into the PRNG's `seed >>> 0` normalization, silently
 * bit-casting negatives, wrapping values >= 2^32 and truncating fractions
 * onto a DIFFERENT deterministic stream than the caller requested. Every
 * other seeding surface (WorkerPool in both transports, the IPC bridge, the
 * Python client's [0, MAX_RESET_SEED] check) rejects exactly these values,
 * so a rollout recorded through the direct API with such a seed could never
 * be reproduced anywhere else. The direct boundary now enforces the same
 * single supported domain — an integer in [0, MAX_SUPPORTED_RESET_SEED] —
 * with a labeled error, while previously-valid seeds keep byte-identical
 * streams.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { MAX_SUPPORTED_RESET_SEED } from '../../src/core/seed-range';

const resetRangeError = (value: number) =>
  new RegExp(`Seed ${value} out of supported range \\[0, ${MAX_SUPPORTED_RESET_SEED}\\] for reset`);

const constructorRangeError = (value: number) =>
  new RegExp(`Invalid seed ${value}: expected an integer in \\[0, ${MAX_SUPPORTED_RESET_SEED}\\]`);

describe('BonkEnvironment seed validation (#460)', () => {
  it('rejects reset(-1) (previously bit-cast to 0xFFFFFFFF by >>> 0)', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset(-1)).toThrow(resetRangeError(-1));
    env.close();
  });

  it('rejects reset(2**32) (previously wrapped to 0 by >>> 0)', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset(2 ** 32)).toThrow(resetRangeError(2 ** 32));
    env.close();
  });

  it('rejects reset(1.9) (previously truncated to 1 by >>> 0)', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset(1.9)).toThrow(resetRangeError(1.9));
    env.close();
  });

  it('rejects reset(0xFFFFFFFF): a valid uint32 but one past the supported bound', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset(0xffffffff)).toThrow(resetRangeError(0xffffffff));
    env.close();
  });

  it('rejects fractional, NaN and non-finite resets that >>> 0 would coerce', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset(3.7)).toThrow(resetRangeError(3.7));
    expect(() => env.reset(NaN)).toThrow(/out of supported range/);
    expect(() => env.reset(Infinity)).toThrow(/out of supported range/);
    env.close();
  });

  it('rejects a non-numeric reset instead of coercing through ToUint32', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset('7' as any)).toThrow(/out of supported range/);
    env.close();
  });

  it('leaves the environment untouched after a rejected reset', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    const seedBefore = (env as any).config.seed;
    const stateBefore = (env as any).rng.getState();
    expect(() => env.reset(-1)).toThrow(resetRangeError(-1));
    expect((env as any).config.seed).toBe(seedBefore);
    expect((env as any).rng.getState()).toBe(stateBefore);
    // The rejected call must not poison the environment: a subsequent valid
    // reset behaves exactly like a fresh environment on the same seed.
    const fresh = new BonkEnvironment({ numOpponents: 1, seed: 9 });
    expect(env.reset(9)).toEqual(fresh.reset());
    env.close();
    fresh.close();
  });

  it('rejects constructor seed -1, 2**32 and 1.9 with the labeled guard', () => {
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: -1 })).toThrow(constructorRangeError(-1));
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: 2 ** 32 })).toThrow(constructorRangeError(2 ** 32));
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: 1.9 })).toThrow(constructorRangeError(1.9));
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: 0xffffffff })).toThrow(constructorRangeError(0xffffffff));
  });

  it('still treats an absent constructor seed as random (#200), not invalid', () => {
    const envUndefined = new BonkEnvironment({ numOpponents: 1, seed: undefined });
    expect((envUndefined as any).config.seed).toBeGreaterThanOrEqual(0);
    expect((envUndefined as any).config.seed).toBeLessThanOrEqual(999999);
    envUndefined.close();
    const envNull = new BonkEnvironment({ numOpponents: 1, seed: null as any });
    expect((envNull as any).config.seed).toBeGreaterThanOrEqual(0);
    envNull.close();
  });

  it('still treats reset(undefined) as unseeded, not invalid', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => env.reset()).not.toThrow();
    env.close();
  });

  it('accepts the full supported domain [0, MAX_SUPPORTED_RESET_SEED]', () => {
    const envLow = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => envLow.reset(0)).not.toThrow();
    expect((envLow as any).config.seed).toBe(0);
    envLow.close();
    const envHigh = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => envHigh.reset(MAX_SUPPORTED_RESET_SEED)).not.toThrow();
    expect((envHigh as any).config.seed).toBe(MAX_SUPPORTED_RESET_SEED);
    envHigh.close();
    // Integral floats stay legal (Python transport parity, as for frameSkip).
    const envFloat = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => envFloat.reset(7.0)).not.toThrow();
    expect((envFloat as any).config.seed).toBe(7);
    envFloat.close();
  });

  // Golden fingerprints captured on the pre-fix build (commit a64e470):
  // the rng state after 40 idle steps from reset(seed), the score line and
  // the observation tail. Valid seeds must keep byte-identical streams.
  const golden: Record<number, { rngState: number; score: string; doneTicks: number[]; obsTail: number[] }> = {
    0: {
      rngState: 1489130928,
      score: '0-0',
      doneTicks: [],
      obsTail: [-100, 681.166667, -100, 706.5, -100, 732.5, -100, 759.166667],
    },
    1: {
      rngState: 1489130929,
      score: '0-0',
      doneTicks: [],
      obsTail: [-100, 681.166667, -100, 706.5, -100, 732.5, -100, 759.166667],
    },
    42: {
      rngState: 1489130970,
      score: '0-0',
      doneTicks: [],
      obsTail: [-100, 681.166667, -100, 706.5, -100, 732.5, -100, 759.166667],
    },
    12345: {
      rngState: 1489143273,
      score: '0-0',
      doneTicks: [],
      obsTail: [-100, 681.166667, -100, 706.5, -100, 732.5, -100, 759.166667],
    },
    [MAX_SUPPORTED_RESET_SEED]: {
      rngState: 1489130926,
      score: '0-0',
      doneTicks: [39],
      obsTail: [-100, 681.166667, -100, 706.5, -100, 732.5, -100, 759.166667],
    },
  };

  it('produces byte-identical sequences for previously-valid seeds (golden check)', () => {
    for (const [seedStr, expected] of Object.entries(golden)) {
      const seed = Number(seedStr);
      const env = new BonkEnvironment({ numOpponents: 1, seed });
      env.reset(seed);
      const doneTicks: number[] = [];
      const obs: number[] = [];
      for (let i = 0; i < 40; i++) {
        const r = env.step(0);
        if (r.done) doneTicks.push(i);
        obs.push(+r.observation.playerX.toFixed(6), +r.observation.playerY.toFixed(6));
      }
      expect((env as any).rng.getState()).toBe(expected.rngState);
      expect(`${(env as any).scoreBlue}-${(env as any).scoreRed}`).toBe(expected.score);
      expect(doneTicks).toEqual(expected.doneTicks);
      expect(obs.slice(-8)).toEqual(expected.obsTail);
      env.close();

      // The constructor seed slot seeds the identical stream without an
      // explicit reset(seed): the same 40-step pattern must produce the
      // same fingerprint.
      const envCtor = new BonkEnvironment({ numOpponents: 1, seed });
      envCtor.reset();
      for (let i = 0; i < 40; i++) {
        envCtor.step(0);
      }
      expect((envCtor as any).rng.getState()).toBe(expected.rngState);
      envCtor.close();
    }
  });

  it('routes the seed into the PRNG unmodified (state equals the seed after reset)', () => {
    const env = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    env.reset(1234);
    expect((env as any).rng.getState()).toBe(1234);
    env.close();
    const envCtor = new BonkEnvironment({ numOpponents: 1, seed: 1234 });
    expect((envCtor as any).rng.getState()).toBe(1234);
    envCtor.close();
  });
});
