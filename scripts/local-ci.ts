/**
 * local-ci.ts — Master Local CI/CD Engine
 *
 * Single orchestrator managing all 8 verification domains of the repository:
 *
 *   1. Static quality & syntax   (prettier, tsc, ruff, webscript IDs)
 *   2. Core physics & simulation (unit + integration suites)
 *   3. Differential fidelity     (P0–P4 gates, replay comparator)
 *   4. Worker pool & IPC bridge  (shared memory, ZeroMQ suites)
 *   5. Python RL & reward suite  (pytest)
 *   6. Detached renderer         (render math, map geometry, ring buffer)
 *   7. Security & property       (fast-check, security boundaries)
 *   8. Benchmarks & SLA          (Layer 1–7 regression enforcement)
 *
 * Execution tiers:
 *   --quick     Tier 1: staged-file format check, typecheck, unit tests,
 *               webscript IDs (~pre-commit)
 *   --standard  Tier 2: format check of the branch's own changes (merge-base
 *               diff vs origin/main), typecheck, all Vitest suites, pytest,
 *               fidelity gates (~pre-push) [default]
 *   --full      Tier 3: Tier 2 + live ZeroMQ E2E integration suite
 *   --bench     Tier 4: Layer 1–6 (optional 7) benchmarks + SLA enforcement
 *
 * Flags: --fix (prettier/ruff write), --verbose (stream child output),
 *        --no-python (skip ruff/pytest), --list (show checks), --help
 *
 * Run: npm run ci | npm run ci:quick | npm run ci:full | npm run ci:bench
 *
 * The pure helpers (attributeDomain, parseVitestJson, changedFiles) are
 * exported for unit testing (tests/unit/local-ci.test.ts); main() only runs
 * when this file is executed directly.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

type Tier = 'quick' | 'standard' | 'full' | 'bench';

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

interface CheckResult {
  id: string;
  domain: string;
  label: string;
  status: CheckStatus;
  durationMs: number;
  detail?: string;
}

interface DomainFiles {
  domain: string;
  passed: number;
  failed: number;
  files: string[];
}

interface VitestRunOutcome {
  result: CheckResult;
  domainFiles: DomainFiles[];
}

interface VitestFileResult {
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  assertionCount: number;
  failedCount: number;
  durationMs: number;
}

interface Options {
  tier: Tier;
  fix: boolean;
  verbose: boolean;
  noPython: boolean;
  extraArgs: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    tier: 'standard',
    fix: false,
    verbose: false,
    noPython: false,
    extraArgs: [],
  };

  for (const arg of argv) {
    switch (arg) {
      case '--quick':
      case '-q':
        opts.tier = 'quick';
        break;
      case '--standard':
        opts.tier = 'standard';
        break;
      case '--full':
        opts.tier = 'full';
        break;
      case '--bench':
        opts.tier = 'bench';
        break;
      case '--fix':
        opts.fix = true;
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--no-python':
        opts.noPython = true;
        break;
      case '--layer7':
        opts.extraArgs.push('--layer7');
        break;
      default:
        break;
    }
  }

  return opts;
}

function printHelp(): void {
  console.log('Bonk-RL-Env Local CI/CD Engine');
  console.log('');
  console.log('Usage: npm run ci[:mode] -- [flags]');
  console.log('');
  console.log('Modes:');
  console.log('  ci:quick    Tier 1 — pre-commit: staged-file format check, typecheck,');
  console.log('              unit tests, webscript ID validation');
  console.log('  ci          Tier 2 — pre-push: branch-scoped format check (merge-base');
  console.log('              diff), typecheck, all Vitest suites, pytest, fidelity gates');
  console.log('  ci:full     Tier 3 — Tier 2 + live ZeroMQ E2E integration suite');
  console.log('  ci:bench    Tier 4 — Layer 1–6 (optional 7) benchmarks + SLA checks');
  console.log('');
  console.log('Flags:');
  console.log('  --fix         Apply prettier/ruff fixes to the checked files');
  console.log('  --verbose     Stream raw child output instead of summaries');
  console.log('  --no-python   Skip Python checks (ruff, pytest)');
  console.log('  --layer7      (bench tier) include the Python IPC roundtrip check');
  console.log('  --list        List all checks and their tiers');
  console.log('  --help        Show this help');
}

// ─── Spawning helpers ───────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

function spawnCapture(
  command: string,
  args: string[],
  timeoutMs: number,
  verbose: boolean,
  spinLabel?: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startHr = process.hrtime.bigint();
    let output = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    // Live elapsed spinner for captured checks (TTY only) so long-running
    // typecheck/pytest runs never look hung.
    let spinner: ReturnType<typeof setInterval> | null = null;
    if (!verbose && process.stdout.isTTY && spinLabel) {
      const frames = ['\u25D0', '\u25D3', '\u25D1', '\u25D2'];
      let frame = 0;
      spinner = setInterval(() => {
        const elapsed = Number(process.hrtime.bigint() - startHr) / 1e6;
        process.stdout.write(
          `\r  ${frames[frame % frames.length]} ${spinLabel} ${colors.dim}${fmtDuration(elapsed)}${colors.reset}   `,
        );
        frame++;
      }, 120);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (verbose) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (verbose) process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: SpawnResult): void => {
      if (spinner) {
        clearInterval(spinner);
        process.stdout.write('\r\x1b[K');
      }
      resolve(result);
    };

    child.on('error', (err) => {
      clearTimeout(timeout);
      finish({
        exitCode: null,
        output: output + '\n' + err.message,
        timedOut: false,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1e6,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      finish({
        exitCode: code,
        output,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1e6,
      });
    });
  });
}

function spawnInherit(command: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startHr = process.hrtime.bigint();
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        output: err.message,
        timedOut: false,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1e6,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        output: '',
        timedOut,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1e6,
      });
    });
  });
}

function toolAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
}

function tail(output: string, lines: number): string {
  const all = output.trim().split(/\r?\n/);
  return all.slice(-lines).join('\n');
}

// ─── Changed-file helpers (prettier scope) ──────────────────────────────────

const FORMAT_EXTENSIONS = /\.(ts|tsx|js|jsx|json)$/;
const FORMAT_EXCLUDES = ['package-lock.json'];

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return '';
  return (result.stdout ?? '').trim();
}

function trackedFiles(): Set<string> {
  const output = git(['ls-files']);
  return new Set(output.split(/\r?\n/).filter(Boolean));
}

export function changedFiles(stagedOnly: boolean): string[] {
  const tracked = trackedFiles();

  const names = new Set<string>();
  if (stagedOnly) {
    for (const file of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean)) {
      names.add(file);
    }
  } else {
    // Union of the branch's own committed changes and any uncommitted work:
    // the merge-base diff (origin/main...HEAD) excludes commits that landed
    // on main after the branch diverged, while the staged/unstaged diffs
    // cover edits that have not been committed yet.
    const mergeBase = git(['merge-base', 'origin/main', 'HEAD']);
    if (mergeBase) {
      for (const file of git(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD'])
        .split(/\r?\n/)
        .filter(Boolean)) {
        names.add(file);
      }
    } else {
      for (const file of git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']).split(/\r?\n/).filter(Boolean)) {
        names.add(file);
      }
    }
    for (const file of git(['diff', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean)) {
      names.add(file);
    }
    for (const file of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean)) {
      names.add(file);
    }
  }

  return [...names]
    .filter((file) => tracked.has(file))
    .filter((file) => FORMAT_EXTENSIONS.test(file))
    .filter((file) => !FORMAT_EXCLUDES.some((excluded) => file === excluded));
}

// ─── Check implementations ──────────────────────────────────────────────────

async function checkPrettier(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const files = changedFiles(opts.tier === 'quick');

  if (files.length === 0) {
    const scope = opts.tier === 'quick' ? 'staged' : 'changed-vs-origin/main';
    return {
      id: 'prettier',
      domain: 'static',
      label: `prettier (${scope} files)`,
      status: 'SKIP',
      durationMs: 0,
      detail: 'no candidate files',
    };
  }

  const args = ['prettier', opts.fix ? '--write' : '--check', '--config', '.prettierrc', ...files];
  const result = await spawnCapture('npx', args, 180_000, opts.verbose, 'prettier');
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'prettier',
      domain: 'static',
      label: `prettier (${files.length} files)`,
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 180s',
    };
  }
  if (result.exitCode !== 0) {
    return {
      id: 'prettier',
      domain: 'static',
      label: `prettier (${files.length} files)`,
      status: 'FAIL',
      durationMs,
      detail: `run 'npm run ci -- --fix' to auto-format\n${tail(result.output, 30)}`,
    };
  }
  return { id: 'prettier', domain: 'static', label: `prettier (${files.length} files)`, status: 'PASS', durationMs };
}

async function checkTypecheck(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const result = await spawnCapture('npx', ['tsc', '--noEmit'], 600_000, opts.verbose, 'tsc --noEmit');
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'typecheck',
      domain: 'static',
      label: 'tsc --noEmit',
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 600s',
    };
  }
  if (result.exitCode !== 0) {
    const errors = result.output
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.includes('error TS'));
    const detail =
      errors.length > 0 ? `${errors.length} TypeScript error(s)\n${tail(result.output, 30)}` : tail(result.output, 30);
    return { id: 'typecheck', domain: 'static', label: 'tsc --noEmit', status: 'FAIL', durationMs, detail };
  }
  return { id: 'typecheck', domain: 'static', label: 'tsc --noEmit', status: 'PASS', durationMs };
}

async function checkRuff(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const command = toolAvailable('ruff', ['--version'])
    ? 'ruff'
    : toolAvailable('python', ['-m', 'ruff', '--version'])
      ? 'python'
      : '';
  if (!command) {
    return {
      id: 'ruff',
      domain: 'static',
      label: 'ruff check python/',
      status: 'SKIP',
      durationMs: 0,
      detail: 'ruff not installed — pip install ruff',
    };
  }

  const args =
    command === 'ruff'
      ? ['check', 'python/', '--output-format', 'concise', ...(opts.fix ? ['--fix'] : [])]
      : ['-m', 'ruff', 'check', 'python/', '--output-format', 'concise', ...(opts.fix ? ['--fix'] : [])];
  const result = await spawnCapture(command, args, 120_000, opts.verbose, 'ruff');
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'ruff',
      domain: 'static',
      label: 'ruff check python/',
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 120s',
    };
  }
  if (result.exitCode !== 0) {
    return {
      id: 'ruff',
      domain: 'static',
      label: 'ruff check python/',
      status: 'FAIL',
      durationMs,
      detail: tail(result.output, 30),
    };
  }
  return { id: 'ruff', domain: 'static', label: 'ruff check python/', status: 'PASS', durationMs };
}

async function checkWebscriptIds(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const result = await spawnCapture('node', ['scripts/check-webscript-ids.js'], 60_000, opts.verbose);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'webscript-ids',
      domain: 'static',
      label: 'webscript DOM ID validation',
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 60s',
    };
  }
  if (result.exitCode !== 0) {
    return {
      id: 'webscript-ids',
      domain: 'static',
      label: 'webscript DOM ID validation',
      status: 'FAIL',
      durationMs,
      detail: tail(result.output, 30),
    };
  }
  return { id: 'webscript-ids', domain: 'static', label: 'webscript DOM ID validation', status: 'PASS', durationMs };
}

export function parseVitestJson(jsonPath: string): VitestFileResult[] | null {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      testResults?: Array<{
        name?: string;
        status?: string;
        assertionResults?: Array<{ status?: string }>;
        duration?: number;
      }>;
    };
    const testResults = parsed.testResults;
    if (!Array.isArray(testResults)) return null;
    return testResults.map((file) => ({
      file: (file.name ?? '').replace(/\\/g, '/'),
      status: file.status === 'passed' ? 'passed' : file.status === 'failed' ? 'failed' : 'skipped',
      assertionCount: (file.assertionResults ?? []).length,
      failedCount: (file.assertionResults ?? []).filter((a) => a.status === 'failed').length,
      durationMs: file.duration ?? 0,
    }));
  } catch {
    return null;
  }
}

const DOMAIN_RULES: Array<{ domain: string; match: RegExp }> = [
  { domain: 'fidelity', match: /physics-fidelity|exact-match-gates|replay-comparator|differential/ },
  { domain: 'worker-ipc', match: /(^|\/)(worker|ipc|shared-memory|env-manager|port-manager|telemetry)/ },
  { domain: 'renderer', match: /render-|preview-|snapshot-ring|sim-layer|map-geometry/ },
  { domain: 'security', match: /tests\/(security|property|perf)\// },
  { domain: 'physics', match: /tests\// },
];

export function attributeDomain(file: string): string {
  for (const rule of DOMAIN_RULES) {
    if (rule.match.test(file)) return rule.domain;
  }
  return 'other';
}

const DOMAIN_LABELS: Record<string, { label: string; color: string }> = {
  static: { label: '1. Static quality & syntax', color: colors.cyan },
  physics: { label: '2. Core physics & simulation', color: colors.blue },
  fidelity: { label: '3. Differential fidelity gates', color: colors.magenta },
  'worker-ipc': { label: '4. Worker pool & IPC bridge', color: colors.yellow },
  python: { label: '5. Python RL & reward suite', color: colors.green },
  renderer: { label: '6. Detached renderer', color: colors.gray },
  security: { label: '7. Security & property fuzzing', color: colors.white },
  benchmark: { label: '8. Benchmarks & SLA', color: colors.bright + colors.red },
  e2e: { label: 'E2E ZeroMQ live integration', color: colors.bright + colors.cyan },
  other: { label: 'Other suites', color: colors.dim },
};

async function runVitest(
  label: string,
  id: string,
  configArgs: string[],
  timeoutMs: number,
): Promise<VitestRunOutcome> {
  const started = process.hrtime.bigint();
  const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonk-ci-vitest-'));
  const jsonPath = path.join(jsonDir, 'results.json');

  const args = ['vitest', 'run', ...configArgs, '--reporter=dot', '--reporter=json', `--outputFile.json=${jsonPath}`];
  const result = await spawnInherit('npx', args, timeoutMs);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  const files = parseVitestJson(jsonPath);
  fs.rmSync(jsonDir, { recursive: true, force: true });

  if (result.timedOut) {
    return {
      result: {
        id,
        domain: id,
        label,
        status: 'FAIL',
        durationMs,
        detail: `timed out after ${Math.round(timeoutMs / 1000)}s`,
      },
      domainFiles: [],
    };
  }

  const failedFiles = (files ?? []).filter((file) => file.status === 'failed');
  const passedFiles = (files ?? []).filter((file) => file.status === 'passed');
  const totalTests = (files ?? []).reduce((sum, file) => sum + file.assertionCount, 0);
  const failedTests = (files ?? []).reduce((sum, file) => sum + file.failedCount, 0);

  let detail = '';
  if (files) {
    detail = `${passedFiles.length} files passed, ${failedFiles.length} failed (${failedTests}/${totalTests} assertions failed)`;
    if (failedFiles.length > 0) {
      detail += '\n' + failedFiles.map((file) => `  \u2717 ${file.file}`).join('\n');
    }
  }

  const domainFiles: DomainFiles[] = [];
  if (files) {
    const byDomain = new Map<string, { passed: number; failed: number; files: string[] }>();
    for (const file of files) {
      const domain = attributeDomain(file.file);
      const entry = byDomain.get(domain) ?? { passed: 0, failed: 0, files: [] };
      entry.files.push(file.file);
      if (file.status === 'failed') entry.failed++;
      else entry.passed++;
      byDomain.set(domain, entry);
    }
    for (const [domain, entry] of byDomain) {
      domainFiles.push({ domain, passed: entry.passed, failed: entry.failed, files: entry.files });
    }
  }

  const status: CheckStatus = result.exitCode !== 0 || (files !== null && failedTests > 0) ? 'FAIL' : 'PASS';
  return {
    result: { id, domain: id, label, status, durationMs, detail: files ? detail : undefined },
    domainFiles,
  };
}

async function checkUnitTests(opts: Options): Promise<VitestRunOutcome> {
  return runVitest('unit test suites (tests/unit/)', 'physics', ['tests/unit/'], 900_000);
}

async function checkAllSuites(opts: Options): Promise<VitestRunOutcome> {
  return runVitest('all Vitest suites (unit+integration+perf+security+property)', 'all-suites', [], 1_500_000);
}

async function checkE2E(opts: Options): Promise<VitestRunOutcome> {
  return runVitest('E2E live ZeroMQ server/client suites', 'e2e', ['--config', 'vitest.e2e.config.ts'], 1_200_000);
}

async function checkPytest(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const result = await spawnCapture(
    'python',
    ['-m', 'pytest', 'python/tests', '-q', '--tb=short'],
    900_000,
    opts.verbose,
    'pytest',
  );
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'pytest',
      domain: 'python',
      label: 'pytest python/tests',
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 900s',
    };
  }
  if (result.exitCode !== 0) {
    return {
      id: 'pytest',
      domain: 'python',
      label: 'pytest python/tests',
      status: 'FAIL',
      durationMs,
      detail: tail(result.output, 40),
    };
  }
  return { id: 'pytest', domain: 'python', label: 'pytest python/tests', status: 'PASS', durationMs };
}

async function checkBench(opts: Options): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const args = ['tsx', 'scripts/ci-bench-check.ts', ...opts.extraArgs];
  const result = await spawnInherit('npx', args, 3_600_000);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.timedOut) {
    return {
      id: 'bench',
      domain: 'benchmark',
      label: 'Layer 1–6 benchmarks + SLA',
      status: 'FAIL',
      durationMs,
      detail: 'timed out after 3600s',
    };
  }
  if (result.exitCode !== 0) {
    return {
      id: 'bench',
      domain: 'benchmark',
      label: 'Layer 1–6 benchmarks + SLA',
      status: 'FAIL',
      durationMs,
      detail: 'SLA regression detected — see report above',
    };
  }
  return { id: 'bench', domain: 'benchmark', label: 'Layer 1–6 benchmarks + SLA', status: 'PASS', durationMs };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

function tierTitle(tier: Tier): string {
  switch (tier) {
    case 'quick':
      return 'TIER 1 — PRE-COMMIT QUICK';
    case 'standard':
      return 'TIER 2 — STANDARD CI';
    case 'full':
      return 'TIER 3 — FULL SYSTEM & E2E';
    case 'bench':
      return 'TIER 4 — BENCHMARK REGRESSION';
  }
}

interface CheckTask {
  label: string;
  fn: () => Promise<{ result: CheckResult; domainFiles?: DomainFiles[] }>;
}

async function buildChecks(opts: Options): Promise<CheckTask[]> {
  const checks: CheckTask[] = [];

  const add = (label: string, fn: () => Promise<CheckResult>): void => {
    checks.push({ label, fn: async () => ({ result: await fn() }) });
  };

  const addVitest = (label: string, run: () => Promise<VitestRunOutcome>): void => {
    checks.push({ label, fn: async () => run() });
  };

  switch (opts.tier) {
    case 'quick':
      add('prettier (staged files)', () => checkPrettier(opts));
      add('webscript DOM ID validation', () => checkWebscriptIds(opts));
      if (!opts.noPython) add('ruff check python/', () => checkRuff(opts));
      add('tsc --noEmit', () => checkTypecheck(opts));
      addVitest('unit test suites (tests/unit/)', () => checkUnitTests(opts));
      break;
    case 'standard':
      add('prettier (changed vs origin/main)', () => checkPrettier(opts));
      add('webscript DOM ID validation', () => checkWebscriptIds(opts));
      if (!opts.noPython) add('ruff check python/', () => checkRuff(opts));
      add('tsc --noEmit', () => checkTypecheck(opts));
      addVitest('all Vitest suites (unit+integration+perf+security+property)', () => checkAllSuites(opts));
      if (!opts.noPython) add('pytest python/tests', () => checkPytest(opts));
      break;
    case 'full':
      add('prettier (changed vs origin/main)', () => checkPrettier(opts));
      add('webscript DOM ID validation', () => checkWebscriptIds(opts));
      if (!opts.noPython) add('ruff check python/', () => checkRuff(opts));
      add('tsc --noEmit', () => checkTypecheck(opts));
      addVitest('all Vitest suites (unit+integration+perf+security+property)', () => checkAllSuites(opts));
      addVitest('E2E live ZeroMQ server/client suites', () => checkE2E(opts));
      if (!opts.noPython) add('pytest python/tests', () => checkPytest(opts));
      break;
    case 'bench':
      add('Layer 1–6 benchmarks + SLA enforcement', () => checkBench(opts));
      break;
  }

  return checks;
}

function pad(text: string, len: number): string {
  return text.length >= len ? text.substring(0, len) : text + ' '.repeat(len - text.length);
}

function padLeft(text: string, len: number): string {
  return text.length >= len ? text.substring(0, len) : ' '.repeat(len - text.length) + text;
}

function statusTag(status: CheckStatus): string {
  switch (status) {
    case 'PASS':
      return colors.green + '\u2713 PASS' + colors.reset;
    case 'FAIL':
      return colors.red + '\u2717 FAIL' + colors.reset;
    case 'SKIP':
      return colors.gray + '\u25CB SKIP' + colors.reset;
    case 'ERROR':
      return colors.yellow + '! ERROR' + colors.reset;
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function runAll(opts: Options): Promise<number> {
  const checks = await buildChecks(opts);
  const results: CheckResult[] = [];
  const domainFiles: DomainFiles[] = [];
  const totalStarted = process.hrtime.bigint();
  let aborted = false;

  const onSigint = (): void => {
    aborted = true;
    process.stderr.write('\n\n\u26A0 Aborted by user (SIGINT).\n');
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  printHeader(opts);

  for (let i = 0; i < checks.length && !aborted; i++) {
    const task = checks[i];
    console.log(colors.bright + `  \u2192 [${i + 1}/${checks.length}] ${task.label} ...` + colors.reset);
    const outcome = await task.fn();
    results.push(outcome.result);
    if (outcome.domainFiles) domainFiles.push(...outcome.domainFiles);

    const line = `  ${pad(`[${i + 1}/${checks.length}] ${outcome.result.label}`, 60)} ${statusTag(outcome.result.status)}  ${colors.dim}${fmtDuration(outcome.result.durationMs)}${colors.reset}`;
    console.log(line);
    if (outcome.result.detail) {
      console.log(colors.gray + outcome.result.detail.replace(/^/gm, '    ') + colors.reset);
    }
    console.log();
  }

  process.removeListener('SIGINT', onSigint);

  if (!aborted) {
    printSummary(results, domainFiles, Number(process.hrtime.bigint() - totalStarted) / 1e6);
  }

  const failed = results.filter((result) => result.status === 'FAIL' || result.status === 'ERROR').length;
  return failed > 0 ? 1 : 0;
}

function printHeader(opts: Options): void {
  console.log();
  console.log(colors.cyan + '\u2554' + '\u2550'.repeat(78) + '\u2557' + colors.reset);
  const title = ` BONK-RL-ENV LOCAL CI/CD ENGINE — ${tierTitle(opts.tier)} `;
  console.log(
    colors.cyan + '\u2551' + title.padStart(Math.floor((78 + title.length) / 2)).padEnd(78) + '\u2551' + colors.reset,
  );
  console.log(colors.cyan + '\u255A' + '\u2550'.repeat(78) + '\u255D' + colors.reset);
  console.log();
  const flags: string[] = [];
  if (opts.fix) flags.push('--fix');
  if (opts.verbose) flags.push('--verbose');
  if (opts.noPython) flags.push('--no-python');
  if (flags.length > 0) {
    console.log(colors.dim + '  flags: ' + flags.join(', ') + colors.reset);
  }
  console.log();
}

function printSummary(results: CheckResult[], domainFiles: DomainFiles[], wallMs: number): void {
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  console.log(colors.cyan + '\u2554' + '\u2550'.repeat(78) + '\u2557' + colors.reset);
  console.log(colors.cyan + '\u2551' + ' CI SUMMARY '.padStart(45).padEnd(78) + '\u2551' + colors.reset);
  console.log(colors.cyan + '\u255A' + '\u2550'.repeat(78) + '\u255D' + colors.reset);
  console.log();

  const hr = '\u2500'.repeat(78);
  console.log(colors.bright + colors.white + 'CHECKS' + colors.reset);
  console.log(hr);

  const nameW = 60;
  for (const result of results) {
    const row =
      '  ' +
      pad(result.label, nameW) +
      ' ' +
      statusTag(result.status) +
      '  ' +
      colors.dim +
      padLeft(fmtDuration(result.durationMs), 8) +
      colors.reset;
    console.log(row);
  }

  console.log();
  console.log(colors.bright + colors.white + 'DOMAIN ROLLUP (plan \u00A71 coverage matrix)' + colors.reset);
  console.log(hr);

  for (const [domain, config] of Object.entries(DOMAIN_LABELS)) {
    const checkResults = results.filter((r) => r.domain === domain);
    const fileRollup = domainFiles.find((entry) => entry.domain === domain);

    if (checkResults.length === 0 && !fileRollup) continue;

    const failedChecks = checkResults.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
    const skippedOnly = checkResults.length > 0 && checkResults.every((r) => r.status === 'SKIP');
    const domainFailed = failedChecks.length > 0 || (fileRollup !== undefined && fileRollup.failed > 0);
    const tag = domainFailed
      ? colors.red + '\u2717' + colors.reset
      : skippedOnly
        ? colors.gray + '\u25CB' + colors.reset
        : colors.green + '\u2713' + colors.reset;

    console.log(`  ${tag} ${config.color}${config.label}${colors.reset}`);

    const parts: string[] = [];
    for (const result of checkResults) {
      parts.push(
        `${result.label} ${statusTag(result.status)} ${colors.dim}${fmtDuration(result.durationMs)}${colors.reset}`,
      );
    }
    if (fileRollup) {
      const fileLabel =
        fileRollup.failed > 0
          ? colors.red + `${fileRollup.failed} failed / ${fileRollup.passed + fileRollup.failed} files` + colors.reset
          : colors.green + `${fileRollup.passed + fileRollup.failed} files passed` + colors.reset;
      parts.push(fileLabel);
    }
    console.log(`     ${colors.dim}${parts.join(' \u00B7 ')}${colors.reset}`);
  }

  console.log();
  console.log(hr);
  console.log(
    colors.bright +
      `  RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped — check time ${fmtDuration(totalMs)}, wall time ${fmtDuration(wallMs)}` +
      colors.reset,
  );
  if (failed === 0) {
    console.log(colors.green + '  All checks passed. Commit/push is clear.' + colors.reset);
  } else {
    console.log(
      colors.red +
        `  ${failed} check(s) failed — fix the issues above (or 'npm run ci -- --fix') before commit/push.` +
        colors.reset,
    );
  }
  console.log();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (argv.includes('--list')) {
    console.log('Checks and their tiers:');
    console.log('  [quick]     prettier (staged files)');
    console.log('  [quick]     webscript DOM ID validation');
    console.log('  [quick]     ruff check python/');
    console.log('  [quick]     tsc --noEmit');
    console.log('  [quick]     unit test suites (tests/unit/)');
    console.log('  [standard]  prettier (changed vs origin/main)');
    console.log('  [standard]  all Vitest suites (unit+integration+perf+security+property)');
    console.log('  [standard]  pytest python/tests');
    console.log('  [full]      E2E live ZeroMQ server/client suites');
    console.log('  [bench]     Layer 1–6 benchmarks + SLA (--layer7 for Python IPC)');
    process.exit(0);
  }

  const opts = parseArgs(argv);
  const exitCode = await runAll(opts);
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      colors.red +
        `Local CI engine crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` +
        colors.reset,
    );
    process.exit(1);
  });
}
