# Custom Reward Functions

## Overview

Custom reward function system for RL agents. See python/reward/reward_functions.py for implementation.

## Quick Start

```python
import numpy as np
from reward import NavigationReward

nav = NavigationReward(
    goal_position=np.array([10.0, 10.0]),
    collision_penalty=-1.0,
    time_penalty=-0.01,
    reward_clip=(-1.0, 1.0)
)

reward = nav.compute(state, action, next_state, info)
```

## Classes

- **NavigationReward** - Navigation with potential-based shaping
- **CompositeReward** - Combine multiple reward components  
- **CuriosityReward** - Intrinsic motivation via state novelty
- **CountBasedExplorationReward** - Count-based exploration
- **ConstraintPenaltyReward** - Prevent reward hacking
- **RewardValidator** - Validate reward stability

## Info Dict Fields

| Field | Type | Description |
|-------|------|-------------|
| collision | bool | Whether collision occurred |
| goal_reached | bool | Whether goal was reached |
| done | bool | Whether episode terminated |

## Integration

### Gymnasium
```python
from reward import make_reward_function

reward_fn = make_reward_function({'type': 'navigation', 'goal_position': [10.0, 10.0]})
```

### RLlib  
```python
from reward import rllib_reward_batch_fn, NavigationReward

reward_fn = rllib_reward_batch_fn(NavigationReward(goal_position=np.array([10.0, 10.0])))
```

## Best Practices

1. Always clip rewards: reward_clip=(-1.0, 1.0)
2. Reset at episode start: reward_fn.reset()
3. Use potential-based shaping for NavigationReward
4. Validate with RewardValidator.validate()

## See Also

- [Roadmap](./roadmap.md)
- [Configuration](./configuration.md)

