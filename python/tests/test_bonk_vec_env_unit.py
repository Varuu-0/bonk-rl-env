from collections import UserDict
from collections.abc import Mapping
from unittest.mock import MagicMock
import os
import re
import warnings

import numpy as np
import pytest
import zmq

from envs import bonk_env


class _KeyValueMapping(Mapping):
    def __init__(self, data):
        self._data = dict(data)

    def __getitem__(self, key):
        return self._data[key]

    def __iter__(self):
        return iter(self._data)

    def __len__(self):
        return len(self._data)


def _make_mocked_env(monkeypatch, num_envs=1, **kwargs):
    socket = MagicMock()
    socket.recv_json.return_value = {"status": "ok"}
    context = MagicMock()
    context.socket.return_value = socket
    context_factory = MagicMock(return_value=context)
    monkeypatch.setattr(bonk_env.zmq, "Context", context_factory)

    env = bonk_env.BonkVecEnv(num_envs=num_envs, **kwargs)
    return env, context, socket


def test_socket_uses_bounded_options_and_session_close(monkeypatch):
    env, context, socket = _make_mocked_env(
        monkeypatch,
        timeout_ms=123,
        close_timeout_ms=45,
        linger_ms=67,
    )

    socket.setsockopt.assert_any_call(zmq.LINGER, 67)
    socket.setsockopt.assert_any_call(zmq.SNDTIMEO, 123)
    socket.setsockopt.assert_any_call(zmq.RCVTIMEO, 123)

    env.close()

    socket.setsockopt.assert_any_call(zmq.SNDTIMEO, 45)
    socket.setsockopt.assert_any_call(zmq.RCVTIMEO, 45)
    assert socket.send_json.call_args_list[-1].args[0] == {"command": "close"}
    socket.close.assert_called_once_with(linger=67)
    context.term.assert_called_once_with()
    assert env.socket is None
    assert env.context is None


@pytest.mark.parametrize(
    ("operation", "message"),
    [
        ("send_json", "123 ms sending 'init' request"),
        ("recv_json", "123 ms waiting for 'init' response"),
    ],
)
def test_init_timeout_is_clear_and_cleans_up(monkeypatch, operation, message):
    socket = MagicMock()
    getattr(socket, operation).side_effect = zmq.Again()
    context = MagicMock()
    context.socket.return_value = socket
    monkeypatch.setattr(bonk_env.zmq, "Context", MagicMock(return_value=context))

    with pytest.raises(TimeoutError, match=message):
        bonk_env.BonkVecEnv(timeout_ms=123, linger_ms=0)

    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()


def test_socket_creation_failure_terminates_the_context(monkeypatch):
    context = MagicMock()
    context.socket.side_effect = zmq.ZMQError("socket failed")
    monkeypatch.setattr(bonk_env.zmq, "Context", MagicMock(return_value=context))

    with pytest.raises(zmq.ZMQError, match="socket failed"):
        bonk_env.BonkVecEnv()

    context.term.assert_called_once_with()


def test_init_cleanup_failure_preserves_original_exception_and_nulls_transport(
    monkeypatch,
):
    socket = MagicMock()
    socket.recv_json.return_value = {"status": "error", "error": "original init failure"}
    context = MagicMock()
    context.socket.return_value = socket
    context.term.side_effect = zmq.ZMQError("cleanup failed")
    monkeypatch.setattr(bonk_env.zmq, "Context", MagicMock(return_value=context))
    env = bonk_env.BonkVecEnv.__new__(bonk_env.BonkVecEnv)

    with pytest.raises(RuntimeError, match="original init failure"):
        env.__init__(linger_ms=0)

    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()
    assert env.socket is None
    assert env.context is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout_ms": 0},
        {"close_timeout_ms": 0},
        {"linger_ms": -1},
        {"timeout_ms": True},
        {"linger_ms": 1.5},
    ],
)
def test_transport_options_require_bounded_integer_values(kwargs):
    with pytest.raises(ValueError, match="must be an integer greater than or equal to"):
        bonk_env.BonkVecEnv(**kwargs)


