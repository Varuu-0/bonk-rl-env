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

/**
 * Performs graceful shutdown of the IPC bridge and worker threads.
 * Ensures all resources are properly released before exiting.
 */
async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        console.log('\nShutdown already in progress...');
        return;
    }
    isShuttingDown = true;
    
    console.log(`\nReceived ${signal}. Shutting down IPC bridge and worker threads...`);
    
    try {
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
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
}

/**
 * Sets up cross-platform signal handlers for graceful shutdown.
 * Handles SIGINT (Ctrl+C), SIGTERM, and Windows-specific signals.
 */
function setupSignalHandlers(): void {
    // Unix/Linux/macOS signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Windows-specific: Handle Ctrl+Break and console close
    if (process.platform === 'win32') {
        // Readline setup for Windows Ctrl+C detection
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        // Handle Ctrl+C on Windows more reliably
        process.on('SIGINT', () => {
            // Double SIGINT on Windows means force exit
            shutdown('SIGINT (Windows)');
        });
        
        // Handle Ctrl+Break on Windows
        process.on('SIGBREAK', () => shutdown('SIGBREAK (Windows)'));
        
        // Handle console window close
        process.on('close', () => shutdown('close (Windows)'));
    }
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
        shutdown('uncaughtException');
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
        shutdown('unhandledRejection');
    });
    
    // Exit handler
    process.on('exit', (code) => {
        console.log(`Process exiting with code: ${code}`);
    });
}

async function main(): Promise<void> {
    console.log('=== Bonk.io Headless RL Environment ===');
    console.log('Initializing zero-mq bridge (Worker pool initialized on demand over ipc)...');
    console.log('Press Ctrl+C to stop the server gracefully.');
    
    bridge = new IpcBridge(5555);
    
    // Set up signal handlers BEFORE starting the server
    setupSignalHandlers();
    
    console.log('Starting IPC Bridge. Waiting for Python connection...');
    await bridge.start();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
