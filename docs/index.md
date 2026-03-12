# Bonk.io Reinforcement Learning Environment - Documentation

## Project Overview

**Manifold Server** is a high-performance, headless simulation engine for *Bonk.io*, designed specifically for reinforcement learning and automated agent training. This project transforms the original multiplayer architecture into a synchronous, high-throughput environment capable of processing simulation steps at over 23,400 frames per second.

## Version Information

- **Project Version**: 1.1.0
- **Repository**: Manifold Server
- **License**: MIT
- **Author**: SneezingCactus

## Architecture

The system consists of two primary components:

1. **Node.js Backend** (`/src`): TypeScript headless physics engine with ZeroMQ IPC bridge
2. **Python ML Pipeline** (`/python`): Gymnasium-compatible environment wrapper for RL training

### Key Features

- **Deterministic Physics**: Reproducible simulation results for reliable RL training
- **Multi-threaded Parallelism**: Horizontal scaling across all available CPU cores via Node.js worker threads
- **Gymnasium Compatible**: Native integration with stable-baselines3 and other Python RL frameworks
- **ZeroMQ Communication**: Low-latency message passing between Node.js and Python
- **Configurable Tick Rates**: Support for 15/30/60 ticks per second simulation
- **Memory Efficient**: Typed arrays for observations, worker thread memory isolation
- **Optional SharedArrayBuffer**: Zero-copy IPC for maximum performance

## Module Overview

### Python Modules

| Module | Description |
|:-------|:------------|
| [envs/bonk_env](./python/envs/bonk_env.md) | Gymnasium VecEnv wrapper for Bonk.io physics simulation |
| [utils/training_logger](./python/utils/training_logger.md) | CSV-based trajectory logging utility |
| [utils/visualize_map](./python/utils/visualize_map.md) | Map and trajectory visualization tool |
| [tests/test_env](./python/tests/test_env.md) | Basic environment connectivity test |
| [tests/test_profiler_load](./python/tests/test_profiler_load.md) | High-stress profiler load testing script |
| [benchmarks/benchmark](./python/benchmarks/benchmark.md) | Performance benchmarking script |

### TypeScript Modules

| Module | Description |
|:-------|:------------|
| [src/core/physics-engine](./typescript/src/core/physics-engine.md) | Core Box2D physics simulation engine |
| [src/core/worker-pool](./typescript/src/core/worker-pool.md) | Multi-threaded worker pool management |
| [src/core/environment](./typescript/src/core/environment.md) | Environment state management |
| [src/core/prng](./typescript/src/core/prng.md) | Deterministic pseudo-random number generator |
| [src/ipc/ipc-bridge](./typescript/src/ipc/ipc-bridge.md) | ZeroMQ IPC bridge for Python communication |
| [src/ipc/shared-memory](./typescript/src/ipc/shared-memory.md) | SharedArrayBuffer-based zero-copy IPC |
| [src/telemetry/telemetry-controller](./typescript/src/telemetry/telemetry-controller.md) | Telemetry data collection and reporting |
| [src/telemetry/flags](./typescript/src/telemetry/flags.md) | CLI flag-based telemetry configuration |
| [src/telemetry/profiler](./typescript/src/telemetry/profiler.md) | Performance profiling utilities |
| [config](./typescript/config.md) | Project configuration management |

## Documentation Statistics

- **Total Python Modules**: 6
- **Total TypeScript Modules**: 10
- **Total Documentation Pages**: 18

## Quick Start

### Prerequisites

- Node.js (v20+ recommended)
- Python 3.10+

### Installation

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt
```

### Running the Environment

1. Start the Node.js physics engine:
   ```bash
   npx tsx src/main.ts
   ```

2. Run Python training:
   ```bash
   python -c "from python.envs.bonk_env import BonkEnv; e = BonkEnv(); print(e.reset())"
   ```

## Performance Benchmarks

| Concurrent Envs (N) | Aggregate FPS | Total Time (10,000 steps) |
|:--------------------|:--------------|:--------------------------|
| 1                   | 3,120.19      | 3.2049s                   |
| 2                   | 5,171.39      | 3.8674s                   |
| 4                   | 8,533.98      | 4.6871s                   |
| 8                   | 12,829.85     | 6.2355s                   |
| 16                  | 17,969.23     | 8.9041s                   |
| 32                  | 21,917.79     | 14.6000s                  |
| 64                  | 23,460.06     | 27.2804s                  |

*Total physics throughput peaks at **>23,400 simulation steps per second** with 64 parallel environments.*

## Additional Resources

- [Telemetry System](./telemetry.md) - Comprehensive telemetry configuration guide
- [SharedArrayBuffer](./shared-memory.md) - Optional high-performance IPC mode
- [Roadmap](./roadmap.md) - Planned improvements and implementation status
- [Deprecated APIs](./deprecated.md) - Known issues, deprecated features, and future plans
- [Configuration](./configuration.md) - Setup and configuration guide

## Contributing

This project is for research and educational purposes. Please respect the original developers of *Bonk.io* and follow their policies regarding third-party software.
