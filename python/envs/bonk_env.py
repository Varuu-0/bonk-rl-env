import gymnasium as gym
from gymnasium import spaces
import numpy as np
import zmq
import json
from stable_baselines3.common.vec_env import VecEnv

class BonkVecEnv(VecEnv):
    def __init__(self, num_envs=1, port=5555, config=None):
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
        """
        # Action space: 6 binary inputs (left, right, up, down, heavy, grapple)
        action_space = spaces.Discrete(64)
        
        # Observation space: 14-dimensional
        # [playerX, playerY, playerVelX, playerVelY, playerAngle, playerAngularVel, playerIsHeavy,
        #  opponentX, opponentY, opponentVelX, opponentVelY, opponentIsHeavy, opponentAlive, tick]
        observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(14,), dtype=np.float32
        )
        
        super().__init__(num_envs, observation_space, action_space)
        
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.DEALER)
        self.socket.connect(f"tcp://127.0.0.1:{port}")
        
        # Wait a short moment for connection before sending init
        import time
        time.sleep(0.1)
        
        self.socket.send_json({
            "command": "init", 
            "numEnvs": num_envs, 
            "config": config or {},
            "useSharedMemory": True
        })
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error initializing environments: {message.get('error')}")

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
        
        Args:
            seeds: Optional list of seeds for each environment
            options: Optional reset options
            
        Returns:
            Initial observations for all environments
        """
        # Generate random seeds for deterministic rollouts in each env
        if seeds is None:
            seeds = np.random.randint(0, 1000000, size=self.num_envs).tolist()
        
        self.socket.send_json({"command": "reset", "seeds": seeds, "options": options or {}})
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error resetting environment: {message.get('error')}")
            
        obs_data = message["data"]["observation"]
        obs_array = np.array([self._convert_obs(o) for o in obs_data])
        
        # Return in Gymnasium format: (obs, info)
        return obs_array, {}
    
    def step_async(self, actions):
        """Send actions to environments asynchronously.
        
        Args:
            actions: List or array of actions for each environment
        """
        if isinstance(actions, np.ndarray):
            actions = actions.tolist()
            
        self.socket.send_json({"command": "step", "actions": actions})

    def step_wait(self):
        """Wait for step results and return observations.
        
        Returns:
            tuple: (obs, rewards, terminated, truncated, infos)
                - obs: observations for each environment
                - rewards: rewards for each environment  
                - terminated: boolean array for terminated episodes (natural end)
                - truncated: boolean array for truncated episodes (max steps)
                - infos: list of info dictionaries for each environment
        """
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error stepping environment: {message.get('error')}")
            
        data = message["data"]
        
        obs_list = []
        rewards = []
        terminated = []
        truncated = []
        infos = []
        
        for d in data:
            obs_list.append(self._convert_obs(d["observation"]))
            rewards.append(float(d["reward"]))
            
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
                max_ticks = d.get("max_ticks", 1000)
                
                # If done and at max ticks, it is truncated (not terminated)
                is_terminated = is_done and tick < max_ticks
                is_truncated = is_done and tick >= max_ticks
            
            terminated.append(is_terminated)
            truncated.append(is_truncated)
            
            # Build info dict
            info = d.get("info", {})
            
            # Handle terminal observation for terminated episodes only
            if is_terminated and "terminal_observation" in info:
                info["terminal_observation"] = self._convert_obs(info["terminal_observation"])
            
            # Add individual episode info for debugging
            info["_episode"] = {
                "terminated": is_terminated,
                "truncated": is_truncated,
            }
            
            infos.append(info)
        
        return (
            np.array(obs_list), 
            np.array(rewards), 
            np.array(terminated), 
            np.array(truncated),
            infos
        )

    def close(self):
        """Close the environment and cleanup resources."""
        self.socket.close()
        self.context.term()

    def get_attr(self, attr_name, indices=None):
        """Get attribute from environments."""
        return [None] * self.num_envs

    def set_attr(self, attr_name, value, indices=None):
        """Set attribute in environments."""
        pass

    def env_method(self, method_name, *method_args, indices=None, **met
