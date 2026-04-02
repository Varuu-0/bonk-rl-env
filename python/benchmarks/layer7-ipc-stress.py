import time
import numpy as np
import os
import sys
import argparse

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'envs')))
from bonk_env import BonkVecEnv


def run_throughput_benchmark(num_envs, max_steps=500000):
    print(f"Benchmarking N={num_envs} with max_steps={max_steps}...")
    env = None
    try:
        env = BonkVecEnv(num_envs=num_envs)
        env.reset()

        # Warmup step
        actions = np.random.randint(0, 64, size=num_envs)
        env.step_async(actions)
        env.step_wait()

        report_interval = max(1, min(50000, max_steps // 10))

        start_time = time.time()
        for step in range(1, max_steps + 1):
            actions = np.random.randint(0, 64, size=num_envs)
            env.step_async(actions)
            env.step_wait()

            if step % report_interval == 0 or step == max_steps:
                elapsed = time.time() - start_time
                sps = step / elapsed if elapsed > 0 else 0
                pct = (step / max_steps) * 100
                print(f"  [N={num_envs}] {step}/{max_steps} steps ({pct:.0f}%) | SPS={sps:.0f} | Elapsed={elapsed:.2f}s")

        end_time = time.time()
        elapsed = end_time - start_time
        total_env_steps = max_steps * num_envs
        sps = max_steps / elapsed if elapsed > 0 else 0
        spm = sps * 60

        env.close()

        return {
            "N": num_envs,
            "Steps": max_steps,
            "Total Env Steps": total_env_steps,
            "Duration (s)": round(elapsed, 4),
            "SPS": round(sps, 2),
            "SPM": round(spm, 2),
        }
    except Exception as e:
        print(f"Error at N={num_envs}: {e}")
        if env is not None:
            try:
                env.close()
            except Exception:
                pass
        return None


def main():
    parser = argparse.ArgumentParser(description="Bonk RL Throughput Benchmark")
    parser.add_argument("--steps", type=int, default=500000, help="Max steps per configuration (default: 500000)")
    args = parser.parse_args()

    max_steps = args.steps
    bench_configs = [1, 2, 4, 8, 16, 32, 64]
    cooldown = 2

    print("=== Bonk RL Throughput Benchmark ===")
    print(f"Max steps per config: {max_steps}")
    print(f"Environment counts:   {bench_configs}")
    print(f"Cooldown between runs: {cooldown}s")
    print("=" * 40)

    results = []
    for n in bench_configs:
        res = run_throughput_benchmark(n, max_steps=max_steps)
        if res:
            results.append(res)
            print(f"  N={n} => {res['SPS']:.2f} SPS, {res['SPM']:.2f} SPM, {res['Duration (s)']:.2f}s")
        print()
        time.sleep(cooldown)

    print("\n" + "=" * 75)
    print("Benchmark Results:")
    print(f"{'N':>4} | {'Steps':>10} | {'Total Env Steps':>16} | {'Duration (s)':>12} | {'SPS':>12} | {'SPM':>12}")
    print("-" * 75)
    for r in results:
        print(
            f"{r['N']:>4} | {r['Steps']:>10} | {r['Total Env Steps']:>16,} | {r['Duration (s)']:>12.4f} | {r['SPS']:>12.2f} | {r['SPM']:>12.2f}"
        )
    print("=" * 75)


if __name__ == "__main__":
    main()
