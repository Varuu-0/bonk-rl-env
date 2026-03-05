/**
 * High-precision telemetry profiler for the vectorized bonk environment.
 * Uses process.hrtime.bigint() for nanosecond precision with zero overhead.
 */

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
     * Start timing a block of code.
     */
    start(label: string) {
        this.activeTimers.set(label, process.hrtime.bigint());
    }

    /**
     * Stop timing a block and record the duration.
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
    }

    /**
     * Output a structured table of metrics.
     * @param windowSize Number of ticks in this reporting window.
     */
    report(windowSize: number = 5000) {
        if (this.currentTick - this.startTick < windowSize) return;

        console.log(`\n=== Telemetry Report (Avg over last ${windowSize} ticks) ===`);

        // Performance Timing
        const perfData: any[] = [];
        this.timeMetrics.forEach((metric, label) => {
            const avgMs = Number(metric.totalNs) / metric.count / 1_000_000;
            perfData.push({
                'Metric': label,
                'Avg Time (ms)': avgMs.toFixed(4),
                'Total Calls': metric.count
            });
        });
        if (perfData.length > 0) {
            console.log('--- Performance ---');
            console.table(perfData);
        }

        // Throughput Counters
        const countData: any[] = [];
        this.counters.forEach((val, label) => {
            countData.push({
                'Metric': label,
                'Total': val,
                'Avg/Tick': (val / windowSize).toFixed(4)
            });
        });
        if (countData.length > 0) {
            console.log('--- Throughput ---');
            console.table(countData);
        }

        // Health Gauges
        const gaugeData: any[] = [];
        this.gauges.forEach((val, label) => {
            gaugeData.push({
                'Metric': label,
                'Value': val.toFixed(2)
            });
        });
        if (gaugeData.length > 0) {
            console.log('--- Health & State ---');
            console.table(gaugeData);
        }

        this.reset();
    }
}

export const globalProfiler = new Profiler();
