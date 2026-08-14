import os
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


def test_process_creation_times_filters_pids(monkeypatch):
    class _Result:
        returncode = 0
        stdout = (
            '[{"ProcessId": 10, "ParentProcessId": 5,'
            ' "CreationDate": "20260804120000.123456-300"},'
            ' {"ProcessId": 11, "ParentProcessId": 10,'
            ' "CreationDate": "20260804120001.000000-300"}]'
        )

    monkeypatch.setattr(conftest.os, "name", "nt")
    monkeypatch.setattr(
        conftest.subprocess, "run", lambda *a, **k: _Result()
    )

    assert conftest._process_creation_times({10}) == {
        10: "20260804120000.123456-300"
    }
    assert conftest._process_creation_times({11}) == {
        11: "20260804120001.000000-300"
    }
    # Unknown / missing PIDs are never reported.
    assert conftest._process_creation_times({10, 99}) == {
        10: "20260804120000.123456-300"
    }


def test_tail_stderr_log_reads_last_lines(tmp_path):
    log = tmp_path / "stderr.log"
    log.write_text("\n".join(f"line {i}" for i in range(50)), encoding="utf-8")

    assert conftest._tail_stderr_log(str(log), max_lines=5) == "\n".join(
        f"line {i}" for i in range(45, 50)
    )


def test_tail_stderr_log_missing_file_is_actionable():
    assert "unavailable" in conftest._tail_stderr_log(
        os.path.join("definitely", "missing", "stderr.log")
    )


def test_listener_belongs_to_windows_confirms_own_tree(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: {300, 400})
    monkeypatch.setattr(conftest, "_windows_process_table", lambda: {})
    monkeypatch.setattr(
        conftest, "_process_tree_pids", lambda table, pid: {200, 300, 400}
    )

    assert conftest._listener_belongs_to(5556, _FakeProc())


def test_listener_belongs_to_windows_rejects_foreign_listener(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: {300, 9999})
    monkeypatch.setattr(conftest, "_windows_process_table", lambda: {})
    monkeypatch.setattr(conftest, "_process_tree_pids", lambda table, pid: {200, 300})

    assert not conftest._listener_belongs_to(5556, _FakeProc())


def test_listener_belongs_to_windows_no_listener_or_dead_proc(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "nt")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: set())

    assert not conftest._listener_belongs_to(5556, _FakeProc())

    monkeypatch.setattr(conftest, "_listening_pids", lambda port: {300})
    assert not conftest._listener_belongs_to(5556, _FakeProc(poll_result=0))


def test_posix_listener_pids_parses_ss_output(monkeypatch):
    class _Result:
        returncode = 0
        stdout = (
            "LISTEN 0      4096  127.0.0.1:5556       0.0.0.0:*    "
            'users:(("node",pid=24156,fd=26))\n'
            "LISTEN 0      4096  [::1]:5556            [::]:*       "
            'users:(("node",pid=32832,fd=27))\n'
            "LISTEN 0      4096  127.0.0.1:5557       0.0.0.0:*    "
            'users:(("tsx",pid=9999,fd=28))\n'
        )

    monkeypatch.setattr(conftest.subprocess, "run", lambda *a, **k: _Result())

    assert conftest._posix_listener_pids(5556) == {24156, 32832}


def test_posix_listener_pids_parses_lsof_output(monkeypatch):
    class _Result:
        def __init__(self, returncode, stdout):
            self.returncode = returncode
            self.stdout = stdout

    def fake_run(argv, *args, **kwargs):
        if argv[0] == "ss":
            return _Result(1, "")
        return _Result(0, "24156\n32832\n")

    monkeypatch.setattr(conftest.subprocess, "run", fake_run)

    assert conftest._posix_listener_pids(5556) == {24156, 32832}