@pytest.mark.parametrize(
    "num_envs",
    [
        0,
        -1,
        1.5,
        True,
        "8",
        2 ** 40,
        bonk_env.MAX_NUM_ENVS + 1,
    ],
)
def test_num_envs_validation_rejects_out_of_range_counts(monkeypatch, num_envs):
    """num_envs must be an integer in [1, MAX_NUM_ENVS]; the client rejects
    malformed counts before opening the socket or sending an init request."""
    context_factory = MagicMock()
    monkeypatch.setattr(bonk_env.zmq, "Context", context_factory)

    with pytest.raises(
        ValueError,
        match=f"num_envs must be an integer between 1 and {bonk_env.MAX_NUM_ENVS}",
    ):
        bonk_env.BonkVecEnv(num_envs=num_envs)

    context_factory.assert_not_called()


def test_num_envs_accepts_the_maximum_bound(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=bonk_env.MAX_NUM_ENVS)
    assert env.num_envs == bonk_env.MAX_NUM_ENVS
    env.close()


def test_max_num_envs_matches_typescript_source_of_truth():
    """MAX_NUM_ENVS is a hand-copied mirror of the TS export in
    src/core/worker-pool.ts, and the two transports must never disagree on a
    valid count. Reading the declaration directly ties the Python constant to
    the TS source of truth: any drift (or a renamed/missing export) fails
    here instead of silently splitting client and server acceptance ranges.
    """
    project_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )
    worker_pool_ts = os.path.join(project_root, "src", "core", "worker-pool.ts")
    if not os.path.isfile(worker_pool_ts):
        pytest.fail(
            "src/core/worker-pool.ts not found next to the python package "
            "(renamed or moved?); the MAX_NUM_ENVS parity guard must never "
            "silently disable itself"
        )
    with open(worker_pool_ts, encoding="utf-8") as ts_file:
        source = ts_file.read()
    match = re.search(r"export const MAX_NUM_ENVS = (\d+)", source)
    assert match is not None, (
        "`export const MAX_NUM_ENVS` not found in src/core/worker-pool.ts"
    )
    assert int(match.group(1)) == bonk_env.MAX_NUM_ENVS, (
        f"python MAX_NUM_ENVS={bonk_env.MAX_NUM_ENVS} drifted from the TypeScript "
        f"source of truth ({match.group(1)} in src/core/worker-pool.ts)"
    )


def test_reset_receive_timeout_invalidates_session_and_rejects_later_requests(monkeypatch):
    env, context, socket = _make_mocked_env(monkeypatch, timeout_ms=123, linger_ms=0)
    socket.recv_json.side_effect = zmq.Again()

    with pytest.raises(TimeoutError, match="123 ms waiting for 'reset' response"):
        env.reset(seeds=[1])

    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()
    assert env.socket is None
    assert env.context is None

    # Even if the timed-out reply arrives late, no later request may consume it.
    socket.recv_json.side_effect = None
    socket.recv_json.return_value = {"status": "ok"}
    socket.send_json.reset_mock()
    socket.recv_json.reset_mock()

    for operation in (
        lambda: env.reset(seeds=[2]),
        lambda: env.step_async([0]),
        env.step_wait,
    ):
        with pytest.raises(RuntimeError, match="cannot use BonkVecEnv after a receive timeout"):
            operation()

    socket.send_json.assert_not_called()
    socket.recv_json.assert_not_called()
    env.close()
    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()


def test_step_send_and_receive_timeouts_name_the_command(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, timeout_ms=123)
    socket.send_json.side_effect = zmq.Again()

    with pytest.raises(TimeoutError, match="123 ms sending 'step' request"):
        env.step_async([0])

    socket.send_json.side_effect = None
    socket.recv_json.side_effect = zmq.Again()
    with pytest.raises(TimeoutError, match="123 ms waiting for 'step' response"):
        env.step_wait()

    socket.recv_json.side_effect = None
    socket.recv_json.return_value = {"status": "ok"}
    env.close()


