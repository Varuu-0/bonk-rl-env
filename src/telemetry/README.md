# Telemetry System (`src/telemetry/`)

Flag-based telemetry activation, high-precision performance profiling, and runtime reporting for the Bonk.io RL environment.

## Files

| File | Purpose |
|------|---------|
| `flags.ts` | CLI flag parser — `--telemetry`, `--profile`, `--debug`, `--output`, `--dashboard-port`, `--report-interval`, `--retention` |
| `profiler.ts` | High-precision profiler — `BigUint64Array` accumulator, `wrap()` decorator, heatmap reporting |
| `telemetry-controller.ts` | Singleton controller — coordinates flags, config, and profiler lifecycle |

## CLI Flags

| Flag | Alias | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--telemetry` | `-t` | boolean | `false` | Master switch to enable telemetry |
| `--profile` | `-p` | value | `standard` | Profile level: `minimal`, `standard`, `detailed` |
| `--debug` | `-d` | value | `none` | Debug level: `none`, `error`, `verbose` |
| `--output` | `-o` | value | `console` | Output format: `console`, `file`, `both` |
| `--dashboard-port` | — | number | `3001` | Telemetry dashboard port |
| `--report-interval` | — | number | `5000` | Ticks between telemetry reports |
| `--retention` | — | number | `7` | Days to retain telemetry data |

## Environment Variable Overrides

| Variable | Overrides |
|----------|-----------|
| `MANIFOLD_TELEMETRY` | `enableTelemetry` |
| `MANIFOLD_TELEMETRY_OUTPUT` | `outputFormat` |
| `MANIFOLD_PROFILE` | `profileLevel` |
| `MANIFOLD_DEBUG` | `debugLevel` |

## Performance Overhead

| Mode | Overhead | Description |
|------|----------|-------------|
| Disabled | 0% | No telemetry code executes |
| Minimal | <1% | Basic timing only |
| Standard | 2-5% | Per-worker stats included |
| Detailed | 5-10% | Full debug info including memory |

## Profiler API

```typescript
// Global accumulator (zero-allocation hot path)
const TelemetryBuffer = new BigUint64Array(5);

// Telemetry indices
TelemetryIndices = {
  PHYSICS_TICK: 0,
  RAYCAST_CALL: 1,
  COLLISION_RESOLVE: 2,
  ZMQ_SEND: 3,
  JSON_PARSE: 4,
};

// Wrap any function for automatic timing
const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, physicsEngine.tick);

// Global profiler instance
globalProfiler.tick();
globalProfiler.increment('collision_events');
globalProfiler.gauge('Memory (RSS MB)', mem.rss / 1024 / 1024);
globalProfiler.report(5000);  // Heatmap report every 5000 ticks
```

## TelemetryController

Singleton pattern with lazy initialization:

```typescript
TelemetryController.isEnabled();     // Fast-path check for hot loops
TelemetryController.getInstance();   // Get singleton
isTelemetryEnabled();                // Convenience function
```
