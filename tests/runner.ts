/**
 * Compatibility CLI for the pre-Vitest test runner.
 *
 * The individual npm scripts invoke Vitest directly. This entry point remains
 * for users of test:runner, test:list, test:legacy, and the old numeric CLI.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
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

export function resolveVitestCli(
  vitestPackageRoot: string = path.join(repositoryRoot, 'node_modules', 'vitest'),
): string {
  const vitestPackagePath = path.join(vitestPackageRoot, 'package.json');
  let vitestPackage: { bin?: string | Record<string, string> };
  try {
    vitestPackage = JSON.parse(fs.readFileSync(vitestPackagePath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
  } catch (error) {
    throw new Error(
      `Unable to read the vitest package manifest at ${vitestPackagePath}: ${(error as Error).message}. ` +
        `Reinstall dependencies with 'npm ci'.`,
    );
  }

  const binEntry = typeof vitestPackage.bin === 'string' ? vitestPackage.bin : vitestPackage.bin?.['vitest'];
  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    throw new Error(
      `The vitest package manifest at ${vitestPackagePath} has no valid 'bin.vitest' entry. ` +
        `Reinstall dependencies with 'npm ci'.`,
    );
  }

  return path.join(vitestPackageRoot, binEntry);
}

function runVitest(testFile?: string): number {
  let vitestCli: string;
  try {
    vitestCli = resolveVitestCli();
  } catch (error) {
    console.error(`Unable to start Vitest: ${(error as Error).message}`);
    return 1;
  }

  const args = [vitestCli, 'run'];
  if (testFile) args.push(testFile);

  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
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
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      input.close();
      resolve(code);
    };

    input.on('close', () => {
      if (!settled) console.error('Input closed before a suite was selected.');
      finish(1);
    });
    input.on('error', (error) => {
      if (!settled) console.error(`Error reading input: ${error.message}`);
      finish(1);
    });

    input.question('Select a suite: ', (answer) => {
      const choice = answer.trim().toLowerCase();
      if (choice === 'q' || choice === 'quit') {
        finish(0);
        return;
      }
      if (choice === 'a' || choice === 'all' || choice === '') {
        finish(runVitest());
        return;
      }

      const suite = TEST_SUITES.find((candidate) => candidate.key === choice);
      if (!suite) {
        console.error(`Unknown test suite: ${choice}`);
        finish(1);
        return;
      }
      finish(runVitest(suite.file));
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
