import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();
const nativePaths = {
  raw: process.env.BONK_RAW_REFERENCE_FILE || path.join(ROOT, '.deobf/alpha2s.raw.js'),
  box2d: process.env.BOX2D_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/Box2DModuleGJMod.js'),
  trig: process.env.SAFETRIG_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/SafeTrig.js'),
};

type VtolReport = {
  schema: string;
  pass: boolean;
  status: string;
  originalOnlyExpectedValues: boolean;
  publicEngineParityClaimed: boolean;
  bitParityClaimed: boolean;
  totals: {
    scenarios: number;
    passed: number;
    failed: number;
    comparisons: number;
    maximumAbsoluteError: number;
    coverageFailures: number;
    localRepairOrReseeds: number;
  };
  scenarios: {
    name: string;
    pass: boolean;
    firstMismatch: unknown;
    coverage: {
      vtStates: number[];
      heavyTicks: number;
      minEnergy: number;
      nativeDeathEvents: number;
      nonzeroAngularTicks: number;
      lastHitTicks: number;
      nativeWingWorldContacts: number;
      nativeWingDiscContacts: number;
      nativeWingWingContacts: number;
      nativeDiscBodyWorldContacts: number;
      nativeDiscBodyDiscContacts: number;
      nativeDeathKinds: { lethalContact: number };
    };
  }[];
  error?: { message: string };
};

// Deliberately unconditional: absent pinned artifacts produce a visible BLOCKED
// failure from the CLI, never a skipped or self-generated native PASS.
describe('original-native VTOL differential', () => {
  it('matches directional forces, rotation, wing contacts, lethality, and disc collisions', () => {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.join(ROOT, 'validation/native/compare-native-modes.cjs'),
        '--raw',
        nativePaths.raw,
        '--box2d',
        nativePaths.box2d,
        '--safe-trig',
        nativePaths.trig,
        '--group',
        'vtol',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    const output = result.stdout || result.stderr;
    expect(output, 'native runner must emit a JSON receipt').not.toBe('');
    const report = JSON.parse(output) as VtolReport;
    expect(report.schema).toBe('bonk-rl-env.native-mode-differential');
    expect(report.originalOnlyExpectedValues).toBe(true);
    expect(report.publicEngineParityClaimed).toBe(false);
    expect(report.bitParityClaimed).toBe(false);
    expect(report.totals.scenarios).toBe(10);
    expect(report.totals.comparisons).toBeGreaterThan(0);
    expect(report.totals.localRepairOrReseeds).toBe(0);

    const failures = report.scenarios
      .filter((scenario) => !scenario.pass)
      .map((scenario) => ({
        name: scenario.name,
        firstMismatch: scenario.firstMismatch,
      }));
    expect(report.pass, JSON.stringify({ status: report.status, error: report.error, failures }, null, 2)).toBe(true);
    expect(report.status).toBe('PASS');
    expect(report.totals).toMatchObject({ passed: 10, failed: 0, coverageFailures: 0 });
    expect(report.totals.maximumAbsoluteError).toBeLessThanOrEqual(1e-9);

    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('vtol-directional'))) {
      expect(scenario.coverage.vtStates).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(scenario.coverage).toMatchObject({ heavyTicks: 5, minEnergy: 950, nativeDeathEvents: 0 });
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('vtol-rotated'))) {
      expect(scenario.coverage.nonzeroAngularTicks).toBeGreaterThan(0);
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('vtol-wing-world'))) {
      expect(scenario.coverage.nativeWingWorldContacts).toBeGreaterThan(0);
      expect(scenario.coverage.nativeDiscBodyWorldContacts).toBe(0);
      expect(scenario.coverage).toMatchObject({ nativeDeathEvents: 1, nativeDeathKinds: { lethalContact: 1 } });
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('vtol-wing-kinematics'))) {
      expect(scenario.coverage.nativeWingWorldContacts).toBeGreaterThan(0);
      expect(scenario.coverage.nativeDiscBodyWorldContacts).toBe(0);
      expect(scenario.coverage.nonzeroAngularTicks).toBeGreaterThan(0);
      expect(scenario.coverage.nativeDeathEvents).toBe(0);
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('vtol-disc-collision'))) {
      expect(scenario.coverage.nativeWingDiscContacts).toBeGreaterThan(0);
      expect(scenario.coverage.nativeWingWingContacts).toBeGreaterThan(0);
      expect(scenario.coverage.nativeDiscBodyDiscContacts).toBe(0);
      expect(scenario.coverage.lastHitTicks).toBeGreaterThan(0);
      expect(scenario.coverage.nonzeroAngularTicks).toBeGreaterThan(0);
    }
  }, 260_000);
});
