# Bonk.io Reinforcement Learning Environment

A high-performance, headless simulation engine for *Bonk.io*, designed specifically for reinforcement learning and automated agent training. This repository transforms the original multiplayer architecture into a synchronous, high-throughput environment capable of processing simulation steps at over 22,000 ticks per second natively, or 43,000+ env-steps per second through the shared memory worker pool at 16 parallel environments.

## Overview

This project decouples the core *Bonk.io* physics logic from the original multiplayer networking stack. By removing browser-based rendering and WebSocket bottlenecks, we have created a seedable, headless simulation loop. This allows machine learning agents to train in minutes rather than days, making it an ideal environment for testing PPO, DQN, or other reinforcement learning algorithms.

## Architecture

- **Worker Pool**: Operates as a Massively Parallel Vectorized Environment, dynamically scaling to use all available CPU cores via Node.js `worker_threads`.
- **Synchronous Loop**: Replaces real-time clocks with a synchronous `tick()` system and a deterministic PRNG. Explicit seeds reproduce rollouts on the same runtime and architecture; absent seeds intentionally randomize, and bit-exact cross-platform floating-point parity is not guaranteed.
- **Batch IPC Bridge**: Utilizes **ZeroMQ (ZMQ) ROUTER/DEALER** patterns for high-speed, batch communication between the TypeScript worker pool and the Python ML pipeline.
- **Vectorized Gymnasium API**: Implements the `stable_baselines3.common.vec_env.VecEnv` interface natively, allowing the Python agent to dispatch actions and aggregate observations across 64+ parallel environments simultaneously.

## Key Physics Constants (Verified)

| Constant | Value | Description |
|:---------|:------|:------------|
| TPS | 30 | Ticks per second |
| DT | 0.0333... | Time per tick (1/30s) |
| Gravity | 20 | Native downward gravity |
| Solver | 2 velocity / 6 position | Native low-quality solver request; installed port cannot apply separate position iterations |
| Player PPM | 12 | Native default player scale; radius is `ppm / SCALE` |
| Movement force | 12 | Native base movement force |
| Heavy | 0.7x force | Heavy does not change player mass |
| OOB radius | 850 map units (`850 / SCALE` world) | Native circular death boundary; native's `850/ppm` is in px/ppm world units so ppm cancels |
| MAX_TICKS | 900 | Max episode (30s at 30 TPS) |

## Features

- **Seeded Reproducibility**: Explicit seeds reproduce simulation results on the same runtime and architecture
- **Multi-threaded Parallelism**: Horizontal scaling across all available CPU cores
- **Gymnasium Compatible**: Native integration with stable-baselines3 and other Python RL frameworks
- **ZeroMQ Communication**: Low-latency message passing between Node.js and Python
- **Native Tick Rate**: Fixed 30 ticks per second, matching the verified Bonk.io simulation rate
- **Memory Efficient**: Typed arrays for observations, worker thread memory isolation

## SharedArrayBuffer Worker Pool (Optional Feature)

This implementation includes an optional **SharedArrayBuffer** mode for high-performance worker pool communication. This feature provides zero-copy inter-process communication between the main thread and worker threads.

### What It Does

The SharedArrayBuffer implementation enables **zero-copy IPC** between the main thread and worker threads. Instead of serializing and copying data through message passing, workers share a common memory region for exchanging environment states and actions.

### How It Works

The implementation uses JavaScript's `SharedArrayBuffer` combined with the `Atomics` API for synchronization:

- **Shared Memory Region**: A pre-allocated `SharedArrayBuffer` is shared between the main thread and all worker threads
- **Atomic Synchronization**: The `Atomics` API (specifically `Atomics.wait`, `Atomics.notify`, and `Atomics.store`/`Atomics.load`) provides lock-free synchronization between threads
- **Ring Buffer Protocol**: A ring buffer structure in shared memory allows efficient, non-blocking exchange of environment steps

### Benefits

- **Reduced Latency**: Eliminates serialization/deserialization overhead for each environment step
- **Lower Memory Usage**: Single buffer instead of per-message allocation
- **Improved Throughput**: Particularly beneficial when stepping many environments in parallel
- **Cache-Friendly**: Shared memory can be more cache-coherent than message passing

### How to Enable/Disable

