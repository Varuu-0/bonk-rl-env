# `throughput_benchmark` Module

## Overview

The `throughput_benchmark` module provides a long-running throughput measurement tool for the Bonk.io reinforcement learning environment. It benchmarks aggregate steps-per-second across different parallel environment configurations over extended run durations.

## Module: `python.benchmarks.throughput_benchmark`

**Source File**: `python/benchmarks/throughput_benchmark.py`

---

## Function: `run_throughput_benchmark`

Runs a single throughput benchmark with a specified number of parallel environments over a configurable number of steps.

```python
def run_throughput_benchmark(num_envs, max_steps=500000) -> Optional[dict]
```

### Parameters

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `num_envs` | `int` | - | Number of parallel environments to test. |
| `max_steps` | `int` | `500000` | Maximum number of steps to execute per configuration. |

### Returns

| Type | Description |
|:-----|:------------|
| `dict` or `None` | Dictionary containing throughput results, or `None` if the benchmark failed. |

### Return Value Structure

```python
{
    "N": int,               # Number of environments
    "steps": int,           # Steps executed
    "total_env_steps": int, # steps × num_envs
    "duration_s": float,    # Wall-clock seconds
    "sps": float,           # Steps per second (aggregate throughput)
    "spm": float,           # Steps per minute
}
```

### Example

```python
result = run_throughput_benchmark(num_envs=16, max_steps=500000)
print(result)
# {'N': 16, 'steps': 500000, 'total_env_steps': 8000000, 'duration_s': 27.86, 'sps': 17950.23, 'spm': 1077013.8}
```

---

## Function: `main`

The main entry point for the throughput benchmark. Runs benchmarks across multiple environment configurations with progress reporting and a final summary table.

```python
def main()
```

### Description

Executes benchmarks for the following environment counts: 1, 2, 4, 8, 16, 32, 64

Each benchmark:
1. Creates a `BonkVecEnv` with N parallel environments
2. Runs up to `max_steps` steps
3. Reports progress every ~10% or 50,000 steps
4. Calculates aggregate throughput (SPS / SPM)
5. Applies a 2-second cooldown between configurations

### Arguments

| Argument | Type | Default | Description |
|:---------|:-----|:--------|:------------|
| `--steps` | `int` | `500000` | Maximum steps per benchmark configuration. |

### Default Configuration

| Parameter | Value | Description |
|:----------|:------|:------------|
| `bench_configs` | `[1, 2, 4, 8, 16, 32, 64]` | Environment counts to benchmark |
| `max_steps` | `500,000` | Steps per benchmark run |
| `cooldown` | `2 seconds` | Delay between configurations |
| `progress_interval` | `~10% or 50K steps` | Frequency of progress reports |

### Output Format

```
=== Bonk RL Throughput Benchmark ===
Max Steps: 500,000 | Environments: [1, 2, 4, 8, 16, 32, 64] | Cooldown: 2s

Benchmarking N=1 (500,000 steps)...
  [10.0%] 50,000 steps | SPS: 3,145.2 | Elapsed: 15.90s
  [20.0%] 100,000 steps | SPS: 3,152.8 | Elapsed: 31.72s
  ...
  Completed: 500,000 steps in 158.42s | SPS: 3,156.18 | SPM: 189,370.92

[Cooldown 2s]
...

Benchmark Summary:
  N |   Steps | Total Env Steps | Duration (s) |        SPS |          SPM
---------------------------------------------------------------------------
  1 | 500,000 |         500,000 |      158.42  |   3,156.18 |   189,370.92
  2 | 500,000 |       1,000,000 |       80.11  |   6,241.42 |   374,485.20
 ...
```

### Metrics Explained

| Metric | Description |
|:-------|:------------|
| `N` | Number of parallel environments |
| `Steps` | Total steps executed in the benchmark run |
| `Total Env Steps` | Aggregate environment steps (steps × N) |
| `Duration (s)` | Wall-clock time in seconds to complete the run |
| `SPS` | Steps per second — aggregate throughput across all environments |
| `SPM` | Steps per minute (SPS × 60) |
| `Progress %` | Percentage of max_steps completed at time of report |
| `Elapsed` | Cumulative wall-clock time at time of progress report |

---

### Usage

```bash
# Run with default 500,000 steps (backend must be running)
python python/benchmarks/throughput_benchmark.py

# Run with custom step count
python python/benchmarks/throughput_benchmark.py --steps 1000000
```

### Prerequisites

- Node.js backend must be running
- Port 5555 must be available

### Performance Expectations

