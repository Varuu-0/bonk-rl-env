# src/env/ — Environment Wrappers

Gymnasium-compatible environment wrappers that provide a clean API for RL training. Manages individual environment instances and pools of parallel environments.

## Files

| File | Purpose |
|------|---------|
| `bonk-env.ts` | `BonkEnv` class — single simulation instance with worker pool, async `start()`/`stop()`/`reset()`/`step()` |
| `env-manager.ts` | `EnvManager` class — manages multiple `BonkEnv` instances, batch action dispatch, VecEnv-style interface |

## BonkEnv API

```typescript
class BonkEnv {
  id: string;                    // Unique identifier (e.g., "env-1")
  port: number;                  // IPC port if server mode enabled

  async start(): Promise<void>;
  async stop(): Promise<void>;
  async reset(seeds?: number[]): Promise<any>;
  async step(actions: any[]): Promise<StepResult | StepResult[]>;
  isActive(): boolean;
}
```

## EnvManager API

```typescript
class EnvManager {
  async createEnv(config?: BonkEnvConfig): Promise<BonkEnv>;
  async createPool(size: number, config?: BonkEnvConfig): Promise<BonkEnv[]>;
  async destroyEnv(id: string): Promise<void>;
  async shutdownAll(): Promise<void>;
  async resetAll(seeds?: number[]): Promise<any[]>;
  async stepAll(actions: any[]): Promise<any[]>;
  getEnv(id: string): BonkEnv | undefined;
  getAllEnvs(): BonkEnv[];
  getEnvCount(): number;
}
```

## Design

- Each `BonkEnv` owns a `WorkerPool` and allocates a unique port via `PortManager`
- `EnvManager` provides lifecycle management for parallel environment pools
- Port allocation range: 6000–7000 (configurable)
- Environments run in separate processes for true parallelism
