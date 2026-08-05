import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The heap measurement runs in a dedicated subprocess (tests/perf/
// memory-probe.ts) instead of the vitest fork, so:
//   - `global.gc` is always available (the vitest forks pool has no
//     --expose-gc), making the assertion measure actual retained memory
//     after forced GC rather than GC timing.
//   - `--expose-gc` is scoped to that one measurement process instead of
//     every test fork in the suite.
//   - native/external memory categories are measured alongside V8 heap.
// The probe is launched through the tsx CLI (which forwards node flags and
// supports the project's node engines range without the `--import` flag,
// which requires node >= 20.6). vitest resolves from the project root as
// cwd, so paths are anchored relative to it.
const probePath = join(process.cwd(), 'tests', 'perf', 'memory-probe.ts');
const tsxCliPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('Memory stability', () => {
  it('no significant heap growth after many resets', () => {
    let report = '';
    let stderr = '';
    let exitCode: number;
    try {
      report = execFileSync(
        process.execPath,
        [tsxCliPath, '--expose-gc', probePath],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      exitCode = 0;
    } catch (err) {
      const error = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = error.status ?? 1;
      report = error.stdout ?? '';
      stderr = error.stderr ?? '';
    }

    const results = JSON.parse(
      (report.match(/\{.*\}/) ?? [''])[0] || '{}'
    ) as Record<string, number>;
    const growthMB = results.heapUsedMB ?? NaN;
    const detail = (`${report}\n${stderr}`).trim();

    expect(
      exitCode,
      `memory probe exited ${exitCode}; ${detail}`
    ).toBe(0);
    expect(
      growthMB,
      `retained heap growth ${growthMB.toFixed(2)} MB exceeds ${results.thresholdMB ?? 20} MB`
    ).toBeLessThan(results.thresholdMB ?? 20);
  });
});