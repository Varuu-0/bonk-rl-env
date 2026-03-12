/**
 * PRNG based on Mulberry32 for deterministic random number generation.
 */
export class PRNG {
    private a: number;

    constructor(seed: number) {
        // Mulberry32 requires the seed file to be well mixed, but we'll take any number
        // and do a quick hash to initialize 'a'
        this.a = seed;
    }

    /**
     * Set the seed
     */
    setSeed(seed: number): void {
        this.a = seed;
    }

    /**
     * Returns a float between 0 (inclusive) and 1 (exclusive)
     */
    next(): number {
        var t = this.a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    /**
     * Returns an integer between min and max (inclusive)
     */
    nextInt(min: number, max: number): number {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }
}
