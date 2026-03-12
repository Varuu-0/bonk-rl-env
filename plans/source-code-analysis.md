# Manifold Server Source Code Analysis

## Overview
This document provides a detailed analysis of the manifold-server source code structure based on recursive examination of the `src/` directory.

## Directory Structure
```
src/
├── main.ts                    # Entry point
├── core/                      # Core RL environment functionality
│   ├── environment.ts         # BonkEnvironment - Gymnasium-style RL interface
│   ├── physics-engine.ts      # Synchronous Box2D physics wrapper
│   ├── prng.ts                # Deterministic random number generator
│   ├── worker-loader.js       # Worker thread loader
│   ├── worker-pool.ts         # Worker thread management
│   └── worker.ts              # Worker thread implementation
├── ipc/                       # Inter-process communication
│   ├── ipc-bridge.ts          # ZeroMQ bridge for Python communication
│   └── shared-memory.ts       # SharedArrayBuffer zero-copy IPC
├── legacy/                    # Original bonk.io server code
│   ├── inPacketIds.ts         # Incoming packet ID definitions
│   ├── outPacketIds.ts        # Outgoing packet ID definitions
│   ├── server.ts              # Express/Socket.IO server
│   └── terminal.ts            # Command-line interface
├── telemetry/                 # Telemetry and profiling system
│   ├── flags.ts               # CLI flag parsing
│   ├── profiler.ts            # High-precision profiler
│   └── telemetry-controller.ts # Telemetry singleton manager
└── types/                     # TypeScript definitions
    └── index.d.ts             # All type definitions
```

## Component Analysis

### 1. Entry Point (`main.ts`)
- Initializes `IpcBridge` on port 5555
- Sets up graceful shutdown handlers for SIGINT/SIGTERM
- Starts the IPC bridge and waits for Python connections
- Replaces the original `index.ts` which started the Express/Socket.IO server

### 2. Core Modules

#### Environment (`environment.ts`)
- Provides Gymnasium-style RL interface with `reset()` and `step(action)` methods
- AI controls player 0, with dummy opponent(s) using random/scripted policies
- Fully synchronous - each `step()` advances physics by exactly one tick (1/30s)
- Observation includes player state, opponent states, arena boundaries, and tick count
- Reward structure: +1 for opponent KO, -1 for self KO, -0.001 time penalty
- Supports configurable number of opponents, max ticks, random opponent policy, custom maps, and seeding

#### Physics Engine (`physics-engine.ts`)
- Synchronous Box2D wrapper running at 30 TPS (ticks per second)
- No real-time clock - `tick()` called manually by RL loop
- Player bodies are circles with configurable radius/density
- Heavy state doubles mass and applies downward force
- Features: grappling joints, lethal collision detection, out-of-bounds death detection
- Telemetry integration for performance monitoring

#### PRNG (`prng.ts`)
- Mulberry32-based deterministic random number generator
- Used for opponent behavior and environment randomization
- Provides `next()` (0-1 float) and `nextInt(min, max)` methods

#### Worker System (`worker-pool.ts`, `worker.ts`, `worker-loader.js`)
- `WorkerPool`: Manages pool of worker threads for parallel environment execution
- Supports both shared memory (zero-copy IPC) and message passing modes
- Automatic fallback to message passing if shared memory not supported
- Each worker runs multiple `BonkEnvironment` instances
- Action encoding: bit flags (left=1, right=2, up=4, down=8, heavy=16, grapple=32)
- Shared memory layout: actions, observations, rewards, dones, truncated, ticks, seeds, control

### 3. IPC Modules

#### IPC Bridge (`ipc-bridge.ts`)
- ZeroMQ Router socket bound to tcp://127.0.0.1:5555
- Handles JSON-encoded commands from Python RL agents:
  - `init`: Initializes worker pool with configuration
  - `reset`: Resets environments with optional seeds
  - `step`: Steps environments with actions
- Integrates with telemetry system for performance monitoring
- Manages worker pool lifecycle

#### Shared Memory (`shared-memory.ts`)
- Zero-copy IPC using SharedArrayBuffer
- Efficient binary data transfer between main thread and workers
- Ring buffer for actions to allow pipelining
- Atomic operations for synchronization between threads
- Layout optimized for cache efficiency with proper alignment
- Supports reset and step commands with signaling mechanism

### 4. Legacy Modules
These appear to be the original bonk.io server code, maintained for compatibility:

#### Server (`server.ts`)
- Express.js server with Socket.IO for real-time communication
- HTTPS support with certificate files
- CORS restricted to bonk.io origin
- Player management: joining, leaving, team changes, chat, ready states
- Rate limiting for various actions (joining, chatting, team changes, etc.)
- Host management: transfer, kicking, banning
- Scheduled closing functionality
- Chat logging with timestamp formatting

#### Terminal (`terminal.ts`)
- Command-line interface for server administration
- Commands: host, ban, unban, players, roomname, roompass, savechatlog, scheduledclose, abortscheduledclose, close, help
- Player lookup by ID or username
- Integration with server for executing administrative actions

#### Packet IDs (`inPacketIds.ts`, `outPacketIds.ts`)
- String-based packet ID definitions for Socket.IO communication
- Organized by functional areas: join handlers, lobby actions, in-game actions, misc

