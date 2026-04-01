# Environment Wrappers

Gymnasium-compatible environment wrappers that bridge the Node.js Bonk.io physics engine to Python RL frameworks. The `BonkVecEnv` class implements the `stable_baselines3.common.vec_env.VecEnv` interface, enabling direct use with PPO, SAC, A2C, and other stable-baselines3 algorithms.

## Files

| File | Purpose |
|------|---------|
| `bonk_env.py` | `BonkVecEnv` class — full `VecEnv` implementation with ZMQ communication |

## BonkVecEnv

```python
from envs.bonk_env import BonkVecEnv

env = BonkVecEnv(
    num_envs=8,       # Number of parallel environments
    port=5555,        # ZMQ port (must match Node.js backend)
    config={          # Optional simulation config
        "frame_skip": 1,
        "num_opponents": 1,
        "max_ticks": 900,
        "random_opponent": True,
        "seed": 42,
    }
)
```

### Observation Space

14-dimensional `Box(-inf, inf, (14,), float32)`:

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `playerX` | Player X position |
| 1 | `playerY` | Player Y position |
| 2 | `playerVelX` | Player X velocity |
| 3 | `playerVelY` | Player Y velocity |
| 4 | `playerAngle` | Player rotation angle |
| 5 | `playerAngularVel` | Player angular velocity |
| 6 | `playerIsHeavy` | Heavy mode flag (0 or 1) |
| 7 | `opponentX` | First opponent X position |
| 8 | `opponentY` | First opponent Y position |
| 9 | `opponentVelX` | First opponent X velocity |
| 10 | `opponentVelY` | First opponent Y velocity |
| 11 | `opponentIsHeavy` | Opponent heavy mode flag |
| 12 | `opponentAlive` | Opponent alive flag (0 or 1) |
| 13 | `tick` | Current simulation tick |

### Action Space

`Discrete(64)` — encodes 6 binary inputs as a single integer:

| Bit | Action |
|-----|--------|
| 0 | Left |
| 1 | Right |
| 2 | Up |
| 3 | Down |
| 4 | Heavy |
| 5 | Grapple |

### VecEnv Interface Methods

| Method | Description |
|--------|-------------|
| `reset(seeds, options)` | Reset all environments, returns `(obs, info)` |
| `step_async(actions)` | Send actions non-blocking |
| `step_wait()` | Receive results: `(obs, rewards, terminated, truncated, infos)` |
| `close()` | Close ZMQ socket and context |
| `get_attr(name)` | Get attribute from environments |
| `set_attr(name, value)` | Set attribute in environments |
| `env_method(name, *args)` | Call method on environments |

### Features

- **Native VecEnv interface** — works directly with `stable_baselines3` without additional wrappers
- **Automatic reconnection** — ZMQ DEALER socket handles reconnection automatically
- **Configurable parallel envs** — scale from 1 to 64+ parallel environments
- **Framework compatibility** — compatible with stable-baselines3, RLlib (via custom wrappers), and any Gymnasium-based framework
- **Terminated/truncated support** — properly distinguishes between natural episode ends and max-tick truncation
- **Terminal observation handling** — provides terminal observations for proper value bootstrapping

## Usage with Stable Baselines3

```python
from envs.bonk_env import BonkVecEnv
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import VecMonitor

# Create and wrap with monitor for logging
env = BonkVecEnv(num_envs=8)
env = VecMonitor(env)

# Train
model = PPO("MlpPolicy", env, verbose=1, tensorboard_log="./logs/")
model.learn(total_timesteps=1_000_000)

# Evaluate
obs = env.reset()
for _ in range(1000):
    action, _ = model.predict(obs, deterministic=True)
    obs, rewards, terminated, truncated, infos = env.step(action)
```
