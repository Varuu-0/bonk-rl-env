/**
 * ci-bench-check.ts — Benchmark Regression & SLA Enforcement
 *
 * Runs Layer 1–6 benchmarks programmatically, extracts the numeric metrics
 * from the structured __BENCH_JSON_START__/__BENCH_JSON_END__ blocks each
 * layer emits, and asserts every metric against the local SLA threshold
 * table. Exits with a non-zero code and prints actionable diffs when any
 * throughput or memory regression is detected.
 *
 * Layer 7 (Python IPC roundtrip) is optional: it requires a running
 * TypeScript server, so it is skipped unless --layer7 is passed.
 *
 * Run: npx tsx scripts/ci-bench-check.ts [--layer7] [--verbose]
 *
 * The pure evaluation helpers are exported for unit testing
 * (tests/unit/ci-bench-check.test.ts); main() only runs when this file is
 * executed directly.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

interface BenchmarkMetric {
  label: string;
  value: number;
  unit: string;
}

interface BenchmarkResult {
  layer: number;
  name: string;
  passed: boolean;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';
  durationMs: number;
  metrics: BenchmarkMetric[];
  error?: string;
}

interface BenchmarkSuite {
  layer: number;
  name: string;
  description: string;
  results: BenchmarkResult[];
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
}

interface LayerRun {
  layer: number;
  name: string;
  suite: BenchmarkSuite | null;
  durationMs: number;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT' | 'SKIP';
  error?: string;
  rawOutput: string;
}

type SlaDirection = 'higher-better' | 'lower-better';

interface SlaCheck {
  layer: number;
  description: string;
  benchMatch: RegExp;
  metricLabel: string;
  unit: string;
  baseline: number;
  failLimit: number;
  direction: SlaDirection;
}

/**
 * Local SLA threshold table (plan §3.H). `baseline` is the expected healthy
 * value measured on reference hardware; `failLimit` is the hard regression
 * boundary — anything past it FAILs the pipeline. Values between baseline
 * and failLimit produce a WARN (regression suspected, not yet fatal).
 */
const SLA_CHECKS: SlaCheck[] = [
  {
    layer: 1,
    description: 'Atomics read/write latency',
    benchMatch: /^Atomics\.(store|load)$/,
    metricLabel: 'Latency',
    unit: 'ms',
    baseline: 0.001,
    failLimit: 0.005,
    direction: 'lower-better',
  },
  {
    layer: 2,
    description: 'Box2D tick() throughput',
    benchMatch: /PhysicsEngine\.tick\(\)/,
    metricLabel: 'TPS',
    unit: 'steps/sec',
    baseline: 22_600,
    failLimit: 18_000,
    direction: 'higher-better',
  },
  {
    layer: 3,
    description: 'BonkEnvironment 1v1 step() throughput',
    benchMatch: /BonkEnvironment\.step\(\) \(1 AI \+ 1 opponent\)/,
    metricLabel: 'SPS',
    unit: 'steps/sec',
    baseline: 28_000,
    failLimit: 22_000,
    direction: 'higher-better',
  },
  {
    layer: 4,
    description: 'Worker pool aggregate throughput (16 envs)',
    benchMatch: /WorkerPool\.step\(\) N=16$/,
    metricLabel: 'Env-SPS (aggregate)',
    unit: 'env-steps/sec',
    baseline: 35_000,
    failLimit: 32_000,
    direction: 'higher-better',
  },
  {
    layer: 5,
    description: '50K-step heap growth',
    benchMatch: /Memory stability/,
    metricLabel: 'Heap growth',
    unit: 'MB',
    baseline: 2.5,
    failLimit: 10.0,
    direction: 'lower-better',
  },
  {
    layer: 5,
    description: '200-reset-cycle heap growth',
    benchMatch: /Reset cycles/,
    metricLabel: 'Heap growth',
    unit: 'MB',
    baseline: 0.5,
    failLimit: 3.0,
    direction: 'lower-better',
  },
  {
    layer: 6,
    description: 'Long-run throughput variance (CV, stable)',
    benchMatch: /Native env stability/,
    metricLabel: 'CV (stable)',
    unit: '%',
    baseline: 5,
    failLimit: 15,
    direction: 'lower-better',
  },
];

