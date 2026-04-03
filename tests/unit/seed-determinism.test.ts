import { describe, it, expect } from 'vitest';
import { PRNG } from '../../src/core/prng';

describe('PRNG determinism', () => {
  describe('same seed produces identical sequence', () => {
    it('generates identical values for 100 calls with seed 42', () => {
      const rng1 = new PRNG(42);
      const rng2 = new PRNG(42);

      for (let i = 0; i < 100; i++) {
        expect(rng1.next()).toBe(rng2.next());
      }
    });

    it('generates identical nextInt values for 100 calls with seed 123', () => {
      const rng1 = new PRNG(123);
      const rng2 = new PRNG(123);

      for (let i = 0; i < 100; i++) {
        expect(rng1.nextInt(0, 100)).toBe(rng2.nextInt(0, 100));
      }
    });
  });

  describe('different seeds produce different sequences', () => {
    it('seed 1 and seed 2 produce different first values', () => {
      const rng1 = new PRNG(1);
      const rng2 = new PRNG(2);

      const values1 = Array.from({ length: 10 }, () => rng1.next());
      const values2 = Array.from({ length: 10 }, () => rng2.next());

      expect(values1).not.toEqual(values2);
    });

    it('seed 0 and seed 999 produce different sequences', () => {
      const rng1 = new PRNG(0);
      const rng2 = new PRNG(999);

      const seq1 = Array.from({ length: 50 }, () => rng1.nextInt(1, 1000));
      const seq2 = Array.from({ length: 50 }, () => rng2.nextInt(1, 1000));

      expect(seq1).not.toEqual(seq2);
    });
  });

  describe('edge case seeds', () => {
    it('seed 0 produces valid values', () => {
      const rng = new PRNG(0);

      for (let i = 0; i < 50; i++) {
        const val = rng.next();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });

    it('seed MAX_INT produces valid values', () => {
      const maxInt = 2147483647;
      const rng = new PRNG(maxInt);

      for (let i = 0; i < 50; i++) {
        const val = rng.next();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });

    it('seed 0 is deterministic across runs', () => {
      const rng1 = new PRNG(0);
      const rng2 = new PRNG(0);

      for (let i = 0; i < 100; i++) {
        expect(rng1.next()).toBe(rng2.next());
      }
    });
  });

  describe('nextInt range validation', () => {
    it('returns values within [min, max] inclusive', () => {
      const rng = new PRNG(42);

      for (let i = 0; i < 100; i++) {
        const val = rng.nextInt(5, 15);
        expect(val).toBeGreaterThanOrEqual(5);
        expect(val).toBeLessThanOrEqual(15);
        expect(Number.isInteger(val)).toBe(true);
      }
    });

    it('returns min when min === max', () => {
      const rng = new PRNG(42);
      const val = rng.nextInt(7, 7);
      expect(val).toBe(7);
    });

    it('throws when min > max', () => {
      const rng = new PRNG(42);
      expect(() => {
        rng.nextInt(10, 5);
      }).toThrow('Invalid range: min (10) cannot be greater than max (5)');
    });

    it('handles negative ranges', () => {
      const rng = new PRNG(42);

      for (let i = 0; i < 20; i++) {
        const val = rng.nextInt(-10, -1);
        expect(val).toBeGreaterThanOrEqual(-10);
        expect(val).toBeLessThanOrEqual(-1);
      }
    });

    it('floors non-integer bounds', () => {
      const rng = new PRNG(42);
      const val = rng.nextInt(1.9, 5.9);
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(5);
    });
  });

  describe('setSeed', () => {
    it('resets the sequence when seed is changed', () => {
      const rng = new PRNG(42);
      const first = rng.next();

      rng.setSeed(42);
      const afterReset = rng.next();

      expect(first).toBe(afterReset);
    });

    it('produces different sequence after setSeed with different value', () => {
      const rng = new PRNG(42);
      const original = rng.next();

      rng.setSeed(999);
      const afterChange = rng.next();

      expect(original).not.toBe(afterChange);
    });
  });
});
