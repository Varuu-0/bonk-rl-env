# Reward Functions

Custom reward functions for reinforcement learning training. This module provides flexible, composable reward definitions with support for task-specific objectives, potential-based reward shaping, intrinsic motivation, and exploration bonuses.

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | Public API exports |
| `reward_functions.py` | All reward function implementations |

## Available Rewards

| Class | Description |
|-------|-------------|
| `BaseRewardFunction` | Abstract base class with clipping, history tracking, and statistics |
| `NavigationReward` | Goal-based reward with potential shaping, collision penalty, and time efficiency |
| `CuriosityReward` | Intrinsic motivation based on state novelty and prediction error |
| `CountBasedExplorationReward` | Discrete state exploration bonus using visit counts |
| `CompositeReward` | Weighted combination of multiple reward components with optional normalization |
| `ConstraintPenaltyReward` | Penalizes constraint violations to prevent reward hacking |
| `RewardValidator` | Validates reward stability, detects NaN/inf, checks variance |

## Usage

### Single Reward

```python
from reward import NavigationReward
import numpy as np

reward_fn = NavigationReward(
    goal_position=np.array([10.0, 10.0]),
    collision_penalty=-1.0,
    time_penalty=-0.01,
    reward_clip=(-1.0, 1.0),
)

reward = reward_fn.compute(state, action, next_state, info)
```

### Composite Reward

```python
from reward import NavigationReward, CuriosityReward, CompositeReward
import numpy as np

components = [
    (NavigationReward(goal_position=np.array([10.0, 10.0])), 1.0),
    (CuriosityReward(eta=0.1), 0.5),
]

reward_fn = CompositeReward(components, normalize=True)
reward = reward_fn.compute(state, action, next_state, info)

# Adjust weights at runtime
reward_fn.set_weight("CuriosityReward", 0.2)
```

### Validation

```python
from reward import RewardValidator

result = RewardValidator.validate(reward_fn, num_steps=1000)
print(f"Valid: {result['is_valid']}")
print(f"Issues: {result['issues']}")
```

### Configuration-Based Creation

```python
from reward import create_reward_from_config

config = {
    "type": "composite",
    "components": [
        {"type": "navigation", "goal_position": [10.0, 10.0], "weight": 1.0},
        {"type": "curiosity", "eta": 0.1, "weight": 0.5},
    ],
}
reward_fn = create_reward_from_config(config)
```

## Reward Design Principles

- All rewards inherit from `BaseRewardFunction` for consistent clipping and statistics
- Potential-based shaping in `NavigationReward` guarantees optimal policy preservation
- `CompositeReward` stores per-component rewards in `info["_reward_components"]` for debugging
- `RewardValidator` checks for non-finite rewards, zero variance, and excessive magnitudes
