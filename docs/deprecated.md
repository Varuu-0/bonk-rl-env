# Deprecated APIs, Known Issues, and Future Plans

## Deprecated APIs

### Telemetry Configuration Option

**Status**: Deprecated

**Option**: `config.verboseTelemetry`

**Replacement**: Use CLI flags `--telemetry` or `--profile`

**Migration Guide**:

```typescript
// Old (deprecated)
const config = {
  verboseTelemetry: true
};

// New (recommended)
npx tsx src/main.ts --telemetry --profile detailed
```

---

## Known Issues

### Python Client

#### Issue: Import Resolution

**Description**: Some Python IDEs may show import errors for `bonk_env` module.

**Status**: Non-breaking - runtime works correctly

**Workaround**: Add the parent directory to Python path:
```python
import sys
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'envs'))
from bonk_env import BonkVecEnv
```

---

#### Issue: ZMQ Type Checking

**Description**: Type checkers may report errors for `recv_json()` return types.

**Status**: Non-breaking - works at runtime

**Workaround**: These are false positives from type stubs.

---

### SharedArrayBuffer Support

#### Issue: Browser Security Requirements

**Description**: SharedArrayBuffer requires specific HTTP headers.

**Requirements**:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

**Workaround**: Set headers in your HTTP server or disable SharedArrayBuffer mode.

---

#### Issue: Node.js Version

**Description**: SharedArrayBuffer requires Node.js v12+ (v18+ recommended).

**Solution**: Upgrade Node.js or fall back to standard ZMQ communication.

---

### Performance

#### Issue: Scaling Plateau

**Description**: FPS plateaus around 64 environments.

**Status**: Expected - hardware limitation

**Workaround**: Distribute across multiple machines if higher throughput needed.

---

### Map Loading

#### Issue: Invalid Map JSON

**Description**: Malformed map JSON files cause runtime errors.

**Workaround**: Validate JSON before loading:
```bash
python -c "import json; json.load(open('maps/wdb.json'))"
```

---

## Roadmap Implementation Status

This document tracks the implementation status of items listed in the project roadmap.

---

### Phase 1: Quick Wins (1-2 weeks)

| Feature | Status | Notes |
|:--------|:-------|:------|
| Binary protocol (MsgPack/Protocol Buffers) | **Not Implemented** | Still using JSON for ZMQ communication |
| Typed arrays for observations | **Partial** | Observations converted in Python; could use TypedArrays for IPC |
| ZMQ socket optimization | **Partial** | DEALER/ROUTER pattern implemented; further optimization possible |
| Box2D configuration tuning | **Implemented** | Physics constants (TPS, DT, SOLVER_ITERATIONS, etc.) are configurable |

---

### Phase 2: Core Optimization (2-4 weeks)

| Feature | Status | Notes |
|:--------|:-------|:------|
| Worker affinity and NUMA optimization | **Not Implemented** | Static worker pool allocation |
| Adaptive worker pool scaling | **Not Implemented** | Fixed pool size at startup |
| SharedArrayBuffer for zero-copy IPC | **Implemented** | Full implementation in `src/ipc/shared-memory.ts` |
| Worker pool pre-warming | **Not Implemented** | Workers start on first use |
| Performance benchmarks and profiling | **Implemented** | Full telemetry system with profiler (`src/telemetry/profiler.ts`) |

---

### Phase 3: Advanced Features (4-8 weeks)

| Feature | Status | Notes |
|:--------|:-------|:------|
| Multi-agent support | **Partial** | Supports 2-player (1v1); >2 players not implemented |
| Curriculum learning | **Not Implemented** | Would require multi-map support |
| Custom reward function support | **Not Implemented** | Fixed reward function in environment |
| GPU-accelerated batch processing | **Not Implemented** | CPU-only at present |
| Trajectory recording and playback | **Partial** | Recording via `training_logger.py`; playback not implemented |
| Real-time statistics dashboard | **Not Implemented** | Telemetry outputs to console/file; no web UI |

---

### Future Enhancements

| Feature | Status | Notes |
|:--------|:-------|:------|
| Multi-environment map support | **Not Implemented** | Single map loaded at startup |
| Server mode for human play | **Not Implemented** | Headless-only |
| Box2D WASM investigation | **Not Implemented** | JS-based Box2D in use |
| TypeScript 5.x migration | **Not Implemented** | Currently using TypeScript 5.3.3 |

---

### Implementation Summary

| Phase | Completed | Partial | Not Started |
|:------|:----------|:--------|:------------|
| Phase 1 | 1 | 2 | 1 |
| Phase 2 | 2 | 0 | 3 |
| Phase 3 | 0 | 2 | 4 |
| Future | 0 | 0 | 4 |
| **Total** | **3** | **4** | **12** |

---

## Version History

### v1.1.0 (Current)

- Added SharedArrayBuffer support
- Enhanced telemetry system
- Performance optimizations

### v1.0.0

- Initial release
- Basic ZMQ communication
- Worker pool parallelization

---

## Contributing

Contributions are welcome. Please ensure:

1. Tests pass for new features
2. Documentation is updated
3. No breaking changes to public API

---

## Contact

- Author: SneezingCactus
- License: MIT
- Purpose: Research and educational use

---

### See Also

- [Configuration](./configuration.md) - Setup instructions
- [API Reference](./api-reference.md) - Full API documentation
- [Roadmap](./roadmap.md) - Project roadmap
