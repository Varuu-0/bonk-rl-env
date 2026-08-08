/**
 * telemetry-argv-cache.test.ts — Regression coverage for issue #237
 *
 * Before the fix, TelemetryController.isEnabled() fell back to scanning
 * process.argv on every call because cachedFlags was never populated, and the
 * physics hot path (hook trampoline + per-tick telemetry gauge) invoked it on
 * every tick. This pins down that process.argv is never rescanned per tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

const mocks = vi.hoisted(() => ({
  isAnyTelemetryEnabled: vi.fn(() => false),
}));

vi.mock('../../src/telemetry/flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/telemetry/flags')>();
  return { ...actual, isAnyTelemetryEnabled: mocks.isAnyTelemetryEnabled };
});

import { TelemetryController, getTelemetryController } from '../../src/telemetry/telemetry-controller';

describe('telemetry process.argv caching (issue #237)', () => {
  beforeEach(() => {
    TelemetryController.getInstance().shutdown();
    mocks.isAnyTelemetryEnabled.mockClear();
  });

  afterEach(() => {
    TelemetryController.getInstance().shutdown();
  });

  it('never scans process.argv once the controller is initialized (server wiring)', () => {
    // Production wiring: the server initializes the controller once at startup.
    getTelemetryController().initialize({ enabled: false });
    mocks.isAnyTelemetryEnabled.mockClear();

    const env = new BonkEnvironment({ numOpponents: 0, randomOpponent: false, maxTicks: 30 });
    env.reset();
    for (let i = 0; i < 30; i++) {
      env.step(0);
    }
    env.close();

    expect(mocks.isAnyTelemetryEnabled).not.toHaveBeenCalled();
  });

  it('scans process.argv at most once even without initialization', () => {
    // Worst case (library use without a server): the first fallback scan is
    // cached, so physics ticks never rescan process.argv per tick.
    const env = new BonkEnvironment({ numOpponents: 0, randomOpponent: false, maxTicks: 30 });
    env.reset();
    for (let i = 0; i < 30; i++) {
      env.step(0);
    }
    env.close();

    expect(mocks.isAnyTelemetryEnabled.mock.calls.length).toBeLessThanOrEqual(1);
  });
});