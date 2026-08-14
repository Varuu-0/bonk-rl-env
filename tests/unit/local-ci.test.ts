import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attributeDomain, changedFiles, parseVitestJson } from '../../scripts/local-ci';

describe('local-ci: attributeDomain file classification', () => {
  it('maps fidelity suites to the differential fidelity domain', () => {
    expect(attributeDomain('tests/integration/physics-fidelity-p4.test.ts')).toBe('fidelity');
    expect(attributeDomain('tests/integration/physics-fidelity-p2b.test.ts')).toBe('fidelity');
  });

  it('maps worker/ipc/shared-memory suites to the worker pool & IPC domain', () => {
    expect(attributeDomain('tests/integration/worker-pool-errors.test.ts')).toBe('worker-ipc');
    expect(attributeDomain('tests/integration/ipc-bridge-restart.test.ts')).toBe('worker-ipc');
    expect(attributeDomain('tests/integration/shared-memory.test.ts')).toBe('worker-ipc');
    expect(attributeDomain('tests/unit/port-manager.test.ts')).toBe('worker-ipc');
  });

  it('maps renderer suites to the detached renderer domain', () => {
    expect(attributeDomain('tests/integration/render-math.test.ts')).toBe('renderer');
    expect(attributeDomain('tests/integration/snapshot-ring.test.ts')).toBe('renderer');
    expect(attributeDomain('tests/integration/map-geometry.test.ts')).toBe('renderer');
    expect(attributeDomain('tests/integration/sim-layer.test.ts')).toBe('renderer');
  });

  it('maps security/property/perf suites to the security & property domain', () => {
    expect(attributeDomain('tests/security/input-validation.test.ts')).toBe('security');
    expect(attributeDomain('tests/property/map-invariants.test.ts')).toBe('security');
    expect(attributeDomain('tests/perf/memory-stability.test.ts')).toBe('security');
  });

  it('maps remaining test suites to the core physics domain', () => {
    expect(attributeDomain('tests/unit/physics-engine.test.ts')).toBe('physics');
    expect(attributeDomain('tests/integration/map-body-types.test.ts')).toBe('physics');
    expect(attributeDomain('tests/integration/frame-skip.test.ts')).toBe('physics');
  });
});

describe('local-ci: parseVitestJson', () => {
  it('parses vitest json testResults with per-file statuses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonk-ci-json-'));
    const jsonPath = path.join(dir, 'results.json');
    try {
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          numTotalTestSuites: 2,
          testResults: [
            {
              name: 'tests/unit/physics-engine.test.ts',
              status: 'passed',
              assertionResults: [{ status: 'passed' }, { status: 'passed' }],
              duration: 123,
            },
            {
              name: 'tests/integration/ipc-bridge.test.ts',
              status: 'failed',
              assertionResults: [{ status: 'passed' }, { status: 'failed' }],
              duration: 456,
            },
          ],
        }),
      );

      const files = parseVitestJson(jsonPath);
      expect(files).not.toBeNull();
      expect(files).toHaveLength(2);
      expect(files![0]).toMatchObject({
        file: 'tests/unit/physics-engine.test.ts',
        status: 'passed',
        assertionCount: 2,
      });
      expect(files![1]).toMatchObject({
        file: 'tests/integration/ipc-bridge.test.ts',
        status: 'failed',
        failedCount: 1,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a malformed or missing report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonk-ci-json-'));
    try {
      expect(parseVitestJson(path.join(dir, 'missing.json'))).toBeNull();
      const badPath = path.join(dir, 'bad.json');
      fs.writeFileSync(badPath, '{not json');
      expect(parseVitestJson(badPath)).toBeNull();
      const wrongPath = path.join(dir, 'wrong.json');
      fs.writeFileSync(wrongPath, JSON.stringify({ unrelated: true }));
      expect(parseVitestJson(wrongPath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('local-ci: changedFiles prettier scope', () => {
  it('returns only tracked files matching prettier extensions', () => {
    for (const files of [changedFiles(true), changedFiles(false)]) {
      expect(Array.isArray(files)).toBe(true);
      for (const file of files) {
        expect(file).toMatch(/\.(ts|tsx|js|jsx|json)$/);
        expect(file).not.toContain('package-lock.json');
        expect(file).not.toContain('.user.js');
        expect(file).not.toContain('.git');
      }
    }
  });

  it('keeps git-native forward-slash paths (tracked-filter compatible on Windows)', () => {
    const files = changedFiles(false);
    for (const file of files) {
      expect(file).not.toContain('\\');
    }
  });

  it('excludes the untracked worktree scripts from the scope', () => {
    const files = changedFiles(false);
    expect(files).not.toContain('scripts/validate-live-extraction.js');
    expect(files).not.toContain('Webscripts/bonk-live-tool.user.js');
  });
});
