# Benchmarks

Performance benchmarking scripts for the Bonk.io RL environment. Measure FPS, IPC latency, and end-to-end throughput (steps per second/minute) across different parallel environment counts.

## Files

| File | Purpose |
|------|---------|
| `benchmark.py` | General-purpose FPS benchmark across environment counts |
| `profile_ipc.py` | Detailed IPC latency and throughput profiling with per-phase breakdown |
| `throughput_benchmark.py` | End-to-end throughput measurement (SPS, SPM) with progress reporting |

## benchmark.py

Runs the environment at various parallel counts (1, 2, 4, 8, 16, 32, 64) and reports frames per second.

```bash
python benchmarks/benchmark.py
```

### Output

| Metric | Description |
|--------|-------------|
| `FPS` | Total physics steps per second |
| `Time` | Wall-clock time for 10,000 steps |
| `FPS/Core (est)` | Normalized FPS estimate per core |

## profile_ipc.py

Profiles the ZMQ IPC bridge with detailed per-phase timing breakdown:

- **Phase 1**: Bulk send+recv throughput (SPS)
- **Phase 2**: Single-step timing breakdown (send, recv, JSON parse, obs conversion, array building)
- **Phase 3**: Per-step timing with statistics (mean, median, P5, P95, min, max)
- **Phase 4**: Raw send/recv latency without response processing

```bash
python benchmarks/profile_ipc.py
```

### Configuration

Edit constants at the top of the file:

| Constant | Default | Description |
|----------|---------|-------------|
| `NUM_ENVS` | 2 | Number of parallel environments |
| `PORT` | 5555 | ZMQ port |
| `STEPS` | 200 | Iterations for bulk profiling |

## throughput_benchmark.py

Measures sustained throughput over a large number of steps with periodic progress reporting. Reports both steps per second (SPS) and steps per minute (SPM).

```bash
# Default: 500,000 steps per configuration
python benchmarks/throughput_benchmark.py

# Custom step count
python benchmarks/throughput_benchmark.py --steps 1000000
```

### Output

| Metric | Description |
|--------|-------------|
| `SPS` | Steps per second (batch steps, not env steps) |
| `SPM` | Steps per minute |
| `Total Env Steps` | SPS × num_envs |

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--steps` | 500000 | Max steps per configuration |

## Prerequisites

All benchmarks require the Node.js physics engine to be running:

```bash
npx tsx src/main.ts
```

Then run the benchmark script in a separate terminal.
