# Project Roadmap

This document outlines the planned improvements for the Manifold Server project, organized by priority and implementation phase.

> **Recommendation**: See [Priority Recommendation](./priority-recommendation.md) for detailed analysis of which features to implement next.

## Implementation Status Legend

| Status | Description |
|:-------|:------------|
| ✅ Implemented | Complete and functional |
| ⚠️ Partial | Partially implemented |
| ❌ Not Started | Not yet implemented |

---

## Phase 1: Quick Wins (1-2 weeks)

These are high-impact, low-effort improvements that can be completed quickly.

| Feature | Status | Description |
|:--------|:-------|:------------|
| Binary protocol for ZMQ | ❌ | Replace JSON with MsgPack/Protocol Buffers for faster serialization |
| Typed arrays for observations | ⚠️ | Use TypedArrays for observations (partial implementation in Python) |
| ZMQ socket optimization | ⚠️ | Socket tuning - DEALER/ROUTER pattern implemented |
| Box2D configuration tuning | ✅ | Physics constants are configurable in `physics-engine.ts` |

### Details

- **Binary Protocol**: Currently using JSON for all ZMQ messages. Switching to binary format could reduce message size by 50%+ and improve serialization speed.
- **Typed Arrays**: Observations are already numpy arrays in Python, but could use TypedArrays for IPC to avoid conversion.
- **ZMQ Optimization**: Current implementation uses DEALER/ROUTER pattern which is efficient but could benefit from socket tuning.
- **Box2D Tuning**: Constants like `TPS`, `DT`, `SOLVER_ITERATIONS`, `GRAVITY`, etc. are exported and configurable.

---

## Phase 2: Core Optimization (2-4 weeks)

These are performance-critical features that require more significant engineering effort.

| Feature | Status | Description |
|:--------|:-------|:------------|
| Worker affinity and NUMA optimization | ❌ | Bind workers to specific CPU cores for better cache locality |
| Adaptive worker pool scaling | ❌ | Dynamically adjust worker count based on load |
| SharedArrayBuffer for zero-copy IPC | ✅ | Implemented in `src/ipc/shared-memory.ts` |
| Worker pool pre-warming | ❌ | Pre-spawn workers before first use |
| Performance benchmarks and profiling | ✅ | Full telemetry system in `src/telemetry/profiler.ts` |

### Details

- **SharedArrayBuffer**: ✅ Fully implemented with ring buffer protocol and Atomics API. Provides zero-copy IPC between main thread and workers.
- **Performance Benchmarks**: ✅ Implemented with comprehensive telemetry including:
  - Physics tick timing
  - Collision detection metrics
  - Worker telemetry
  - Memory usage tracking

---

## Phase 3: Advanced Features (4-8 weeks)

These are feature-rich enhancements for more advanced RL scenarios.

| Feature | Status | Description |
|:--------|:-------|:------------|
| Multi-agent support | ⚠️ | Support for >2 players in the same match |
| Curriculum learning | ❌ | Progressive difficulty based on agent performance |
| Custom reward function support | ❌ | Allow users to define custom reward functions |
| GPU-accelerated batch processing | ❌ | Offload computation to GPU |
| Trajectory recording and playback | ⚠️ | Record and replay agent behavior |
| Real-time statistics dashboard | ❌ | Web-based monitoring UI |

### Details

- **Multi-agent Support**: ⚠️ Currently supports 2 players (1v1). Extending to >2 requires changes to observation space and action handling.
- **Trajectory Recording**: ⚠️ Recording implemented in `python/utils/training_logger.py`. Playback not implemented.

---

## Future Enhancements

Long-term goals for the project.

| Feature | Status | Description |
|:--------|:-------|:------------|
| Multi-environment map support | ❌ | Support multiple arena types |
| Server mode for human play | ❌ | Allow humans to play against AI |
| Box2D WASM investigation | ❌ | Investigate WebAssembly physics engine |
| TypeScript 5.x migration | ❌ | Upgrade to latest TypeScript |

---

## Implementation Progress

### Summary by Phase

```
Phase 1: ████████░░ 25% complete (1/4 fully, 2/4 partial)
Phase 2: █████░░░░░ 40% complete (2/5 fully, 0/5 partial)  
Phase 3: ░░░░░░░░░░  0% complete (0/6 fully, 2/6 partial)
Future:  ░░░░░░░░░░  0% complete (0/4 fully, 0/4 partial)
```

### Overall Progress

- **Total Features**: 19
- **Fully Implemented**: 3 (16%)
- **Partially Implemented**: 4 (21%)
- **Not Started**: 12 (63%)

---

## Contributing

To contribute to the roadmap:

1. Open an issue to propose a new feature
2. Discuss priority and implementation approach
3. Submit a pull request

---

## See Also

- [Deprecated APIs](./deprecated.md) - Known issues and deprecated features
- [Configuration](./configuration.md) - Setup and configuration
- [Telemetry](./telemetry.md) - Performance monitoring
