import json
import pytest
import signal
import subprocess
import time
import os
import sys
import shutil
import socket

import numpy as np


def _listener_pids(netstat_output, port):
    """Parse ``netstat -ano -p tcp`` output for PIDs listening on ``port``."""
    pids = set()
    for line in netstat_output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == "TCP" and parts[3] == "LISTENING":
            local_address, pid = parts[1], parts[4]
            if local_address.endswith(f":{port}") and pid.isdigit():
                pids.add(int(pid))
    return pids


def _listening_pids(port):
    """Return the PIDs currently listening on ``port`` (Windows only)."""
    if os.name != "nt":
        return set()
    try:
        output = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return _listener_pids(output, port)


def _process_tree_pids(process_table, root_pid):
    """Return all live PIDs in the tree rooted at ``root_pid``.

    ``process_table`` maps pid -> parent pid, e.g. parsed from
    ``Win32_Process`` (ProcessId, ParentProcessId). Includes ``root_pid``.
    """
    children = {}
    for pid, parent_pid in process_table.items():
        children.setdefault(parent_pid, []).append(pid)
    tree = set()
    frontier = [root_pid]
    while frontier:
        pid = frontier.pop()
        if pid in tree:
            continue
        tree.add(pid)
        frontier.extend(children.get(pid, ()))
    return tree


