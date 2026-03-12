import time
import numpy as np
import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'envs')))
from bonk_env import BonkVecEnv

def main():
    num_envs = 64
    print(f"Connecting to Bonk RL Massively Parallel Environment (N={num_envs})...")
    
    # Needs to be matched with the already running Node.js server
    env = BonkVecEnv(num_envs=num_envs)
    
    print(f"Resetting {num_envs} environments...")
    obs = env.reset()
    print("Initial observation array shape:", obs.shape)
    
    print("\nRunning 100 random steps to test batch throughput...")
    
    # Initialize random actions for 64 envs using the Discrete(64) space
    actions = np.random.randint(0, 64, size=num_envs)
    
    start_time = time.time()
    
    total_steps = 100
    total_rewards = np.zeros(num_envs)
    episodes_completed = 0
    
    for i in range(total_steps):
        # We can just use random integers for actions
        actions = np.random.randint(0, 64, size=num_envs)
        obs, rewards, terminated, truncated, infos = env.step_wait() if i > 0 else (obs, np.zeros(num_envs), np.zeros(num_envs, dtype=bool), np.zeros(num_envs, dtype=bool), [])
        if i == 0:
            env.step_async(actions)
            continue
            
        total_rewards += rewards
        episodes_completed += np.sum(terminated)
        
        env.step_async(actions)
            
    # Final step wait
    obs, rewards, terminated, truncated, infos = env.step_wait()
    total_rewards += rewards
    episodes_completed += np.sum(terminated)

    end_time = time.time()
    elapsed = end_time - start_time
    
    total_physics_steps = (total_steps) * num_envs
    fps = total_physics_steps / elapsed if elapsed > 0 else 0
    
    print(f"\n{total_steps} batched steps completed in {elapsed:.4f} seconds.")
    print(f"Total physics steps (ticks): {total_physics_steps}")
    print(f"Effective Massively Parallel FPS: {fps:.2f} (Includes ZMQ router/dealer + Node cluster)")
    print(f"Total episodes completed: {episodes_completed}")
    
    print("Disconnecting...")
    env.close()

if __name__ == "__main__":
    main()
