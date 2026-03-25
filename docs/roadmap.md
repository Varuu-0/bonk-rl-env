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
| Typed arrays for observations | ❌ TODO | High | ~30% faster obs | Use Float32Array instead of object creation |
| Force vector reuse | ❌ TODO | Medium | ~25% faster input | Pre-allocate b2Vec2 instead of creating each call |
| Player state caching | ❌ TODO | Medium | ~15% faster step | Cache states to avoid redundant Box2D calls |

### Observation Extraction Optimization (NEXT)

**Current bottleneck**: 54% of step time

```typescript
// Current: Creates new object each time
private getObservation(): Observation {
  const aiState = this.physics.getPlayerState(this.aiPlayerId);
  return { playerX: aiState.x, playerY: aiState.y, ... };
}
```

**Optimized**: Pre-allocated Float32Array

```typescript
private obsBuffer: Float32Array = new Float32Array(14);

getObservationFast(): Float32Array {
  const body = this.playerBodies.get(this.aiPlayerId);
  const pos = body.GetPosition();
  this.obsBuffer[0] = pos.x * SCALE;
  this.obsBuffer[1] = pos.y * SCALE;
  return this.obsBuffer;
}
```

**Expected gain**: ~30-40% faster observation extraction

### Force Vector Reuse (NEXT)

**Current**: Allocates new b2Vec2 every call

```typescript
applyInput(playerId: number, input: PlayerInput): void {
  const force = new b2Vec2(0, 0);  // Allocation!
  body.ApplyForce(force, pos);
}
```

**Optimized**: Pre-allocated vector

```typescript
private forceBuffer: any = new b2Vec2(0, 0);

applyInput(playerId: number, input: PlayerInput): void {
  this.forceBuffer.Set(0, 0);  // Reset instead of allocate
  body.ApplyForce(this.forceBuffer, pos);
}
```

**Expected gain**: ~20-30% faster input processing

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
| Observation array pooling | ❌ | Medium | Memory | Reuse observation arrays |
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
Phase 1: ██████████░░ 60% complete (3/5 fully, 2/5 partial, 1 reverted)
Phase 2: █████░░░░░ 40% complete (2/5 fully, 0/5 partial)  
Phase 3: ████████░░ 30% complete (1/6 fully, 2/6 partial)
Phase 4: ░░░░░░░░░░  0% complete (0/4 fully, 0/4 partial)
```

### Performance Optimization Progress

```
Current TPS (single env): ~67,000
After optimizations:     ~100,000-150,000 (projected)

Optimization Stack:
  ✅ SOLVER_ITERATIONS=5         → +100% physics speed
  ❌ Observation Float32Array    → +30% observation speed  
  ❌ Force vector reuse          → +25% input speed
  ❌ State caching               → +15% step speed
  ❌ Batch ticks                 → +50% IPC reduction
```

### Overall Progress

- **Total Features**: 24
- **Fully Implemented**: 6 (25%)
- **Partially Implemented**: 4 (17%)
- **Not Started**: 13 (54%)
- **Reverted**: 1 (4%)

---

## Recommended Implementation Order

### This Sprint (Immediate)

1. **Observation Float32Array** (Priority: HIGH)
   - Effort: ~2 hours
   - Impact: ~30% faster observation extraction
   - Files: `src/core/environment.ts`

2. **Force vector reuse** (Priority: MEDIUM)
   - Effort: ~1 hour
   - Impact: ~25% faster input processing
   - Files: `src/core/physics-engine.ts`

### Next Sprint (1-2 weeks)

3. **Player state caching** (Priority: MEDIUM)
   - Effort: ~3 hours
   - Impact: ~15% faster step
   - Files: `src/core/environment.ts`

4. **Batch ticks in worker** (Priority: HIGH)
   - Effort: ~1
