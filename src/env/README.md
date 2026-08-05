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
  async reset(seeds?: number[], options?: ResultOwnershipOptions): Promise<any>;
  async step(actions: any[], options?: ResultOwnershipOptions): Promise<StepResult[]>;
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
  async resetAll(seeds?: number[], options?: ResultOwnershipOptions): Promise<any[]>;
  async stepAll(actions: any[], options?: ResultOwnershipOptions): Promise<any[]>;
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

## Batch semantics

`EnvManager`'s batch methods cover every *internal* environment of the
manager's pools: a `BonkEnv` configured with `numEnvs: N` contributes `N`
entries to each batch. `resetAll(seeds)` and `stepAll(actions)` therefore
expect exactly one seed / exactly one action per internal environment
(`sum(numEnvs)` across all created `BonkEnv`s) and return a single flat array
with one entry per internal environment — the same shape from both APIs. A
count mismatch is rejected with an `Invalid seed batch` / `Invalid action
batch` error before any pool is touched, so an under-sized batch can never
silently leave internal environments unseeded or fail a multi-env worker
pool.

## Result Ownership

`reset` and `step` return caller-owned object graphs by default. Retaining an
observation or step result across later calls is safe in both message-passing
and SharedArrayBuffer modes.

Callers that consume a batch synchronously and discard it before the next
`reset` or `step` may pass `{ ownership: 'borrowed' }`. Borrowed results expose
the internal shared-memory extraction pools, must not be mutated, and become
invalid after the next call. This opt-in avoids the caller snapshot allocations
without changing the SharedArrayBuffer transport itself.

`ownership` only affects the SharedArrayBuffer path. Message-passing results are
structured-cloned by the worker transport and are always caller-owned, so
`borrowed` is accepted for API symmetry but has no allocation effect there.
