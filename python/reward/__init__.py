"""
Custom Reward Functions for Reinforcement Learning

This module provides flexible reward function definitions for RL agents,
with support for task-specific objectives, reward shaping, and exploration bonuses.

Usage:
    from reward import NavigationReward, CuriosityReward, RewardValidator
    
    # Create reward function
    reward_fn = NavigationReward(
        goal_position=np.array([10.0, 10.0]),
        collision_penalty=-1.0,
        time_penalty=-0.01,
        reward_clip=(-1.0, 1.0)
    )
    
    # In RL loop
    reward = reward_fn.compute(state, action, next_state, info)
"""

from .reward_functions import (
    BaseRewardFunction,
    NavigationReward,
    CompositeReward,
    CuriosityReward,
    CountBasedExplorationReward,
    ConstraintPenaltyReward,
    RewardValidator,
    validate_reward,
    create_reward_from_config,
)

__all__ = [
    "BaseRewardFunction",
    "NavigationReward",
    "CompositeReward",
    "CuriosityReward",
    "CountBasedExplorationReward",
    "ConstraintPenaltyReward",
    "RewardValidator",
    "validate_reward",
    "create_reward_from_config",
]
