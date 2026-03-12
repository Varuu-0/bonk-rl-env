# Roadmap Prioritization Recommendation

## Executive Summary

Based on analysis of the project's current state, performance metrics, and core goals, I recommend prioritizing **Custom Reward Functions** as the next major feature, followed by **Binary Protocol for ZMQ**.

---

## Prioritization Framework

Each feature is evaluated on:
- **Impact**: Benefit to users and research capabilities
- **Effort**: Development time and complexity
- **Dependencies**: Prerequisites needed
- **Strategic Alignment**: Fit with project's high-performance RL goal

---

## Recommended Priority Order

### 1. Custom Reward Functions (HIGH PRIORITY)

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **High** | Enables research into novel training strategies |
| Effort | **Low** | ~1-2 days |
| Dependencies | **None** | Standalone feature |
| Alignment | **High** | Core to RL experimentation |

**Why**: This is a quick win that dramatically increases the project's value for researchers. Currently, users must fork the codebase to modify rewards. A plugin system or config-based approach would make the environment far more versatile.

**Implementation approach**:
```python
# Simple reward function interface
def custom_reward(obs, action, next_obs, done) -> float:
    # User-defined logic
    return reward

# Or via configuration
env = BonkVecEnv(num_envs=64, reward_fn="balance_bonus")
```

---

### 2. Binary Protocol for ZMQ (HIGH PRIORITY)

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **High** | 30-50% faster IPC |
| Effort | **Medium** | ~1 week |
| Dependencies | **None** | Independent |
| Alignment | **High** | Core performance goal |

**Why**: The current JSON serialization is the main bottleneck. Switching to MsgPack or Protocol Buffers could improve throughput from ~23,400 to ~30,000+ FPS. This directly advances the project's performance goals.

**Estimated improvement**: 20-30% throughput increase

**Trade-off**: Increases code complexity; consider using MsgPack over Protocol Buffers for simpler implementation.

---

### 3. Multi-Agent Support (>2 Players)

| Criterion | Rating | Notes |
|:----------|:-------|:-------|
| Impact | **High** | Enables complex multi-agent research |
| Effort | **Medium** | ~1-2 weeks |
| Dependencies | **None** | Independent |
| Alignment | **High** | Expands research scope |

**Why**: Many RL research papers require 3+ agents. Supporting this would make the environment more relevant for academic research.

**Challenge**: Observation space scaling; action space explosion (64^n for n players)

---

### 4. Multi-Map Support

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **High** | Enables curriculum learning |
| Effort | **Medium** | ~1 week |
| Dependencies | **Custom Rewards** | Useful for reward shaping |
| Alignment | **High** | Important for progressive training |

**Why**: Supports curriculum learning and transfer learning research. Maps can be ordered by difficulty.

---

### 5. ZMQ Socket Optimization

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **Medium** | 5-10% improvement |
| Effort | **Low** | ~2-3 days |
| Dependencies | **None** | Independent |
| Alignment | **Medium** | Performance tuning |

**Why**: Lower effort than binary protocol but with modest gains. Could be done alongside binary protocol work.

---

## Features to Deprioritize

### Worker Affinity / NUMA Optimization

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **Low-Medium** | Only relevant for specific hardware |
| Effort | **Medium** | Complex to implement correctly |
| Dependencies | **None** | Independent |

**Reason**: Most users run on standard cloud VMs where this provides minimal benefit. The current scaling already works well.

---

### GPU Acceleration

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **High** | Could dramatically improve training |
| Effort | **Very High** | Significant engineering |
| Dependencies | **None** | Independent |

**Reason**: While impactful, this is a major undertaking that may not align with the project's current scope. The CPU-based system is already performant enough for most use cases.

---

### Server Mode for Human Play

| Criterion | Rating | Notes |
|:----------|:-------|:------|
| Impact | **Low** | Out of scope for RL research |
| Effort | **High** | Significant architectural change |
| Dependencies | **Many** | Requires UI, state management |

**Reason**: This project is focused on RL training, not human gameplay. The original Bonk.io handles this already.

---

## Recommended Implementation Sequence

### Immediate (This Sprint)

1. **Custom Reward Functions** (Priority #1)
   - Estimated: 1-2 days
   - Deliverable: Reward function plugin system

### Short-term (1-4 weeks)

2. **Binary Protocol** (Priority #2)
   - Estimated: 1 week
   - Deliverable: MsgPack serialization for ZMQ

3. **Multi-Map Support** (Priority #4)
   - Estimated: 1 week
   - Deliverable: Map loader with hot-swap capability

### Medium-term (1-2 months)

4. **Multi-Agent Support** (Priority #3)
   - Estimated: 1-2 weeks
   - Deliverable: Support for 3-4 players

5. **Typed Arrays Optimization**
   - Estimated: 3-5 days
   - Deliverable: Zero-copy observation passing

---

## Summary Recommendation

**Start with Custom Reward Functions** because it:

1. ✅ Has high impact with low effort
2. ✅ Requires no architectural changes
3. ✅ Immediately benefits all users
4. ✅ Unblocks curriculum learning research
5. ✅ Has no dependencies

**Follow with Binary Protocol** to address the performance bottleneck and push throughput beyond 25,000 FPS.

---

## Decision Matrix

| Feature | Impact | Effort | Dependencies | Score | Priority |
|:--------|:-------|:-------|:-------------|:------|:---------|
| Custom Rewards | 9 | 2 | 0 | **11** | #1 |
| Binary Protocol | 8 | 5 | 0 | **13** | #2 |
| Multi-Agent | 8 | 6 | 0 | **14** | #3 |
| Multi-Map | 7 | 5 | 2 | **14** | #4 |
| ZMQ Optimization | 5 | 3 | 0 | **8** | #5 |
| Worker Affinity | 4 | 6 | 0 | **10** | Low |
| GPU Acceleration | 9 | 10 | 0 | **19** | Low |
| Server Mode | 3 | 8 | 5 | **16** | Skip |

*Score = Impact + Effort + Dependencies (lower is easier)*

---

## Next Steps

1. **Decide**: Confirm custom rewards as next priority
2. **Design**: Sketch reward function interface
3. **Prototype**: Implement basic version in 1-2 days
4. **Iterate**: Gather feedback, refine API

---

## See Also

- [Roadmap](./roadmap.md) - Full implementation status
- [Deprecated APIs](./deprecated.md) - Known issues
- [Configuration](./configuration.md) - Current configuration options
