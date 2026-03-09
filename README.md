# Bonk.io Reinforcement Learning Environment

A high-performance, headless simulation engine for *Bonk.io*, designed specifically for reinforcement learning and automated agent training. This repository transforms the original multiplayer architecture into a synchronous, high-throughput environment capable of processing simulation steps at over 23,400 frames per second.

## Overview

This project decouples the core *Bonk.io* physics logic from the original multiplayer networking stack. By removing browser-based rendering and WebSocket bottlenecks, we have created a deterministic, headless simulation loop. This allows machine learning agents to train in minutes rather than days, making it an ideal environment for testing PPO, DQN, or other reinforcement learning algorithms.

## Architecture

- **Worker Pool**: Operates as a Massively Parallel Vectorized Environment, dynamically scaling to use all available CPU cores via Node.js `worker_threads`.
- **Synchronous Loop**: Replaces real-time clocks with a synchronous `tick()` system equipped with a deterministic PRNG for perfectly reproducible rollouts.
- **Batch IPC Bridge**: Utilizes **ZeroMQ (ZMQ) ROUTER/DEALER** patterns for high-speed, batch communication between the TypeScript worker pool and the Python ML pipeline.
- **Vectorized Gymnasium API**: Implements the `stable_baselines3.common.vec_env.VecEnv` interface natively, allowing the Python agent to dispatch actions and aggregate observations across 64+ parallel environments simultaneously.

## Features

- **Deterministic Physics**: Reproducible simulation results for reliable RL training
- **Multi-threaded Parallelism**: Horizontal scaling across all available CPU cores
- **Gymnasium Compatible**: Native integration with stable-baselines3 and other Python RL frameworks
- **ZeroMQ Communication**: Low-latency message passing between Node.js and Python
- **Configurable Tick Rates**: Support for 15/30/60 ticks per second simulation
- **Memory Efficient**: Typed arrays for observations, worker thread memory isolation

## SharedArrayBuffer Worker Pool (Optional Feature)

This implementation includes an optional **SharedArrayBuffer** mode for high-performance worker pool communication. This feature provides zero-copy inter-process communication between the main thread and worker threads.

### What It Does

The SharedArrayBuffer implementation enables **zero-copy IPC** between the main thread and worker threads. Instead of serializing and copying data through message passing, workers share a common memory region for exchanging environment states and actions.

### How It Works

The implementation uses JavaScript's `SharedArrayBuffer` combined with the `Atomics` API for synchronization:

- **Shared Memory Region**: A pre-allocated `SharedArrayBuffer` is shared between the main thread and all worker threads
- **Atomic Synchronization**: The `Atomics` API (specifically `Atomics.wait`, `Atomics.notify`, and `Atomics.store`/`Atomics.load`) provides lock-free synchronization between threads
- **Ring Buffer Protocol**: A ring buffer structure in shared memory allows efficient, non-blocking exchange of environment steps

### Benefits

- **Reduced Latency**: Eliminates serialization/deserialization overhead for each environment step
- **Lower Memory Usage**: Single buffer instead of per-message allocation
- **Improved Throughput**: Particularly beneficial for high-frequency environment stepping (60 ticks/sec)
- **Cache-Friendly**: Shared memory can be more cache-coherent than message passing

### How to Enable/Disable

Pass the `useSharedMemory` parameter when initializing the environment:

```typescript
// Enable SharedArrayBuffer (default: false)
const env = await init({
  numEnvs: 32,
  useSharedMemory: true  // Enable zero-copy IPC
});

// Disable SharedArrayBuffer (default behavior)
const env = await init({
  numEnvs: 32,
  useSharedMemory: false  // Use standard message passing
});
```

### Requirements

- **Browser Security**: SharedArrayBuffer requires specific HTTP headers for cross-origin isolation:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **Node.js Version**: Requires Node.js v12+ (v18+ recommended)
- **Platform Support**: Works on Windows, macOS, and Linux

If SharedArrayBuffer is not available (or headers not set), the system automatically falls back to standard `postMessage` communication.

## Performance

By dispersing batched simulation steps across multiple worker threads, the engine achieves massive horizontal scaling.

### Benchmark Results (Sustained Performance)

Ran 10,000 steps across varying instance counts to measure sustained throughput:

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

## Setup & Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended, v22+ for latest optimizations)
- [Python 3.8+](https://www.python.org/)

### Node.js Backend

1. Install dependencies:
   ```bash
   npm install
   npm install zeromq@6
   ```
2. Start the simulation engine:
   ```bash
   npx tsx src/main.ts
   ```

### Python ML Pipeline

1. Install requirements:
   ```bash
   pip install -r requirements.txt
   ```
   *(Ensure `stable-baselines3`, `gymnasium`, and `pyzmq` are included)*
2. Train your agent:
   ```bash
   python python/train_agent.py
   ```

## Repository Structure

- `/src`: Contains the TypeScript headless physics engine and the ZMQ bridge server.
- `/python`: Contains the `BonkEnv` Gymnasium wrapper and the training scripts.
- `/bonk1-box2d`: The source physics module reference.

## Roadmap

Planned improvements organized by priority and implementation phase.

### Phase 1: Quick Wins (1-2 weeks)

- Binary protocol for ZMQ (MsgPack/Protocol Buffers)
- Typed arrays for observations
- ZMQ socket optimization
- Box2D configuration tuning

### Phase 2: Core Optimization (2-4 weeks)

- Worker affinity and NUMA optimization
- Adaptive worker pool scaling
- SharedArrayBuffer for zero-copy IPC
- Worker pool pre-warming
- Performance benchmarks and profiling

### Phase 3: Advanced Features (4-8 weeks)

- Multi-agent support
- Curriculum learning
- Custom reward function support
- GPU-accelerated batch processing
- Trajectory recording and playback
- Real-time statistics dashboard

### Future Enhancements

- Multi-environment map support
- Server mode for human play
- Box2D WASM investigation
- TypeScript 5.x migration

## License

This project is for research and educational purposes. Please respect the original developers of *Bonk.io* and follow their policies regarding third-party software.
