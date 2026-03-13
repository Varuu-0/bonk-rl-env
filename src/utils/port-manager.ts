/**
 * port-manager.ts — Port allocation module for spawnable environments
 *
 * Provides sequential port allocation in a configurable range to avoid
 * port collisions when spawning multiple RL environments.
 */

import * as net from 'net';

export interface PortManagerOptions {
    /** Starting port number (default: 6000) */
    startPort?: number;
    /** Ending port number (default: 7000) */
    endPort?: number;
}

export class PortManager {
    private startPort: number;
    private endPort: number;
    private allocatedPorts: Set<number> = new Set();
    private currentPort: number;

    constructor(options: PortManagerOptions = {}) {
        this.startPort = options.startPort ?? 6000;
        this.endPort = options.endPort ?? 7000;
        
        if (this.startPort < 1 || this.endPort > 65535) {
            throw new Error(`Invalid port range: ${this.startPort}-${this.endPort}`);
        }
        
        if (this.startPort >= this.endPort) {
            throw new Error(`Start port must be less than end port: ${this.startPort} >= ${this.endPort}`);
        }
        
        this.currentPort = this.startPort;
    }

    /**
     * Allocate the next available port in the range.
     * Uses simple sequential allocation with wraparound.
     * @returns The allocated port number
     * @throws Error if no ports are available
     */
    allocate(): number {
        const startSearch = this.currentPort;
        
        // Try to find an available port
        while (true) {
            if (!this.allocatedPorts.has(this.currentPort)) {
                this.allocatedPorts.add(this.currentPort);
                const allocated = this.currentPort;
                
                // Move to next port with wraparound
                this.currentPort++;
                if (this.currentPort > this.endPort) {
                    this.currentPort = this.startPort;
                }
                
                return allocated;
            }
            
            // Move to next port with wraparound
            this.currentPort++;
            if (this.currentPort > this.endPort) {
                this.currentPort = this.startPort;
            }
            
            // We've wrapped around and checked all ports
            if (this.currentPort === startSearch) {
                throw new Error(`No available ports in range ${this.startPort}-${this.endPort}`);
            }
        }
    }

    /**
     * Release a previously allocated port.
     * @param port The port to release
     */
    release(port: number): void {
        this.allocatedPorts.delete(port);
    }

    /**
     * Check if a specific port is currently allocated.
     * @param port The port to check
     * @returns true if allocated, false otherwise
     */
    isAllocated(port: number): boolean {
        return this.allocatedPorts.has(port);
    }

    /**
     * Get the number of currently allocated ports.
     * @returns Count of allocated ports
     */
    getAllocatedCount(): number {
        return this.allocatedPorts.size;
    }

    /**
     * Check if a port is available (not in use by the system).
     * @param port The port to check
     * @returns true if available, false otherwise
     */
    static async isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            
            server.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false);
                } else {
                    // Some other error - assume port is not usable
                    resolve(false);
                }
            });
            
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            
            server.listen(port, '127.0.0.1');
        });
    }

    /**
     * Find an available port in the system (any port).
     * @param preferredStart Preferred starting port
     * @returns An available port number
     */
    static async findAvailablePort(preferredStart: number = 6000): Promise<number> {
        for (let port = preferredStart; port <= 65535; port++) {
            if (await PortManager.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error('No available ports found');
    }

    /**
     * Release all allocated ports.
     */
    releaseAll(): void {
        this.allocatedPorts.clear();
        this.currentPort = this.startPort;
    }
}

// Singleton instance for global use
let globalPortManager: PortManager | null = null;

/**
 * Get or create the global PortManager instance.
 * @param options Options for the port manager
 * @returns The global PortManager instance
 */
export function getGlobalPortManager(options?: PortManagerOptions): PortManager {
    if (!globalPortManager) {
        globalPortManager = new PortManager(options);
    }
    return globalPortManager;
}

/**
 * Reset the global PortManager instance.
 * Useful for testing.
 */
export function resetGlobalPortManager(): void {
    if (globalPortManager) {
        globalPortManager.releaseAll();
        globalPortManager = null;
    }
}
