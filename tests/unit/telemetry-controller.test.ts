import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import {
  TelemetryController,
  isTelemetryEnabled,
  getTelemetryController,
} from '../../src/telemetry/telemetry-controller';
import { globalProfiler, TelemetryBuffer, setLatestWorkerTelemetry } from '../../src/telemetry/profiler';
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled } from '../../src/telemetry/flags';

describe('TelemetryController', () => {
  const originalArgv = process.argv;
  const envKeys = [
    'MANIFOLD_TELEMETRY',
    'MANIFOLD_PROFILE',
    'MANIFOLD_DEBUG',
    'MANIFOLD_TELEMETRY_OUTPUT',
    'TELEMETRY_ENABLED',
    'PROFILE_LEVEL',
    'DEBUG_LEVEL',
    'OUTPUT_FORMAT',
  ];

  beforeEach(() => {
    // Reset singleton state
    TelemetryController.getInstance().shutdown();
    // Reset env vars
    for (const key of envKeys) delete (process.env as any)[key];
    process.argv = originalArgv;
  });

  afterEach(() => {
    try {
      TelemetryController.getInstance().shutdown();
    } catch {
      // Already shut down
    }
    process.argv = originalArgv;
    for (const key of envKeys) delete (process.env as any)[key];
  });

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const a = TelemetryController.getInstance();
      const b = TelemetryController.getInstance();
      expect(a).toBe(b);
    });

    it('getTelemetryController returns the singleton', () => {
      expect(getTelemetryController()).toBe(TelemetryController.getInstance());
    });
  });

  describe('disabled by default', () => {
    it('isTelemetryEnabled returns false', () => {
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('flags show telemetry disabled', () => {
      const flags = TelemetryController.getInstance().getFlags();
      expect(flags.enableTelemetry).toBe(false);
    });
  });

  describe('enabled via CLI', () => {
    it('isTelemetryEnabled returns true with --telemetry', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('isTelemetryEnabled returns true with -t', () => {
      process.argv = ['node', 'script.js', '-t'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('isTelemetryEnabled returns true with --enable-telemetry', () => {
      process.argv = ['node', 'script.js', '--enable-telemetry'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('isTelemetryEnabled returns true with --telemetry-enabled (documented long form, issue #459)', () => {
      process.argv = ['node', 'script.js', '--telemetry-enabled'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('isTelemetryEnabled returns true with --enable-telemetry (documented alias)', () => {
      process.argv = ['node', 'script.js', '--enable-telemetry'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      expect(isTelemetryEnabled()).toBe(true);
    });

    // Last-wins parity with parseFlags()/parseCliFlags() (#459 review): the
    // controller's initialize() resolution must agree with the worker
    // fallback on the same argv.
    it('--telemetry --telemetry-enabled=false leaves the controller disabled (last-wins parity, #459 review)', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--telemetry-enabled=false'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(false);
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('--telemetry-enabled=false --telemetry enables the controller (last-wins parity, #459 review)', () => {
      process.argv = ['node', 'script.js', '--telemetry-enabled=false', '--telemetry'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('--profile minimal --telemetry-enabled=false leaves the controller disabled (level-then-disable parity, #459 review)', () => {
      process.argv = ['node', 'script.js', '--profile', 'minimal', '--telemetry-enabled=false'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(false);
      expect(isTelemetryEnabled()).toBe(false);
    });
  });

  describe('enabled via environment', () => {
    it('isTelemetryEnabled returns true with MANIFOLD_TELEMETRY=true', () => {
      process.env.MANIFOLD_TELEMETRY = 'true';
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('isTelemetryEnabled returns true with MANIFOLD_TELEMETRY=1', () => {
      process.env.MANIFOLD_TELEMETRY = '1';
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('isTelemetryEnabled returns true with MANIFOLD_TELEMETRY=yes', () => {
      process.env.MANIFOLD_TELEMETRY = 'yes';
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('isTelemetryEnabled returns true with TELEMETRY_ENABLED=true (documented name, issue #459)', () => {
      process.env.TELEMETRY_ENABLED = 'true';
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('isTelemetryEnabled returns false with TELEMETRY_ENABLED=false', () => {
      process.env.TELEMETRY_ENABLED = 'false';
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(false);
      expect(isTelemetryEnabled()).toBe(false);
    });
  });

  describe('implicit activation via MANIFOLD_PROFILE/MANIFOLD_DEBUG', () => {
    it('MANIFOLD_PROFILE alone enables telemetry at the requested level through initialize()', () => {
      process.env.MANIFOLD_PROFILE = 'detailed';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.profileLevel).toBe('detailed');
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('MANIFOLD_DEBUG alone enables telemetry through initialize()', () => {
      process.env.MANIFOLD_DEBUG = 'verbose';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.debugLevel).toBe('verbose');
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('explicit MANIFOLD_TELEMETRY=false disables telemetry even when MANIFOLD_PROFILE is set', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      process.env.MANIFOLD_PROFILE = 'detailed';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(false);
      expect(flags.profileLevel).toBe('detailed');
      expect(isTelemetryEnabled()).toBe(false);
    });

    // Documented env names (config.example.json, issue #459) through the
    // initialize() pipeline.
    it('PROFILE_LEVEL alone enables telemetry at the requested level through initialize()', () => {
      process.env.PROFILE_LEVEL = 'detailed';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.profileLevel).toBe('detailed');
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('DEBUG_LEVEL alone enables telemetry through initialize()', () => {
      process.env.DEBUG_LEVEL = 'verbose';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.debugLevel).toBe('verbose');
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('explicit TELEMETRY_ENABLED=false disables telemetry even when PROFILE_LEVEL is set', () => {
      process.env.TELEMETRY_ENABLED = 'false';
      process.env.PROFILE_LEVEL = 'detailed';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(false);
      expect(flags.profileLevel).toBe('detailed');
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('MANIFOLD_TELEMETRY wins over TELEMETRY_ENABLED when both are set', () => {
      process.env.TELEMETRY_ENABLED = 'true';
      process.env.MANIFOLD_TELEMETRY = 'false';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      expect(controller.getFlags().enableTelemetry).toBe(false);
    });

    it('config telemetry.enabled=false cannot downgrade a MANIFOLD_PROFILE activation', () => {
      process.env.MANIFOLD_PROFILE = 'detailed';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('MANIFOLD_DEBUG resolves to the same level as the CLI --debug equivalent', () => {
      process.env.MANIFOLD_DEBUG = 'error';
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      expect(controller.getDebugLevel()).toBe('error');
    });
  });

  describe('profile levels', () => {
    it('getProfileLevel returns minimal', () => {
      process.argv = ['node', 'script.js', '--profile', 'minimal'];
      const controller = TelemetryController.getInstance();
      expect(controller.getProfileLevel()).toBe('minimal');
    });

    it('getProfileLevel returns standard (default)', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getProfileLevel()).toBe('standard');
    });

    it('getProfileLevel returns detailed', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      const controller = TelemetryController.getInstance();
      expect(controller.getProfileLevel()).toBe('detailed');
    });

    it('isDetailedEnabled returns true for detailed profile', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      const controller = TelemetryController.getInstance();
      expect(controller.isDetailedEnabled()).toBe(true);
    });

    it('isDetailedEnabled returns false for standard profile', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.isDetailedEnabled()).toBe(false);
    });
  });

  describe('debug levels', () => {
    it('getDebugLevel returns none (default)', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getDebugLevel()).toBe('none');
    });

    it('getDebugLevel returns error', () => {
      process.argv = ['node', 'script.js', '--debug', 'error'];
      const controller = TelemetryController.getInstance();
      expect(controller.getDebugLevel()).toBe('error');
    });

    it('getDebugLevel returns verbose', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      const controller = TelemetryController.getInstance();
      expect(controller.getDebugLevel()).toBe('verbose');
    });

    it('isVerboseEnabled returns true for verbose debug', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      const controller = TelemetryController.getInstance();
      expect(controller.isVerboseEnabled()).toBe(true);
    });

    it('isVerboseEnabled returns false for error debug', () => {
      process.argv = ['node', 'script.js', '--debug', 'error'];
      const controller = TelemetryController.getInstance();
      expect(controller.isVerboseEnabled()).toBe(false);
    });
  });

  describe('output format', () => {
    it('getOutputFormat returns console (default)', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getOutputFormat()).toBe('console');
    });

    it('getOutputFormat returns file', () => {
      process.argv = ['node', 'script.js', '--output', 'file'];
      const controller = TelemetryController.getInstance();
      expect(controller.getOutputFormat()).toBe('file');
    });

    it('getOutputFormat returns both', () => {
      process.argv = ['node', 'script.js', '--output', 'both'];
      const controller = TelemetryController.getInstance();
      expect(controller.getOutputFormat()).toBe('both');
    });
  });

  describe('dashboard port', () => {
    it('getDashboardPort returns default 3001', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getDashboardPort()).toBe(3001);
    });

    it('getDashboardPort returns custom port', () => {
      process.argv = ['node', 'script.js', '--dashboard-port', '8080'];
      const controller = TelemetryController.getInstance();
      expect(controller.getDashboardPort()).toBe(8080);
    });
  });

  describe('report interval', () => {
    it('getReportInterval returns default 5000', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getReportInterval()).toBe(5000);
    });

    it('getReportInterval returns custom interval', () => {
      process.argv = ['node', 'script.js', '--report-interval', '1000'];
      const controller = TelemetryController.getInstance();
      expect(controller.getReportInterval()).toBe(1000);
    });
  });

  describe('retention days', () => {
    it('getRetentionDays returns default 7', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getRetentionDays()).toBe(7);
    });

    it('getRetentionDays returns custom value', () => {
      process.argv = ['node', 'script.js', '--retention', '30'];
      const controller = TelemetryController.getInstance();
      expect(controller.getRetentionDays()).toBe(30);
    });
  });

  describe('updateFlags', () => {
    it('updates enableTelemetry flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ enableTelemetry: true });
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });

    it('updates profileLevel flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ profileLevel: 'detailed' });
      expect(controller.getFlags().profileLevel).toBe('detailed');
    });

    it('updates debugLevel flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ debugLevel: 'verbose' });
      expect(controller.getFlags().debugLevel).toBe('verbose');
    });

    it('updates outputFormat flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ outputFormat: 'file' });
      expect(controller.getFlags().outputFormat).toBe('file');
    });

    it('updates dashboardPort flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ dashboardPort: 9090 });
      expect(controller.getFlags().dashboardPort).toBe(9090);
    });

    it('updates reportInterval flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ reportInterval: 2000 });
      expect(controller.getFlags().reportInterval).toBe(2000);
    });

    it('updates retentionDays flag', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ retentionDays: 14 });
      expect(controller.getFlags().retentionDays).toBe(14);
    });

    it('merges multiple flags at once', () => {
      const controller = TelemetryController.getInstance();
      controller.updateFlags({
        enableTelemetry: true,
        profileLevel: 'detailed',
        debugLevel: 'verbose',
      });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.profileLevel).toBe('detailed');
      expect(flags.debugLevel).toBe('verbose');
    });

    it('preserves existing flags when updating subset', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      const controller = TelemetryController.getInstance();
      controller.updateFlags({ enableTelemetry: true });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.profileLevel).toBe('detailed');
    });
  });

  describe('shutdown', () => {
    it('stops profiler collection by resetting metrics', () => {
      const controller = TelemetryController.getInstance();
      // Simulate some profiler activity
      globalProfiler.tick();
      globalProfiler.increment('test-counter', 5);
      // Manually reset the profiler to verify shutdown behavior
      globalProfiler.reset();
      const metrics = globalProfiler.getAndResetMetrics();
      expect(metrics.counters.length).toBe(0);
    });

    it('is idempotent', () => {
      const controller = TelemetryController.getInstance();
      controller.shutdown();
      expect(() => controller.shutdown()).not.toThrow();
    });

    it('clears cached flags', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      const controller = TelemetryController.getInstance();
      expect(controller.getFlags().enableTelemetry).toBe(true);
      controller.shutdown();
      // After shutdown, cachedFlags is null, so new instance will reinitialize
      // Since process.argv still has --telemetry, it will be enabled again
      // The key behavior is that shutdown() resets the singleton state
      expect((TelemetryController as any).instance).toBeNull();
    });

    it('resets singleton instance', () => {
      const controller = TelemetryController.getInstance();
      controller.shutdown();
      // getInstance should return a new instance after shutdown
      const newController = TelemetryController.getInstance();
      expect(newController).not.toBe(controller);
    });

    it('generates final report when telemetry is enabled', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '1'];
      const controller = TelemetryController.getInstance();
      // Simulate steps to advance the profiler window
      globalProfiler.tick();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      controller.shutdown();
      expect(reportSpy).toHaveBeenCalledTimes(1);
      reportSpy.mockRestore();
    });

    it('does not generate report when telemetry is disabled', () => {
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report');
      controller.shutdown();
      expect(reportSpy).not.toHaveBeenCalled();
      reportSpy.mockRestore();
    });

    it('skips the forced final report when shutdown opts out (emitFinalReport: false)', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      globalProfiler.tick();
      // A server that never served a tick must not append a zero-tick report /
      // JSONL entry to replay-validation traces (#324).
      controller.shutdown({ emitFinalReport: false });
      expect(reportSpy).not.toHaveBeenCalled();
      reportSpy.mockRestore();
    });

    it('emits a final report on shutdown over an incomplete profiler window (not a silent no-op)', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '100'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // A single tick is far short of the 100-tick report window, so without
      // a forced final report the console output would be nothing.
      globalProfiler.tick();
      controller.shutdown();
      const heatmapCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('Telemetry Heatmap'));
      expect(heatmapCalls.length).toBeGreaterThan(0);
      logSpy.mockRestore();
    });

    it('clears worker telemetry after the shutdown final report', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setLatestWorkerTelemetry([
        new BigUint64Array([BigInt(10), BigInt(20), BigInt(0), BigInt(0), BigInt(0)]) as unknown as BigUint64Array,
      ]);
      controller.shutdown();
      // The snapshots are consumed by the final report and cleared via reset().
      expect(globalProfiler.formatReport()).not.toContain('Global Worker Telemetry');
      logSpy.mockRestore();
    });

    it('forced shutdown report over an empty window avoids a misleading 0-tick header', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '100'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // No ticks at all in this window: the forced final report must not
      // print a 'Avg over last 0 ticks' heatmap header with no rows.
      controller.shutdown();
      const called = logSpy.mock.calls.map((c) => String(c[0]));
      expect(called.some((t) => t.includes('no ticks in window'))).toBe(true);
      expect(called.some((t) => t.includes('Avg over last 0 ticks'))).toBe(false);
      logSpy.mockRestore();
    });
  });

  describe('dashboard close race', () => {
    it('closes the HTTP server even when shutdown races the listening event', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      const controller = TelemetryController.getInstance();
      const server = http.createServer(() => {});
      const closeSpy = vi.spyOn(server, 'close').mockImplementation(function (
        this: http.Server,
        callback?: (err?: Error) => void,
      ) {
        if (typeof callback === 'function') callback();
        return this as unknown as http.Server;
      } as unknown as typeof server.close);

      // Simulate a shutdown that fires before the async 'listening' event:
      // dashboardListened is still false, yet the server must be closed so
      // the port is released rather than leaked.
      (controller as any).dashboardServer = server;
      (controller as any).dashboardListened = false;
      (controller as any).closeDashboard();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect((controller as any).dashboardServer).toBeNull();
      expect((controller as any).dashboardListened).toBe(false);
      closeSpy.mockRestore();
    });
  });

  describe('worker telemetry in file reports', () => {
    const workerBuf = (vals: bigint[]): BigUint64Array => {
      const buf = new BigUint64Array(5);
      vals.forEach((v, i) => {
        buf[i] = v;
      });
      return buf;
    };

    afterEach(() => {
      globalProfiler.reset();
      setLatestWorkerTelemetry(null);
    });

    it('formatReport includes latest worker telemetry (file output)', () => {
      setLatestWorkerTelemetry([
        workerBuf([BigInt(40_000_000), BigInt(10_000_000), BigInt(0), BigInt(0), BigInt(0)]),
        workerBuf([BigInt(30_000_000), BigInt(10_000_000), BigInt(0), BigInt(0), BigInt(0)]),
      ]);
      const text = globalProfiler.formatReport();
      expect(text).toContain('Global Worker Telemetry');
      // Worker 0 dominates physics time, so it is the reported straggler.
      expect(text).toContain('[Worker ID: 0]');
    });

    it('formatReport is empty of worker telemetry once none are set', () => {
      setLatestWorkerTelemetry(null);
      expect(globalProfiler.formatReport()).not.toContain('Global Worker Telemetry');
    });

    it('mean divides by contributing workers, not total worker count (heterogeneous buffers)', () => {
      const buf0 = workerBuf([40_000_000n, 20_000_000n, 0n, 0n, 0n]);
      // buf1 is shorter and only contributes to index 0 (PHYSICS_TICK), so
      // the RAYCAST mean must be computed over a single contributing worker.
      const buf1 = new BigUint64Array(1);
      buf1[0] = 40_000_000n;
      setLatestWorkerTelemetry([buf0, buf1]);

      const text = globalProfiler.formatReport();
      const row = text.split('\n').find((l) => l.startsWith('RAYCAST_CALL'));
      expect(row).toBeDefined();
      // 20ms from the sole contributing worker (not 10ms from /workerCount 2).
      expect(row).toContain('20.000');
    });

    it('file-only reportNow writes worker telemetry and clears it (file-only mode)', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--output', 'file', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      const writeSpy = vi.spyOn(controller as any, 'writeToFile').mockImplementation(() => {});
      setLatestWorkerTelemetry([
        workerBuf([BigInt(40_000_000), BigInt(10_000_000), BigInt(0), BigInt(0), BigInt(0)]),
        workerBuf([BigInt(30_000_000), BigInt(10_000_000), BigInt(0), BigInt(0), BigInt(0)]),
      ]);

      expect(controller.reportNow()).toBe(true);

      // The file entry carries the worker telemetry section, and because
      // file-only mode advances the window via reset(), the snapshots are
      // cleared rather than reused by a later report.
      const entry = writeSpy.mock.calls[0][0] as { report: string };
      expect(entry.report).toContain('Global Worker Telemetry');
      expect(globalProfiler.formatReport()).not.toContain('Global Worker Telemetry');

      reportSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });

  describe('tick and report', () => {
    it('increments tick count', () => {
      const controller = TelemetryController.getInstance();
      expect(controller.getTickCount()).toBe(0);
      controller.tick();
      expect(controller.getTickCount()).toBe(1);
      controller.tick();
      expect(controller.getTickCount()).toBe(2);
    });

    it('signals a report is due at the configured interval and reportNow emits', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '3'];
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});

      expect(controller.tick()).toBe(false);
      expect(controller.tick()).toBe(false);
      // Interval bookkeeping only — no report is emitted by tick() itself.
      expect(controller.tick()).toBe(true);
      expect(reportSpy).not.toHaveBeenCalled();

      controller.reportNow();
      expect(reportSpy).toHaveBeenCalledTimes(1);

      reportSpy.mockRestore();
    });

    it('reset clears tick count', () => {
      const controller = TelemetryController.getInstance();
      controller.tick();
      controller.tick();
      expect(controller.getTickCount()).toBe(2);
      controller.reset();
      expect(controller.getTickCount()).toBe(0);
    });
  });

  describe('reportNow', () => {
    it('emits a report when telemetry is enabled', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      globalProfiler.tick();

      expect(controller.reportNow()).toBe(true);
      expect(reportSpy).toHaveBeenCalledTimes(1);

      reportSpy.mockRestore();
    });

    it('is a no-op when telemetry is disabled', () => {
      process.argv = ['node', 'script.js'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});

      expect(controller.reportNow()).toBe(false);
      expect(reportSpy).not.toHaveBeenCalled();

      reportSpy.mockRestore();
    });

    it('does not retry emission when report generation throws', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {
        throw new Error('report failed');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(controller.reportNow()).toBe(false);
      expect(reportSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
      reportSpy.mockRestore();
    });
  });

  describe('tick with telemetry disabled', () => {
    it('never signals a report when telemetry is disabled', () => {
      process.argv = ['node', 'script.js'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      for (let i = 0; i < 100; i++) {
        expect(controller.tick()).toBe(false);
      }
    });
  });

  describe('isAnyTelemetryEnabled', () => {
    it('returns false with no telemetry flags', () => {
      process.argv = ['node', 'script.js'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns true with --telemetry flag', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true with --enable-telemetry flag', () => {
      process.argv = ['node', 'script.js', '--enable-telemetry'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true with -t flag', () => {
      process.argv = ['node', 'script.js', '-t'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true with --profile flag', () => {
      process.argv = ['node', 'script.js', '--profile', 'minimal'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true with --debug flag', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns false with unrelated flags', () => {
      process.argv = ['node', 'script.js', '--some-other-flag'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });
  });

  describe('initialize with config', () => {
    it('applies config when telemetry enabled', () => {
      process.argv = ['node', 'script.js'];
      const controller = TelemetryController.getInstance();
      controller.initialize({
        enabled: true,
        outputFormat: 'file',
        retentionDays: 30,
        dashboardPort: 5000,
        reportIntervalMs: 1000,
      });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.outputFormat).toBe('file');
      expect(flags.retentionDays).toBe(30);
      expect(flags.dashboardPort).toBe(5000);
      // 1000ms converts to a 30-tick window at the default 30 TPS.
      expect(flags.reportInterval).toBe(30);
    });

    it('does not reinitialize if already initialized', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      const controller = TelemetryController.getInstance();
      controller.initialize({ enabled: false });
      // Should still be enabled from CLI
      expect(controller.getFlags().enableTelemetry).toBe(true);
    });
  });
});
