# Benchmarks

TypeScript performance benchmarking scripts for the Bonk.io RL Environment. Measure throughput, latency, and overhead at every layer of the stack.

## Benchmark Files

| File | Purpose | What It Measures |
|------|---------|------------------|
| `quick-2000-step.ts` | Quick baseline | Raw physics engine TPS vs `BonkEnvironment` SPS over 2,000 steps |
| `step-throughput.ts` | Detailed step throughput | `WorkerPool` SPS across env counts (1–16) with warmup |
| `step-throughput-40k.ts` | High-volume stress test | 40K steps per config (1–128 envs), scaling efficiency analysis |
| `diagnose-ipc.ts` | IPC latency diagnosis | Layered breakdown: direct env → worker pool → IPC bridge → full ZMQ round-trip |
| `telemetry.ts` | Telemetry overhead | Nanosecond overhead per tick of the profiling system, frame budget impact |
| `bench-atomics.ts` | Atomics & memory latencies | `Atomics.wait`/`store`/`load`/`notify`, `TypedArray.set`, object alloc vs mutation |
| `bench-pool-phases.ts` | Pool phase breakdown | Per-step overhead vs theoretical physics minimum across 1–128 envs |
| `profile-step.ts` | Step timing profile | End-to-end step latency per env count (1–32) |

## Running Benchmarks

```sh
# All core benchmarks (quick + throughput + telemetry)
npm run bench:all

# Individual benchmarks
npm run bench:native        # quick-2000-step.ts
npm run bench:pool          # step-throughput.ts
npm run bench:diagnose      # diagnose-ipc.ts
npm run bench:telemetry     # telemetry.ts

# Benchmarks without npm scripts
npx tsx benchmarks/quick-2000-step.ts
npx tsx benchmarks/step-throughput.ts
npx tsx benchmarks/step-throughput-40k.ts
npx tsx benchmarks/diagnose-ipc.ts
npx tsx benchmarks/telemetry.ts
npx tsx benchmarks/bench-atomics.ts
npx tsx benchmarks/bench-pool-phases.ts
npx tsx benchmarks/profile-step.ts
```

## Performance Targets

| Metric | Target | Benchmark |
|--------|--------|-----------|
| Physics engine TPS | > 25,000 | `quick-2000-step.ts` |
| BonkEnvironment SPS | > 15,000 | `quick-2000-step.ts` |
| WorkerPool 1-env SPS | > 8,000 | `step-throughput.ts` |
| WorkerPool 8-env SPS | > 3,000 | `step-throughput.ts` |
| 40K scaling efficiency (8 envs) | > 60% | `step-throughput-40k.ts` |
| ZMQ round-trip latency | < 2ms | `diagnose-ipc.ts` |
| Telemetry overhead per tick | < 1% of 33ms frame | `telemetry.ts` |
| Atomics.wait non-blocking | < 1μs | `bench-atomics.ts` |
| Object alloc overhead vs mutation | < 10x | `bench-atomics.ts` |

## IPC Diagnosis Layers

`diagnose-ipc.ts` tests each layer of the IPC stack to isolate overhead:

| Layer | Description |
|-------|-------------|
| 0 | Direct `BonkEnvironment` (pure physics + env wrapper) |
| 1 | `WorkerPool` 1 env (shared memory, worker thread) |
| 2 | `WorkerPool` 2 envs (shared memory, worker thread) |
| 3 | `IpcBridge.stepEnv` (bridge overhead, no ZMQ) |
| 4 | Full ZMQ step round-trip (serialize + ZMQ + bridge + pool) |
| 5 | ZMQ echo round-trip (serialize + ZMQ + parse only) |

## Requirements

- Node.js >= 20.0.0
- `tsx` (TypeScript executor, installed via `devDependencies`)
