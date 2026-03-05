import gymnasium as gym
from gymnasium import spaces
import numpy as np
import zmq
import json
from stable_baselines3.common.vec_env import VecEnv

class BonkVecEnv(VecEnv):
    def __init__(self, num_envs=1, port=5555, config=None):
        # Action space: 6 binary inputs (left, right, up, down, heavy, grapple)
        action_space = spaces.Discrete(64)
        
        # Observation space
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
            "config": config or {}
        })
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error initializing environments: {message.get('error')}")

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
        
    def reset(self):
        # Generate random seeds for deterministic rollouts in each env
        seeds = np.random.randint(0, 1000000, size=self.num_envs).tolist()
        
        self.socket.send_json({"command": "reset", "seeds": seeds})
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error resetting environment: {message.get('error')}")
            
        obs_data = message["data"]["observation"]
        obs_array = np.array([self._convert_obs(o) for o in obs_data])
        
        return obs_array

    def step_async(self, actions):
        if isinstance(actions, np.ndarray):
            actions = actions.tolist()
            
        self.socket.send_json({"command": "step", "actions": actions})

    def step_wait(self):
        message = self.socket.recv_json()
        
        if message.get("status") != "ok":
            raise RuntimeError(f"Error stepping environment: {message.get('error')}")
            
        data = message["data"]
        
        obs_list = []
        rewards = []
        dones = []
        infos = []
        
        for d in data:
            obs_list.append(self._convert_obs(d["observation"]))
            rewards.append(float(d["reward"]))
            dones.append(bool(d["done"]))
            
            info = d["info"]
            if "terminal_observation" in info:
                info["terminal_observation"] = self._convert_obs(info["terminal_observation"])
            infos.append(info)
            
        return np.array(obs_list), np.array(rewards), np.array(dones), infos

    def close(self):
        self.socket.close()
        self.context.term()

    def get_attr(self, attr_name, indices=None):
        return [None] * self.num_envs

    def set_attr(self, attr_name, value, indices=None):
        pass

    def env_method(self, method_name, *method_args, indices=None, **method_kwargs):
        return [None] * self.num_envs

    def seed(self, seed=None):
        # Seeds are handled in reset
        return [None] * self.num_envs

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * self.num_envs
