import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { globalProfiler, TelemetryBuffer, TelemetryIndices, Profiler, setLatestWorkerTelemetry, startCollection, stopCollection } from '../../src/telemetry/profiler';
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled } from '../../src/telemetry/flags';

describe('Profiler uncovered paths', () => {
  beforeEach(() => {
    for (let i = 0; i < TelemetryBuffer.length; i++) {
      TelemetryBuffer[i] = BigInt(0);
    }
  });

  describe('startCollection/stopCollection', () => {
    it('starts periodic memory recording', () => {
      vi.useFakeTimers();
      const recordSpy = vi.spyOn(globalProfiler, 'recordMemory');
      startCollection(50);
      vi.advanceTimersByTime(150);
      expect(recordSpy).toHaveBeenCalledTimes(3);
      stopCollection();
      vi.useRealTimers();
      recordSpy.mockRestore();
    });

    it('stops collection and clears interval', () => {
      vi.useFakeTimers();
      const recordSpy = vi.spyOn(globalProfiler, 'recordMemory');
      startCollection(50);
      stopCollection();
      vi.advanceTimersByTime(100);
      expect(recordSpy).not.toHaveBeenCalled();
      vi.useRealTimers();
      recordSpy.mockRestore();
    });

    it('calling stopCollection when not started is safe', () => {
      expect(() => stopCollection()).not.toThrow();
    });

    it('startCollection replaces existing interval', () => {
      vi.useFakeTimers();
      const recordSpy = vi.spyOn(globalProfiler, 'recordMemory');
      startCollection(50);
      startCollection(100);
      vi.advanceTimersByTime(100);
      expect(recordSpy).toHaveBeenCalledTimes(1);
      stopCollection();
      vi.useRealTimers();
      recordSpy.mockRestore();
    });
  });

  describe('getSnapshot', () => {
    it('returns a copy of the telemetry buffer', () => {
      TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(12345);
      const snapshot = globalProfiler.getSnapshot();
      expect(snapshot.telemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBe(BigInt(12345));
      expect(snapshot.telemetryBuffer).not.toBe(TelemetryBuffer);
    });

    it('returns copies of maps', () => {
      globalProfiler.increment('test_counter', 5);
      globalProfiler.gauge('test_gauge', 42);
      const snapshot = globalProfiler.getSnapshot();
      expect(snapshot.counters.get('test_counter')).toBe(5);
      expect(snapshot.gauges.get('test_gauge')).toBe(42);
      expect(snapshot.counters).not.toBe((globalProfiler as any).counters);
    });

    it('includes currentTick', () => {
      globalProfiler.tick();
      globalProfiler.tick();
      const snapshot = globalProfiler.getSnapshot();
      expect(snapshot.currentTick).toBe(2);
    });
  });

  describe('formatReport', () => {
    it('returns empty report when no data', () => {
      const profiler = new Profiler();
      const report = profiler.formatReport();
      expect(report).toBe('=== Telemetry Report ===\n');
    });

    it('includes telemetry buffer entries with non-zero values', () => {
      TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(1_000_000);
      const report = globalProfiler.formatReport();
      expect(report).toContain('PHYSICS_TICK');
      expect(report).toContain('1.000 ms');
    });

    it('includes counters section when counters exist', () => {
      globalProfiler.increment('collisions', 10);
      const report = globalProfiler.formatReport();
      expect(report).toContain('--- Counters ---');
      expect(report).toContain('collisions: 10');
    });

    it('includes gauges section when gauges exist', () => {
      globalProfiler.gauge('Memory (RSS MB)', 128.5);
      const report = globalProfiler.formatReport();
      expect(report).toContain('--- Gauges ---');
      expect(report).toContain('Memory (RSS MB): 128.50');
    });

    it('includes both counters and gauges', () => {
      globalProfiler.increment('hits', 3);
      globalProfiler.gauge('load', 0.75);
      const report = globalProfiler.formatReport();
      expect(report).toContain('--- Counters ---');
      expect(report).toContain('--- Gauges ---');
      expect(report).toContain('hits: 3');
      expect(report).toContain('load: 0.75');
    });
  });

  describe('report with worker telemetry', () => {
    it('outputs straggler report when worker telemetry is set', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();

      const worker1 = new BigUint64Array(5);
      worker1[TelemetryIndices.PHYSICS_TICK] = BigInt(5_000_000);
      const worker2 = new BigUint64Array(5);
      worker2[TelemetryIndices.PHYSICS_TICK] = BigInt(10_000_000);
      setLatestWorkerTelemetry([worker1, worker2]);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Straggler Report'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Worker ID: 1'),
      );
      logSpy.mockRestore();
    });

    it('skips worker telemetry when snapshots are null', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();
      setLatestWorkerTelemetry(null);

      profiler.report(5000);

      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Global Worker Telemetry'),
      );
      logSpy.mockRestore();
    });

    it('skips worker telemetry when array is empty', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();
      setLatestWorkerTelemetry([]);

      profiler.report(5000);

      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Global Worker Telemetry'),
      );
      logSpy.mockRestore();
    });

    it('handles worker buffers shorter than TelemetryBuffer length', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();

      const shortBuf = new BigUint64Array(2);
      shortBuf[TelemetryIndices.PHYSICS_TICK] = BigInt(3_000_000);
      setLatestWorkerTelemetry([shortBuf]);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Global Worker Telemetry'),
      );
      logSpy.mockRestore();
    });

    it('handles null worker buffer in array', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();

      const worker = new BigUint64Array(5);
      worker[TelemetryIndices.PHYSICS_TICK] = BigInt(2_000_000);
      setLatestWorkerTelemetry([null as any, worker]);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Global Worker Telemetry'),
      );
      logSpy.mockRestore();
    });

    it('clears worker telemetry after report', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();

      const worker = new BigUint64Array(5);
      worker[TelemetryIndices.PHYSICS_TICK] = BigInt(1_000_000);
      setLatestWorkerTelemetry([worker]);

      profiler.report(5000);

      const firstCallOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(firstCallOutput).toContain('Global Worker Telemetry');

      logSpy.mockClear();
      profiler.tick();
      for (let t = 0; t < 5000; t++) profiler.tick();
      profiler.report(5000);

      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Global Worker Telemetry'),
      );
      logSpy.mockRestore();
    });

    it('outputs legacy counters table when counters exist', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();
      profiler.increment('events', 100);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Throughput'),
      );
      expect(tableSpy).toHaveBeenCalled();
      logSpy.mockRestore();
      tableSpy.mockRestore();
    });

    it('outputs legacy gauges table when gauges exist', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();
      profiler.gauge('health', 0.95);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Health & State'),
      );
      expect(tableSpy).toHaveBeenCalled();
      logSpy.mockRestore();
      tableSpy.mockRestore();
    });

    it('highlights critical path when percent > 25%', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const profiler = new Profiler();
      for (let t = 0; t < 5001; t++) profiler.tick();
      TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(50_000_000_000);

      profiler.report(5000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL'),
      );
      logSpy.mockRestore();
    });
  });
});