interface SlaVerdict {
  check: SlaCheck;
  measured: number | null;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP' | 'ERROR';
  detail: string;
}

interface Layer7Verdict {
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP' | 'ERROR';
  measuredMs: number | null;
  detail: string;
}

const LAYERS: Record<string, { file: string; name: string; timeoutMs: number }> = {
  '1': { file: 'benchmarks/layer1-primitives.ts', name: 'Primitives', timeoutMs: 180_000 },
  '2': { file: 'benchmarks/layer2-physics.ts', name: 'Raw Physics', timeoutMs: 180_000 },
  '3': { file: 'benchmarks/layer3-environment.ts', name: 'Environment', timeoutMs: 180_000 },
  '4': { file: 'benchmarks/layer4-worker-pool.ts', name: 'Worker Pool', timeoutMs: 900_000 },
  '5': { file: 'benchmarks/layer5-memory.ts', name: 'Memory', timeoutMs: 600_000 },
  '6': { file: 'benchmarks/layer6-stability.ts', name: 'Stability', timeoutMs: 900_000 },
};

function print(text: string, color?: string): void {
  if (color) console.log(color + text + colors.reset);
  else console.log(text);
}

/**
 * Kill a shell-spawned process tree. `child.kill()` on a `shell: true` spawn
 * only terminates the shell wrapper and orphans the npx/tsx benchmark
 * grandchildren, so the children are spawned `detached` on POSIX (their own
 * process group, signalled here via the negative pid) and Windows uses
 * `taskkill /T` to tear the whole tree down.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

export function parseSuiteFromOutput(output: string): BenchmarkSuite | null {
  const startMarker = '__BENCH_JSON_START__';
  const endMarker = '__BENCH_JSON_END__';
  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const json = output.substring(startIdx + startMarker.length, endIdx).trim();
  try {
    const parsed = JSON.parse(json) as BenchmarkSuite;
    if (typeof parsed.layer !== 'number' || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Environment overrides for the fail limits. The plan's SLA table is
 * authored against reference hardware (see README benchmark table, measured
 * April 2026); machines with materially different threading primitives
 * (notably Windows, where Atomics.wait/notify round-trips are ~4x costlier
 * than on Linux) can tune the regression boundary without weakening the
 * default. Baseline values are never overridden.
 */
const FAIL_LIMIT_ENV: Record<string, { layer: number; description?: string }> = {
  CI_BENCH_L1_FAIL_LATENCY_MS: { layer: 1 },
  CI_BENCH_L2_FAIL_TPS: { layer: 2 },
  CI_BENCH_L3_FAIL_SPS: { layer: 3 },
  CI_BENCH_L4_FAIL_ENV_SPS: { layer: 4 },
  CI_BENCH_L5_FAIL_HEAP_MB: { layer: 5, description: '50K-step heap growth' },
  CI_BENCH_L5_RESET_FAIL_MB: { layer: 5, description: '200-reset-cycle heap growth' },
  CI_BENCH_L6_FAIL_CV_PCT: { layer: 6 },
};

export function applyEnvOverrides(checks: SlaCheck[]): SlaCheck[] {
  for (const [envName, target] of Object.entries(FAIL_LIMIT_ENV)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isNaN(value) || value <= 0) continue;

    for (const check of checks) {
      if (check.layer !== target.layer) continue;
      if (target.description !== undefined && check.description !== target.description) continue;
      check.failLimit = value;
    }
  }
  return checks;
}

