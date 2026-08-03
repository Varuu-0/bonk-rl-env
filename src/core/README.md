# src/core/ — Core Simulation Engine

The heart of the Bonk.io RL environment. Contains the physics engine, RL environment wrapper, deterministic PRNG, and worker pool for parallel execution.

## Files

| File | Purpose |
|------|---------|
| `physics-engine.ts` | Synchronous Box2D wrapper — 30 TPS physics, player bodies, grapple joints, collision detection |
| `environment.ts` | `BonkEnvironment` class — Gymnasium-style `reset()` / `step(action)` API with reward calculation |
| `prng.ts` | Mulberry32 PRNG — deterministic seedable random number generation |
| `worker-pool.ts` | Manages a pool of child-process workers for parallel environment execution |
| `worker.ts` | Worker process entry point — runs physics loop in isolation |
| `worker-loader.js` | JavaScript loader for spawning worker processes |

## Key Constants

```typescript
TPS                 = 30        // Ticks per second
DT                  = 1/30      // Delta time per tick (0.0333s)
VELOCITY_ITERATIONS = 2         // Verified native low-quality velocity solver count
POSITION_ITERATIONS = 6         // Verified native position solver count
SCALE               = 30        // Exported map coordinate conversion for this JS port
DEFAULT_PPM         = 12        // Native default player ppm
MOVE_FORCE          = 12.0      // Native base movement force
HEAVY_FORCE_MULTIPLIER = 0.7    // Heavy reduces force; it does not change mass
GRAVITY_Y           = 20        // Native gravity in m/s²
OUT_OF_BOUNDS_DISTANCE = 850    // Circular boundary: 850 map units (world radius = 850 / SCALE)
MAX_TICKS           = 900       // 30 seconds at 30 TPS (truncation limit)
```

The installed `box2d` port accepts `Step(dt, iterations)` only. It therefore
cannot reproduce Bonk's separate native `Step(dt, 2, 6)` solver counts exactly.
Player radius is `ppm / SCALE`, not a fixed constant. The local simulator uses
the verified circular death boundary: the native rule `dist > 850 / ppm` is in
native world units (px/ppm), so the circle is exactly 850 map units for every
map; this port applies it as `850 / SCALE` world units, independent of ppm.

## Verified Contact Rules (DEOBFUSCATION BeginContact case 6)

| Rule | Engine API | Notes |
|------|-----------|-------|
| Same-team discs don't collide (`tea`) | `setTeamsEnabled(true)` + `setPlayerTeam(id, team)` | Enforced via per-disc category/mask bits: teams map to the native g1-g4 slots (red, blue, green, yellow) and a disc's mask excludes its own team bit. The port never calls `SetContactFilter` callbacks, so mask data is the enforcement path |
| No-collision mode (`nc`) | `setNoCollide(true)` | Removes all player bits from every disc mask |
| Swing destroy (`swingCollideDestroyEvents`) | automatic | A disc-disc contact while a grapple joint is active destroys the grapple after the step |
| Last-hit attribution (`lhid`/`lht`) | `getLastHit(playerId)` | Records both directions; `LAST_HIT_TIMER_TICKS = 120` (4s at 30 TPS); countdown runs before each Step |

`BonkEnvironment` exposes `teamsEnabled` and `noCollide` config options
(map-level `physics.teams` / `physics.nc` act as defaults).

The grapple reach is the verified 500 map units converted through this port's
exported-map coordinate scale (`500 / SCALE`; DEOBFUSCATION line 2531). The
native surface-point anchor and `disc.a1a` accumulation remain unresolved and
are intentionally not invented.

## Physics Pipeline

Each `tick()` advances the world through:

1. **Input Processing** — Apply forces from `PlayerInput` (left/right/up/down/heavy/grapple)
2. **Physics Step** — `world.Step(DT, 2, 6)` is requested; this port applies only the velocity count
3. **Observation Extraction** — Read player positions, velocities, angles, alive state
4. **Reward Calculation** — +1.0 for opponent kill, -1.0 for death, -0.001 time penalty
5. **Terminal Check** — Out-of-bounds death, lethal collision, or `MAX_TICKS` reached

## Key Exports

- `PhysicsEngine` — Core physics world wrapper
- `BonkEnvironment` — RL environment with `reset()`, `step()`, `getObservation()`, `close()`
- `PRNG` — Deterministic random number generator
- `WorkerPool` — Parallel environment execution manager
- Types: `PlayerInput`, `PlayerState`, `MapDef`, `MapBodyDef`, `Observation`, `StepResult`