describe('Flags uncovered paths', () => {
  const originalArgv = process.argv;
  const envKeys = ['MANIFOLD_TELEMETRY', 'MANIFOLD_PROFILE', 'MANIFOLD_DEBUG', 'MANIFOLD_TELEMETRY_OUTPUT'];

  beforeEach(() => {
    for (const key of envKeys) delete (process.env as any)[key];
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const key of envKeys) delete (process.env as any)[key];
  });

  describe('parseFlags value flags', () => {
    it('parses --profile with valid value', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('detailed');
    });

    it('parses -p short alias', () => {
      process.argv = ['node', 'script.js', '-p', 'minimal'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('minimal');
    });

    it('warns on invalid profile level and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--profile', 'extreme'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('standard');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid profile level'));
      warnSpy.mockRestore();
    });

    it('parses --debug with valid value', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      const flags = parseFlags();
      expect(flags.debugLevel).toBe('verbose');
    });

    it('parses -d short alias', () => {
      process.argv = ['node', 'script.js', '-d', 'error'];
      const flags = parseFlags();
      expect(flags.debugLevel).toBe('error');
    });

    it('warns on invalid debug level and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--debug', 'trace'];
      const flags = parseFlags();
      expect(flags.debugLevel).toBe('none');
      warnSpy.mockRestore();
    });

    it('parses --output with valid value', () => {
      process.argv = ['node', 'script.js', '--output', 'file'];
      const flags = parseFlags();
      expect(flags.outputFormat).toBe('file');
    });

    it('parses --output with both value', () => {
      process.argv = ['node', 'script.js', '--output', 'both'];
      const flags = parseFlags();
      expect(flags.outputFormat).toBe('both');
    });

    it('warns on invalid output format and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--output', 'json'];
      const flags = parseFlags();
      expect(flags.outputFormat).toBe('console');
      warnSpy.mockRestore();
    });

    it('parses --dashboard-port with valid port', () => {
      process.argv = ['node', 'script.js', '--dashboard-port', '8080'];
      const flags = parseFlags();
      expect(flags.dashboardPort).toBe(8080);
    });

    it('warns on invalid port and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--dashboard-port', '99999'];
      const flags = parseFlags();
      expect(flags.dashboardPort).toBe(3001);
      warnSpy.mockRestore();
    });

    it('warns on non-numeric port and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--dashboard-port', 'abc'];
      const flags = parseFlags();
      expect(flags.dashboardPort).toBe(3001);
      warnSpy.mockRestore();
    });

    it('parses --report-interval with valid value', () => {
      process.argv = ['node', 'script.js', '--report-interval', '10000'];
      const flags = parseFlags();
      expect(flags.reportInterval).toBe(10000);
    });

    it('warns on invalid report interval and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--report-interval', '-5'];
      const flags = parseFlags();
      expect(flags.reportInterval).toBe(5000);
      warnSpy.mockRestore();
    });

    it('parses --retention with valid value', () => {
      process.argv = ['node', 'script.js', '--retention', '30'];
      const flags = parseFlags();
      expect(flags.retentionDays).toBe(30);
    });

    it('warns on invalid retention days and uses default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.argv = ['node', 'script.js', '--retention', '0'];
      const flags = parseFlags();
      expect(flags.retentionDays).toBe(7);
      warnSpy.mockRestore();
    });

    it('skips value flag when next arg looks like a flag', () => {
      process.argv = ['node', 'script.js', '--profile', '--debug', 'verbose'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('standard');
      expect(flags.debugLevel).toBe('verbose');
    });

    it('skips value flag when no next argument exists', () => {
      process.argv = ['node', 'script.js', '--profile'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('standard');
    });

    it('skips non-flag arguments', () => {
      process.argv = ['node', 'script.js', 'somefile.txt', '--telemetry'];
      const flags = parseFlags();
      expect(flags.enableTelemetry).toBe(true);
    });

    it('ignores unknown flags', () => {
      process.argv = ['node', 'script.js', '--unknown-flag'];
      const flags = parseFlags();
      expect(flags).toEqual(expect.objectContaining({ enableTelemetry: false }));
    });
  });

  describe('applyEnvOverrides', () => {
    it('overrides enableTelemetry with MANIFOLD_TELEMETRY=true', () => {
      process.env.MANIFOLD_TELEMETRY = 'true';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
    });

    it('overrides enableTelemetry with MANIFOLD_TELEMETRY=1', () => {
      process.env.MANIFOLD_TELEMETRY = '1';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
    });

    it('overrides enableTelemetry with MANIFOLD_TELEMETRY=yes', () => {
      process.env.MANIFOLD_TELEMETRY = 'yes';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
    });

    it('disables enableTelemetry with MANIFOLD_TELEMETRY=false', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(false);
    });

    it('disables enableTelemetry with MANIFOLD_TELEMETRY=0', () => {
      process.env.MANIFOLD_TELEMETRY = '0';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(false);
    });

    it('disables enableTelemetry with MANIFOLD_TELEMETRY=no', () => {
      process.env.MANIFOLD_TELEMETRY = 'no';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(false);
    });

    it('ignores invalid MANIFOLD_TELEMETRY values', () => {
      process.env.MANIFOLD_TELEMETRY = 'maybe';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
    });

    it('overrides outputFormat with MANIFOLD_TELEMETRY_OUTPUT=file', () => {
      process.env.MANIFOLD_TELEMETRY_OUTPUT = 'file';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.outputFormat).toBe('file');
    });

    it('overrides outputFormat with MANIFOLD_TELEMETRY_OUTPUT=both', () => {
      process.env.MANIFOLD_TELEMETRY_OUTPUT = 'both';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.outputFormat).toBe('both');
    });

    it('ignores invalid MANIFOLD_TELEMETRY_OUTPUT values', () => {
      process.env.MANIFOLD_TELEMETRY_OUTPUT = 'xml';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.outputFormat).toBe('console');
    });

    it('overrides profileLevel with MANIFOLD_PROFILE', () => {
      process.env.MANIFOLD_PROFILE = 'detailed';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.profileLevel).toBe('detailed');
    });

    it('ignores invalid MANIFOLD_PROFILE values', () => {
      process.env.MANIFOLD_PROFILE = 'extreme';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.profileLevel).toBe('standard');
    });

    it('overrides debugLevel with MANIFOLD_DEBUG', () => {
      process.env.MANIFOLD_DEBUG = 'verbose';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.debugLevel).toBe('verbose');
    });

    it('ignores invalid MANIFOLD_DEBUG values', () => {
      process.env.MANIFOLD_DEBUG = 'trace';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.debugLevel).toBe('none');
    });

    it('applies multiple env overrides at once', () => {
      process.env.MANIFOLD_TELEMETRY = '1';
      process.env.MANIFOLD_PROFILE = 'minimal';
      process.env.MANIFOLD_DEBUG = 'error';
      process.env.MANIFOLD_TELEMETRY_OUTPUT = 'file';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
      expect(flags.profileLevel).toBe('minimal');
      expect(flags.debugLevel).toBe('error');
      expect(flags.outputFormat).toBe('file');
    });
  });

  describe('mergeConfigWithFlags', () => {
    const defaultCliFlags = { enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 };

    it('applies config when CLI has defaults', () => {
      const result = mergeConfigWithFlags({ enabled: true, outputFormat: 'file', retentionDays: 30 }, defaultCliFlags);
      expect(result.enableTelemetry).toBe(true);
      expect(result.outputFormat).toBe('file');
      expect(result.retentionDays).toBe(30);
    });

    it('CLI flags take precedence over config', () => {
      const cliFlags = { ...defaultCliFlags, enableTelemetry: true, outputFormat: 'file' };
      const result = mergeConfigWithFlags({ enabled: false, outputFormat: 'console' }, cliFlags);
      expect(result.enableTelemetry).toBe(true);
      expect(result.outputFormat).toBe('file');
    });

    it('handles undefined config', () => {
      const result = mergeConfigWithFlags(undefined, defaultCliFlags);
      expect(result).toEqual(defaultCliFlags);
    });

    it('handles empty config object', () => {
      const result = mergeConfigWithFlags({}, defaultCliFlags);
      expect(result).toEqual(defaultCliFlags);
    });

    it('applies config dashboardPort when CLI has default', () => {
      const result = mergeConfigWithFlags({ dashboardPort: 9090 }, defaultCliFlags);
      expect(result.dashboardPort).toBe(9090);
    });

    it('applies config reportInterval when CLI has default', () => {
      const result = mergeConfigWithFlags({ reportInterval: 10000 }, defaultCliFlags);
      expect(result.reportInterval).toBe(10000);
    });

    it('ignores invalid outputFormat from config', () => {
      const result = mergeConfigWithFlags({ outputFormat: 'xml' }, defaultCliFlags);
      expect(result.outputFormat).toBe('console');
    });

    it('applies all config settings when CLI has all defaults', () => {
      const result = mergeConfigWithFlags(
        { enabled: true, outputFormat: 'both', retentionDays: 14, dashboardPort: 4000, reportInterval: 2000 },
        defaultCliFlags
      );
      expect(result.enableTelemetry).toBe(true);
      expect(result.outputFormat).toBe('both');
      expect(result.retentionDays).toBe(14);
      expect(result.dashboardPort).toBe(4000);
      expect(result.reportInterval).toBe(2000);
    });
  });

  describe('isAnyTelemetryEnabled', () => {
    it('returns true for --telemetry flag', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true for --enable-telemetry flag', () => {
      process.argv = ['node', 'script.js', '--enable-telemetry'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true for -t flag', () => {
      process.argv = ['node', 'script.js', '-t'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns false for --telemetry=true (not supported by isAnyTelemetryEnabled)', () => {
      process.argv = ['node', 'script.js', '--telemetry=true'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns false for --telemetry=1 (not supported by isAnyTelemetryEnabled)', () => {
      process.argv = ['node', 'script.js', '--telemetry=1'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns false for --telemetry=yes (not supported by isAnyTelemetryEnabled)', () => {
      process.argv = ['node', 'script.js', '--telemetry=yes'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns false for --telemetry=false', () => {
      process.argv = ['node', 'script.js', '--telemetry=false'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns false for --telemetry=0', () => {
      process.argv = ['node', 'script.js', '--telemetry=0'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns true for --profile flag', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns true for --debug flag', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });

    it('returns false when no telemetry flags present', () => {
      process.argv = ['node', 'script.js', '--output', 'file'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });

    it('returns false with empty argv beyond node/script', () => {
      process.argv = ['node', 'script.js'];
      expect(isAnyTelemetryEnabled()).toBe(false);
    });
  });
});
