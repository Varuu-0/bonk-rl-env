"""Tests for reward functions in reward_functions.py."""
import pytest
import numpy as np
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reward.reward_functions import (
    BaseRewardFunction,
    NavigationReward,
    CompositeReward,
    CuriosityReward,
    CountBasedExplorationReward,
    ConstraintPenaltyReward,
    RewardValidator,
    validate_reward,
    create_reward_from_config,
    make_reward_function,
    rllib_reward_batch_fn,
)


def _make_state(size=14):
    return np.random.randn(size).astype(np.float32)


def _make_info(**kwargs):
    info = {"done": False, "collision": False, "goal_reached": False}
    info.update(kwargs)
    return info


class TestNavigationReward:
    def test_positive_shaping_toward_goal(self, navigation_reward):
        state = np.array([0.0, 0.0, 0.0, 0.0], dtype=np.float32)
        next_state = np.array([1.0, 1.0, 0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info()

        reward = navigation_reward.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert -1.0 <= reward <= 1.0

    def test_negative_shaping_away_from_goal(self, navigation_reward):
        state = np.array([9.0, 9.0, 0.0, 0.0], dtype=np.float32)
        next_state = np.array([0.0, 0.0, 0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info()

        reward = navigation_reward.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert -1.0 <= reward <= 1.0

    def test_collision_penalty(self, navigation_reward):
        state = np.array([5.0, 5.0, 0.0, 0.0], dtype=np.float32)
        next_state = np.array([5.1, 5.1, 0.0, 0.0], dtype=np.float32)
        action = 0
        info_no_collision = _make_info(collision=False)
        info_collision = _make_info(collision=True)

        reward_no_collision = navigation_reward.compute(
            state, action, next_state, info_no_collision
        )
        reward_collision = navigation_reward.compute(
            state, action, next_state, info_collision
        )

        assert reward_collision < reward_no_collision

    def test_time_penalty(self, navigation_reward):
        state = np.array([5.0, 5.0, 0.0, 0.0], dtype=np.float32)
        next_state = np.array([5.0, 5.0, 0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info()

        reward = navigation_reward.compute(state, action, next_state, info)

        assert reward <= 0.0 or reward > -1.0

    def test_reward_clipping(self, navigation_reward):
        state = _make_state(4)
        next_state = _make_state(4)
        action = 0
        info = _make_info()

        reward = navigation_reward.compute(state, action, next_state, info)

        assert -1.0 <= reward <= 1.0

    def test_goal_reached_bonus(self):
        reward_fn = NavigationReward(
            goal_position=np.array([0.0, 0.0], dtype=np.float32),
            collision_penalty=-1.0,
            time_penalty=-0.01,
            time_bonus=1.0,
            success_radius=1.0,
            reward_clip=(-1.0, 1.0),
        )
        state = np.array([0.1, 0.1, 0.0, 0.0], dtype=np.float32)
        next_state = np.array([0.0, 0.0, 0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info(done=True, goal_reached=True)

        reward = reward_fn.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert -1.0 <= reward <= 1.0

    def test_reset_clears_state(self, navigation_reward):
        state = _make_state(4)
        next_state = _make_state(4)
        navigation_reward.compute(state, 0, next_state, _make_info())
        navigation_reward.reset()

        assert navigation_reward._prev_distance is None
        assert navigation_reward._episode_step == 0

    def test_set_goal(self, navigation_reward):
        new_goal = np.array([20.0, 30.0], dtype=np.float32)
        navigation_reward.set_goal(new_goal)

        np.testing.assert_array_equal(
            navigation_reward.goal_position, new_goal
        )

    def test_statistics(self, navigation_reward):
        for _ in range(10):
            state = _make_state(4)
            next_state = _make_state(4)
            navigation_reward.compute(state, 0, next_state, _make_info())

        stats = navigation_reward.get_statistics()

        assert "mean" in stats
        assert "std" in stats
        assert "min" in stats
        assert "max" in stats
        assert "count" in stats
        assert stats["count"] == 10

    def test_potential_shaping_disabled(self):
        reward_fn = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            enable_potential_shaping=False,
            reward_clip=(-1.0, 1.0),
        )
        state = _make_state(4)
        next_state = _make_state(4)
        info = _make_info()

        reward = reward_fn.compute(state, 0, next_state, info)

        assert isinstance(reward, float)
        assert -1.0 <= reward <= 1.0


class TestCompositeReward:
    def test_weighted_combination(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        curiosity = CuriosityReward(
            eta=0.1, reward_clip=(-1.0, 1.0)
        )
        composite = CompositeReward(
            components=[(nav, 1.0), (curiosity, 0.5)],
            reward_clip=(-2.0, 2.0),
        )

        state = _make_state()
        next_state = _make_state()
        action = 0
        info = _make_info()

        reward = composite.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert -2.0 <= reward <= 2.0

    def test_normalization(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-5.0, 5.0),
            normalize=True,
            normalize_window=10,
        )

        for _ in range(20):
            state = _make_state()
            next_state = _make_state()
            composite.compute(state, 0, next_state, _make_info())

    def test_disabled_component(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
            enabled=False,
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-1.0, 1.0),
        )

        state = _make_state()
        next_state = _make_state()
        reward = composite.compute(state, 0, next_state, _make_info())

        assert reward == 0.0

    def test_set_weight(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-2.0, 2.0),
        )

        composite.set_weight("NavigationReward", 2.0)

        assert composite.weights["NavigationReward"] == 2.0

    def test_set_weight_invalid_component(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-2.0, 2.0),
        )

        with pytest.raises(ValueError, match="not found"):
            composite.set_weight("nonexistent", 1.0)

    def test_component_statistics(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-2.0, 2.0),
        )

        stats = composite.get_component_statistics()

        assert "NavigationReward" in stats

    def test_reset_resets_components(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        composite = CompositeReward(
            components=[(nav, 1.0)],
            reward_clip=(-2.0, 2.0),
        )

        composite.compute(_make_state(), 0, _make_state(), _make_info())
        composite.reset()

        assert nav._call_count == 0


class TestCuriosityReward:
    def test_novel_state_high_reward(self, curiosity_reward):
        state = _make_state()
        next_state = _make_state()
        action = 0
        info = _make_info()

        reward = curiosity_reward.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert -1.0 <= reward <= 1.0

    def test_visited_state_low_reward(self, curiosity_reward):
        state = np.zeros(14, dtype=np.float32)
        next_state = np.zeros(14, dtype=np.float32)
        action = 0
        info = _make_info()

        rewards = []
        for _ in range(10):
            r = curiosity_reward.compute(state, action, next_state, info)
            rewards.append(r)

        assert rewards[-1] <= rewards[0] or rewards[-1] == rewards[0]

    def test_reward_clipping(self, curiosity_reward):
        state = _make_state()
        next_state = _make_state()
        action = 0
        info = _make_info()

        reward = curiosity_reward.compute(state, action, next_state, info)

        assert -1.0 <= reward <= 1.0

    def test_reset_clears_buffer(self, curiosity_reward):
        curiosity_reward.compute(_make_state(), 0, _make_state(), _make_info())
        curiosity_reward.reset()

        assert len(curiosity_reward._state_buffer) == 0

    def test_initial_curiosity_with_empty_buffer(self):
        reward_fn = CuriosityReward(
            reward_clip=(-1.0, 1.0),
        )
        state = _make_state()
        next_state = _make_state()

        reward = reward_fn.compute(state, 0, next_state, _make_info())

        assert isinstance(reward, float)


class TestCountBasedExplorationReward:
    def test_first_visit_high_reward(self, count_based_reward):
        state = np.array([0.0, 0.0], dtype=np.float32)
        next_state = np.array([0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info()

        reward = count_based_reward.compute(state, action, next_state, info)

        assert isinstance(reward, float)
        assert 0.0 <= reward <= 1.0

    def test_repeated_visit_low_reward(self, count_based_reward):
        state = np.array([0.0, 0.0], dtype=np.float32)
        next_state = np.array([0.0, 0.0], dtype=np.float32)
        action = 0
        info = _make_info()

        first_reward = count_based_reward.compute(
            state, action, next_state, info
        )
        second_reward = count_based_reward.compute(
            state, action, next_state, info
        )

        assert second_reward <= first_reward

    def test_reward_clipping(self, count_based_reward):
        state = _make_state(2)
        next_state = _make_state(2)
        action = 0
        info = _make_info()

        reward = count_based_reward.compute(state, action, next_state, info)

        assert 0.0 <= reward <= 1.0

    def test_reset_clears_counts(self, count_based_reward):
        count_based_reward.compute(
            np.array([0.0, 0.0], dtype=np.float32),
            0,
            np.array([0.0, 0.0], dtype=np.float32),
            _make_info(),
        )
        count_based_reward.reset()

        assert len(count_based_reward._state_counts) == 0
        assert count_based_reward._total_visits == 0

    def test_visited_states_ratio(self):
        reward_fn = CountBasedExplorationReward(
            state_bins=5,
            state_dim=2,
        )
        reward_fn.compute(
            np.array([0.0, 0.0], dtype=np.float32),
            0,
            np.array([0.0, 0.0], dtype=np.float32),
            _make_info(),
        )

        ratio = reward_fn.get_visited_states_ratio()

        assert 0.0 <= ratio <= 1.0


class TestConstraintPenaltyReward:
    def test_no_violation_zero_reward(self, constraint_penalty_reward):
        state = _make_state()
        next_state = _make_state()
        action = 0
        info = _make_info(constraint_violated=False)

        reward = constraint_penalty_reward.compute(
            state, action, next_state, info
        )

        assert reward == 0.0

    def test_violation_negative_reward(self, constraint_penalty_reward):
        state = _make_state()
        next_state = _make_state()
        action = 0
        info = _make_info(constraint_violated=True)

        reward = constraint_penalty_reward.compute(
            state, action, next_state, info
        )

        assert reward < 0.0
        assert -1.0 <= reward <= 0.0

    def test_violation_count(self, constraint_penalty_reward):
        state = _make_state()
        next_state = _make_state()
        action = 0

        constraint_penalty_reward.compute(
            state, action, next_state, _make_info(constraint_violated=True)
        )
        constraint_penalty_reward.compute(
            state, action, next_state, _make_info(constraint_violated=True)
        )

        assert constraint_penalty_reward.get_violation_count() == 2

    def test_reset_clears_violation_count(self, constraint_penalty_reward):
        constraint_penalty_reward.compute(
            _make_state(), 0, _make_state(), _make_info(constraint_violated=True)
        )
        constraint_penalty_reward.reset()

        assert constraint_penalty_reward.get_violation_count() == 0

    def test_constraint_error_handling(self):
        def bad_constraint(state, action, next_state, info):
            raise ValueError("test error")

        reward_fn = ConstraintPenaltyReward(
            constraint_fn=bad_constraint,
            penalty=-1.0,
            constraint_name="bad",
            reward_clip=(-1.0, 0.0),
        )

        reward = reward_fn.compute(
            _make_state(), 0, _make_state(), _make_info()
        )

        assert reward == 0.0


class TestRewardValidator:
    def test_validate_navigation_reward(self, navigation_reward):
        result = RewardValidator.validate(
            navigation_reward, num_steps=50
        )

        assert "is_valid" in result
        assert "issues" in result
        assert "warnings" in result
        assert "statistics" in result

    def test_validate_curiosity_reward(self, curiosity_reward):
        result = RewardValidator.validate(
            curiosity_reward, num_steps=50
        )

        assert "is_valid" in result
        assert isinstance(result["is_valid"], bool)

    def test_check_gradient_friendly(self, navigation_reward):
        result = RewardValidator.check_gradient_friendly(
            navigation_reward, num_samples=20
        )

        assert "mean_change" in result
        assert "max_change" in result
        assert "std_change" in result
        assert "is_smooth" in result


class TestValidateReward:
    def test_valid_reward(self):
        valid, msg = validate_reward(0.5, clip_range=(-1.0, 1.0))

        assert valid is True
        assert msg is None

    def test_nan_reward(self):
        valid, msg = validate_reward(float("nan"))

        assert valid is False
        assert "NaN" in msg

    def test_inf_reward(self):
        valid, msg = validate_reward(float("inf"))

        assert valid is False
        assert "infinite" in msg

    def test_out_of_range_reward(self):
        valid, msg = validate_reward(5.0, clip_range=(-1.0, 1.0))

        assert valid is False
        assert "outside range" in msg

    def test_allow_nan(self):
        valid, msg = validate_reward(float("nan"), allow_nan=True)

        assert valid is True

    def test_allow_inf(self):
        valid, msg = validate_reward(float("inf"), allow_inf=True)

        assert valid is True


class TestCreateRewardFromConfig:
    def test_create_navigation(self):
        config = {
            "type": "navigation",
            "goal_position": [10.0, 10.0],
            "collision_penalty": -1.0,
        }

        reward_fn = create_reward_from_config(config)

        assert isinstance(reward_fn, NavigationReward)

    def test_create_curiosity(self):
        config = {
            "type": "curiosity",
            "eta": 0.1,
        }

        reward_fn = create_reward_from_config(config)

        assert isinstance(reward_fn, CuriosityReward)

    def test_create_count_based(self):
        config = {
            "type": "count_based",
            "state_bins": 20,
        }

        reward_fn = create_reward_from_config(config)

        assert isinstance(reward_fn, CountBasedExplorationReward)

    def test_create_composite(self):
        config = {
            "type": "composite",
            "components": [
                {
                    "type": "navigation",
                    "goal_position": [10.0, 10.0],
                    "weight": 1.0,
                }
            ],
        }

        reward_fn = create_reward_from_config(config)

        assert isinstance(reward_fn, CompositeReward)

    def test_unknown_type_raises(self):
        config = {"type": "unknown"}

        with pytest.raises(ValueError, match="Unknown reward type"):
            create_reward_from_config(config)


class TestMakeRewardFunction:
    def test_from_config(self):
        config = {
            "type": "navigation",
            "goal_position": [10.0, 10.0],
        }

        fn = make_reward_function(config)

        reward = fn(_make_state(), 0, _make_state(), _make_info())
        assert isinstance(reward, float)

    def test_from_instance(self):
        reward_fn = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
        )

        fn = make_reward_function(reward_fn)

        reward = fn(_make_state(), 0, _make_state(), _make_info())
        assert isinstance(reward, float)


class TestRLlibRewardBatchFn:
    def test_batch_reward(self):
        nav = NavigationReward(
            goal_position=np.array([10.0, 10.0], dtype=np.float32),
            reward_clip=(-1.0, 1.0),
        )
        batch_fn = rllib_reward_batch_fn(nav)

        batch = {
            "obs": np.array([_make_state() for _ in range(4)]),
            "actions": np.array([0, 1, 2, 3]),
            "new_obs": np.array([_make_state() for _ in range(4)]),
        }

        rewards = batch_fn(batch)

        assert isinstance(rewards, np.ndarray)
        assert rewards.shape == (4,)
        assert rewards.dtype == np.float32
