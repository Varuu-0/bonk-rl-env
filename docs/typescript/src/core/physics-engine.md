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
| `ARENA_HALF_WIDTH` | `25` | Arena half-width in metres (fallback) |
| `ARENA_HALF_HEIGHT` | `20` | Arena half-height in metres (fallback) |
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

  // New fields
  noPhysics?: boolean;    // When true, body becomes a sensor (no collision response)
  noGrapple?: boolean;    // When true, cannot be grappled
  innerGrapple?: boolean; // Inner grapple behavior
  friction?: number;      // Surface friction coefficient (default 0.3)
  collides?: {            // Collision group filtering
    g1: boolean;          // Collides with Player 0
    g2: boolean;          // Collides with Player 1+
    g3: boolean;          // Reserved for future use
    g4: boolean;          // Reserved for future use
  };
  color?: number;         // Visual color (RGB as integer)
  surfaceName?: string;   // Surface type name
}
```

#### `MapDef`

```typescript
interface MapDef {
  name: string;
  spawnPoints: MapSpawnPoints;
  bodies: MapBodyDef[];
}

interface MapSpawnPoints {
  [playerId: number]: { x: number; y: number };
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

**Behavior**:
- Automatically calls `calculateArenaBounds()` after adding the body
- Applies collision filtering based on `collides.g1-g4` fields
- Sets `shapeDef.isSensor = true` when `noPhysics: true`

---

##### `calculateArenaBounds`

```typescript
calculateArenaBounds(): { halfWidth: number; halfHeight: number }
```

Dynamically calculates arena bounds from all platform body extents.

**Behavior**:
- Called automatically after each `addBody()` call
- Calculates bounds from all platform body extents (excluding sensor bodies)
- Adds 5m margin beyond body extents
- Replaces hardcoded `ARENA_HALF_WIDTH`/`ARENA_HALF_HEIGHT` for death checks

**Returns**: Object containing `halfWidth` and `halfHeight` in metres

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

## Feature Documentation

### Dynamic Arena Bounds

The physics engine calculates arena bounds dynamically based on map geometry:

- After each `addBody()` call, `calculateArenaBounds()` is automatically invoked
- Bounds are computed from all platform body extents (non-sensor bodies)
- A 5m margin is added beyond the body extents
- Death checks use the dynamic bounds instead of hardcoded `ARENA_HALF_WIDTH`/`ARENA_HALF_HEIGHT`

This allows maps to define their own play areas without relying on fixed constants.

---

### Collision Filtering

The physics engine uses Box2D's category/mask system for collision filtering:

| Group | Category Bit | Description |
|:------|:-------------|:------------|
| Map bodies | `0x0001` | Static geometry |
| Player 0 | `0x0002` | First player (g1) |
| Player 1+ | `0x0004` | Additional players (g2) |
| Reserved | `0x0008` | Future use (g3) |
| Reserved | `0x0010` | Future use (g4) |

**How `collides` works**:

The `MapBodyDef.collides` object controls which player groups collide with the body:

```typescript
{
  g1: boolean;  // Collides with Player 0
  g2: boolean;  // Collides with Player 1+
  g3: boolean;  // Reserved
  g4: boolean   // Reserved
}
```

- `g1: true` → maskBits includes `0x0002` (Player 0)
- `g2: true` → maskBits includes `0x0004` (Player 1+)

**Example**:
```typescript
// Platform that only Player 0 can collide with
{
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  static: true,
  collides: { g1: true, g2: false, g3: false, g4: false }
}
```

---

### Sensor Bodies

Bodies with `noPhysics: true` become sensor bodies:

```typescript
{
  type: 'rect',
  x: 0,
  y: -50,
  width: 200,
  height: 20,
  static: true,
  noPhysics: true,  // Shape is a sensor
  isLethal: true    // Still triggers death
}
```

**Behavior**:
- `shapeDef.isSensor = true` when `noPhysics: true`
- No collision response (objects pass through)
- Contact events are still triggered
- Lethal detection still works on sensors

Use cases:
- Hazard zones that detect entry without blocking movement
- Trigger regions for game logic
- Visual-only elements that don't affect physics

---

### Surface Properties

Map bodies can define surface properties for customized physics behavior:

```typescript
{
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  static: true,
  friction: 0.5,        // Higher friction (default: 0.3)
  surfaceName: 'ice',   // For surface-specific game logic
  color: 0x00FF00       // RGB as integer for visual rendering
}
```

| Property | Type | Default | Description |
|:---------|:-----|:--------|:------------|
| `friction` | `number` | `0.3` | Surface friction coefficient |
| `surfaceName` | `string` | `undefined` | Surface type identifier |
| `color` | `number` | `undefined` | Visual color (RGB integer) |

---

### Grapple Configuration

Map bodies can modify grapple behavior:

| Property | Type | Default | Description |
|:---------|:-----|:--------|:------------|
| `noGrapple` | `boolean` | `false` | When true, cannot be grappled |
| `innerGrapple` | `boolean` | `false` | Inner grapple behavior (different anchor point) |
| `grappleMultiplier` | `number` | `1.0` | Grapple force multiplier |

---

### Key Design Decisions

1. **Synchronous Loop**: No real-time clock - tick() is called manually by the RL loop
2. **Deterministic Physics**: Each tick advances the world by exactly 1/30th of a second
3. **Player Bodies**: Circles with configurable radius/density
4. **Heavy State**: Multiplies mass by 3x and applies downward force
5. **Dynamic Bounds**: Arena bounds computed from map geometry

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

// Add map bodies with new features
engine.addBody({
  type: 'rect',
  x: 0,
  y: 200,
  width: 800,
  height: 20,
  static: true,
  friction: 0.5,
  surfaceName: 'ground',
  color: 0x808080,
  collides: { g1: true, g2: true, g3: false, g4: false }
});

// Add sensor hazard
engine.addBody({
  type: 'rect',
  x: 0,
  y: -50,
  width: 200,
  height: 20,
  static: true,
  noPhysics: true,
  isLethal: true
});

// Add players
engine.addPlayer(0, -100, 0);
engine.addPlayer(1, 100, 0);

// Apply inputs
engine.applyInput(0, { left: true, up: false, ... });
engine.applyInput(1, { right: true, ... });

// Step simulation
engine.tick();

// Get dynamic arena bounds
const bounds = (engine as any).calculateArenaBounds();

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