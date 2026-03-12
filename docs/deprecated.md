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

## Future Plans

### Phase 1: Quick Wins (1-2 weeks)

| Feature | Description | Priority |
|:--------|:------------|:---------|
| Binary protocol | MsgPack/Protocol Buffers for ZMQ | High |
| Typed arrays | Use TypedArrays for observations | High |
| ZMQ optimization | Socket tuning | Medium |
| Box2D tuning | Physics parameter optimization | Medium |

---

### Phase 2: Core Optimization (2-4 weeks)

| Feature | Description | Priority |
|:--------|:------------|:---------|
| Worker affinity | NUMA optimization | High |
| Adaptive scaling | Dynamic worker pool | High |
| Pre-warming | Worker warmup | Medium |
| Performance benchmarks | Comprehensive profiling | Medium |

---

### Phase 3: Advanced Features (4-8 weeks)

| Feature | Description | Priority |
|:--------|:------------|:---------|
| Multi-agent support | >2 players | High |
| Curriculum learning | Progressive difficulty | Medium |
| Custom rewards | User-defined reward functions | Medium |
| GPU acceleration | Batch processing on GPU | Low |
| Trajectory recording | Save/replay | Medium |
| Real-time dashboard | Web-based monitoring | Medium |

---

### Future Enhancements

| Feature | Description | Priority |
|:--------|:------------|:---------|
| Multi-map support | Multiple arena types | Low |
| Server mode | Human play support | Low |
| Box2D WASM | WebAssembly physics | Low |
| TypeScript 5.x | Language upgrade | Low |

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
