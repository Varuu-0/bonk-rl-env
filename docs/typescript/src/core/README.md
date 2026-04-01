# core/

Core engine modules that drive the Bonk.io physics simulation. These modules handle the Box2D simulation loop, Gymnasium-style environment API, deterministic PRNG, and multi-threaded worker pool.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [environment.md](environment.md) | `src/core/environment.ts` | Game environment state management, map loading, player lifecycle, episode reset, Gymnasium-compatible `step()`/`reset()` API |
| [physics-engine.md](physics-engine.md) | `src/core/physics-engine.ts` | Box2D wrapper providing synchronous `tick()`, body creation (rect/circle/polygon), collision filtering, lethal detection, grapple raycast, arena bounds |
| [prng.md](prng.md) | `src/core/prng.ts` | Deterministic pseudo-random number generator for reproducible rollouts — seedable `next()`, `nextInt()`, `nextRange()` methods |
| [worker-pool.md](worker-pool.md) | `src/core/worker-pool.ts` | Thread pool manager — spawns N worker threads, SharedArrayBuffer action/observation exchange, `stepSharedMemory()` / `stepMessage()` protocols, scaling to 128+ environments |
