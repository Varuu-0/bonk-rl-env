/**
 * Benchmark Runner — Consolidated Benchmark Suite
 *
 * Discovers and runs all TypeScript benchmark layers, collects
 * JSON output, and prints a consolidated summary report mirroring
 * the test suite runner format.
 *
 * Run: npx tsx benchmarks/runner.ts [layer] [--list]
 * Layer numbers: 1-6, or "all" for everything.
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

const REPORT_WIDTH = 78;

interface BenchmarkMetric {
    label: string;
    value: number;
    unit: string;
}

interface BenchmarkResult {
    layer: number;
    name: string;
    passed: boolean;
    status: string;
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

interface SuiteRunResult {
    layer: number;
    file: string;
    name: string;
    suite: BenchmarkSuite | null;
    durationMs: number;
    status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT' | 'SKIP';
    exitCode: number | null;
    rawOutput: string;
    error?: string;
}

const LAYERS: Record<string, { file: string; name: string; description: string }> = {
    '1': { file: 'layer1-primitives.ts', name: 'Primitives', description: 'Atomics, TypedArray, object allocation latencies' },
    '2': { file: 'layer2-physics.ts', name: 'Raw Physics', description: 'Box2D physics engine tick throughput (isolated)' },
    '3': { file: 'layer3-environment.ts', name: 'Environment', description: 'BonkEnvironment step throughput (no IPC)' },
    '4': { file: 'layer4-worker-pool.ts', name: 'Worker Pool', description: 'SharedArrayBuffer IPC throughput across env counts' },
    '5': { file: 'layer5-memory.ts', name: 'Memory', description: 'Heap stability and reset cycle memory leaks' },
    '6': { file: 'layer6-stability.ts', name: 'Stability', description: 'Long-running throughput variance and GC pressure' },
};

function print(text: string, color?: string) {
    if (color) console.log(color + text + colors.reset);
    else console.log(text);
}

function printHeader() {
    if (process.stdout.isTTY) console.clear();
    print('========================================================', colors.cyan);
    print('  BONK.RL-ENV — BENCHMARK SUITE', colors.cyan);
    print('========================================================', colors.cyan);
    console.log();
}

function parseJsonFromOutput(output: string): BenchmarkSuite | null {
    const startMarker = '__BENCH_JSON_START__';
    const endMarker = '__BENCH_JSON_END__';
    const startIdx = output.indexOf(startMarker);
    const endIdx = output.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) return null;
    const json = output.substring(startIdx + startMarker.length, endIdx).trim();
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

const BENCH_TIMEOUT = 600_000; // 10 minutes

function runLayer(layerKey: string): Promise<SuiteRunResult> {
    return new Promise((resolve) => {
        const layer = LAYERS[layerKey];
        const benchPath = path.join(__dirname, layer.file);

        if (!fs.existsSync(benchPath)) {
            resolve({
                layer: +layerKey, file: layer.file, name: layer.name, suite: null,
                durationMs: 0, status: 'SKIP', exitCode: null, rawOutput: '',
                error: 'File not found',
            });
            return;
        }

        print(`Running Layer ${layerKey}: ${layer.name} ...`, colors.cyan);
        const startHr = process.hrtime.bigint();
        let rawOutput = '';
        let timedOut = false;

        const child = spawn('npx', ['tsx', benchPath], {
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
        }, BENCH_TIMEOUT);

        child.on('close', (code) => {
            clearTimeout(timeout);
            const elapsed = Number(process.hrtime.bigint() - startHr) / 1e6;
            const suite = parseJsonFromOutput(rawOutput);

            const status: SuiteRunResult['status'] = timedOut
                ? 'TIMEOUT'
                : code !== 0 && !suite
                    ? 'ERROR'
                    : suite && (suite.failed > 0 || suite.errored > 0)
                        ? 'FAIL'
                        : 'PASS';

            resolve({
                layer: +layerKey, file: layer.file, name: layer.name, suite,
                durationMs: elapsed, status, exitCode: code, rawOutput,
                error: timedOut ? `Timed out after ${BENCH_TIMEOUT}ms` : undefined,
            });
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            const elapsed = Number(process.hrtime.bigint() - startHr) / 1e6;
            resolve({
                layer: +layerKey, file: layer.file, name: layer.name, suite: null,
                durationMs: elapsed, status: 'ERROR', exitCode: null, rawOutput,
                error: err.message,
            });
        });
    });
}

function pad(text: string, len: number): string {
    return text.length >= len ? text.substring(0, len) : text + ' '.repeat(len - text.length);
}

function padLeft(text: string, len: number): string {
    return text.length >= len ? text.substring(0, len) : ' '.repeat(len - text.length) + text;
}

function progressBar(pct: number, width: number): string {
    const filled = Math.round((pct / 100) * width);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function getMetric(results: BenchmarkResult[], benchName: string, label: string): number | undefined {
    const bench = results.find(r => r.name === benchName);
    if (!bench) return undefined;
    return bench.metrics.find(m => m.label === label)?.value;
}

function fmtNum(v: number | undefined, suffix = ''): string {
    if (v === undefined) return 'N/A';
    if (typeof v !== 'number' || isNaN(v)) return 'N/A';
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M' + suffix;
    if (Math.abs(v) >= 10_000) return v.toLocaleString() + suffix;
    if (Math.abs(v) >= 100) return v.toFixed(0) + suffix;
    if (Math.abs(v) >= 1) return v.toFixed(2) + suffix;
    return v.toFixed(4) + suffix;
}

function printConsolidatedSummary(results: SuiteRunResult[]) {
    const totalSuites = results.length;
    const totalBenchmarks = results.reduce((s, r) => s + (r.suite?.results.length ?? 0), 0);
    const totalPassed = results.reduce((s, r) => s + (r.suite?.passed ?? 0), 0);
    const totalFailed = results.reduce((s, r) => s + (r.suite?.failed ?? 0), 0);
    const totalSkipped = results.reduce((s, r) => s + (r.suite?.skipped ?? 0), 0);
    const totalErrored = results.reduce((s, r) => s + (r.suite?.errored ?? 0), 0);
    const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
    const overallPassRate = totalBenchmarks > 0 ? (totalPassed / totalBenchmarks) * 100 : 0;

    const hr = '\u2500'.repeat(REPORT_WIDTH);
    const topLine = '\u2554' + '\u2550'.repeat(REPORT_WIDTH) + '\u2557';
    const botLine = '\u255A' + '\u2550'.repeat(REPORT_WIDTH) + '\u255D';
    const midLine = '\u2551' + ' CONSOLIDATED BENCHMARK REPORT '.padStart(41).padEnd(REPORT_WIDTH) + '\u2551';

    console.log();
    print(topLine, colors.cyan);
    print(midLine, colors.cyan);
    print(botLine, colors.cyan);
    console.log();

    // ─── OVERALL SUMMARY ─────────────────────────────────────────────
    print('OVERALL SUMMARY', colors.bright + colors.white);
    print(hr);

    const barWidth = 44;
    const passRateStr = totalBenchmarks > 0 ? (overallPassRate.toFixed(1) + '%') : 'N/A';
    const passBar = progressBar(overallPassRate, barWidth);

    print(`  Total Layers:        ${totalSuites}`);
    print(`  Total Benchmarks:    ${totalBenchmarks}`);
    print(`  Passed:              ${padLeft(String(totalPassed), 4)}  ${passBar}  ${passRateStr}`, colors.green);
    print(`  Failed:              ${padLeft(String(totalFailed), 4)}`, totalFailed > 0 ? colors.red : colors.green);
    print(`  Errors:              ${padLeft(String(totalErrored), 4)}`, totalErrored > 0 ? colors.yellow : colors.green);
    print(`  Skipped:             ${padLeft(String(totalSkipped), 4)}`);
    print(`  Total Duration:      ${(totalDuration / 1000).toFixed(2)}s`);

    console.log();

    // ─── LAYER BREAKDOWN TABLE ───────────────────────────────────────
    print('LAYER BREAKDOWN', colors.bright + colors.white);
    print(hr);

    const numW = 2; const nameW = 16; const benchW = 7; const passW = 6;
    const failW = 6; const durW = 10; const rateW = 7; const statusW = 6;

    const header =
        '  ' + pad('#', numW) + '  ' +
        pad('Layer', nameW) + ' ' +
        padLeft('Bench', benchW) + ' ' +
        padLeft('Pass', passW) + ' ' +
        padLeft('Fail', failW) + ' ' +
        padLeft('Duration', durW) + ' ' +
        padLeft('Rate', rateW) + ' ' +
        ' ' + pad('Status', statusW);

    print(header, colors.bright + colors.white);
    print('  ' + '\u2500'.repeat(numW) + ' ' +
        '\u2500'.repeat(nameW) + ' ' +
        '\u2500'.repeat(benchW) + ' ' +
        '\u2500'.repeat(passW) + ' ' +
        '\u2500'.repeat(failW) + ' ' +
        '\u2500'.repeat(durW) + ' ' +
        '\u2500'.repeat(rateW) + ' ' +
        '\u2500'.repeat(statusW));

    for (const r of results) {
        const s = r.suite;
        const n = s ? s.results.length : 0;
        const p = s ? s.passed : 0;
        const f = s ? (s.failed + s.errored) : 0;
        const rate = n > 0 ? ((p / n) * 100).toFixed(1) + '%' : 'N/A';
        const statusColor =
            r.status === 'PASS' ? colors.green :
                r.status === 'FAIL' ? colors.red :
                    colors.yellow;

        const row =
            pad(String(r.layer), numW + 2) +
            pad(r.name, nameW) + ' ' +
            padLeft(String(n), benchW) + ' ' +
            padLeft(String(p), passW) + ' ' +
            padLeft(String(f), failW) + ' ' +
            padLeft((r.durationMs / 1000).toFixed(2) + 's', durW) + ' ' +
            padLeft(rate, rateW) + ' ' +
            pad(statusColor + r.status + colors.reset + ' '.repeat(Math.max(0, statusW - r.status.length + 7)), statusW + 7);

        console.log(row);
    }

    console.log();

    // ─── DETAILED METRICS PER LAYER ──────────────────────────────────
    print('DETAILED BENCHMARK RESULTS', colors.bright + colors.white);
    print(hr);

    for (const r of results) {
        if (!r.suite || r.suite.results.length === 0) continue;
        print(`\n  Layer ${r.layer}: ${r.name}`, colors.bright + colors.cyan);
        print(`  ${r.suite.description}`, colors.dim);

        for (const bench of r.suite.results) {
            const tag = bench.status === 'PASS' ? '\u2713' : bench.status === 'FAIL' ? '\u2717' : bench.status === 'SKIP' ? '\u25CB' : '!';
            const tagColor = bench.status === 'PASS' ? colors.green : bench.status === 'FAIL' ? colors.red : colors.yellow;
            print(`\n    ${tagColor}${tag} ${bench.name}${colors.reset}`);

            if (bench.metrics.length === 0 && bench.error) {
                print(`      ${bench.error}`, colors.gray);
                continue;
            }

            // Print all metrics in a consistent two-column format
            const labelMaxLen = Math.max(...bench.metrics.map(m => m.label.length), 12);
            for (const m of bench.metrics) {
                const valStr = typeof m.value === 'number' && Math.abs(m.value) >= 10000
                    ? m.value.toLocaleString()
                    : String(m.value);
                print(`      ${pad(m.label, labelMaxLen)}  ${padLeft(valStr, 12)} ${m.unit}`, colors.dim);
            }

            if (bench.error) {
                print(`      Error: ${bench.error}`, colors.red);
            }
        }
    }

    console.log();

    // ─── SCALING ANALYSIS (Layer 4) ─────────────────────────────────
    const layer4 = results.find(r => r.layer === 4 && r.suite);
    if (layer4 && layer4.suite) {
        print('SCALING ANALYSIS (Layer 4: Worker Pool)', colors.bright + colors.white);
        print(hr);

        const n1Sps = getMetric(layer4.suite.results, 'WorkerPool.step() N=1', 'SPS (per-env)') ?? 0;

        const scHeader =
            '  ' + pad('N', 4) + ' ' +
            padLeft('SPS', 10) + ' ' +
            padLeft('Env-SPS', 12) + ' ' +
            padLeft('Speedup', 10) + ' ' +
            padLeft('Efficiency', 12) + ' ' +
            padLeft('Latency', 10);

        print(scHeader, colors.bright + colors.white);
        print('  ' + '\u2500'.repeat(4) + ' ' +
            '\u2500'.repeat(10) + ' ' +
            '\u2500'.repeat(12) + ' ' +
            '\u2500'.repeat(10) + ' ' +
            '\u2500'.repeat(12) + ' ' +
            '\u2500'.repeat(10));

        for (const bench of layer4.suite.results) {
            const n = bench.metrics.find(m => m.label === 'Envs')?.value ?? 0;
            const sps = bench.metrics.find(m => m.label === 'SPS (per-env)')?.value ?? 0;
            const envSps = bench.metrics.find(m => m.label === 'Env-SPS (aggregate)')?.value ?? 0;
            const latency = bench.metrics.find(m => m.label === 'Latency')?.value ?? 0;
            const speedup = n1Sps > 0 ? (envSps / n1Sps) : 0;
            const efficiency = n > 0 ? (speedup / n) * 100 : 0;

            const row =
                '  ' + pad(String(n), 4) + ' ' +
                padLeft(sps.toLocaleString(), 10) + ' ' +
                padLeft(envSps.toLocaleString(), 12) + ' ' +
                padLeft(speedup.toFixed(2) + 'x', 10) + ' ' +
                padLeft(efficiency.toFixed(1) + '%', 12) + ' ' +
                padLeft(latency.toFixed(3) + 'ms', 10);
            print(row);
        }

        console.log();

        // Scaling insights
        const envCounts = layer4.suite.results.map(b => b.metrics.find(m => m.label === 'Envs')?.value ?? 0);
        const envSpsValues = layer4.suite.results.map(b => b.metrics.find(m => m.label === 'Env-SPS (aggregate)')?.value ?? 0);
        const maxIdx = envSpsValues.indexOf(Math.max(...envSpsValues));
        print(`  Peak aggregate throughput: ${fmtNum(envSpsValues[maxIdx])} env-steps/sec at N=${envCounts[maxIdx]}`, colors.dim);
        const n16 = getMetric(layer4.suite.results, 'WorkerPool.step() N=16', 'SPS (per-env)');
        if (n16) print(`  Per-env SPS at N=16: ${n16.toLocaleString()} (serial Atomics.wait overhead visible)`, colors.dim);
    }

    console.log();

    // ─── PIPELINE COST BREAKDOWN ─────────────────────────────────────
    print('PIPELINE COST BREAKDOWN', colors.bright + colors.white);
    print(hr);

    const layer2 = results.find(r => r.layer === 2 && r.suite);
    const layer3 = results.find(r => r.layer === 3 && r.suite);
    const layer4_1 = results.find(r => r.layer === 4 && r.suite);

    if (layer2 && layer3 && layer4_1) {
        const rawTps = getMetric(layer2.suite!.results, 'PhysicsEngine.tick() (2 players, applyInput + tick)', 'TPS');
        const envSps = getMetric(layer3.suite!.results, 'BonkEnvironment.step() (1 AI + 1 opponent)', 'SPS');
        const poolSps = getMetric(layer4_1.suite!.results, 'WorkerPool.step() N=1', 'SPS (per-env)');

        if (rawTps && envSps && poolSps) {
            // Note: L2 simulates 2 players, L3 simulates 1 AI + 1 opponent.
            // Compare per-step latency rather than raw SPS for meaningful overhead.
            const envStepUs = 1_000_000 / envSps;
            const rawStepUs = 1_000_000 / rawTps;
            const ipcStepUs = 1_000_000 / poolSps;
            const envOverheadUs = envStepUs - rawStepUs;
            const ipcOverheadUs = ipcStepUs - envStepUs;

            print(`\n  Layer              Latency       Throughput    Overhead    Breakdown`, colors.bright + colors.white);
            print(`  ${'\u2500'.repeat(72)}`);
            print(`  Raw Physics (L2)   ${padLeft(rawStepUs.toFixed(1) + 'us', 8)}     ${padLeft(rawTps.toLocaleString(), 10)} TPS  (baseline)`);
            print(`  + Env (L3)         ${padLeft(envStepUs.toFixed(1) + 'us', 8)}     ${padLeft(envSps.toLocaleString(), 10)} SPS  +${padLeft(envOverheadUs.toFixed(1) + 'us', 8)} obs+reward+decode+frame-skip`);
            print(`  + IPC (L4)         ${padLeft(ipcStepUs.toFixed(1) + 'us', 8)}     ${padLeft(poolSps.toLocaleString(), 10)} SPS  +${padLeft(ipcOverheadUs.toFixed(1) + 'us', 8)} Atomics sync+serial wait`);
            print(`  ${'\u2500'.repeat(72)}`);
            print(`  Total step cost:   ${padLeft(ipcStepUs.toFixed(1) + 'us', 8)}     ${padLeft(poolSps.toLocaleString(), 10)} SPS`, colors.bright);

            const frameSkipSps = getMetric(layer3.suite!.results, 'BonkEnvironment.step() (frameSkip=3)', 'SPS');
            if (frameSkipSps) {
                const fsStepUs = 1_000_000 / frameSkipSps;
                print(`\n  frameSkip=3:       ${padLeft(fsStepUs.toFixed(1) + 'us', 8)}     ${padLeft(frameSkipSps.toLocaleString(), 10)} SPS  (skips physics on 2/3 ticks)`, colors.dim);
            }

            print(`\n  Note: L2 uses 2 players, L3 uses 1 AI + 1 opponent. Per-step overhead is`, colors.dim);
            print(`  comparable but absolute throughput differs due to player count.`, colors.dim);
        }
    }

    console.log();

    // ─── MEMORY ANALYSIS (Layer 5) ──────────────────────────────────
    const layer5 = results.find(r => r.layer === 5 && r.suite);
    if (layer5 && layer5.suite) {
        print('MEMORY ANALYSIS (Layer 5)', colors.bright + colors.white);
        print(hr);

        const stability = layer5.suite.results.find(r => r.name.includes('Memory stability'));
        const resetCycles = layer5.suite.results.find(r => r.name.includes('Reset cycles'));

        if (stability) {
            const growth = stability.metrics.find(m => m.label === 'Heap growth')?.value ?? 0;
            const peakRss = stability.metrics.find(m => m.label === 'Peak RSS')?.value ?? 0;
            const tag = growth < 5 ? '\u2713' : '\u2717';
            const tagColor = growth < 5 ? colors.green : colors.red;
            print(`\n  ${tagColor}${tag} Step loop stability (50K steps)${colors.reset}`);
            print(`    Heap growth: ${fmtNum(growth)} MB — ${growth < 5 ? 'stable (GC collects objects)' : 'LEAK: significant heap growth'}`, colors.dim);
            print(`    Peak RSS: ${fmtNum(peakRss)} MB`, colors.dim);
        }

        if (resetCycles) {
            const growth = resetCycles.metrics.find(m => m.label === 'Heap growth')?.value ?? 0;
            const tag = growth < 10 ? '\u2713' : '\u2717';
            const tagColor = growth < 10 ? colors.green : colors.red;
            print(`\n  ${tagColor}${tag} Reset cycle leak test (200 resets)${colors.reset}`);
            print(`    Heap growth: ${fmtNum(growth)} MB — ${growth >= 10 ? 'LEAK: PhysicsEngine objects not fully GC\'d' : 'no significant leak'}`, colors.dim);
            if (growth >= 10) {
                print(`    Root cause: environment.ts reset() creates new PhysicsEngine + PRNG each call`, colors.gray);
                print(`    Recommendation: reuse engine via destroyAllBodies() instead of new instance`, colors.gray);
            }
        }
    }

    console.log();

    // ─── STABILITY ANALYSIS (Layer 6) ───────────────────────────────
    const layer6 = results.find(r => r.layer === 6 && r.suite);
    if (layer6 && layer6.suite) {
        print('STABILITY ANALYSIS (Layer 6)', colors.bright + colors.white);
        print(hr);

        for (const bench of layer6.suite.results) {
            const cvAll = bench.metrics.find(m => m.label === 'CV (all)')?.value ?? 0;
            const cvStable = bench.metrics.find(m => m.label === 'CV (stable)')?.value ?? cvAll;
            const tag = bench.status === 'PASS' ? '\u2713' : '\u2717';
            const tagColor = bench.status === 'PASS' ? colors.green : colors.red;
            const interpretation = cvStable < 10 ? 'stable' : cvStable < 20 ? 'moderate variance' : 'high variance (GC pauses / straggler workers)';
            print(`\n  ${tagColor}${tag} ${bench.name}${colors.reset}`);
            print(`    CV (all segments):  ${cvAll.toFixed(1)}%`, colors.dim);
            print(`    CV (stable):        ${cvStable.toFixed(1)}% — ${interpretation}`, colors.dim);

            const minSps = bench.metrics.find(m => m.label === 'Min segment SPS')?.value;
            const maxSps = bench.metrics.find(m => m.label === 'Max segment SPS')?.value;
            if (minSps !== undefined && maxSps !== undefined) {
                print(`    Min-Max range: ${minSps.toLocaleString()} - ${maxSps.toLocaleString()} SPS`, colors.gray);
            }
        }
    }

    console.log();

    // ─── TIMING ANALYSIS ────────────────────────────────────────────
    print('TIMING ANALYSIS', colors.bright + colors.white);
    print(hr);

    const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs);
    const slowest = sorted[0];
    const fastest = sorted[sorted.length - 1];
    const avg = totalDuration / totalSuites;
    const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1].durationMs + sorted[sorted.length / 2].durationMs) / 2
        : sorted[Math.floor(sorted.length / 2)].durationMs;

    print(`  Slowest Layer:  ${pad(slowest.name, 16)} (${(slowest.durationMs / 1000).toFixed(2)}s)`);
    print(`  Fastest Layer:  ${pad(fastest.name, 16)} (${(fastest.durationMs / 1000).toFixed(2)}s)`);
    print(`  Average Layer:  ${(avg / 1000).toFixed(2)}s`);
    print(`  Median Layer:   ${(median / 1000).toFixed(2)}s`);

    console.log();
    print('  Top Slowest:', colors.dim);
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        print(`    ${i + 1}. ${pad(sorted[i].name, 16)} ${(sorted[i].durationMs / 1000).toFixed(2)}s`, colors.dim);
    }

    console.log();

    // ─── FAILURE DETAILS ────────────────────────────────────────────
    const failures: Array<{ layer: string; name: string; rootCause: string; recommendation: string }> = [];
    for (const r of results) {
        if (!r.suite) continue;
        for (const bench of r.suite.results) {
            if (bench.status !== 'FAIL') continue;
            let rootCause = '';
            let recommendation = '';

            if (bench.name.includes('Atomics.wait blocking')) {
                rootCause = 'Cross-thread Atomics.wait round-trip is inherently expensive (~40ms per ping-pong)';
                recommendation = 'This is expected; blocking Atomics.wait is for synchronization, not throughput. Accept the cost.';
            } else if (bench.name.includes('Reset cycles')) {
                rootCause = 'BonkEnvironment.reset() allocates new PhysicsEngine + PRNG each call instead of reusing';
                recommendation = 'Implement destroyAllBodies() in PhysicsEngine to clear and reuse the existing world';
            } else if (bench.name.includes('stability')) {
                rootCause = 'High coefficient of variation even after excluding JIT warmup segment';
                recommendation = 'GC pauses or straggler workers causing intermittent slowdowns; consider --expose-gc flag';
            } else {
                rootCause = 'See metrics above for details';
                recommendation = 'Review benchmark-specific thresholds';
            }

            failures.push({
                layer: `Layer ${r.layer}: ${r.name}`,
                name: bench.name,
                rootCause,
                recommendation,
            });
        }
    }

    print('FAILURE DETAILS', colors.bright + colors.white);
    print(hr);

    if (failures.length === 0) {
        print('  No failures to report.', colors.green);
    } else {
        for (const f of failures) {
            print(`\n  [${f.layer}] "${f.name}"`, colors.red);
            print(`    \u2514\u2500 Root cause: ${f.rootCause}`, colors.gray);
            print(`    \u2514\u2500 Fix: ${f.recommendation}`, colors.yellow);
        }
    }

    console.log();
    print('\u2550'.repeat(REPORT_WIDTH + 2), colors.cyan);
    console.log();
}

async function runAllLayers() {
    print('RUNNING FULL BENCHMARK SUITE...', colors.yellow);
    console.log();

    const results: SuiteRunResult[] = [];
    const keys = Object.keys(LAYERS).sort();

    for (const key of keys) {
        try {
            const result = await runLayer(key);
            results.push(result);
            if (result.status === 'PASS') {
                print(`PASS: Layer ${key} (${(result.durationMs / 1000).toFixed(2)}s)`, colors.green);
            } else {
                print(`${result.status}: Layer ${key}`, result.status === 'FAIL' ? colors.red : colors.yellow);
            }
        } catch (error: any) {
            results.push({
                layer: +key, file: LAYERS[key].file, name: LAYERS[key].name, suite: null,
                durationMs: 0, status: 'ERROR', exitCode: null, rawOutput: '',
                error: error.message,
            });
        }
    }

    printConsolidatedSummary(results);

    const anyFailed = results.some(r => r.status !== 'PASS');
    process.exit(anyFailed ? 1 : 0);
}

async function runSingleLayer(key: string) {
    try {
        const result = await runLayer(key);
        if (result.status === 'PASS') {
            print(`\nPASS: Layer ${key} — ${result.name} (${(result.durationMs / 1000).toFixed(2)}s)`, colors.green);
            process.exit(0);
        } else {
            print(`\n${result.status}: Layer ${key} — ${result.name}`, colors.red);
            if (result.error) print(`  Error: ${result.error}`, colors.red);
            process.exit(1);
        }
    } catch (error: any) {
        print('Benchmark failed: ' + error.message, colors.red);
        process.exit(1);
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--list') || args.includes('list')) {
        printHeader();
        console.log('Available benchmark layers:\n');
        for (const [key, layer] of Object.entries(LAYERS)) {
            console.log(`  [${key}] ${pad(layer.name, 18)} ${layer.description}`);
        }
        console.log();
        console.log('Usage:');
        console.log('  npx tsx benchmarks/runner.ts all      Run all layers');
        console.log('  npx tsx benchmarks/runner.ts 2        Run layer 2 only');
        console.log('  npx tsx benchmarks/runner.ts --list   Show this listing');
        console.log();
        process.exit(0);
    }

    if (args.length === 0 || args[0] === 'all') {
        printHeader();
        await runAllLayers();
        return;
    }

    const key = args[0];
    if (LAYERS[key]) {
        printHeader();
        await runSingleLayer(key);
        return;
    }

    console.log(`Unknown layer: ${key}`);
    console.log('Use --list to see available layers');
    process.exit(1);
}

main().catch((err) => {
    print('Error: ' + err.message, colors.red);
    process.exit(1);
});
