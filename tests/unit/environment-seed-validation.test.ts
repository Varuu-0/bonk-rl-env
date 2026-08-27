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
import { deriveConstructionSeed, MAX_SUPPORTED_RESET_SEED } from '../../src/core/seed-range';

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
    // Integral floats stay legal on the JS surface because ToUint32-like
    // acceptance was the pre-#460 behavior for them; this leniency is
    // JS-only — the Python client raises TypeError for non-Integral seeds
    // (python/envs/bonk_env.py), and cross-transport float parity was
    // never the contract.
    const envFloat = new BonkEnvironment({ numOpponents: 1, seed: 1 });
    expect(() => envFloat.reset(7.0)).not.toThrow();
    expect((envFloat as any).config.seed).toBe(7);
    envFloat.close();
  });

  // Golden fingerprints captured on the pre-fix build (commit a64e470):
  // the Mulberry32 state after 40 idle steps from reset(seed) — a pure
  // function of the seed's stream. Deliberately stream-only: pinning
  // death ticks or observation tails here would couple this test to
  // engine/map changes (RNG-driven permanent-death timing) for
  // non-#460 reasons.
  const goldenRngState: Record<number, number> = {
    0: 1489130928,
    1: 1489130929,
    42: 1489130970,
    12345: 1489143273,
    [MAX_SUPPORTED_RESET_SEED]: 1489130926,
  };

  it('produces byte-identical PRNG streams for previously-valid seeds (golden check)', () => {
    for (const [seedStr, expectedState] of Object.entries(goldenRngState)) {
      const seed = Number(seedStr);
      const env = new BonkEnvironment({ numOpponents: 1, seed });
      try {
        env.reset(seed);
        for (let i = 0; i < 40; i++) {
          env.step(0);
        }
        expect((env as any).rng.getState()).toBe(expectedState);
      } finally {
        env.close();
      }

      // The constructor seed slot seeds the identical stream without an
      // explicit reset(seed): the same 40-step pattern must produce the
      // same fingerprint.
      const envCtor = new BonkEnvironment({ numOpponents: 1, seed });
      try {
        envCtor.reset();
        for (let i = 0; i < 40; i++) {
          envCtor.step(0);
        }
        expect((envCtor as any).rng.getState()).toBe(expectedState);
      } finally {
        envCtor.close();
      }
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

describe('pooled derived construction seeds (review of #460)', () => {
  it('is the identity for every in-range base seed and offset', () => {
    for (const base of [0, 1, 42, 12345, MAX_SUPPORTED_RESET_SEED - 100]) {
      for (const offset of [0, 1, 7, 99]) {
        expect(deriveConstructionSeed(base, offset)).toBe(base + offset);
      }
    }
  });

  it('wraps into the supported domain instead of exceeding it (clamp would duplicate streams)', () => {
    // init(4, { seed: MAX }) must derive MAX, 0, 1, 2 — all distinct and
    // all accepted by the constructor guard.
    const derived = [0, 1, 2, 3].map((i) => deriveConstructionSeed(MAX_SUPPORTED_RESET_SEED, i));
    expect(derived).toEqual([MAX_SUPPORTED_RESET_SEED, 0, 1, 2]);
    for (const seed of derived) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_SUPPORTED_RESET_SEED);
      const env = new BonkEnvironment({ numOpponents: 1, seed });
      env.close();
    }
  });

  it('still strictly validates the configured base seed (only the derived offset wraps)', () => {
    // The wrap applies to base + offset, never to a caller-supplied
    // out-of-domain base: an invalid configured seed must keep failing
    // loudly rather than silently wrapping onto a different stream.
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: MAX_SUPPORTED_RESET_SEED + 1 })).toThrow(
      new RegExp(`Invalid seed ${MAX_SUPPORTED_RESET_SEED + 1}: expected an integer in`),
    );
    expect(() => new BonkEnvironment({ numOpponents: 1, seed: -1 })).toThrow(/Invalid seed -1/);
  });
});