@pytest.mark.parametrize(
    ("operation", "message"),
    [
        ("send_json", "45 ms sending 'close' request"),
        ("recv_json", "45 ms waiting for 'close' response"),
    ],
)
def test_close_timeout_is_clear_bounded_and_idempotent(monkeypatch, operation, message):
    env, context, socket = _make_mocked_env(
        monkeypatch,
        close_timeout_ms=45,
        linger_ms=0,
    )
    getattr(socket, operation).side_effect = zmq.Again()

    with pytest.raises(TimeoutError, match=message):
        env.close()

    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()

    env.close()
    socket.close.assert_called_once_with(linger=0)
    context.term.assert_called_once_with()


@pytest.mark.parametrize("operation", ["reset", "step_async", "step_wait"])
def test_request_operations_after_close_raise_clear_runtime_error(monkeypatch, operation):
    env, _, socket = _make_mocked_env(monkeypatch)
    env.close()
    socket.send_json.reset_mock()
    socket.recv_json.reset_mock()

    with pytest.raises(RuntimeError, match="cannot use BonkVecEnv after close"):
        if operation == "reset":
            env.reset(seeds=[1])
        elif operation == "step_async":
            env.step_async([0])
        else:
            env.step_wait()

    socket.send_json.assert_not_called()
    socket.recv_json.assert_not_called()


def test_step_accepts_integer_actions_and_normalizes_numpy_values(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=2)
    socket.send_json.reset_mock()

    env.step_async([np.int64(0), np.int32(63)])

    socket.send_json.assert_called_once_with({"command": "step", "actions": [0, 63]})
    env.close()


def test_reset_accepts_integer_seeds_and_normalizes_numpy_values(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=2)
    socket.send_json.reset_mock()
    socket.recv_json.side_effect = zmq.Again()

    with pytest.raises(TimeoutError, match="waiting for 'reset' response"):
        env.reset(seeds=np.array([np.uint32(0), np.uint64(0xFFFFFFFE)]))

    socket.send_json.assert_called_once_with(
        {"command": "reset", "seeds": [0, 4294967294], "options": {}}
    )


@pytest.mark.parametrize(
    ("seeds", "error", "message"),
    [
        ([1.0], TypeError, "must be an integer"),
        ([True], TypeError, "must be an integer"),
        ([np.bool_(False)], TypeError, "must be an integer"),
        ([-1], ValueError, "must be in \\[0, 4294967294\\]"),
        ([0xFFFFFFFF], ValueError, "must be in \\[0, 4294967294\\]"),
        (np.array([[0]]), ValueError, "one-dimensional"),
        (0, TypeError, "must be a sequence"),
        ({0: 1}, TypeError, "must be a sequence"),
        (UserDict({0: 1}), TypeError, "must be a sequence"),
        (_KeyValueMapping({0: 1}), TypeError, "must be a sequence"),
        ("12", TypeError, "must be a sequence"),
    ],
)
def test_reset_rejects_non_integer_out_of_range_or_invalid_shape_seeds(
    monkeypatch, seeds, error, message
):
    env, _, socket = _make_mocked_env(monkeypatch)
    socket.send_json.reset_mock()

    with pytest.raises(error, match=message):
        env.reset(seeds=seeds)

    socket.send_json.assert_not_called()
    env.close()


def test_reset_accepts_sequence_containers_besides_lists_and_arrays(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=2)
    socket.send_json.reset_mock()
    socket.recv_json.side_effect = zmq.Again()

    with pytest.raises(TimeoutError, match="waiting for 'reset' response"):
        env.reset(seeds=(1, 2))

    socket.send_json.assert_called_once_with(
        {"command": "reset", "seeds": [1, 2], "options": {}}
    )


