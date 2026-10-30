import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();
const runnerPath = path.join(ROOT, 'validation/native/compare-native-football.cjs');
const { bits, inputsFor, parseArguments, SCENARIOS, SCOPE, TOLERANCE } = require(runnerPath) as {
  bits: (value: number) => Record<string, boolean>;
  inputsFor: (kind: string, tick: number) => number[];
  parseArguments: (
    argv: string[],
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => {
    paths: { rawPath: string; physicsPath?: string; trigPath?: string };
    scenarioNames: string[];
    tickLimit: number | null;
    negativeControl: boolean;
    negativeControlOnly: boolean;
  };
  SCENARIOS: readonly {
    name: string;
    kind: string;
    ticks: number;
    boundary: string;
  }[];
  SCOPE: string;
  TOLERANCE: number;
};

describe('native Football differential harness', () => {
  it('pins the bounded scope, tolerance, and complete scenario matrix', () => {
    expect(TOLERANCE).toBe(1e-9);
    expect(SCOPE).toContain('only src/core/football-physics.ts');
    expect(SCOPE).toContain('not public PhysicsEngine/environment integration');
    expect(SCENARIOS).toHaveLength(13);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(13);
    const kinds = [
      'football-kickoff-countdown',
      'football-movement-force',
      'football-kick-impulse',
      'football-kick-rearm',
      'football-action-slowdown',
      'football-action2-zero-force',
      'football-ball-wall-bounce',
      'football-player-goalpost-collision',
      'football-goal-left',
      'football-goal-right',
      'football-goal-freeze-reset',
      'football-clamp-to-pitch',
      'football-footbounce-sound',
    ];
    for (const kind of kinds) {
      expect(SCENARIOS.filter((scenario) => scenario.kind === kind)).toHaveLength(1);
    }
    expect(SCENARIOS.find(({ kind }) => kind === 'football-kickoff-countdown')).toMatchObject({
      ticks: 125,
      boundary: 'fresh-createNewState-countdown',
    });
    expect(SCENARIOS.find(({ kind }) => kind === 'football-goal-freeze-reset')).toMatchObject({
      ticks: 260,
    });
  });

  it('preserves six-bit inputs and native-only schedules', () => {
    expect(bits(1 | 2 | 32)).toEqual({
      left: true,
      right: true,
      up: false,
      down: false,
      action: false,
      action2: true,
    });
    expect(inputsFor('football-movement-force', 1)).toEqual([2, 0]);
    expect(inputsFor('football-kick-impulse', 1)).toEqual([16, 0]);
    expect(inputsFor('football-kick-rearm', 4)).toEqual([16, 0]);
    expect(inputsFor('football-kick-rearm', 5)).toEqual([0, 0]);
    expect(inputsFor('football-action-slowdown', 1)).toEqual([16 | 2, 0]);
    expect(inputsFor('football-action2-zero-force', 1)).toEqual([32 | 2, 0]);
    expect(inputsFor('football-kickoff-countdown', 1)).toEqual([0, 0]);
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
        '--scenario',
        'football-goal-left',
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
      scenarioNames: ['football-goal-left'],
      tickLimit: 48,
      negativeControl: true,
      negativeControlOnly: false,
    });
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
      schema: 'bonk-rl-env.native-football-differential',
      pass: false,
      status: 'BLOCKED',
      error: { code: 'NATIVE_DEPENDENCIES_MISSING' },
    });
    expect(report.error.message).toContain('BLOCKED: native comparison dependency is not a file');
  });
});
