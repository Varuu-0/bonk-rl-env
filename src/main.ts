/**
 * main.ts — CLI entry point for the Bonk.io RL environment server
 *
 * Provides human-friendly CLI with support for:
 * - TEST_MODE for automation/CI environments
 * - --max-runtime CLI flag for time-limited execution
 * - Graceful shutdown via SIGINT/SIGTERM
 */

import { startServer, stopServer } from './server';
import * as readline from 'readline';

let isShuttingDown = false;

// Readline interface for Windows Ctrl+C handling
let rl: readline.Interface | null = null;

/**
 * Get the IPC bridge port from environment variable or default.
 */
function getPort(): number {
    const portStr = process.env.PORT ?? '5555';
    const port = parseInt(portStr, 10);
    
    if (isNaN(port)) {
        throw new Error(`Invalid PORT value: "${portStr}". PORT must be a valid integer.`);
    }
    
    if (port < 1 || port > 65535) {
        throw new Error(`Invalid PORT value: ${port}. PORT must be between 1 and 65535.`);
    }
    
    return port;
}

/**
 * Parse --max-runtime CLI argument.
 * @returns Max runtime in seconds, or undefined if not specified
 */
function getMaxRuntime(): number | undefined {
    const args = process.argv.slice(2);
    const maxRuntimeIndex = args.findIndex(arg => arg === '--max-runtime');
    
    if (maxRuntimeIndex !== -1 && args[maxRuntimeIndex + 1]) {
        const value = parseInt(args[maxRuntimeIndex + 1], 10);
        if (!isNaN(value) && value > 0) {
            return value;
        }
    }
    
    return undefined;
}

/**
 * Performs graceful shutdown.
 */
async function shutdown(signal: string, isError = false): Promise<void> {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    
    const exitCode = isError ? 1 : 0;
    console.log(`\nShutting down...`);
    
    try {
        // Close readline interface on Windows
        if (rl) {
            rl.close();
            rl = null;
        }
        
        await stopServer();
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
    
    process.exit(exitCode);
}

/**
 * Register shutdown handlers for SIGINT and SIGTERM.
 */
function registerShutdownHandlers(): void {
    // Register signal handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Windows-specific: Handle Ctrl+C via readline
    if (process.platform === 'win32') {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.on('SIGINT', () => {
            shutdown('SIGINT (Windows)');
        });
    }
}

async function main(): Promise<void> {
    console.log('=== Bonk.io Headless RL Environment ===');
    
    // Get port from environment variable or use default
    const port = getPort();
    console.log(`Server running on port ${port}`);
    
    // Check for TEST_MODE
    const testMode = process.env.TEST_MODE === '1';
    
    // Check for --max-runtime CLI flag
    const maxRuntime = getMaxRuntime();
    
    // Determine the effective timeout (use shorter of TEST_MODE or --max-runtime)
    let effectiveTimeout: number | undefined;
    
    if (testMode && maxRuntime !== undefined) {
        effectiveTimeout = Math.min(2, maxRuntime);
    } else if (testMode) {
        effectiveTimeout = 2;
    } else if (maxRuntime !== undefined) {
        effectiveTimeout = maxRuntime;
    }
    
    if (testMode) {
        console.log('TEST_MODE enabled');
    }
    
    // Register shutdown handlers
    registerShutdownHandlers();
    
    // Set up auto-shutdown if needed BEFORE starting the server
    if (effectiveTimeout !== undefined) {
        setTimeout(async () => {
            await shutdown('auto-timeout');
        }, effectiveTimeout * 1000);
    }
    
    // Start the server
    await startServer(port);
    
    if (!effectiveTimeout) {
        console.log('Press Ctrl+C to stop the server.');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
