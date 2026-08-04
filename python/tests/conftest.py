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


def _taskkill(pid):
    """Force-kill ``pid`` and its whole child tree on Windows."""
    if os.name != "nt":
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
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
        # Parent may be gone already (taskkill failed silently): enumerate
        # surviving descendants from a fresh process snapshot and kill each.
        table = _windows_process_table()
        for pid in _process_tree_pids(table, proc.pid):
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


@pytest.fixture(scope="session")
def bonk_server():
    """Start and stop the TypeScript bonk server for the test session.

    The fixture owns port 5555 for the whole session: any stale server left
    over from a previous run is killed before spawning, and teardown kills
    the entire spawned process tree so no node processes survive pytest.
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

    proc = subprocess.Popen(
        [shutil.which("node"), tsx_cli, "src/main.ts"],
        cwd=project_root,
        # DEVNULL, not PIPE: the server logs verbosely per init/reset and an
        # undrained pipe buffer deadlocks the server after a few test cycles.
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
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
            pytest.skip("bonk server did not start within 10s")

    yield proc

    if proc is not None:
        _kill_process_tree(proc)

    # Belt and suspenders: any listener still on the port belongs to our
    # spawn (stale servers were removed at startup), so remove it too.
    for pid in _listening_pids(port):
        _taskkill(pid)


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
