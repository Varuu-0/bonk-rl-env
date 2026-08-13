import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TEST_SUITES, resolveVitestCli } from '../runner';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const focusedSuiteScripts = {
  'test:physics': 'tests/unit/physics-engine.test.ts',
  'test:prng': 'tests/unit/prng.test.ts',
  'test:env': 'tests/integration/bonk-env.test.ts',
  'test:frameskip': 'tests/integration/frame-skip.test.ts',
  'test:shared': 'tests/integration/shared-memory.test.ts',
  'test:manager': 'tests/integration/env-manager.test.ts',
  'test:map-types': 'tests/integration/map-body-types.test.ts',
  'test:collision': 'tests/integration/collision-filtering.test.ts',
  'test:nophysics': 'tests/integration/nophysics-friction.test.ts',
  'test:grapple': 'tests/integration/grapple-mechanics.test.ts',
  'test:bounds': 'tests/integration/dynamic-arena-bounds.test.ts',
} as const;

describe('npm test script mappings', () => {
  it.each(Object.entries(focusedSuiteScripts))('%s targets an existing Vitest suite', (scriptName, testFile) => {
    expect(packageJson.scripts[scriptName]).toBe(`vitest run ${testFile}`);
    expect(fs.existsSync(path.join(repositoryRoot, testFile))).toBe(true);
  });

  it('runs the current integration directory for test:integration', () => {
    expect(packageJson.scripts['test:integration']).toBe('vitest run tests/integration/');
    expect(fs.existsSync(path.join(repositoryRoot, 'tests', 'integration'))).toBe(true);
  });

  it('keeps the legacy CLI aliases backed by the compatibility runner', () => {
    expect(fs.existsSync(path.join(repositoryRoot, 'tests', 'runner.ts'))).toBe(true);
    expect(packageJson.scripts['test:legacy']).toBe('npx tsx tests/runner.ts all');
    expect(packageJson.scripts['test:runner']).toBe('npx tsx tests/runner.ts');
    expect(packageJson.scripts['test:list']).toBe('npx tsx tests/runner.ts list');
  });

  it('maps numeric TEST_SUITES keys to existing suites consistent with the per-suite scripts', () => {
    const scriptFiles = Object.values(focusedSuiteScripts);
    const numericFiles = [...scriptFiles, 'tests/integration/map-integration.test.ts'];
    expect(TEST_SUITES.map((suite) => suite.key)).toEqual(numericFiles.map((_, index) => String(index + 1)));
    expect(TEST_SUITES.map((suite) => suite.file)).toEqual(numericFiles);
    for (const suite of TEST_SUITES) {
      expect(fs.existsSync(path.join(repositoryRoot, suite.file))).toBe(true);
    }
  });

  it('resolves the local vitest CLI entry to a runnable subprocess', () => {
    const cli = resolveVitestCli();
    expect(fs.existsSync(cli)).toBe(true);
    const result = spawnSync(process.execPath, [cli, '--version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/vitest\/\d+/);
  });

  it('reports a clear error for a missing or malformed vitest bin entry', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-bin-fixture-'));
    try {
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'vitest' }));
      expect(() => resolveVitestCli(fixture)).toThrow(/bin\.vitest/);

      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ bin: {} }));
      expect(() => resolveVitestCli(fixture)).toThrow(/bin\.vitest/);

      fs.writeFileSync(path.join(fixture, 'package.json'), '{ not json');
      expect(() => resolveVitestCli(fixture)).toThrow(/vitest package manifest/);

      fs.rmSync(path.join(fixture, 'package.json'));
      expect(() => resolveVitestCli(fixture)).toThrow(/vitest package manifest/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
