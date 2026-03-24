# Documentation Index

## Quick Links

- **[Main README](../README.md)** - Full project documentation
- **[Telemetry](./telemetry.md)** - Performance monitoring system
- **[Configuration](./configuration.md)** - Setup and configuration
- **[Benchmarks](./python/benchmarks/benchmark.md)** - Performance testing

## Module Reference

### Python
| Module | Purpose |
|:-------|:--------|
| `bonk_env` | Gymnasium VecEnv wrapper |
| `training_logger` | Trajectory logging |
| `visualize_map` | Map visualization |
| `benchmark` | Performance testing |

### TypeScript
| Module | Purpose |
|:-------|:--------|
| `physics-engine` | Core Box2D physics |
| `worker-pool` | Multi-threaded parallelism |
| `ipc-bridge` | ZeroMQ communication |
| `shared-memory` | Zero-copy IPC |
| `profiler` | Performance profiling |

## Key Constants

| Constant | Value |
|:---------|:------|
| TPS | 30 |
| MAX_TICKS | 900 |
| HEAVY_MASS_MULTIPLIER | 3.0 |

See [physics-engine docs](./typescript/src/core/physics-engine.md) for full constants list.