def test_reset_requires_one_seed_per_environment(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=2)
    socket.send_json.reset_mock()

    with pytest.raises(ValueError, match="exactly 2 values, got 1"):
        env.reset(seeds=[1])

    socket.send_json.assert_not_called()
    env.close()


@pytest.mark.parametrize(
    ("actions", "error", "message"),
    [
        ([1.0], TypeError, "must be an integer"),
        ([True], TypeError, "must be an integer"),
        ([np.bool_(False)], TypeError, "must be an integer"),
        ([-1], ValueError, "must be in \\[0, 63\\]"),
        ([64], ValueError, "must be in \\[0, 63\\]"),
        (np.array([[0]]), ValueError, "one-dimensional"),
        (0, TypeError, "must be a sequence"),
    ],
)
def test_step_rejects_non_integer_or_out_of_range_actions(
    monkeypatch, actions, error, message
):
    env, _, socket = _make_mocked_env(monkeypatch)
    socket.send_json.reset_mock()

    with pytest.raises(error, match=message):
        env.step_async(actions)

    socket.send_json.assert_not_called()
    env.close()


def test_step_requires_one_action_per_environment(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=2)
    socket.send_json.reset_mock()

    with pytest.raises(ValueError, match="exactly 2 values, got 1"):
        env.step_async([0])

    socket.send_json.assert_not_called()
    env.close()


def test_vec_env_proxy_methods_do_not_return_dummy_values(monkeypatch):
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=3)
    socket.send_json.reset_mock()

    assert env.render_mode is None
    assert env.get_attr("render_mode") == [None, None, None]
    assert env.get_attr("render_mode", indices=1) == [None]
    assert env.get_attr("render_mode", indices=[0, 2]) == [None, None]
    with pytest.raises(IndexError):
        env.get_attr("render_mode", indices=3)

    with pytest.raises(NotImplementedError, match="remote attribute access.*'score'"):
        env.get_attr("score")
    with pytest.raises(NotImplementedError, match="remote attribute assignment.*'score'"):
        env.set_attr("score", 1)
    with pytest.raises(NotImplementedError, match="remote method calls.*'render'"):
        env.env_method("render")

    socket.send_json.assert_not_called()
    env.close()


def _obs(tick):
    return {
        "playerX": 0.0,
        "playerY": 0.0,
        "playerVelX": 0.0,
        "playerVelY": 0.0,
        "playerAngle": 0.0,
        "playerAngularVel": 0.0,
        "playerIsHeavy": False,
        "opponents": [],
        "tick": tick,
    }


def _step_result(
    tick, terminated, reward, terminal_obs=None, truncated=False, frame_skip=None
):
    info = {
        "tick": tick,
        "terminated": terminated,
        **({"frameSkip": frame_skip} if frame_skip is not None else {}),
        **({"terminal_observation": terminal_obs} if terminal_obs is not None else {}),
    }
    return {
        "observation": _obs(tick),
        "reward": reward,
        "terminated": terminated,
        "truncated": truncated,
        "info": info,
    }


