# `test_env` Module

## Overview

The `test_env` module provides a basic connectivity test for the Bonk.io reinforcement learning environment. It verifies that the Python client can successfully connect to the Node.js backend and perform basic operations.

## Module: `python.tests.test_env`

**Source File**: `python/tests/test_env.py`

---

## Function: `main`

The main entry point for the environment connectivity test.

```python
def main()
```

### Description

This script performs the following operations:

1. Creates a `BonkVecEnv` with 64 parallel environments
2. Resets the environment to get initial observations
3. Executes 100 random action steps
4. Reports throughput statistics (FPS)
5. Cleans up resources

### Prerequisites

- Node.js backend must be running on the default port (5555)
- All 64 worker threads must be available

### Usage

```bash
# Start the Node.js backend first (in a separate terminal)
npx tsx src/main.ts

# Run the connectivity test (in another terminal)
python python/tests/test_env.py
```

### Expected Output

```
Connecting to Bonk RL Massively Parallel Environment (N=64)...
Resetting 64 environments...
Initial observation array shape: (64, 14)

Running 100 random steps to test batch throughput...

100 batched steps completed in X.XXXX seconds.
Total physics steps (ticks): 6400
Effective Massively Parallel FPS: XXXX.XX (Includes ZMQ router/dealer + Node cluster)
Total episodes completed: X
Disconnecting...
```

### Output Fields

| Field | Description |
|:------|:------------|
| `N` | Number of parallel environments |
| `Initial observation array shape` | Shape of the observation array |
| `100 batched steps completed in X.XXXX seconds` | Time taken for 100 steps |
| `Total physics steps (ticks)` | Total environment steps (100 × 64) |
| `Effective Massively Parallel FPS` | Aggregate frames per second |
| `Total episodes completed` | Number of episodes that finished during the test |

### Error Handling

| Error | Cause | Solution |
|:------|:------|:----------|
| `ZMQError: Connection refused` | Backend not running | Start Node.js server with `npx tsx src/main.ts` |
| `RuntimeError: Error initializing environments` | Backend initialization failed | Check backend logs |
| `RuntimeError: Error stepping environment` | Step failed | Check backend logs |

### Configuration

The test uses the following default configuration:

| Parameter | Value | Can Modify |
|:----------|:------|:-----------|
| `num_envs` | 64 | Edit `num_envs` variable in source |
| `port` | 5555 | Pass as second argument to `BonkVecEnv` |
| `total_steps` | 100 | Edit `total_steps` variable in source |

### Modifying for Different Configurations

```python
# Change number of environments
num_envs = 32  # instead of 64

# Change port
env = BonkVecEnv(num_envs=num_envs, port=5556)
```

### Understanding the Results

- **Higher FPS is better**: Indicates better throughput
- **Episodes completed**: Varies based on map and random actions
- **Expected FPS range**: 10,000-25,000 FPS depending on hardware

### Performance Expectations

| Hardware | Expected FPS (64 envs) |
|:---------|:----------------------|
| High-end (8+ cores) | 20,000+ |
| Mid-range (4-8 cores) | 10,000-20,000 |
| Low-end (<4 cores) | <10,000 |

---

### Source Code Analysis

```python
import numpy as np
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'envs')))
from bonk_env import BonkVecEnv

def main():
    num_envs = 64
    env = BonkVecEnv(num_envs=num_envs)  # Connect to backend
    obs = env.reset()                    # Initialize environments
    
    total_steps = 100
    start_time = time.time()
    
    for i in range(total_steps):
        actions = np.random.randint(0, 64, size=num_envs)
        obs, rewards, dones, infos = env.step_wait() if i > 0 else ...
        env.step_async(actions)
            
    obs, rewards, dones, infos = env.step_wait()
    elapsed = time.time() - start_time
    
    fps = (total_steps * num_envs) / elapsed
    print(f"Effective Massively Parallel FPS: {fps:.2f}")
    
    env.close()
```

---

### Troubleshooting

#### Issue: "Connection refused"

**Cause**: The Node.js backend is not running.

**Solution**:
```bash
# Terminal 1
npx tsx src/main.ts

# Terminal 2
python python/tests/test_env.py
```

#### Issue: "Error initializing environments"

**Cause**: Backend failed to create worker threads.

**Solution**: Check available CPU cores and reduce `num_envs` if needed.

#### Issue: Low FPS

**Cause**: System resource constraints or network latency.

**Solution**:
- Ensure Node.js is running locally (not over network)
- Reduce number of parallel environments
- Check CPU utilization

---

### See Also

- [BonkVecEnv](../envs/bonk_env.md) - The environment being tested
- [test_profiler_load](test_profiler_load.md) - More intensive load testing
- [benchmark](../benchmarks/benchmark.md) - Performance benchmarking across different configurations
