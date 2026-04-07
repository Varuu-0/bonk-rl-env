## Summary
Step failures in WorkerPool return null observations instead of propagating errors, causing RL training to silently produce NaNs and fail.

## Severity
Major

## Confidence
95

## Files / Locations
- src/core/worker-pool.ts:431-458 (stepSharedMemory)
- src/core/worker-pool.ts:492-504 (stepMessagePassing)

## Root Cause
The WorkerPool catches exceptions during step operations and returns null observations to maintain array length consistency. Most RL frameworks convert null to zero tensors, leading to catastrophic policy degradation without any visible errors.

## Why This Matters
- Training will silently degrade without any indication that environment steps are failing.
- Null observations cause NaN rewards, breaking backpropagation.
- Makes debugging impossible since errors are swallowed.

## Evidence
In `stepSharedMemory`:
```typescript
try {
    shm.consumeResultsSignal();
} catch (e: any) {
    console.warn(`[WorkerPool] reset: worker ${i} failed during consume:`, e.message);
}
...
for (let i = 0; i < this.workers.length; i++) {
    if (finished[i]) continue;
    const shm = this.sharedMemManagers[i]!;
    try {
        shm.consumeResultsSignal();
    } catch (e: any) {
        console.warn(`[WorkerPool] step: worker ${i} failed to read results:`, e.message);
        // Pushes null observations for this worker
        for (let j = 0; j < wEnvs; j++) {
            observations.push(null);
        }
        continue;
    }
    ...
}
```

Similarly, in `stepMessagePassing`, errors are caught and null arrays are returned.

## Reproduction / Conditions
Occurs whenever a worker throws an exception during a step operation (e.g., physics engine crash, uncaught error in environment logic).

## Suggested Fix
Propagate errors to the caller instead of catching them. Remove the try-catch blocks that return null observations. Let the error bubble up to the Python wrapper, which can then raise an exception that RL code can handle appropriately (e.g., reset environment, stop training).

## Related Follow-Up
- Add proper error propagation across worker boundaries (see also issue #64 for reset path)
- Add integration tests for worker crash scenarios during step
- Consider adding a "fail-fast" mode for environment errors