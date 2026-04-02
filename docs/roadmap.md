# Project Roadmap

This document outlines the planned improvements for the Bonk.io RL Environment, organized by priority and implementation phase.

> **Recommendation**: See [Priority Recommendation](./priority-recommendation.md) for detailed analysis of which features to implement next.

## Implementation Status Legend

| Status | Description |
|:-------|:------------|
| ✅ Implemented | Complete and functional |
| ⚠️ Partial | Partially implemented |
| ❌ Not Started | Not yet implemented |
| 🔥 Proposal | Proposed for consideration |
| 🔄 Reverted | Tested and reverted (not beneficial) |

---

## Performance Analysis (Updated March 2026)

### Benchmark Results (SOLVER_ITERATIONS = 5)

| Component | Time per tick | % of total | Description |
|:----------|:-------------|:-----------|:------------|
| Physics step | ~1.13 μs | ~8% | Box2D collision + gravity |
| Input processing | ~5 μs | ~34% | Convert inputs to forces |
| Observation extraction | ~8 μs | ~54% | Read physics state to arrays |
| Other overhead | ~1 μs | ~4% | Frame skip, rewards, bookkeeping |
| **Total** | **~14.8 μs** | **100%** | |
| **TPS (single env)** | **~67,000** | | |

### Key Findings

- **JSON vs MsgPack**: Binary protocol NOT beneficial (slower encode/decode in JS, IPC <1% of time)
- **SOLVER_ITERATIONS**: Changed from 10 → 5 for ~2x physics speedup
- **Main bottleneck**: Observation extraction (54% of step time)

---

## Phase 1: Quick Wins (1-2 weeks)

These are high-impact, low-engineering-effort improvements.

| Feature | Status | Priority | Impact | Description |
|:--------|:-------|:---------|:-------|:------------|
| SOLVER_ITERATIONS=5 | ✅ Done | High | ~2x physics | Reduced solver iterations for faster simulation |
| Binary protocol for ZMQ | 🔄 Reverted | N/A | None | Tested MsgPack - slower than JSON in JS, IPC not bottleneck |
| Action Frame Skip | ✅ Done | High | Reduces jitter | Agent holds action for N ticks |
| Typed arrays for observations | ✅ Done | High | ~30% faster obs | Float32Array via getObservationFast() in shared memory mode |
| Force vector reuse | ✅ Done | Medium | ~25% faster input | Pre-allocated _tempForce in PhysicsEngine.applyInput() |
| Player state caching | ✅ Done | Medium | ~15% faster step | Direct physics state read in getObservationFast() |

### Observation Extraction Optimization (IMPLEMENTED)

**Status**: ✅ Implemented in `src/core/environment.ts:459-490`

The `getObservationFast()` method uses a pre-allocated `Float32Array(14)` to extract observations directly from physics state, skipping intermediate object creation. This is used in the shared memory code path (`worker.ts:65-67`, `worker.ts:186,261`).

```typescript
private _obsBuffer: Float32Array = new Float32Array(14);

getObservationFast(): Float32Array {
  const aiState = this.physics.getPlayerState(this.aiPlayerId);
  this._obsBuffer[0] = aiState.x;
  this._obsBuffer[1] = aiState.y;
  // ... direct array writes
  return this._obsBuffer;
}
```

### Force Vector Reuse (IMPLEMENTED)

**Status**: ✅ Implemented in `src/core/physics-engine.ts:205`

The `_tempForce` field is a pre-allocated `b2Vec2` reused across all `applyInput()` calls.

```typescript
private _tempForce = new b2Vec2(0, 0);

applyInput(playerId: number, input: PlayerInput): void {
  const force = this._tempForce;
  force.x = 0;
  force.y = 0;
  // ... reuse force vector
  body.ApplyForce(force, pos);
}
```

---

## Phase 2: Core Optimization (2-4 weeks)

| Feature | Status | Priority | Impact | Description |
|:--------|:-------|:---------|:-------|:------------|
| Worker affinity and NUMA optimization | ❌ | Low | 5-10% | Bind workers to specific CPU cores |
| Adaptive worker pool scaling | ❌ | Medium | Variable | Dynamically adjust worker count |
| SharedArrayBuffer for zero-copy IPC | ✅ Done | High | ~50% IPC | Zero-copy IPC between threads |
| Worker pool pre-warming | ❌ | Medium | Reduces latency | Pre-spawn workers before first use |
| Performance benchmarks and profiling | ✅ Done | High | Observability | Full telemetry system |

### SharedArrayBuffer Details