Pass the `useSharedMemory` parameter when initializing the environment:

```typescript
// Enable SharedArrayBuffer (default: false)
const env = await init({
  numEnvs: 32,
  useSharedMemory: true  // Enable zero-copy IPC
});

// Disable SharedArrayBuffer (default behavior)
const env = await init({
  numEnvs: 32,
  useSharedMemory: false  // Use standard message passing
});
```

### Requirements

- **Browser Security**: SharedArrayBuffer requires specific HTTP headers for cross-origin isolation:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **Node.js Version**: Requires Node.js v12+ (v18+ recommended)
- **Platform Support**: Works on Windows, macOS, and Linux

If SharedArrayBuffer is not available (or headers not set), the system automatically falls back to standard `postMessage` communication.

### Worker and IPC Tuning

Worker-pool and ZeroMQ tuning can be supplied in `config.json`, through the
documented environment variables, or through CLI flags. Resolution order is
config file, environment, then CLI, with the highest-priority value winning.

| Setting | Environment | CLI | Default |
|:--------|:------------|:----|:--------|
| Worker count | `NUM_WORKERS` | `--num-workers` | auto-detect |
| Worker cap | `MAX_WORKERS` | `--max-workers` | `8` |
| Ring buffer | `RING_BUFFER_SIZE` | `--ring-buffer-size` | `16` |
| Message timeout | `MESSAGE_TIMEOUT_MS` | `--message-timeout-ms` | `30000` ms |
| Step timeout | `STEP_TIMEOUT_MS` | `--step-timeout-ms` | `5000` ms |
| ZMQ backlog | `ZMQ_BACKLOG` | `--zmq-backlog` | `100` |
| ZMQ send HWM | `SND_HWM` | `--snd-hwm` | `1000` |
| ZMQ receive HWM | `RCV_HWM` | `--rcv-hwm` | `1000` |
| ZMQ linger | `LINGER_MS` | `--linger-ms` | `1000` ms |
| TCP keepalive | `TCP_KEEPALIVE` | `--tcp-keepalive` | `0` |

`IpcBridge` applies the numeric ZeroMQ settings before binding its ROUTER
socket and reapplies them after a restart. The wire contract remains ROUTER
plus JSON; alternate `socketType` and `serialization` values are reserved
until a matching client protocol is available.

### Result Ownership

SharedArrayBuffer transport still uses pooled internal buffers, but public
`WorkerPool`, `BonkEnv`, and `EnvManager` reset/step results are caller-owned by
default. Retained observations therefore remain unchanged after later steps.

Allocation-sensitive code that consumes a result immediately can opt into the
pooled path with `{ ownership: 'borrowed' }`. Borrowed results must not be
retained or mutated and are invalidated by the next reset or step on that pool.
This option changes only result materialization; worker transport remains on
the same SharedArrayBuffer.

## Telemetry System

The Manifold Server includes a comprehensive telemetry system for monitoring performance, debugging issues, and analyzing simulation behavior. The system is designed with a **zero-overhead default** - telemetry is disabled by default and only activates when explicitly enabled.

### Flag-Based Activation

Telemetry is controlled via CLI flags. All flags are optional; the system defaults to maximum performance with all telemetry disabled.

#### CLI Flags

| Flag | Alias | Description | Default |
|:-----|:------|:------------|:--------|
| `--telemetry` | `-t` | Master switch to enable telemetry | `false` |
| `--profile` / `--profile-level` | `-l` | Profiling detail level: `minimal`, `standard`, `detailed` | `standard` |
| `--debug` | `-d` | Debug output level: `none`, `error`, `verbose` | `none` |
| `--output` | `-o` | Output format: `console`, `file`, `both` | `console` |
| `--dashboard-port` | — | HTTP port for telemetry dashboard | `3001` |
| `--report-interval` | — | Milliseconds between telemetry reports | `5000` |
| `--retention` | — | Days to retain telemetry data files | `7` |

#### Profile Levels

- **`minimal`**: Basic timing information only - minimal overhead
- **`standard`**: Includes per-worker statistics, tick rates, and throughput - recommended for production monitoring
- **`detailed`**: Full debug information including memory usage, IPC latency histograms, and detailed worker state

#### Debug Levels

- **`none`**: No debug output
- **`error`**: Errors and warnings only
- **`verbose`**: Full debug output including all telemetry events