def test_posix_listener_pids_empty_when_no_listener(monkeypatch):
    # Tools run successfully but no listener matches the port (ss exits 0
    # with headers only, lsof exits 1 = documented "no match"): a genuine
    # "no listener", not an inability to look.
    def fake_run(argv, *args, **kwargs):
        if argv[0] == "ss":
            return type("R", (), {"returncode": 0, "stdout": "LISTEN 0 4096\n"})()
        return type("R", (), {"returncode": 1, "stdout": ""})()

    monkeypatch.setattr(conftest.subprocess, "run", fake_run)

    assert conftest._posix_listener_pids(5556) == set()


def test_posix_listener_pids_none_when_tools_error(monkeypatch):
    # Both tools launch but fail (non-zero exit, e.g. permission-denied
    # /proc): the check is inconclusive, not "no listener", so a host with a
    # present-but-failing tool must not be misread as a listenerless port.
    def fake_run(argv, *args, **kwargs):
        return type("R", (), {"returncode": 2, "stdout": ""})()

    monkeypatch.setattr(conftest.subprocess, "run", fake_run)

    assert conftest._posix_listener_pids(5556) is None


def test_posix_listener_pids_none_when_tools_missing(monkeypatch):
    # Neither ss nor lsof is installed (OSError when launched): the listener
    # cannot be identified at all, which must be distinguishable from "no
    # listener" so ownership-unverifiable hosts do not hard-fail fixtures.
    def fake_run(argv, *args, **kwargs):
        raise OSError(f"no such tool: {argv[0]}")

    monkeypatch.setattr(conftest.subprocess, "run", fake_run)

    assert conftest._posix_listener_pids(5556) is None


def test_posix_listener_pids_none_when_ss_errors_and_lsof_missing(
    monkeypatch,
):
    # The review scenario: ss is installed but fails non-zero (e.g.
    # permission-denied /proc) and lsof is not installed. Launch alone must
    # not count as a successful check, so the port stays unverifiable (None)
    # instead of being misread as "no listener".
    def fake_run(argv, *args, **kwargs):
        if argv[0] == "ss":
            return type("R", (), {"returncode": 2, "stdout": ""})()
        raise OSError(f"no such tool: {argv[0]}")

    monkeypatch.setattr(conftest.subprocess, "run", fake_run)

    assert conftest._posix_listener_pids(5556) is None


def test_posix_process_table_parses_ps_output(monkeypatch):
    class _Result:
        returncode = 0
        stdout = " 10 5\n 11 10\n 12 0\n"

    monkeypatch.setattr(conftest.subprocess, "run", lambda *a, **k: _Result())

    assert conftest._posix_process_table() == {10: 5, 11: 10, 12: 0}


def test_listener_belongs_to_posix_confirms_own_tree(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "posix")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: {300})
    monkeypatch.setattr(conftest, "_posix_process_table", lambda: {})
    monkeypatch.setattr(
        conftest, "_process_tree_pids", lambda table, pid: {200, 300}
    )

    assert conftest._listener_belongs_to(5556, _FakeProc())


def test_listener_belongs_to_posix_rejects_foreign_listener(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "posix")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: {300, 9999})
    monkeypatch.setattr(conftest, "_posix_process_table", lambda: {})
    monkeypatch.setattr(
        conftest, "_process_tree_pids", lambda table, pid: {200, 300}
    )

    assert not conftest._listener_belongs_to(5556, _FakeProc())


def test_listener_belongs_to_posix_retries_when_listener_unverifiable(monkeypatch):
    monkeypatch.setattr(conftest.os, "name", "posix")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: set())

    assert not conftest._listener_belongs_to(5556, _FakeProc())


def test_listener_belongs_to_posix_accepts_when_tools_unavailable(
    monkeypatch, capsys
):
    # A POSIX host without ss/lsof cannot identify the listener at all; the
    # probe is accepted with a warning instead of hard-failing the fixture.
    monkeypatch.setattr(conftest.os, "name", "posix")
    monkeypatch.setattr(conftest, "_listening_pids", lambda port: None)

    assert conftest._listener_belongs_to(5556, _FakeProc())
    assert "cannot verify" in capsys.readouterr().err
