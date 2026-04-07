## Summary
Control variables in SharedArrayBuffer are placed close together, potentially causing false sharing on cache line bouncing.

## Severity
Minor

## Confidence
70

## Files / Locations
- src/ipc/shared-memory.ts:87-94

## Root Cause
The control structure packs multiple 4-byte integers (stepCounter, workerReady, mainReady, actionSlotIndex, command, completed) within 24 bytes. On systems with 64-byte cache lines, these variables may frequently reside on the same cache line, causing performance degradation due to false sharing when both threads access different variables simultaneously.

## Why This Matters
- Could reduce the performance benefits of shared memory mode.
- May cause unnecessary cache coherence traffic.
- Impacts scalability when many environments are used.

## Evidence
```typescript
this.control = {
    stepCounter: new Int32Array(this.buffer, offset, 1),
    workerReady: new Int32Array(this.buffer, offset + 4, 1),
    mainReady: new Int32Array(this.buffer, offset + 8, 1),
    actionSlotIndex: new Int32Array(this.buffer, offset + 12, 1),
    command: new Int32Array(this.buffer, offset + 16, 1),
    completed: new Int32Array(this.buffer, offset + 20, 1)
};
```
All within 24 bytes.

## Reproduction / Conditions
High-frequency step operations with many environments may expose this issue on architectures with smaller cache lines.

## Suggested Fix
Pad control variables to separate cache lines. For example, align each variable to 64 bytes using padding or separate buffers.

## Related Follow-Up
- Benchmark to measure impact of false sharing
- Consider separating control variables into dedicated buffers
- Profile with perf or similar tools to confirm false sharing