function runLayer(layerKey: string, verbose: boolean): Promise<LayerRun> {
  return new Promise((resolve) => {
    const layer = LAYERS[layerKey];
    const benchPath = path.join(ROOT, layer.file);
    const startHr = process.hrtime.bigint();
    let rawOutput = '';
    let timedOut = false;

    print(`  Running Layer ${layerKey}: ${layer.name} ...`, colors.cyan);

    // --expose-gc makes global.gc available so the Layer 5 heap-growth
    // measurements are deterministic instead of GC-timing noise (see
    // issue #196: the global.gc guard is a no-op without the flag).
    const child = spawn('npx', ['tsx', '--expose-gc', layer.file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd: ROOT,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      rawOutput += text;
      if (verbose) process.stdout.write(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      rawOutput += text;
      if (verbose) process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, layer.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        layer: +layerKey,
        name: layer.name,
        suite: null,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1e6,
        status: 'ERROR',
        error: err.message,
        rawOutput,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      const suite = parseSuiteFromOutput(rawOutput);
      const status: LayerRun['status'] = timedOut
        ? 'TIMEOUT'
        : code !== 0 && !suite
          ? 'ERROR'
          : suite && (suite.failed > 0 || suite.errored > 0)
            ? 'FAIL'
            : suite
              ? 'PASS'
              : 'ERROR';
      resolve({
        layer: +layerKey,
        name: layer.name,
        suite,
        durationMs,
        status,
        error: timedOut ? `Timed out after ${layer.timeoutMs}ms` : undefined,
        rawOutput,
      });
    });
  });
}

function metricValue(suite: BenchmarkSuite, benchMatch: RegExp, metricLabel: string): number | null {
  for (const bench of suite.results) {
    if (!benchMatch.test(bench.name)) continue;
    const metric = bench.metrics.find((m) => m.label === metricLabel);
    if (metric && typeof metric.value === 'number' && !Number.isNaN(metric.value)) {
      return metric.value;
    }
  }
  return null;
}

function metricValues(suite: BenchmarkSuite, benchMatch: RegExp, metricLabel: string): number[] {
  const values: number[] = [];
  for (const bench of suite.results) {
    if (!benchMatch.test(bench.name)) continue;
    const metric = bench.metrics.find((m) => m.label === metricLabel);
    if (metric && typeof metric.value === 'number' && !Number.isNaN(metric.value)) {
      values.push(metric.value);
    }
  }
  return values;
}

/**
 * Layer 1 reports latency in microseconds (us), while the SLA table is
 * written in milliseconds — the verdict converts before comparing.
 */
export function toMillis(value: number, unit: string): number {
  if (unit === 'us') return value / 1000;
  return value;
}

export function evaluate(check: SlaCheck, measuredRaw: number | null, measuredUnit: string | null): SlaVerdict {
  if (measuredRaw === null) {
    return {
      check,
      measured: null,
      status: 'ERROR',
      detail: `metric '${check.metricLabel}' not found in any matching benchmark`,
    };
  }

  const measured = toMillis(measuredRaw, measuredUnit ?? '');
  const unitText = check.unit;

  if (check.direction === 'higher-better') {
    if (measured >= check.baseline) {
      return {
        check,
        measured,
        status: 'PASS',
        detail: `${measured.toLocaleString()} ${unitText} >= baseline ${check.baseline.toLocaleString()}`,
      };
    }
    if (measured >= check.failLimit) {
      const pct = (((check.baseline - measured) / check.baseline) * 100).toFixed(1);
      return {
        check,
        measured,
        status: 'WARN',
        detail: `${measured.toLocaleString()} ${unitText} < baseline ${check.baseline.toLocaleString()} (${pct}% below)`,
      };
    }
    const pct = (((check.baseline - measured) / check.baseline) * 100).toFixed(1);
    return {
      check,
      measured,
      status: 'FAIL',
      detail: `${measured.toLocaleString()} ${unitText} < fail limit ${check.failLimit.toLocaleString()} (${pct}% below baseline)`,
    };
  }

  if (measured <= check.baseline) {
    return {
      check,
      measured,
      status: 'PASS',
      detail: `${measured.toFixed(3)} ${unitText} <= baseline ${check.baseline.toFixed(3)}`,
    };
  }
  if (measured <= check.failLimit) {
    return {
      check,
      measured,
      status: 'WARN',
      detail: `${measured.toFixed(3)} ${unitText} > baseline ${check.baseline.toFixed(3)} (within fail limit ${check.failLimit.toFixed(3)})`,
    };
  }
  return {
    check,
    measured,
    status: 'FAIL',
    detail: `${measured.toFixed(3)} ${unitText} > fail limit ${check.failLimit.toFixed(3)}`,
  };
}

export function parseLayer7(output: string): Layer7Verdict {
  // Phase 3 prints "Median: X ms" for full per-step roundtrips. The LAST
  // "Median:" line belongs to Phase 4 (raw send/recv). Use Phase 3's value
  // (the first occurrence) as the end-to-end step roundtrip latency.
  const matches = output.match(/Median:\s*([\d.]+)\s*ms/g);
  if (!matches || matches.length === 0) {
    return { status: 'ERROR', measuredMs: null, detail: 'no "Median: X ms" line found in layer7 output' };
  }
  const measuredMs = parseFloat(matches[0].replace(/[^\d.]/g, ''));
  if (Number.isNaN(measuredMs)) {
    return { status: 'ERROR', measuredMs: null, detail: 'unparseable median latency in layer7 output' };
  }
  const baseline = 5;
  const failLimit = 20;
  if (measuredMs <= baseline) {
    return { status: 'PASS', measuredMs, detail: `${measuredMs.toFixed(2)} ms <= baseline ${baseline} ms` };
  }
  if (measuredMs <= failLimit) {
    return {
      status: 'WARN',
      measuredMs,
      detail: `${measuredMs.toFixed(2)} ms > baseline ${baseline} ms (within fail limit ${failLimit} ms)`,
    };
  }
  return { status: 'FAIL', measuredMs, detail: `${measuredMs.toFixed(2)} ms > fail limit ${failLimit} ms` };
}

function runLayer7(verbose: boolean): Promise<Layer7Verdict> {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, 'python', 'benchmarks', 'layer7-ipc-latency.py');
    print('  Running Layer 7: Python IPC roundtrip latency ...', colors.cyan);

    const child = spawn('python', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd: ROOT,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let rawOutput = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      rawOutput += text;
      if (verbose) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      rawOutput += chunk.toString();
      if (verbose) process.stderr.write(chunk.toString());
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, 300_000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ status: 'ERROR', measuredMs: null, detail: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve({ status: 'ERROR', measuredMs: null, detail: 'timed out after 300s' });
        return;
      }
      if (code !== 0) {
        const lastLine = rawOutput.trim().split(/\r?\n/).pop() ?? 'unknown error';
        resolve({ status: 'ERROR', measuredMs: null, detail: `layer7 exited with code ${code}: ${lastLine}` });
        return;
      }
      resolve(parseLayer7(rawOutput));
    });
  });
}