@pytest.mark.parametrize(
    ("responses", "expected_dones", "expected_episodes"),
    [
        (
            # Mid-cycle termination (death on tick 2 of a frame_skip=4 cycle):
            # the backend serves the death step plus the rest of the hold
            # window (2 hold steps) before auto-resetting, so only the death
            # step is an episode boundary. The hold steps carry the raw
            # backend terminal_observation too (applyStepAutoReset attaches it
            # to every done step), which step_wait() must strip from the info.
            [
                {"status": "ok", "data": [_step_result(1, False, 1.0)]},
                {"status": "ok", "data": [_step_result(2, True, 2.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(1, False, 0.5)]},
            ],
            [False, True, False, False, False],
            {1: {"r": 3.0, "l": 2}},
        ),
        (
            # Death on tick 1 of every episode (full frame_skip=4 hold, no
            # intervening non-done step): the fresh episode's own termination
            # on step 5 must surface as a NEW boundary instead of being
            # swallowed as a hold-tail continuation of the previous episode.
            [
                {"status": "ok", "data": [_step_result(1, True, 5.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 7.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
            ],
            [True, False, False, False, True, False, False, False],
            {0: {"r": 5.0, "l": 1}, 4: {"r": 7.0, "l": 1}},
        ),
        (
            # Mid-cycle death followed by a spawn-in-death-circle episode:
            # death at tick 2 (two hold steps), then the fresh episode dies on
            # its very first tick — a DONE step arriving MID-window
            # (_hold_steps < frame_skip) with a changed tick. The tick counter
            # restarts after the auto-reset, so it regresses 2 -> 1; the guard
            # is tick inequality, and that change, not the window elapsing,
            # marks the step as a new boundary.
            [
                {"status": "ok", "data": [_step_result(1, False, 1.0)]},
                {"status": "ok", "data": [_step_result(2, True, 2.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2))]},
                {"status": "ok", "data": [_step_result(1, True, 5.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
                {"status": "ok", "data": [_step_result(1, True, 0.0, terminal_obs=_obs(1))]},
            ],
            [False, True, False, False, True, False, False, False],
            {1: {"r": 3.0, "l": 2}, 4: {"r": 5.0, "l": 1}},
        ),
    ],
)
def test_step_wait_coalesces_terminated_hold_tail(
    monkeypatch, responses, expected_dones, expected_episodes
):
    """#260: an AI-death terminal hold must surface as a single episode
    boundary from ``step_wait()`` — one ``dones`` hit, one ``episode`` record
    with the true accumulated return, no ``TimeLimit.truncated``, and the
    ``terminal_observation`` conversion on the boundary step only."""
    env, _, socket = _make_mocked_env(
        monkeypatch, num_envs=1, config={"frame_skip": 4}
    )
    socket.recv_json.side_effect = responses

    results = []
    try:
        for _ in responses:
            results.append(env.step_wait())
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()

    for index, (_, _, dones, infos) in enumerate(results):
        assert bool(dones[0]) is expected_dones[index]
        info = infos[0]
        # A termination never sets TimeLimit.truncated, and the coalesced
        # _episode flags always agree with the dones array.
        assert "TimeLimit.truncated" not in info
        assert info["_episode"]["terminated"] is expected_dones[index]
        assert info["_episode"]["truncated"] is False
        if index in expected_episodes:
            expected = expected_episodes[index]
            assert info["episode"]["r"] == pytest.approx(expected["r"])
            assert info["episode"]["l"] == expected["l"]
            # The terminal observation conversion runs on the boundary step.
            assert isinstance(info["terminal_observation"], np.ndarray)
        else:
            assert "episode" not in info
            assert "terminal_observation" not in info


def test_step_wait_uses_server_config_frame_skip_for_empty_client_config(monkeypatch):
    """#328: config.json's effective frame_skip must drive coalescing."""
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config={})
    responses = [
        {"status": "ok", "data": [_step_result(1, False, 1.0, frame_skip=4)]},
        {"status": "ok", "data": [_step_result(2, False, 1.0, frame_skip=4)]},
        {"status": "ok", "data": [_step_result(3, False, 1.0, frame_skip=4)]},
        {"status": "ok", "data": [_step_result(4, False, 1.0, frame_skip=4)]},
        {
            "status": "ok",
            "data": [
                _step_result(
                    5,
                    False,
                    2.0,
                    terminal_obs=_obs(5),
                    truncated=True,
                    frame_skip=4,
                )
            ],
        },
        {
            "status": "ok",
            "data": [_step_result(5, False, 0.0, truncated=True, frame_skip=4)],
        },
        {
            "status": "ok",
            "data": [_step_result(5, False, 0.0, truncated=True, frame_skip=4)],
        },
        {
            "status": "ok",
            "data": [_step_result(5, False, 0.0, truncated=True, frame_skip=4)],
        },
        {"status": "ok", "data": [_step_result(1, False, 0.5, frame_skip=4)]},
    ]
    socket.recv_json.side_effect = responses

    results = []
    try:
        for _ in responses:
            results.append(env.step_wait())
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()

    assert [bool(result[2][0]) for result in results] == [
        False,
        False,
        False,
        False,
        True,
        False,
        False,
        False,
        False,
    ]
    boundary_info = results[4][3][0]
    assert boundary_info["frameSkip"] == 4
    assert boundary_info["episode"] == {"r": 6.0, "l": 5}
    assert boundary_info["TimeLimit.truncated"] is True
    assert isinstance(boundary_info["terminal_observation"], np.ndarray)

    for _, _, dones, info_list in results[5:8]:
        assert bool(dones[0]) is False
        assert "episode" not in info_list[0]
        assert "TimeLimit.truncated" not in info_list[0]
        assert "terminal_observation" not in info_list[0]
        assert info_list[0]["_episode"] == {"terminated": False, "truncated": False}


def test_client_frame_skip_config_accepts_integral_float(monkeypatch):
    """#328 follow-up: an integral float client frame_skip config is kept."""
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        env, _, _ = _make_mocked_env(monkeypatch, num_envs=1, config={"frame_skip": 4.0})
    try:
        assert env._frame_skip == 4
    finally:
        env.close()


def test_client_frame_skip_config_absent_or_valid_does_not_warn(monkeypatch):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        env, _, _ = _make_mocked_env(monkeypatch, num_envs=1, config={})
    try:
        assert env._frame_skip == 1
    finally:
        env.close()


@pytest.mark.parametrize("bad_value", [4.5, 0, -1, 1000, True, None, "4"])
def test_client_frame_skip_config_warns_and_falls_back_on_invalid(
    monkeypatch, bad_value
):
    """#328 follow-up: an invalid client frame_skip config is signalled with a
    warning, not silently downgraded to window 1."""
    with pytest.warns(UserWarning, match="ignoring invalid client config frame_skip"):
        env, _, _ = _make_mocked_env(
            monkeypatch, num_envs=1, config={"frame_skip": bad_value}
        )
    try:
        assert env._frame_skip == 1
    finally:
        env.close()


def test_step_wait_accepts_integral_float_frame_skip(monkeypatch):
    """#328 follow-up: an integral float frameSkip (JSON 4.0) must drive
    coalescing exactly like the integer form instead of silently dropping
    the window back to 1."""
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config={})
    responses = [
        {"status": "ok", "data": [_step_result(1, False, 1.0, frame_skip=4.0)]},
        {"status": "ok", "data": [_step_result(2, True, 2.0, terminal_obs=_obs(2), frame_skip=4.0)]},
        {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2), frame_skip=4.0)]},
        {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2), frame_skip=4.0)]},
        {"status": "ok", "data": [_step_result(2, True, 0.0, terminal_obs=_obs(2), frame_skip=4.0)]},
        {"status": "ok", "data": [_step_result(1, False, 0.5, frame_skip=4.0)]},
    ]
    socket.recv_json.side_effect = responses

    results = []
    try:
        for _ in responses:
            results.append(env.step_wait())
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()

    assert int(env._effective_frame_skip[0]) == 4
    assert [bool(result[2][0]) for result in results] == [
        False,
        True,
        False,
        False,
        False,
        False,
    ]
    boundary_info = results[1][3][0]
    assert boundary_info["episode"] == {"r": 3.0, "l": 2}


