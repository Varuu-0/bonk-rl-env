# Python Client

The `python/` directory contains the Python client and ML pipeline for the Bonk.io RL environment. It provides Gymnasium-compatible environment wrappers, custom reward functions, training utilities, and performance benchmarking tools designed for reinforcement learning with frameworks like Stable Baselines3.

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| [`envs/`](envs/) | Gymnasium-compatible `BonkVecEnv` wrapping the Node.js physics backend via ZMQ IPC |
| [`reward/`](reward/) | Custom reward functions: navigation, curiosity, count-based exploration, composite rewards |
| [`utils/`](utils/) | Training logger (CSV trajectory recording) and map visualization (static + animated) |
| [`benchmarks/`](benchmarks/) | Performance benchmarking: IPC throughput, latency profiling, stress testing |
| [`tests/`](tests/) | Test suite for environment API, profiler loading, and reward validation |

## Quick Start

```python
import numpy as np
from envs.bonk_env import BonkVecEnv
from stable_baselines3 import PPO

# Create vectorized environment
env = BonkVecEnv(num_envs=8, port=5555, config={
    "frame_skip": 1,
    "num_opponents": 1,
    "max_ticks": 900,
})

# Train with PPO
model = PPO("MlpPolicy", env, verbose=1, n_steps=512)
model.learn(total_timesteps=1_000_000)
model.save("bonk_ppo")

env.close()
```

## Dependencies

See `requirements.txt` in the project root for the full dependency list. Core requirements:

| Package | Purpose |
|---------|---------|
| `gymnasium` | RL environment interface |
| `stable-baselines3` | PPO, A2C, DQN algorithms |
| `pyzmq` | ZMQ IPC communication with Node.js backend |
| `numpy` | Numerical operations |
| `matplotlib` | Map visualization |
| `pandas` | Trajectory log processing |

## Architecture

The Python client communicates with the Node.js physics engine over ZMQ (TCP). The `BonkVecEnv` class implements the `stable_baselines3.common.vec_env.VecEnv` interface, enabling seamless integration with SB3 algorithms. Each step sends batched actions and receives observations, rewards, and done flags for all parallel environments in a single IPC round-trip.
