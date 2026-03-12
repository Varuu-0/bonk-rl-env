# Telemetry Controller Module

## Overview

The `telemetry-controller` module provides centralized telemetry management with zero-overhead defaults.

## Module: `src.telemetry.telemetry_controller`

**Source File**: `src/telemetry/telemetry-controller.ts`

---

## API Outline

### Class: `TelemetryController`

Central controller for all telemetry operations.

#### Constructor

```typescript
constructor()
```

#### Static Methods

##### `isEnabled`

```typescript
static isEnabled(): boolean
```

Checks if any telemetry is enabled.

**Returns**: true if telemetry is active

---

##### `start`

```typescript
static start(): void
```

Starts the telemetry system.

---

##### `stop`

```typescript
static stop(): void
```

Stops the telemetry system.

---

##### `record`

```typescript
static record(metric: string, value: number): void
```

Records a metric value.

**Parameters**:
- `metric`: Metric name
- `value`: Metric value

---

### Configuration

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `enabled` | `boolean` | `false` | Master enable switch |
| `profile` | `string` | `"standard"` | Profile level |
| `output` | `string` | `"console"` | Output format |
| `dashboardPort` | `number` | `3001` | HTTP dashboard port |
| `reportInterval` | `number` | `5000` | Report interval (ms) |

---

### Profile Levels

| Level | Overhead | Description |
|:------|:---------|:------------|
| `minimal` | <1% | Basic timing only |
| `standard` | 2-5% | Per-worker stats |
| `detailed` | 5-15% | Full debug info |

---

### Usage Example

```typescript
import { TelemetryController } from './telemetry-controller';

// Check if telemetry is enabled
if (TelemetryController.isEnabled()) {
  TelemetryController.record('custom_metric', 42);
}
```

---

### See Also

- [Flags](flags.md) - CLI flag configuration
- [Profiler](profiler.md) - Performance profiling
