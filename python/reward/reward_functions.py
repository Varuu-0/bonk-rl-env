"""
Custom Reward Functions for Reinforcement Learning

This module provides flexible reward function definitions for RL agents,
with support for task-specific objectives, reward shaping, and exploration bonuses.

Usage:
    from reward import NavigationReward, CuriosityReward, RewardValidator
    
    reward_fn = NavigationReward(
        goal_position=np.array([10.0, 10.0]),
        collision_penalty=-1.0,
        time_penalty=-0.01,
        reward_clip=(-1.0, 1.0)
    )
    
    reward = reward_fn.compute(state, action, next_state, info)

Author: Implementation Team
License: MIT
"""

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional, Tuple, Union
import numpy as np
from collections import defaultdict
import copy


class BaseRewardFunction(ABC):
    """Abstract base class for custom reward functions."""
    
    def __init__(
        self,
        name: str,
        reward_clip: Optional[Tuple[float, float]] = None,
        enabled: bool = True,
    ):
        self.name = name
        self.reward_clip = reward_clip
        self.enabled = enabled
        self._reward_history: List[float] = []
        self._call_count = 0
    
    @abstractmethod
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        pass
    
    def _clip_reward(self, reward: float) -> float:
        if self.reward_clip is not None:
            return float(np.clip(reward, self.reward_clip[0], self.reward_clip[1]))
        return float(reward)
    
    def _record_reward(self, reward: float) -> None:
        self._reward_history.append(reward)
        self._call_count += 1
        if len(self._reward_history) > 10000:
            self._reward_history = self._reward_history[-10000:]
    
    def get_statistics(self) -> Dict[str, float]:
        if not self._reward_history:
            return {"mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0, "count": 0}
        return {
            "mean": float(np.mean(self._reward_history)),
            "std": float(np.std(self._reward_history)),
            "min": float(np.min(self._reward_history)),
            "max": float(np.max(self._reward_history)),
            "count": self._call_count,
        }
    
    def reset(self) -> None:
        self._reward_history.clear()
        self._call_count = 0
    
    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(name='{self.name}', enabled={self.enabled})"


class NavigationReward(BaseRewardFunction):
    """
    Navigation reward function combining multiple objectives.
    
    Implements:
    - Distance-to-goal potential (potential-based shaping)
    - Collision penalty (safety constraint)
    - Time efficiency bonus
    
    Reward is clipped to [-1, 1] by default for stable training.
    """
    
    def __init__(
        self,
        goal_position: np.ndarray,
        collision_penalty: float = -1.0,
        time_penalty: float = -0.01,
        time_bonus: float = 1.0,
        reward_clip: Tuple[float, float] = (-1.0, 1.0),
        gamma: float = 0.99,
        success_radius: float = 0.5,
        distance_scale: float = 1.0,
        enable_potential_shaping: bool = True,
    ):
        super().__init__(name="NavigationReward", reward_clip=reward_clip)
        
        self.goal_position = np.array(goal_position, dtype=np.float32)
        self.collision_penalty = collision_penalty
        self.time_penalty = time_penalty
        self.time_bonus = time_bonus
        self.gamma = gamma
        self.success_radius = success_radius
        self.distance_scale = distance_scale
        self.enable_potential_shaping = enable_potential_shaping
        
        self._prev_distance: Optional[float] = None
        self._episode_step = 0
    
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        current_pos = self._extract_position(state)
        next_pos = self._extract_position(next_state)
        
        current_distance = self._distance_to_goal(current_pos)
        next_distance = self._distance_to_goal(next_pos)
        
        total_reward = 0.0
        
        if self.enable_potential_shaping:
            potential_reward = self._compute_potential_shaping(
                current_distance, next_distance, info
            )
            total_reward += potential_reward
        
        collision = info.get("collision", False)
        if collision:
            total_reward += self.collision_penalty
        
        total_reward += self.time_penalty
        
        goal_reached = info.get("goal_reached", False)
        done = info.get("done", False)
        
        if goal_reached or done:
            if next_distance <= self.success_radius:
                total_reward += self.time_bonus
        
        final_reward = self._clip_reward(total_reward)
        self._record_reward(final_reward)
        
        if done:
            self._prev_distance = None
            self._episode_step = 0
        else:
            self._prev_distance = next_distance
            self._episode_step += 1
        
        return final_reward
    
    def _extract_position(self, state: np.ndarray) -> np.ndarray:
        state = np.asarray(state, dtype=np.float32)
        if len(state) >= 2:
            return state[:2]
        return state
    
    def _distance_to_goal(self, position: np.ndarray) -> float:
        position = np.asarray(position, dtype=np.float32)
        return float(np.linalg.norm(position - self.goal_position))
    
    def _compute_potential_shaping(
        self,
        current_distance: float,
        next_distance: float,
        info: Dict[str, Any],
    ) -> float:
        done = info.get("done", False)
        
        if done:
            if info.get("goal_reached", False):
                return self.time_bonus
            return 0.0
        
        potential_current = -current_distance * self.distance_scale
        potential_next = -next_distance * self.distance_scale
        
        shaping_reward = self.gamma * potential_next - potential_current
        
        return shaping_reward
    
    def reset(self) -> None:
        super().reset()
        self._prev_distance = None
        self._episode_step = 0
    
    def set_goal(self, goal_position: np.ndarray) -> None:
        self.goal_position = np.array(goal_position, dtype=np.float32)
    
    def __repr__(self) -> str:
        return (
            f"NavigationReward(goal={self.goal_position}, "
            f"collision_penalty={self.collision_penalty}, "
            f"time_penalty={self.time_penalty})"
        )


class CompositeReward(BaseRewardFunction):
    """Composite reward combining multiple components with weights."""
    
    def __init__(
        self,
        components: List[Tuple[BaseRewardFunction, float]],
        reward_clip: Optional[Tuple[float, float]] = None,
        normalize: bool = False,
        normalize_window: int = 1000,
    ):
        super().__init__(name="CompositeReward", reward_clip=reward_clip)
        
        self.components = components
        self.normalize = normalize
        self.normalize_window = normalize_window
        
        self.component_names = [comp.name for comp, _ in components]
        self.weights = {reward_fn.name: weight for reward_fn, weight in components}
        
        self._reward_buffer: List[float] = []
        self._running_mean = 0.0
        self._running_var = 1.0
    
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        total_reward = 0.0
        component_rewards = {}
        
        for reward_fn, weight in self.components:
            if not reward_fn.enabled:
                continue
            
            try:
                component_reward = reward_fn.compute(state, action, next_state, info)
                weighted_reward = weight * component_reward
                total_reward += weighted_reward
                component_rewards[reward_fn.name] = component_reward
            except Exception as e:
                print(f"Warning: Error computing {reward_fn.name}: {e}")
                component_rewards[reward_fn.name] = 0.0
        
        if self.normalize:
            total_reward = self._normalize_reward(total_reward)
        
        final_reward = self._clip_reward(total_reward)
        self._record_reward(final_reward)
        
        info["_reward_components"] = component_rewards
        info["_reward_weights"] = {
            name: self.weights.get(name, 0.0) 
            for name in component_rewards.keys()
        }
        
        return final_reward
    
    def _normalize_reward(self, reward: float) -> float:
        self._reward_buffer.append(reward)
        
        if len(self._reward_buffer) > self.normalize_window:
            self._reward_buffer.pop(0)
        
        if len(self._reward_buffer) > 1:
            mean = np.mean(self._reward_buffer)
            std = np.std(self._reward_buffer) + 1e-8
            
            self._running_mean = 0.99 * self._running_mean + 0.01 * mean
            self._running_var = 0.99 * self._running_var + 0.01 * (std ** 2)
            
            return (reward - mean) / std
        
        return reward
    
    def set_weight(self, component_name: str, weight: float) -> None:
        if component_name not in self.weights:
            raise ValueError(f"Component '{component_name}' not found. "
                           f"Available: {list(self.weights.keys())}")
        
        self.weights[component_name] = weight
        
        for i, (reward_fn, _) in enumerate(self.components):
            if reward_fn.name == component_name:
                self.components[i] = (reward_fn, weight)
                break
    
    def get_component_statistics(self) -> Dict[str, Dict[str, float]]:
        return {
            reward_fn.name: reward_fn.get_statistics()
            for reward_fn, _ in self.components
            if reward_fn.enabled
        }
    
    def reset(self) -> None:
        super().reset()
        for reward_fn, _ in self.components:
            reward_fn.reset()
        self._reward_buffer.clear()
    
    def __repr__(self) -> str:
        return f"CompositeReward(components={self.component_names}, weights={self.weights})"


class CuriosityReward(BaseRewardFunction):
    """Curiosity-based exploration reward using intrinsic motivation."""
    
    def __init__(
        self,
        feature_dim: int = 64,
        eta: float = 0.1,
        reward_scale: float = 1.0,
        reward_clip: Tuple[float, float] = (-1.0, 1.0),
        buffer_size: int = 10000,
    ):
        super().__init__(name="CuriosityReward", reward_clip=reward_clip)
        
        self.feature_dim = feature_dim
        self.eta = eta
        self.reward_scale = reward_scale
        
        self._state_buffer: List[np.ndarray] = []
        self._buffer_size = buffer_size
        self._forward_model: Optional[Callable] = None
    
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        state = np.asarray(state, dtype=np.float32).flatten()
        next_state = np.asarray(next_state, dtype=np.float32).flatten()
        
        min_len = min(len(state), len(next_state))
        state = state[:min_len]
        next_state = next_state[:min_len]
        
        self._state_buffer.append(state)
        if len(self._state_buffer) > self._buffer_size:
            self._state_buffer.pop(0)
        
        curiosity = self._compute_intrinsic_curiosity(state, action, next_state)
        
        final_reward = self._clip_reward(self.eta * curiosity * self.reward_scale)
        self._record_reward(final_reward)
        
        return final_reward
    
    def _compute_intrinsic_curiosity(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
    ) -> float:
        if len(self._state_buffer) < 2:
            return 0.1
        
        prev_states = np.array(self._state_buffer[-100:])
        
        distances = np.linalg.norm(prev_states - state, axis=1)
        min_distance = np.min(distances) if len(distances) > 0 else 1.0
        
        novelty = 1.0 / (1.0 + min_distance)
        
        return float(novelty)
    
    def set_forward_model(self, model: Callable) -> None:
        self._forward_model = model
    
    def reset(self) -> None:
        super().reset()
        self._state_buffer.clear()


class CountBasedExplorationReward(BaseRewardFunction):
    """Count-based exploration bonus for discrete state spaces."""
    
    def __init__(
        self,
        state_bins: int = 20,
        bonus_scale: float = 0.1,
        reward_clip: Tuple[float, float] = (0.0, 1.0),
        state_dim: Optional[int] = None,
    ):
        super().__init__(name="CountBasedExplorationReward", reward_clip=reward_clip)
        
        self.state_bins = state_bins
        self.bonus_scale = bonus_scale
        self.state_dim = state_dim
        
        self._state_counts: Dict[int, int] = defaultdict(int)
        self._total_visits = 0
    
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        state_key = self._discretize_state(next_state)
        
        self._state_counts[state_key] += 1
        self._total_visits += 1
        
        count = self._state_counts[state_key]
        bonus = self.bonus_scale / np.sqrt(count)
        
        final_reward = self._clip_reward(bonus)
        self._record_reward(final_reward)
        
        return final_reward
    
    def _discretize_state(self, state: np.ndarray) -> int:
        state = np.asarray(state, dtype=np.float32).flatten()
        
        if self.state_dim is not None:
            state = state[:self.state_dim]
        
        state = np.tanh(state)
        
        bins = np.digitize(state, np.linspace(-1, 1, self.state_bins)) - 1
        bins = np.clip(bins, 0, self.state_bins - 1)
        
        key = 0
        multiplier = 1
        for b in bins:
            key += b * multiplier
            multiplier *= self.state_bins
        
        return key
    
    def get_visited_states_ratio(self) -> float:
        max_possible_states = self.state_bins ** self.state_dim if self.state_dim else 0
        if max_possible_states == 0:
            return 0.0
        return len(self._state_counts) / max_possible_states
    
    def reset(self) -> None:
        super().reset()
        self._state_counts.clear()
        self._total_visits = 0


class ConstraintPenaltyReward(BaseRewardFunction):
    """Constraint penalty reward to prevent reward hacking."""
    
    def __init__(
        self,
        constraint_fn: Callable[[np.ndarray, Union[int, np.ndarray], np.ndarray, Dict], bool],
        penalty: float = -1.0,
        constraint_name: str = "constraint",
        reward_clip: Tuple[float, float] = (-1.0, 0.0),
    ):
        super().__init__(name=f"ConstraintPenaltyReward_{constraint_name}", 
                        reward_clip=reward_clip)
        
        self.constraint_fn = constraint_fn
        self.penalty = penalty
        self.constraint_name = constraint_name
        self._violation_count = 0
    
    def compute(
        self,
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        try:
            violated = self.constraint_fn(state, action, next_state, info)
        except Exception as e:
            print(f"Warning: Error in constraint function '{self.constraint_name}': {e}")
            violated = False
        
        if violated:
            self._violation_count += 1
            final_reward = self._clip_reward(self.penalty)
        else:
            final_reward = 0.0
        
        self._record_reward(final_reward)
        return final_reward
    
    def get_violation_count(self) -> int:
        return self._violation_count
    
    def reset(self) -> None:
        super().reset()
        self._violation_count = 0


class RewardValidator:
    """Validator for reward function behavior and stability."""
    
    @staticmethod
    def validate(
        reward_fn: BaseRewardFunction,
        num_steps: int = 1000,
        state_shape: Tuple[int, ...] = (14,),
        action_space_size: int = 64,
    ) -> Dict[str, Any]:
        issues = []
        warnings = []
        rewards = []
        
        np.random.seed(42)
        
        state = np.random.randn(*state_shape).astype(np.float32)
        
        for step in range(num_steps):
            action = np.random.randint(0, action_space_size)
            next_state = np.random.randn(*state_shape).astype(np.float32)
            
            info = {
                "done": step == num_steps - 1,
                "collision": step % 100 == 50,
                "goal_reached": step == num_steps - 1,
                "episode_step": step,
            }
            
            try:
                reward = reward_fn.compute(state, action, next_state, info)
                rewards.append(reward)
                
                if not np.isfinite(reward):
                    issues.append(f"Step {step}: Non-finite reward: {reward}")
                
            except Exception as e:
                issues.append(f"Step {step}: Exception: {str(e)}")
            
            state = next_state
        
        if rewards:
            rewards = np.array(rewards)
            
            if np.max(np.abs(rewards)) > 1000:
                warnings.append("Reward magnitudes are very large (>1000)")
            
            if np.std(rewards) < 1e-6:
                issues.append("Reward function has near-zero variance (likely dead)")
            
            mean_reward = np.mean(rewards)
            if abs(mean_reward) > 100:
                warnings.append(f"Mean reward is very large: {mean_reward:.2f}")
        
        statistics = reward_fn.get_statistics()
        
        is_valid = len(issues) == 0
        
        return {
            "is_valid": is_valid,
            "issues": issues,
            "warnings": warnings,
            "statistics": statistics,
        }
    
    @staticmethod
    def check_gradient_friendly(
        reward_fn: BaseRewardFunction,
        state_range: Tuple[float, float] = (-1.0, 1.0),
        num_samples: int = 100,
    ) -> Dict[str, Any]:
        np.random.seed(42)
        
        changes = []
        
        for _ in range(num_samples):
            base_state = np.random.uniform(state_range[0], state_range[1], size=(14,))
            next_state1 = base_state + np.random.randn(14) * 0.01
            next_state2 = base_state + np.random.randn(14) * 0.01
            
            action = np.random.randint(0, 64)
            info = {"done": False, "collision": False, "goal_reached": False}
            
            try:
                reward1 = reward_fn.compute(base_state, action, next_state1, info)
                reward2 = reward_fn.compute(base_state, action, next_state2, info)
                
                change = abs(reward2 - reward1)
                changes.append(change)
                
            except Exception:
                pass
        
        if changes:
            changes = np.array(changes)
            return {
                "mean_change": float(np.mean(changes)),
                "max_change": float(np.max(changes)),
                "std_change": float(np.std(changes)),
                "is_smooth": np.mean(changes) < 1.0,
            }
        
        return {
            "mean_change": 0.0,
            "max_change": 0.0,
            "std_change": 0.0,
            "is_smooth": True,
        }


def validate_reward(
    reward: float,
    clip_range: Tuple[float, float] = (-np.inf, np.inf),
    allow_nan: bool = False,
    allow_inf: bool = False,
) -> Tuple[bool, Optional[str]]:
    if not allow_nan and np.isnan(reward):
        return False, "Reward is NaN"
    
    if not allow_inf and np.isinf(reward):
        return False, "Reward is infinite"
    
    if reward < clip_range[0] or reward > clip_range[1]:
        return False, f"Reward {reward} outside range {clip_range}"
    
    return True, None


def create_reward_from_config(config: Dict[str, Any]) -> BaseRewardFunction:
    config = copy.deepcopy(config)
    reward_type = config.pop("type", "navigation").lower()
    
    if reward_type == "navigation":
        if "goal_position" in config:
            config["goal_position"] = np.array(config["goal_position"])
        return NavigationReward(**config)
    
    elif reward_type == "curiosity":
        return CuriosityReward(**config)
    
    elif reward_type == "count_based":
        return CountBasedExplorationReward(**config)
    
    elif reward_type == "composite":
        components = []
        for comp_config in config.pop("components", []):
            comp_type = comp_config.pop("type", "navigation")
            if "goal_position" in comp_config:
                comp_config["goal_position"] = np.array(comp_config["goal_position"])
            comp_fn = create_reward_from_config({"type": comp_type, **comp_config})
            weight = comp_config.get("weight", 1.0)
            components.append((comp_fn, weight))
        return CompositeReward(components=components, **config)
    
    else:
        raise ValueError(f"Unknown reward type: {reward_type}")


def make_reward_function(
    reward_config: Union[Dict[str, Any], BaseRewardFunction],
) -> Callable[[np.ndarray, int, np.ndarray, Dict], float]:
    if isinstance(reward_config, BaseRewardFunction):
        reward_fn = reward_config
    else:
        reward_fn = create_reward_from_config(reward_config)
    
    def reward_callable(
        state: np.ndarray,
        action: Union[int, np.ndarray],
        next_state: np.ndarray,
        info: Dict[str, Any],
    ) -> float:
        return reward_fn.compute(state, action, next_state, info)
    
    return reward_callable


def rllib_reward_batch_fn(
    reward_fn: BaseRewardFunction,
) -> Callable[[Dict], np.ndarray]:
    def batch_reward(batch: Dict) -> np.ndarray:
        obs = batch["obs"]
        actions = batch["actions"]
        next_obs = batch["new_obs"]
        
        infos = batch.get("infos", [{}] * len(obs))
        
        rewards = []
        for i in range(len(obs)):
            info = infos[i] if i < len(infos) else {}
            info["batch_index"] = i
            
            reward = reward_fn.compute(obs[i], actions[i], next_obs[i], info)
            rewards.append(reward)
        
        return np.array(rewards, dtype=np.float32)
    
    return batch_reward
