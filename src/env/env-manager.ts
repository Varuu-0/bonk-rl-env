/**
 * env-manager.ts — Environment Manager for spawnable RL environments
 *
 * Manages multiple BonkEnv instances, providing pooling and lifecycle
 * management for parallel RL training.
 */

import { BonkEnv, BonkEnvConfig } from './bonk-env';
import { PortManager } from '../utils/port-manager';
import type { ResultOwnershipOptions } from '../core/worker-pool';

export interface EnvManagerOptions {
  /** Port manager range options, or an existing PortManager instance to share */
  portManager?:
    | PortManager
    | {
        startPort?: number;
        endPort?: number;
      };
  /** Default configuration for created environments */
  defaultEnvConfig?: BonkEnvConfig;
}

export class EnvManager {
  private environments: Map<string, BonkEnv> = new Map();
  private portManager: PortManager;
  // True when this manager constructed its own PortManager (default).
  // For a caller-supplied shared instance, shutdown must not releaseAll
  // — the caller's allocator may carry claims from other envs.
  private ownsPortManager: boolean;
  private defaultEnvConfig: BonkEnvConfig;
  private isShutdown: boolean = false;

  constructor(options: EnvManagerOptions = {}) {
    const provided = options.portManager;
    if (provided instanceof PortManager) {
      this.portManager = provided;
      this.ownsPortManager = false;
    } else {
      this.portManager = new PortManager(provided ?? {});
      this.ownsPortManager = true;
    }

    this.defaultEnvConfig = options.defaultEnvConfig ?? {};
  }

  /**
   * Create a single environment.
   * @param config Optional configuration to override defaults
   * @returns The created and started BonkEnv
   */
  async createEnv(config?: BonkEnvConfig): Promise<BonkEnv> {
    if (this.isShutdown) {
      throw new Error('EnvManager has been shut down');
    }

    // Merge default config with provided config. The manager's
    // allocator is injected only when the caller did not supply one —
    // silently discarding config.portManager made per-env opt-out
    // impossible (issue #432).
    const envConfig: BonkEnvConfig = {
      ...this.defaultEnvConfig,
      ...config,
    };
    if (!envConfig.portManager) {
      envConfig.portManager = this.portManager;
    }

    const env = new BonkEnv(envConfig);
    try {
      await env.start();
    } catch (error) {
      await env.stop();
      throw error;
    }
    this.environments.set(env.id, env);

    console.log(`[EnvManager] Created environment ${env.id} on port ${env.port}`);

    return env;
  }

  /**
   * Create a pool of environments.
   * @param size Number of environments to create
   * @param config Optional configuration for all environments
   * @returns Array of created and started BonkEnv instances
   */
  async createPool(size: number, config?: BonkEnvConfig): Promise<BonkEnv[]> {
    if (size < 1) {
      throw new Error('Pool size must be at least 1');
    }

    const envs: BonkEnv[] = [];
    const errors: Error[] = [];

    // Create environments in parallel
    for (let i = 0; i < size; i++) {
      try {
        const env = await this.createEnv(config);
        envs.push(env);
      } catch (error) {
        errors.push(error as Error);
        console.error(`[EnvManager] Failed to create environment ${i}:`, error);
      }
    }

    if (envs.length === 0) {
      throw new Error(`Failed to create any environments: ${errors.map((e) => e.message).join(', ')}`);
    }

    if (envs.length < size) {
      console.warn(`[EnvManager] Only created ${envs.length} of ${size} requested environments`);
    }

    return envs;
  }

  /**
   * Destroy a specific environment by ID.
   * @param id The environment ID to destroy
   */
  async destroyEnv(id: string): Promise<void> {
    const env = this.environments.get(id);

    if (!env) {
      console.warn(`[EnvManager] Environment ${id} not found`);
      return;
    }

    await env.stop();
    this.environments.delete(id);

    console.log(`[EnvManager] Destroyed environment ${id}`);
  }

  /**
   * Get an environment by ID.
   * @param id The environment ID
   * @returns The BonkEnv or undefined if not found
   */
  getEnv(id: string): BonkEnv | undefined {
    return this.environments.get(id);
  }

  /**
   * Get all active environments.
   * @returns Array of all BonkEnv instances
   */
  getAllEnvs(): BonkEnv[] {
    return Array.from(this.environments.values());
  }

  /**
   * Get the number of active environments.
   * @returns Count of environments
   */
  getEnvCount(): number {
    return this.environments.size;
  }

  /**
   * Check if an environment exists.
   * @param id The environment ID
   * @returns true if exists, false otherwise
   */
  hasEnv(id: string): boolean {
    return this.environments.has(id);
  }

  /**
   * Shutdown all environments and release resources.
   * After shutdown, the manager cannot create new environments.
   */
  async shutdownAll(): Promise<void> {
    if (this.isShutdown) {
      console.log('[EnvManager] Already shut down');
      return;
    }

    console.log(`[EnvManager] Shutting down ${this.environments.size} environments...`);

    // Stop all environments in parallel
    const stopPromises = Array.from(this.environments.values()).map(async (env) => {
      try {
        await env.stop();
      } catch (error) {
        console.error(`[EnvManager] Error stopping environment ${env.id}:`, error);
      }
    });

    await Promise.all(stopPromises);

    this.environments.clear();
    // Only release claims when this manager owns its allocator; a
    // caller-supplied shared PortManager may hold reservations from
    // envs outside this manager (issue #432).
    if (this.ownsPortManager) {
      this.portManager.releaseAll();
    }
    this.isShutdown = true;

    console.log('[EnvManager] Shutdown complete');
  }

