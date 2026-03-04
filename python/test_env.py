import time
from bonk_env import BonkEnv

def main():
    print("Connecting to Bonk RL Environment...")
    env = BonkEnv()
    
    print("Resetting environment...")
    obs, info = env.reset()
    print("Initial observation array shape:", obs.shape)
    print("Initial observation:", obs)
    
    print("\nRunning 1000 random steps to test bridge speed...")
    start_time = time.time()
    
    episodes = 0
    total_reward = 0.0
    
    for i in range(1000):
        action = env.action_space.sample()
        obs, reward, done, truncated, info = env.step(action)
        total_reward += reward
        
        if done or truncated:
            episodes += 1
            env.reset()
            
    end_time = time.time()
    elapsed = end_time - start_time
    fps = 1000 / elapsed if elapsed > 0 else 0
    
    print(f"\n1000 steps completed in {elapsed:.4f} seconds.")
    print(f"Effective FPS: {fps:.2f} (Includes communication overhead & physics speed)")
    print(f"Episodes finished: {episodes}")
    print(f"Sum of rewards over 1000 steps: {total_reward:.4f}")
    
    env.close()
    print("Disconnecting...")

if __name__ == "__main__":
    main()
