import pytest
import numpy as np


@pytest.mark.slow
class TestBonkVecEnvConnectionLifecycle:
    def test_create_and_close(self, bonk_vec_env_single):
        assert bonk_vec_env_single is not None

    def test_reset_returns_obs_and_info(self, bonk_vec_env_single):
        obs, info = bonk_vec_env_single.reset()
        assert isinstance(obs, np.ndarray)
        assert isinstance(info, dict)

    def test_step_returns_correct_shapes(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        action = np.array([0])
        bonk_vec_env_single.step_async(action)
        obs, rewards, terminated, truncated, infos = bonk_vec_env_single.step_wait()

        assert obs.shape == (1, 14)
        assert rewards.shape == (1,)
        assert terminated.shape == (1,)
        assert truncated.shape == (1,)
        assert isinstance(infos, list)
        assert len(infos) == 1

    def test_close_can_be_called_multiple_times(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1)
        env.close()
        env.close()


@pytest.mark.slow
class TestBonkVecEnvObservationShape:
    def test_observation_shape_single_env(self, bonk_vec_env_single):
        obs, _ = bonk_vec_env_single.reset()
        assert obs.shape == (1, 14)

    def test_observation_shape_multi_env(self, bonk_vec_env):
        obs, _ = bonk_vec_env.reset()
        assert obs.shape == (2, 14)

    def test_observation_shape_after_step(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 0])
        bonk_vec_env.step_async(actions)
        obs, _, _, _, _ = bonk_vec_env.step_wait()
        assert obs.shape == (2, 14)

    def test_observation_dtype(self, bonk_vec_env_single):
        obs, _ = bonk_vec_env_single.reset()
        assert obs.dtype == np.float32


@pytest.mark.slow
class TestBonkVecEnvRewardShape:
    def test_reward_shape_single_env(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        _, rewards, _, _, _ = bonk_vec_env_single.step_wait()
        assert rewards.shape == (1,)

    def test_reward_shape_multi_env(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 0])
        bonk_vec_env.step_async(actions)
        _, rewards, _, _, _ = bonk_vec_env.step_wait()
        assert rewards.shape == (2,)

    def test_reward_dtype(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        _, rewards, _, _, _ = bonk_vec_env_single.step_wait()
        assert rewards.dtype == np.float64 or rewards.dtype == np.float32


@pytest.mark.slow
class TestBonkVecEnvDoneShapes:
    def test_terminated_shape(self, bonk_vec_env):
        bonk_vec_env.reset()
        bonk_vec_env.step_async(np.array([0, 0]))
        _, _, terminated, _, _ = bonk_vec_env.step_wait()
        assert terminated.shape == (2,)
        assert terminated.dtype == bool

    def test_truncated_shape(self, bonk_vec_env):
        bonk_vec_env.reset()
        bonk_vec_env.step_async(np.array([0, 0]))
        _, _, _, truncated, _ = bonk_vec_env.step_wait()
        assert truncated.shape == (2,)
        assert truncated.dtype == bool


@pytest.mark.slow
class TestBonkVecEnvActionSpace:
    def test_action_space_is_discrete(self, bonk_vec_env_single):
        assert bonk_vec_env_single.action_space.n == 64

    def test_valid_action_zero(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        obs, rewards, terminated, truncated, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)

    def test_valid_action_max(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([63]))
        obs, rewards, terminated, truncated, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)

    def test_valid_action_mid_range(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([32]))
        obs, rewards, terminated, truncated, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)


@pytest.mark.slow
class TestBonkVecEnvMultipleReset:
    def test_multiple_reset_calls(self, bonk_vec_env_single):
        obs1, _ = bonk_vec_env_single.reset()
        obs2, _ = bonk_vec_env_single.reset()
        assert obs1.shape == (1, 14)
        assert obs2.shape == (1, 14)

    def test_reset_between_episodes(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        bonk_vec_env_single.step_wait()
        obs, _ = bonk_vec_env_single.reset()
        assert obs.shape == (1, 14)


@pytest.mark.slow
class TestBonkVecEnvConfigurableNumEnvs:
    def test_num_envs_4(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=4)
        obs, _ = env.reset()
        assert obs.shape == (4, 14)
        env.close()

    def test_num_envs_8(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=8)
        obs, _ = env.reset()
        assert obs.shape == (8, 14)
        env.close()


@pytest.mark.slow
class TestBonkVecEnvStepSequence:
    def test_multiple_steps(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        for _ in range(5):
            bonk_vec_env_single.step_async(np.array([0]))
            obs, rewards, terminated, truncated, infos = bonk_vec_env_single.step_wait()
            assert obs.shape == (1, 14)
            assert rewards.shape == (1,)

    def test_step_with_different_actions(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 63])
        bonk_vec_env.step_async(actions)
        obs, rewards, terminated, truncated, infos = bonk_vec_env.step_wait()
        assert obs.shape == (2, 14)
        assert rewards.shape == (2,)