### Environment Variables

Environment variables provide an alternative way to configure telemetry. They take precedence over CLI flags:

| Variable | Values | Description |
|:---------|:-------|:------------|
| `MANIFOLD_TELEMETRY` | `true`, `false`, `1`, `0`, `yes`, `no` | Enable/disable telemetry |
| `MANIFOLD_TELEMETRY_OUTPUT` | `console`, `file`, `both` | Output format |
| `MANIFOLD_PROFILE` | `minimal`, `standard`, `detailed` | Profile level |
| `MANIFOLD_DEBUG` | `none`, `error`, `verbose` | Debug level |

#### Precedence Order

Configuration priority (highest to lowest) for the server/config-loader settings
(`--port`, `--workers`, `--seed`, `--map`, telemetry flags, ...):

1. CLI flags
2. Environment variables
3. Config file settings
4. Default values

Note: `-p` is the short form of `--port` (server port) only — it is not a
telemetry alias. Use `--profile-level` or `-l` for the profiling level.

Telemetry-only settings additionally merge the `MANIFOLD_*` environment
variables after CLI parsing inside the telemetry controller, so for those
specific flags the environment takes precedence over the CLI.

### Usage Examples

#### Basic Usage - Enable Telemetry

```bash
# Enable telemetry with default settings
npx tsx src/main.ts --telemetry

# Short flag form
npx tsx src/main.ts -t
```

#### Production Monitoring

```bash
# Enable with standard profiling, output to file
npx tsx src/main.ts -t --profile standard --output file

# With custom dashboard port
npx tsx src/main.ts -t --dashboard-port 8080

# Less frequent reports for high-throughput scenarios
npx tsx tsx src/main.ts -t --report-interval 10000
```

#### Debugging Issues

```bash
# Enable verbose debug output
npx tsx src/main.ts -t --debug verbose

# Detailed profiling with console output
npx tsx src/main.ts -t --profile detailed --output console

# Both console and file for comprehensive debugging
npx tsx src/main.ts -t --profile detailed --debug verbose --output both
```

#### Environment Variable Usage

```bash
# Enable via environment variable (useful for containers)
export MANIFOLD_TELEMETRY=true
export MANIFOLD_PROFILE=standard
npx tsx src/main.ts

# Docker example
docker run -e MANIFOLD_TELEMETRY=true -e MANIFOLD_DEBUG=error manifold-server
```

### Performance Characteristics

The telemetry system is engineered for minimal performance impact:

| Profile Level | Overhead | Use Case |
|:-------------|:---------|:----------|
| Disabled | **0%** | Production, maximum performance |
| `minimal` | <1% | Lightweight monitoring |
| `standard` | 2-5% | Production monitoring, recommended |
| `detailed` | 5-10% | Debugging, development |

## Setup and Installation

### Prerequisites

- **Node.js**: v20.0.0 or higher
- **Python**: v3.10+ (for RL agent training)
- **npm** or **yarn**

### Installation

```bash
# Clone the repository
git clone https://github.com/Varuu-0/bonk-rl-env.git
cd bonk-rl-env

# Install Node.js dependencies
npm install

# Verify installation
npm run typecheck
```

### Quick Start

```bash
# Start the server (uses ZeroMQ IPC bridge on port 5555)
npm start

# Or with custom port
PORT=5556 npm start

# Stop with Ctrl+C (graceful shutdown)
```

## Shutdown and Signals

The server handles graceful shutdown across different platforms:

### Signal Handling

| Signal | Platform | Behavior |
|--------|----------|----------|
| SIGINT | Unix/macOS/Windows | Graceful shutdown (Ctrl+C) |
| SIGTERM | Unix/macOS | Graceful shutdown |
| SIGBREAK | Windows | Graceful shutdown (Ctrl+Break) |

### How It Works

1. **Signal Detection**: The `registerShutdownHandlers()` function in `src/main.ts` registers handlers for all relevant signals
2. **Idempotent Registration**: Multiple calls to `registerShutdownHandlers()` won't register duplicate handlers
3. **Resource Cleanup**: On shutdown, the IPC bridge and readline interfaces are properly closed
4. **Timeout Protection**: A 10-second timeout ensures forced exit if graceful shutdown hangs

