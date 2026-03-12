# `training_logger` Module

## Overview

The `training_logger` module provides a simple CSV-based logging utility for recording training trajectories from the Bonk.io reinforcement learning environment.

## Module: `python.utils.training_logger`

**Source File**: `python/utils/training_logger.py`

---

## Class: `TrainingLogger`

A lightweight CSV logger for recording episode and step data during RL training.

### Constructor

```python
def __init__(self, log_dir="logs", filename="trajectory.csv")
```

#### Parameters

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `log_dir` | `str` | `"logs"` | Directory path where the CSV file will be saved. Created if it doesn't exist. |
| `filename` | `str` | `"trajectory.csv"` | Name of the CSV file to create. |

#### Example

```python
from training_logger import TrainingLogger

# Create logger with default settings
logger = TrainingLogger()

# Create logger with custom settings
logger = TrainingLogger(log_dir="my_logs", filename="training_run_001.csv")
```

---

### Public Methods

#### `log_step`

```python
def log_step(self, episode, tick, obs, reward, done)
```

Logs a single training step to the CSV file.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `episode` | `int` | Current episode number. |
| `tick` | `int` | Current tick (step) within the episode. |
| `obs` | `np.ndarray` | 14-dimensional observation array from `BonkEnv`. |
| `reward` | `float` | Reward received from the environment. |
| `done` | `bool` | Whether the episode has ended. |

**CSV Columns**

| Column | Description |
|:-------|:------------|
| `episode` | Episode number |
| `tick` | Step within the episode |
| `playerX` | Player X position (from `obs[0]`) |
| `playerY` | Player Y position (from `obs[1]`) |
| `opX` | Opponent X position (from `obs[7]`) |
| `opY` | Opponent Y position (from `obs[8]`) |
| `reward` | Reward value |
| `done` | Episode termination flag |

**Example**

```python
import numpy as np
from training_logger import TrainingLogger
from bonk_env import BonkVecEnv

# Initialize logger
logger = TrainingLogger(log_dir="logs", filename="episode_001.csv")

# Initialize environment
env = BonkVecEnv(num_envs=1)
obs = env.reset()

episode = 1
tick = 0

# Training loop
while True:
    action = env.action_space.sample()
    obs, reward, done, info = env.step(action)
    
    logger.log_step(episode, tick, obs[0], reward[0], done[0])
    
    if done[0]:
        episode += 1
        tick = 0
        obs = env.reset()
    else:
        tick += 1
        
    if episode > 100:  # Stop after 100 episodes
        break

logger.close()
env.close()
```

---

#### `close`

```python
def close(self)
```

Closes the CSV file. Should be called when done logging to ensure all data is flushed.

**Example**

```python
logger.close()
```

---

### Data Format

The logger writes CSV files with the following format:

```csv
episode,tick,playerX,playerY,opX,opY,reward,done
1,0,123.45,-67.89,100.00,-50.00,0.0,False
1,1,124.10,-68.20,101.50,-51.20,0.1,False
1,2,125.00,-69.00,103.00,-52.50,0.2,False
...
```

---

### Observation Array Mapping

The `TrainingLogger` assumes the observation array follows the `BonkVecEnv` convention:

| Index | Field | Description |
|:------|:------|:------------|
| 0 | `playerX` | Player X position |
| 1 | `playerY` | Player Y position |
| 7 | `opX` | Opponent X position |
| 8 | `opY` | Opponent Y position |

**Note**: If the observation format changes, you may need to modify the logger to use the correct indices.

---

### Integration with Training

```python
from training_logger import TrainingLogger
from bonk_env import BonkVecEnv
from stable_baselines3 import PPO

# Create environment and logger
env = BonkVecEnv(num_envs=4)
logger = TrainingLogger(log_dir="logs", filename="ppo_training.csv")

# Custom callback to log trajectories
class LoggingCallback:
    def __init__(self, logger):
        self.logger = logger
        self.episode = 0
        self.tick = 0
        
    def __call__(self, locals_):
        obs = locals_["obs"]
        reward = locals_["reward"]
        done = locals_["done"]
        
        for i in range(len(obs)):
            self.logger.log_step(
                self.episode + i,
                self.tick,
                obs[i],
                reward[i],
                done[i]
            )
            
        if any(done):
            self.episode += sum(done)
            self.tick = 0
        else:
            self.tick += 1
            
        return True

# Train with callback
model = PPO("MlpPolicy", env, verbose=1)
model.learn(total_timesteps=100000, callback=LoggingCallback(logger))

logger.close()
env.close()
```

---

### Best Practices

1. **Always close the logger**: Always call `logger.close()` when done to ensure the file is properly flushed and closed.

2. **Use descriptive filenames**: Include relevant information like date, run number, or hyperparameters in the filename.

3. **Separate log directories**: Use different directories for different training runs to avoid overwriting.

4. **Monitor disk space**: CSV logging can generate large files for long training runs. Consider using a different logging method for production.

---

### Performance Considerations

- **Minimal overhead**: The logger uses Python's built-in `csv` module with minimal abstraction
- **Buffered writes**: The file is kept open with buffering for better performance
- **Synchronous**: Each `log_step` call writes to disk immediately (no batching)

---

### See Also

- [BonkVecEnv](../envs/bonk_env.md) - The environment this logger is designed to work with
- [Visualize Map](../utils/visualize_map.md) - Visualize logged trajectories
