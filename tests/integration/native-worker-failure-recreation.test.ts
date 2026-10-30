/**
 * Focused real-worker native reliability integration test. The child harness
 * owns fault injection via NODE_OPTIONS so Vitest's worker execArgv handling
 * cannot remove the preload. No WorkerPool/Worker/SharedMemoryManager mocks.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HARNESS = path.join('validation', 'native', 'reliability-worker-recreation.ts');
const PRELOAD = path.resolve(process.cwd(), 'validation', 'native', 'reliability-worker-crash-preload.cjs');

/**
 * Serializes JSON the way Prettier formats .json files: 2-space indent with
 * arrays of primitives kept inline when they fit the print width. Mirrors the
 * receipt formatting contract used by the local CI prettier gate.
 */
function prettierJson(value: unknown): string {
  const render = (node: unknown, indent: number): string => {
    const pad = ' '.repeat(indent);
    if (Array.isArray(node)) {
      if (node.length === 0) return '[]';
      // Prettier keeps arrays of primitives inline when they fit the print
      // width, but always expands arrays containing arrays or objects.
      const allPrimitive = node.every((item) => item === null || typeof item !== 'object');
      if (allPrimitive) {
        const inline = `[${node.map((item) => JSON.stringify(item)).join(', ')}]`;
        if (inline.length + indent <= 80) return inline;
      }
      const items = node.map((item) => render(item, indent + 2));
      return `[\n${items.map((s) => `${pad}  ${s}`).join(',\n')}\n${pad}]`;
    }
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      const body = entries
        .map(([key, val]) => `${pad}  ${JSON.stringify(key)}: ${render(val, indent + 2)}`)
        .join(',\n');
      return `{\n${body}\n${pad}}`;
    }
    return JSON.stringify(node);
  };
  return render(value, 0);
}

describe('native real-worker failure and explicit recreation', () => {
  it('rejects mid-step native crashes and recreates deterministic direct/message/shared residency', async () => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), HARNESS], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: `--require=${PRELOAD}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    try {
      const code = await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Native reliability harness exceeded 20s\n${stdout}\n${stderr}`));
          }, 20000);
        }),
      ]);
      const receipt = stdout.split(/\r?\n/).find((line) => line.startsWith('NATIVE_RELIABILITY_RECEIPT '));
      expect(code, `Native reliability child failed\n${stdout}\n${stderr}`).toBe(0);
      expect(receipt, `Missing machine-readable native reliability receipt\n${stdout}\n${stderr}`).toBeDefined();
      const evidence = JSON.parse(receipt!.slice('NATIVE_RELIABILITY_RECEIPT '.length));
      expect(evidence.automaticRecovery).toBe(false);
      expect(evidence.cases.map((entry: any) => entry.shared)).toEqual([false, true]);
      for (const entry of evidence.cases) {
        expect(entry.crashes).toHaveLength(2);
        expect(entry.replayComparisons).toBe(4);
        expect(entry.replayStepsPerGraph).toBe(20);
      }
      // This is a new, generated receipt, not a production/tracker update.
      // A failed run leaves the prior receipt untouched; no failure is greenwashed.
      // Formatting matches Prettier's JSON style (2-space indent, short arrays
      // collapsed inline) so regenerated receipts never fail the format gate.
      writeFileSync(
        path.join(process.cwd(), 'validation', 'native', 'reliability-worker-recreation.receipt.json'),
        `${prettierJson({ ...evidence, runner: 'vitest', passed: true })}\n`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      // Always observe the close promise, including assertion failure paths.
      await exit.catch(() => undefined);
    }
  }, 25000);
});
