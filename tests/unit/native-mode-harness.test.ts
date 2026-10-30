import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();
const runnerPath = path.join(ROOT, 'validation/native/compare-native-modes.cjs');
const { bits, inputsFor, parseArguments, SCENARIOS, SCOPE, TOLERANCE } = require(runnerPath) as {
  bits: (value: number) => Record<string, boolean>;
  inputsFor: (scenario: { kind: string }, tick: number) => number[];
  parseArguments: (
    argv: string[],
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => {
    paths: { rawPath: string; physicsPath?: string; trigPath?: string };
    group: string;
    scenarioNames: string[];
    tickLimit: number | null;
    negativeControl: boolean;
    negativeControlOnly: boolean;
  };
  SCENARIOS: readonly {
    name: string;
    kind: string;
    group: 'arrow' | 'vtol' | 'grapple' | 'simple' | 'sweep';
    mode: 'ar' | 'ard' | 'v' | 'sp' | 'bs' | 'b';
    quality: 1 | 2;
    ticks: number;
    boundary: string;
    seed?: number;
    balances?: number[];
  }[];
  SCOPE: string;
  TOLERANCE: number;
};

describe('native Arrow/Death Arrow/VTOL differential harness', () => {
  it('pins the bounded scope, tolerance, and complete scenario matrix', () => {
    expect(TOLERANCE).toBe(1e-9);
    expect(SCOPE).toContain('only src/core/classic-physics.ts');
    expect(SCOPE).toContain('not public PhysicsEngine/environment integration');
    expect(SCENARIOS).toHaveLength(73);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(73);
    expect(SCENARIOS.filter((scenario) => scenario.group === 'arrow')).toHaveLength(32);
    expect(SCENARIOS.filter((scenario) => scenario.group === 'vtol')).toHaveLength(10);
    expect(SCENARIOS.filter((scenario) => scenario.group === 'grapple')).toHaveLength(18);
    expect(SCENARIOS.filter((scenario) => scenario.group === 'simple')).toHaveLength(8);
    // W6 sweep group: seed/roster/balance parameter sweeps beyond seed 1.
    expect(SCENARIOS.filter((scenario) => scenario.group === 'sweep')).toHaveLength(5);
    expect(SCENARIOS.filter((scenario) => scenario.group === 'sweep').every((scenario) => scenario.mode === 'b')).toBe(
      true,
    );
    expect(SCENARIOS.find((scenario) => scenario.name === 'sweep-balance-positive-b-q1')?.balances).toEqual([50, 50]);
    expect(SCENARIOS.find((scenario) => scenario.name === 'sweep-balance-negative-b-q1')?.balances).toEqual([-80, -80]);
    expect(SCENARIOS.find((scenario) => scenario.name === 'sweep-roster-three-b-q1')?.seed).toBe(7);
    expect(SCENARIOS.find((scenario) => scenario.name === 'sweep-roster-four-teams-b-q1')?.seed).toBe(13);
    expect(SCENARIOS.find((scenario) => scenario.name === 'sweep-seed-97-b-q1')?.seed).toBe(97);

    const grappleKinds = [
      'grapple-acquire-static',
      'grapple-acquire-inner',
      'grapple-acquire-nograpple',
      'grapple-slack-taut',
      'grapple-release-button',
      'grapple-break-collision',
      'grapple-break-impulse',
      'grapple-energy-depletion',
      'grapple-target-death',
    ];
    for (const kind of grappleKinds) {
      const scenarios = SCENARIOS.filter((scenario) => scenario.kind === kind);
      expect(scenarios.map(({ mode, quality }) => `${mode}-q${quality}`)).toEqual(['sp-q1', 'sp-q2']);
    }

    const simpleKinds = ['simple-movement', 'simple-heavy-frozen', 'simple-energy-frozen', 'simple-disc-collision'];
    for (const kind of simpleKinds) {
      const scenarios = SCENARIOS.filter((scenario) => scenario.kind === kind);
      expect(scenarios.map(({ mode, quality }) => `${mode}-q${quality}`)).toEqual(['bs-q1', 'bs-q2']);
    }

    const arrowKinds = [
      'arrow-charge-release',
      'arrow-aim-simultaneous',
      'arrow-owner-ffa',
      'arrow-disc-impact',
      'arrow-team-filter',
      'arrow-world-impact',
      'arrow-projectile-expiry',
      'arrow-dual-release',
    ];
    const vtolKinds = [
      'vtol-directional',
      'vtol-rotated',
      'vtol-wing-world',
      'vtol-wing-kinematics',
      'vtol-disc-collision',
    ];
    for (const kind of arrowKinds) {
      const scenarios = SCENARIOS.filter((scenario) => scenario.kind === kind);
      expect(scenarios.map(({ mode, quality }) => `${mode}-q${quality}`)).toEqual([
        'ar-q1',
        'ar-q2',
        'ard-q1',
        'ard-q2',
      ]);
    }
    for (const kind of vtolKinds) {
      const scenarios = SCENARIOS.filter((scenario) => scenario.kind === kind);
      expect(scenarios.map(({ mode, quality }) => `${mode}-q${quality}`)).toEqual(['v-q1', 'v-q2']);
    }
    expect(SCENARIOS.find(({ kind }) => kind === 'arrow-charge-release')).toMatchObject({
      ticks: 422,
      boundary: 'fresh-createNewState-countdown',
    });
    expect(SCENARIOS.find(({ kind }) => kind === 'vtol-directional')).toMatchObject({
      ticks: 145,
      boundary: 'fresh-createNewState-countdown',
    });
  });

  it('preserves six-bit inputs and native-only direction/charge schedules', () => {
    expect(bits(1 | 2 | 32)).toEqual({
      left: true,
      right: true,
      up: false,
      down: false,
      action: false,
      action2: true,
    });
    expect(inputsFor({ kind: 'arrow-charge-release' }, 260)).toEqual([32, 0]);
    expect(inputsFor({ kind: 'arrow-charge-release' }, 261)).toEqual([0, 0]);
    expect(inputsFor({ kind: 'arrow-aim-simultaneous' }, 1)).toEqual([1 | 2 | 32, 0]);
    expect(inputsFor({ kind: 'vtol-directional' }, 60)).toEqual([0]);
    expect(inputsFor({ kind: 'vtol-directional' }, 61)).toEqual([0]);
    expect(inputsFor({ kind: 'vtol-directional' }, 66)).toEqual([4]);
    expect(inputsFor({ kind: 'vtol-directional' }, 126)).toEqual([16 | 4]);
    expect(inputsFor({ kind: 'vtol-directional' }, 131)).toEqual([0]);
  });

  it('parses explicit dependencies and rejects invalid selectors', () => {
    expect(() => parseArguments([], {}, ROOT)).toThrow(/BLOCKED: native comparison dependencies are required/);
    const parsed = parseArguments(
      [
        '--raw',
        'raw.js',
        '--box2d',
        'solver.js',
        '--safe-trig',
        'trig.js',
        '--group',
        'vtol',
        '--scenario',
        'vtol-rotated-v-q2',
        '--ticks',
        '48',
        '--negative-control',
      ],
      {},
      ROOT,
    );
    expect(parsed.paths.rawPath).toBe(path.resolve(ROOT, 'raw.js'));
    expect(parsed.paths.physicsPath).toBe(path.resolve(ROOT, 'solver.js'));
    expect(parsed.paths.trigPath).toBe(path.resolve(ROOT, 'trig.js'));
    expect(parsed).toMatchObject({
      group: 'vtol',
      scenarioNames: ['vtol-rotated-v-q2'],
      tickLimit: 48,
      negativeControl: true,
      negativeControlOnly: false,
    });
    expect(() => parseArguments(['--box2d', 'b', '--safe-trig', 't', '--group', 'other'], {}, ROOT)).toThrow(
      /--group must be/,
    );
    expect(() => parseArguments(['--box2d', 'b', '--safe-trig', 't', '--scenario', 'unknown'], {}, ROOT)).toThrow(
      /Unknown scenario/,
    );
    expect(() => parseArguments(['--box2d', 'b', '--safe-trig', 't', '--ticks', '0'], {}, ROOT)).toThrow(
      /--ticks must be/,
    );
  });

  it('returns BLOCKED and nonzero for missing native artifacts instead of skipping', () => {
    const missing = (name: string) => path.join(ROOT, 'validation/native', `__missing-${name}__`);
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        runnerPath,
        '--raw',
        missing('raw.js'),
        '--box2d',
        missing('box2d.js'),
        '--safe-trig',
        missing('trig.js'),
        '--negative-control-only',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    const report = JSON.parse(result.stderr) as {
      schema: string;
      pass: boolean;
      status: string;
      error: { code: string; message: string };
    };
    expect(report).toMatchObject({
      schema: 'bonk-rl-env.native-mode-differential',
      pass: false,
      status: 'BLOCKED',
      error: { code: 'NATIVE_DEPENDENCIES_MISSING' },
    });
    expect(report.error.message).toContain('BLOCKED: native comparison dependency is not a file');
  });
});
