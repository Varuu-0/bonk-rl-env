import signal
import subprocess

import pytest

import conftest


class _FakeProc:
    def __init__(self, poll_result=None, wait_error=None):
        self._poll_result = poll_result
        self._wait_error = wait_error
        self.pid = 1234

    def poll(self):
        return self._poll_result

    def wait(self, timeout=None):
        if self._wait_error is not None:
            raise self._wait_error
        return 0


class _RecordingSubprocess:
    """Stand-in for subprocess.run that records argv and returns success."""

    def __init__(self):
        self.calls = []

    def run(self, argv, *args, **kwargs):
        self.calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0)


def test_listener_pids_parses_netstat_output():
    output = (
        "  TCP    127.0.0.1:5555         0.0.0.0:0              LISTENING       24156\n"
        "  TCP    [::1]:5555             [::]:0                 LISTENING       32832\n"
        "  TCP    127.0.0.1:5556         0.0.0.0:0              LISTENING       9999\n"
        "  TCP    127.0.0.1:49363        127.0.0.1:5555         TIME_WAIT       0\n"
        "  TCP    127.0.0.1:5555         0.0.0.0:0              ESTABLISHED     7777\n"
    )
    assert conftest._listener_pids(output, 5555) == {24156, 32832}


def test_process_tree_pids_collects_descendants():
    table = {
        100: 1,    # root child
        200: 100,  # grandchild
        300: 100,  # grandchild
        400: 200,  # great-grandchild
        500: 0,    # unrelated process
    }
    assert conftest._process_tree_pids(table, 100) == {100, 200, 300, 400}
    assert conftest._process_tree_pids(table, 1) == {1, 100, 200, 300, 400}
    assert conftest._process_tree_pids(table, 500) == {500}


def test_process_tree_pids_handles_cycles():
    table = {1: 2, 2: 1, 3: 2}
    assert conftest._process_tree_pids(table, 1) == {1, 2, 3}


def test_kill_process_tree_windows_uses_taskkill_tree(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)

    conftest._kill_process_tree(_FakeProc())

    # /T is what kills the tsx child node that actually holds the port.
    assert recorder.calls == [["taskkill", "/F", "/T", "/PID", "1234"]]


def test_kill_process_tree_windows_falls_back_to_descendants(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)
    monkeypatch.setattr(
        conftest,
        "_windows_process_table",
        lambda: {1000: 0, 1234: 1000, 5678: 1234, 9999: 1234},
    )

    conftest._kill_process_tree(
        _FakeProc(wait_error=subprocess.TimeoutExpired("fake", 5))
    )

    assert ["taskkill", "/F", "/T", "/PID", "1234"] in recorder.calls
    assert ["taskkill", "/F", "/T", "/PID", "5678"] in recorder.calls
    assert ["taskkill", "/F", "/T", "/PID", "9999"] in recorder.calls
    assert ["taskkill", "/F", "/T", "/PID", "1000"] not in recorder.calls


def test_kill_process_tree_windows_skips_descendants_once_parent_exited(
    monkeypatch,
):
    monkeypatch.setattr(conftest.os, "name", "nt")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)
    monkeypatch.setattr(
        conftest,
        "_windows_process_table",
        lambda: {1000: 0, 1234: 1000, 5678: 1234},
    )

    # First wait times out, but the parent has exited by then: enumerating
    # descendants would risk killing recycled PIDs, so only the direct
    # taskkill /T attempt may run.
    proc = _FakeProc(wait_error=subprocess.TimeoutExpired("fake", 5))
    calls = {"poll": 0}

    def flaky_poll():
        calls["poll"] += 1
        # Entry check reports alive; the post-timeout check reports dead.
        return None if calls["poll"] == 1 else 42

    proc.poll = flaky_poll
    conftest._kill_process_tree(proc)

    assert recorder.calls == [["taskkill", "/F", "/T", "/PID", "1234"]]
    assert calls["poll"] == 2


def test_kill_process_tree_posix_uses_killpg(monkeypatch):
    killed = []
    monkeypatch.setattr(conftest.os, "name", "posix")
    monkeypatch.setattr(
        conftest.os,
        "killpg",
        lambda pgid, sig: killed.append(sig),
        raising=False,
    )

    conftest._kill_process_tree(_FakeProc())

    assert killed == [signal.SIGTERM]


def test_kill_process_tree_noop_when_already_exited(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)

    conftest._kill_process_tree(_FakeProc(poll_result=0))

    assert recorder.calls == []


def test_taskkill_is_noop_off_windows(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "posix")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)

    conftest._taskkill(42)

    assert recorder.calls == []


def test_taskkill_leaf_kill_omits_tree_flag(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    recorder = _RecordingSubprocess()
    monkeypatch.setattr(conftest.subprocess, "run", recorder.run)

    conftest._taskkill(42, tree=False)

    assert recorder.calls == [["taskkill", "/F", "/PID", "42"]]


def test_windows_process_table_parses_cim_json(monkeypatch):
    class _Result:
        returncode = 0
        stdout = '[{"ProcessId": 10, "ParentProcessId": 5}, {"ProcessId": 11, "ParentProcessId": 10}]'

    monkeypatch.setattr(conftest.os, "name", "nt")
    monkeypatch.setattr(
        conftest.subprocess, "run", lambda *a, **k: _Result()
    )

    assert conftest._windows_process_table() == {10: 5, 11: 10}
