import pytest
import numpy as np


@pytest.mark.slow
class TestBonkVecEnvConnectionLifecycle:
    def test_create_and_close(self, bonk_vec_env_single):
        assert bonk_vec_env_single is not None

    def test_reset_returns_observation_array(self, bonk_vec_env_single):
        obs = bonk_vec_env_single.reset()
        assert isinstance(obs, np.ndarray)

    def test_step_returns_correct_shapes(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        action = np.array([0])
        bonk_vec_env_single.step_async(action)
        obs, rewards, dones, infos = bonk_vec_env_single.step_wait()

        assert obs.shape == (1, 14)
        assert rewards.shape == (1,)
        assert dones.shape == (1,)
        assert dones.dtype == bool
        assert isinstance(infos, list)
        assert len(infos) == 1

    def test_close_can_be_called_multiple_times(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1)
        env.close()
        env.close()

    def test_close_keeps_server_available_for_a_new_session(self, bonk_vec_env_factory):
        first_env = bonk_vec_env_factory(num_envs=1)
        first_env.reset(seeds=[1])
        first_env.close()

        second_env = bonk_vec_env_factory(num_envs=1)
        obs = second_env.reset(seeds=[2])
        assert obs.shape == (1, 14)


@pytest.mark.slow
class TestBonkVecEnvObservationShape:
    def test_observation_shape_single_env(self, bonk_vec_env_single):
        obs = bonk_vec_env_single.reset()
        assert obs.shape == (1, 14)

    def test_observation_shape_multi_env(self, bonk_vec_env):
        obs = bonk_vec_env.reset()
        assert obs.shape == (2, 14)

    def test_observation_shape_after_step(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 0])
        bonk_vec_env.step_async(actions)
        obs, _, _, _ = bonk_vec_env.step_wait()
        assert obs.shape == (2, 14)

    def test_observation_dtype(self, bonk_vec_env_single):
        obs = bonk_vec_env_single.reset()
        assert obs.dtype == np.float32