@pytest.mark.parametrize("bad_value", [4.5, 0, -1, 1000, True])
def test_step_wait_rejects_invalid_frame_skip_keeping_client_window(
    monkeypatch, bad_value
):
    """#328 follow-up: fractional, non-positive, or oversized frameSkip reports
    must not reset the window (to 1 or anything else); the current effective
    window is preserved."""
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config={"frame_skip": 2})
    socket.recv_json.side_effect = [
        {"status": "ok", "data": [_step_result(1, False, 1.0, frame_skip=bad_value)]},
        {"status": "ok", "data": [_step_result(2, False, 1.0, frame_skip=bad_value)]},
    ]
    try:
        env.step_wait()
        env.step_wait()
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()

    assert int(env._effective_frame_skip[0]) == 2


def test_step_wait_valid_frame_skip_refreshes_after_a_rejected_report(monkeypatch):
    """#328 follow-up: a valid frameSkip report still updates the window even
    when an earlier step carried a rejected value."""
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config={})
    socket.recv_json.side_effect = [
        {"status": "ok", "data": [_step_result(1, False, 1.0, frame_skip=4.5)]},
        {"status": "ok", "data": [_step_result(2, False, 1.0, frame_skip=4)]},
    ]
    try:
        env.step_wait()
        assert int(env._effective_frame_skip[0]) == 1
        env.step_wait()
        assert int(env._effective_frame_skip[0]) == 4
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()


