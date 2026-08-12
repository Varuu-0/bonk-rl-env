/**
 * Compatibility CLI for the pre-Vitest test runner.
 *
 * The individual npm scripts invoke Vitest directly. This entry point remains
 * for users of test:runner, test:list, test:legacy, and the old numeric CLI.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';

const repositoryRoot = path.resolve(__dirname, '..');

export const TEST_SUITES = [
  { key: '1', file: 'tests/unit/physics-engine.test.ts', description: 'Box2D physics simulation' },
  { key: '2', file: 'tests/unit/prng.test.ts', description: 'Deterministic RNG' },
  { key: '3', file: 'tests/integration/bonk-env.test.ts', description: 'Gymnasium API' },
  { key: '4', file: 'tests/integration/frame-skip.test.ts', description: 'Frame skip action repetition' },
  { key: '5', file: 'tests/integration/shared-memory.test.ts', description: 'Shared memory IPC' },
  { key: '6', file: 'tests/integration/env-manager.test.ts', description: 'Environment pool management' },
  { key: '7', file: 'tests/integration/map-body-types.test.ts', description: 'Map body types' },
  { key: '8', file: 'tests/integration/collision-filtering.test.ts', description: 'Collision group filtering' },
  { key: '9', file: 'tests/integration/nophysics-friction.test.ts', description: 'Sensor bodies and friction' },
  { key: '10', file: 'tests/integration/grapple-mechanics.test.ts', description: 'Grapple and slingshot mechanics' },
  { key: '11', file: 'tests/integration/dynamic-arena-bounds.test.ts', description: 'Dynamic arena bounds' },
  { key: '12', file: 'tests/integration/map-integration.test.ts', description: 'Real map loading and integration' },
] as const;

function runVitest(testFile?: string): number {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['--no-install', 'vitest', 'run'];
  if (testFile) args.push(testFile);

  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Unable to start Vitest: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function printList(): void {
  console.log('Available test suites:');
  for (const suite of TEST_SUITES) {
    console.log(`  [${suite.key}] ${suite.file} - ${suite.description}`);
  }
  console.log('  [all] Vitest default suite');
}

async function runInteractive(): Promise<number> {
  printList();
  console.log('  [q]   Quit');

  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question('Select a suite: ', (answer) => {
      input.close();
      const choice = answer.trim().toLowerCase();
      if (choice === 'q' || choice === 'quit') {
        resolve(0);
        return;
      }
      if (choice === 'a' || choice === 'all' || choice === '') {
        resolve(runVitest());
        return;
      }

      const suite = TEST_SUITES.find((candidate) => candidate.key === choice);
      if (!suite) {
        console.error(`Unknown test suite: ${choice}`);
        resolve(1);
        return;
      }
      resolve(runVitest(suite.file));
    });
  });
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const choice = args[0]?.toLowerCase();

  if (choice === 'list' || choice === 'l') {
    printList();
    return 0;
  }

  if (choice === 'all' || choice === 'a') {
    return runVitest();
  }

  if (choice) {
    const suite = TEST_SUITES.find((candidate) => candidate.key === choice);
    if (!suite) {
      console.error(`Unknown test suite: ${choice}`);
      console.error('Use "list" to see available suites.');
      return 1;
    }
    return runVitest(suite.file);
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    return runInteractive();
  }

  return runVitest();
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
