from collections.abc import Mapping
from numbers import Integral
import warnings

from gymnasium import spaces
import numpy as np
import zmq
from stable_baselines3.common.vec_env import VecEnv


DEFAULT_REQUEST_TIMEOUT_MS = 30_000
DEFAULT_CLOSE_TIMEOUT_MS = 1_000
DEFAULT_LINGER_MS = 1_000
MAX_RESET_SEED = 0xFFFFFFFE
# Sanity cap for the effective frame-skip window. Real configs use values
# far below this (default 1, tests 4); the cap only rejects malformed or
# hostile values so a bogus server report cannot inflate the hold window.
MAX_FRAME_SKIP = 100
# Mirrors WorkerPool.MAX_NUM_ENVS (src/core/worker-pool.ts): the upper bound
# on environments per pool. It keeps a valid request well inside the Node
# side's auth of construction cost and shared-memory sizing (see the constant
# rationale there, issue #390), and lets the client reject a misconfigured
# count before any request is sent instead of waiting out the 30 s timeout.
MAX_NUM_ENVS = 2048


def _frame_skip_window(value):
    """Coerce a ``frameSkip``/``frame_skip`` value to a bounded window.

    Accepts positive integers and integral floats (both IPC transports can
    report a window of 4 as ``4.0``) up to ``MAX_FRAME_SKIP``; returns
    ``None`` for booleans, fractional or non-finite values, and anything
    outside ``[1, MAX_FRAME_SKIP]`` so callers can keep the previous window
    instead of silently falling back to 1 (which would re-introduce #328).
    """
    if isinstance(value, (bool, np.bool_)) or not isinstance(
        value, (Integral, float, np.floating)
    ):
        return None
    try:
        window = int(value)
    except (ValueError, OverflowError):
        return None
    if window != value or not 1 <= window <= MAX_FRAME_SKIP:
        return None
    return window


