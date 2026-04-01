# Tests

Python-side test suite for the Bonk.io RL environment. Validates the environment API, profiler load handling, and reward function correctness.

## Files

| File | Purpose |
|------|---------|
| `test_env.py` | Environment API tests — connects to backend, runs batched steps, measures throughput |
| `test_profiler_load.py` | High-stress profiler load test — saturates IPC bridge with 64 parallel envs |
| `test_rewards.py` | Reward function validation tests |

## Running Tests

### Environment API Test

Validates the `BonkVecEnv` connection, reset, and step operations with 64 parallel environments:

```bash
python tests/test_env.py
```

Reports effective FPS, total physics steps, and episode completion count.

### Profiler Load Test

Saturates the IPC bridge and worker pool to stress-test the Node.js profiler and Straggler Detector:

```bash
# Terminal 1: Start engine and profiler
npx tsx src/main.ts

# Terminal 2: Run load test
python tests/test_profiler_load.py
```

The load test drives 64 parallel environments for 50,000 physics ticks at maximum throughput with no sleeps, printing progress every 5,000 ticks.

### Reward Tests

```bash
pytest tests/test_rewards.py -v
```

## Test Descriptions

### test_env.py

- Connects to `BonkVecEnv` with 64 parallel environments
- Runs 100 batched random steps
- Measures effective massively-parallel FPS
- Tracks total episodes completed and cumulative rewards

### test_profiler_load.py

- Spawns 64 parallel environments to stress the worker pool
- Drives simulation as fast as possible for ~50,000 physics ticks
- Reports progress every 5,000 ticks
- Prints final throughput in Physics Ticks/sec
- Designed to generate enough data for profiler heatmaps and straggler reports

### test_rewards.py

- Validates reward function behavior and stability

## Prerequisites

Environment tests require the Node.js physics engine running:

```bash
npx tsx src/main.ts
```
