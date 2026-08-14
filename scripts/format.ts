/**
 * format.ts — Prettier gate scoped to files that actually changed.
 *
 * The repository predates strict prettier enforcement, so a whole-tree
 * `prettier --check .` would always fail on legacy debt. This script checks
 * (or writes) only the files the current work touches:
 *
 *   --check          report non-conforming changed files (exit 1 on any)
 *   --write          auto-format changed files
 *   --staged         scope to git-staged files instead of the diff vs
 *                    origin/main (default when --staged is absent)
 *   --all            scope to every tracked file (opt-in; useful for a
 *                    deliberate whole-repo formatting pass)
 *
 * Run: npm run format:check | npm run format:fix
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

const FORMAT_EXTENSIONS = /\.(ts|tsx|js|jsx|json)$/;
const FORMAT_EXCLUDES = new Set(['package-lock.json']);

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
  return new Set(git(['ls-files']).split(/\r?\n/).filter(Boolean));
}

function scopeFiles(staged: boolean, all: boolean): string[] {
  const tracked = trackedFiles();

  const names = new Set<string>();
  if (all) {
    for (const file of tracked) names.add(file);
  } else if (staged) {
    for (const file of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean)) {
      names.add(file);
    }
  } else {
    // Union of the branch's own committed changes and any uncommitted
    // work: the merge-base diff (origin/main...HEAD) excludes commits
    // that landed on main after divergence, while the staged/unstaged
    // diffs cover edits that have not been committed yet.
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
    .filter((file) => !FORMAT_EXCLUDES.has(file));
}

function main(): void {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const staged = argv.includes('--staged');
  const all = argv.includes('--all');

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run format:check [--staged|--all]');
    console.log('       npm run format:fix   [--staged|--all]');
    console.log('');
    console.log('  --staged  only files staged for commit (default: diff vs origin/main)');
    console.log('  --all     every tracked file (whole-repo pass)');
    process.exit(0);
  }

  const files = scopeFiles(staged, all);
  const scopeName = all ? 'all tracked files' : staged ? 'staged files' : 'changed files (vs origin/main)';

  if (files.length === 0) {
    console.log(`No ${scopeName} matching prettier extensions — nothing to ${write ? 'format' : 'check'}.`);
    process.exit(0);
  }

  console.log(`${write ? 'Formatting' : 'Checking'} ${files.length} ${scopeName} ...`);

  const args = ['prettier', write ? '--write' : '--check', '--config', '.prettierrc', ...files];
  const result = spawnSync('npx', args, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  if (result.status !== 0) {
    console.log('');
    console.log(
      write
        ? 'Formatting failed — review the files above.'
        : 'Format check failed — run `npm run format:fix` to auto-format the changed files.',
    );
    process.exit(1);
  }

  if (!write) {
    console.log('All changed files conform to .prettierrc.');
  }
  process.exit(0);
}

main();
