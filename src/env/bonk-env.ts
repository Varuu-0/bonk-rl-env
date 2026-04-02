/**
 * bonk-env.ts — RL Environment abstraction for spawnable Bonk simulations
 *
 * This class represents a single Bonk simulation instance. Each environment 
 * runs its own worker pool and can be controlled independently for parallel 
 * RL training.
 */

import { WorkerPool } from '../core/worker-pool';
import { PortManager, getGlobalPortManager } from '../utils/port-manager';
import { getConfig } from '../config/config-loader';

export interface BonkEnvConfig {
    /** Number of environments to create internally (default: 1) */
    numEnvs?: number;
    /** Configuration for the environment */
    config?: Record<string, any>;
    /** Whether to use shared memory for IPC (default: auto-detect) */
    useSharedMemory?: boolean;
    /** Port manager instance to use (optional) */
    portManager?: PortManager;
    /** Port number for this environment (optional, for IPC server mode) */
    port?: number;
    /** If true, start an IPC server for external connections */
    enableIpcServer?: boolean;
}

export interface StepResult {
    observation: any;
    reward: number;
    done: boolean;
    truncated: boolean;
    info: Record<string, any>;
}

export class BonkEnv {
    /** Unique identifier for this environment */
    public readonly id: string;
    
    /** Port number this environment is running on (if IPC server enabled) */
    public readonly port: number;
    
    private pool: WorkerPool | null = null;
    private portManager: PortManager;
    private isRunning: boolean = false;
    private config: BonkEnvConfig;
    private static instanceCount: number = 0;

    constructor(config: BonkEnvConfig = {}) {
        this.id = `env-${++BonkEnv.instanceCount}`;
        this.config = config;
        
        // Use provided port manager or get global one
        this.portManager = config.portManager ?? getGlobalPortManager();
        
        // Get port from config or allocate one
        if (config.port) {
            // Use provided port and reserve it
            this.port = config.port;
            this.portManager.reserve(this.port);
        } else {
            // Allocate a unique port
            this.port = this.portManager.allocate();
        }
    }

    /**
     * Start the environment.
     * Initializes the worker pool (and optionally starts IPC server).
     * @returns Promise that resolves when the environment is started
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error(`Environment ${this.id} is already running`);
        }
        
        console.log(`[BonkEnv:${this.id}] Starting on port ${this.port}`);
        
        // Create worker pool
        this.pool = new WorkerPool();
        
        // Initialize the worker pool with the configured number of envs
        const useSharedMemory = this.config.useSharedMemory ?? getConfig().workerPool.useSharedMemory;
        await this.pool.init(
            this.config.numEnvs ?? 1,
            getConfig().environment,
            useSharedMemory
        );
        
        this.isRunning = true;
        console.log(`[BonkEnv:${this.id}] Started successfully`);
    }

    /**
     * Stop the environment and release resources.
     * @returns Promise that resolves when the environment is stopped
     */
    async stop(): Promise<void> {
        if (!this.isRunning || !this.pool) {
            console.log(`[BonkEnv:${this.id}] Already stopped`);
            return;
        }
        
        console.log(`[BonkEnv:${this.id}] Stopping...`);
        
        try {
            this.pool.close();
        } catch (error) {
            console.error(`[BonkEnv:${this.id}] Error during shutdown:`, error);
        } finally {
            this.pool = null;
            this.isRunning = false;
            this.portManager.release(this.port);
            console.log(`[BonkEnv:${this.id}] Stopped`);
        }
    }

    /**
     * Reset the environment to initial state.
     * @param seeds Optional seeds for environment reset
     * @returns Initial observation(s)
     */
    async reset(seeds?: number[]): Promise<any> {
        if (!this.isRunning || !this.pool) {
            throw new Error(`Environment ${this.id} is not running`);
        }
        
        return this.pool.reset(seeds);
    }

    /**
     * Take a step in the environment with the given action(s).
     * @param actions Action(s) to apply
     * @returns Step result(s) containing observation, reward, done, truncated, info
     */
    async step(actions: any[]): Promise<StepResult | StepResult[]> {
        if (!this.isRunning || !this.pool) {
            throw new Error(`Environment ${this.id} is not running`);
        }
        
        return this.pool.step(actions);
    }

    /**
     * Check if the environment is currently running.
     * @returns true if running, false otherwise
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Get the worker pool instance (for advanced usage).
     * @returns The WorkerPool instance or null if not running
     */
    getPool(): WorkerPool | null {
        return this.pool;
    }

    /**
     * Wait for the environment to be ready.
     * @returns Promise that resolves when ready
     */
    async ready(): Promise<void> {
        if (!this.isRunning) {
            throw new Error(`Environment ${this.id} is not running`);
        }
    }
}

/**
 * Create a new BonkEnv instance with the given configuration.
 * @param config Environment configuration
 * @returns A new BonkEnv instance (not started)
 */
export function createBonkEnv(config?: BonkEnvConfig): BonkEnv {
    return new BonkEnv(config);
}
