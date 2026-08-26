/**
 * Issue #429 regression coverage: a benchmark layer process that exits
 * non-zero AFTER printing a parseable clean suite block must resolve
 * ERROR through runLayer's real spawn/close pipeline — never PASS.
 * Exercises the actual close handler with genuine child processes
 * (stub benchmarks spawned via `npx tsx` like production layers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLayer } from '../../scripts/ci-bench-check';
import type { BenchmarkSuite } from '../../scripts/ci-bench-check';

const CLEAN_SUITE: BenchmarkSuite = {
  layer: 99,
  name: 'Stub layer',
  description: 'stub',
  results: [
    {
      layer: 99,
      name: 'PhysicsEngine.tick()',
      passed: true,
      status: 'PASS',
      durationMs: 1,
      metrics: [{ label: 'TPS', value: 30000, unit: 'steps/sec' }],
    },
  ],
  durationMs: 2,
  passed: 1,
  failed: 0,
  skipped: 0,
  errored: 0,
};

const CRASH_AFTER_REPORT = `
const suite = ${JSON.stringify(CLEAN_SUITE)};
// Synchronous write: console.log to a pipe can be lost when process.exit
// fires immediately after (async pipe flush on some platforms).
require('node:fs').writeSync(1, '__BENCH_JSON_START__' + JSON.stringify(suite) + '__BENCH_JSON_END__\\n');
process.exit(3);
`;

const CRASH_BEFORE_REPORT = `
require('node:fs').writeSync(2, 'boom during warmup\\n');
process.exit(1);
`;

const HEALTHY = `
const suite = ${JSON.stringify(CLEAN_SUITE)};
require('node:fs').writeSync(1, '__BENCH_JSON_START__' + JSON.stringify(suite) + '__BENCH_JSON_END__\\n');
`;

describe('ci-bench-check gate: non-zero layer exit fails the SLA gate (#429)', () => {
  let dir: string;
  let crashAfterReportStub: string;
  let crashBeforeReportStub: string;
  let healthyStub: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-429-'));
    const write = (name: string, body: string): string => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return file;
    };
    crashAfterReportStub = write('crash-after-report.ts', CRASH_AFTER_REPORT);
    crashBeforeReportStub = write('crash-before-report.ts', CRASH_BEFORE_REPORT);
    healthyStub = write('healthy.ts', HEALTHY);
  }, 30_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves ERROR when a layer prints a clean suite block and then crashes (exit 3)', async () => {
    const run = await runLayer('x', false, {
      x: { file: crashAfterReportStub, name: 'Stub Crash', timeoutMs: 120_000 },
    });
    expect(run.status).toBe('ERROR');
    expect(run.error).toContain('exited with code 3');
    // The suite WAS present and internally clean — proving the pre-fix
    // suppression path (parseable suite + failed==0) is gone for good:
    // main()'s verdict seeding turns any ERROR run into failing SLA
    // verdicts, so the gate can no longer exit 0 here.
    expect(run.suite).not.toBeNull();
    expect(run.suite!.failed).toBe(0);
    expect(run.suite!.errored).toBe(0);
  }, 180_000);

  it('resolves ERROR when a layer dies before printing any suite block', async () => {
    const run = await runLayer('x', false, {
      x: { file: crashBeforeReportStub, name: 'Stub Boom', timeoutMs: 120_000 },
    });
    expect(run.status).toBe('ERROR');
    expect(run.error).toContain('exited with code 1');
    expect(run.suite).toBeNull();
  }, 180_000);

  it('still passes a healthy layer (zero exit + clean suite) so the happy path is intact', async () => {
    const run = await runLayer('x', false, {
      x: { file: healthyStub, name: 'Stub Healthy', timeoutMs: 120_000 },
    });
    expect(run.status).toBe('PASS');
    expect(run.error).toBeUndefined();
    expect(run.suite).not.toBeNull();
  }, 180_000);
});
