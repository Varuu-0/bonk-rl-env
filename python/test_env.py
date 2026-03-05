import time
from bonk_env import BonkEnv
from training_logger import TrainingLogger

def main():
    print("Connecting to Bonk RL Environment...")
    env = BonkEnv()
    logger = TrainingLogger()
    
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
        logger.log_step(episodes, i, obs, reward, done)
        
        if done or truncated:
            episodes += 1
            env.reset()
            
    end_time = time.time()
    elapsed = end_time - start_time
    fps = 1000 / elapsed if elapsed > 0 else 0
    
    print(f"\n1000 steps completed in {elapsed:.4f} seconds.")
    print(f"Effective FPS: {fps:.2f} (Includes communication overhead & physics speed)")
    print(f"Total loop time: {elapsed:.4f} seconds")
    print(f"Effective steps per second (FPS): {1000 / elapsed:.2f}")
    
    logger.close()
    
    print("Disconnecting...")
    env.close()
    print("Disconnecting...")

if __name__ == "__main__":
    main()
