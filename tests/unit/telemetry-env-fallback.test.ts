/**
 * telemetry-env-fallback.test.ts — Regression coverage for issue #389
 *
 * Before the fix, MANIFOLD_PROFILE / MANIFOLD_DEBUG only activated telemetry
 * through TelemetryController.initialize(), which only the standalone server
 * (src/server.ts) calls. Worker threads (WorkerPool) and embedded programmatic
 * usage run the un-initialized fallback path, whose isAnyTelemetryEnabled()
 * scan read process.argv exclusively — so the env vars stayed inert there.
 * These tests pin the worker-style fallback context (fresh module state, no
 * CLI flags, env-only activation), the explicit MANIFOLD_TELEMETRY=false
 * master switch, argv parity, and the one-time activation cache (issue #237).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TelemetryController,
  isTelemetryEnabled,
} from '../../src/telemetry/telemetry-controller';

const envKeys = ['MANIFOLD_TELEMETRY', 'MANIFOLD_PROFILE', 'MANIFOLD_DEBUG', 'MANIFOLD_TELEMETRY_OUTPUT'];
const originalArgv = process.argv;

function clearTelemetryEnv(): void {
  for (const key of envKeys) delete (process.env as any)[key];
}

describe('telemetry activation without initialize() (worker/embedded fallback, issue #389)', () => {
  beforeEach(() => {
    // A worker isolate starts with cachedFlags null and never calls
    // initialize(); shutdown() resets the in-process singleton to that same
    // state, so these tests exercise the identical fallback path.
    TelemetryController.getInstance().shutdown();
    clearTelemetryEnv();
    process.argv = ['node', 'worker.js'];
  });

  afterEach(() => {
    TelemetryController.getInstance().shutdown();
    clearTelemetryEnv();
    process.argv = originalArgv;
  });

  describe('env-only activation (no argv flags)', () => {
    it('MANIFOLD_PROFILE=standard enables telemetry on the fallback path', () => {
      process.env.MANIFOLD_PROFILE = 'standard';
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('MANIFOLD_DEBUG=error enables telemetry on the fallback path', () => {
      process.env.MANIFOLD_DEBUG = 'error';
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('MANIFOLD_DEBUG=none is a valid selection and still enables (mirrors --debug none)', () => {
      process.env.MANIFOLD_DEBUG = 'none';
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('MANIFOLD_TELEMETRY=1 alone enables telemetry', () => {
      process.env.MANIFOLD_TELEMETRY = '1';
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('uppercase MANIFOLD_TELEMETRY=TRUE alone enables telemetry (case-insensitive, like config-loader)', () => {
      process.env.MANIFOLD_TELEMETRY = 'TRUE';
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('uppercase MANIFOLD_TELEMETRY=NO alone leaves telemetry disabled', () => {
      process.env.MANIFOLD_TELEMETRY = 'NO';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('invalid MANIFOLD_PROFILE/MANIFOLD_DEBUG values do not enable telemetry', () => {
      process.env.MANIFOLD_PROFILE = 'extreme';
      process.env.MANIFOLD_DEBUG = 'trace';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('MANIFOLD_TELEMETRY_OUTPUT alone does not enable telemetry', () => {
      process.env.MANIFOLD_TELEMETRY_OUTPUT = 'file';
      expect(isTelemetryEnabled()).toBe(false);
    });
  });

  describe('explicit MANIFOLD_TELEMETRY=false master switch', () => {
    it('disables telemetry even when MANIFOLD_PROFILE is set', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      process.env.MANIFOLD_PROFILE = 'standard';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('disables telemetry even when MANIFOLD_DEBUG is set', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      process.env.MANIFOLD_DEBUG = 'verbose';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('uppercase MANIFOLD_TELEMETRY=FALSE disables telemetry even when MANIFOLD_PROFILE is set', () => {
      process.env.MANIFOLD_TELEMETRY = 'FALSE';
      process.env.MANIFOLD_PROFILE = 'standard';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('disables telemetry even when argv carries --profile (env wins, like initialize())', () => {
      process.env.MANIFOLD_TELEMETRY = 'false';
      process.argv = ['node', 'worker.js', '--profile', 'detailed'];
      expect(isTelemetryEnabled()).toBe(false);
    });
  });

  describe('CLI/argv behavior unchanged on the fallback path', () => {
    it('--profile detailed enables telemetry without env vars', () => {
      process.argv = ['node', 'worker.js', '--profile', 'detailed'];
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('--debug verbose enables telemetry without env vars', () => {
      process.argv = ['node', 'worker.js', '--debug', 'verbose'];
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('--telemetry enables telemetry without env vars', () => {
      process.argv = ['node', 'worker.js', '--telemetry'];
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('no flags and no env vars leave telemetry disabled', () => {
      expect(isTelemetryEnabled()).toBe(false);
    });
  });

  describe('one-time activation cache (issue #237 hot path)', () => {
    it('caches the env-aware result and does not rescan per call', () => {
      process.env.MANIFOLD_PROFILE = 'standard';
      expect(isTelemetryEnabled()).toBe(true);

      // A worker isolate's environment would not change mid-run, but even if
      // it did, the cached fallback must stay sticky so the hot path never
      // rescans process.argv/process.env per tick.
      delete (process.env as any).MANIFOLD_PROFILE;
      expect(isTelemetryEnabled()).toBe(true);

      // A fresh context (shutdown resets the fallback) re-resolves activation.
      TelemetryController.getInstance().shutdown();
      expect(isTelemetryEnabled()).toBe(false);
    });
  });
});