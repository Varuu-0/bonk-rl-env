/**
 * main.ts — Entry point for the bonk.io RL environment with IPC bridge.
 *
 * Replaces the original index.ts (which started the Express/Socket.IO server).
 * Instantiates the BonkEnvironment and starts the ZeroMQ IPC Bridge on port 5555.
 *
 * Supports graceful shutdown via:
 * - SIGINT (Ctrl+C) on Unix/macOS/Windows
 * - SIGTERM on Unix/macOS
 * - Windows: Ctrl+Break or close console window
 */

import { IpcBridge } from './ipc/ipc-bridge';
import * as readline from 'readline';

let bridge: IpcBridge | null = null;
let isShuttingDown = false;

// Module-level flag to track if shutdown handlers have been registered
// This ensures idempotent registration - we don't rely on global listener counts
let _shutdownHandlersRegistered = false;

// Readline interface for Windows Ctrl+C handling - initialized lazily
let rl: readline.Interface | null = null;

/**
 * Get the IPC bridge port from environment variable or default.
 * 
 * @returns The port number to use for the IPC bridge
 * @throws Error if PORT environment variable is invalid
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
 * Performs graceful shutdown of the IPC bridge and worker threads.
 * Ensures all resources are properly released before exiting.
 * 
 * @param signal - The signal or reason for shutdown
 * @param isError - Whether this is an error shutdown (non-zero exit code)
 */
async function shutdown(signal: string, isError = false): Promise<void> {
    if (isShuttingDown) {
        console.log('\nShutdown already in progress...');
        return;
    }
    isShuttingDown = true;
    
    const exitCode = isError ? 1 : 0;
    
    console.log(`\nReceived ${signal}. Shutting down IPC bridge and worker threads...`);
    
    try {
        // Close readline interface on Windows to free resource
        if (rl) {
            rl.close();
            rl = null;
        }
        
        if (bridge) {
            // Set a timeout for graceful shutdown
            const shutdownTimeout = setTimeout(() => {
                console.error('Shutdown timed out. Forcing exit...');
                process.exit(1);
            }, 10000); // 10 second timeout
            
            await bridge.close();
            clearTimeout(shutdownTimeout);
        }
        console.log('Shutdown complete. Goodbye!');
        process.exit(exitCode);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
}

/**
 * Sets up cross-platform signal handlers for graceful shutdown.
 * Handles SIGINT (Ctrl+C), SIGTERM, and Windows-specific signals.
 * 
 * This function is idempotent - calling multiple times will not register
 * duplicate handlers. Uses a module-level flag to track registration.
 * 
 * @param platformOverride - Optional platform override for testing (e.g., 'win32', 'linux')
 * @returns Object with wasRegistered flag and closeResources function
 */
export function registerShutdownHandlers(platformOverride?: string): {wasRegistered: boolean, closeResources: () => Promise<void>} {
    // Use module-level flag to prevent duplicate registration
    // This ensures we register our handlers regardless of what other modules have registered
    if (_shutdownHandlersRegistered) {
        return {
            wasRegistered: true,
            closeResources: async () => {
                if (rl) {
                    rl.close();
                    rl = null;
                }
            }
        };
    }
    
    _shutdownHandlersRegistered = true;
    const platform = platformOverride || process.platform;
    
    // Unix/Linux/macOS signals - single handler for both SIGINT and SIGTERM
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Windows-specific: Handle Ctrl+Break 
    if (platform === 'win32') {
        // Set up readline interface for Windows Ctrl+C detection
        // This enables proper Ctrl+C handling in Windows terminals
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        // Wire readline's SIGINT event to our shutdown handler
        rl.on('SIGINT', () => {
            shutdown('SIGINT (Windows)');
        });
        
        // Handle Ctrl+Break on Windows
        process.on('SIGBREAK', () => shutdown('SIGBREAK (Windows)'));
        
        // Handle console window close - use beforeExit instead of close
        // Note: process.on('close') is NOT a valid Node.js event on the global process object
        // beforeExit fires when the event loop is empty but before exiting
        // Only log cleanup message during actual graceful shutdown
        process.on('beforeExit', (code) => {
            // Only log cleanup message during graceful shutdown (isShuttingDown === true)
            if (isShuttingDown) {
                console.log('Graceful shutdown: cleanup complete.');
            }
        });
    }
    
    // Handle uncaught exceptions - these are fatal errors
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
        shutdown('uncaughtException', true); // Exit with non-zero code
    });
    
    // Handle unhandled promise rejections - these are fatal errors
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
        shutdown('unhandledRejection', true); // Exit with non-zero code
    });
    
    // Removed redundant process.on('exit') handler that duplicated shutdown logging.
    // The shutdown() function already logs "Shutdown complete. Goodbye!" on line above.
    // Only log non-zero exit codes for debugging purposes.
    process.on('exit', (code) => {
        if (code !== 0) {
            console.log(`Process exiting with code: ${code}`);
        }
    });
    
    return {
        wasRegistered: false,
        closeResources: async () => {
            if (rl) {
                rl.close();
                rl = null;
            }
        }
    };
}

/**
 * @deprecated Use registerShutdownHandlers() instead
 * Sets up cross-platform signal handlers for graceful shutdown.
 * Handles SIGINT (Ctrl+C), SIGTERM, and Windows-specific signals.
 */
function setupSignalHandlers(): void {
    registerShutdownHandlers();
}

async function main(): Promise<void> {
    console.log('=== Bonk.io Headless RL Environment ===');
    
    // Get port from environment variable or use default
    const port = getPort();
    console.log(`IPC Bridge configured on port: ${port}`);
    console.log('Initializing zero-mq bridge (Worker pool initialized on demand over ipc)...');
    console.log('Press Ctrl+C to stop the server gracefully.');
    
    // Create bridge with configured port
    bridge = new IpcBridge(port);
    
    // Set up signal handlers BEFORE starting the server
    registerShutdownHandlers();
    
    console.log('Starting IPC Bridge. Waiting for Python connection...');
    await bridge.start();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
