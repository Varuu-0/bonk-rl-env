import pytest
import subprocess
import time
import os
import sys
import shutil
import socket

import numpy as np


@pytest.fixture(scope="session")
def bonk_server():
    """Start and stop the TypeScript bonk server for the test session."""
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

    proc = subprocess.Popen(
        [shutil.which("node"), tsx_cli, "src/main.ts"],
        cwd=project_root,
        # DEVNULL, not PIPE: the server logs verbosely per init/reset and an
        # undrained pipe buffer deadlocks the server after a few test cycles.
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    port = 5555
    connected = False
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                connected = True
                break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)

    if not connected:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        pytest.skip("bonk server did not start within 10s")

    yield proc

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


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
