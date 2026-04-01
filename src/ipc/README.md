# src/ipc/ — Inter-Process Communication

ZeroMQ-based IPC bridge and SharedArrayBuffer zero-copy communication between the TypeScript simulation engine and Python RL clients.

## Files

| File | Purpose |
|------|---------|
| `ipc-bridge.ts` | ZeroMQ ROUTER/DEALER server — handles `init`, `reset`, `step` commands from Python clients |
| `shared-memory.ts` | `SharedMemoryManager` — zero-copy IPC using `SharedArrayBuffer` with atomic signaling |

## IPC Bridge Protocol

The `IpcBridge` listens on a TCP port and processes JSON requests:

| Command | Request Fields | Response |
|---------|---------------|----------|
| `init` | `numEnvs`, `config`, `useSharedMemory` | `{ status: "ok" }` |
| `reset` | `seeds` | `{ status: "ok", data: { observation } }` |
| `step` | `actions` | `{ status: "ok", data: results }` |

## SharedMemoryManager

Zero-copy shared memory layout with ring-buffer action slots:

```typescript
// Memory regions (8-byte aligned)
actions:      Uint8Array    // numEnvs × ringSize action ring buffer
observations: Float32Array  // numEnvs × 14 observation data
rewards:      Float32Array  // numEnvs reward values
dones:        Uint8Array    // numEnvs done flags
truncated:    Uint8Array    // numEnvs truncated flags
ticks:        Uint32Array   // numEnvs tick counters
seeds:        Uint32Array   // numEnvs seed values
control:      Int32Array    // stepCounter, workerReady, mainReady, actionSlotIndex, command, completed
```

### Command Codes

| Code | Action |
|------|--------|
| 0 | Step |
| 1 | Reset |
| 2 | Shutdown |

### Synchronization

Uses `Atomics.wait()` / `Atomics.notify()` for lock-free signaling between main thread and workers. Ring buffer size must be a power of 2 (default: 16).
