import gymnasium as gym
from gymnasium import spaces
import numpy as np
import zmq
import json

class BonkEnv(gym.Env):
    metadata = {"render_modes": ["human"]}

    def __init__(self, port=5555):
        super().__init__()
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.connect(f"tcp://127.0.0.1:{port}")
        
        # Action space: 5 binary inputs (left, right, up, down, heavy)
        # We represent this as a Discrete(32) space.
        self.action_space = spaces.Discrete(32)
        
        # Observation space
        # We flatten the observation to a 1D vector of float32s.
        # [playerX, playerY, playerVelX, playerVelY, playerAngle, playerAngularVel, playerIsHeavy, opX, opY, opVx, opVy, opHeavy, opAlive, tick]
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(14,), dtype=np.float32
        )

    def _convert_obs(self, data):
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
        
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        
        self.socket.send_json({"command": "reset"})
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error resetting environment: {message.get('error')}")
            
        obs = self._convert_obs(message["data"]["observation"])
        info = {}
        return obs, info

    def step(self, action):
        action = int(action)
        self.socket.send_json({"command": "step", "action": action})
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error stepping environment: {message.get('error')}")
            
        data = message["data"]
        
        obs = self._convert_obs(data["observation"])
        reward = float(data["reward"])
        done = bool(data["done"])
        truncated = bool(data["truncated"])
        info = data["info"]
        
        return obs, reward, done, truncated, info

    def close(self):
        self.socket.close()
        self.context.term()
