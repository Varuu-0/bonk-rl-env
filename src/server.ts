/**
 * server.ts — Server lifecycle management module
 *
 * Provides startServer() and stopServer() functions for managing
 * the IPC bridge lifecycle. Used by both CLI and programmatic entry points.
 */

import { IpcBridge } from './ipc/ipc-bridge';
import { AppConfig, getConfig } from './config/config-loader';
import { getTelemetryController } from './telemetry/telemetry-controller';

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
    const serverBridge = new IpcBridge(appConfig);
    bridge = serverBridge;

    try {
        // Issue #237: initialize the telemetry controller once at startup so the
        // parsed flags are cached (no per-tick process.argv scan) and the
        // documented config surfaces (reportIntervalMs, dashboardPort,
        // outputFormat: 'file') take effect. This must happen before bridge.start()
        // is awaited: start() only resolves when the server closes.
        const controller = getTelemetryController();
        controller.initialize(appConfig.telemetry, appConfig.physics.ticksPerSecond);
        if (controller.getFlags().enableTelemetry) {
            controller.startDashboard(appConfig.telemetry.dashboardPort);
        }

        await serverBridge.start();
    } catch (error) {
        // A failed bind never started a serve cycle, so roll back the singleton
        // state and release everything created for this attempt. In particular,
        // this closes the failed bridge's ROUTER socket and telemetry dashboard
        // so callers can retry without an intervening stopServer() (issue #326).
        bridge = null;
        try {
            await serverBridge.close();
        } catch (cleanupError) {
            console.error('Error during failed server startup cleanup:', cleanupError);
        }
        try {
            getTelemetryController().shutdown();
        } catch (cleanupError) {
            console.error('Error during telemetry startup cleanup:', cleanupError);
        }
        throw error;
    }
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
        // Emit the shutdown final report and release telemetry resources.
        try {
            getTelemetryController().shutdown();
        } catch (error) {
            console.error('Error during telemetry shutdown:', error);
        }
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
