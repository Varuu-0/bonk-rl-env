# `benchmark` Module

## Overview

The `benchmark` module provides a comprehensive performance benchmarking script for the Bonk.io reinforcement learning environment. It measures throughput across different configurations of parallel environments.

## Module: `python.benchmarks.benchmark`

**Source File**: `python/benchmarks/benchmark.py`

---

## Function: `run_benchmark`

Runs a single benchmark iteration with a specified number of parallel environments.

```python
def run_benchmark(num_envs, steps=100) -> Optional[dict]
```

### Parameters

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `num_envs` | `int` | - | Number of parallel environments to test. |
| `steps` | `int` | `100` | Number of steps to execute in each benchmark run. |

### Returns

| Type | Description |
|:-----|:------------|
| `dict` or `None` | Dictionary containing benchmark results, or `None` if the benchmark failed. |

### Return Value Structure

```python
{
    "N": int,              # Number of environments
    "FPS": float,          # Frames per second
    "Time": float,         # Total time in seconds
    "FPS/Core (est)": float  # Estimated FPS per core
}
```

### Example

```python
result = run_benchmark(num_envs=32, steps=1000)
print(result)
# {'N': 32, 'FPS': 21917.79, 'Time': 14.60, 'FPS/Core (est)': 1370.11}
```

---

## Function: `main`

The main entry point for the benchmark. Runs benchmarks across multiple configurations and displays results.

```python
def main()
```

### Description

Executes benchmarks for the following environment counts: 1, 2, 4, 8, 16, 32, 64

Each benchmark:
1. Creates a `BonkVecEnv` with N parallel environments
2. Executes a warmup step
3. Runs 10,000 steps and measures elapsed time
4. Calculates FPS and other metrics

### Default Configuration

| Parameter | Value | Description |
|:----------|:------|:------------|
| `bench_configs` | `[1, 2, 4, 8, 16, 32, 64]` | Environment counts to benchmark |
| `steps` | `10,000` | Steps per benchmark run |
| `cooldown` | `1 second` | Delay between configurations |

### Output Format

```
=== Bonk RL Parallel Benchmark (10,000 steps) ===
Benchmarking N=1...
  Result: XXXX.XX FPS
Benchmarking N=2...
  Result: XXXX.XX FPS
...

Benchmark Results:
   N |        FPS |    Time (s)
--------------------------------
   1 |   XXXX.XX  |   X.
   2 |   XXXX.XX  |   X.XXXX
   4 |   XXXXXXXX.XX  |   X.XXXX
   8 |   XXXX.XX  |   X.XXXX
  16 |   XXXX.XX  |   X.XXXX
  32 |   XXXX.XX  |   X.XXXX
  64 |   XXXX.XX  |   X.XXXX
```

### Metrics Explained

| Metric | Description |
|:-------|:------------|
| `N` | Number of parallel environments |
| `FPS` | Aggregate frames per second (steps × N / time) |
| `Time (s)` | Total time to complete 10,000 steps |
| `FPS/Core (est)` | Estimated FPS per CPU core (assuming 16-core machine) |

---

### Usage

```bash
# Run the benchmark (backend must be running)
python python/benchmarks/benchmark.py
```

### Prerequisites

- Node.js backend must be running
- Port 5555 must be available

### Performance Expectations

| N (Envs) | Expected FPS | Notes |
|:---------|:-------------|:------|
| 1 | 3,000-4,000 | Baseline single-threaded |
| 2 | 5,000-6,000 | Near-linear scaling |
| 4 | 8,000-10,000 | Good parallelization |
| 8 | 12,000-15,000 | Diminishing returns begin |
| 16 | 16,000-20,000 | Moderate scaling |
| 32 | 20,000-23,000 | Approaching ceiling |
| 64 | 22,000-24,000 | Maximum throughput |

### Sample Results

```
Benchmark Results:
   N |        FPS |    Time (s)
--------------------------------
   1 |   3120.19  |   3.2049
   2 |   5171.39  |   3.8674
   4 |   8533.98  |   4.6871
   8 |  12829.85  |   6.2355
  16 |  17969.23  |   8.9041
  32 |  21917.79  |  14.6000
  64 |  23460.06  |  27.2804
```

---

### Customizing Benchmarks

```python
# Modify bench_configs for different environment counts
bench_configs = [1, 4, 16, 128]  # Custom configuration

# Modify steps for longer/shorter benchmarks
res = run_benchmark(n, steps=50000)  # More steps = more accurate
```

---

### Source Code Analysis

```python
def run_benchmark(num_envs, steps=100):
    env = BonkVecEnv(num_envs=num_envs)
    env.reset()
    
    # Warmup to allow JIT optimization
    actions = np.random.randint(0, 64, size=num_envs)
    env.step_async(actions)
    env.step_wait()
    
    # Benchmark
    start_time = time.time()
    for _ in range(steps):
        actions = np.random.randint(0, 64, size=num_envs)
        env.step_async(actions)
        env.step_wait()
    
    elapsed = time.time() - start_time
    fps = (steps * num_envs) / elapsed
    
    return {
        "N": num_envs,
        "FPS": round(fps, 2),
        "Time": round(elapsed, 4),
        "FPS/Core (est)": round(fps / min(num_envs, 16), 2)
    }
```

---

### Interpreting Results

#### Scaling Efficiency

| Scaling | Description |
|:--------|:------------|
| Linear (N×) | Ideal scaling, FPS increases proportionally with N |
| Sub-linear | Normal for parallel workloads |
| Flat | Indicates bottleneck (likely IPC or synchronization) |

#### Common Patterns

1. **Initial linear scaling**: Up to ~8-16 environments
2. **Diminishing returns**: Beyond 16-32 environments
3. **Plateau**: At 64+ environments (hardware limit)

#### Identifying Bottlenecks

- **If FPS doesn't increase with N**: IPC bottleneck (ZeroMQ)
- **If FPS plateaus early**: Worker pool saturation
- **If time increases linearly**: Per-step overhead dominates

---

### Troubleshooting

#### Issue: Decreasing FPS with more environments

**Cause**: Usually indicates the backend cannot keep up with the request rate.

**Solution**:
- Check CPU utilization
- Reduce number of environments
- Enable SharedArrayBuffer mode

#### Issue: High variance in results

**Cause**: System noise or thermal throttling.

**Solution**:
- Run multiple iterations
- Ensure adequate cooling
- Close other applications

#### Issue: Connection errors

**Solution**: Ensure backend is running:
```bash
# Terminal 1
npx tsx src/main.ts

# Terminal 2
python python/benchmarks/benchmark.py
```

---

### Comparison with Other Tests

| Test | Purpose | Duration |
|:-----|:--------|:---------|
| `test_env.py` | Basic connectivity | ~3 seconds |
| `test_profiler_load.py` | Stress testing | ~10-30 seconds |
| `benchmark.py` | Performance measurement | ~3-5 minutes |

---

### Best Practices

1. **Allow warmup**: First run includes JIT compilation
2. **Cooldown between runs**: Prevents thermal throttling
3. **Multiple runs**: Average results for accuracy
4. **Consistent system state**: Close other applications

---

### See Also

- [BonkVecEnv](../envs/bonk_env.md) - The environment being benchmarked
- [test_env](../tests/test_env.md) - Basic connectivity test
- [test_profiler_load](../tests/test_profiler_load.md) - High-stress load test