  /**
   * Reset all environments.
   * @param seeds Optional seeds, one per internal environment across the
   *   manager's pools. When provided the batch must contain exactly one
   *   seed per internal environment (numEnvs per BonkEnv) so no internal
   *   environment is silently left unseeded.
   * @param options Result ownership mode; caller-owned by default
   * @returns Flat array of initial observations, one per internal environment
   */
  async resetAll(seeds?: number[], options?: ResultOwnershipOptions): Promise<any[]> {
    const envs = this.getAllEnvs();
    const results: any[] = [];

    if (seeds !== undefined) {
      if (!Array.isArray(seeds)) {
        throw new Error(`Invalid seed batch: expected an array of seeds, got ${typeof seeds}`);
      }
      this.assertBatchLength('seed', seeds.length, envs);
    }

    // Reset all environments in parallel, slicing the batch per pool so
    // every internal environment of a multi-env BonkEnv receives its own
    // seed instead of only the first one (issue #230).
    let seedIdx = 0;
    const resetPromises = envs.map((env) => {
      const count = env.getNumEnvs();
      const envSeeds = seeds !== undefined ? seeds.slice(seedIdx, seedIdx + count) : undefined;
      seedIdx += count;
      return env.reset(envSeeds, options);
    });

    const resetResults = await Promise.all(resetPromises);

    for (const result of resetResults) {
      if (Array.isArray(result)) {
        // Flatten per-env results with an explicit loop: spreading a
        // very large batch would exceed the engine's argument limit.
        for (const item of result) {
          results.push(item);
        }
      } else {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Step all environments with the given actions.
   * @param actions Actions for each internal environment across the
   *   manager's pools: exactly one action per internal environment
   *   (numEnvs per BonkEnv)
   * @param options Result ownership mode; caller-owned by default
   * @returns Flat array of step results, one per internal environment,
   *   matching the shape returned by {@link resetAll}
   */
  async stepAll(actions: any[], options?: ResultOwnershipOptions): Promise<any[]> {
    const envs = this.getAllEnvs();

    if (!Array.isArray(actions)) {
      throw new Error(`Invalid action batch: expected an array of actions, got ${typeof actions}`);
    }
    this.assertBatchLength('action', actions.length, envs);

    // Step all environments in parallel, slicing the batch so each pool
    // receives the actions for all of its internal environments instead
    // of a single-element batch that a multi-env pool would reject
    // (issue #230).
    let actionIdx = 0;
    const stepPromises = envs.map((env) => {
      const count = env.getNumEnvs();
      const envActions = actions.slice(actionIdx, actionIdx + count);
      actionIdx += count;
      return env.step(envActions, options);
    });

    const stepResults = await Promise.all(stepPromises);

    // Every BonkEnv.step resolves to an array (one StepResult per internal
    // environment), so collect the results into the same flat shape
    // resetAll returns (issue #198).
    const results: any[] = [];
    for (const result of stepResults) {
      if (Array.isArray(result)) {
        // Flatten per-env results with an explicit loop: spreading a
        // very large batch would exceed the engine's argument limit.
        for (const item of result) {
          results.push(item);
        }
      } else {
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Validate that a batch covers exactly the internal environments of the
   * given BonkEnvs. A count mismatch rejects before any pool is touched, so
   * a malformed batch can never fail or desync a worker pool by forwarding
   * an empty or short action list.
   * @param kind 'seed' or 'action' (used in the error message)
   * @param received Number of entries in the caller's batch
   * @param envs The BonkEnv instances the batch is meant to cover
   */
  private assertBatchLength(kind: 'seed' | 'action', received: number, envs: BonkEnv[]): void {
    let expected = 0;
    for (const env of envs) {
      expected += env.getNumEnvs();
    }
    if (received !== expected) {
      const plural = expected === 1 ? '' : 's';
      throw new Error(
        `Invalid ${kind} batch: expected ${expected} ${kind}${plural} for ${expected} internal environment${plural} across ${envs.length} environment pool${envs.length === 1 ? '' : 's'}, got ${received}`,
      );
    }
  }

  /**
   * Check if the manager has been shut down.
   * @returns true if shut down, false otherwise
   */
  isShuttingDown(): boolean {
    return this.isShutdown;
  }

  /**
   * Get the port manager instance.
   * @returns The PortManager
   */
  getPortManager(): PortManager {
    return this.portManager;
  }
}

// Singleton instance for global use
let globalEnvManager: EnvManager | null = null;

/**
 * Get or create the global EnvManager instance.
 * @param options Options for the env manager
 * @returns The global EnvManager instance
 */
export function getGlobalEnvManager(options?: EnvManagerOptions): EnvManager {
  if (!globalEnvManager) {
    globalEnvManager = new EnvManager(options);
  }
  return globalEnvManager;
}

/**
 * Reset the global EnvManager instance.
 * Useful for testing.
 */
export async function resetGlobalEnvManager(): Promise<void> {
  if (globalEnvManager) {
    await globalEnvManager.shutdownAll();
    globalEnvManager = null;
  }
}
