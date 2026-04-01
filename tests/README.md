# Tests

TypeScript test suites for the Bonk.io RL Environment. 361 test cases across 14 suites, 100% passing.

## Test Files

| File | Suite | Test Cases | Coverage |
|------|-------|------------|----------|
| `runner.ts` | Test runner | — | CLI runner with `pass`/`fail` output parsing and consolidated summary report |
| `bonk-env.test.ts` | Gymnasium API | 24 | `reset()`, `step()`, observation shape, reward, truncation, seeding |
| `collision-filtering.test.ts` | Collision group filtering | 33 | `collisionGroup`, `collisionMask`, group bitmasks, sensor interactions |
| `dynamic-arena-bounds.test.ts` | Dynamic arena bounds | 19 | `worldBoundary` expansion, shrink triggers, bounds recalculation |
| `env-manager.test.ts` | Pool management | 24 | `WorkerPool` init, multi-env dispatch, shared memory allocation |
| `frame-skip.test.ts` | Action repetition | 22 | `frameSkip` config, action carry-over, tick counting |
| `grapple-mechanics.test.ts` | Grapple & slingshot | 34 | `grapple` input, rope constraint, release impulse, direction vectors |
| `map-body-types.test.ts` | Map body types & properties | 34 | `rect`, `circle`, `polygon` bodies, `static`, `sensor`, density, friction |
| `map-integration.test.ts` | Real map file loading | 64 | `*.json` map parsing, body instantiation, collision groups from map data |
| `nophysics-friction.test.ts` | Sensor bodies & friction | 31 | `noPhysics` flag, `sensor` bodies, friction coefficient behavior |
| `physics-engine.test.ts` | Box2D physics | 25 | `addBody`, `addPlayer`, `tick`, gravity, velocity, angular motion |
| `prng.test.ts` | Deterministic RNG | 11 | `XorShift128`, determinism, seed replay, distribution |
| `shared-memory.ts` | Zero-copy IPC | 7 | `SharedArrayBuffer` action ring buffer, worker synchronization |

## Running Tests

```sh
# All tests (336 cases)
npm test

# Interactive runner (menu-based selection)
npm run test:runner

# List available suites
npm run test:list

# Individual suites
npm run test:physics        # suite 1  — Box2D physics
npm run test:prng           # suite 2  — Deterministic RNG
npm run test:env            # suite 3  — Gymnasium API
npm run test:frameskip      # suite 4  — Frame skip
npm run test:shared         # suite 5  — Shared memory
npm run test:manager        # suite 6  — Pool management
npm run test:map-types      # suite 7  — Map body types
npm run test:collision      # suite 8  — Collision filtering
npm run test:nophysics      # suite 9  — Sensor bodies & friction
npm run test:grapple        # suite 10 — Grapple mechanics
npm run test:bounds         # suite 11 — Dynamic arena bounds
npm run test:integration    # suite 12 — Real map loading
```

## Output Format

Each test file prints results in a parseable format:

```
+ test name              # pass
X test name              # fail
X test name: details     # fail with details
RESULTS: N passed, M failed
```

The runner aggregates all suite outputs into a consolidated summary with pass rates, timing analysis, and failure details.

## Requirements

- Node.js >= 20.0.0
- `tsx` (TypeScript executor, installed via `devDependencies`)
