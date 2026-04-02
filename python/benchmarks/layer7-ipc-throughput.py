import time
import numpy as np
import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'envs')))
from bonk_env import BonkVecEnv

def run_benchmark(num_envs, steps=100):
    print(f"Benchmarking N={num_envs}...")
    try:
        env = BonkVecEnv(num_envs=num_envs)
        env.reset()
        
        # Warmup step
        actions = np.random.randint(0, 64, size=num_envs)
        env.step_async(actions)
        env.step_wait()
        
        start_time = time.time()
        for _ in range(steps):
            actions = np.random.randint(0, 64, size=num_envs)
            env.step_async(actions)
            env.step_wait()
        end_time = time.time()
        
        elapsed = end_time - start_time
        total_frames = steps * num_envs
        fps = total_frames / elapsed
        
        env.close()
        return {
            "N": num_envs,
            "FPS": round(fps, 2),
            "Time": round(elapsed, 4),
            "FPS/Core (est)": round(fps / max(1, np.min([num_envs, 16])), 2) # Assuming 16 core machine for ref
        }
    except Exception as e:
        print(f"Error at N={num_envs}: {e}")
        return None

def main():
    bench_configs = [1, 2, 4, 8, 16, 32, 64]
    results = []
    
    print("=== Bonk RL Parallel Benchmark (10,000 steps) ===")
    for n in bench_configs:
        res = run_benchmark(n, steps=10000)
        if res:
            results.append(res)
            print(f"  Result: {res['FPS']} FPS")
        time.sleep(1) # Cool down
        
    print("\nBenchmark Results:")
    print(f"{'N':>4} | {'FPS':>10} | {'Time (s)':>10}")
    print("-" * 32)
    for r in results:
        print(f"{r['N']:>4} | {r['FPS']:>10.2f} | {r['Time']:>10.4f}")

if __name__ == "__main__":
    main()
