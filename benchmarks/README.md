# Benchmarks

TypeScript performance benchmarking scripts for the Bonk.io RL Environment. Measure throughput, latency, and overhead at every layer of the stack.

## Benchmark Files

| File | Purpose | What It Measures |
|------|---------|------------------|
| `quick-2000-step.ts` | Quick baseline | Raw physics engine TPS vs `BonkEnvironment` SPS over 2,000 steps |
| `step-throughput.ts` | Detailed step throughput | `WorkerPool` SPS across env counts (1–16) with warmup |
| `bench-atomics.ts` | Atomics & memory latencies | `Atomics.wait`/`store`/`load`/`notify`, `TypedArray.set`, object alloc vs mutation |

## Running Benchmarks

```sh
# All core benchmarks (quick + throughput)
npm run bench:all

# Individual benchmarks
npm run bench:native        # quick-2000-step.ts
npm run bench:pool          # step-throughput.ts

# Benchmarks without npm scripts
npx tsx benchmarks/quick-2000-step.ts
npx tsx benchmarks/step-throughput.ts
npx tsx benchmarks/bench-atomics.ts
```

## Performance Targets

| Metric | Target | Benchmark |
|--------|--------|-----------|
| Physics engine TPS | > 25,000 | `quick-2000-step.ts` |
| BonkEnvironment SPS | > 15,000 | `quick-2000-step.ts` |
| WorkerPool 1-env SPS | > 8,000 | `step-throughput.ts` |
| WorkerPool 8-env SPS | > 3,000 | `step-throughput.ts` |
| Atomics.wait non-blocking | < 1μs | `bench-atomics.ts` |
| Object alloc overhead vs mutation | < 10x | `bench-atomics.ts` |

## Requirements

- Node.js >= 20.0.0
- `tsx` (TypeScript executor, installed via `devDependencies`)
