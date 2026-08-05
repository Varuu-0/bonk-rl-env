/**
 * telemetry-pipeline.test.ts — Regression coverage for issue #237
 *
 * The TelemetryController reporting pipeline was dead code: initialize() and
 * tick() had no production caller, so reportIntervalMs, dashboardPort and
 * outputFormat: 'file' were silently ignored (and the IPC bridge reported on
 * a hardcoded 5000-step boundary).
 *
 * These tests exercise the production wiring (startServer -> initialize ->
 * IPC step path -> controller.tick() -> post-step telemetry -> reportNow ->
 * writeToFile) through a real ZMQ server, real worker pool, and the real
 * dashboard HTTP server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as zmq from 'zeromq';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { startServer, stopServer } from '../../src/server';
import { loadConfig, deepMerge, resetConfig, type AppConfig } from '../../src/config/config-loader';
import { getTelemetryController, getTelemetryFilePath } from '../../src/telemetry/telemetry-controller';
import { PortManager } from '../../src/utils/port-manager';

const TELEMETRY_DIR = path.join(process.cwd(), 'telemetry');

describe('telemetry reporting pipeline (issue #237)', () => {
  let serverPort: number;
  let dashboardPort: number;
  let client: zmq.Dealer | null = null;
  let serverStart: Promise<void> | null = null;

  beforeAll(async () => {
    serverPort = await PortManager.findAvailablePort(18500);
    dashboardPort = await PortManager.findAvailablePort(18600);
  }, 30000);

  beforeEach(() => {
    resetConfig();
    getTelemetryController().shutdown();
    if (fs.existsSync(TELEMETRY_DIR)) {
      fs.rmSync(TELEMETRY_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      client = null;
    }
    try {
      await stopServer();
    } catch { /* ignore */ }
    if (serverStart) {
      await serverStart.catch(() => { /* server start settles on close */ });
      serverStart = null;
    }
    getTelemetryController().shutdown();
    if (fs.existsSync(TELEMETRY_DIR)) {
      fs.rmSync(TELEMETRY_DIR, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (fs.existsSync(TELEMETRY_DIR)) {
      fs.rmSync(TELEMETRY_DIR, { recursive: true, force: true });
    }
  });

  async function waitForFile(filePath: string, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return fs.existsSync(filePath);
  }

  async function waitForServerPort(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const open = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => { sock.destroy(); resolve(false); });
      });
      if (open) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`server port ${port} never became reachable`);
  }

  async function startServerDetached(config: AppConfig): Promise<void> {
    // bridge.start() resolves only when the server closes (stopServer), so the
    // startup promise is intentionally not awaited.
    serverStart = startServer(config);
    await waitForServerPort(config.server.port);
  }

  async function connectClient(port: number): Promise<zmq.Dealer> {
    const dealer = new zmq.Dealer();
    await dealer.connect(`tcp://127.0.0.1:${port}`);
    // ZMQ ROUTER/DEALER exchange requires a handshake before messages flow.
    await new Promise(r => setTimeout(r, 500));
    return dealer;
  }

  async function sendCommand(cmd: object): Promise<any> {
    if (!client) throw new Error('client not connected');
    await client.send(JSON.stringify(cmd));
    const reply = await Promise.race([
      client.receive(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no reply for ${JSON.stringify(cmd)}`)), 20000)),
    ]);
    return JSON.parse(reply[0].toString());
  }

  it('initialize converts reportIntervalMs into the configured tick window (30 TPS)', () => {
    getTelemetryController().initialize({ enabled: true, reportIntervalMs: 100 });
    expect(getTelemetryController().getReportInterval()).toBe(3);
    getTelemetryController().shutdown();
    getTelemetryController().initialize({ enabled: true, reportIntervalMs: 250 });
    expect(getTelemetryController().getReportInterval()).toBe(8);
  });

  it('emits a JSONL file report after the configured interval and binds the dashboard port', async () => {
    const base = loadConfig();
    const config = deepMerge(base, {
      server: { port: serverPort },
      workerPool: { numWorkers: 1, useSharedMemory: false },
      telemetry: {
        enabled: true,
        outputFormat: 'file',
        reportIntervalMs: 100, // 3 ticks at 30 TPS
        dashboardPort,
      },
    } as Partial<AppConfig>);

    await startServerDetached(config);
    expect(getTelemetryController().getFlags().enableTelemetry).toBe(true);

    client = await connectClient(serverPort);
    await sendCommand({ command: 'init', numEnvs: 1, useSharedMemory: false, config: { num_opponents: 0, max_ticks: 50 } });
    const reset = await sendCommand({ command: 'reset', seeds: [1] });
    expect(reset.status).toBe('ok');

    // Two steps stay inside the 3-tick window: no report yet.
    await sendCommand({ command: 'step', actions: [0] });
    await sendCommand({ command: 'step', actions: [0] });
    const filePath = getTelemetryFilePath();
    expect(fs.existsSync(filePath)).toBe(false);

    // Third step crosses the interval: report is emitted asynchronously.
    await sendCommand({ command: 'step', actions: [0] });
    expect(await waitForFile(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.tick).toBe(3);
    expect(typeof entry.report).toBe('string');

    // The dashboard HTTP server answers on the configured dashboard port.
    const dashboardBody = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${dashboardPort}/`, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    const dashboard = JSON.parse(dashboardBody);
    expect(dashboard.enabled).toBe(true);
    expect(dashboard.outputFormat).toBe('file');
    expect(dashboard.reportInterval).toBe(3);
  });

  it('does not write a file when outputFormat is console', async () => {
    const base = loadConfig();
    const config = deepMerge(base, {
      server: { port: await PortManager.findAvailablePort(18700) },
      workerPool: { numWorkers: 1, useSharedMemory: false },
      telemetry: {
        enabled: true,
        outputFormat: 'console',
        reportIntervalMs: 100,
        dashboardPort: await PortManager.findAvailablePort(18800),
      },
    } as Partial<AppConfig>);

    await startServerDetached(config);
    client = await connectClient((config as any).server.port);
    await sendCommand({ command: 'init', numEnvs: 1, useSharedMemory: false, config: { num_opponents: 0, max_ticks: 50 } });
    await sendCommand({ command: 'reset', seeds: [1] });
    for (let i = 0; i < 4; i++) {
      await sendCommand({ command: 'step', actions: [0] });
    }
    await new Promise(r => setTimeout(r, 300));

    expect(fs.existsSync(getTelemetryFilePath())).toBe(false);
  });
});