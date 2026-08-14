# Tests

TypeScript test suites for the Bonk.io RL Environment. 361 test cases across 14 suites, 100% passing.

## Test Files

| File | Suite | Test Cases | Coverage |
|------|-------|------------|----------|
| `runner.ts` | Test runner | — | Compatibility CLI that delegates to Vitest and preserves the legacy runner commands |
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

# Compatibility runner (interactive in a TTY, full suite otherwise)
npm run test:runner

# List available suites
npm run test:list

# Individual suites
npm run test:physics        # tests/unit/physics-engine.test.ts
npm run test:prng           # tests/unit/prng.test.ts
npm run test:env             # tests/integration/bonk-env.test.ts
npm run test:frameskip       # tests/integration/frame-skip.test.ts
npm run test:shared          # tests/integration/shared-memory.test.ts
npm run test:manager         # tests/integration/env-manager.test.ts
npm run test:map-types       # tests/integration/map-body-types.test.ts
npm run test:collision       # tests/integration/collision-filtering.test.ts
npm run test:nophysics       # tests/integration/nophysics-friction.test.ts
npm run test:grapple         # tests/integration/grapple-mechanics.test.ts
npm run test:bounds          # tests/integration/dynamic-arena-bounds.test.ts
npm run test:integration     # all tests/integration/ suites
```

## Output

Vitest prints the test results and controls the exit code. The compatibility
runner delegates directly to Vitest, so it no longer parses the output or
produces a separate consolidated report.

## Requirements

- Node.js >= 20.0.0
- `tsx` (TypeScript executor, installed via `devDependencies`)
