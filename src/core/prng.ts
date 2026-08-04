const UINT32_SIZE = 0x100000000;
const STATE_INCREMENT = 0x6D2B79F5;

/**
 * PRNG based on Mulberry32 for deterministic random number generation.
 * 
 * This class implements the Mulberry32 algorithm, which is a fast, 
 * high-quality pseudorandom number generator suitable for applications 
 * requiring reproducible random sequences.
 *
 * next() always emits the canonical Mulberry32 sequence. nextInt() samples
 * integers without modulo bias; see nextInt() for how rejection sampling
 * affects stream consumption and backward-compatible outputs.
 */
export class PRNG {
    /** 
     * Internal state of the generator, a 32-bit unsigned integer.
     */
    private a: number;

    /**
     * Create a new PRNG instance with the given seed.
     * @param seed - The initial seed. It is normalized to a 32-bit unsigned integer.
     */
    constructor(seed: number) {
        // Canonical Mulberry32 uses the normalized seed directly, without a warmup.
        this.a = seed >>> 0;
    }

    /**
     * Reset the internal state to a new seed.
     * @param seed - The new seed value.
     */
    setSeed(seed: number): void {
        this.a = seed >>> 0;
    }

    /**
     * Generate the next pseudorandom number in the sequence.
     * @returns A floating-point number in the range [0, 1) (inclusive of 0, exclusive of 1).
     * 
     * The algorithm follows these steps:
     * 1. Increment the state by the constant 0x6D2B79F5.
     * 2. Apply a series of bitwise operations and multiplications to mix the state.
     * 3. Extract the final 32-bit value and convert it to a fraction.
     */
    next(): number {
        // Step 1: Update state in the uint32 ring to avoid long-run precision loss.
        let t = this.a = ((this.a >>> 0) + STATE_INCREMENT) >>> 0;
        
        // Step 2: First mixing step.
        t = Math.imul(t ^ t >>> 15, t | 1);
        
        // Step 3: Second mixing step.
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        
        // Step 4: Convert to unsigned 32-bit and then to double in [0, 1).
        return ((t ^ t >>> 14) >>> 0) / UINT32_SIZE;
    }

    /**
     * Generate the next pseudorandom integer in the inclusive range [min, max].
     * @param min - The lower bound (inclusive). Will be floored to an integer.
     * @param max - The upper bound (inclusive). Will be floored to an integer.
     * @returns An integer in the range [min, max] (inclusive).
     * 
     * Consumes exactly one raw 32-bit word when the inclusive range is a power
     * of two, and the returned values are then identical to the previous
     * float-scaled implementation. For every other range, rejection sampling
     * may consume additional words and the returned values intentionally
     * differ from the float-scaled implementation to remove modulo bias.
     * Because draw consumption is data-dependent for such ranges, interleaving
     * next() and nextInt() advances the shared stream by a variable number of
* words; next() itself always emits the canonical sequence.
 *
 * @throws {Error} If min is greater than max after flooring or the inclusive
     *                 range contains more than 2^32 values.
     */
    nextInt(min: number, max: number): number {
        // Convert min and max to integers by flooring.
        const _min = Math.floor(min);
        const _max = Math.floor(max);
        
        // Validate the range.
        if (_min > _max) {
            throw new Error(
                `Invalid range: min (${_min}) cannot be greater than max (${_max})`
            );
        }
        
        // Calculate the size of the range. One uint32 word can sample at most 2^32 values.
        const range = _max - _min + 1;
        if (!(range >= 1 && range <= UINT32_SIZE)) {
            throw new Error(
                `Invalid range size: nextInt supports at most ${UINT32_SIZE} values`
            );
        }

        // Powers of two evenly divide the uint32 space: one word is exactly
        // uniform, and mapping it to the high bits matches the legacy
        // float-scaled outputs exactly.
        if ((range & (range - 1)) === 0) {
            const value = this.next() * UINT32_SIZE;
            return Math.floor(value / (UINT32_SIZE / range)) + _min;
        }

        // Reject the incomplete high bucket so every result has the same number of preimages.
        const limit = UINT32_SIZE - (UINT32_SIZE % range);
        let value: number;
        do {
            value = this.next() * UINT32_SIZE;
        } while (value >= limit);

        return (value % range) + _min;
    }

    /**
     * Read the current internal state.
     *
     * Intended for tests and diagnostics; not part of the public API.
     * @internal
     */
    getState(): number {
        return this.a;
    }

    /**
     * Overwrite the internal state, normalized to a 32-bit unsigned integer.
     *
     * Intended for tests and diagnostics; not part of the public API.
     * @internal
     */
    setState(state: number): void {
        this.a = state >>> 0;
    }
}
