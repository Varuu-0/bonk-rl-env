import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
});
