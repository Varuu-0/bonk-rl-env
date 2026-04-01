# telemetry/

Telemetry subsystem for performance monitoring, profiling, and debug output. Designed with zero-overhead defaults — no cost when telemetry is disabled.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [profiler.md](profiler.md) | `src/telemetry/profiler.ts` | Low-overhead timing instrumentation — `TelemetryIndices` enum for named metrics, `globalProfiler` singleton, `beginTiming()`/`endTiming()` bracket API, per-worker statistics |
| [telemetry-controller.md](telemetry-controller.md) | `src/telemetry/telemetry-controller.ts` | Central telemetry manager — flag-based activation (CLI/env), profile level dispatch, output format routing (console/file/both), dashboard port configuration |
