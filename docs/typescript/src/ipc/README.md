# ipc/

Inter-process communication layer. Handles data exchange between the Node.js physics engine, worker threads, and the Python RL client.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [ipc-bridge.md](ipc-bridge.md) | `src/ipc/ipc-bridge.ts` | ZeroMQ ROUTER/DEALER bridge — receives action batches from Python, dispatches to WorkerPool, returns observations/rewards/dones as JSON |
| [shared-memory.md](shared-memory.md) | `src/ipc/shared-memory.ts` | SharedArrayBuffer manager — zero-copy action/observation transfer between main thread and workers using `Atomics.wait`/`Atomics.notify`, ring buffer action pipelining |
