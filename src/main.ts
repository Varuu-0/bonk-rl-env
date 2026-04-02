/**
 * main.ts — CLI entry point for the Bonk.io RL environment server
 *
 * Provides human-friendly CLI with support for:
 * - TEST_MODE for automation/CI environments
 * - --max-runtime CLI flag for time-limited execution
 * - Graceful shutdown via SIGINT/SIGTERM
 */

import { startServer, stopServer } from './server';
import { loadConfig, AppConfig } from './config/config-loader';
import * as readline from 'readline';

let isShuttingDown = false;

// Readline interface for Windows Ctrl+C handling
let rl: readline.Interface | null = null;

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
    
    const config = loadConfig();
    
    console.log(`Config: port=${config.server.port}, telemetry=${config.telemetry.enabled}, numWorkers=${config.workerPool.numWorkers}`);
    
    const effectiveTimeout = config.server.maxRuntimeSeconds > 0 ? config.server.maxRuntimeSeconds : undefined;
    
    // Register shutdown handlers
    registerShutdownHandlers();
    
    // Set up auto-shutdown if needed BEFORE starting the server
    if (effectiveTimeout !== undefined) {
        setTimeout(async () => {
            await shutdown('auto-timeout');
        }, effectiveTimeout * 1000);
    }
    
    // Start the server
    await startServer(config);
    
    if (!effectiveTimeout) {
        console.log('Press Ctrl+C to stop the server.');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
