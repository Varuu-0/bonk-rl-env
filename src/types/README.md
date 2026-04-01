# Type Definitions (`src/types/`)

TypeScript type definitions shared across the Bonk.io RL environment.

## Files

| File | Purpose |
|------|---------|
| `index.d.ts` | Global type declarations — config, player, avatar, telemetry, and legacy server types |

## Key Types

### Map & Physics

```typescript
interface MapDef {
  name: string;
  spawnPoints: MapSpawnPoints;
  bodies: MapBodyDef[];
}

interface MapBodyDef {
  name: string;
  type: 'rect' | 'circle' | 'polygon';
  x: number; y: number;
  width?: number; height?: number; radius?: number;
  vertices?: { x: number; y: number }[];
  static: boolean;
  density?: number; restitution?: number; angle?: number;
  isLethal?: boolean; grappleMultiplier?: number;
  noPhysics?: boolean; noGrapple?: boolean; innerGrapple?: boolean;
  friction?: number; collides?: { g1: boolean; g2: boolean; g3: boolean; g4: boolean };
  color?: number; surfaceName?: string;
}

interface PlayerInput {
  left: boolean; right: boolean; up: boolean;
  down: boolean; heavy: boolean; grapple: boolean;
}
```

### Observation

```typescript
interface Observation {
  playerX: number; playerY: number;
  playerVelX: number; playerVelY: number;
  playerAngle: number; playerAngularVel: number;
  playerIsHeavy: boolean;
  opponents: Array<{
    x: number; y: number; velX: number; velY: number;
    isHeavy: boolean; alive: boolean;
  }>;
  arenaHalfWidth: number; arenaHalfHeight: number;
  tick: number;
}
```

### Telemetry

```typescript
interface TelemetryFlags {
  enableTelemetry: boolean;
  profileLevel: 'minimal' | 'standard' | 'detailed';
  debugLevel: 'none' | 'error' | 'verbose';
  outputFormat: 'console' | 'file' | 'both';
  dashboardPort: number;
  reportInterval: number;
  retentionDays: number;
}

interface TelemetryConfig {
  enabled: boolean;
  outputFormat: 'console' | 'file' | 'both';
  retentionDays: number;
  dashboardPort: number;
  reportInterval: number;
}
```

### Legacy Server Types

Types for the original multiplayer server (reference only):
- `Config` — Server configuration
- `Player` — Player state
- `GameSettings` — Game mode settings
- `BanList` — Ban list
- `TerminalCommand` — Console command definition
- `Avatar` / `AvatarLayer` / `eAvatarShape` — Avatar rendering