### 5. Telemetry System
High-performance telemetry system designed for zero-allocation hot paths:

#### Flags (`flags.ts`)
- CLI argument parsing for telemetry configuration
- Boolean flags: `--telemetry`, `--enable-telemetry`, `-t`
- Value flags with validation: `--profile`, `--debug`, `--output`, `--dashboard-port`, `--report-interval`, `--retention`
- Environment variable overrides: `MANIFOLD_TELEMETRY`, `MANIFOLD_TELEMETRY_OUTPUT`, `MANIFOLD_PROFILE`, `MANIFOLD_DEBUG`
- Merging with config file settings (CLI takes precedence)

#### Profiler (`profiler.ts`)
- Global `BigUint64Array` accumulator indexed by `TelemetryIndices`
- `wrap(label, fn)` decorator for automatic timing of sync/async functions
- Legacy API: start/end timers, increment counters, set gauges
- Heatmap-style reporting showing average time per frame and percentage of frame budget
- Worker telemetry aggregation for global statistics
- Frame budget: 33.3ms (30 FPS) = 33,333,333ns
- Critical path highlighting when >25% of frame budget consumed

#### Telemetry Controller (`telemetry-controller.ts`)
- Singleton manager for telemetry settings
- Lazy initialization on first access
- Thread-safe double-checked locking pattern
- Fast-path `isEnabled()` check for hot loops
- Automatic report generation based on interval
- Worker telemetry gathering via `getTelemetrySnapshots()`
- File output placeholder for Phase 2 implementation

### 6. Types Module (`types/index.d.ts`)
Centralized TypeScript definitions including:
- `BanList`, `UsernameRestrictions`, `LevelRestrictions`, `RatelimitRestrictions`
- `ConfigRestrictions`, `Config`, `GameSettings`
- `eAvatarShape` enum, `AvatarLayer`, `Avatar`, `Player`
- `TerminalCommand` interface
- `TelemetryFlags` and `TelemetryConfig` interfaces

## Dependencies and Data Flow

### Main Data Flow (RL Training)
1. Python RL agent sends JSON commands via ZeroMQ to `ipc-bridge.ts`
2. IPC bridge forwards commands to `worker-pool.ts`
3. Worker pool distributes work to worker threads (`worker.ts`)
4. Each worker runs `BonkEnvironment` instances which use:
   - `physics-engine.ts` for physics simulation
   - `prng.ts` for random number generation
5. Results flow back through the same path to Python agent
6. When shared memory is enabled:
   - Actions written to SharedArrayBuffer by main thread
   - Workers read actions, process environments, write results
   - Atomic operations synchronize between threads without copying

### Telemetry Flow
1. Functions wrapped with `wrap()` from `profiler.ts` automatically record timing
2. Data accumulated in global `TelemetryBuffer`
3. `telemetry-controller.ts` triggers reports at intervals
4. Reports include per-function timing and worker statistics
5. Can output to console, file, or both based on configuration

### Legacy Server Flow (Separate from RL)
1. Players connect via Socket.IO to `server.ts`
2. Server handles game logic, player management, chat
3. Administrative commands via `terminal.ts`
4. Packet IDs define communication protocol
5. This system runs independently of the RL environment

## Architectural Characteristics

### Performance Optimizations
- Synchronous physics simulation (no real-time clock)
- Zero-copy IPC via SharedArrayBuffer for worker communication
- Deterministic PRNG for reproducible experiments
- Telemetry system designed for zero-allocation hot paths
- Ring buffers and atomic operations for efficient synchronization
- Lazy initialization of telemetry hooks

### Scalability Features
- Worker pool scales with available CPU cores
- Each worker can manage multiple environments
- Shared memory reduces serialization overhead
- Fallback to message passing ensures compatibility

### Modularity and Separation of Concerns
- Clear separation between RL environment and legacy game server
- IPC bridge decouples Python agents from core simulation
- Telemetry system is pluggable and configurable
- Type definitions centralized in types module
- Legacy systems maintained for backward compatibility

### Reliability Features
- Graceful shutdown handling
- Input validation and sanitization
- Rate limiting to prevent abuse
- Error handling and logging throughout
- Memory leak prevention in worker cleanup
- Timeout mechanisms for worker communication

## Potential Improvement Areas

Based on the analysis, several areas could be considered for improvement:

1. **Documentation**: Add more inline comments explaining complex algorithms
2. **Type Safety**: Some areas use `any` types that could be strengthened
3. **Configuration**: External configuration file support beyond command-line flags
4. **Testing**: Visible lack of test files in the src/ directory
5. **Modernization**: Some legacy patterns could be updated to modern TypeScript practices
6. **Security**: Additional input validation and sanitization in network-facing code
7. **Observability**: Enhanced logging and metrics collection capabilities
8. **Code Duplication**: Some patterns repeated across worker and main thread code

## Summary
The manifold-server represents a sophisticated headless RL environment built upon the original bonk.io game server. It cleanly separates the RL training infrastructure (worker pool, IPC bridge, shared memory) from the legacy game server functionality, while providing high-performance communication channels and comprehensive telemetry for performance monitoring and debugging.

The architecture demonstrates careful consideration of performance requirements for RL training, with synchronous simulation, zero-copy IPC, and efficient telemetry systems. The modular design allows for independent development and maintenance of different subsystems.