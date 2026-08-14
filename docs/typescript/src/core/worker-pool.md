# Worker Pool Module

## Overview

The `worker-pool` module manages a pool of worker threads for parallelizing physics simulations. Each worker runs its own PhysicsEngine instance, enabling massive horizontal scaling across CPU cores.

## Module: `src.core.worker_pool`

**Source File**: `src/core/worker-pool.ts`

---

## API Outline

### Interfaces

#### `PlayerInput`

```typescript
interface PlayerInput {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  heavy?: boolean;
  grapple?: boolean;
}
```

#### `SharedObservation`

```typescript
interface SharedObservation {
  playerX: number;
  playerY: number;
  playerVelX: number;
  playerVelY: number;
  playerAngle: number;
  playerAngularVel: number;
  playerIsHeavy: number;
  opponentX: number;
  opponentY: number;
  opponentVelX: number;
  opponentVelY: number;
  opponentIsHeavy: number;
  opponentAlive: number;
  tick: number;
}
```

---

### Class: `WorkerPool`

Manages multiple worker threads for parallel physics simulation.

#### Constructor

```typescript
constructor(numWorkers?: number)
```

**Parameters**:
- `numWorkers`: Number of workers (defaults to min(CPU cores, 8))

#### Methods

##### `init`

```typescript
async init(totalEnvs: number, config?: any, useSharedMemory?: boolean): Promise<void>
```

Initializes the worker pool with the specified number of environments.

**Parameters**:
- `totalEnvs`: Total number of parallel environments
- `config`: Configuration object
- `useSharedMemory`: Whether to use SharedArrayBuffer mode

---

##### `reset`

```typescript
async reset(seeds?: number[], options?: ResultOwnershipOptions): Promise<any[]>
```

Resets all environments with the given seeds.

**Parameters**:
- `seeds`: Array of random seeds for each environment
- `options.ownership`: `owned` (default) or `borrowed`

**Returns**: Array of initial observations. Owned observations remain stable
across later calls.

---

##### `step`

```typescript
async step(actions: number[], options?: ResultOwnershipOptions): Promise<any[]>
```

Executes one step in all environments.

**Parameters**:
- `actions`: Array of actions for each environment
- `options.ownership`: `owned` (default) or `borrowed`

**Returns**: Array of step results (observations, rewards, dones, infos)

Owned results are caller snapshots and may be retained or mutated without
affecting later steps. Borrowed results avoid snapshot allocations but expose
pooled objects: consume them before the next `reset` or `step`, do not retain
or mutate them, and do not overlap calls on the same pool.

`ownership` only affects the shared-memory transport. In message-passing mode
results are structured-cloned by the worker transport and are always
caller-owned, so `borrowed` is a no-op there (accepted for a symmetric API).

---

##### `getTelemetrySnapshots`

```typescript
async getTelemetrySnapshots(): Promise<any[]>
```

Gets telemetry snapshots from all workers.

**Returns**: Array of telemetry data from each worker

---

##### `close`

```typescript
close(): void
```

Closes all workers and releases resources.

---

### Key Features

1. **Worker Thread Isolation**: Each worker runs in a separate thread
2. **Shared Memory Mode**: Optional zero-copy IPC via SharedArrayBuffer
3. **Ring Buffer Protocol**: Efficient data exchange between main thread and workers
4. **Dynamic Load Balancing**: Environments distributed across workers

### Performance Characteristics

- **Scaling**: Near-linear scaling up to CPU core count
- **Latency**: < 1ms per worker step
- **Memory**: ~1MB per worker thread

---

### Usage Example

```typescript
import { WorkerPool } from './worker-pool';

const pool = new WorkerPool(8); // 8 workers

// Initialize
await pool.init(64); // 64 parallel environments

// Reset
const obs = await pool.reset([1, 2, 3, ..., 64]);

// Step
const actions = [0, 1, 2, ..., 63]; // Actions for each env
const results = await pool.step(actions);

// Allocation-sensitive consumers may opt into pooled, short-lived results.
const borrowed = await pool.step(actions, { ownership: 'borrowed' });

// Get telemetry
const telemetry = await pool.getTelemetrySnapshots();

// Cleanup
pool.close();
```

---

### Configuration Options

| Option | Type | Description |
|:-------|:-----|:------------|
| `numWorkers` | `number` | Number of worker threads |
| `maxWorkers` | `number` | Upper bound used when `numWorkers` is auto-detected |
| `useSharedMemory` | `boolean` | Enable SharedArrayBuffer mode |
| `ringBufferSize` | `number` | Power-of-two shared-memory ring size, from 2 through 1048576 |
| `messageTimeoutMs` | `number` | Worker message timeout in milliseconds, minimum 100 |
| `stepTimeoutMs` | `number` | Shared-memory step timeout in milliseconds, minimum 100 |

The loader resolves these values in the order `config.json`, environment
variables (`NUM_WORKERS`, `MAX_WORKERS`, `RING_BUFFER_SIZE`,
`MESSAGE_TIMEOUT_MS`, `STEP_TIMEOUT_MS`), then CLI flags
(`--num-workers`, `--max-workers`, `--ring-buffer-size`,
`--message-timeout-ms`, `--step-timeout-ms`). CLI values take precedence over
environment values, which take precedence over the config file.

---

### See Also

- [Physics Engine](physics-engine.md) - Per-worker physics simulation
- [IPC Bridge](../ipc/ipc-bridge.md) - Python communication
- [Shared Memory](../ipc/shared-memory.md) - Zero-copy IPC
