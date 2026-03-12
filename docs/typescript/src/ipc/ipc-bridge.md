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
