# Shared Memory Module

## Overview

The `shared-memory` module provides zero-copy inter-process communication using SharedArrayBuffer and Atomics API for high-performance data exchange between the main thread and worker threads.

## Module: `src.ipc.shared_memory`

**Source File**: `src/ipc/shared-shared-memory.ts`

---

## API Outline

### Class: `SharedMemoryManager`

Manages SharedArrayBuffer for zero-copy IPC.

#### Constructor

```typescript
constructor(bufferSize: number)
```

**Parameters**:
- `bufferSize`: Size of the shared buffer in bytes

#### Static Methods

##### `isSupported`

```typescript
static isSupported(): boolean
```

Checks if SharedArrayBuffer is available.

**Returns**: true if supported, false otherwise

---

#### Methods

##### `write`

```typescript
write(offset: number, data: Uint8Array): void
```

Writes data to the shared buffer.

**Parameters**:
- `offset`: Buffer offset
- `data`: Data to write

---

##### `read`

```typescript
read(offset: number, length: number): Uint8Array
```

Reads data from the shared buffer.

**Parameters**:
- `offset`: Buffer offset
- `length`: Number of bytes to read

**Returns**: Data from buffer

---

##### `notify`

```typescript
notify(index: number, count: number): void
```

Notifies waiting threads of new data.

**Parameters**:
- `index`: Index to notify
- `count`: Number of waiters to notify

---

##### `wait`

```typescript
wait(index: number, expected: number): number
```

Waits for notification.

**Parameters**:
- `index`: Index to wait on
- `expected`: Expected value

**Returns**: Result of wait

---

### Ring Buffer Protocol

The shared memory uses a ring buffer for efficient data exchange:

```
┌─────────────────────────────────────────────────────────┐
│                     SharedArrayBuffer                    │
├─────────────┬─────────────┬─────────────┬──────────────┤
│  Control    │  Slot 0     │  Slot 1     │  ...         │
│  (metadata) │  (env data) │  (env data) │              │
└─────────────┴─────────────┴─────────────┴──────────────┘
```

### Memory Layout

| Offset | Size | Description |
|:-------|:-----|:------------|
| 0 | 8 bytes | Write pointer |
| 8 | 8 bytes | Read pointer |
| 16 | N bytes | Data slots |

---

### Requirements

- **Browser Security**: SharedArrayBuffer requires cross-origin isolation headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **Node.js**: v12+ (v18+ recommended)
- **Platform**: Windows, macOS, Linux

---

### Enabling Shared Memory

```typescript
// In BonkVecEnv (Python)
env = BonkVecEnv(num_envs=32, useSharedMemory=True)

// Or via IPC init command
{
  "command": "init",
  "numEnvs": 32,
  "useSharedMemory": true
}
```

---

### Benefits

| Benefit | Description |
|:--------|:------------|
| Zero-copy | No serialization/deserialization overhead |
| Low latency | Direct memory access |
| Cache-friendly | Shared memory is more cache-coherent |
| High throughput | Eliminates message passing bottleneck |

---

### Fallback Behavior

If SharedArrayBuffer is not available, the system automatically falls back to standard `postMessage` communication.

---

### Performance Comparison

| Mode | Latency | Throughput |
|:-----|:--------|:-----------|
| ZMQ (default) | ~1ms | 20,000+ FPS |
| SharedMemory | <0.1ms | 23,000+ FPS |

---

### Usage Example

```typescript
import { SharedMemoryManager } from './shared-memory';

// Check support
if (SharedMemoryManager.isSupported()) {
  const manager = new SharedMemoryManager(1024 * 1024); // 1MB
  
  // Write data
  const data = new Uint8Array([1, 2, 3, 4]);
  manager.write(16, data);
  
  // Notify worker
  manager.notify(0, 1);
}
```

---

### Troubleshooting

#### Error: SharedArrayBuffer is not defined

**Cause**: Browser security headers not set or Node.js version too old

**Solution**:
- Set COOP/COEP headers
- Use Node.js v18+

#### Error: Cannot read property 'Atomics' of undefined

**Cause**: JavaScript runtime doesn't support Atomics

**Solution**: Fall back to standard message passing

---

### See Also

- [IPC Bridge](ipc-bridge.md) - ZMQ-based communication
- [Worker Pool](../core/worker-pool.md) - Uses shared memory
- [BonkVecEnv (Python)](../../python/envs/bonk_env.md) - Python client
