# src/

TypeScript source module documentation. Each subdirectory corresponds to a subsystem of the Bonk RL Environment engine.

## Subdirectories

| Directory | Description |
|:----------|:------------|
| [core/](core/) | Core engine — physics simulation, environment lifecycle, worker pool, PRNG |
| [ipc/](ipc/) | IPC layer — ZeroMQ bridge and SharedArrayBuffer zero-copy communication |
| [render/](render/) | Rendering — native-coordinate coordinate transforms, map geometry, live sim layer, detached snapshot transport, SVG rasterizer |
| [telemetry/](telemetry/) | Telemetry — profiler instrumentation and centralized telemetry controller |
