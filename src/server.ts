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
 * Rolls the module singleton back to the stopped state for one specific
 * bridge attempt, releasing its (possibly already closed) ROUTER socket and
 * telemetry resources.
 *
 * Guarded on instance identity: a stale settle must never tear down a newer
 * server instance that replaced it. Idempotent with a concurrent explicit
 * stopServer(): whichever observer clears the singleton first wins and the
 * other becomes a no-op.
 */
async function releaseServerInstance(
  serverBridge: IpcBridge,
  telemetryOptions: { emitFinalReport?: boolean },
): Promise<void> {
  if (bridge !== serverBridge) {
    return;
  }
  bridge = null;
  try {
    await serverBridge.close();
  } catch (cleanupError) {
    console.error('Error during server cleanup:', cleanupError);
  }
  try {
    getTelemetryController().shutdown(telemetryOptions);
  } catch (cleanupError) {
    console.error('Error during telemetry cleanup:', cleanupError);
  }
}

/**
 * Starts the IPC bridge server on the specified port.
 *
 * The returned promise settles when serving ends — either by rejecting on a
 * failed bind or by resolving once the serve loop exits (a client-initiated
 * remote shutdown included). Both settlements roll the module singleton back
 * to the stopped state so isServerRunning() stays truthful and a subsequent
 * startServer() works without an intervening stopServer() (#326, #424).
 *
 * @param config - Optional app config (default: cached global config)
 * @returns Promise that resolves once the server has stopped serving
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
    await releaseServerInstance(serverBridge, { emitFinalReport: false });
    throw error;
  }

  // Issue #424: start() RESOLVING also means serving has ended — a client
  // sent the documented remote-shutdown command (`close` with
  // shutdown:true), which closes the bridge's own socket inside
  // handleRequest before the serve loop exits. Without this branch the
  // singleton survived the dead listener: isServerRunning() kept reporting
  // true and every restart threw "already running". Roll back to the exact
  // state stopServer() leaves behind so isServerRunning() is truthful and a
  // subsequent startServer() works without manual stopServer() surgery.
  // Telemetry keeps stopServer()'s forced shutdown final report (#237) for
  // a server that served, while preserving the #324 zero-tick discipline:
  // a remote shutdown that arrives before any tick was served must not
  // force-emit a zero-tick report (or JSONL entry in file/both modes).
  const controller = getTelemetryController();
  await releaseServerInstance(serverBridge, { emitFinalReport: controller.getTickCount() > 0 });
  console.log('Server stopped.');
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
