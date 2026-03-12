# `bonk_env` Module

## Overview

The `bonk_env` module provides a Gymnasium-compatible vectorized environment wrapper for the Bonk.io physics simulation engine. This module enables reinforcement learning agents to interact with the headless Bonk.io physics simulation via ZeroMQ communication.

## Module: `python.envs.bonk_env`

**Source File**: `python/envs/bonk_env.py`

**Dependencies**:
- `gymnasium`
- `numpy`
- `zmq` (PyZMQ)
- `stable_baselines3`

---

## Class: `BonkVecEnv`

A vectorized Gymnasium environment that communicates with the Node.js physics engine via ZeroMQ. Implements the `stable_baselines3.common.vec_env.VecEnv` interface for compatibility with popular RL frameworks like stable-baselines3.

### Inheritance

```
BonkVecEnv → VecEnv (from stable_baselines3.common.vec_env)
```

### Constructor

```python
def __init__(self, num_envs=1, port=5555, config=None)
```

#### Parameters

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `num_envs` | `int` | `1` | Number of parallel environments to instantiate. Each environment runs in a separate worker thread on the Node.js backend. |
| `port` | `int` | `5555` | ZeroMQ port number for communication with the Node.js backend server. |
| `config` | `dict` | `None` | Optional configuration dictionary to pass to the Node.js engine. If `None`, an empty config is used. |

#### Raises

| Exception | Description |
|:----------|:------------|
| `RuntimeError` | If the Node.js backend fails to initialize the environments or returns an error status. |
| `zmq.ZMQError` | If ZeroMQ connection fails (e.g., backend not running). |

#### Example

```python
from bonk_env import BonkVecEnv

# Create a vectorized environment with 32 parallel instances
env = BonkVecEnv(num_envs=32, port=5555)

# Reset and get initial observations
obs = env.reset()

# Take random actions
actions = env.action_space.sample()
obs, rewards, dones, infos = env.step(actions)

# Clean up
env.close()
```

---

### Public Methods

#### `reset`

```python
def reset(self) -> np.ndarray
```

Resets all parallel environments to their initial states with random seeds for deterministic rollouts.

**Returns**:

| Type | Description |
|:-----|:------------|
| `np.ndarray` | Array of shape `(num_envs, 14)` containing initial observations for each environment. |

**Raises**:

| Exception | Description |
|:----------|:------------|
| `RuntimeError` | If the backend fails to reset the environments. |

**Example**:

```python
obs = env.reset()
print(obs.shape)  # (num_envs, 14)
```

---

#### `step_async`

```python
def step_async(self, actions)
```

Sends actions to the backend for execution. This is an asynchronous operation that must be followed by `step_wait()` to retrieve results.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `actions` | `np.ndarray` or `list` | Array of actions for each environment. Actions are integers in range `[0, 64)` corresponding to the 6 binary inputs (left, right, up, down, heavy, grapple). |

**Example**:

```python
actions = np.random.randint(0, 64, size=num_envs)
env.step_async(actions)
```

---

#### `step_wait`

```python
def step_wait(self) -> Tuple[np.ndarray, np.ndarray, np.ndarray, list]
```

Waits for the backend to process the previously sent actions and returns the results.

**Returns**:

| Type | Description |
|:-----|:------------|
| `obs` | `np.ndarray` of shape `(num_envs, 14)` - observations after taking the actions |
| `rewards` | `np.ndarray` of shape `(num_envs,)` - reward received for each environment |
| `dones` | `np.ndarray` of shape `(num_envs,)` - boolean flags indicating episode termination |
| `infos` | `list` - list of info dictionaries for each environment |

**Raises**:

| Exception | Description |
|:----------|:------------|
| `RuntimeError` | If the backend returns an error status. |

**Example**:

```python
env.step_async(actions)
obs, rewards, dones, infos = env.step_wait()
```

---

#### `close`

```python
def close(self)
```

Closes the ZeroMQ socket and terminates the context. Should be called when done using the environment to properly release resources.

**Example**:

```python
env.close()
```

---

#### `get_attr`

```python
def get_attr(self, attr_name, indices=None) -> list
```

Retrieves attributes from underlying environments. Currently returns `None` for all attributes.

**Parameters**:

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `attr_name` | `str` | - | Name of the attribute to retrieve. |
| `indices` | `list` | `None` | Specific environment indices to query. If `None`, queries all environments. |

**Returns**:

| Type | Description |
|:-----|:------------|
| `list` | List of attribute values (currently all `None`). |

---

#### `set_attr`

```python
def set_attr(self, attr_name, value, indices=None)
```

