/**
 * opponent-capacity.ts — Derived upper bound for `numOpponents` (#392).
 *
 * The bundled Box2D port (node_modules/box2d/box2dnode.js) allocates its
 * broadphase at world creation with fixed capacities:
 *
 *   b2_maxProxies = 512                          (proxy pool, line 45)
 *   b2_maxPairs   = 8 * b2_maxProxies = 4096     (pair table, line 46)
 *
 * Every AABB overlap in the world consumes one pair-table slot, and
 * `b2PairManager.AddPair` drains the free list with no bounds check —
 * once the 4096 slots are gone it dereferences `undefined` and throws the
 * opaque `TypeError: Cannot read properties of undefined (reading 'next')`.
 *
 * `BonkEnvironment.reset()` spawns the AI plus every opponent at the two
 * team spawn points, so the spawned discs start co-located and mutually
 * overlapping: D = numOpponents + 1 discs create D * (D - 1) / 2
 * disc-vs-disc pairs — a quadratic term that alone approaches the table
 * size at D = 90 (90 * 89 / 2 = 4005). On the default bundled WDB map
 * (40 map bodies) the table is deterministically exhausted between
 * numOpponents = 86 (OK) and numOpponents = 87 (crash); map bodies and
 * cap-zone sensors add a linear D-per-fixture term on top.
 *
 * MAX_OPPONENTS = 64 keeps the worst-case disc-vs-disc term for D = 65 at
 * 65 * 64 / 2 = 2080 — just under half the 4096-slot table — leaving at
 * least another 2080 slots (31+ per disc) for fixture pairs. Any map with
 * at most 31 fixtures overlapping the spawn area is therefore guaranteed
 * to fit, which every bundled/exported map satisfies comfortably, and the
 * bound sits below the empirically pinned 86-opponent ceiling of the
 * default map while staying far above real workloads (native bonk.io caps
 * rooms at 8 players).
 */
export const BOX2D_MAX_PROXIES = 512;
export const BOX2D_MAX_PAIRS = 4096;

export const MAX_OPPONENTS = 64;

/**
 * Labeled validation error for an out-of-range opponent count. Mirrors the
 * `Invalid environment count` wording used for numEnvs (#243/#390) so every
 * surface (direct API, worker pool, IPC client) reports the parameter name
 * and the supported range instead of the library-internal TypeError.
 */
export function numOpponentsError(value: number): Error {
    return new Error(
        `Invalid numOpponents ${value}: expected at most ${MAX_OPPONENTS} opponents ` +
        `(the bundled Box2D broadphase pair table is limited to ${BOX2D_MAX_PAIRS} pairs)`,
    );
}