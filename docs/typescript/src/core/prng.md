# PRNG Module

## Overview

The `prng` module provides a deterministic pseudo-random number generator for reproducible simulation results in reinforcement learning training.

## Module: `src.core.prng`

**Source File**: `src/core/prng.ts`

---

## API Outline

### Class: `PRNG`

Deterministic PRNG for reproducible rollouts.

#### Constructor

```typescript
constructor(seed: number)
```

**Parameters**:
- `seed`: Initial seed value

#### Methods

##### `next`

```typescript
next(): number
```

Returns the next random number in the sequence.

**Returns**: Random number in range [0, 1)

---

##### `nextInt`

```typescript
nextInt(min: number, max: number): number
```

Returns a random integer in range [min, max).

**Parameters**:
- `min`: Minimum value (inclusive)
- `max`: Maximum value (exclusive)

**Returns**: Random integer

---

##### `seed`

```typescript
seed(value: number): void
```

Resets the PRNG with a new seed.

**Parameters**:
- `value`: New seed value

---

### Usage Example

```typescript
import { PRNG } from './prng';

// Create PRNG with seed for reproducibility
const rng = new PRNG(42);

// Generate deterministic random values
const r1 = rng.next();      // 0.123...
const r2 = rng.nextInt(0, 64); // Random action

// Reset for replay
rng.seed(42);
const r1_replay = rng.next(); // Same as r1
```

---

### Design Principles

1. **Deterministic**: Same seed always produces same sequence
2. **Fast**: Minimal overhead per random number
3. **Reproducible**: Essential for RL training reproducibility

---

### See Also

- [Physics Engine](physics-engine.md) - Uses PRNG for initial positions
- [Worker Pool](worker-pool.md) - Uses PRNG for environment seeds
