/**
 * High-precision telemetry profiler with zero-allocation hot path.
 *
 * Design:
 *   - A global BigUint64Array accumulator indexed by TelemetryIndices.
 *   - A wrap(label, fn) helper that returns a wrapped function which
 *     records elapsed time using process.hrtime.bigint().
 *   - The wrapper supports both sync and async functions and guarantees
 *     that timing is recorded even when errors are thrown (finally block).
 */

// ─── Global Telemetry Registry ───────────────────────────────────────────

export const TelemetryIndices = {
    PHYSICS_TICK: 0,
    RAYCAST_CALL: 1,
    COLLISION_RESOLVE: 2,
    ZMQ_SEND: 3,
    JSON_PARSE: 4,
} as const;

const TELEMETRY_SLOT_COUNT = 5;

/**
 * Global accumulator for nanoseconds spent in each telemetry bucket.
 * This is safe to import from workers; each worker process gets its own
 * view, and worker.ts can aggregate and report these stats upstream.
 */
export const TelemetryBuffer = new BigUint64Array(TELEMETRY_SLOT_COUNT);

// Pre-computed label lookup by index to avoid allocations in report().
const TelemetryLabels: string[] = [];
TelemetryLabels[TelemetryIndices.PHYSICS_TICK] = 'PHYSICS_TICK';
TelemetryLabels[TelemetryIndices.RAYCAST_CALL] = 'RAYCAST_CALL';
TelemetryLabels[TelemetryIndices.COLLISION_RESOLVE] = 'COLLISION_RESOLVE';
TelemetryLabels[TelemetryIndices.ZMQ_SEND] = 'ZMQ_SEND';
TelemetryLabels[TelemetryIndices.JSON_PARSE] = 'JSON_PARSE';

// Latest worker telemetry snapshots (set from the main thread).
let latestWorkerTelemetry: BigUint64Array[] | null = null;

export function setLatestWorkerTelemetry(snapshots: BigUint64Array[] | null): void {
    latestWorkerTelemetry = snapshots;
}

// Target frame budget for 30 FPS in nanoseconds (33.3ms ≈ 33_333_333ns).
const FRAME_BUDGET_NS = BigInt(33_333_333);

// Helper to detect async functions without allocating on the hot path.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const AsyncFunction = (async function () { /* empty */ }).constructor as FunctionConstructor;

/**
 * Decorator-style wrapper around a function that profiles its wall-clock time.
 *
 * Constraints respected:
 *   - No object or array literals are created on the hot path.
 *   - Works for both synchronous and async (Promise-returning) functions.
 *   - Timing is always recorded via a finally block, even on error.
 */
export function wrap(label: keyof typeof TelemetryIndices | string, fn: Function): Function {
    const index = (TelemetryIndices as any)[label];
    if (index === undefined) {
        throw new Error(`Unknown telemetry label: ${label}`);
    }

    // Async functions get an async wrapper that awaits the inner function.
    if ((fn as any).constructor === AsyncFunction) {
        const wrappedAsync = async function (this: unknown): Promise<unknown> {
            const start = process.hrtime.bigint();
            try {
                // Use arguments object to avoid rest parameter allocations.
                return await (fn as any).apply(this, arguments as any);
            } finally {
                const end = process.hrtime.bigint();
                TelemetryBuffer[index] += end - start;
            }
        };
        return wrappedAsync;
    }

    // Synchronous fast-path wrapper.
    const wrappedSync = function (this: unknown): unknown {
        const start = process.hrtime.bigint();
        try {
            return (fn as any).apply(this, arguments as any);
        } finally {
            const end = process.hrtime.bigint();
            TelemetryBuffer[index] += end - start;
        }
    };
    return wrappedSync;
}

// ─── Legacy Profiler API (counters / gauges / reporting) ────────────────

interface TimeMetric {
    totalNs: bigint;
    count: number;
}

export class Profiler {
    private timeMetrics: Map<string, TimeMetric> = new Map();
    private activeTimers: Map<string, bigint> = new Map();
    private counters: Map<string, number> = new Map();
    private gauges: Map<string, number> = new Map();

    private startTick: number = 0;
    private currentTick: number = 0;

    constructor() { }

    /**
     * Mark a tick of the simulation.
     */
    tick() {
        this.currentTick++;
    }

    /**
     * Start timing a block of code (legacy manual API).
     * Kept for compatibility; new code should prefer wrap().
     */
    start(label: string) {
        this.activeTimers.set(label, process.hrtime.bigint());
    }

    /**
     * Stop timing a block and record the duration (legacy manual API).
     */
    end(label: string) {
        const startTime = this.activeTimers.get(label);
        if (startTime === undefined) return;

        const duration = process.hrtime.bigint() - startTime;

        let metric = this.timeMetrics.get(label);
        if (!metric) {
            metric = { totalNs: BigInt(0), count: 0 };
            this.timeMetrics.set(label, metric);
        }
        metric.totalNs += duration;
        metric.count += 1;
        this.activeTimers.delete(label);
    }

    /**
     * Increment a non-time based counter (e.g. collisions).
     */
    increment(label: string, amount: number = 1) {
        const val = this.counters.get(label) || 0;
        this.counters.set(label, val + amount);
    }

    /**
     * Set a gauge to a specific value (e.g. memory usage).
     */
    gauge(label: string, value: number) {
        this.gauges.set(label, value);
    }

    /**
     * Record current process memory usage.
     */
    recordMemory() {
        const mem = process.memoryUsage();
        this.gauge('Memory (Heap Used MB)', mem.heapUsed / 1024 / 1024);
        this.gauge('Memory (RSS MB)', mem.rss / 1024 / 1024);
    }