def test_reset_clears_server_frame_skip_restoring_client_fallback(monkeypatch):
    """#328 follow-up: reset() clears a server-learned window so a stale value
    from a previous server config cannot persist across episodes."""
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config={"frame_skip": 2})
    socket.recv_json.side_effect = [
        {"status": "ok", "data": [_step_result(1, False, 1.0, frame_skip=4)]},
    ]
    try:
        env.step_wait()
        assert int(env._effective_frame_skip[0]) == 4

        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok", "data": {"observation": [_obs(1)]}}
        socket.send_json.reset_mock()
        env.reset(seeds=[1])
        assert int(env._effective_frame_skip[0]) == 2
    finally:
        socket.recv_json.side_effect = None
        socket.recv_json.return_value = {"status": "ok"}
        env.close()


@pytest.mark.parametrize(
    ("bad_value", "reported"),
    [
        (65, "65"),
        (87, "87"),
        (65.5, "65"),
        (1000, "1000"),
        (10**30, "1000000000000000000000000000000"),
    ],
)
def test_num_opponents_above_max_rejected_before_connecting(
    monkeypatch, bad_value, reported
):
    """#392: the client mirrors the backend's MAX_OPPONENTS bound and rejects
    an unsupportable count before creating any transport, so the error names
    the parameter instead of surfacing the opaque backend init failure."""
    context_factory = MagicMock()
    monkeypatch.setattr(bonk_env.zmq, "Context", context_factory)

    with pytest.raises(
        ValueError,
        match=rf"Invalid num_opponents {reported}: expected at most 64 opponents",
    ):
        bonk_env.BonkVecEnv(num_envs=1, config={"num_opponents": bad_value})

    context_factory.assert_not_called()


def test_num_opponents_within_bound_forwards_verbatim(monkeypatch):
    """#392: counts at or below the bound (including integral floats, which
    the backend floors) pass client-side validation and are forwarded
    verbatim in the init request."""
    for value in (0, 1, 64, 64.9):
        env, _, socket = _make_mocked_env(
            monkeypatch, num_envs=1, config={"num_opponents": value}
        )
        payload = socket.send_json.call_args.args[0]
        assert payload["config"]["num_opponents"] == value
        env.close()


@pytest.mark.parametrize(
    "non_finite",
    [float("inf"), float("-inf"), float("nan")],
)
def test_num_opponents_non_finite_defaults_to_one_like_backend(
    monkeypatch, non_finite
):
    """#398 review: non-finite num_opponents is not a misconfiguration on
    either surface — the backend's normalizeNumOpponents defaults NaN/±inf to
    1, so the client mirrors that by coercing the forwarded config value to 1
    (which also keeps the payload spec-valid JSON; Infinity/NaN are not valid
    JSON) instead of raising or forwarding the raw float."""
    original = {"num_opponents": non_finite}
    env, _, socket = _make_mocked_env(monkeypatch, num_envs=1, config=original)

    payload = socket.send_json.call_args.args[0]
    assert payload["config"]["num_opponents"] == 1

    # The caller's dict is untouched: the coercion happens on a shallow copy.
    assert original["num_opponents"] is non_finite

    env.close()
