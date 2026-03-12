# Manifold Server Comprehensive Documentation Reference

This document synthesizes all file analyses performed to provide a complete understanding of the manifold-server system, including how files interconnect, system functionality, data and control flows, architectural patterns, and component roles.

## Table of Contents
1. [System Overview](#system-overview)
2. [File Interconnections](#file-interconnections)
3. [Holistic System Function](#holistic-system-function)
4. [Data Flow Between Modules](#data-flow-between-modules)
5. [Control Flow Patterns](#control-flow-patterns)
6. [Architectural Patterns Employed](#architectural-patterns-employed)
7. [Component Summary](#component-summary)
8. [Integration Points](#integration-points)

## System Overview

The manifold-server is a sophisticated headless RL (Reinforcement Learning) environment built upon the original bonk.io game server. It cleanly separates the RL training infrastructure from the legacy game server functionality while providing high-performance communication channels and comprehensive telemetry.

The system serves two primary purposes:
1. **RL Training Environment**: A headless bonk.io physics simulator optimized for machine learning training via IPC with Python RL agents
2. **Legacy Game Server**: The original bonk.io server for human players (maintained for compatibility)

These systems operate independently but share core physics and type definitions.

## File Interconnections

### Core Directory Structure
```
src/
├── main.ts                    # Entry point (RL environment)
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

### Key Interconnections

1. **main.ts → ipc-bridge.ts**: Entry point instantiates and starts the IPC bridge
2. **ipc-bridge.ts ↔ worker-pool.ts**: IPC bridge communicates with worker pool via ZeroMQ
3. **worker-pool.ts → worker.ts**: Worker pool manages worker threads
4. **worker.ts → environment.ts**: Workers run BonkEnvironment instances
5. **environment.ts → physics-engine.ts, prng.ts**: Environment uses physics and RNG
6. **physics-engine.ts → Box2D**: Physics engine wraps Box2D library
7. **ipc-bridge.ts ↔ shared-memory.ts**: IPC bridge coordinates shared memory when enabled
8. **worker-pool.ts ↔ shared-memory.ts**: Worker pool manages shared memory managers
9. **telemetry/* modules**: Telemetry system integrates throughout via decorators and globals
10. **types/index.d.ts**: Centralized type definitions used across all modules
11. **legacy/server.ts ↔ legacy/terminal.ts**: Legacy server and terminal CLI are interconnected
12. **legacy/* ↔ inPacketIds.ts/outPacketIds.ts**: Legacy communication uses defined packet IDs

## Holistic System Function

### RL Training Path (Primary Function)
1. **Input**: Python RL agent sends JSON commands via ZeroMQ to `ipc-bridge.ts` on port 5555
2. **Command Processing**: IPC bridge parses commands (`init`, `reset`, `step`) and forwards to worker pool
3. **Worker Distribution**: Worker pool distributes work to worker threads
4. **Environment Execution**: Each worker runs `BonkEnvironment` instances which:
   - Apply actions to physics engine
   - Step physics synchronously (1 tick = 1/30s)
   - Generate observations, rewards, and termination signals
   - Use deterministic PRNG for opponent behavior
5. **Result Aggregation**: Worker pool collects results from all workers
6. **Output**: Results sent back to Python agent via ZeroMQ
7. **Telemetry**: Throughout the process, telemetry automatically captures performance metrics

### Shared Memory Optimization (When Enabled)
- Actions written to SharedArrayBuffer by main thread
- Workers read actions directly from shared memory (zero-copy)
- Workers process environments and write results to shared memory
- Atomic operations synchronize between threads without data copying
- Ring buffer allows pipelining of actions

### Legacy Game Server Path (Separate)
1. **Input**: Human players connect via Socket.IO to `server.ts`
2. **Game Logic**: Server handles player movement, chat, game state
3. **Player Management**: Server manages joining/leaving, teams, ready states
4. **Administrative Control**: Terminal CLI provides admin commands
5. **Output**: Server sends game state updates to clients via Socket.IO
6. **Rate Limiting**: Prevents abuse of various actions
7. **Host Management**: Transfer, kicking, banning functionality

## Data Flow Between Modules

### RL Training Data Flow
```
Python Agent 
    ↓ ZeroMQ (JSON)
IPC Bridge (ipc-bridge.ts)
    ↓ Internal Calls
Worker Pool (worker-pool.ts)
    ↓ Worker Messages
Worker Threads (worker.ts)
    ↓ Environment Calls
Bonk Environment (environment.ts)
    ↓ Physics Calls
Physics Engine (physics-engine.ts)
    ↓ Box2D Library
    ↑ Physics State
Bonk Environment (environment.ts)
    ↓ Observation/Result Construction
Worker Threads (worker.ts)
    ↓ Result Messages
Worker Pool (worker-pool.ts)
    ↓ Internal Calls
IPC Bridge (ipc-bridge.ts)
    ↓ ZeroMQ (JSON)
Python Agent
```

### Shared Memory Data Flow (Optimized Path)
```
Main Thread:
    ↓ Encode Actions
Shared Memory Buffer (SharedArrayBuffer)
    ↑ Read Actions
Worker Thread:
    ↓ Process Environment
Shared Memory Buffer (SharedArrayBuffer)
    ↑ Write Results
Main Thread:
    ↓ Read Results
```

### Telemetry Data Flow
```
Function Calls
    ↓ @wrap Decorator (profiler.ts)
Telemetry Buffer (BigUint64Array)
    ↓ Periodic Collection
Telemetry Controller (telemetry-controller.ts)
    ↓ Report Generation
Console/File Output
```

Worker Telemetry Flow:
```
Worker Thread Functions
    ↓ @wrap Decorator
Worker Local Telemetry Buffer
    ↓ GET_TELEMETRY Command
Worker Pool (worker-pool.ts)
    ↓ Collect Snapshots
Telemetry Controller
    ↓ Aggregate Reporting
```

### Legacy Server Data Flow
```
Socket.IO Client
    ↓ WebSocket Messages
Legacy Server (server.ts)
    ↓ Game Logic Processing
Player State Updates
    ↓ Broadcast to Clients
Socket.IO Client
    ↑ Game State Updates
    
Terminal CLI
    ↓ Admin Commands
Legacy Server (server.ts)
    ↓ Execute Administrative Actions
```

## Control Flow Patterns

### Synchronous Execution Pattern
- **Where**: Core RL environment (`environment.ts`, `physics-engine.ts`)
- **How**: Each `step()` call advances physics by exactly one tick (1/30s)
- **Benefit**: Deterministic behavior essential for RL training
- **Contrast**: Unlike real-time game loops, there's no internal clock

### Request-Response Pattern
- **Where**: IPC bridge (`ipc-bridge.ts`)
- **How**: ZeroMQ Router socket handles request/reply cycle with Python agents
- **Commands**: `init`, `reset`, `step` with corresponding responses
- **Benefit**: Clear separation of concerns, easy to debug

### Worker Pool Pattern
- **Where**: Worker pool (`worker-pool.ts`)
- **How**: Manages fixed pool of worker threads for parallel environment execution
- **Load Balancing**: Distributes environments evenly across workers
- **Fault Tolerance**: Includes timeout mechanisms and error handling

### Double-Checked Locking Pattern
- **Where**: Telemetry controller (`telemetry-controller.ts`)
- **How**: Lazy initialization with thread-safe access
- **Benefit**: Zero overhead when telemetry disabled, safe initialization

### Decorator Pattern
- **Where**: Profiler (`profiler.ts`)
- **How**: `wrap()` function automatically instruments synchronous/async functions
- **Benefit**: Zero-allocation hot paths, automatic performance monitoring

### State Pattern
- **Where**: Environment (`environment.ts`)
- **How**: Tracks player states (alive/dead, heavy/normal) for reward calculation
- **Benefit**: Clear separation of state concerns

### Observer Pattern (Implicit)
- **Where**: Telemetry system
- **How**: Various modules register for telemetry collection via global profiler
- **Benefit**: Decoupled performance monitoring

## Architectural Patterns Employed

### 1. Modular Separation of Concerns
- **RL Infrastructure**: Completely separate from legacy game server
- **IPC Layer**: Abstracts communication mechanism (ZeroMQ/shared memory)
- **Worker Abstraction**: Hides threading complexity from core logic
- **Telemetry**: Pluggable monitoring system
- **Types**: Centralized definitions prevent duplication

### 2. Layered Architecture
```
Presentation Layer (Python Agent/Human Clients)
    ↓
Application Layer (IPC Bridge/Socket.IO Server)
    ↓
Domain Layer (Environment, Physics Engine)
    ↓
Infrastructure Layer (Worker System, Shared Memory, Telemetry)
    ↓
External Systems (Box2D, ZeroMQ, Node.js worker_threads)
```

### 3. Proxy Pattern
- **Where**: Shared memory manager (`shared-memory.ts`)
- **How**: Provides zero-copy interface to SharedArrayBuffer
- **Benefit**: Efficient binary data transfer between threads

### 4. Object Pool Pattern
- **Where**: Worker pool (`worker-pool.ts`)
- **How**: Reuses worker threads instead of creating/destroying per task
- **Action Buffer Pool**: Reuses Uint8Arrays for action encoding
- **Benefit**: Reduced allocation overhead, predictable performance

### 5. Ring Buffer Pattern
- **Where**: Shared memory (`shared-memory.ts`)
- **How**: Circular buffer for actions to allow pipelining
- **Benefit**: Enables asynchronous action submission while maintaining order

### 6. Singleton Pattern
- **Where**: Telemetry controller (`telemetry-controller.ts`)
- **How**: Global instance manages telemetry configuration and reporting
- **Benefit**: Centralized control, consistent configuration

### 7. Factory Pattern (Implicit)
- **Where**: Environment creation (`environment.ts` constructor)
- **How**: Creates physics engine, PRNG, and sets up initial state
- **Benefit**: Encapsulates complex initialization logic

### 8. Strategy Pattern
- **Where**: Opponent behavior (`environment.ts`)
- **How**: Configurable random vs. scripted opponent policies
- **Benefit**: Easy to swap opponent behaviors without changing core logic

### 9. Command Pattern
- **Where**: IPC bridge command handling (`ipc-bridge.ts`)
- **How**: Encapsulates requests as objects with execute method
- **Benefit**: Easy to extend with new commands, undo/redo capability

### 10. Template Method Pattern
- **Where**: Worker initialization (`worker-pool.ts`)
- **How**: Common initialization flow with shared memory fallback
- **Benefit**: Consistent setup process with optional optimization

## Component Summary

### Entry Point
- **main.ts**: Application entry point, initializes IPC bridge, handles graceful shutdown

### Core RL Environment
- **environment.ts**: Gymnasium-style RL interface with reset()/step() API
  - Controls AI player (ID 0) with dummy opponents
  - Synchronous physics stepping (1 tick = 1/30s)
  - Reward: +1 opponent KO, -1 self KO, -0.001 time penalty
  - Features: Configurable opponents, maps, seeding, max ticks
- **physics-engine.ts**: Synchronous Box2D wrapper at 30 TPS
  - Manual tick() advancement (no real-time clock)
  - Player bodies as circles with configurable properties
  - Heavy state: doubled mass + downward force
  - Features: Grappling joints, lethal collision, OOB death detection
  - Telemetry integration for performance monitoring
- **prng.ts**: Mulberry32-based deterministic RNG
  - Used for opponent behavior and environment randomization
  - Methods: next() (0-1 float), nextInt(min, max)
- **worker.ts**: Individual worker thread implementation
  - Runs multiple BonkEnvironment instances
  - Handles init/reset/step commands from worker pool
  - Supports both shared memory and message passing modes
- **worker-loader.js**: Minimal script to bootstrap worker threads
- **worker-pool.ts**: Manages pool of worker threads
  - Scales with CPU cores (default: min(cores, 8))
  - Distributes environments evenly across workers
  - Shared memory mode: Zero-copy IPC via SharedArrayBuffer
  - Message passing fallback: Traditional worker thread messaging
  - Action encoding: Bit flags (left=1, right=2, up=4, down=8, heavy=16, grapple=32)
  - Shared memory layout: Actions, observations, rewards, dones, truncated, ticks, seeds, control

### IPC System
- **ipc-bridge.ts**: ZeroMQ Router socket on tcp://127.0.0.1:5555
  - Handles JSON commands from Python RL agents
  - Commands: init (worker pool setup), reset (environment reset), step (action execution)
  - Integrates with telemetry system for performance monitoring
  - Manages worker pool lifecycle
- **shared-memory.ts**: Zero-copy IPC using SharedArrayBuffer
  - Ring buffer for actions to enable pipelining
  - Atomic operations for thread synchronization
  - Cache-efficient layout with proper alignment
  - Supports reset and step commands with signaling mechanism
  - Automatic fallback detection when SharedArrayBuffer not supported

### Telemetry System
- **flags.ts**: CLI argument parsing for telemetry configuration
  - Boolean flags: --telemetry, --enable-telemetry, -t
  - Value flags: --profile, --debug, --output, --dashboard-port, --report-interval, --retention
  - Environment variable overrides: MANIFOLD_TELEMETRY*, etc.
  - Merging with config file settings (CLI takes precedence)
- **profiler.ts**: High-precision telemetry profiler
  - Global BigUint64Array accumulator indexed by TelemetryIndices
  - wrap(label, fn) decorator for automatic timing of sync/async functions
  - Legacy API: start/end timers, increment counters, set gauges
  - Heatmap-style reporting: average time per frame, % of frame budget
  - Worker telemetry aggregation for global statistics
  - Frame budget: 33.3ms (30 FPS) = 33,333,333ns
  - Critical path highlighting when >25% of frame budget consumed
- **telemetry-controller.ts**: Singleton manager for telemetry settings
  - Lazy initialization on first access (double-checked locking)
  - Thread-safe initialization
  - Fast-path isEnabled() check for hot loops
  - Automatic report generation based on interval
  - Worker telemetry gathering via getTelemetrySnapshots()
  - File output placeholder for Phase 2 implementation

### Legacy Systems (Maintained for Compatibility)
- **server.ts**: Express.js server with Socket.IO for real-time communication
  - HTTPS support with certificate files
  - CORS restricted to bonk.io origin
  - Player management: joining, leaving, team changes, chat, ready states
  - Rate limiting for various actions (joining, chatting, team changes, etc.)
  - Host management: transfer, kicking, banning
  - Scheduled closing functionality
  - Chat logging with timestamp formatting
- **terminal.ts**: Command-line interface for server administration
  - Commands: host, ban, unban, players, roomname, roompass, savechatlog, scheduledclose, abortscheduledclose, close, help
  - Player lookup by ID or username
  - Integration with server for executing administrative actions
- **inPacketIds.ts/outPacketIds.ts**: String-based packet ID definitions
  - Organized by functional areas: join handlers, lobby actions, in-game actions, misc
  - Used for Socket.IO communication protocol

### Type Definitions
- **types/index.d.ts**: Centralized TypeScript definitions
  - BanList, UsernameRestrictions, LevelRestrictions, RatelimitRestrictions
  - ConfigRestrictions, Config, GameSettings
  - eAvatarShape enum, AvatarLayer, Avatar, Player
  - TerminalCommand interface
  - TelemetryFlags and TelemetryConfig interfaces

## Integration Points

### Python RL Agent Integration
- **Protocol**: ZeroMQ Router socket on port 5555
- **Message Format**: JSON-encoded commands
- **Commands**:
  - `init`: {numEnvs: N, config: {...}, useSharedMemory: boolean}
  - `reset`: {seeds: [number]} (optional)
  - `step`: {actions: [number]} (action bit flags)
- **Responses**: {status: "ok"/"error", data: {...}}

### Shared Memory Integration
- **Detection**: SharedMemoryManager.isSupported() check
- **Layout**:
  - Actions: Uint8Array[ringSize * numEnvs] (bit flags)
  - Observations: Float32Array[numEnvs * 14] (player state + opponent + tick)
  - Rewards: Float32Array[numEnvs]
  - Dones/Truncated: Uint8Array[numEnvss]
  - Ticks: Uint32Array[numEnvs]
  - Seeds: Uint32Array[numEnvs] (for reset)
  - Control: Uint8Array[2] (command signaling, results ready)
- **Synchronization**: Atomic operations via SharedArrayBuffer

### Telemetry Integration
- **Automatic Instrumentation**: @wrap decorator on functions
- **Manual Instrumentation**: profiler.start/end/increment/gauge APIs
- **Configuration**: Via CLI flags, environment variables, or config.ts
- **Reporting**: Automatic interval-based or manual triggering
- **Worker Aggregation**: Collects telemetry from all workers for global view

### Legacy System Integration
- **Independent Operation**: Legacy server runs separately from RL environment
- **Shared Physics**: Both systems could potentially use same physics engine
- **Shared Types**: Type definitions used by both systems
- **No Direct Communication**: Systems operate in separate processes/threads

## Data Flow Summary

### RL Training Path (Optimized with Shared Memory)
1. Python agent → ZeroMQ JSON → IPC bridge
2. IPC bridge → Worker pool commands
3. Worker pool → Shared memory writes (actions)
4. Shared memory → Worker threads read actions
5. Worker threads → Environment processing
6. Environment → Physics engine stepping
7. Physics engine → State updates
8. Environment → Observation/reward calculation
9. Worker threads → Shared memory writes (results)
10. Shared memory → Main thread reads results
11. Main thread → Worker pool aggregation
12. Worker pool → IPC bridge response
13. IPC bridge → ZeroMQ JSON → Python agent

### RL Training Path (Message Passing Fallback)
1. Python agent → ZeroMQ JSON → IPC bridge
2. IPC bridge → Worker pool commands
3. Worker pool → Worker thread messages
4. Worker threads → Environment processing
5. Environment → Physics engine stepping
6. Physics engine → State updates
7. Environment → Observation/reward calculation
8. Worker threads → Worker pool messages (results)
9. Worker pool → IPC bridge response
10. IPC bridge → ZeroMQ JSON → Python agent

### Legacy Game Server Path
1. Human client → Socket.IO → Legacy server
2. Legacy server → Game logic processing
3. Legacy server → State updates
4. Legacy server → Socket.IO broadcast
5. Human client ← Socket.IO ← Legacy server

### Administrative Path
1. Admin → Terminal CLI → Legacy server
2. Legacy server → Execute admin command
3. Legacy server → Admin feedback via Terminal CLI

## Conclusion

The manifold-server represents a sophisticated headless RL environment that successfully separates concerns between machine learning training infrastructure and legacy game functionality. Key architectural achievements include:

1. **Performance Optimization**: Synchronous physics, zero-copy IPC, deterministic RNG, and minimal-allocation telemetry
2. **Scalability**: Worker pool that scales with CPU cores, each managing multiple environments
3. **Reliability**: Graceful shutdown, timeout mechanisms, error handling, and fallback systems
4. **Modularity**: Clear separation of concerns enabling independent development and testing
5. **Observability**: Comprehensive telemetry system for performance monitoring and debugging
6. **Compatibility**: Maintenance of legacy systems ensures backward compatibility

The system is designed specifically for RL training workloads where deterministic behavior, high throughput, and detailed performance insights are paramount, while preserving the ability to run the original bonk.io game server for human players.