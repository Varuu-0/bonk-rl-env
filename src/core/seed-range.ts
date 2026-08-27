/**
 * seed-range.ts — The single supported seed domain shared by every seeding
 * surface (#460).
 *
 * The shared-memory reset path encodes real seeds as seed + 1 (0 is the
 * "no seed" sentinel), so a seed must fit in [0, 0xFFFFFFFE] for seed + 1 to
 * remain a representable uint32. The range has been enforced for BOTH pool
 * transports since #226; the direct BonkEnvironment boundary (constructor
 * seed slot + reset(seed)) now enforces the same domain so an invalid value
 * can no longer reach the PRNG's silent `>>> 0` bit-cast (negatives become
 * huge positives, values >= 2^32 wrap, fractions truncate) and silently
 * reseed onto a different stream than the caller requested (#460).
 */
export const MAX_SUPPORTED_RESET_SEED = 0xfffffffe;

/**
 * Throw unless `seed` is an integer in the supported domain
 * [0, MAX_SUPPORTED_RESET_SEED].
 *
 * `context` selects the labeled message: pool and direct-API resets share
 * the pool's exact wording ("... for reset") so a caller sees the same
 * error on every reset surface, while the constructor slot mirrors the
 * style of the existing constructor guards (maxTicks, frameSkip,
 * aiPlayerId).
 */
export function assertSupportedSeed(seed: number, context: 'reset' | 'constructor'): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SUPPORTED_RESET_SEED) {
    if (context === 'reset') {
      throw new Error(`Seed ${seed} out of supported range [0, ${MAX_SUPPORTED_RESET_SEED}] for reset`);
    }
    throw new Error(`Invalid seed ${seed}: expected an integer in [0, ${MAX_SUPPORTED_RESET_SEED}]`);
  }
}

/**
 * Derive the per-env pooled construction seed (#200/#460): configured seed
 * plus the global env index, wrapped into the supported domain.
 *
 * The wrap only engages for configured seeds within `offset` of the ceiling
 * (e.g. `init(4, { seed: MAX_SUPPORTED_RESET_SEED })` derives MAX, 0, 1, 2);
 * for every in-range base the result is the identity, so pooled construction
 * streams are byte-identical to the pre-#460 derivation there. Wrapping
 * (instead of clamping) keeps every derived seed distinct and inside
 * [0, MAX_SUPPORTED_RESET_SEED] — a clamp would hand the trailing
 * environments duplicate streams — and the derived value can never trip the
 * constructor's #460 guard, which still strictly validates the configured
 * base seed itself.
 */
export function deriveConstructionSeed(baseSeed: number, offset: number): number {
  return (baseSeed + offset) % (MAX_SUPPORTED_RESET_SEED + 1);
}
