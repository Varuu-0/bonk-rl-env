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

const TEST_FILES = {
  '1': { file: 'physics-engine.test.ts', description: 'Box2D physics simulation' },
  '2': { file: 'prng.test.ts', description: 'Deterministic RNG' },
  '3': { file: 'bonk-env.test.ts', description: 'Gymnasium API' },
  '4': { file: 'frame-skip.test.ts', description: 'Frame skip action repetition' },
  '5': { file: 'shared-memory.ts', description: 'SharedArrayBuffer IPC' },
  '6': { file: 'shutdown.ts', description: 'Signal handlers' },
  '7': { file: 'telemetry.ts', description: 'Profiling system' },
  '8': { file: 'env-manager.test.ts', description: 'Environment pool management' },
};

function print(text, color) {
  if (color) console.log(color + text + colors.reset);
  else console.log(text);
}

function printHeader() {
  // Only clear terminal in interactive TTY environments (not CI)
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
  print('    [1]  Physics Engine    - Box2D physics simulation', colors.gray);
  print('    [2]  PRNG             - Deterministic RNG', colors.gray);
  print('    [3]  Bonk Environment - Gymnasium API', colors.gray);
  print('    [4]  Frame Skip       - Action repetition', colors.gray);
  print('    [5]  Shared Memory    - Zero-copy IPC', colors.gray);
  print('    [6]  Shutdown         - Signal handlers', colors.gray);
  print('    [7]  Telemetry        - Profiling system', colors.gray);
  print('    [8]  Env Manager      - Pool management', colors.gray);
  console.log();
  print('  [Q]  QUIT', colors.red);
  print('  [L]  LIST ALL TESTS', colors.blue);
  console.log();
  process.stdout.write('Enter your choice: ');
}

function runTest(testFile) {
  return new Promise((resolve, reject) => {
    const testPath = path.join(__dirname, testFile);
    if (!fs.existsSync(testPath)) {
      reject(new Error('Test file not found: ' + testPath));
      return;
    }
    console.log();
    print('Running: ' + testFile + ' ...', colors.cyan);
    console.log();
    const startTime = Date.now();
    
    const child = spawn('npx', ['tsx', testPath], {
      stdio: 'inherit',
      shell: true,
      cwd: path.join(__dirname, '..'),
    });
    
    // Set up timeout to prevent indefinite hanging
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Test timed out after ${TEST_TIMEOUT}ms`));
    }, TEST_TIMEOUT);
    
    child.on('close', (code) => {
      clearTimeout(timeout);
      const time = Date.now() - startTime;
      resolve({ passed: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1, time });
    });
    
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function runAllTests() {
  console.log();
  print('RUNNING FULL TEST SUITE...', colors.yellow);
  console.log();
  const results = [];
  let totalPassed = 0, totalFailed = 0;
  for (const [key, test] of Object.entries(TEST_FILES)) {
    try {
      const result = await runTest(test.file);
      results.push({ name: test.file, passed: result.failed === 0, time: result.time });
      totalPassed++;
      print('PASS: ' + test.file + ' (' + result.time + 'ms)', colors.green);
    } catch (error) {
      results.push({ name: test.file, passed: false, time: 0, error: error.message });
      totalFailed++;
      print('FAIL: ' + test.file + ' - ' + error.message, colors.red);
    }
  }
  console.log();
  print('========================= TEST SUMMARY =========================', colors.cyan);
  console.log();
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const color = r.passed ? colors.green : colors.red;
    print('  ' + status.padEnd(6) + '  ' + r.name.padEnd(30) + ' ' + r.time + 'ms', color);
  }
  console.log();
  const total = totalPassed + totalFailed;
  print('  Total: ' + total + ' | ' + totalPassed + ' passed | ' + totalFailed + ' failed');
  console.log();
  if (totalFailed > 0) {
    print('SOME TESTS FAILED', colors.red);
    process.exit(1);
  } else {
    print('ALL TESTS PASSED', colors.green);
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
      await runTest(TEST_FILES[arg].file);
      return;
    }
    console.log('Unknown test: ' + arg);
    console.log('Use "list" to see available tests');
    process.exit(1);
  }
  printHeader();
  printMenu();
  const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  readline.question('', async (answer) => {
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
      try {
        await runTest(TEST_FILES[choice].file);
        console.log();
        print('Test passed!', colors.green);
        process.exit(0);
      } catch (error) {
        console.log();
        print('Test failed: ' + error.message, colors.red);
        process.exit(1);
      }
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
