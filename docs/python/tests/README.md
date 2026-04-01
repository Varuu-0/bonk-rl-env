# tests/

Test scripts for verifying Python-to-engine connectivity and stress-testing the IPC bridge.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [test_env.md](test_env.md) | `python/tests/test_env.py` | Basic connectivity test — creates 64 parallel envs, runs 100 random steps, reports FPS throughput |
| [test_profiler_load.md](test_profiler_load.md) | `python/tests/test_profiler_load.py` | High-stress load test — drives 50,000 ticks across 64 envs to saturate the worker pool and generate profiler data for the Straggler Detector |
