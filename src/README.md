# src/ — Source Code

TypeScript source code for the Bonk.io RL Environment — a high-performance headless simulation engine for reinforcement learning.

## Architecture Overview

The source tree is organized into focused modules:

| Directory | Purpose |
|-----------|---------|
| [`core/`](core/) | Core simulation engine — physics, environment, PRNG, worker pool |
| [`env/`](env/) | Gymnasium-compatible environment wrappers and manager |
| [`ipc/`](ipc/) | ZeroMQ ROUTER/DEALER IPC bridge and SharedArrayBuffer zero-copy |
| [`telemetry/`](telemetry/) | Flag-based telemetry activation, profiling, and reporting |
| [`legacy/`](legacy/) | Original multiplayer server code (reference only, not used) |
| [`utils/`](utils/) | Shared utilities (port allocation) |
| [`visualization/`](visualization/) | Canvas-based browser rendering via Socket.IO |
| [`types/`](types/) | Global TypeScript type definitions |

## Entry Points

| File | Purpose |
|------|---------|
| `main.ts` | CLI entry point — parses args, starts server, handles SIGINT/SIGTERM |
| `server.ts` | Server lifecycle — `startServer(port)` / `stopServer()` |

## Key Architecture

- **Worker Pool** — Spawns child processes for parallel environment execution (`core/worker-pool.ts`)
- **Deterministic PRNG** — Mulberry32-based seedable RNG for reproducible simulations (`core/prng.ts`)
- **ZeroMQ IPC** — ROUTER/DEALER pattern for Python↔TypeScript communication (`ipc/ipc-bridge.ts`)
- **SharedArrayBuffer** — Optional zero-copy IPC with atomic signaling (`ipc/shared-memory.ts`)
- **30 TPS Physics** — Box2DFlash v2.0 port, each tick = 1/30s (`core/physics-engine.ts`)
