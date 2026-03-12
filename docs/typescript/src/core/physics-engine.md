# Physics Engine Module

## Overview

The `physics-engine` module provides a synchronous Box2D wrapper for the Bonk.io RL environment. It wraps the `box2d` npm package (Box2DFlash v2.0 JS port) into a clean, headless interface designed specifically for reinforcement learning.

## Module: `src.core.physics_engine`

**Source File**: `src/core/physics-engine.ts`

---

## API Outline

### Constants

| Constant | Value | Description |
|:---------|:------|:------------|
| `TPS` | `30` | Ticks per second |
| `DT` | `1/30` | Delta time per tick in seconds |
| `SOLVER_ITERATIONS` | `10` | Box2D solver iterations per step |
| `SCALE` | `30` | Physics scale: pixels to metres |
| `GRAVITY_X` | `0` | Gravity X component |
| `GRAVITY_Y` | `10` | Gravity Y component (downward) |
| `PLAYER_RADIUS` | `0.5` | Default player circle radius in metres |
| `PLAYER_DENSITY` | `1.0` | Default player density |
| `HEAVY_MASS_MULTIPLIER` | `3.0` | Heavy state mass multiplier |
| `ARENA_HALF_WIDTH` | `25` | Arena half-width in metres |
| `ARENA_HALF_HEIGHT` | `20` | Arena half-height in metres |
| `MOVE_FORCE` | `8.0` | Movement force magnitude in Newtons |

---

### Interfaces

#### `PlayerState`

```typescript
interface PlayerState {
  x: number;           // Player X position (pixels)
  y: number;           // Player Y position (pixels)
  velX: number;        // Player X velocity (pixels/sec)
  velY: number;        // Player Y velocity (pixels/sec)
  angle: number;       // Player angle (radians)
  angularVel: number;  // Player angular velocity
  isHeavy: boolean;    // Heavy state flag
  alive: boolean;      // Alive/dead status
}
```

#### `PlayerInput`

```typescript
interface PlayerInput {
  left: boolean;    // Move left
  right: boolean;   // Move right
  up: boolean;      // Move up
  down: boolean;    // Move down
  heavy: boolean;   // Heavy state toggle
  grapple: boolean; // Grapple toggle
}
```

#### `MapBodyDef`

```typescript
interface MapBodyDef {
  name: string;
  type: 'rect' | 'circle';
  x: number;
  y: number;
  width?: number;      // For rect
  height?: number;     // For rect
  radius?: number;    // For circle
  static: boolean;
  density?: number;
  restitution?: number;
  angle?: number;
  isLethal?: boolean;  // Lethal hazard
  grappleMultiplier?: number; // Grapple multiplier
}
```

#### `MapDef`

```typescript
interface MapDef {
  name: string;
  spawnPoints: MapSpawnPoints;
  bodies: MapBodyDef[];
}
```

---

### Class: `PhysicsEngine`

The main physics simulation class.

#### Constructor

```typescript
constructor()
```

Creates a new physics world with gravity and collision detection.

#### Methods

##### `addBody`

```typescript
addBody(def: MapBodyDef): void
```

Adds a static or dynamic body from a MapBodyDef to the world.

**Parameters**:
- `def`: Body definition including type, position, dimensions

---

##### `addPlayer`

```typescript
addPlayer(id: number, x: number, y: number): void
```

Adds a dynamic circular player body.

**Parameters**:
- `id`: Player ID (0-indexed)
- `x`: Initial X position
- `y`: Initial Y position

---

##### `applyInput`

```typescript
applyInput(playerId: number, input: PlayerInput): void
```

Applies player inputs as forces on their body.

**Parameters**:
- `playerId`: Player ID
- `input`: Player input state

---

##### `tick`

```typescript
tick(): void
```

Advances the physics simulation by exactly one tick (1/30s). This is the core synchronous step with no real-time clock involvement.

---

##### `getPlayerState`

```typescript
getPlayerState(playerId: number): PlayerState
```

Gets the current state of a player.

**Parameters**:
- `playerId`: Player ID

**Returns**: PlayerState object

---

##### `getAlivePlayerIds`

```typescript
getAlivePlayerIds(): number[]
```

Gets all alive player IDs.

**Returns**: Array of player IDs

---

##### `getTickCount`

```typescript
getTickCount(): number
```

Gets the current tick number.

**Returns**: Tick count

---

##### `reset`

```typescript
reset(): void
```

Resets the world - destroys all bodies, recreates a fresh world.

---

##### `destroy`

```typescript
destroy(): void
```

Completely destroys the world for cleanup.

---

### Key Design Decisions

1. **Synchronous Loop**: No real-time clock - tick() is called manually by the RL loop
2. **Deterministic Physics**: Each tick advances the world by exactly 1/30th of a second
3. **Player Bodies**: Circles with configurable radius/density
4. **Heavy State**: Multiplies mass by 3x and applies downward force

---

### Telemetry Integration

The physics engine integrates with the telemetry system:

- `PHYSICS_TICK`: Wrapped tick() method timing
- `RAYCAST_CALL`: Grapple raycast timing
- `COLLISION_RESOLVE`: Collision detection timing

---

### Performance Characteristics

- **Tick Duration**: < 1ms per tick under normal load
- **Collision Detection**: Optimized with spatial partitioning
- **Memory**: Minimal allocation per tick

---

### Usage Example

```typescript
import { PhysicsEngine } from './physics-engine';

const engine = new PhysicsEngine();

// Add map bodies
engine.addBody({
  type: 'rect',
  x: 0,
  y: 200,
  width: 800,
  height: 20,
  static: true
});

// Add players
engine.addPlayer(0, -100, 0);
engine.addPlayer(1, 100, 0);

// Apply inputs
engine.applyInput(0, { left: true, up: false, ... });
engine.applyInput(1, { right: true, ... });

// Step simulation
engine.tick();

// Get state
const state0 = engine.getPlayerState(0);
const state1 = engine.getPlayerState(1);

// Reset for new episode
engine.reset();
```

---

### See Also

- [Worker Pool](worker-pool.md) - Manages multiple physics instances
- [IPC Bridge](../ipc/ipc-bridge.md) - Python communication
- [Telemetry](../telemetry/telemetry-controller.md) - Performance monitoring