@pytest.mark.slow
class TestBonkVecEnvRewardShape:
    def test_reward_shape_single_env(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        _, rewards, _, _ = bonk_vec_env_single.step_wait()
        assert rewards.shape == (1,)

    def test_reward_shape_multi_env(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 0])
        bonk_vec_env.step_async(actions)
        _, rewards, _, _ = bonk_vec_env.step_wait()
        assert rewards.shape == (2,)

    def test_reward_dtype(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        _, rewards, _, _ = bonk_vec_env_single.step_wait()
        assert rewards.dtype == np.float64 or rewards.dtype == np.float32


@pytest.mark.slow
class TestBonkVecEnvDoneShapes:
    def test_dones_shape_and_dtype(self, bonk_vec_env):
        bonk_vec_env.reset()
        bonk_vec_env.step_async(np.array([0, 0]))
        _, _, dones, _ = bonk_vec_env.step_wait()
        assert dones.shape == (2,)
        assert dones.dtype == bool

    def test_infos_report_done_reasoning(self, bonk_vec_env):
        bonk_vec_env.reset()
        bonk_vec_env.step_async(np.array([0, 0]))
        _, _, dones, infos = bonk_vec_env.step_wait()
        assert len(infos) == 2
        assert all(isinstance(info, dict) for info in infos)
        for info, done in zip(infos, dones):
            if done:
                assert "episode" in info
            assert "_episode" in info
            assert "terminated" in info["_episode"]
            assert "truncated" in info["_episode"]


@pytest.mark.slow
class TestBonkVecEnvActionSpace:
    def test_action_space_is_discrete(self, bonk_vec_env_single):
        assert bonk_vec_env_single.action_space.n == 64

    def test_valid_action_zero(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        obs, rewards, dones, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)

    def test_valid_action_max(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([63]))
        obs, rewards, dones, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)

    def test_valid_action_mid_range(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([32]))
        obs, rewards, dones, infos = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)

    def test_invalid_actions_do_not_poison_the_live_session(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()

        with pytest.raises(TypeError, match="must be an integer"):
            bonk_vec_env_single.step_async(np.array([1.5]))
        with pytest.raises(ValueError, match="must be in \\[0, 63\\]"):
            bonk_vec_env_single.step_async(np.array([64]))

        bonk_vec_env_single.step_async(np.array([0]))
        obs, _, _, _ = bonk_vec_env_single.step_wait()
        assert obs.shape == (1, 14)


@pytest.mark.slow
class TestBonkVecEnvMultipleReset:
    def test_multiple_reset_calls(self, bonk_vec_env_single):
        obs1 = bonk_vec_env_single.reset()
        obs2 = bonk_vec_env_single.reset()
        assert obs1.shape == (1, 14)
        assert obs2.shape == (1, 14)

    def test_reset_between_episodes(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        bonk_vec_env_single.step_async(np.array([0]))
        bonk_vec_env_single.step_wait()
        obs = bonk_vec_env_single.reset()
        assert obs.shape == (1, 14)

    def test_numpy_seed_transport_boundaries(self, bonk_vec_env_single):
        obs = bonk_vec_env_single.reset(seeds=np.array([np.uint64(0xFFFFFFFE)]))
        assert obs.shape == (1, 14)

    def test_invalid_seed_does_not_poison_the_live_session(self, bonk_vec_env_single):
        with pytest.raises(ValueError, match="must be in \\[0, 4294967294\\]"):
            bonk_vec_env_single.reset(seeds=[0xFFFFFFFF])

        obs = bonk_vec_env_single.reset(seeds=[0])
        assert obs.shape == (1, 14)


@pytest.mark.slow
class TestBonkVecEnvConfigurableNumEnvs:
    def test_num_envs_4(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=4)
        obs = env.reset()
        assert obs.shape == (4, 14)
        env.close()

    def test_num_envs_8(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=8)
        obs = env.reset()
        assert obs.shape == (8, 14)
        env.close()


@pytest.mark.slow
class TestBonkVecEnvStepSequence:
    def test_multiple_steps(self, bonk_vec_env_single):
        bonk_vec_env_single.reset()
        for _ in range(5):
            bonk_vec_env_single.step_async(np.array([0]))
            obs, rewards, dones, infos = bonk_vec_env_single.step_wait()
            assert obs.shape == (1, 14)
            assert rewards.shape == (1,)

    def test_step_with_different_actions(self, bonk_vec_env):
        bonk_vec_env.reset()
        actions = np.array([0, 63])
        bonk_vec_env.step_async(actions)
        obs, rewards, dones, infos = bonk_vec_env.step_wait()
        assert obs.shape == (2, 14)
        assert rewards.shape == (2,)


@pytest.mark.slow
class TestBonkVecEnvSb3Contract:
    """Regression tests for #177.

    BonkVecEnv must satisfy the stable-baselines3 ``VecEnv`` contract
    (``reset()`` -> observation array, ``step()`` -> 4-tuple) so that
    ``PPO.learn()`` and friends can drive it directly. These tests exercise
    the exact call pattern used by ``PPO.collect_rollouts``.
    """

    def test_reset_returns_plain_observation_array(self, bonk_vec_env):
        # SB3 stores env.reset() into self._last_obs and feeds it straight to
        # obs_as_tensor, which rejects tuples ("Unrecognized type of observation").
        obs = bonk_vec_env.reset()
        assert isinstance(obs, np.ndarray)
        assert not isinstance(obs, tuple)
        assert obs.shape == (2, 14)

    def test_step_returns_sb3_4_tuple(self, bonk_vec_env):
        obs = bonk_vec_env.reset()
        assert isinstance(obs, np.ndarray)
        new_obs, rewards, dones, infos = bonk_vec_env.step(np.array([0, 0]))
        assert isinstance(new_obs, np.ndarray)
        assert new_obs.shape == (2, 14)
        assert rewards.shape == (2,)
        assert dones.shape == (2,)
        assert dones.dtype == bool
        assert isinstance(infos, list)
        assert len(infos) == 2

    def test_ppo_learn_style_rollout_loop(self, bonk_vec_env):
        # Mirror of PPO.collect_rollouts: reset once, then repeatedly
        # env.step(clipped_actions) -> (new_obs, rewards, dones, infos).
        obs = bonk_vec_env.reset()
        assert isinstance(obs, np.ndarray)
        for _ in range(8):
            new_obs, rewards, dones, infos = bonk_vec_env.step(np.array([0, 0]))
            assert isinstance(new_obs, np.ndarray)
            assert new_obs.shape == (2, 14)
            assert rewards.shape == (2,)
            assert dones.shape == (2,)
            assert dones.dtype == bool
            assert len(infos) == 2
            obs = new_obs

    def test_ppo_learn_smoke(self, bonk_vec_env):
        # The exact repro from issue #177: PPO.learn() used to crash on the
        # (obs, info) reset tuple and the 5-tuple step.
        from stable_baselines3 import PPO

        model = PPO("MlpPolicy", bonk_vec_env, n_steps=16, batch_size=8, seed=0)
        model.learn(total_timesteps=32)
        assert model.num_timesteps == 32


@pytest.mark.slow
class TestBonkVecEnvFrameSkipConfig:
    """Regression tests for #204.

    ``frame_skip`` sent through the init config must reach the worker and
    hold each action for the configured number of physics ticks. The
    horizontal velocity direction is the observable: while the first action
    (left) is held, later right actions are ignored and ``playerVelX`` stays
    negative; with ``frame_skip`` 1 every action applies immediately.
    """

    def test_frame_skip_holds_first_action_across_ticks(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1, config={"frame_skip": 8})
        env.reset(seeds=[1])

        # First action: left (1). The next four steps send right (2), which
        # must be ignored while the left action is held for 8 ticks.
        env.step_async(np.array([1]))
        env.step_wait()
        for _ in range(4):
            env.step_async(np.array([2]))
            obs, _, _, _ = env.step_wait()
            # playerVelX (index 2) must stay negative: left is still held.
            assert obs[0][2] < 0

    def test_frame_skip_1_applies_every_action_immediately(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1, config={"frame_skip": 1})
        env.reset(seeds=[1])

        env.step_async(np.array([1]))
        env.step_wait()
        for _ in range(4):
            env.step_async(np.array([2]))
            obs, _, _, _ = env.step_wait()
        # playerVelX (index 2) must be positive: the right action applied.
        assert obs[0][2] > 0


@pytest.mark.slow
class TestBonkVecEnvFrameSkipEpisodeBoundary:
    """Regression tests for #260.

    With ``frame_skip > 1`` the backend keeps serving ``done: true`` for the
    whole terminal hold window after an episode ends (the worker defers the
    auto-reset to the frame-skip cycle boundary, #228). ``step_wait()`` must
    coalesce those hold-tail steps into the episode's first done step: a
    single truncation must surface as exactly one ``dones`` boundary, exactly
    one ``info["episode"]`` record carrying the true accumulated return, and
    ``TimeLimit.truncated`` on only that boundary step.
    """

    def test_frame_skip_hold_reports_single_episode_boundary(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(
            num_envs=1,
            config={"frame_skip": 4, "max_ticks": 5, "num_opponents": 0},
        )
        env.reset(seeds=[1])

        done_steps = []
        truncation_steps = []
        episode_records = []
        episode_return = 0.0

        for step in range(1, 21):
            env.step_async(np.array([0]))
            _, rewards, dones, infos = env.step_wait()
            if len(episode_records) == 0:
                episode_return += float(rewards[0])
            if dones[0]:
                done_steps.append(step)
            if infos[0].get("TimeLimit.truncated") is True:
                truncation_steps.append(step)
            if "episode" in infos[0]:
                episode_records.append(infos[0]["episode"])
            if done_steps and not dones[0]:
                break

        # The truncation is a single episode boundary: done once, then the
        # hold-tail steps return done=False until the fresh episode begins.
        assert done_steps == [5]
        assert len(episode_records) == 1
        # True episode length (max_ticks=5) and the summed step rewards.
        assert episode_records[0]["l"] == 5
        assert episode_records[0]["r"] == pytest.approx(episode_return)
        # The truncation marker is set on exactly the boundary step.
        assert truncation_steps == done_steps


@pytest.mark.slow
@pytest.mark.e2e
class TestBonkVecEnvServerConfigFrameSkip:
    """Regression coverage for #328's config.json-only frame_skip path."""

    def test_server_config_frame_skip_coalesces_terminal_hold(
        self, bonk_server_config
    ):
        from envs.bonk_env import BonkVecEnv

        env = BonkVecEnv(num_envs=1, port=bonk_server_config, config={})
        try:
            env.reset(seeds=[1])
            done_steps = []
            episode_records = []
            truncation_steps = []
            frame_skips = []
            episode_return = 0.0

            for step in range(1, 10):
                env.step_async(np.array([0]))
                _, rewards, dones, infos = env.step_wait()
                info = infos[0]
                frame_skips.append(info["frameSkip"])
                if len(episode_records) == 0:
                    episode_return += float(rewards[0])
                if dones[0]:
                    done_steps.append(step)
                if "episode" in info:
                    episode_records.append(info["episode"])
                if info.get("TimeLimit.truncated") is True:
                    truncation_steps.append(step)

            assert frame_skips == [4] * 9
            assert done_steps == [5]
            assert len(episode_records) == 1
            assert episode_records[0]["l"] == 5
            assert episode_records[0]["r"] == pytest.approx(episode_return)
            assert truncation_steps == [5]
        finally:
            env.close()


@pytest.mark.slow
class TestBonkVecEnvPythonConfigKeys:
    """Regression tests for #204 review follow-up.

    The documented Python-client config keys ``num_opponents``, ``max_ticks``
    and ``random_opponent`` must reach the worker through the server instead
    of being shadowed by the backend's camelCase defaults.
    """

    def test_max_ticks_truncates_at_configured_horizon(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1, config={"max_ticks": 5, "frame_skip": 1})
        env.reset(seeds=[1])

        first_done = None
        for step in range(1, 11):
            env.step_async(np.array([0]))
            _, _, dones, infos = env.step_wait()
            if dones[0]:
                first_done = step
                assert infos[0].get("TimeLimit.truncated") is True
                break
        assert first_done == 5

    def test_num_opponents_zero_episodes_are_not_instantly_terminal(self, bonk_vec_env_factory):
        env = bonk_vec_env_factory(num_envs=1, config={"num_opponents": 0})
        env.reset(seeds=[1])

        for _ in range(3):
            env.step_async(np.array([0]))
            _, _, dones, infos = env.step_wait()
            assert bool(dones[0]) is False
            assert infos[0]["_episode"]["truncated"] is False
