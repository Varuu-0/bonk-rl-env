/**
 * server.ts — Server lifecycle management module
 *
 * Provides startServer() and stopServer() functions for managing
 * the IPC bridge lifecycle. Used by both CLI and programmatic entry points.
 */

import { IpcBridge } from './ipc/ipc-bridge';
import { AppConfig, getConfig } from './config/config-loader';

// Module-level server instance
let bridge: IpcBridge | null = null;

/**
 * Starts the IPC bridge server on the specified port.
 * 
 * @param port - The port number to bind the server to (default: 5555)
 * @returns Promise that resolves when the server is started
 * @throws Error if server is already running
 */
export async function startServer(config?: AppConfig): Promise<void> {
    if (bridge !== null) {
        throw new Error('Server is already running. Call stopServer() first.');
    }
    
    const appConfig = config || getConfig();
    console.log(`Starting server on port ${appConfig.server.port} (config: ${config ? 'provided' : 'cached'})`);
    bridge = new IpcBridge(appConfig);
    await bridge.start();
}

/**
 * Gracefully stops the IPC bridge server.
 * 
 * @returns Promise that resolves when the server is stopped
 */
export async function stopServer(): Promise<void> {
    if (bridge === null) {
        return;
    }
    
    console.log('Shutting down IPC bridge...');
    
    try {
        await bridge.close();
    } catch (error) {
        console.error('Error during server shutdown:', error);
    } finally {
        bridge = null;
        console.log('Server stopped.');
    }
}

/**
 * Checks if the server is currently running.
 * 
 * @returns true if server is running, false otherwise
 */
export function isServerRunning(): boolean {
    return bridge !== null;
}
