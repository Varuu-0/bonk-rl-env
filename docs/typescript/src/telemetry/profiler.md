# Profiler Module

## Overview

The `profiler` module provides performance profiling utilities with low-overhead instrumentation for the Manifold Server.

## Module: `src.telemetry.profiler`

**Source File**: `src/telemetry/profiler.ts`

---

## API Outline

### Telemetry Indices

```typescript
enum TelemetryIndices {
  PHYSICS_TICK = 0,
  RAYCAST_CALL = 1,
  COLLISION_RESOLVE = 2,
  JSON_PARSE = 3,
  ZMQ_SEND = 4,
  // ... more indices
}
```

### Global Profiler

The `globalProfiler` singleton provides profiling capabilities.

#### Methods

##### `start`

```typescript
start(name: string): void
```

Starts timing a named operation.

**Parameters**:
- `name`: Operation name

---

##### `end`

```typescript
end(name: string): void
```

Ends timing a named operation.

**Parameters**:
- `name`: Operation name

---

##### `increment`

```typescript
increment(counter: string): void
```

Increments a counter.

**Parameters**:
- `counter`: Counter name

---

##### `gauge`

```typescript
gauge(name: string, value: number): void
```

Sets a gauge value.

**Parameters**:
- `name`: Gauge name
- `value`: Gauge value

---

##### `tick`

```typescript
tick(): void
```

Called each physics tick to update timing statistics.

---

##### `report`

```typescript
report(interval: number): void
```

Reports statistics at the specified interval.

**Parameters**:
- `interval`: Report interval in ticks

---

##### `recordMemory`

```typescript
recordMemory(): void
```

Records current memory usage.

---

### Wrapper Function

```typescript
wrap(index: number, fn: Function): Function
```

Wraps a function for profiling.

**Parameters**:
- `index`: Telemetry index
- `fn`: Function to wrap

**Returns**: Wrapped function

---

### Default Metrics

| Metric | Type | Description |
|:-------|:-----|:------------|
| `PHYSICS_TICK` | timing | Physics simulation time |
| `RAYCAST_CALL` | timing | Grapple raycast time |
| `COLLISION_RESOLVE` | timing | Collision detection time |
| `JSON_PARSE` | timing | JSON parsing time |
| `ZMQ_SEND` | timing | ZeroMQ send time |
| `collision_events` | counter | Collision events |
| `collision_lethal` | counter | Lethal collisions |
| `death_out_of_bounds` | counter | Out of bounds deaths |
| `grapple_fire` | counter | Grapple fires |
| `active_joints` | gauge | Active grapple joints |

---

### Usage Example

```typescript
import { globalProfiler, wrap, TelemetryIndices } from './profiler';

// Manual timing
globalProfiler.start('my_operation');
// ... do work ...
globalProfiler.end('my_operation');

// Counter
globalProfiler.increment('custom_counter');

// Gauge
globalProfiler.gauge('queue_size', 10);

// Wrap a function
const wrappedFn = wrap(TelemetryIndices.JSON_PARSE, JSON.parse);
const data = wrappedFn(jsonString);
```

---

### Integration with Physics Engine

The physics engine wraps hot paths for profiling:

```typescript
// Automatically wraps tick(), fireGrapple(), etc.
physicsProto.tick = wrap(TelemetryIndices.PHYSICS_TICK, physicsProto.tick);
physicsProto.fireGrapple = wrap(TelemetryIndices.RAYCAST_CALL, physicsProto.fireGrapple);
```

---

### Zero-Overhead Default

When telemetry is disabled:
- No profiler objects allocated
- No timing hooks installed
- Original functions run unmodified

This ensures maximum performance in production.

---

### Performance Characteristics

| Profile Level | Overhead |
|:--------------|:---------|
| Disabled | 0% |
| Minimal | <1% |
| Standard | 2-5% |
| Detailed | 5-15% |

---

### Output Reports

The profiler generates reports including:

- **Mean/Max/Min** timing for each operation
- **Counter** values
- **Gauge** readings
- **Memory** usage
- **Worker** telemetry (when available)

---

### See Also

- [Telemetry Controller](telemetry-controller.md) - Telemetry management
- [Flags](flags.md) - CLI flag configuration
- [Physics Engine](../core/physics-engine.md) - Profiling integration