### Using Scripts

#### Unix/macOS/Linux

```bash
# Start server
./scripts/start-server.sh [port]

# Stop server
./scripts/stop-server.sh
```

#### Windows PowerShell

```powershell
# Start server on custom port
.\scripts\Start-BonkServer.ps1 -Port 5555

# Stop server
.\scripts\Stop-BonkServer.ps1
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5555 | IPC bridge port |
| MANIFOLD_TELEMETRY | false | Enable telemetry |
| MANIFOLD_PROFILE | standard | Profile level |

## Running Tests

The test suite uses Vitest. The legacy runner aliases remain available for
interactive selection and listing:

```bash
# Run all tests (default)
npm test

# Compatibility runner (interactive in a TTY, full suite otherwise)
npm run test:runner

# List all available tests
npm run test:list

# Run specific test categories
npm run test:physics      # tests/unit/physics-engine.test.ts
npm run test:prng         # tests/unit/prng.test.ts
npm run test:env          # tests/integration/bonk-env.test.ts
npm run test:frameskip    # tests/integration/frame-skip.test.ts
npm run test:shared       # tests/integration/shared-memory.test.ts
npm run test:manager      # tests/integration/env-manager.test.ts
npm run test:map-types    # tests/integration/map-body-types.test.ts
npm run test:collision    # tests/integration/collision-filtering.test.ts
npm run test:nophysics    # tests/integration/nophysics-friction.test.ts
npm run test:grapple      # tests/integration/grapple-mechanics.test.ts
npm run test:bounds       # tests/integration/dynamic-arena-bounds.test.ts
npm run test:integration  # all tests/integration/ suites

# Type check
npm run typecheck
```

### Test Suite Overview

| # | Test File | Description | Test Cases |
|:--|:----------|:------------|:-----------|
| 1 | `physics-engine.test.ts` | Box2D physics simulation | 25 |
| 2 | `prng.test.ts` | Deterministic RNG | 11 |
| 3 | `bonk-env.test.ts` | Gymnasium API | 24 |
| 4 | `frame-skip.test.ts` | Action repetition | 22 |
| 5 | `shared-memory.ts` | Zero-copy IPC | 7 |
| 6 | `env-manager.test.ts` | Pool management | 24 |
| 7 | `map-body-types.test.ts` | Map body types & properties | 34 |
| 8 | `collision-filtering.test.ts` | Collision group filtering | 33 |
| 9 | `nophysics-friction.test.ts` | Sensor bodies & friction | 31 |
| 10 | `grapple-mechanics.test.ts` | Grapple & slingshot | 34 |
| 11 | `dynamic-arena-bounds.test.ts` | Dynamic arena bounds | 19 |
| 12 | `map-integration.test.ts` | Real map file loading (WDB map) | 72 |

**Total: 284 test cases across 12 test suites (99.3% passing)**

## Local CI/CD Pipeline

The repository ships an exhaustive local CI/CD engine (`scripts/local-ci.ts`) that verifies every layer of the project — static quality, physics fidelity, worker pool IPC, the Python RL stack, the detached renderer, security/property fuzzing, and benchmark SLAs — before code is committed or pushed. Git hooks run the pipeline automatically (`pre-commit` → Tier 1, `pre-push` → Tier 2).

| Command | Tier | What it runs |
|---------|------|--------------|
| `npm run ci:quick` | 1 — pre-commit | Staged-file prettier check, webscript DOM ID validation, ruff, `tsc --noEmit`, unit tests |
| `npm run ci` | 2 — pre-push | Full prettier check (changed vs `origin/main`), all Vitest suites (unit + integration + perf + security + property), pytest, typecheck, differential fidelity gates |
| `npm run ci:full` | 3 — E2E | Tier 2 + live ZeroMQ E2E server/client integration suite |
| `npm run ci:bench` | 4 — benchmarks | Layer 1–6 benchmarks with SLA regression enforcement (`--layer7` adds the Python IPC roundtrip check) |
| `npm run format:check` | — | Prettier check on changed files (vs `origin/main`; `--staged` for staged-only) |
| `npm run format:fix` | — | Auto-format changed files with prettier |

### Flags

```
npm run ci -- --fix          # auto-format + ruff --fix instead of checking
npm run ci -- --verbose      # stream raw child output
npm run ci -- --no-python    # skip ruff/pytest (e.g. CI without Python)
npm run ci:bench -- --layer7 # include the Python IPC roundtrip benchmark
```

PowerShell and bash entry points forward the same flags: `./scripts/Invoke-LocalCI.ps1 --quick`, `./scripts/local-ci.sh --standard`.

The benchmark tier enforces the SLA regression table: raw physics ≥ 18,000 TPS, environment ≥ 22,000 SPS, 16-env worker pool ≥ 32,000 env-SPS, ≤ 10 MB heap growth over 50K steps, ≤ 3 MB over 200 resets, and < 15% long-run throughput variance. Any regression exits non-zero with actionable diffs.

The fail limits are authored against reference hardware (the April 2026 benchmark table above). Machines with materially different threading primitives — notably Windows, where `Atomics.wait`/`notify` round-trips cost several times more than on Linux — can tune the regression boundary via environment variables without touching the defaults:

| Variable | Default | Check |
|----------|---------|-------|
| `CI_BENCH_L1_FAIL_LATENCY_MS` | `0.005` | Atomics read/write latency |
| `CI_BENCH_L2_FAIL_TPS` | `18000` | Raw physics throughput |
| `CI_BENCH_L3_FAIL_SPS` | `22000` | Environment step throughput |
| `CI_BENCH_L4_FAIL_ENV_SPS` | `32000` | 16-env worker pool aggregate |
| `CI_BENCH_L5_FAIL_HEAP_MB` | `10` | 50K-step heap growth |
| `CI_BENCH_L5_RESET_FAIL_MB` | `3` | 200-reset heap growth |
| `CI_BENCH_L6_FAIL_CV_PCT` | `15` | Long-run throughput variance |

Hooks can be bypassed with `git commit --no-verify` / `git push --no-verify` or `LOCAL_CI_SKIP=1`.

## Performance Benchmarks

Measured on a standard development machine (April 2026). All benchmarks use 2000 steps with warmup.
See [PERFORMANCE.md](docs/PERFORMANCE.md) for the full detailed performance report.

### Running Benchmarks

```bash
# Run all benchmarks with consolidated report
npm run bench:all

