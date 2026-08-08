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
`server.maxClientSessions` (default 32) caps the number of concurrent sessions;
a new client `init` beyond the cap is rejected loudly with a clear error
instead of silently evicting an existing session.

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
