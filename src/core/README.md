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
TPS              = 30        // Ticks per second
DT               = 1/30      // Delta time per tick (0.0333s)
SOLVER_ITERATIONS = 5        // Box2D constraint solver iterations
SCALE            = 30        // Physics scale: pixels → metres
ARENA_HALF_WIDTH = 25        // Arena half-width in metres
ARENA_HALF_HEIGHT = 20       // Arena half-height in metres
MAX_TICKS        = 900       // 30 seconds at 30 TPS (truncation limit)
MOVE_FORCE       = 8.0       // Newtons per input direction
PLAYER_RADIUS    = 0.5       // Player circle radius in metres
GRAVITY_Y        = 10        // Gravity in m/s²
```

## Physics Pipeline

Each `tick()` advances the world through:

1. **Input Processing** — Apply forces from `PlayerInput` (left/right/up/down/heavy/grapple)
2. **Physics Step** — `world.Step(DT, SOLVER_ITERATIONS)` advances by exactly 1/30s
3. **Observation Extraction** — Read player positions, velocities, angles, alive state
4. **Reward Calculation** — +1.0 for opponent kill, -1.0 for death, -0.001 time penalty
5. **Terminal Check** — Out-of-bounds death, lethal collision, or `MAX_TICKS` reached

## Key Exports

- `PhysicsEngine` — Core physics world wrapper
- `BonkEnvironment` — RL environment with `reset()`, `step()`, `getObservation()`, `close()`
- `PRNG` — Deterministic random number generator
- `WorkerPool` — Parallel environment execution manager
- Types: `PlayerInput`, `PlayerState`, `MapDef`, `MapBodyDef`, `Observation`, `StepResult`
