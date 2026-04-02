# Benchmarks

TypeScript and Python benchmarking suite for the Bonk.io RL Environment. Each layer isolates a specific part of the pipeline so you can see exactly where overhead comes from.

## Architecture

```
Layer 1: Primitives          Atomics, TypedArray, object alloc latencies
Layer 2: Raw Physics         PhysicsEngine.tick() in isolation (Box2D only)
Layer 3: Environment         BonkEnvironment.step() (physics + obs + reward)
Layer 4: Worker Pool         WorkerPool.step() via SharedArrayBuffer IPC
Layer 5: Memory              Heap stability and reset cycle leak detection
Layer 6: Stability           100K-step sustained throughput variance (CV)
Layer 7: IPC (Python)        Full ZMQ end-to-end: Python → TS → workers → back
```

## Quick Start

```sh
# Run all TypeScript benchmarks with consolidated report
npm run bench:all

# Run a single layer
npm run bench:layer1    # primitives
npm run bench:layer2    # raw physics
npm run bench:layer3    # environment
npm run bench:layer4    # worker pool
npm run bench:layer5    # memory
npm run bench:layer6    # stability

# Run with runner directly (supports layer numbers)
npx tsx benchmarks/runner.ts all
npx tsx benchmarks/runner.ts 2
npx tsx benchmarks/runner.ts --list

# Python benchmarks (requires running server)
npm run bench:layer7        # IPC throughput (10K steps)
npm run bench:ipc-stress    # IPC stress (500K steps)
npm run bench:ipc-profile   # IPC latency decomposition
```

## Layers

### Layer 1 — Primitives (`layer1-primitives.ts`)
Micro-benchmarks for the atomic operations that underpin shared memory IPC.
Measures latency of `Atomics.wait`, `store`, `load`, `notify`, `TypedArray.set`,
object allocation vs mutation, and the `sendCommand` cycle.

### Layer 2 — Raw Physics (`layer2-physics.ts`)
Isolates the Box2D physics engine by calling `PhysicsEngine.tick()` in a tight
loop. No environment wrapper, no observation extraction, no reward calculation.
This is the theoretical maximum throughput of the simulation core.

### Layer 3 — Environment (`layer3-environment.ts`)
Measures `BonkEnvironment.step()` which includes physics tick, observation
extraction, reward calculation, and action decoding. No worker threads or IPC.
Tests both default and frame-skip configurations.

### Layer 4 — Worker Pool (`layer4-worker-pool.ts`)
Tests `WorkerPool.step()` with SharedArrayBuffer IPC across N=1,2,4,8,16
environments. This is the TypeScript multi-env path with Atomics synchronization.

### Layer 5 — Memory (`layer5-memory.ts`)
Runs 50K steps and monitors heap growth, peak RSS, and GC effectiveness.
Also stress-tests 200 reset cycles to detect memory leaks from repeated
environment creation/destruction.

### Layer 6 — Stability (`layer6-stability.ts`)
Runs 100K steps with per-segment reporting to measure throughput variance.
Reports coefficient of variation (CV) — a high CV indicates GC pauses or
JIT deoptimization causing performance instability.

### Layer 7 — IPC (Python) (`python/benchmarks/layer7-*.py`)
Full end-to-end benchmarks over ZMQ. Requires the TypeScript server running
on port 5555. `layer7-ipc-throughput.py` measures SPS/SPM scaling.
`layer7-ipc-latency.py` decomposes IPC into send/recv/parse/convert phases.
`layer7-ipc-stress.py` runs 500K steps for sustained throughput measurement.

## Output

Each layer outputs structured JSON to `benchmarks/results/layerN.json` and
prints a human-readable summary. The runner (`benchmarks/runner.ts`) collects
all layer outputs and produces a consolidated report with pass/fail status
and key metrics per layer.

## Performance Targets

| Layer | Metric | Target |
|:------|:-------|:-------|
| 1 | Atomics.wait non-blocking | < 10 us |
| 1 | Object alloc (obs-like) | < 1 us |
| 2 | PhysicsEngine TPS | > 15,000 |
| 3 | BonkEnvironment SPS | > 30,000 |
| 4 | WorkerPool SPS (N=1) | > 2,000 |
| 5 | Heap growth (50K steps) | < 5 MB |
| 6 | Throughput CV (100K steps) | < 10% |

## Requirements

- Node.js >= 20.0.0
- `tsx` (installed via devDependencies)
- Python 3.8+ with `pyzmq`, `gymnasium`, `numpy` (Layer 7 only)
- Running TypeScript server (Layer 7 only): `npm start`
