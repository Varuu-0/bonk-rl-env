# Documentation Index

## Quick Links

- **[Main README](../README.md)** - Full project documentation
- **[Telemetry](./telemetry.md)** - Performance monitoring system
- **[Configuration](./configuration.md)** - Setup and configuration
- **[Reward Functions](./reward-functions.md)** - Custom reward functions

## Getting Started

### Installation

```bash
# Clone and install
git clone https://github.com/Varuu-0/bonk-rl-env.git
cd bonk-rl-env
npm install

# Verify with type check
npm run typecheck
```

### Running the Server

```bash
# Start server (port 5555)
npm start

# Custom port
PORT=5556 npm start
```

### Running Tests

```bash
# Run all tests
npm test

# Interactive menu
npm run test:runner

# List available tests
npm run test:list

# Run specific tests
npm run test:physics    # Physics engine
npm run test:prng       # PRNG
npm run test:env        # Environment
npm run test:frameskip # Frame skip
npm run test:shared     # Shared memory
npm run test:shutdown   # Shutdown handlers
npm run test:telemetry  # Telemetry
npm run test:manager    # Env manager
```

## Test Suite

The project includes a comprehensive automated test suite with 14 test files covering all core functionality:

| # | Test File | Description |
|:--|:----------|:------------|
| 1 | `physics-engine.test.ts` | Box2D physics simulation |
| 2 | `prng.test.ts` | Deterministic RNG |
| 3 | `bonk-env.test.ts` | Gymnasium API |
| 4 | `frame-skip.test.ts` | Action repetition |
| 5 | `shared-memory.ts` | SharedArrayBuffer IPC |
| 6 | `shutdown.ts` | Signal handlers |
| 7 | `telemetry.ts` | Profiling system |
| 8 | `env-manager.test.ts` | Pool management |
| 9 | `map-body-types.test.ts` | Map body types (rect/circle/polygon) |
| 10 | `collision-filtering.test.ts` | Collision group filtering |
| 11 | `nophysics-friction.test.ts` | Sensor bodies and friction |
| 12 | `grapple-mechanics.test.ts` | Grapple and slingshot mechanics |
| 13 | `dynamic-arena-bounds.test.ts` | Dynamic arena bounds expansion |
| 14 | `map-integration.test.ts` | Real map loading and integration |

**Total: 361 individual test cases (361 passing, 100%)**

See [Test Runner](./typescript/tests/runner.md) for full documentation on the test execution framework, output parsing, and test file contract.

## Module Reference

### Python

| Module | Purpose |
|:-------|:--------|
| `bonk_env` | Gymnasium VecEnv wrapper |
| `training_logger` | Trajectory logging |
| `visualize_map` | Map visualization |
| `benchmark` | Performance testing |
| `reward_functions` | Custom reward functions |

### TypeScript

| Module | Purpose |
|:-------|:--------|
| `physics-engine` | Core Box2D physics |
| `environment` | Gymnasium-style API |
| `worker-pool` | Multi-threaded parallelism |
| `worker` | Worker thread implementation |
| `ipc-bridge` | ZeroMQ communication |
| `shared-memory` | Zero-copy IPC |
| `profiler` | Performance profiling |
| `telemetry-controller` | Telemetry management |

## Key Constants

| Constant | Value |
|:---------|:------|
| TPS | 30 |
| DT | 0.0333... |
| MAX_TICKS | 900 |
| HEAVY_MASS_MULTIPLIER | 3.0 |
| ARENA_HALF_WIDTH | 25m |
| ARENA_HALF_HEIGHT | 20m |

See [physics-engine docs](./typescript/src/core/physics-engine.md) for full constants list.

## Action Space

6 binary inputs (0-63):

| Bit | Action |
|:----|:-------|
| 0 | left |
| 1 | right |
| 2 | up |
| 3 | down |
| 4 | heavy |
| 5 | grapple |

## Observation Space

14-dimensional vector:

| Index | Field |
|:------|:------|
| 0-6 | Player state (x, y, vx, vy, angle, angularVel, isHeavy) |
| 7-12 | Opponent state (x, y, vx, vy, isHeavy, alive) |
| 13 | tick |

## Performance (Measured March 2026)

| Metric | Value |
|:-------|:------|
| Raw PhysicsEngine TPS | ~14,500 |
| WorkerPool SPS (N=1) | ~14,700 |
| WorkerPool Env-SPS (N=16) | ~80,600 |
| ZMQ IPC SPS (N=1) | 1,272 |
| ZMQ IPC SPM (N=1) | 76,313 |
| Telemetry Overhead | <0.02% of frame |

## See Also

- [Benchmarks](./python/benchmarks/benchmark.md) - Performance testing
- [Deprecated Features](./deprecated.md) - Legacy information
