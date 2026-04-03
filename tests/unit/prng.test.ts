/**
 * prng.test.ts — Vitest test suite for PRNG
 */

import { describe, it, expect } from 'vitest';
import { PRNG } from '../../src/core/prng';

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