function pad(text: string, len: number): string {
  return text.length >= len ? text.substring(0, len) : text + ' '.repeat(len - text.length);
}

function padLeft(text: string, len: number): string {
  return text.length >= len ? text.substring(0, len) : ' '.repeat(len - text.length) + text;
}

function statusTag(status: string): string {
  switch (status) {
    case 'PASS':
      return colors.green + '\u2713 PASS' + colors.reset;
    case 'WARN':
      return colors.yellow + '\u26A0 WARN' + colors.reset;
    case 'FAIL':
      return colors.red + '\u2717 FAIL' + colors.reset;
    case 'SKIP':
      return colors.gray + '\u25CB SKIP' + colors.reset;
    default:
      return colors.red + '! ' + status + colors.reset;
  }
}

function printSlaReport(verdicts: SlaVerdict[], layer7: Layer7Verdict | null, includeLayer7: boolean): void {
  console.log();
  print('\u2554' + '\u2550'.repeat(76) + '\u2557', colors.cyan);
  print('\u2551' + ' SLA REGRESSION REPORT '.padStart(45).padEnd(76) + '\u2551', colors.cyan);
  print('\u255A' + '\u2550'.repeat(76) + '\u255D', colors.cyan);
  console.log();

  const hr = '\u2500'.repeat(76);
  print('BENCHMARK SLA THRESHOLDS', colors.bright + colors.white);
  print(hr);

  const header =
    '  ' +
    pad('#', 2) +
    '  ' +
    pad('Check', 42) +
    ' ' +
    padLeft('Measured', 12) +
    ' ' +
    padLeft('Baseline', 11) +
    ' ' +
    padLeft('Fail limit', 11) +
    '  ' +
    'Status';
  print(header, colors.bright + colors.white);
  print(
    '  ' +
      '\u2500'.repeat(2) +
      '  ' +
      '\u2500'.repeat(42) +
      ' ' +
      '\u2500'.repeat(12) +
      ' ' +
      '\u2500'.repeat(11) +
      ' ' +
      '\u2500'.repeat(11) +
      '  ' +
      '\u2500'.repeat(6),
  );

  let index = 0;
  for (const verdict of verdicts) {
    index++;
    const measuredText =
      verdict.measured === null ? 'N/A' : verdict.measured.toLocaleString(undefined, { maximumFractionDigits: 3 });
    const row =
      '  ' +
      pad(String(index), 2) +
      '  ' +
      pad(`L${verdict.check.layer} ${verdict.check.description}`, 42) +
      ' ' +
      padLeft(measuredText, 12) +
      ' ' +
      padLeft(verdict.check.baseline.toLocaleString(), 11) +
      ' ' +
      padLeft(verdict.check.failLimit.toLocaleString(), 11) +
      '  ' +
      statusTag(verdict.status);
    console.log(row);
    const original = SLA_CHECKS.find((candidate) => candidate.description === verdict.check.description);
    const overridden = original !== undefined && original.failLimit !== verdict.check.failLimit;
    if (overridden) {
      print(`       \u2514\u2500 fail limit overridden from environment`, colors.dim);
    }
    if (verdict.status === 'FAIL' || verdict.status === 'ERROR') {
      print(`       \u2514\u2500 ${verdict.detail}`, colors.red);
    } else if (verdict.status === 'WARN') {
      print(`       \u2514\u2500 ${verdict.detail}`, colors.yellow);
    }
  }

  if (includeLayer7 && layer7) {
    index++;
    const measuredText = layer7.measuredMs === null ? 'N/A' : layer7.measuredMs.toFixed(2) + ' ms';
    const row =
      '  ' +
      pad(String(index), 2) +
      '  ' +
      pad('L7 Python IPC roundtrip latency', 42) +
      ' ' +
      padLeft(measuredText, 12) +
      ' ' +
      padLeft('5', 11) +
      ' ' +
      padLeft('20', 11) +
      '  ' +
      statusTag(layer7.status);
    console.log(row);
    if (layer7.status === 'FAIL' || layer7.status === 'ERROR') {
      print(`       \u2514\u2500 ${layer7.detail}`, colors.red);
    } else if (layer7.status === 'WARN') {
      print(`       \u2514\u2500 ${layer7.detail}`, colors.yellow);
    }
  }

  console.log();
  print(hr);

  const failed = verdicts.filter((v) => v.status === 'FAIL' || v.status === 'ERROR').length;
  const warned = verdicts.filter((v) => v.status === 'WARN').length;
  const passed = verdicts.filter((v) => v.status === 'PASS').length;
  const skipped = verdicts.filter((v) => v.status === 'SKIP').length;

  print(`  Passed: ${passed}   Warnings: ${warned}   Failed: ${failed}   Skipped: ${skipped}`, colors.bright);
  if (failed === 0) {
    print('  RESULT: All SLA thresholds met.', colors.green);
  } else {
    print(`  RESULT: ${failed} SLA threshold(s) violated — regression detected.`, colors.red);
  }
  console.log();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const includeLayer7 = args.includes('--layer7');
  const verbose = args.includes('--verbose');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Benchmark Regression & SLA Enforcement Checker');
    console.log('');
    console.log('Usage: npx tsx scripts/ci-bench-check.ts [--layer7] [--verbose]');
    console.log('');
    console.log('  --layer7   Also run the Python IPC roundtrip latency benchmark.');
    console.log('             Requires a running TypeScript server (npm start).');
    console.log('  --verbose  Stream raw benchmark output to the console.');
    console.log('');
    process.exit(0);
  }

  print('\u2554' + '\u2550'.repeat(76) + '\u2557', colors.cyan);
  print('\u2551' + ' BENCHMARK REGRESSION CHECKER — LAYERS 1-6'.padStart(46).padEnd(76) + '\u2551', colors.cyan);
  print('\u255A' + '\u2550'.repeat(76) + '\u255D', colors.cyan);
  console.log();

  const layerRuns: LayerRun[] = [];
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    try {
      const run = await runLayer(key, verbose);
      layerRuns.push(run);
      const label =
        run.status === 'PASS'
          ? colors.green + `  PASS: Layer ${key} — ${run.name} (${(run.durationMs / 1000).toFixed(2)}s)` + colors.reset
          : run.status === 'SKIP'
            ? colors.gray + `  SKIP: Layer ${key} — ${run.name}` + colors.reset
            : colors.red +
              `  ${run.status}: Layer ${key} — ${run.name} (${(run.durationMs / 1000).toFixed(2)}s)` +
              colors.reset;
      console.log(label);
      if (run.error) print(`    ${run.error}`, colors.red);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      layerRuns.push({
        layer: +key,
        name: LAYERS[key].name,
        suite: null,
        durationMs: 0,
        status: 'ERROR',
        error: message,
        rawOutput: '',
      });
      print(`  ERROR: Layer ${key} — ${message}`, colors.red);
    }
    console.log();
  }

  const verdicts: SlaVerdict[] = [];
  let layerFailures = 0;

  const slaChecks = applyEnvOverrides(SLA_CHECKS.map((check) => ({ ...check })));

  for (const check of slaChecks) {
    const run = layerRuns.find((r) => r.layer === check.layer);
    if (!run || run.status === 'TIMEOUT' || run.status === 'ERROR' || run.suite === null) {
      verdicts.push({
        check,
        measured: null,
        status: run?.status === 'SKIP' ? 'SKIP' : 'ERROR',
        detail: run?.error ?? `layer ${check.layer} did not produce a parseable suite`,
      });
      continue;
    }
    if (run.status === 'FAIL') {
      // The layer's own internal gates already failed; treat the SLA
      // metric as an error so the report is honest about the source.
      layerFailures++;
      const values = metricValues(run.suite, check.benchMatch, check.metricLabel);
      const worst = values.length > 0 ? Math.max(...values) : null;
      verdicts.push({
        check,
        measured: worst,
        status: 'ERROR',
        detail: `layer ${check.layer} failed its own internal benchmarks`,
      });
      continue;
    }

    if (check.layer === 1) {
      // Layer 1 latencies are reported in us; combine store+load as the
      // representative read/write latency (worst of the two).
      const values = metricValues(run.suite, check.benchMatch, check.metricLabel);
      if (values.length === 0) {
        verdicts.push({
          check,
          measured: null,
          status: 'ERROR',
          detail: `no Atomics.store/load latency metrics found`,
        });
        continue;
      }
      const worstUs = Math.max(...values);
      verdicts.push(evaluate(check, worstUs, 'us'));
      continue;
    }

    const measured = metricValue(run.suite, check.benchMatch, check.metricLabel);
    verdicts.push(evaluate(check, measured, check.unit));
  }

  let layer7: Layer7Verdict | null = null;
  if (includeLayer7) {
    try {
      layer7 = await runLayer7(verbose);
      print(
        `  Layer 7 result: ${layer7.status} — ${layer7.detail}`,
        layer7.status === 'FAIL' ? colors.red : colors.dim,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      layer7 = { status: 'ERROR', measuredMs: null, detail: message };
      print(`  ERROR: Layer 7 — ${message}`, colors.red);
    }
    console.log();
  } else {
    print('  Layer 7 (Python IPC) skipped — pass --layer7 and start `npm start` to include it.', colors.dim);
    console.log();
  }

  printSlaReport(verdicts, layer7, includeLayer7);

  const failed = verdicts.filter((v) => v.status === 'FAIL' || v.status === 'ERROR').length;
  const layer7Failed = layer7 !== null && (layer7.status === 'FAIL' || layer7.status === 'ERROR');
  return failed > 0 || layerFailures > 0 || layer7Failed ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