def _windows_process_table():
    """Snapshot of {pid: parent_pid} for all live Windows processes."""
    script = (
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,ParentProcessId | ConvertTo-Json"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    if isinstance(rows, dict):
        rows = [rows]
    table = {}
    for row in rows:
        try:
            table[int(row["ProcessId"])] = int(row["ParentProcessId"])
        except (KeyError, TypeError, ValueError):
            continue
    return table


def _process_creation_times(pids):
    """Map pid -> creation time string for the given live Windows PIDs.

    Creation times are matched alongside PIDs so a recycled PID (reused by
    an unrelated process after ours exited) can never be mistaken for our
    own process.
    """
    if os.name != "nt" or not pids:
        return {}
    script = (
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,CreationDate | ConvertTo-Json"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    if isinstance(rows, dict):
        rows = [rows]
    creation_times = {}
    for row in rows:
        try:
            pid = int(row["ProcessId"])
            creation_times[pid] = row["CreationDate"]
        except (KeyError, TypeError, ValueError):
            continue
    return {pid: creation_times[pid] for pid in pids if pid in creation_times}


def _taskkill(pid, tree=True):
    """Force-kill ``pid`` on Windows, optionally its whole child tree."""
    if os.name != "nt":
        return
    args = ["taskkill", "/F"]
    if tree:
        args.append("/T")
    args.extend(["/PID", str(pid)])
    try:
        subprocess.run(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def _kill_process_tree(proc):
    """Terminate ``proc`` and every descendant, not just the parent.

    On Windows the tsx CLI spawns a child node process that actually binds
    the port, so terminating only the parent leaks the child (issue #182).
    taskkill /T kills the whole tree; if the parent is already gone the
    descendant snapshot is used instead. On POSIX the process is spawned in
    its own session and the whole group is killed.
    """
    if proc.poll() is not None:
        return

    if os.name == "nt":
        _taskkill(proc.pid)
        try:
            proc.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            pass
        # Parent is still alive but children survived (taskkill /T missed
        # them). PIDs can be recycled after a process exits, so only resolve
        # the descendant tree while the parent is provably alive.
        if proc.poll() is None:
            for pid in _process_tree_pids(_windows_process_table(), proc.pid):
                _taskkill(pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def _find_tsx_cli(project_root):
    """Find tsx in the workspace or an ancestor dependency directory."""
    candidate_root = os.path.abspath(project_root)
    while True:
        candidate = os.path.join(candidate_root, "node_modules", "tsx", "dist", "cli.mjs")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(candidate_root)
        if parent == candidate_root:
            return None
        candidate_root = parent


MAX_SERVER_START_ATTEMPTS = 5


def _tail_stderr_log(stderr_path, max_lines=40):
    """Return the last ``max_lines`` lines of a captured server stderr log."""
    try:
        with open(stderr_path, "r", encoding="utf-8", errors="replace") as log:
            lines = log.read().splitlines()
    except OSError:
        return "(server stderr log is unavailable)"
    if not lines:
        return "(server stderr log is empty)"
    return "\n".join(lines[-max_lines:])


def _listener_belongs_to(port, proc):
    """True if every PID listening on ``port`` is inside ``proc``'s tree.

    Confirms a successful connect probe reached the server we spawned rather
    than a foreign listener that claimed the ephemeral port after the
    allocation probe was released. POSIX cannot cheaply identify the
    listener, so the check is skipped there (the OS-allocated port is bound
    moments before the child binds it, and any failed spawn retries on a
    fresh port anyway).
    """
    if os.name != "nt":
        return True
    if proc is None or proc.poll() is not None:
        return False
    listening = _listening_pids(port)
    if not listening:
        return False
    return listening <= _process_tree_pids(_windows_process_table(), proc.pid)


@pytest.fixture(scope="session")
def bonk_server(tmp_path_factory):
    """Start and stop the TypeScript bonk server for the test session.

    The fixture owns port 5555 for the whole session: any stale server left
    over from a previous run is killed before spawning, and teardown kills
    the entire spawned process tree so no node processes survive pytest.

    Windows-specific parts: the port is reclaimed with netstat + taskkill
    (tsx spawns a child node process that actually binds the port, so killing
    only the parent would leak it). On POSIX the server runs in its own
    session and teardown kills the whole process group with killpg; stale
    listeners are not reclaimed there, so a leftover server would be reused
    rather than killed.

    The spawned server's stderr is captured to a file (never a pipe, which
    would deadlock the server once the buffer filled) and a failed startup
    is a hard error surfacing that stderr, not a silent skip, so a broken
    server or config can never quietly no-op the Python suite.
    """
    project_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )
    server_script = os.path.join(project_root, "src", "main.ts")
    if not os.path.isfile(server_script):
        pytest.skip("src/main.ts not found")

    if shutil.which("node") is None:
        pytest.skip("node not found")

    # Invoke tsx's Node CLI directly instead of going through npx, which is a
    # .cmd shim on Windows and fails when npx is missing or broken.
    tsx_cli = os.path.join(project_root, "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.isfile(tsx_cli):
        pytest.skip("tsx CLI not found (run npm install)")

    port = 5555

    # A server orphaned by a previous run (or run manually outside pytest)
    # would hijack the port and serve stale state. Clear it before spawning
    # so the tests always talk to a server we control and can tear down.
    # (_listening_pids uses netstat + taskkill, so this reclamation is
    # Windows-only; POSIX spawns in a fresh session instead.)
    for pid in _listening_pids(port):
        _taskkill(pid)
        time.sleep(0.5)

    spawn_kwargs = {}
    if os.name == "nt":
        # Own process group so the whole tree can be force-killed even if
        # tsx spawns a child server process.
        spawn_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        # Own session/process group so the whole tree can be killpg'd.
        spawn_kwargs["start_new_session"] = True

    stderr_path = os.path.join(
        str(tmp_path_factory.mktemp("bonk-server-stderr")), "server-stderr.log"
    )
    stderr_file = open(stderr_path, "w", encoding="utf-8", errors="replace")
    proc = None
    probe_listener_pids = set()
    probe_creation_times = {}
    try:
        proc = subprocess.Popen(
            [shutil.which("node"), tsx_cli, "src/main.ts"],
            cwd=project_root,
            # A file, not PIPE: the server logs verbosely per init/reset and
            # an undrained pipe buffer deadlocks the server after a few test
            # cycles, while a file never blocks and keeps the errors readable.
            stdout=subprocess.DEVNULL,
            stderr=stderr_file,
            **spawn_kwargs,
        )

        connected = False
        for _ in range(100):
            if proc.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    connected = True
                    break
            except (ConnectionRefusedError, OSError):
                time.sleep(0.1)

        if not connected:
            _kill_process_tree(proc)
            if _listening_pids(port):
                # Our server died but another process serves the port (e.g. a
                # manually started server). Use it and leave it alone.
                print(
                    f"WARNING: spawned bonk server exited (code {proc.returncode}) "
                    f"but port {port} is served by another process; tests will use it",
                    file=sys.stderr,
                )
                proc = None
            else:
                raise RuntimeError(
                    "bonk server did not start within 10s on port "
                    f"{port}; server stderr:\n{_tail_stderr_log(stderr_path)}"
                )

        # Record the identity of the process serving the port at probe time:
        # it is our spawn (stale listeners were removed at startup). Teardown
        # reclaims the port only from that exact process, matched by pid AND
        # creation time, so a foreign server or a recycled pid is never touched.
        if proc is not None and os.name == "nt":
            probe_listener_pids = _listening_pids(port)
            probe_creation_times = _process_creation_times(probe_listener_pids)

        yield proc
    finally:
        if proc is not None:
            _kill_process_tree(proc)

            # Belt and suspenders: reclaim the port from our own server process
            # if the tree-kill missed it (e.g. the parent died and the child
            # kept serving). Only the exact process that answered the startup
            # probe is killed, and only while its creation time still matches.
            if probe_creation_times:
                current = _listening_pids(port) & probe_listener_pids
                current_times = _process_creation_times(current)
                for pid in current:
                    probe_time = probe_creation_times.get(pid)
                    if probe_time is not None and current_times.get(pid) == probe_time:
                        _taskkill(pid, tree=False)
        stderr_file.close()


@pytest.fixture
def bonk_server_config(tmp_path):
    """Start a server from a temporary config.json for config-file regressions.

    The server binds an OS-allocated ephemeral port. The allocation probe is
    released before the child binds, so another process could claim the port
    in between; to keep that TOCTOU window from silently routing tests to an
    unconfigured listener, the fixture verifies (on Windows) that the
    listener answering the probe belongs to the spawned process tree and
    retries with a fresh port when it does not. Foreign listeners are never
    killed: the port is simply abandoned and the spawn retried.

    A server that fails to start is a hard error, not a silent skip, and the
    captured stderr tail is surfaced to make the failure actionable.
    """
    project_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )
    server_script = os.path.join(project_root, "src", "main.ts")
    if not os.path.isfile(server_script):
        pytest.skip("src/main.ts not found")

    node = shutil.which("node")
    if node is None:
        pytest.skip("node not found")
    tsx_cli = _find_tsx_cli(project_root)
    if tsx_cli is None:
        pytest.skip("tsx CLI not found (run npm install)")

    spawn_kwargs = {}
    if os.name == "nt":
        spawn_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        spawn_kwargs["start_new_session"] = True

    config_path = os.path.join(tmp_path, "config.json")
    stderr_path = os.path.join(tmp_path, "bonk-server-stderr.log")
    failures = []

    for attempt in range(1, MAX_SERVER_START_ATTEMPTS + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]

        config = {
            "server": {"port": port},
            "environment": {
                "frame_skip": 4,
                "max_ticks": 5,
                "num_opponents": 0,
                "random_opponent": False,
            },
            "workerPool": {"numWorkers": 1, "useSharedMemory": True},
        }
        with open(config_path, "w", encoding="utf-8") as config_file:
            json.dump(config, config_file)
        with open(stderr_path, "w", encoding="utf-8", errors="replace") as stderr_log:
            proc = subprocess.Popen(
                [node, tsx_cli, server_script],
                cwd=tmp_path,
                stdout=subprocess.DEVNULL,
                stderr=stderr_log,
                **spawn_kwargs,
            )

        connected = False
        for _ in range(100):
            if proc.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    connected = True
                    break
            except (ConnectionRefusedError, OSError):
                time.sleep(0.1)

        if connected and _listener_belongs_to(port, proc):
            try:
                yield port
            finally:
                _kill_process_tree(proc)
            return

        _kill_process_tree(proc)
        if connected:
            failures.append(
                f"attempt {attempt}: port {port} is served by a process outside "
                "the spawned bonk server tree; abandoned for a fresh port"
            )
        else:
            failures.append(
                f"attempt {attempt}: bonk server did not start within 10s "
                f"on port {port}"
            )

    raise RuntimeError(
        "config-file bonk server failed to start after "
        f"{MAX_SERVER_START_ATTEMPTS} attempts:\n"
        + "\n".join(failures)
        + "\nserver stderr:\n"
        + _tail_stderr_log(stderr_path)
    )


@pytest.fixture
def bonk_vec_env(bonk_server):
    """Create a BonkVecEnv instance with default config."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from envs.bonk_env import BonkVecEnv

    env = BonkVecEnv(num_envs=2, port=5555)
    yield env
    env.close()


@pytest.fixture
def bonk_vec_env_single(bonk_server):
    """Create a BonkVecEnv instance with a single environment."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from envs.bonk_env import BonkVecEnv

    env = BonkVecEnv(num_envs=1, port=5555)
    yield env
    env.close()


@pytest.fixture
def bonk_vec_env_factory(bonk_server):
    """Factory fixture to create BonkVecEnv with custom num_envs."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from envs.bonk_env import BonkVecEnv

    envs = []

    def _make_env(num_envs=1, port=5555, config=None):
        env = BonkVecEnv(num_envs=num_envs, port=port, config=config)
        envs.append(env)
        return env

    yield _make_env

    for env in envs:
        env.close()


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reward.reward_functions import (
    NavigationReward,
    CompositeReward,
    CuriosityReward,
    CountBasedExplorationReward,
    ConstraintPenaltyReward,
)


@pytest.fixture
def navigation_reward():
    return NavigationReward(
        goal_position=np.array([10.0, 10.0], dtype=np.float32),
        collision_penalty=-1.0,
        time_penalty=-0.01,
        reward_clip=(-1.0, 1.0),
    )


@pytest.fixture
def curiosity_reward():
    return CuriosityReward(
        feature_dim=64,
        eta=0.1,
        reward_scale=1.0,
        reward_clip=(-1.0, 1.0),
    )


@pytest.fixture
def count_based_reward():
    return CountBasedExplorationReward(
        state_bins=20,
        bonus_scale=0.1,
        reward_clip=(0.0, 1.0),
        state_dim=2,
    )


@pytest.fixture
def constraint_penalty_reward():
    def constraint_fn(state, action, next_state, info):
        return info.get("constraint_violated", False)

    return ConstraintPenaltyReward(
        constraint_fn=constraint_fn,
        penalty=-1.0,
        constraint_name="test_constraint",
        reward_clip=(-1.0, 0.0),
    )


def _make_random_state(size=14):
    return np.random.randn(size).astype(np.float32)


def _make_info(**kwargs):
    info = {
        "done": False,
        "collision": False,
        "goal_reached": False,
    }
    info.update(kwargs)
    return info
