# Utilities (`src/utils/`)

Shared utility modules used across the Bonk.io RL environment.

## Files

| File | Purpose |
|------|---------|
| `port-manager.ts` | Dynamic port allocation — sequential allocation with wraparound, collision avoidance |

## PortManager API

```typescript
class PortManager {
  constructor(options?: { startPort?: number; endPort?: number })  // Default: 6000-7000
  allocate(): number           // Get next available port
  reserve(port: number): void  // Reserve a specific port
  release(port: number): void  // Release a port
  isAllocated(port: number): boolean  // Check if port is allocated
  getAllocatedCount(): number  // Count of allocated ports
  releaseAll(): void           // Release all ports
}

// Static helpers
PortManager.isPortAvailable(port: number): Promise<boolean>   // Check system availability
PortManager.findAvailablePort(preferredStart: number): Promise<number>  // Find free port
```

## Usage

Each `BonkEnv` instance gets a unique port from the `PortManager` to avoid collisions when running multiple IPC servers simultaneously. The default range (6000-7000) supports up to 1000 concurrent environments.

## Global Instance

```typescript
getGlobalPortManager(options?: PortManagerOptions): PortManager
resetGlobalPortManager(): void  // For testing
```
