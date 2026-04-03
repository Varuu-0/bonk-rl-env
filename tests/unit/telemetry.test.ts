/**
 * telemetry.test.ts — TelemetryController and related tests
 *
 * Tests: TelemetryController singleton, disabled by default,
 * profiler wrap function, TelemetryFlags parsing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelemetryController,
  isTelemetryEnabled,
  getTelemetryController,
} from '../../src/telemetry/telemetry-controller';
import { globalProfiler, wrap, TelemetryIndices, TelemetryBuffer } from '../../src/telemetry/profiler';
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled } from '../../src/telemetry/flags';
import { resetConfig } from '../../src/config/config-loader';

describe('TelemetryController', () => {
  beforeEach(() => {
    TelemetryController.getInstance().shutdown();
  });

  afterEach(() => {
    TelemetryController.getInstance().shutdown();
  });

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const instance1 = TelemetryController.getInstance();
      const instance2 = TelemetryController.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('getTelemetryController returns the singleton', () => {
      const controller = getTelemetryController();
      expect(controller).toBe(TelemetryController.getInstance());
    });
  });

  describe('disabled by default', () => {
    it('isTelemetryEnabled returns false when no flags set', () => {
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('isEnabled returns false without CLI flags', () => {
      const controller = TelemetryController.getInstance();
      const flags = controller.getFlags();
      expect(flags.enableTelemetry).toBe(false);
    });
  });
});

describe('profiler wrap function', () => {
  beforeEach(() => {
    for (let i = 0; i < TelemetryBuffer.length; i++) {
      TelemetryBuffer[i] = BigInt(0);
    }
  });

  it('records time for sync functions', () => {
    const fn = () => {
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += i;
      return sum;
    };

    const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, fn);
    const result = wrapped();

    expect(result).toBe(4950);
    expect(TelemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBeGreaterThan(BigInt(0));
  });

  it('records time even when sync function throws', () => {
    const fn = () => { throw new Error('test error'); };
    const wrapped = wrap(TelemetryIndices.RAYCAST_CALL, fn);

    expect(() => wrapped()).toThrow('test error');
    expect(TelemetryBuffer[TelemetryIndices.RAYCAST_CALL]).toBeGreaterThan(BigInt(0));
  });

  it('records time for async functions', async () => {
    const fn = async () => {
      await new Promise(r => setTimeout(r, 1));
      return 'done';
    };

    const wrapped = wrap(TelemetryIndices.ZMQ_SEND, fn);
    const result = await wrapped();

    expect(result).toBe('done');
    expect(TelemetryBuffer[TelemetryIndices.ZMQ_SEND]).toBeGreaterThan(BigInt(0));
  });

  it('records time even when async function rejects', async () => {
    const fn = async () => { throw new Error('async error'); };
    const wrapped = wrap(TelemetryIndices.COLLISION_RESOLVE, fn);

    await expect(wrapped()).rejects.toThrow('async error');
    expect(TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE]).toBeGreaterThan(BigInt(0));
  });

  it('throws on unknown label', () => {
    expect(() => wrap('NONEXISTENT' as any, () => {})).toThrow('Unknown telemetry label');
  });
});

describe('TelemetryFlags parsing', () => {
  const originalArgv = process.argv;
  const envKeys = ['MANIFOLD_TELEMETRY', 'MANIFOLD_PROFILE', 'MANIFOLD_DEBUG', 'MANIFOLD_TELEMETRY_OUTPUT'];

  beforeEach(() => {
    for (const key of envKeys) delete (process.env as any)[key];
    resetConfig();
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const key of envKeys) delete (process.env as any)[key];
    resetConfig();
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const key of envKeys) delete (process.env as any)[key];
    resetConfig();
  });

  describe('parseFlags', () => {
    it('returns defaults with no CLI args', () => {
      process.argv = ['node', 'script.js'];
      const flags = parseFlags();

      expect(flags.enableTelemetry).toBe(false);
      expect(flags.profileLevel).toBe('standard');
      expect(flags.debugLevel).toBe('none');
      expect(flags.outputFormat).toBe('console');
      expect(flags.dashboardPort).toBe(3001);
      expect(flags.reportInterval).toBe(5000);
      expect(flags.retentionDays).toBe(7);
    });

    it('parses --telemetry flag', () => {
      process.argv = ['node', 'script.js', '--telemetry'];
      const flags = parseFlags();
      expect(flags.enableTelemetry).toBe(true);
    });

    it('parses -t alias', () => {
      process.argv = ['node', 'script.js', '-t'];
      const flags = parseFlags();
      expect(flags.enableTelemetry).toBe(true);
    });

    it('parses --profile flag', () => {
      process.argv = ['node', 'script.js', '--profile', 'detailed'];
      const flags = parseFlags();
      expect(flags.profileLevel).toBe('detailed');
    });

    it('parses --debug flag', () => {
      process.argv = ['node', 'script.js', '--debug', 'verbose'];
      const flags = parseFlags();
      expect(flags.debugLevel).toBe('verbose');
    });

    it('parses --dashboard-port flag', () => {
      process.argv = ['node', 'script.js', '--dashboard-port', '4000'];
      const flags = parseFlags();
      expect(flags.dashboardPort).toBe(4000);
    });

    it('warns on invalid profile level', () => {
      process.argv = ['node', 'script.js', '--profile', 'invalid'];
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const flags = parseFlags();
      warnSpy.mockRestore();

      expect(flags.profileLevel).toBe('standard');
    });
  });

  describe('applyEnvOverrides', () => {
    it('enables telemetry via MANIFOLD_TELEMETRY=true', () => {
      process.env.MANIFOLD_TELEMETRY = 'true';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(true);
    });

    it('disables telemetry via MANIFOLD_TELEMETRY=false', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      const flags = applyEnvOverrides({ enableTelemetry: true, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.enableTelemetry).toBe(false);
    });

    it('sets profile level via MANIFOLD_PROFILE', () => {
      process.env.MANIFOLD_PROFILE = 'minimal';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.profileLevel).toBe('minimal');
    });

    it('sets debug level via MANIFOLD_DEBUG', () => {
      process.env.MANIFOLD_DEBUG = 'error';
      const flags = applyEnvOverrides({ enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 });
      expect(flags.debugLevel).toBe('error');
    });
  });

  describe('mergeConfigWithFlags', () => {
    it('applies config when CLI uses defaults', () => {
      const cliFlags = { enableTelemetry: false, profileLevel: 'standard', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 };
      const config = { enabled: true, outputFormat: 'file' as const };

      const merged = mergeConfigWithFlags(config, cliFlags);
      expect(merged.enableTelemetry).toBe(true);
      expect(merged.outputFormat).toBe('file');
    });

    it('CLI flags take precedence over config', () => {
      const cliFlags = { enableTelemetry: true, profileLevel: 'detailed', debugLevel: 'none', outputFormat: 'console', dashboardPort: 3001, reportInterval: 5000, retentionDays: 7 };
      const config = { enabled: false };

      const merged = mergeConfigWithFlags(config, cliFlags);
      expect(merged.enableTelemetry).toBe(true);
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

    it('returns true with --profile flag', () => {
      process.argv = ['node', 'script.js', '--profile', 'minimal'];
      expect(isAnyTelemetryEnabled()).toBe(true);
    });
  });
});
