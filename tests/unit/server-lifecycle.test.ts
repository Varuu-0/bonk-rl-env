/**
 * server-lifecycle.test.ts — regression coverage for issue #326
 *
 * A failed standalone server bind must release its bridge, ROUTER socket, and
 * telemetry dashboard so the caller can retry after the port becomes free.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { startServer, stopServer, isServerRunning } from '../../src/server';
import { deepMerge, loadConfig, resetConfig, type AppConfig } from '../../src/config/config-loader';
import { getTelemetryController } from '../../src/telemetry/telemetry-controller';

interface ListeningServer {
  server: net.Server;
  port: number;
}

async function listenOnEphemeralPort(): Promise<ListeningServer> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to determine ephemeral test port');
  }
  return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForServerPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server port ${port} never became reachable`);
}

async function waitForPortAvailable(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = net.createServer();
    const available = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} did not become available`);
}

function makeConfig(port: number, telemetryEnabled = false, dashboardPort?: number): AppConfig {
  const base = loadConfig();
  return deepMerge(base, {
    server: { port, bindAddress: '127.0.0.1' },
    workerPool: { numWorkers: 1, useSharedMemory: false },
    telemetry: {
      enabled: telemetryEnabled,
      outputFormat: 'console',
      ...(dashboardPort === undefined ? {} : { dashboardPort }),
    },
  } as Partial<AppConfig>);
}

describe('standalone server bind-failure lifecycle (issue #326)', () => {
  beforeEach(() => {
    resetConfig();
    getTelemetryController().shutdown();
  });

  afterEach(async () => {
    await stopServer();
    getTelemetryController().shutdown();
  });

  it('rolls back running state after a bind failure', async () => {
    const blocker = await listenOnEphemeralPort();
    try {
      await expect(startServer(makeConfig(blocker.port))).rejects.toThrow(/address already in use|eaddrinuse/i);
      expect(isServerRunning()).toBe(false);
    } finally {
      await closeServer(blocker.server);
    }
  });

  it('restarts successfully after the failed port is released without stopServer()', async () => {
    const blocker = await listenOnEphemeralPort();
    const config = makeConfig(blocker.port);
    try {
      await expect(startServer(config)).rejects.toThrow(/address already in use|eaddrinuse/i);
      expect(isServerRunning()).toBe(false);
    } finally {
      await closeServer(blocker.server);
    }

    const serverStart = startServer(config);
    try {
      await waitForServerPort(blocker.port);
      expect(isServerRunning()).toBe(true);
    } finally {
      await stopServer();
      // The kernel listener exists before start()'s continuation runs, so
      // stopServer() can land inside startup's post-bind window. That
      // cancelled cycle now rejects deterministically with the clear
      // closed-during-start error (#402) instead of an opaque libzmq
      // failure or a hang; a cycle that already entered its serve loop
      // exits normally on shutdown. Both outcomes are valid here.
      await serverStart.then(undefined, (err: unknown) => {
        if (!(err instanceof Error) || !/closed during start/i.test(err.message)) {
          throw err;
        }
      });
    }
    expect(isServerRunning()).toBe(false);
  });

  it('releases the telemetry dashboard after a failed server bind', async () => {
    const blocker = await listenOnEphemeralPort();
    const dashboard = await listenOnEphemeralPort();
    await closeServer(dashboard.server);

    try {
      await expect(startServer(makeConfig(blocker.port, true, dashboard.port))).rejects.toThrow(
        /address already in use|eaddrinuse/i,
      );
      expect(isServerRunning()).toBe(false);
      await waitForPortAvailable(dashboard.port);
    } finally {
      await closeServer(blocker.server);
    }
  });

  it('does not force-emit a telemetry report (or JSONL entry) for a server that never served', async () => {
    const blocker = await listenOnEphemeralPort();
    const dashboard = await listenOnEphemeralPort();
    await closeServer(dashboard.server);

    const controller = getTelemetryController();
    // Keep reportNow real so a forced shutdown report would flow into
    // emitReport, and stub writeToFile so the file/both JSONL branch is
    // observed without touching disk. outputFormat 'both' keeps that branch
    // live, so both assertions below genuinely fail if the rollback ever
    // force-emits the shutdown report for a server that never served.
    const reportSpy = vi.spyOn(controller, 'reportNow');
    const writeSpy = vi.spyOn(controller as any, 'writeToFile').mockImplementation(() => {});
    const base = loadConfig();
    const config = deepMerge(base, {
      server: { port: blocker.port, bindAddress: '127.0.0.1' },
      workerPool: { numWorkers: 1, useSharedMemory: false },
      telemetry: { enabled: true, outputFormat: 'both', dashboardPort: dashboard.port },
    } as Partial<AppConfig>);
    try {
      await expect(startServer(config)).rejects.toThrow(/address already in use|eaddrinuse/i);
      expect(isServerRunning()).toBe(false);
      // The failed bind never served a tick, so its rollback must tear down
      // telemetry without the forced shutdown final report: a zero-tick
      // report (and JSONL entry in file/both modes) would pollute
      // replay-validation traces (#324).
      expect(reportSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      reportSpy.mockRestore();
      writeSpy.mockRestore();
      await closeServer(blocker.server);
    }
  });

  it('closes a ROUTER socket when a direct bridge bind fails', async () => {
    const blocker = await listenOnEphemeralPort();
    const bridge = new IpcBridge(makeConfig(blocker.port));
    try {
      await expect(bridge.start()).rejects.toThrow(/address already in use|eaddrinuse/i);
      expect((bridge as any).sock.closed).toBe(true);
    } finally {
      await bridge.close();
      await closeServer(blocker.server);
    }
  });
});
