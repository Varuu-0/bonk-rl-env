# benchmarks/

Performance benchmarking tools for measuring the throughput of the Bonk.io RL environment across different parallelism configurations.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [benchmark.md](benchmark.md) | `python/benchmarks/benchmark.py` | Configuration sweep benchmark — runs 100-step iterations across varying `num_envs` counts (1, 2, 4, 8, 16, 32, 64, 128), reports per-config FPS and aggregate steps/sec |
| [throughput_benchmark.md](throughput_benchmark.md) | `python/benchmarks/throughput_benchmark.py` | Long-running throughput benchmark — executes up to 500,000 steps per configuration, measures sustained aggregate env-steps/sec for training workload characterization |