# List available benchmark layers
npm run bench:list

# Run individual layers
npm run bench:layer1    # Primitives: Atomics, TypedArray latencies
npm run bench:layer2    # Raw Physics: Box2D tick throughput
npm run bench:layer3    # Environment: step throughput (no IPC)
npm run bench:layer4    # Worker Pool: SharedArrayBuffer IPC scaling
npm run bench:layer5    # Memory: heap stability and reset leaks
npm run bench:layer6    # Stability: long-running throughput variance
```

### Native TypeScript Throughput

| Metric | Value |
|--------|-------|
| Raw PhysicsEngine TPS | 22,612 |
| BonkEnvironment SPS (1 AI + 1 opponent) | 28,255 |
| BonkEnvironment SPS (frameSkip=3) | 68,565 |
| WorkerPool SPS (N=1 env) | 15,252 |
| WorkerPool Env-SPS (N=16 envs) | 43,487 |
| Peak sustained (100K steps) | 615,526 SPS |

### Worker Pool Scaling (Shared Memory)

| N (Envs) | SPS (per-env) | Env-SPS (aggregate) | Latency |
|:---------|:-------------|:--------------------|:--------|
| 1 | 15,252 | 15,252 | 0.066 ms |
| 2 | 8,303 | 16,607 | 0.120 ms |
| 4 | 6,813 | 27,251 | 0.147 ms |
| 8 | 4,780 | 38,238 | 0.209 ms |
| 16 | 2,718 | 43,487 | 0.368 ms |

### Memory Stability

| Test | Result | Notes |
|------|--------|-------|
| Step loop (50K steps) | 2.18 MB growth | Stable — GC collects objects |
| Reset cycles (200 resets) | -0.33 MB growth | No leak — engine reuse on reset |

### Telemetry Overhead

| Configuration | Overhead | % of 33.3ms Frame |
|:-------------|:--------:|:-----------------:|
| Disabled | 0% | 0% |
| Minimal | ~1,269 ns/tick | 0.004% |
| Full (all 5 indices) | ~4,286 ns/tick | 0.013% |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - See LICENSE file for details.
