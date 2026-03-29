# `test_profiler_load` Module

## Overview

The `test_profiler_load` module provides a high-stress load testing script designed to saturate the IPC bridge and worker pool. It generates sufficient data for the Node.js profiler and Straggler Detector to produce useful performance reports.

## Module: `python.tests.test_profiler_load`

**Source File**: `python/tests/test_profiler_load.py`

---

## Function: `main`

The main entry point for the profiler load test.

```python
def main() -> None
```

### Description

This script performs a high-throughput stress test of the Bonk.io physics engine:

1. Connects to the Node.js backend with 64 parallel environments
2. Executes up to 50,000 physics ticks as fast as possible
3. Reports progress every 5,000 ticks
4. Outputs overall throughput (Physics Ticks/sec)

### Prerequisites

- Node.js backend must be running with profiling enabled
- The telemetry/profiler system should be active

### Usage

**Terminal 1 - Start the engine with profiling:**
```bash
npx tsx src/main.ts
```

Watch for:
- Periodic profiler heatmaps (every ~5,000 physics ticks)
- Straggler reports flagging slow workers
- PHYSICS_TICK mean timing:
  - `> 1.0 ms` → CPU is struggling
  - `< 0.1 ms` → CPU is handling the load well

**Terminal 2 - Run the load test:**
```bash
python python/tests/test_profiler_load.py
```

### Expected Output

```
Starting high-stress profiler load test...
- Parallel environments: 64
- Target physics ticks: 50000
- Report interval:      5000 ticks

Executing batched physics steps at maximum throughput...
Progress: 5000/50000 physics ticks...
Progress: 10000/50000 physics ticks...
Progress: 15000/50000 physics ticks...
Progress: 20000/50000 physics ticks...
Progress: 25000/50000 physics ticks...
Progress: 30000/50000 physics ticks...
Progress: 35000/50000 physics ticks...
Progress: 40000/50000 physics ticks...
Progress: 45000/50000 physics ticks...
Progress: 50000/50000 physics ticks...
Load test complete in XX.XX seconds.
Throughput: XXXX.XX Physics Ticks/sec
```

### Configuration Parameters

| Parameter | Default | Description |
|:----------|:--------|:------------|
| `num_envs` | 64 | Number of parallel environments |
| `target_ticks` | 50,000 | Total physics ticks to execute |
| `report_interval_ticks` | 5,000 | Ticks between progress reports |

### Understanding Profiler Output

#### PHYSICS_TICK Mean

| Timing | Interpretation |
|:-------|:---------------|
| < 0.1 ms | Excellent - CPU is breezing through |
| 0.1 - 1.0 ms | Normal - Expected operating range |
| > 1.0 ms | Warning - CPU is struggling with load |

#### Straggler Detection

If the same worker is consistently flagged as "Lagging", it may be handling an environment in a "heavy" part of the map (e.g., dense collision clusters in bonk_WDB__No_Mapshake__716916.json).

---

### Performance Characteristics

The test is designed to:

- **Eliminate sleeps**: No artificial delays between steps
- **Saturate IPC**: Maximum ZeroMQ message throughput
- **Stress worker pool**: All 64 workers operating in parallel
- **Generate profiler data**: Enough samples for meaningful analysis

### Expected Throughput

| Hardware | Expected Throughput |
|:---------|:-------------------|
| High-end (8+ cores) | 500,000+ ticks/sec |
| Mid-range (4-8 cores) | 300,000-500,000 ticks/sec |
| Low-end (<4 cores) | <300,000 ticks/sec |

---

### Customizing the Test

```python
# Modify target_ticks for longer/shorter tests
target_ticks = 100_000  # Run for 100k ticks

# Modify report_interval for more/less frequent updates
report_interval_ticks = 10_000  # Report every 10k ticks
```

---

### Integration with Telemetry

The load test is designed to work with the telemetry system:

1. **Enable profiling** when starting the backend:
   ```bash
   npx tsx src/main.ts --telemetry --profile detailed
   ```

2. **Dashboard**: Access the telemetry dashboard at `http://localhost:3001` (default port)

3. **Output formats**: Console, file, or both

---

### Use Cases

1. **Performance profiling**: Identify bottlenecks in the physics engine
2. **Worker analysis**: Find straggling workers handling heavy map regions
3. **Scalability testing**: Verify the system scales with more environments
4. **Regression testing**: Detect performance regressions between builds

---

### Troubleshooting

#### Issue: Low throughput

**Possible causes**:
- Network latency (if running over network)
- CPU contention from other processes
- Hardware limitations

**Solutions**:
- Run on localhost
- Close other applications
- Upgrade hardware

#### Issue: Straggler workers

**Interpretation**: Some map regions have more collision checks

**Investigation**:
- Check the profiler heatmap
- Identify which worker is lagging
- Analyze the map region that worker handles

#### Issue: Connection refused

**Solution**: Ensure the backend is running first:
```bash
# Terminal 1
npx tsx src/main.ts

# Terminal 2
python python/tests/test_profiler_load.py
```

---

### Code Flow

```python
def main() -> None:
    # Configuration
    num_envs = 64
    target_ticks = 50_000
    report_interval_ticks = 5_000
    
    # Connect to backend
    env = BonkVecEnv(num_envs=num_envs)
    env.reset()
    
    # Tight loop - no sleeps
    ticks_done = 0
    while ticks_done < target_ticks:
        actions = np.random.randint(0, 64, size=num_envs)
        _obs, _rewards, _dones, _infos = env.step(actions)
        ticks_done += num_envs
        
        # Progress reporting
        while ticks_done >= next_report:
            print(f"Progress: {ticks_done}/{target_ticks} physics ticks...")
            next_report += report_interval_ticks
    
    # Results
    throughput = ticks_done / elapsed
    print(f"Throughput: {throughput:.2f} Physics Ticks/sec")
```

---

### Best Practices

1. **Run on clean system**: Close other CPU-intensive applications
2. **Use localhost**: Avoid network latency
3. **Allow warmup**: First few seconds include JIT compilation overhead
4. **Multiple runs**: Average results across multiple runs for accuracy

---

### See Also

- [BonkVecEnv](../envs/bonk_env.md) - The environment being tested
- [test_env](test_env.md) - Basic connectivity test
- [Telemetry System](../../telemetry.md) - Telemetry configuration
- [Profiler](../../typescript/src/telemetry/profiler.md) - Profiler documentation
