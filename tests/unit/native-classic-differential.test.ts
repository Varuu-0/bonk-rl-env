import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();
const { inputsFor, parseArguments, shouldSimulate, TOLERANCE } = require(
  path.join(ROOT, 'validation/native/compare-classic-native.cjs'),
) as {
  inputsFor: (name: string, tick: number) => number[];
  parseArguments: (
    argv: string[],
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => {
    paths: { rawPath: string; physicsPath?: string; trigPath?: string };
    negativeControl: boolean;
  };
  TOLERANCE: number;
  shouldSimulate: (state: { ftu: number; fte: number }) => boolean;
};

const { CASES: MATERIAL_CASES, materialMap } = require(
  path.join(ROOT, 'validation/native/compare-classic-materials.cjs'),
) as {
  CASES: readonly { name: string; friction: number; restitution: number }[];
  materialMap: (
    friction: number,
    restitution: number,
    quality: number,
  ) => {
    physics: { fixtures: { fr: number; fp: boolean; re: number }[] };
    s: { pq: number };
  };
};

const { CASES: SPARSE_CASES, parseArguments: parseSparseArguments } = require(
  path.join(ROOT, 'validation/native/compare-classic-sparse.cjs'),
) as {
  CASES: readonly { name: string; id: number; balance: number | undefined }[];
  parseArguments: (
    argv: string[],
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => {
    paths: { rawPath: string; physicsPath?: string; trigPath?: string };
    negativeControl: boolean;
  };
};

const { deathPoseMap, parseArguments: parseDeathPoseArguments } = require(
  path.join(ROOT, 'validation/native/compare-classic-death-pose.cjs'),
) as {
  deathPoseMap: (quality: number) => {
    physics: { fixtures: { d: boolean }[] };
    spawns: { x: number; y: number; xv: number; yv: number }[];
    s: { pq: number; re: boolean };
  };
  parseArguments: (
    argv: string[],
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => {
    paths: { rawPath: string; physicsPath?: string; trigPath?: string };
    negativeControl: boolean;
  };
};

const nativeSupplied = Boolean(process.env.BOX2D_REFERENCE_FILE && process.env.SAFETRIG_REFERENCE_FILE);

describe('isolated native Classic differential runner', () => {
  it('keeps the fixed tolerance and exercises native input precedence schedules', () => {
    expect(TOLERANCE).toBe(1e-9);
    expect(inputsFor('input-precedence', 80)).toEqual([1 | 2 | 4 | 8, 2 | 8]);
    expect(inputsFor('heavy', 20)).toEqual([2 | 16, 0]);
    expect(inputsFor('heavy', 130)).toEqual([2, 0]);
  });

  it('keeps simulating through the native result countdown after a death', () => {
    expect(shouldSimulate({ ftu: 0, fte: -1 })).toBe(false);
    expect(shouldSimulate({ ftu: -1, fte: -1 })).toBe(true);
    // Regression: the surviving second disc must move on the fte=90 -> 89
    // transition after the first disc falls out of the training arena.
    expect(shouldSimulate({ ftu: -1, fte: 90 })).toBe(true);
    expect(shouldSimulate({ ftu: -1, fte: 0 })).toBe(true);
  });

  it('keeps the signed-friction and high-restitution native fixture corpus explicit', () => {
    expect(MATERIAL_CASES.map(({ name, friction, restitution }) => ({ name, friction, restitution }))).toEqual([
      { name: 'negative-friction', friction: -0.3, restitution: 0 },
      { name: 'restitution-over-one', friction: 0.5, restitution: 1.25 },
      { name: 'in-range-control', friction: 0.5, restitution: 0.8 },
    ]);
    const map = materialMap(-0.3, 1.25, 2);
    expect(map.physics.fixtures[0]).toMatchObject({ fr: -0.3, fp: false, re: 1.25 });
    expect(map.s.pq).toBe(2);
  });

  it('fails explicitly when native dependencies are not supplied', () => {
    expect(() => parseArguments([], {}, ROOT)).toThrow(/BLOCKED: native comparison dependencies are required/);
    const parsed = parseArguments(['--box2d', 'solver.js', '--safe-trig', 'trig.js', '--negative-control'], {}, ROOT);
    expect(parsed.paths.physicsPath).toMatch(/solver\.js$/);
    expect(parsed.paths.trigPath).toMatch(/trig\.js$/);
    expect(parsed.paths.rawPath).toMatch(/\.deobf[\\/]alpha2s\.raw\.js$/);
    expect(parsed.negativeControl).toBe(true);
  });

  it('keeps sparse ID and lethal-respawn native coverage explicit', () => {
    expect(SPARSE_CASES.map(({ id, balance }) => ({ id, balance: balance ?? null }))).toEqual([
      { id: 1, balance: 100 },
      { id: 1, balance: null },
      { id: 19, balance: 100 },
      { id: 19, balance: null },
      { id: 3, balance: 100 },
      { id: 3, balance: null },
    ]);
    const map = deathPoseMap(2);
    expect(map.physics.fixtures[0].d).toBe(true);
    expect(map.spawns[0]).toMatchObject({ x: 0, y: -24, xv: 12, yv: -36 });
    expect(map.s).toMatchObject({ pq: 2, re: true });
    for (const parse of [parseSparseArguments, parseDeathPoseArguments]) {
      expect(() => parse([], {}, ROOT)).toThrow(/BLOCKED/);
      const parsed = parse(['--box2d', 'solver.js', '--safe-trig', 'trig.js'], {}, ROOT);
      expect(parsed.paths.physicsPath).toMatch(/solver\.js$/);
      expect(parsed.paths.trigPath).toMatch(/trig\.js$/);
      expect(parsed.negativeControl).toBe(true);
    }
  });

  it.runIf(nativeSupplied)('matches pinned native static-material contact trajectories', () => {
    const output = execFileSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.join(ROOT, 'validation/native/compare-classic-materials.cjs'),
        '--box2d',
        process.env.BOX2D_REFERENCE_FILE!,
        '--safe-trig',
        process.env.SAFETRIG_REFERENCE_FILE!,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    const report = JSON.parse(output) as {
      pass: boolean;
      totals: { scenarios: number; ticks: number; maximumAbsoluteError: number };
      scenarios: { quality: number; coverage: { simulatedTicks: number; materialResponseTicks: number } }[];
      negativeControl: { detected: boolean };
    };
    expect(report.pass).toBe(true);
    expect(report.totals).toMatchObject({ scenarios: 6, ticks: 720, maximumAbsoluteError: 0 });
    expect(report.scenarios.map((scenario) => scenario.quality)).toEqual([1, 1, 1, 2, 2, 2]);
    for (const scenario of report.scenarios) {
      expect(scenario.coverage.simulatedTicks).toBe(120);
      expect(scenario.coverage.materialResponseTicks).toBeGreaterThan(0);
    }
    expect(report.negativeControl.detected).toBe(true);
  });

  it.runIf(nativeSupplied)('matches original death presentation before immediate respawn', () => {
    const output = execFileSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.join(ROOT, 'validation/native/compare-classic-death-pose.cjs'),
        '--box2d',
        process.env.BOX2D_REFERENCE_FILE!,
        '--safe-trig',
        process.env.SAFETRIG_REFERENCE_FILE!,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    const report = JSON.parse(output) as {
      pass: boolean;
      totals: {
        scenarios: number;
        ticks: number;
        lethalDeaths: number;
        respawns: number;
        maximumAbsoluteError: number;
      };
      scenarios: { quality: number; coverage: { deathDiffersFromRestoredLiveDisc: boolean; roundRollovers: number } }[];
      negativeControl: { detected: boolean };
    };
    expect(report.pass).toBe(true);
    expect(report.totals).toMatchObject({
      scenarios: 2,
      ticks: 2,
      lethalDeaths: 2,
      respawns: 2,
      maximumAbsoluteError: 0,
    });
    expect(report.scenarios.map((scenario) => scenario.quality)).toEqual([1, 2]);
    for (const scenario of report.scenarios) {
      expect(scenario.coverage.deathDiffersFromRestoredLiveDisc).toBe(true);
      expect(scenario.coverage.roundRollovers).toBe(0);
    }
    expect(report.negativeControl.detected).toBe(true);
  });

  // Opt-in native evidence is never a default skipped test or a self-comparison.
  // CI invokes the CLI only when all pinned native artifacts are supplied.
  it.runIf(nativeSupplied)('rejects an injected native/local velocity discrepancy', () => {
    const output = execFileSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.join(ROOT, 'validation/native/compare-classic-native.cjs'),
        '--box2d',
        process.env.BOX2D_REFERENCE_FILE!,
        '--safe-trig',
        process.env.SAFETRIG_REFERENCE_FILE!,
        '--ticks',
        '1',
        '--negative-control-only',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    const report = JSON.parse(output) as {
      pass: boolean;
      negativeControl: { pass: boolean; firstMismatch: { field: string; error: number } };
    };
    expect(report.pass).toBe(true);
    expect(report.negativeControl.pass).toBe(true);
    expect(report.negativeControl.firstMismatch.field).toBe('xv');
    expect(report.negativeControl.firstMismatch.error).toBeGreaterThan(TOLERANCE);
  });
});
