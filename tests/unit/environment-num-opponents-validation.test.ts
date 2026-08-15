/**
 * environment-num-opponents-validation.test.ts — Regression coverage for
 * issue #392.
 *
 * numOpponents >= 87 on the default WDB map used to exhaust the bundled
 * Box2D broadphase pair table (4096 slots) while reset() spawned the discs
 * at the co-located team spawn points, and addPlayer crashed with the
 * library-internal TypeError 'Cannot read properties of undefined (reading
 * 'next')'. normalizeNumOpponents now rejects finite values above
 * MAX_OPPONENTS, so construction fails with a labeled error naming the
 * parameter and the bound — before any world is built.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment, MAX_OPPONENTS } from '../../src/core/environment';
import { SharedMemoryManager } from '../../src/ipc/shared-memory';

const OPAQUE_BOX2D_ERROR = "reading 'next'";

function caughtMessage(fn: () => void): string {
    try {
        fn();
    } catch (err) {
        return String((err as Error).message);
    }
    throw new Error('expected the call to throw');
}

describe('BonkEnvironment numOpponents validation (#392)', () => {
    it(`rejects ${MAX_OPPONENTS + 23} opponents on the default map with a labeled error, not the Box2D TypeError`, () => {
        const message = caughtMessage(
            () => new BonkEnvironment({ numOpponents: MAX_OPPONENTS + 23, maxTicks: 5, seed: 1 }),
        );
        expect(message).toMatch(
            new RegExp(`Invalid numOpponents ${MAX_OPPONENTS + 23}: expected at most ${MAX_OPPONENTS} opponents`),
        );
        expect(message).not.toContain(OPAQUE_BOX2D_ERROR);
    });

    it(`rejects one opponent past the MAX_OPPONENTS bound`, () => {
        const message = caughtMessage(
            () => new BonkEnvironment({ numOpponents: MAX_OPPONENTS + 1, maxTicks: 5, seed: 1 }),
        );
        expect(message).toMatch(
            new RegExp(`Invalid numOpponents ${MAX_OPPONENTS + 1}: expected at most ${MAX_OPPONENTS} opponents`),
        );
        expect(message).not.toContain(OPAQUE_BOX2D_ERROR);
    });

    it('rejects the snake_case num_opponents alias above the bound', () => {
        const message = caughtMessage(
            () => new BonkEnvironment({ num_opponents: MAX_OPPONENTS + 1 } as any),
        );
        expect(message).toMatch(
            new RegExp(`Invalid numOpponents ${MAX_OPPONENTS + 1}: expected at most ${MAX_OPPONENTS} opponents`),
        );
    });

    it('mentions the bundled Box2D pair-table capacity in the error', () => {
        const message = caughtMessage(
            () => new BonkEnvironment({ numOpponents: MAX_OPPONENTS + 1 }),
        );
        expect(message).toContain('Box2D');
        expect(message).toContain('4096');
    });

    it(`accepts the MAX_OPPONENTS bound and steps normally`, () => {
        const env = new BonkEnvironment({ numOpponents: MAX_OPPONENTS, maxTicks: 2, seed: 1 });
        try {
            const obs = env.reset();
            expect(obs.opponents.length).toBe(MAX_OPPONENTS);
            env.step(0);
            expect(env.getObservationFast().length).toBe(16 + 6 * (MAX_OPPONENTS - 1));
        } finally {
            env.close();
        }
    });

    it('keeps in-range normalization behavior (flooring, defaults)', () => {
        expect(SharedMemoryManager.normalizeNumOpponents(MAX_OPPONENTS)).toBe(MAX_OPPONENTS);
        // An integral float at the bound floors into range and stays valid.
        expect(SharedMemoryManager.normalizeNumOpponents(MAX_OPPONENTS + 0.9)).toBe(MAX_OPPONENTS);
        expect(SharedMemoryManager.normalizeNumOpponents(3.9)).toBe(3);
        expect(SharedMemoryManager.normalizeNumOpponents(0)).toBe(0);
        expect(SharedMemoryManager.normalizeNumOpponents(-2)).toBe(0);
        expect(SharedMemoryManager.normalizeNumOpponents(null)).toBe(1);
        expect(SharedMemoryManager.normalizeNumOpponents(NaN)).toBe(1);
    });

    it('normalizeNumOpponents itself rejects out-of-range values with the labeled error', () => {
        expect(() => SharedMemoryManager.normalizeNumOpponents(MAX_OPPONENTS + 1))
            .toThrow(/Invalid numOpponents/);
        expect(() => SharedMemoryManager.floatsPerEnv(1e9))
            .toThrow(/Invalid numOpponents/);
    });

    it('fails fast at construction: no map file I/O is attempted for an invalid count', () => {
        // A bogus mapPath forces map load failure if the constructor runs it;
        // validation must throw before the file read, so the error still names
        // numOpponents instead of falling into the map-load fallback.
        const message = caughtMessage(
            () => new BonkEnvironment({
                numOpponents: MAX_OPPONENTS + 1,
                mapPath: 'definitely-missing-map.json',
            }),
        );
        expect(message).toMatch(/Invalid numOpponents/);
    });
});