✅ Fully implemented with:
- Ring buffer protocol with Atomics API
- Zero-copy IPC between main thread and workers
- Lock-free synchronization

### Performance Benchmarks

✅ Implemented with:
- Physics tick timing
- Collision detection metrics
- Worker telemetry
- Memory usage tracking

---

## Phase 3: Advanced Features (4-8 weeks)

| Feature | Status | Priority | Impact | Description |
|:--------|:-------|:---------|:-------|:------------|
| Multi-agent support | ⚠️ Partial | Medium | >2 players | Support 3+ players in match |
| Curriculum learning | ❌ | Medium | Progressive | Difficulty based on performance |
| Custom reward function support | ✅ Done | High | Flexible | Custom rewards in python/reward/ |
| GPU-accelerated batch processing | ❌ | Low | Major | Offload computation to GPU |
| Trajectory recording and playback | ⚠️ Partial | Medium | Debugging | Record/replay agent behavior |
| Real-time statistics dashboard | ❌ | Low | Monitoring | Web-based monitoring UI |

### Custom Reward Functions (Implemented)

✅ Fully implemented in `python/reward/reward_functions.py`:
- `NavigationReward` - Goal-based with potential shaping
- `CuriosityReward` - Intrinsic motivation
- `CountBasedExplorationReward` - Discrete state exploration
- `CompositeReward` - Weighted combination
- `ConstraintPenaltyReward` - Prevent reward hacking
- `RewardValidator` - Validate reward stability

---

## Phase 4: Major Optimizations (Future)

| Feature | Status | Priority | Impact | Description |
|:--------|:-------|:---------|:-------|:------------|
| Batch tick in worker | ❌ | High | ~2x TPS | Run multiple ticks before IPC |
| Observation array pooling | ✅ Done | Medium | Memory | Pre-allocated _obsPool in WorkerPool |
| JIT compilation hints | ❌ | Low | 5-10% | Optimize hot paths for V8 |
| WebAssembly physics | ❌ | Research | Major | Alternative to Box2D JS |

### Batch Tick Optimization

**Current**: Each tick returns observation immediately

```typescript
// Worker does 1 tick, sends result
for (const action of actions) {
  env.step(action);  // 1 tick → IPC → 1 tick → IPC
}
```

**Optimized**: Batch multiple ticks before IPC

```typescript
// Worker does N ticks, sends batch result
const results = [];
for (let i = 0; i < batchSize; i++) {
  results.push(env.step(actions[i]));
}
sendBatch(results);  // N ticks → 1 IPC
```

**Expected gain**: ~50-70% reduction in IPC overhead

---

## Implementation Progress

### Summary by Phase

```
Phase 1: ████████████████ 83% complete (5/6 fully, 0/6 partial, 1 reverted)
Phase 2: ███████░░░░ 60% complete (3/5 fully, 0/5 partial)  
Phase 3: ████████░░ 30% complete (1/6 fully, 2/6 partial)
Phase 4: ███░░░░░░░ 25% complete (1/4 fully, 0/4 partial)
```

### Performance Optimization Progress

```
Current TPS (single env): ~67,000 (PERFORMANCE.md) / ~40,000 (quick-2000-step benchmark)
After optimizations:     ~100,000-150,000 (projected)

Optimization Stack:
  ✅ SOLVER_ITERATIONS=5         → +100% physics speed
  ✅ Observation Float32Array    → +30% observation speed  
  ✅ Force vector reuse          → +25% input speed
  ✅ State caching               → +15% step speed (via getObservationFast)
  ❌ Batch ticks                 → +50% IPC reduction
```

### Overall Progress

- **Total Features**: 24
- **Fully Implemented**: 10 (42%)
- **Partially Implemented**: 4 (17%)
- **Not Started**: 9 (37%)
- **Reverted**: 1 (4%)

---

## Recommended Implementation Order

### This Sprint (Immediate)

All Phase 1 "this sprint" items are complete. Focus shifts to Phase 4.

1. **Batch ticks in worker** (Priority: HIGH)
   - Effort: ~4 hours
   - Impact: ~50-70% IPC reduction
   - Files: `src/core/worker.ts`, `src/core/worker-pool.ts`
   - Status: Not started — the highest-impact remaining optimization

### Next Sprint (1-2 weeks)

2. **Worker affinity and NUMA optimization** (Priority: LOW)
   - Effort: ~3 hours
   - Impact: 5-10%
   - Files: `src/core/worker-pool.ts`

3. **Adaptive worker pool scaling** (Priority: MEDIUM)
   - Effort: ~4 hours
   - Impact: Variable
   - Files: `src/core/worker-pool.ts`
