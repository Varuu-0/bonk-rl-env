/**
 * bench-report.ts — Shared benchmark reporting utility
 *
 * Provides structured JSON output for each benchmark layer and
 * a summary formatter for the runner. All benchmarks import this
 * to produce consistent output.
 */

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
    lines.push(`Results: ${suite.passed} passed, ${suite.failed} failed, ${suite.errored} errors, ${suite.skipped} skipped (${rate}%)`);
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
