/**
 * prng.test.ts — Vitest test suite for PRNG
 */

import { describe, it, expect } from 'vitest';
import { PRNG } from '../../src/core/prng';

const UINT32_SIZE = 0x100000000;
const STATE_INCREMENT = 0x6D2B79F5;

function getState(prng: PRNG): number {
    return (prng as unknown as { a: number }).a;
}

function setState(prng: PRNG, state: number): void {
    (prng as unknown as { a: number }).a = state;
}

describe('PRNG', () => {
    describe('basic random generation', () => {
        it('generates numbers in [0,1)', () => {
            const prng = new PRNG(12345);
            const values: number[] = [];
            for (let i = 0; i < 100; i++) {
                values.push(prng.next());
            }
            expect(values.every(v => v >= 0 && v < 1)).toBe(true);
        });

        it('generates varied values', () => {
            const prng = new PRNG(12345);
            const values: number[] = [];
            for (let i = 0; i < 100; i++) {
                values.push(prng.next());
            }
            expect(new Set(values).size > 1).toBe(true);
        });
    });

    describe('determinism', () => {
        it('same seed produces identical sequences', () => {
            const prng1 = new PRNG(42);
            const prng2 = new PRNG(42);

            const seq1: number[] = [];
            const seq2: number[] = [];

            for (let i = 0; i < 100; i++) {
                seq1.push(prng1.next());
                seq2.push(prng2.next());
            }

            const identical = seq1.every((v, i) => v === seq2[i]);
            expect(identical).toBe(true);
        });

        it('matches the canonical Mulberry32 sequence without a warmup', () => {
            const prng = new PRNG(0);
            const expectedWords = [
                0x4434B462,
                0x00159C37,
                0x39285B08,
                0x256D8104,
                0x77A2CBD4,
                0x8B885631,
                0x9D811D5F,
                0xA623E7E6,
                0x74BCE381,
                0x94CAC42A,
            ];

            expect(expectedWords.map(() => prng.next())).toEqual(
                expectedWords.map(word => word / UINT32_SIZE)
            );
        });

        it('preserves the canonical sequence after setSeed', () => {
            const prng = new PRNG(999);
            prng.setSeed(42);

            const expectedWords = [
                0x99E1EF7C,
                0x72C32B8A,
                0xDA3B32C0,
                0xAB73B0AD,
                0x2CC09A8A,
            ];

            expect(expectedWords.map(() => prng.next())).toEqual(
                expectedWords.map(word => word / UINT32_SIZE)
            );
        });
    });

    describe('uint32 state', () => {
        it.each([
            [-1, 0xFFFFFFFF],
            [UINT32_SIZE + 42, 42],
            [(2 ** 40) + 123, 123],
        ])('normalizes seed %d to the same sequence as %d', (seed, normalizedSeed) => {
            const prng = new PRNG(seed);
            const normalized = new PRNG(normalizedSeed);

            expect(getState(prng)).toBe(normalizedSeed);
            expect(Array.from({ length: 20 }, () => prng.next())).toEqual(
                Array.from({ length: 20 }, () => normalized.next())
            );
        });

        it('normalizes setSeed values to uint32', () => {
            const prng = new PRNG(0);
            const normalized = new PRNG(42);

            prng.setSeed(UINT32_SIZE + 42);

            expect(getState(prng)).toBe(42);
            expect(Array.from({ length: 20 }, () => prng.next())).toEqual(
                Array.from({ length: 20 }, () => normalized.next())
            );
        });

        it('wraps the internal state after every step', () => {
            const prng = new PRNG(0xFFFFFFFF);

            prng.next();

            expect(getState(prng)).toBe((0xFFFFFFFF + STATE_INCREMENT) >>> 0);
        });

        it('preserves the final output before the legacy state loses precision', () => {
            const legacyStateBeforeFinalExactStep = 4_917_757 * STATE_INCREMENT;
            const prng = new PRNG(0);
            const normalized = new PRNG(legacyStateBeforeFinalExactStep >>> 0);
            setState(prng, legacyStateBeforeFinalExactStep);

            expect(prng.next()).toBe(normalized.next());
            expect(getState(prng)).toBe(getState(normalized));
        });

        it('normalizes a forced long-running state before precision can alter the wrap', () => {
            const legacyStateAtPrecisionBoundary = 4_917_758 * STATE_INCREMENT;
            const prng = new PRNG(0);
            const normalized = new PRNG(legacyStateAtPrecisionBoundary >>> 0);
            setState(prng, legacyStateAtPrecisionBoundary);

            expect((legacyStateAtPrecisionBoundary + STATE_INCREMENT) >>> 0).not.toBe(
                ((legacyStateAtPrecisionBoundary >>> 0) + STATE_INCREMENT) >>> 0
            );
            expect(prng.next()).toBe(normalized.next());
            expect(getState(prng)).toBe(getState(normalized));
        });
    });

    describe('different seeds', () => {
        it('different seeds produce different sequences', () => {
            const prng1 = new PRNG(100);
            const prng2 = new PRNG(200);

            const seq1: number[] = [];
            const seq2: number[] = [];

            for (let i = 0; i < 100; i++) {
                seq1.push(prng1.next());
                seq2.push(prng2.next());
            }

            const different = seq1.some((v, i) => v !== seq2[i]);
            expect(different).toBe(true);
        });
    });

    describe('nextInt validation', () => {
        it('throws when min > max', () => {
            const prng = new PRNG(123);
            expect(() => prng.nextInt(5, 2)).toThrow();
        });

        it('throws when the inclusive range exceeds the uint32 sample space', () => {
            const prng = new PRNG(123);
            expect(() => prng.nextInt(0, UINT32_SIZE)).toThrow(
                `Invalid range size: nextInt supports at most ${UINT32_SIZE} values`
            );
        });
    });

    describe('nextInt range', () => {
        it('all values in range [5,10]', () => {
            const prng = new PRNG(12345);
            const results: number[] = [];
            for (let i = 0; i < 1000; i++) {
                results.push(prng.nextInt(5, 10));
            }
            expect(results.every(v => v >= 5 && v <= 10)).toBe(true);
        });

        it('can produce minimum value (5)', () => {
            const prng = new PRNG(12345);
            const results: number[] = [];
            for (let i = 0; i < 1000; i++) {
                results.push(prng.nextInt(5, 10));
            }
            expect(results.includes(5)).toBe(true);
        });

        it('can produce maximum value (10)', () => {
            const prng = new PRNG(12345);
            const results: number[] = [];
            for (let i = 0; i < 1000; i++) {
                results.push(prng.nextInt(5, 10));
            }
            expect(results.includes(10)).toBe(true);
        });

        it('is deterministic with inclusive negative bounds', () => {
            const prng = new PRNG(42);

            expect(Array.from({ length: 10 }, () => prng.nextInt(-3, 3))).toEqual([
                0, -1, -3, 1, 3, -2, -1, -3, 3, 1,
            ]);
        });

        it('supports the full uint32-sized inclusive range', () => {
            const prng = new PRNG(0);

            expect(prng.nextInt(-0x80000000, 0x7FFFFFFF)).toBe(-0x3BCB4B9E);
        });

        it('deterministically rejects values in the incomplete high bucket', () => {
            const prng = new PRNG(1);

            expect(prng.nextInt(0, 0x80000000)).toBe(0x00B349C9);
            expect(prng.next()).toBe(0x8706C4EB / UINT32_SIZE);
        });
    });

    describe('setSeed', () => {
        it('setSeed resets state to produce same sequence', () => {
            const prng = new PRNG(100);
            const before = prng.next();
            prng.setSeed(100);
            const after = prng.next();
            expect(before).toBe(after);
        });
    });

    describe('edge cases', () => {
        it('handles negative range', () => {
            const prng = new PRNG(123);
            const neg = prng.nextInt(-10, -5);
            expect(neg >= -10 && neg <= -5).toBe(true);
        });

        it('single value range returns that value', () => {
            const prng = new PRNG(123);
            const single = prng.nextInt(5, 5);
            expect(single).toBe(5);
        });
    });
});
