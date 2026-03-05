"""
High-stress profiler load test for the Bonk physics engine.

This script is designed to saturate the IPC bridge and worker pool so that
the Node.js profiler and Straggler Detector have enough data to generate
useful reports.

Usage workflow:

Terminal 1 (Engine & Profiler)
------------------------------
- Start the physics engine and profiler:
    npx tsx src/main.ts

  Watch this terminal for:
  - Periodic profiler heatmaps (every ~5,000 physics ticks).
  - Straggler reports that flag slow workers, e.g.:
      [Worker ID: X] | Status: Lagging
  - PHYSICS_TICK mean (ms):
      - > 1.0 ms  => CPU is struggling.
      - < 0.1 ms  => CPU is breezing through the load.

Terminal 2 (Load Test)
----------------------
- From the project root, run:
    python python/test_profiler_load.py

What this script does:
- Connects to the running Bonk engine via ZMQ using BonkVecEnv.
- Spawns 64 parallel environments to stress the worker pool.
- Drives the simulation as fast as possible (no sleeps) for ~50,000 physics ticks.
- Prints a single-line progress indicator:
    Progress: {ticks_done}/{target_ticks} physics ticks...
- At the end, prints overall throughput in Physics Ticks/sec.

If you consistently see the same worker flagged as Lagging in Terminal 1,
that worker is likely handling an environment that sits in a \"heavy\" part
of your map (e.g., dense collision clusters in wdb.json).
"""

import time
from typing import Optional

import numpy as np

from bonk_env import BonkVecEnv


def main() -> None:
    num_envs = 64
    target_ticks = 50_000
    report_interval_ticks = 5_000

    print("Starting high-stress profiler load test...")
    print(f"- Parallel environments: {num_envs}")
    print(f"- Target physics ticks: {target_ticks}")
    print(f"- Report interval:      {report_interval_ticks} ticks\n")

    env: Optional[BonkVecEnv] = None

    try:
        # Connect to the already-running Node.js engine
        env = BonkVecEnv(num_envs=num_envs)
        env.reset()

        start_time = time.time()
        ticks_done = 0
        next_report = report_interval_ticks

        print("Executing batched physics steps at maximum throughput...")

        # Tight loop: no sleeps, saturate the IPC bridge and worker pool.
        while ticks_done < target_ticks:
            # Discrete(64) action space => integers in [0, 64)
            actions = np.random.randint(0, 64, size=num_envs)

            # VecEnv provides a synchronous step built on step_async/step_wait.
            _obs, _rewards, _dones, _infos = env.step(actions)

            ticks_done += num_envs

            # Emit progress whenever we cross another 5,000-tick boundary.
            while ticks_done >= next_report and next_report <= target_ticks:
                print(
                    f"Progress: {ticks_done}/{target_ticks} physics ticks...",
                    end="\r",
                    flush=True,
                )
                next_report += report_interval_ticks

        elapsed = time.time() - start_time
        if elapsed <= 0:
            elapsed = 1e-9

        print()  # Move off the progress line.
        print(f"Load test complete in {elapsed:.2f} seconds.")
        print(f"Throughput: {ticks_done / elapsed:.2f} Physics Ticks/sec")

    finally:
        if env is not None:
            env.close()


if __name__ == "__main__":
    main()

