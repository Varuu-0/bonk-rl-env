# Environment Module

## Overview

The `environment` module manages the game environment state, including map loading, player management, and episode lifecycle.

## Module: `src.core.environment`

**Source File**: `src/core/environment.ts`

---

## API Outline

### Class: `Environment`

Manages the game state for one or more parallel environments.

#### Constructor

```typescript
constructor(mapDef: MapDef, config?: EnvironmentConfig)
```

**Parameters**:
- `mapDef`: Map definition including bodies and spawn points
- `config`: Optional environment configuration

#### Methods

##### `reset`

```typescript
reset(seed?: number): void
```

Resets the environment to initial state.

**Parameters**:
- `seed`: Optional random seed for deterministic reset

---

##### `step`

```typescript
step(actions: PlayerInput[]): StepResult
```

Advances the environment by one tick.

**Parameters**:
- `actions`: Array of player inputs

**Returns**: Step result containing observations, rewards, dones

---

##### `getObservations`

```typescript
getObservations(): Observation[]
```

Gets current observations for all players.

**Returns**: Array of observations

---

### Interfaces

#### `Observation`

```typescript
interface Observation {
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

### Environment Configuration

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `tickRate` | `number` | `30` | Ticks per second |
| `maxTicks` | `number` | `1800` | Maximum ticks per episode |
| `respawnTime` | `number` | `60` | Respawn delay in ticks |

---

### Map Definition

The environment loads maps from JSON definitions:

```json
{
  "name": "Arena",
  "spawnPoints": {
    "blue": {"x": -200, "y": 100},
    "red": {"x": 200, "y": 100}
  },
  "bodies": [
    {
      "type": "rect",
      "x": 0,
      "y": 200,
      "width": 800,
      "height": 20,
      "static": true
    }
  ]
}
```

---

### Reward Function

The default reward function includes:

| Event | Reward |
|:------|:-------|
| Win (opponent dead) | +100 |
| Death (out of bounds) | -100 |
| Hit lethal object | -50 |
| Time alive | +0.01/tick |

---

### Usage Example

```typescript
import { Environment } from './environment';
import * as fs from 'fs';

// Load map
const mapData = JSON.parse(fs.readFileSync('maps/wdb.json', 'utf8'));

// Create environment
const env = new Environment(mapData);

// Reset
env.reset(42);

// Step through episode
for (let i = 0; i < 1000; i++) {
  const actions = [
    { left: false, right: true, up: false, down: false, heavy: false, grapple: false },
    { left: true, right: false, up: false, down: false, heavy: false, grapple: false }
  ];
  
  const result = env.step(actions);
  
  if (result.dones.some(d => d)) {
    console.log('Episode ended');
    env.reset();
  }
}
```

---

### See Also

- [Physics Engine](physics-engine.md) - Physics simulation
- [Worker Pool](worker-pool.md) - Parallel environments
- [Maps](../maps.md) - Map format specification