Sets attributes on underlying environments. Currently a no-op.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `attr_name` | `str` | Name of the attribute to set. |
| `value` | any | Value to set. |
| `indices` | `list` | Specific environment indices to modify. |

---

#### `env_method`

```python
def env_method(self, method_name, *method_args, indices=None, **method_kwargs) -> list
```

Calls methods on underlying environments. Currently returns `None` for all methods.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `method_name` | `str` | Name of the method to call. |
| `method_args` | `tuple` | Positional arguments to pass to the method. |
| `indices` | `list` | Specific environment indices to target. |
| `method_kwargs` | `dict` | Keyword arguments to pass to the method. |

**Returns**:

| Type | Description |
|:-----|:------------|
| `list` | List of method return values (currently all `None`). |

---

#### `seed`

```python
def seed(self, seed=None) -> list
```

Sets the random seed for environments. Currently seeds are handled in `reset()`.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `seed` | `int` | Random seed (currently not used). |

**Returns**:

| Type | Description |
|:-----|:------------|
| `list` | List of seeds (currently all `None`). |

---

#### `env_is_wrapped`

```python
def env_is_wrapped(self, wrapper_class, indices=None) -> list
```

Checks if environments are wrapped with a specific wrapper class.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `wrapper_class` | `type` | Wrapper class to check for. |
| `indices` | `list` | Specific environment indices to check. |

**Returns**:

| Type | Description |
|:-----|:------------|
| `list` | List of boolean values (currently all `False`). |

---

### Observation Space

The observation space is a `gymnasium.spaces.Box` with the following structure:

| Index | Field | Type | Description |
|:------|:------|:-----|:------------|
| 0 | `playerX` | `float32` | Player X position |
| 1 | `playerY` | `float32` | Player Y position |
| 2 | `playerVelX` | `float32` | Player X velocity |
| 3 | `playerVelY` | `float32` | Player Y velocity |
| 4 | `playerAngle` | `float32` | Player angle |
| 5 | `playerAngularVel` | `float32` | Player angular velocity |
| 6 | `playerIsHeavy` | `float32` | Player heavy state (1.0 if heavy, 0.0 otherwise) |
| 7 | `opX` | `float32` | Opponent X position |
| 8 | `opY` | `float32` | Opponent Y position |
| 9 | `opVelX` | `float32` | Opponent X velocity |
| 10 | `opVelY` | `float32` | Opponent Y velocity |
| 11 | `opIsHeavy` | `float32` | Opponent heavy state |
| 12 | `opAlive` | `float32` | Opponent alive state (1.0 if alive, 0.0 if dead) |
| 13 | `tick` | `float32` | Current tick count |

**Shape**: `(14,)` with dtype `float32`

**Range**: `-inf` to `+inf` for position/velocity fields, `0.0` or `1.0` for boolean fields

---

### Action Space

The action space is a `gymnasium.spaces.Discrete` space with 64 possible actions:

| Action | Binary Representation | Inputs |
|:-------|:---------------------|:-------|
| 0 | 000000 | No action |
| 1 | 000001 | Left |
| 2 | 000010 | Right |
| 4 | 000100 | Up |
| 8 | 001000 | Down |
| 16 | 010000 | Heavy |
| 32 | 100000 | Grapple |

Actions can be combined by adding their binary values (e.g., 5 = Left + Up).

---

### Internal Methods

#### `_convert_obs`

```python
def _convert_obs(self, data) -> np.ndarray
```

Converts raw observation data from the Node.js backend into a numpy array.

**Parameters**:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `data` | `dict` | Raw observation dictionary from the backend. |

**Returns**:

| Type | Description |
|:-----|:------------|
| `np.ndarray` | Converted observation array of shape `(14,)`. |

**Note**: This is an internal method used for data transformation.

---

### Usage with stable-baselines3

```python
from stable_baselines3 import PPO
from bonk_env import BonkVecEnv

# Create the environment
env = BonkVecEnv(num_envs=64)

# Create and train the agent
model = PPO("MlpPolicy", env, verbose=1)
model.learn(total_timesteps=100000)

# Save the model
model.save("ppo_bonk")

# Close the environment
env.close()
```

---

### Performance Considerations

- **Batch Size**: Using more parallel environments (up to 64) increases throughput significantly
- **ZeroMQ Latency**: The DEALER socket pattern adds minimal overhead compared to the physics computation
- **Shared Memory Mode**: When enabled on the backend, uses SharedArrayBuffer for zero-copy IPC

---

### See Also

- [Training Logger](../utils/training_logger.md) - Log training trajectories
- [Visualize Map](../utils/visualize_map.md) - Visualize maps and trajectories
- [Benchmark](../benchmarks/benchmark.md) - Performance benchmarking