    /**
     * Get current metrics and reset them. Useful for worker-to-main aggregation.
     */
    getAndResetMetrics() {
        const metrics = {
            timeMetrics: Array.from(this.timeMetrics.entries()),
            counters: Array.from(this.counters.entries()),
            gauges: Array.from(this.gauges.entries())
        };
        this.reset();
        return metrics;
    }

    /**
     * Reset metrics for the next window.
     */
    reset() {
        this.timeMetrics.clear();
        this.counters.clear();
        this.startTick = this.currentTick;

        // Also reset the global telemetry accumulator.
        for (let i = 0; i < TelemetryBuffer.length; i++) {
            TelemetryBuffer[i] = BigInt(0);
        }
    }

    /**
     * Output a heatmap-style report of telemetry usage.
     * @param windowSize Number of ticks in this reporting window.
     */
    report(windowSize: number = 5000) {
        if (this.currentTick - this.startTick < windowSize) return;

        const windowTicks = this.currentTick - this.startTick;

        console.log(`\n=== Telemetry Heatmap (Avg over last ${windowTicks} ticks) ===`);
        console.log('Label                | Avg ms/frame | % of 33.3ms frame');
        console.log('---------------------+-------------+-------------------');

        for (let i = 0; i < TelemetryBuffer.length; i++) {
            const totalNs = TelemetryBuffer[i];
            if (totalNs === BigInt(0)) continue;

            const label = TelemetryLabels[i];
            if (!label) continue;

            const avgNsPerFrame = totalNs / BigInt(windowTicks);
            const avgMsPerFrame = Number(avgNsPerFrame) / 1_000_000;

            // Fixed-point arithmetic in basis points to avoid BigInt/float mixing.
            const hundred = BigInt(100);
            const bp = (avgNsPerFrame * hundred * hundred) / FRAME_BUDGET_NS; // 100 * 100 = 10_000 (basis points)
            const percent = Number(bp) / 100; // back to percentage with 2 decimal places

            const paddedLabel = (label + '                    ').slice(0, 21);
            const avgMsStr = avgMsPerFrame.toFixed(3).padStart(11);
            const pctStr = percent.toFixed(2).padStart(9);

            console.log(`${paddedLabel} | ${avgMsStr} | ${pctStr}%`);

            // Critical path highlight: scream when a bucket dominates the frame budget.
            if (percent > 25.0) {
                console.log(`⚠️ CRITICAL: ${label} is consuming ${percent.toFixed(2)}% of frame budget!`);
            }
        }

        // RimWorld-style global worker telemetry and straggler report.
        if (latestWorkerTelemetry && latestWorkerTelemetry.length > 0) {
            const workerCount = latestWorkerTelemetry.length;

            console.log('\n=== Global Worker Telemetry (per-metric lifetime stats) ===');
            console.log('Label                | Mean (ms) | Min (ms) | Max (ms)');
            console.log('---------------------+----------+----------+----------');

            let stragglerWorker = -1;
            let stragglerPhysicsNs = BigInt(0);

            for (let i = 0; i < TelemetryBuffer.length; i++) {
                let sumNs = BigInt(0);
                let minNs: bigint | null = null;
                let maxNs: bigint | null = null;

                for (let w = 0; w < workerCount; w++) {
                    const buf = latestWorkerTelemetry[w];
                    if (!buf || buf.length <= i) continue;
                    const v = buf[i];

                    if (minNs === null || v < minNs) {
                        minNs = v;
                    }
                    if (maxNs === null || v > maxNs) {
                        maxNs = v;
                    }
                    sumNs += v;

                    if (i === TelemetryIndices.PHYSICS_TICK && v > stragglerPhysicsNs) {
                        stragglerPhysicsNs = v;
                        stragglerWorker = w;
                    }
                }

                if (minNs === null || maxNs === null) {
                    continue;
                }

                const meanNs = sumNs / BigInt(workerCount);
                const meanMs = Number(meanNs) / 1_000_000;
                const minMs = Number(minNs) / 1_000_000;
                const maxMs = Number(maxNs) / 1_000_000;

                const label = TelemetryLabels[i];
                if (!label) continue;

                const paddedLabel = (label + '                    ').slice(0, 21);
                const meanStr = meanMs.toFixed(3).padStart(8);
                const minStr = minMs.toFixed(3).padStart(8);
                const maxStr = maxMs.toFixed(3).padStart(8);

                console.log(`${paddedLabel} | ${meanStr} | ${minStr} | ${maxStr}`);
            }

            if (stragglerWorker >= 0) {
                const physicsMs = Number(stragglerPhysicsNs) / 1_000_000;
                console.log(
                    `Straggler Report: [Worker ID: ${stragglerWorker}] | Physics Time: ${physicsMs.toFixed(
                        3,
                    )} ms | Status: Lagging.`,
                );
            }

            // Clear snapshots so they are not reused accidentally on the next report.
            latestWorkerTelemetry = null;
        }

        // Optionally keep the legacy tables for counters/gauges.
        if (this.counters.size > 0) {
            console.log('\n--- Throughput (legacy counters) ---');
            const countData: any[] = [];
            this.counters.forEach((val, label) => {
                countData.push({
                    Metric: label,
                    Total: val,
                    'Avg/Tick': (val / windowTicks).toFixed(4),
                });
            });
            console.table(countData);
        }

        if (this.gauges.size > 0) {
            console.log('--- Health & State (legacy gauges) ---');
            const gaugeData: any[] = [];
            this.gauges.forEach((val, label) => {
                gaugeData.push({
                    Metric: label,
                    Value: val.toFixed(2),
                });
            });
            console.table(gaugeData);
        }

        this.reset();
    }
}

export const globalProfiler = new Profiler();
