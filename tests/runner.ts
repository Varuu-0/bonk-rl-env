/**
 * Test Runner - Consolidated CLI Test Suite
 * Run with: npx tsx tests/runner.ts
 * Or: npm test
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// Test timeout in milliseconds (60 seconds)
const TEST_TIMEOUT = 60000;
const REPORT_WIDTH = 78;

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

interface SuiteResult {
  file: string;
  description: string;
  tests: TestResult[];
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  passRate: number;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';
  exitCode: number | null;
  rawOutput: string;
  error?: string;
}

const TEST_FILES: Record<string, { file: string; description: string }> = {
  '1':  { file: 'physics-engine.test.ts',       description: 'Box2D physics simulation' },
  '2':  { file: 'prng.test.ts',                 description: 'Deterministic RNG' },
  '3':  { file: 'bonk-env.test.ts',             description: 'Gymnasium API' },
  '4':  { file: 'frame-skip.test.ts',           description: 'Frame skip action repetition' },
  '5':  { file: 'shared-memory.ts',             description: 'SharedArrayBuffer IPC' },
  '6':  { file: 'env-manager.test.ts',          description: 'Environment pool management' },
  '7':  { file: 'map-body-types.test.ts',       description: 'Map body types (rect/circle/polygon)' },
  '8':  { file: 'collision-filtering.test.ts',  description: 'Collision group filtering' },
  '9':  { file: 'nophysics-friction.test.ts',   description: 'Sensor bodies and friction' },
  '10': { file: 'grapple-mechanics.test.ts',    description: 'Grapple and slingshot mechanics' },
  '11': { file: 'dynamic-arena-bounds.test.ts', description: 'Dynamic arena bounds expansion' },
  '12': { file: 'map-integration.test.ts',      description: 'Real map loading and integration' },
};

function print(text: string, color?: string) {
  if (color) console.log(color + text + colors.reset);
  else console.log(text);
}

function printHeader() {
  if (process.stdout.isTTY) {
    console.clear();
  }
  print('========================================================', colors.cyan);
  print('  BONK.RL-ENV - AUTOMATED TEST SUITE', colors.cyan);
  print('========================================================', colors.cyan);
  console.log();
}

function printMenu() {
  console.log();
  print('SELECT TEST TO RUN:', colors.bright + colors.white);
  console.log();
  print('  [A]  ALL TESTS (Run entire test suite)', colors.green);
  console.log();
  print('    [1]  Physics Engine      - Box2D physics simulation', colors.gray);
  print('    [2]  PRNG                - Deterministic RNG', colors.gray);
  print('    [3]  Bonk Environment    - Gymnasium API', colors.gray);
  print('    [4]  Frame Skip          - Action repetition', colors.gray);
  print('    [5]  Shared Memory       - Zero-copy IPC', colors.gray);
  print('    [6]  Shutdown            - Signal handlers and scripts', colors.gray);
  print('    [7]  Telemetry           - Profiling system', colors.gray);
  print('    [8]  Env Manager         - Pool management', colors.gray);
  print('    [9]  Map Body Types      - rect/circle/polygon', colors.gray);
  print('    [10] Collision Filtering - Group filtering', colors.gray);
  print('    [11] Nophysics Friction  - Sensor bodies and friction', colors.gray);
  print('    [12] Grapple Mechanics   - Grapple and slingshot', colors.gray);
  print('    [13] Dynamic Arena       - Arena bounds expansion', colors.gray);
  print('    [14] Map Integration     - Real map loading', colors.gray);
  console.log();
  print('  [Q]  QUIT', colors.red);
  print('  [L]  LIST ALL TESTS', colors.blue);
  console.log();
  process.stdout.write('Enter your choice: ');
}

function parseTestOutput(output: string): { tests: TestResult[]; passed: number; failed: number } {
  const tests: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  const lines = output.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Skip empty lines
    if (!line.trim()) continue;

    // RESULTS summary line: "RESULTS: N passed, M failed"
    const resultsMatch = line.match(/^RESULTS:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (resultsMatch) {
      passed = parseInt(resultsMatch[1], 10);
      failed = parseInt(resultsMatch[2], 10);
      continue;
    }

    // Pass: "+ <test name>"
    let match = line.match(/^\+\s+(.+)$/);
    if (match) {
      tests.push({ name: match[1], passed: true });
      continue;
    }

    // Pass (telemetry): "✓ <test name>"
    match = line.match(/^✓\s+(.+)$/);
    if (match) {
      tests.push({ name: match[1], passed: true });
      continue;
    }

    // Fail: "X <test name>" or "X <test name>: <details>"
    match = line.match(/^X\s+(.+)$/);
    if (match) {
      const fullMatch = match[1];
      const colonIdx = fullMatch.indexOf(': ');
      if (colonIdx !== -1) {
        const name = fullMatch.substring(0, colonIdx);
        const details = fullMatch.substring(colonIdx + 2);
        tests.push({ name, passed: false, details });
      } else {
        tests.push({ name: fullMatch, passed: false });
      }
      continue;
    }

    // Fail (telemetry): "✗ <test name>"
    match = line.match(/^✗\s+(.+)$/);
    if (match) {
      tests.push({ name: match[1], passed: false });
      continue;
    }
  }

  // If we parsed individual tests but no RESULTS line, derive counts from parsed tests
  if (passed === 0 && failed === 0 && tests.length > 0) {
    passed = tests.filter(t => t.passed).length;
    failed = tests.filter(t => !t.passed).length;
  }

  return { tests, passed, failed };
}

function runTest(testFile: string, testDescription: string): Promise<SuiteResult> {
  return new Promise((resolve) => {
    const testPath = path.join(__dirname, testFile);
    if (!fs.existsSync(testPath)) {
      resolve({
        file: testFile,
        description: testDescription,
        tests: [],
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        passRate: 0,
        status: 'ERROR',
        exitCode: null,
        rawOutput: '',
        error: 'Test file not found: ' + testPath,
      });
      return;
    }

    print('Running: ' + testFile + ' ...', colors.cyan);
    const startHr = process.hrtime.bigint();
    let rawOutput = '';
    let timedOut = false;

    const child = spawn('npx', ['tsx', testPath], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
      cwd: path.join(__dirname, '..'),
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      rawOutput += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      rawOutput += text;
      process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TEST_TIMEOUT);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const elapsed = Number(process.hrtime.bigint() - startHr) / 1e6; // ms
      const { tests, passed, failed } = parseTestOutput(rawOutput);

      const status: SuiteResult['status'] = timedOut
        ? 'TIMEOUT'
        : code !== 0 && tests.length === 0
          ? 'ERROR'
          : failed > 0 || code !== 0
            ? 'FAIL'
            : 'PASS';

      const totalTests = passed + failed;
      const passRate = totalTests > 0 ? (passed / totalTests) * 100 : (status === 'PASS' ? 100 : 0);

      resolve({
        file: testFile,
        description: testDescription,
        tests,
        totalTests,
        passed,
        failed,
        skipped: 0,
        duration: elapsed,
        passRate,
        status,
        exitCode: code,
        rawOutput,
        error: timedOut ? `Timed out after ${TEST_TIMEOUT}ms` : undefined,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      const elapsed = Number(process.hrtime.bigint() - startHr) / 1e6;
      resolve({
        file: testFile,
        description: testDescription,
        tests: [],
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: elapsed,
        passRate: 0,
        status: 'ERROR',
        exitCode: null,
        rawOutput,
        error: err.message,
      });
    });
  });
}

function pad(text: string, len: number): string {
  if (text.length >= len) return text.substring(0, len);
  return text + ' '.repeat(len - text.length);
}

function padLeft(text: string, len: number): string {
  if (text.length >= len) return text.substring(0, len);
  return ' '.repeat(len - text.length) + text;
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function printConsolidatedSummary(results: SuiteResult[]) {
  const totalSuites = results.length;
  const totalTests = results.reduce((s, r) => s + r.totalTests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
  const totalErrors = results.filter(r => r.status === 'ERROR' || r.status === 'TIMEOUT').length;
  const totalDuration = results.reduce((s, r) => s + r.duration, 0);
  const overallPassRate = totalTests > 0 ? (totalPassed / totalTests) * 100 : 0;

  const hr = '\u2500'.repeat(REPORT_WIDTH);
  const topLine = '\u2554' + '\u2550'.repeat(REPORT_WIDTH) + '\u2557';
  const botLine = '\u255A' + '\u2550'.repeat(REPORT_WIDTH) + '\u255D';
  const midLine = '\u2551' + ' CONSOLIDATED TEST SUMMARY REPORT '.padStart(39).padEnd(REPORT_WIDTH) + '\u2551';

  console.log();
  print(topLine, colors.cyan);
  print(midLine, colors.cyan);
  print(botLine, colors.cyan);
  console.log();

  // OVERALL SUMMARY
  print('OVERALL SUMMARY', colors.bright + colors.white);
  print(hr);

  const barWidth = 44;
  const passBar = progressBar(overallPassRate, barWidth);
  const failRate = totalTests > 0 ? ((totalFailed + totalErrors) / totalTests) * 100 : 0;
  const failBar = progressBar(failRate, barWidth);

  const passRateStr = totalTests > 0 ? (overallPassRate.toFixed(1) + '%') : 'N/A';
  print(`  Total Suites:        ${totalSuites}`);
  print(`  Total Tests:         ${totalTests}`);
  print(`  Passed:              ${padLeft(String(totalPassed), 4)}  ${passBar}  ${passRateStr}`, colors.green);
  print(`  Failed:              ${padLeft(String(totalFailed), 4)}  ${failBar}  ${(failRate).toFixed(1)}%`, colors.red);
  print(`  Skipped:             ${padLeft(String(totalSkipped), 4)}`);
  print(`  Errors:              ${padLeft(String(totalErrors), 4)}`);
  print(`  Total Duration:      ${(totalDuration / 1000).toFixed(2)}s`);
  const overallRateStr = totalTests > 0 ? overallPassRate.toFixed(2) + '%' : 'N/A';
  print(`  Pass Rate:           ${overallRateStr}`);

  console.log();

  // SUITE BREAKDOWN
  print('SUITE BREAKDOWN', colors.bright + colors.white);
  print(hr);

  const numW = 2;
  const fileW = 36;
  const testW = 7;
  const passW = 6;
  const failW = 6;
  const skipW = 6;
  const durW = 10;
  const rateW = 7;
  const statusW = 6;

  const header =
    '  ' +
    pad('#', numW) + '  ' +
    pad('Suite', fileW) + ' ' +
    padLeft('Tests', testW) + ' ' +
    padLeft('Pass', passW) + ' ' +
    padLeft('Fail', failW) + ' ' +
    padLeft('Skip', skipW) + ' ' +
    padLeft('Duration', durW) + ' ' +
    padLeft('Rate', rateW) + ' ' +
    ' ' + pad('Status', statusW);

  print(header, colors.bright + colors.white);
  print('  ' + '\u2500'.repeat(numW) + ' ' +
    '\u2500'.repeat(fileW) + ' ' +
    '\u2500'.repeat(testW) + ' ' +
    '\u2500'.repeat(passW) + ' ' +
    '\u2500'.repeat(failW) + ' ' +
    '\u2500'.repeat(skipW) + ' ' +
    '\u2500'.repeat(durW) + ' ' +
    '\u2500'.repeat(rateW) + ' ' +
    '\u2500'.repeat(statusW));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const num = String(i + 1).padStart(numW);
    const rateStr = r.totalTests > 0 ? r.passRate.toFixed(1) + '%' : (r.status === 'PASS' ? '100.0%' : 'N/A');
    const statusColor =
      r.status === 'PASS' ? colors.green :
      r.status === 'FAIL' ? colors.red :
      colors.yellow;

    const row =
      pad(num, numW + 2) +
      pad(r.file, fileW) + ' ' +
      padLeft(String(r.totalTests), testW) + ' ' +
      padLeft(String(r.passed), passW) + ' ' +
      padLeft(String(r.failed), failW) + ' ' +
      padLeft(String(r.skipped), skipW) + ' ' +
      padLeft((r.duration / 1000).toFixed(2) + 's', durW) + ' ' +
      padLeft(rateStr, rateW) + ' ' +
      pad(statusColor + r.status + colors.reset + ' '.repeat(Math.max(0, statusW - r.status.length + 7)), statusW + 7);

    console.log(row);
  }

  const totalsRow =
    '     ' +
    pad('TOTALS', fileW) + ' ' +
    padLeft(String(totalTests), testW) + ' ' +
    padLeft(String(totalPassed), passW) + ' ' +
    padLeft(String(totalFailed), failW) + ' ' +
    padLeft(String(totalSkipped), skipW) + ' ' +
    padLeft((totalDuration / 1000).toFixed(2) + 's', durW) + ' ' +
    padLeft(overallPassRate.toFixed(1) + '%', rateW);

  print('  ' + '\u2500'.repeat(numW) + ' ' +
    '\u2500'.repeat(fileW) + ' ' +
    '\u2500'.repeat(testW) + ' ' +
    '\u2500'.repeat(passW) + ' ' +
    '\u2500'.repeat(failW) + ' ' +
    '\u2500'.repeat(skipW) + ' ' +
    '\u2500'.repeat(durW) + ' ' +
    '\u2500'.repeat(rateW) + ' ' +
    '\u2500'.repeat(statusW));
  print(totalsRow);

  console.log();

  // TIMING ANALYSIS
  print('TIMING ANALYSIS', colors.bright + colors.white);
  print(hr);

  const sorted = [...results].sort((a, b) => b.duration - a.duration);
  const slowest = sorted[0];
  const fastest = sorted[sorted.length - 1];
  const avg = totalDuration / totalSuites;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1].duration + sorted[sorted.length / 2].duration) / 2
    : sorted[Math.floor(sorted.length / 2)].duration;

  print(`  Slowest Suite:  ${pad(slowest.file, 34)} (${(slowest.duration / 1000).toFixed(2)}s)`);
  print(`  Fastest Suite:  ${pad(fastest.file, 34)} (${(fastest.duration / 1000).toFixed(2)}s)`);
  print(`  Average Suite:  ${(avg / 1000).toFixed(2)}s`);
  print(`  Median Suite:   ${(median / 1000).toFixed(2)}s`);
  console.log();

  print('  Top 5 Slowest Suites:', colors.dim);
  const top5 = sorted.slice(0, 5);
  for (let i = 0; i < top5.length; i++) {
    print(`    ${i + 1}. ${pad(top5[i].file, 32)} ${(top5[i].duration / 1000).toFixed(2)}s`);
  }

  console.log();

  // FAILURE DETAILS
  const failureDetails: Array<{ suite: string; name: string; details?: string }> = [];
  for (const r of results) {
    for (const t of r.tests) {
      if (!t.passed) {
        failureDetails.push({ suite: r.file, name: t.name, details: t.details });
      }
    }
  }

  print('FAILURE DETAILS', colors.bright + colors.white);
  print(hr);

  if (failureDetails.length === 0) {
    print('  No failures to report.', colors.green);
  } else {
    for (const fd of failureDetails) {
      print(`  [${fd.suite}] "${fd.name}"`, colors.red);
      if (fd.details) {
        print(`    \u2514\u2500 ${fd.details}`, colors.gray);
      }
    }
  }

  // Also print suites that errored
  const errored = results.filter(r => r.status === 'ERROR' || r.status === 'TIMEOUT');
  if (errored.length > 0) {
    console.log();
    print('ERROR DETAILS', colors.bright + colors.white);
    print(hr);
    for (const r of errored) {
      print(`  [${r.file}] ${r.status}: ${r.error || 'Unknown error'}`, colors.yellow);
    }
  }

  console.log();
  print('\u2550'.repeat(REPORT_WIDTH + 2), colors.cyan);
  console.log();
}

async function runAllTests() {
  console.log();
  print('RUNNING FULL TEST SUITE...', colors.yellow);
  console.log();

  const results: SuiteResult[] = [];

  for (const [, test] of Object.entries(TEST_FILES)) {
    try {
      const result = await runTest(test.file, test.description);
      results.push(result);
      if (result.status === 'PASS') {
        print(`PASS: ${test.file} (${(result.duration / 1000).toFixed(2)}s, ${result.passed}/${result.totalTests} tests)`, colors.green);
      } else {
        print(`${result.status}: ${test.file} (${result.passed}/${result.totalTests} passed, ${result.failed} failed)`, result.status === 'FAIL' ? colors.red : colors.yellow);
      }
    } catch (error: any) {
      const result: SuiteResult = {
        file: test.file,
        description: test.description,
        tests: [],
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        passRate: 0,
        status: 'ERROR',
        exitCode: null,
        rawOutput: '',
        error: error.message,
      };
      results.push(result);
      print('ERROR: ' + test.file + ' - ' + error.message, colors.red);
    }
  }

  printConsolidatedSummary(results);

  const anyFailed = results.some(r => r.status !== 'PASS');
  if (anyFailed) {
    print('SOME TESTS FAILED', colors.red);
    process.exit(1);
  } else {
    print('ALL TESTS PASSED', colors.green);
  }
}

async function runSingleTest(file: string, description: string) {
  console.log();
  try {
    const result = await runTest(file, description);
    console.log();
    if (result.status === 'PASS') {
      print(`PASS: ${result.file} (${(result.duration / 1000).toFixed(2)}s, ${result.passed}/${result.totalTests} tests)`, colors.green);
    } else {
      print(`${result.status}: ${result.file} (${result.passed}/${result.totalTests} passed, ${result.failed} failed)`, result.status === 'FAIL' ? colors.red : colors.yellow);
      if (result.error) {
        print(`  Error: ${result.error}`, colors.red);
      }
    }
    if (result.status === 'PASS') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error: any) {
    print('Test failed: ' + error.message, colors.red);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const arg = args[0].toLowerCase();
    if (arg === 'all' || arg === 'a') {
      await runAllTests();
      return;
    }
    if (arg === 'list' || arg === 'l') {
      printHeader();
      console.log('Available tests:');
      console.log();
      for (const [key, test] of Object.entries(TEST_FILES)) {
        console.log('  [' + key + '] ' + test.file + ' - ' + test.description);
      }
      console.log();
      return;
    }
    if (TEST_FILES[arg]) {
      await runSingleTest(TEST_FILES[arg].file, TEST_FILES[arg].description);
      return;
    }
    console.log('Unknown test: ' + arg);
    console.log('Use list to see available tests');
    process.exit(1);
  }

  printHeader();
  printMenu();
  const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  readline.question('', async (answer: string) => {
    readline.close();
    const choice = answer.trim().toLowerCase();
    if (choice === 'q' || choice === 'quit') {
      console.log();
      print('Goodbye!', colors.cyan);
      process.exit(0);
    }
    if (choice === 'a' || choice === 'all') {
      await runAllTests();
      process.exit(0);
    }
    if (choice === 'l' || choice === 'list') {
      console.log();
      print('Available tests:', colors.white);
      console.log();
      for (const [key, test] of Object.entries(TEST_FILES)) {
        console.log('  [' + key + '] ' + test.file + ' - ' + test.description);
      }
      console.log();
      process.exit(0);
    }
    if (TEST_FILES[choice]) {
      await runSingleTest(TEST_FILES[choice].file, TEST_FILES[choice].description);
    }
    console.log();
    print('Invalid choice', colors.red);
    process.exit(1);
  });
}

main().catch((err) => {
  console.log();
  print('Error: ' + err.message, colors.red);
  process.exit(1);
});
