from collections import UserDict
from collections.abc import Mapping
from unittest.mock import MagicMock

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
