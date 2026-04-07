## Summary
WorkerPool does not properly clean up shared memory managers when workers crash, leading to memory leaks.

## Severity
Major

## Confidence
80

## Files / Locations
- src/core/worker-pool.ts:588-604 (close method)

## Root Cause
The `close()` method terminates workers and disposes shared memory managers, but this is only called when the environment is explicitly closed. If a worker crashes during operation, the shared memory manager may not be disposed, leaking memory.

## Why This Matters
- Memory leaks can cause the process to grow over time, eventually crashing.
- Crashes during long training runs could be exacerbated by leaking resources.
- Makes it difficult to run multiple training experiments sequentially.

## Evidence
The `close()` method explicitly disposes shared memory managers:
```typescript
close() {
    for (const worker of this.workers) {
        worker.terminate();
    }
    for (const shm of this.sharedMemManagers) {
        if (shm) {
            shm.dispose();
        }
    }
    // ...
}
```
However, if a worker crashes and the pool is not closed properly, `dispose()` may never be called.

## Reproduction / Conditions
A worker process crashes during a step or reset operation. The main thread continues, but the shared memory manager for that worker is never disposed.

## Suggested Fix
Add worker health monitoring and automatic cleanup of failed workers. When a worker crash is detected (via 'exit' or 'error' events), dispose of its shared memory manager and replace the worker if possible.

## Related Follow-Up
- Add integration test for worker crash recovery
- Implement worker pool auto-healing
- Add memory usage tracking to detect leaks