class BonkVecEnv(VecEnv):
    def __init__(
        self,
        num_envs=1,
        port=5555,
        config=None,
        timeout_ms=DEFAULT_REQUEST_TIMEOUT_MS,
        close_timeout_ms=DEFAULT_CLOSE_TIMEOUT_MS,
        linger_ms=DEFAULT_LINGER_MS,
    ):
        """Initialize the Bonk vectorized environment.
        
        Args:
            num_envs: Number of parallel environments
            port: ZMQ port for communication with Node.js backend
            config: Optional configuration dictionary, can include:
                - frame_skip: Number of ticks to hold each action (default 1)
                - num_opponents: Number of opponents (default 1)
                - max_ticks: Maximum ticks per episode (default 900)
                - random_opponent: Use random opponent policy (default True)
                - seed: Random seed
                - physics: Engine tuning sub-dict (issue #217), e.g.
                  {"gravityY": 5, "ticksPerSecond": 30, "solverIterations": 2,
                   "scale": 30.0, "gravityX": 0.0, "enableSleeping": true,
                   "worldAabbExtent": 1000.0} — every key reaches PhysicsEngine
                - arena: Arena tuning sub-dict, e.g. {"defaultHalfWidth": 25.0,
                  "defaultHalfHeight": 20.0, "boundsMargin": 5.0}
                - player: Player movement tuning sub-dict, e.g.
                  {"moveForce": 30.0, "heavyMassMultiplier": 0.7}
            timeout_ms: Send and receive timeout for normal requests
            close_timeout_ms: Send and receive timeout for session close
            linger_ms: Maximum time for queued messages to linger on close
        """
        for name, value, minimum in (
            ("timeout_ms", timeout_ms, 1),
            ("close_timeout_ms", close_timeout_ms, 1),
            ("linger_ms", linger_ms, 0),
        ):
            if isinstance(value, bool) or not isinstance(value, Integral) or value < minimum:
                raise ValueError(f"{name} must be an integer greater than or equal to {minimum}")

        # Fail before the socket is created (and thus before any init request
        # is sent): the Node side enforces the same [1, MAX_NUM_ENVS] range,
        # but validating here surfaces the error without a server round trip.
        if isinstance(num_envs, bool) or not isinstance(num_envs, Integral):
            raise ValueError(
                f"num_envs must be an integer between 1 and {MAX_NUM_ENVS}, got {num_envs}"
            )
        if not 1 <= num_envs <= MAX_NUM_ENVS:
            raise ValueError(
                f"num_envs must be an integer between 1 and {MAX_NUM_ENVS}, got {num_envs}"
            )
        num_envs = int(num_envs)

        self._timeout_ms = int(timeout_ms)
        self._close_timeout_ms = int(close_timeout_ms)
        self._linger_ms = int(linger_ms)
        self._closed = False
        self._closed_reason = None

        # Action space: 6 binary inputs (left, right, up, down, heavy, grapple)
        action_space = spaces.Discrete(64)
        
        # Observation space: 14-dimensional
        # [playerX, playerY, playerVelX, playerVelY, playerAngle, playerAngularVel, playerIsHeavy,
        #  opponentX, opponentY, opponentVelX, opponentVelY, opponentIsHeavy, opponentAlive, tick]
        observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(14,), dtype=np.float32
        )
        
        super().__init__(num_envs, observation_space, action_space)
        
        self.context = None
        self.socket = None
        try:
            self.context = zmq.Context()
            self.socket = self.context.socket(zmq.DEALER)
            self.socket.setsockopt(zmq.LINGER, self._linger_ms)
            self.socket.setsockopt(zmq.SNDTIMEO, self._timeout_ms)
            self.socket.setsockopt(zmq.RCVTIMEO, self._timeout_ms)
            self.socket.connect(f"tcp://127.0.0.1:{port}")

            self._send_json({
                "command": "init",
                "numEnvs": num_envs,
                "config": config or {},
                "useSharedMemory": True,
            })
            message = self._recv_json("init")

            if message.get("status") != "ok":
                raise RuntimeError(f"Error initializing environments: {message.get('error')}")
        except Exception:
            self._closed = True
            self._closed_reason = "initialization failure"
            try:
                self._close_transport()
            except Exception:
                pass
            raise

        self._episode_returns = np.zeros(num_envs, dtype=np.float64)
        self._episode_lengths = np.zeros(num_envs, dtype=np.int64)
        # Per-env state for coalescing the frame-skip terminal hold (#260):
        # with frame_skip > 1 the backend serves `done` for the whole hold
        # window of an ended episode (the worker defers the auto-reset to the
        # frame-skip cycle boundary, #228). `_hold_steps` counts the
        # consecutive done steps served for the current episode end (0 when
        # the last step was not done) and `_hold_tick` records the
        # observation tick of the boundary step; a done step is a hold-tail
        # continuation only while the count is still inside the hold window
        # and the observation is unchanged from the boundary.
        self._hold_steps = np.zeros(num_envs, dtype=np.int64)
        self._hold_tick = np.zeros(num_envs, dtype=np.int64)
        # Keep the client setting as a fallback for older servers, but prefer
        # the effective per-environment value reported by the backend. The
        # server may get frame_skip from config.json rather than this client.
        configured_frame_skip = (config or {}).get("frame_skip", 1)
        self._frame_skip = _frame_skip_window(configured_frame_skip)
        if self._frame_skip is None:
            # A provided-but-invalid value (numeric string, None, zero,
            # negative, fractional, or past the cap) is a misconfiguration,
            # not an absence: warn instead of silently running window 1.
            warnings.warn(
                f"ignoring invalid client config frame_skip {configured_frame_skip!r}: "
                f"expected an integer or integral float in [1, {MAX_FRAME_SKIP}]; "
                "using the default window of 1",
                UserWarning,
                stacklevel=2,
            )
            self._frame_skip = 1
        self._effective_frame_skip = np.full(
            num_envs, self._frame_skip, dtype=np.int64
        )

    def _send_json(self, message, timeout_ms=None):
        command = message["command"]
        timeout_ms = self._timeout_ms if timeout_ms is None else timeout_ms
        try:
            self.socket.send_json(message)
        except zmq.Again as exc:
            raise TimeoutError(
                f"Timed out after {timeout_ms} ms sending '{command}' request to Bonk backend"
            ) from exc

    def _recv_json(self, command, timeout_ms=None):
        timeout_ms = self._timeout_ms if timeout_ms is None else timeout_ms
        try:
            return self.socket.recv_json()
        except zmq.Again as exc:
            self._closed = True
            self._closed_reason = f"a receive timeout while waiting for '{command}'"
            try:
                self._close_transport()
            except Exception:
                pass
            raise TimeoutError(
                f"Timed out after {timeout_ms} ms waiting for '{command}' response from Bonk backend"
            ) from exc

    def _close_transport(self):
        socket, context = self.socket, self.context
        self.socket = None
        self.context = None
        try:
            if socket is not None:
                socket.close(linger=self._linger_ms)
        finally:
            if context is not None:
                context.term()

    def _ensure_open(self):
        if self._closed:
            reason = self._closed_reason or "close"
            raise RuntimeError(f"cannot use BonkVecEnv after {reason}")

    def _convert_obs(self, data):
        """Convert JSON observation data to numpy array.
        
        Args:
            data: Dictionary with observation fields from backend
            
        Returns:
            numpy array of shape (14,) with observation values
        """
        obs = np.zeros(14, dtype=np.float32)
        obs[0] = data["playerX"]
        obs[1] = data["playerY"]
        obs[2] = data["playerVelX"]
        obs[3] = data["playerVelY"]
        obs[4] = data["playerAngle"]
        obs[5] = data["playerAngularVel"]
        obs[6] = 1.0 if data["playerIsHeavy"] else 0.0
        
        if len(data["opponents"]) > 0:
            op = data["opponents"][0]
            obs[7] = op["x"]
            obs[8] = op["y"]
            obs[9] = op["velX"]
            obs[10] = op["velY"]
            obs[11] = 1.0 if op["isHeavy"] else 0.0
            obs[12] = 1.0 if op["alive"] else 0.0
            
        obs[13] = data["tick"]
        return obs
        
    def reset(self, seeds=None, options=None):
        """Reset all environments.

        Implements the stable-baselines3 ``VecEnv`` contract: returns the
        observation array directly (not the Gymnasium ``(obs, info)`` tuple),
        so ``PPO.learn()`` and friends can consume the result unchanged.

        Args:
            seeds: Optional list of seeds for each environment
            options: Optional reset options

        Returns:
            numpy array of shape (num_envs, 14) with initial observations
        """
        self._ensure_open()

        # Generate random seeds for deterministic rollouts in each env
        if seeds is None:
            seeds = np.random.randint(0, 1000000, size=self.num_envs).tolist()
        elif isinstance(seeds, np.ndarray):
            if seeds.ndim != 1:
                raise ValueError("seeds must be a one-dimensional sequence")
            seeds = seeds.tolist()
        elif isinstance(seeds, (str, bytes)) or isinstance(seeds, Mapping):
            raise TypeError("seeds must be a sequence of integers")
        else:
            try:
                seeds = list(seeds)
            except TypeError as exc:
                raise TypeError("seeds must be a sequence of integers") from exc

        if len(seeds) != self.num_envs:
            raise ValueError(
                f"seeds must contain exactly {self.num_envs} values, got {len(seeds)}"
            )

        validated_seeds = []
        for index, seed in enumerate(seeds):
            if isinstance(seed, (bool, np.bool_)) or not isinstance(seed, Integral):
                raise TypeError(f"seed at index {index} must be an integer, got {seed!r}")
            seed = int(seed)
            if not 0 <= seed <= MAX_RESET_SEED:
                raise ValueError(
                    f"seed at index {index} must be in [0, {MAX_RESET_SEED}], got {seed}"
                )
            validated_seeds.append(seed)

        self._send_json(
            {"command": "reset", "seeds": validated_seeds, "options": options or {}}
        )
        message = self._recv_json("reset")
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error resetting environment: {message.get('error')}")
            
        self._episode_returns[:] = 0.0
        self._episode_lengths[:] = 0
        self._hold_steps[:] = 0
        self._hold_tick[:] = 0
        # Restore the client-config fallback: a window learned from a
        # previous server's step results must not survive across episodes,
        # because the server config can change between episodes and the next
        # step refreshes the window from the live frameSkip report anyway.
        self._effective_frame_skip[:] = self._frame_skip

        obs_data = message["data"]["observation"]
        obs_array = np.array([self._convert_obs(o) for o in obs_data])
        
        return obs_array
    
    def step_async(self, actions):
        """Send actions to environments asynchronously.
        
        Args:
            actions: List or array of actions for each environment
        """
        self._ensure_open()

        if isinstance(actions, np.ndarray):
            if actions.ndim != 1:
                raise ValueError("actions must be a one-dimensional sequence")
            actions = actions.tolist()
        else:
            try:
                actions = list(actions)
            except TypeError as exc:
                raise TypeError("actions must be a sequence of integers") from exc

        if len(actions) != self.num_envs:
            raise ValueError(
                f"actions must contain exactly {self.num_envs} values, got {len(actions)}"
            )

        validated_actions = []
        for index, action in enumerate(actions):
            if isinstance(action, (bool, np.bool_)) or not isinstance(action, Integral):
                raise TypeError(f"action at index {index} must be an integer, got {action!r}")
            action = int(action)
            if not 0 <= action < self.action_space.n:
                raise ValueError(
                    f"action at index {index} must be in [0, {self.action_space.n - 1}], got {action}"
                )
            validated_actions.append(action)

        self._send_json({"command": "step", "actions": validated_actions})

    def step_wait(self):
        """Wait for step results and return observations.

        Implements the stable-baselines3 ``VecEnv`` contract: ``step()``
        forwards here, so this returns the SB3 4-tuple (not the Gymnasium
        5-tuple). Termination and truncation are folded into a single
        ``dones`` boolean array; episodes that ended by truncation are marked
        with ``info["TimeLimit.truncated"] = True`` so SB3 can bootstrap the
        value of the terminal observation.

        Returns:
            tuple: (obs, rewards, dones, infos)
                - obs: observations for each environment
                - rewards: rewards for each environment
                - dones: boolean array, True for terminated OR truncated episodes
                - infos: list of info dictionaries for each environment
        """
        self._ensure_open()

        message = self._recv_json("step")
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error stepping environment: {message.get('error')}")
            
        data = message["data"]
        
        obs_list = []
        rewards = []
        terminated = []
        truncated = []
        infos = []
        
        for idx, d in enumerate(data):
            obs_list.append(self._convert_obs(d["observation"]))
            rewards.append(float(d["reward"]))

            # `frameSkip` is static per environment but is already carried by
            # every step result in both transports. Refresh the hold window
            # before classifying this step so a server-only config.json value
            # takes effect on the boundary step itself (#328). Integral floats
            # are accepted and out-of-range/fractional values are rejected so
            # a bogus report can never silently drop the window back to 1.
            info = d.get("info")
            if not isinstance(info, dict):
                info = {}
            window = _frame_skip_window(info.get("frameSkip"))
            if window is not None:
                self._effective_frame_skip[idx] = window
            frame_skip = int(self._effective_frame_skip[idx])
            
            # Parse done status - support multiple formats:
            # Format 1 (new): {"terminated": bool, "truncated": bool}
            # Format 2 (legacy): {"done": bool}
            # Format 3: {"done": bool, "max_ticks": int, "tick": int}
            
            if "terminated" in d and "truncated" in d:
                # New format with explicit terminated/truncated
                is_terminated = bool(d["terminated"])
                is_truncated = bool(d["truncated"])
            elif "terminated" in d:
                # Only terminated provided
                is_terminated = bool(d["terminated"])
                is_truncated = False
            elif "truncated" in d:
                # Only truncated provided
                is_terminated = False
                is_truncated = bool(d["truncated"])
            else:
                # Legacy format: only 'done' provided
                # Determine terminated vs truncated based on tick count
                is_done = bool(d.get("done", False))
                tick = d.get("observation", {}).get("tick", 0)
                max_ticks = d.get("max_ticks", 900)
                
                # If done and at max ticks, it is truncated (not terminated)
                is_terminated = is_done and tick < max_ticks
                is_truncated = is_done and tick >= max_ticks
            
            is_done = is_terminated or is_truncated
            # With frame_skip > 1 the backend serves `done` for the whole
            # terminal hold window after an episode ends (the worker defers
            # the auto-reset to the frame-skip cycle boundary, #228). A done
            # step is a hold-tail continuation of the same episode end only
            # while that window is being served: the env already reported done
            # on the previous step, the window (frame_skip done steps) has not
            # elapsed, and the observation is unchanged (same tick) from the
            # boundary step. A fresh episode that terminates on its very first
            # step (e.g. spawn inside the OOB death circle) either advances
            # the tick or falls past the window, so it surfaces as a new
            # boundary instead of being swallowed as a hold-tail (#260).
            obs_tick = d.get("observation", {}).get("tick", 0)
            is_hold_tail = (
                is_done
                and self._hold_steps[idx] > 0
                and self._hold_steps[idx] < frame_skip
                and obs_tick == self._hold_tick[idx]
            )
            if is_done:
                # A new boundary restarts the window count; a hold-tail step
                # keeps advancing it until the window elapses.
                self._hold_steps[idx] = self._hold_steps[idx] + 1 if is_hold_tail else 1
                if not is_hold_tail:
                    self._hold_tick[idx] = obs_tick
            else:
                self._hold_steps[idx] = 0

            terminated.append(is_terminated and not is_hold_tail)
            truncated.append(is_truncated and not is_hold_tail)
            
            if not is_hold_tail:
                # Handle terminal observation for done episodes only (SB3 uses
                # it to bootstrap value estimates on truncation, see GH issue
                # #633)
                if is_done and "terminal_observation" in info:
                    info["terminal_observation"] = self._convert_obs(info["terminal_observation"])

                # SB3 convention: truncation (not termination) is signalled
                # inside the info dict so done() can be treated uniformly.
                if is_truncated and not is_terminated:
                    info["TimeLimit.truncated"] = True

                self._episode_returns[idx] += float(d["reward"])
                self._episode_lengths[idx] += 1

                if is_done:
                    info["episode"] = {
                        "r": float(self._episode_returns[idx]),
                        "l": int(self._episode_lengths[idx]),
                    }
                    self._episode_returns[idx] = 0.0
                    self._episode_lengths[idx] = 0
            else:
                # Hold-tail steps carry no terminal markers: they are ordinary
                # non-boundary steps in the SB3 contract.
                info.pop("terminal_observation", None)
            
            # Add individual episode info for debugging; the flags are
            # coalesced like `dones`, so hold-tail steps report the episode as
            # not ended (a consumer counting boundaries via `_episode` sees the
            # same single boundary as the `dones` array).
            info["_episode"] = {
                "terminated": is_terminated and not is_hold_tail,
                "truncated": is_truncated and not is_hold_tail,
            }
            
            infos.append(info)
        
        dones = np.logical_or(
            np.array(terminated, dtype=bool),
            np.array(truncated, dtype=bool),
        )

        return (
            np.array(obs_list),
            np.array(rewards),
            dones,
            infos
        )

    def close(self):
        """Close this client session and cleanup its transport resources."""
        if self._closed:
            return

        self._closed = True
        self._closed_reason = "close"
        try:
            self.socket.setsockopt(zmq.SNDTIMEO, self._close_timeout_ms)
            self.socket.setsockopt(zmq.RCVTIMEO, self._close_timeout_ms)
            self._send_json({"command": "close"}, timeout_ms=self._close_timeout_ms)
            message = self._recv_json("close", timeout_ms=self._close_timeout_ms)
            if message.get("status") != "ok":
                raise RuntimeError(f"Error closing environments: {message.get('error')}")
        finally:
            self._close_transport()

    def get_attr(self, attr_name, indices=None):
        """Get attribute from environments."""
        if attr_name == "render_mode":
            render_modes = [None] * self.num_envs
            return [render_modes[index] for index in self._get_indices(indices)]
        raise NotImplementedError(
            f"BonkVecEnv does not support remote attribute access for {attr_name!r}"
        )

    def set_attr(self, attr_name, value, indices=None):
        """Set attribute in environments."""
        raise NotImplementedError(
            f"BonkVecEnv does not support remote attribute assignment for {attr_name!r}"
        )

    def env_method(self, method_name, *method_args, indices=None, **method_kwargs):
        """Call method on environments."""
        raise NotImplementedError(
            f"BonkVecEnv does not support remote method calls for {method_name!r}"
        )

    def seed(self, seed=None):
        """Set seeds for environments."""
        # Seeds are handled in reset
        return [None] * self.num_envs

    def env_is_wrapped(self, wrapper_class, indices=None):
        """Check if environment is wrapped."""
        return [False] * self.num_envs
