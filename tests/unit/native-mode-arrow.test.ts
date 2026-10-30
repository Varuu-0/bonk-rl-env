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

type NativeReport = {
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
      maxDraw: number;
      releaseTicks: number[];
      postFireEnergies: number[];
      firedOwners: number[];
      firedTeams: number[];
      projectileZeroTicks: number;
      projectileExpiryTicks: number;
      ownerIgnored: boolean;
      teammatePassed: boolean;
      enemyAffected: boolean;
      targetDeaths: number;
      nativeWorldBounceTicks: number;
      aimWraps: number;
    };
  }[];
  negativeControl: { pass: boolean; detected: boolean } | null;
  error?: { message: string };
};

// Deliberately unconditional: absent pinned artifacts produce a visible BLOCKED
// failure from the CLI, never a skipped or self-generated native PASS.
describe('original-native Arrow and Death Arrow differential', () => {
  it('matches every bounded Arrow/Death Arrow scenario and detects the negative control', () => {
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
        'arrow',
        '--negative-control',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    const output = result.stdout || result.stderr;
    expect(output, 'native runner must emit a JSON receipt').not.toBe('');
    const report = JSON.parse(output) as NativeReport;
    expect(report.schema).toBe('bonk-rl-env.native-mode-differential');
    expect(report.originalOnlyExpectedValues).toBe(true);
    expect(report.publicEngineParityClaimed).toBe(false);
    expect(report.bitParityClaimed).toBe(false);
    expect(report.totals.scenarios).toBe(32);
    expect(report.totals.comparisons).toBeGreaterThan(0);
    expect(report.totals.localRepairOrReseeds).toBe(0);
    expect(report.negativeControl).toMatchObject({ pass: true, detected: true });

    const failures = report.scenarios
      .filter((scenario) => !scenario.pass)
      .map((scenario) => ({
        name: scenario.name,
        firstMismatch: scenario.firstMismatch,
      }));
    expect(report.pass, JSON.stringify({ status: report.status, error: report.error, failures }, null, 2)).toBe(true);
    expect(report.status).toBe('PASS');
    expect(report.totals).toMatchObject({ passed: 32, failed: 0, coverageFailures: 0 });
    expect(report.totals.maximumAbsoluteError).toBeLessThanOrEqual(1e-9);

    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('arrow-charge-release'))) {
      expect(scenario.coverage).toMatchObject({
        maxDraw: 100,
        releaseTicks: [261],
        postFireEnergies: [500],
        firedOwners: [0],
        firedTeams: [1],
      });
      expect(scenario.coverage.projectileZeroTicks).toBeGreaterThan(0);
      expect(scenario.coverage.projectileExpiryTicks).toBeGreaterThan(0);
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('arrow-owner-ffa'))) {
      expect(scenario.coverage.ownerIgnored).toBe(true);
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('arrow-team-filter'))) {
      expect(scenario.coverage.teammatePassed).toBe(true);
      expect(scenario.coverage.enemyAffected).toBe(true);
      if (scenario.name.includes('-ard-')) expect(scenario.coverage.targetDeaths).toBeGreaterThan(0);
    }
    for (const scenario of report.scenarios.filter(({ name }) => name.startsWith('arrow-world-impact'))) {
      expect(scenario.coverage.nativeWorldBounceTicks).toBeGreaterThan(0);
    }
  }, 260_000);
});
