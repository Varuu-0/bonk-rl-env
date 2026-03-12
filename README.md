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

## Telemetry System

The Manifold Server includes a comprehensive telemetry system for monitoring performance, debugging issues, and analyzing simulation behavior. The system is designed with a **zero-overhead default** - telemetry is disabled by default and only activates when explicitly enabled.

### Flag-Based Activation

Telemetry is controlled via CLI flags. All flags are optional; the system defaults to maximum performance with all telemetry disabled.

#### CLI Flags

| Flag | Alias | Description | Default |
|:-----|:------|:------------|:--------|
| `--telemetry` | `-t` | Master switch to enable telemetry | `false` |
| `--profile` | `-p` | Profiling detail level: `minimal`, `standard`, `detailed` | `standard` |
| `--debug` | `-d` | Debug output level: `none`, `error`, `verbose` | `none` |
| `--output` | `-o` | Output format: `console`, `file`, `both` | `console` |
| `--dashboard-port` | — | HTTP port for telemetry dashboard | `3001` |
| `--report-interval` | — | Milliseconds between telemetry reports | `5000` |
| `--retention` | — | Days to retain telemetry data files | `7` |

#### Profile Levels

- **`minimal`**: Basic timing information only - minimal overhead
- **`standard`**: Includes per-worker statistics, tick rates, and throughput - recommended for production monitoring
- **`detailed`**: Full debug information including memory usage, IPC latency histograms, and detailed worker state

#### Debug Levels

- **`none`**: No debug output
- **`error`**: Errors and warnings only
- **`verbose`**: Full debug output including all telemetry events

### Environment Variables

Environment variables provide an alternative way to configure telemetry. They take precedence over CLI flags:

| Variable | Values | Description |
|:---------|:-------|:------------|
| `MANIFOLD_TELEMETRY` | `true`, `false`, `1`, `0`, `yes`, `no` | Enable/disable telemetry |
| `MANIFOLD_TELEMETRY_OUTPUT` | `console`, `file`, `both` | Output format |
| `MANIFOLD_PROFILE` | `minimal`, `standard`, `detailed` | Profile level |
| `MANIFOLD_DEBUG` | `none`, `error`, `verbose` | Debug level |

#### Precedence Order

Configuration priority (highest to lowest):
1. Environment variables
2. CLI flags
3. Config file settings
4. Default values

### Usage Examples

#### Basic Usage - Enable Telemetry

```bash
# Enable telemetry with default settings
npx tsx src/main.ts --telemetry

# Short flag form
npx tsx src/main.ts -t
```

#### Production Monitoring

```bash
# Enable with standard profiling, output to file
npx tsx src/main.ts -t --profile standard --output file

# With custom dashboard port
npx tsx src/main.ts -t --dashboard-port 8080

# Less frequent reports for high-throughput scenarios
npx tsx tsx src/main.ts -t --report-interval 10000
```

#### Debugging Issues

```bash
# Enable verbose debug output
npx tsx src/main.ts -t --debug verbose

# Detailed profiling with console output
npx tsx src/main.ts -t --profile detailed --output console

# Both console and file for comprehensive debugging
npx tsx src/main.ts -t --profile detailed --debug verbose --output both
```

#### Environment Variable Usage

```bash
# Enable via environment variable (useful for containers)
export MANIFOLD_TELEMETRY=true
export MANIFOLD_PROFILE=standard
npx tsx src/main.ts

# Docker example
docker run -e MANIFOLD_TELEMETRY=true -e MANIFOLD_DEBUG=error manifold-server
```

### Performance Characteristics

The telemetry system is engineered for minimal performance impact:

| Profile Level | Overhead | Use Case |
|:-------------|:---------|:----------|
| Disabled | **0%** | Production, maximum performance |
| `minimal` | <1% | Lightweight monitoring |
| `standard` | 2-5% | Produ
| `standard` | 2-5% | Production monitoring, recommended |
| `detailed` | 5-10% | Debugging, development |

## Setup and Installation

### Prerequisites

- **Node.js**: v20.0.0 or higher
- **Python**: v3.10+ (for RL agent training)
- **npm** or **yarn**

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/manifold-server.git
cd manifold-server

# Install Node.js dependencies
npm install

# Verify installation
npm run typecheck
```

### Quick Start

```bash
# Start the server (uses ZeroMQ IPC bridge on port 5555)
npm start

# Or with custom port
PORT=5556 npm start

# Stop with Ctrl+C (graceful shutdown)
```

## Shutdown and Signals

The server handles graceful shutdown across different platforms:

### Signal Handling

| Signal | Platform | Behavior |
|--------|----------|----------|
| SIGINT | Unix/macOS/Windows | Graceful shutdown (Ctrl+C) |
| SIGTERM | Unix/macOS | Graceful shutdown |
| SIGBREAK | Windows | Graceful shutdown (Ctrl+Break) |
| close | Windows | Console window close |

### How It Works

1. **Signal Detection**: The `registerShutdownHandlers()` function in `src/main.ts` registers handlers for all relevant signals
2. **Idempotent Registration**: Multiple calls to `registerShutdownHandlers()` won't register duplicate handlers
3. **Resource Cleanup**: On shutdown, the IPC bridge and readline interfaces are properly closed
4. **Timeout Protection**: A 10-second timeout ensures forced exit if graceful shutdown hangs

### Using Scripts

#### Unix/macOS/Linux

```bash
# Start server
./scripts/start-server.sh [port]

# Stop server
./scripts/stop-server.sh
```

#### Windows PowerShell

```powershell
# Start server on custom port
.\scripts\Start-BonkServer.ps1 -Port 5555

# Stop server
.\scripts\Stop-BonkServer.ps1
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5555 | IPC bridge port |
| MANIFOLD_TELEMETRY | false | Enable telemetry |
| MANIFOLD_PROFILE | standard | Profile level |

## Running Tests

```bash
# Run shutdown and script tests
npm test

# Run telemetry tests
npm run test:telemetry

# Type check
npm run typecheck
```

## Performance Benchmarks

Based on internal testing:

| Metric | Value |
|--------|-------|
| Max FPS | 23,400 |
| Tick Rate | 15/30/60 ticks/sec (configurable) |
| Parallel Environments | 64+ |
| IPC Latency | <1ms |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - See LICENSE file for details.
