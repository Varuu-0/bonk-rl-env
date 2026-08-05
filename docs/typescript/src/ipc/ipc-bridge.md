# IPC Bridge Module

## Overview

The `ipc-bridge` module provides ZeroMQ-based inter-process communication between the Node.js physics engine and Python RL agents.

## Module: `src.ipc.ipc_bridge`

**Source File**: `src/ipc/ipc-bridge.ts`

---

## API Outline

### Class: `IpcBridge`

ZeroMQ ROUTER/DEALER bridge for Python communication.

#### Constructor

```typescript
constructor(port?: number)
```

**Parameters**:
- `port`: ZMQ port number (default: 5555)

#### Methods

##### `start`

```typescript
async start(): Promise<void>
```

Starts the IPC bridge and begins listening for requests.

---

### Supported Commands

| Command | Description |
|:--------|:------------|
| `init` | Initialize environments |
| `reset` | Reset environments with seeds |
| `step` | Execute actions in all environments |

### Message Format

#### Init Request
```json
{
  "command": "init",
  "numEnvs": 64,
  "config": {},
  "useSharedMemory": true
}
```

`numEnvs` must be a positive integer. Numeric strings consisting of decimal
digits only (e.g. `"2"`) are coerced; fractional numbers, `0`/negatives,
non-decimal strings, and missing values are rejected with
`Invalid numEnvs: must be a positive integer` (#195). The same validation
applies to `IpcBridge.initEnv`.

#### Reset Request
```json
{
  "command": "reset",
  "seeds": [1, 2, 3, ...]
}
```

#### Step Request
```json
{
  "command": "step",
  "actions": [0, 1, 2, ...]
}
```

### Response Format

```json
{
  "status": "ok",
  "data": {
    "observation": [...],
    "reward": [...],
    "done": [...],
    "info": [...]
  }
}
```

---

### Step Reply and Telemetry Semantics (issues #185, #229, #240)

A completed `step` is serialized and **transmitted before** any best-effort
post-step telemetry runs, and telemetry never holds up the request path:

- The reply of a step that already executed must not be discarded or replaced
  by an error when telemetry fails (`recordMemory()` throwing, a snapshot
  fetch rejecting) — the client would otherwise retry and double-step the
  environments (#185).
- On the every-5000-steps telemetry boundary the reply is sent eagerly, then
  the telemetry block (`recordMemory`, `getTelemetrySnapshots`, the heatmap
  report) runs detached (`void this.runPostStepTelemetry(...)`) and catches
  its own errors, so a slow or hung worker snapshot fetch (up to
  `messageTimeoutMs` in message mode) can never delay this reply or stall the
  single-threaded ZMQ loop (#229).
- Snapshot fetching is non-blocking: in shared-memory mode workers blocked in
  `Atomics.wait` can never service `GET_TELEMETRY`, so the pool returns an
  empty set immediately; in message mode a snapshot timeout still fails the
  pool per worker-pool semantics, surfacing on the next request (#240). The
  telemetry call targets the **requesting session's** pool (issue #193).

---

### Client Session Isolation (issue #193)

The bridge supports multiple concurrent ZMQ clients, each identified by its
DEALER `routingId` (or the identity the ROUTER assigns when none is set). The
worker pool is **owned per client session**:

- The first `init` from a given routing identity creates a private `WorkerPool`
  for that identity; `reset`/`step` requests are routed to the caller's own
  pool and are validated against that pool's environment count.
- A second client's `init` only (re)creates **its own** pool — it never
  touches the first client's environments, so the first client's episode
  (tick counters, seeds, env count) is preserved.
- A session `close` (no `"shutdown": true`) tears down **only the closing
  client's** pool and removes that client's session; every other client keeps
  working.
- `"shutdown": true` or `IpcBridge.close()` is a full server shutdown: every
  session pool, the local/bypass pool, and the router socket are closed, and
  the local session is reset so a later `start()` restarts clean.
- Requests from an identity that **never called `init`** fall back to the
  bridge's local/bypass pool (`initEnv`/`resetEnv`/`stepEnv`); if that pool is
  also uninitialized, `reset`/`step` are rejected loudly with
  `Worker pool not initialized`.
- An identity that **did call `init`** and then closed its session never
  silently falls back to another pool: its subsequent `reset`/`step` fail
  loudly with `Worker pool not initialized` until it calls `init` again.

Resource bounds: a client that disconnects without sending `close` leaves its
session pool running until the next full server shutdown (sessions are only
torn down by an explicit `close` from that identity). To keep this bounded,
`server.maxClientSessions` (default 32, clamped to a minimum of 1, falling
back to the default when unset) caps the number of concurrent sessions; a new
client `init` beyond the cap is rejected loudly with a clear error instead of
silently evicting an existing session. The bridge additionally retains one
small key per distinct identity that ever called `init` so closed/rejected
clients keep failing loudly instead of silently redirecting to another pool;
that retention is released at full server shutdown.

---

### Usage Example

```typescript
import { IpcBridge } from './ipc-bridge';

const bridge = new IpcBridge(5555);

console.log('Starting IPC bridge...');
await bridge.start();
```

---

### ZeroMQ Patterns

- **ROUTER**: Accepts connections from Python clients
- **DEALER**: Routes requests to worker pool

---

### Performance Characteristics

- **Latency**: < 1ms per round-trip
- **Throughput**: Supports 64+ parallel environments

---

### See Also

- [Worker Pool](../core/worker-pool.md) - Handles actual simulation
- [Shared Memory](shared-memory.md) - Optional zero-copy IPC
- [BonkVecEnv (Python)](../../python/envs/bonk_env.md) - Python client