| N (Envs) | Expected SPS | Expected SPM | Notes |
|:---------|:-------------|:-------------|:------|
| 1 | 3,000-4,000 | 180,000-240,000 | Baseline single-threaded |
| 2 | 5,000-6,000 | 300,000-360,000 | Near-linear scaling |
| 4 | 8,000-10,000 | 480,000-600,000 | Good parallelization |
| 8 | 12,000-15,000 | 720,000-900,000 | Diminishing returns begin |
| 16 | 16,000-20,000 | 960,000-1,200,000 | Moderate scaling |
| 32 | 20,000-23,000 | 1,200,000-1,380,000 | Approaching ceiling |
| 64 | 22,000-24,000 | 1,320,000-1,440,000 | Maximum throughput |

### Sample Results

```
Benchmark Summary:
  N |   Steps | Total Env Steps | Duration (s) |        SPS |          SPM
---------------------------------------------------------------------------
  1 | 500,000 |         500,000 |      158.42  |   3,156.18 |   189,370.92
  2 | 500,000 |       1,000,000 |       80.11  |   6,241.42 |   374,485.20
  4 | 500,000 |       2,000,000 |       58.58  |   8,533.98 |   512,038.80
  8 | 500,000 |       4,000,000 |       38.97  |  12,829.85 |   769,791.00
 16 | 500,000 |       8,000,000 |       27.86  |  17,950.23 | 1,077,013.80
 32 | 500,000 |      16,000,000 |       22.82  |  21,917.79 | 1,315,067.40
 64 | 500,000 |      32,000,000 |       21.32  |  23,460.06 | 1,407,603.60
```

---

### Customizing Benchmarks

```bash
# Longer benchmark for more stable results
python python/benchmarks/throughput_benchmark.py --steps 2000000

# Quick check with fewer steps
python python/benchmarks/throughput_benchmark.py --steps 100000
```

---

### Interpreting Results

#### Scaling Efficiency

| Scaling | Description |
|:--------|:------------|
| Linear (N×) | Ideal scaling, SPS increases proportionally with N |
| Sub-linear | Normal for parallel workloads due to synchronization overhead |
| Flat | Indicates bottleneck (likely IPC or worker pool saturation) |

#### Common Patterns

1. **Initial linear scaling**: Up to ~8-16 environments
2. **Diminishing returns**: Beyond 16-32 environments
3. **Plateau**: At 64+ environments (hardware limit)

#### Identifying Bottlenecks

- **If SPS doesn't increase with N**: IPC bottleneck (ZeroMQ)
- **If SPS plateaus early**: Worker pool saturation
- **If duration scales linearly with N**: Per-step overhead dominates
- **If progress reports show inconsistent SPS**: System noise or thermal throttling

---

### Comparison with `benchmark.py`

| Aspect | `benchmark.py` | `throughput_benchmark.py` |
|:-------|:---------------|:--------------------------|
| Default steps | 10,000 | 500,000 |
| Duration | ~3-5 minutes | ~15-30 minutes |
| Progress reporting | None | Every ~10% or 50K steps |
| Metrics | FPS, Time, FPS/Core | SPS, SPM, Total Env Steps |
| Cooldown | 1 second | 2 seconds |
| Use case | Quick performance snapshot | Sustained throughput measurement |

---

### Troubleshooting

#### Issue: Decreasing SPS with more environments

**Cause**: Usually indicates the backend cannot keep up with the request rate.

**Solution**:
- Check CPU utilization
- Reduce number of environments
- Enable SharedArrayBuffer mode

#### Issue: High variance in SPS across progress reports

**Cause**: System noise, thermal throttling, or background processes.

**Solution**:
- Run with higher step counts for more stable averages
- Ensure adequate cooling
- Close other applications

#### Issue: Connection errors

**Solution**: Ensure backend is running:
```bash
# Terminal 1
npx tsx src/main.ts

# Terminal 2
python python/benchmarks/throughput_benchmark.py
```

#### Issue: Benchmark takes too long

**Solution**: Reduce step count with `--steps`:
```bash
python python/benchmarks/throughput_benchmark.py --steps 100000
```

---

### Best Practices

1. **Use higher step counts for production measurements**: Default 500K is a good baseline; increase to 1M+ for publication-quality results
2. **Cooldown between runs**: The 2-second cooldown prevents thermal throttling from affecting later configurations
3. **Monitor progress reports**: Inconsistent SPS across reports may indicate system instability
4. **Consistent system state**: Close other applications before running
5. **Compare with `benchmark.py`**: Use the quick benchmark for iteration, this module for final measurements

---

### See Also

- [benchmark](benchmark.md) - Quick performance benchmark (fewer steps, faster results)
- [BonkVecEnv](../envs/bonk_env.md) - The environment being benchmarked
- [test_env](../tests/test_env.md) - Basic connectivity test
- [test_profiler_load](../tests/test_profiler_load.md) - High-stress load test
