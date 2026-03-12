/**
 * PRNG based on Mulberry32 for deterministic random number generation.
 * 
 * This class implements the Mulberry32 algorithm, which is a fast, 
 * high-quality pseudorandom number generator suitable for applications 
 * requiring reproducible random sequences.
 */
export class PRNG {
    /** 
     * Internal state of the generator, a 32-bit unsigned integer.
     */
    private a: number;

    /**
     * Create a new PRNG instance with the given seed.
     * @param seed - The initial seed. Any number can be used; the algorithm 
     *               will mix it sufficiently through its operations.
     */
    constructor(seed: number) {
        // Initialize state with the provided seed.
        // Note: The Mulberry32 algorithm does not require additional seeding 
        // steps beyond setting the initial state.
        this.a = seed;
    }

    /**
     * Reset the internal state to a new seed.
     * @param seed - The new seed value.
     */
    setSeed(seed: number): void {
        this.a = seed;
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
        // Step 1: Update state with the golden ratio-like constant.
        let t = this.a += 0x6D2B79F5;
        
        // Step 2: First mixing step.
        t = Math.imul(t ^ t >>> 15, t | 1);
        
        // Step 3: Second mixing step.
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        
        // Step 4: Convert to unsigned 32-bit and then to double in [0, 1).
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    /**
     * Generate the next pseudorandom integer in the inclusive range [min, max].
     * @param min - The lower bound (inclusive). Will be floored to an integer.
     * @param max - The upper bound (inclusive). Will be floored to an integer.
     * @returns An integer in the range [min, max] (inclusive).
     * 
     * @throws {Error} If min is greater than max after flooring.
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
        
        // Calculate the size of the range.
        const range = _max - _min + 1;
        
        // Generate a float in [0, 1), scale it to the range, and floor to get an integer.
        return Math.floor(this.next() * range) + _min;
    }
}