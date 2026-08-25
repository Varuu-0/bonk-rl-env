/**
 * bench-report.ts — Shared benchmark reporting utility
 *
 * Provides structured JSON output for each benchmark layer,
 * a summary formatter for the runner, and the episode-aware
 * `stepLive()` stepper used by every native benchmark loop.
 * All benchmarks import this to produce consistent output.
 */

import type { Action, BonkEnvironment, StepResult } from '../core/environment';

export interface BenchmarkMetric {
  label: string;
  value: number;
  unit: string;
}

export interface BenchmarkResult {
  layer: number;
  name: string;
  passed: boolean;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';
  durationMs: number;
  metrics: BenchmarkMetric[];
  error?: string;
}

export interface BenchmarkSuite {
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

export interface LiveStepOutcome {
  /** The environment's step result, unchanged. */
  result: StepResult;
  /**
   * True when this step executed a physics tick. False only for
   * terminal-hold replay steps (frameSkip > 1), which return the recorded
   * terminal result without advancing physics (#197).
   */
  live: boolean;
  /** True when this call ended an episode and restarted the environment. */
  reset: boolean;
}

/**
 * Episode-aware step for native benchmark loops (#421).
 *
 * Long-running benchmarks must measure sustained *physics* throughput, but a
 * BonkEnvironment settles into a terminal state on any episode end (natural
 * death included) and then returns immediately from its terminal-hold branch
 * with zero physics work until an explicit `reset()` (#197). A loop that
 * ignores `done` therefore degenerates into measuring no-op steps once the
 * episode dies — on the default map that happens at tick ~44, so 95-99% of a
 * long run never touches Box2D and the reported SPS is fiction up to ~300x.
 *
 * `stepLive` mirrors what the worker transport already does via
 * `applyStepAutoReset` (src/core/worker.ts): it steps normally while the
 * episode runs; when a step reports done and the frame-skip terminal hold has
 * been served (`!env.isTerminalHoldActive()`, i.e. frameSkip = 1 or the hold
 * window elapsed), it resets so the next step starts a fresh episode on the
 * physics path. On that reset step the result keeps the ended episode's
 * observation so callers see worker-parity terminal results (#222). Callers
 * should count only `live` steps toward SPS — with frameSkip = 1 every
 * measured step is live up to the reset bookkeeping, and with frameSkip > 1
 * the per-episode terminal window (terminal step plus hold replays) is
 * excluded instead of diluting the measurement with no-op steps. The
 * classification trades the episode's final physics step against its
 * restart step, so the residual error is at most one step per episode.
 */
export function stepLive(env: BonkEnvironment, action: Action): LiveStepOutcome {
  const result = env.step(action);
  if (!result.done) {
    return { result, live: true, reset: false };
  }
  if (env.isTerminalHoldActive()) {
    // Mid-hold replay of the recorded terminal result: no physics ran,
    // and the worker transport would not reset here either (#228).
    return { result, live: false, reset: false };
  }
  // Final report of the ended episode: this step itself advanced physics
  // to the terminal state. Preserve the terminal observation across the
  // reset (the shared-memory transport's observations alias buffers that
  // reset overwrites, so applyStepAutoReset keeps the same guarantee).
  const terminalObservation = result.observation;
  env.reset();
  result.observation = terminalObservation;
  return { result, live: true, reset: true };
}

/**
 * Create an empty suite shell.
 */
export function createSuite(layer: number, name: string, description: string): BenchmarkSuite {
  return { layer, name, description, results: [], durationMs: 0, passed: 0, failed: 0, skipped: 0, errored: 0 };
}

/**
 * Record a single result into a suite.
 */
export function recordResult(suite: BenchmarkSuite, result: BenchmarkResult): void {
  suite.results.push(result);
  if (result.status === 'PASS') suite.passed++;
  else if (result.status === 'FAIL') suite.failed++;
  else if (result.status === 'SKIP') suite.skipped++;
  else if (result.status === 'ERROR') suite.errored++;
}

/**
 * Finalize suite timing.
 */
export function finalizeSuite(suite: BenchmarkSuite, totalMs: number): BenchmarkSuite {
  suite.durationMs = totalMs;
  return suite;
}

/**
 * Write suite JSON to stdout (for runner to capture) and optionally to file.
 */
export function emitSuite(suite: BenchmarkSuite, filePath?: string): void {
  const json = JSON.stringify(suite, null, 2);

  // Machine-readable JSON for the runner
  console.log('__BENCH_JSON_START__');
  console.log(json);
  console.log('__BENCH_JSON_END__');

  if (filePath) {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, json + '\n');
    } catch {
      // best-effort file write
    }
  }
}

/**
 * Format a suite for human-readable console output.
 */
export function formatSuiteSummary(suite: BenchmarkSuite): string {
  const lines: string[] = [];
  const hr = '─'.repeat(60);

  lines.push('');
  lines.push(`=== Layer ${suite.layer}: ${suite.name} ===`);
  lines.push(suite.description);
  lines.push(hr);

  for (const r of suite.results) {
    const tag = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : r.status === 'SKIP' ? '○' : '!';
    lines.push(`${tag} ${r.name}`);
    for (const m of r.metrics) {
      lines.push(`    ${m.label}: ${formatValue(m.value)} ${m.unit}`);
    }
    if (r.error) {
      lines.push(`    ERROR: ${r.error}`);
    }
  }

  lines.push(hr);
  const total = suite.passed + suite.failed + suite.skipped + suite.errored;
  const rate = total > 0 ? ((suite.passed / total) * 100).toFixed(1) : '0.0';
  lines.push(
    `Results: ${suite.passed} passed, ${suite.failed} failed, ${suite.errored} errors, ${suite.skipped} skipped (${rate}%)`,
  );
  lines.push(`Duration: ${(suite.durationMs / 1000).toFixed(2)}s`);
  lines.push('');

  return lines.join('\n');
}

function formatValue(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toLocaleString();
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
