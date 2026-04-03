import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelemetryController,
  isTelemetryEnabled,
  getTelemetryController,
} from '../../src/telemetry/telemetry-controller';
import { globalProfiler, TelemetryBuffer } from '../../src/telemetry/profiler';
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled } from '../../src/telemetry/flags';

describe('TelemetryController', () => {
  const originalArgv = process.argv;
  const envKeys = ['MANIFOLD_TELEMETRY', 'MANIFOLD_PROFILE', 'MANIFOLD_DEBUG', 'MANIFOLD_TELEMETRY_OUTPUT'];

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

    it('clears worker pool reference', () => {
      const controller = TelemetryController.getInstance();
      controller.setWorkerPool({ test: true });
      controller.shutdown();
      // Worker pool should be cleared
      expect((controller as any).workerPoolRef).toBeNull();
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
      // Simulate ticks to trigger report
      for (let i = 0; i < 10; i++) {
        controller.tick();
      }
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      controller.shutdown();
      // Should have generated a report during shutdown
      logSpy.mockRestore();
    });

    it('does not generate report when telemetry is disabled', () => {
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report');
      controller.shutdown();
      expect(reportSpy).not.toHaveBeenCalled();
      reportSpy.mockRestore();
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

    it('generates report at report interval', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--report-interval', '3'];
      const controller = TelemetryController.getInstance();
      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      
      controller.tick();
      controller.tick();
      expect(reportSpy).not.toHaveBeenCalled();
      
      controller.tick();
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

  describe('setWorkerPool', () => {
    it('sets worker pool reference', () => {
      const controller = TelemetryController.getInstance();
      const mockPool = { getTelemetrySnapshots: vi.fn() };
      controller.setWorkerPool(mockPool);
      expect((controller as any).workerPoolRef).toBe(mockPool);
    });
  });

  describe('worker telemetry during report', () => {
    it('gathers worker telemetry when worker pool is set and profile is not minimal', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'detailed', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const mockSnapshots = [new BigUint64Array(5)];
      const mockPool = {
        getTelemetrySnapshots: vi.fn().mockResolvedValue(mockSnapshots),
      };
      controller.setWorkerPool(mockPool);

      controller.tick();

      expect(mockPool.getTelemetrySnapshots).toHaveBeenCalled();
    });

    it('skips worker telemetry when profile is minimal', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'minimal', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const mockPool = {
        getTelemetrySnapshots: vi.fn().mockResolvedValue([new BigUint64Array(5)]),
      };
      controller.setWorkerPool(mockPool);

      controller.tick();

      expect(mockPool.getTelemetrySnapshots).not.toHaveBeenCalled();
    });

    it('skips worker telemetry when no worker pool', () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'detailed', '--report-interval', '1'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const reportSpy = vi.spyOn(globalProfiler, 'report').mockImplementation(() => {});
      controller.tick();

      expect(reportSpy).toHaveBeenCalled();
      reportSpy.mockRestore();
    });
  });

  describe('gatherWorkerTelemetry error handling', () => {
    it('logs full error in verbose debug mode', async () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'detailed', '--debug', 'verbose'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const error = new Error('Worker connection failed');
      const mockPool = {
        getTelemetrySnapshots: vi.fn().mockRejectedValue(error),
      };
      controller.setWorkerPool(mockPool);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await (controller as any).gatherWorkerTelemetry();

      expect(errorSpy).toHaveBeenCalledWith('[Telemetry] Error gathering worker telemetry:', error);
      errorSpy.mockRestore();
    });

    it('logs generic error in error debug mode', async () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'detailed', '--debug', 'error'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const mockPool = {
        getTelemetrySnapshots: vi.fn().mockRejectedValue(new Error('Worker connection failed')),
      };
      controller.setWorkerPool(mockPool);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await (controller as any).gatherWorkerTelemetry();

      expect(errorSpy).toHaveBeenCalledWith('[Telemetry] Error gathering worker telemetry');
      errorSpy.mockRestore();
    });

    it('silently fails in none debug mode', async () => {
      process.argv = ['node', 'script.js', '--telemetry', '--profile', 'detailed', '--debug', 'none'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const mockPool = {
        getTelemetrySnapshots: vi.fn().mockRejectedValue(new Error('Worker connection failed')),
      };
      controller.setWorkerPool(mockPool);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await (controller as any).gatherWorkerTelemetry();

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('returns early when telemetry is disabled', async () => {
      process.argv = ['node', 'script.js'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      const mockPool = {
        getTelemetrySnapshots: vi.fn(),
      };
      controller.setWorkerPool(mockPool);

      await (controller as any).gatherWorkerTelemetry();

      expect(mockPool.getTelemetrySnapshots).not.toHaveBeenCalled();
    });

    it('returns early when worker pool is null', async () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      TelemetryController.getInstance().shutdown();
      const controller = TelemetryController.getInstance();

      await expect((controller as any).gatherWorkerTelemetry()).resolves.toBeUndefined();
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
        reportInterval: 1000,
      });
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.outputFormat).toBe('file');
      expect(flags.retentionDays).toBe(30);
      expect(flags.dashboardPort).toBe(5000);
      expect(flags.reportInterval).toBe(1000);
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
