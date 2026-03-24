/**
 * env-manager.ts — Environment Manager for spawnable RL environments
 *
 * Manages multiple BonkEnv instances, providing pooling and lifecycle
 * management for parallel RL training.
 */

import { BonkEnv, BonkEnvConfig } from './bonk-env';
import { PortManager, getGlobalPortManager } from '../utils/port-manager';

export interface EnvManagerOptions {
    /** Port manager options */
    portManager?: {
        startPort?: number;
        endPort?: number;
    };
    /** Default configuration for created environments */
    defaultEnvConfig?: BonkEnvConfig;
}

export class EnvManager {
    private environments: Map<string, BonkEnv> = new Map();
    private portManager: PortManager;
    private defaultEnvConfig: BonkEnvConfig;
    private isShutdown: boolean = false;

    constructor(options: EnvManagerOptions = {}) {
        // Initialize port manager with provided options or defaults
        this.portManager = new PortManager(options.portManager ?? {
            startPort: 6000,
            endPort: 7000
        });
        
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
        
        // Merge default config with provided config
        const envConfig: BonkEnvConfig = {
            ...this.defaultEnvConfig,
            ...config,
            portManager: this.portManager
        };
        
        const env = new BonkEnv(envConfig);
        await env.start();
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
            throw new Error(`Failed to create any environments: ${errors.map(e => e.message).join(', ')}`);
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
        this.portManager.releaseAll();
        this.isShutdown = true;
        
        console.log('[EnvManager] Shutdown complete');
    }

    /**
     * Reset all environments.
     * @param seeds Optional seeds for each environment
     * @returns Array of initial observations
     */
    async resetAll(seeds?: number[]): Promise<any[]> {
        const envs = this.getAllEnvs();
        const results: any[] = [];
        
        // Reset all environments in parallel, each with its own seed
        const resetPromises = envs.map((env, idx) => {
            const envSeed = seeds?.[idx];
            return env.reset(envSeed !== undefined ? [envSeed] : undefined);
        });
        
        const resetResults = await Promise.all(resetPromises);
        
        for (const result of resetResults) {
            if (Array.isArray(result)) {
                results.push(...result);
            } else {
                results.push(result);
            }
        }
        
        return results;
    }

    /**
     * Step all environments with the given actions.
     * @param actions Actions for each environment
     * @returns Array of step results
     */
    async stepAll(actions: any[]): Promise<any[]> {
        const envs = this.getAllEnvs();
        
        // Step all environments in parallel, each with exactly one action
        const stepPromises = envs.map((env, idx) => {
            const action = actions[idx];
            return env.step(action !== undefined ? [action] : []);
        });
        
        return Promise.all(stepPromises);
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
