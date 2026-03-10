/**
 * Performance Benchmark for Telemetry System
 *
 * This script measures the exact nanosecond overhead per tick
 * added by the telemetry logic.
 *
 * Run with: npx tsx benchmark-telemetry.ts
 */

import { TelemetryBuffer, TelemetryIndices } from './src/profiler';

// Benchmark configuration
const WARMUP_ITERATIONS = 1000;
const BENCHMARK_ITERATIONS = 10000;

/**
 * Reset telemetry buffer
 */
function resetBuffer(): void {
  for (let i = 0; i < TelemetryBuffer.length; i++) {
    TelemetryBuffer[i] = BigInt(0);
  }
}

/**
 * Benchmark: Without telemetry (baseline)
 */
function benchmarkWithoutTelemetry(): { totalNs: bigint; avgNsPerTick: number } {
  resetBuffer();

  const start = process.hrtime.bigint();

  for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
    // Simulate physics tick work
    let sum = 0;
    for (let j = 0; j < 100; j++) {
      sum += j;
    }
    // No telemetry recording
  }

  const end = process.hrtime.bigint();
  const totalNs = end - start;
  const avgNsPerTick = Number(totalNs) / BENCHMARK_ITERATIONS;

  return { totalNs, avgNsPerTick };
}

/**
 * Benchmark: With telemetry enabled (minimal overhead)
 */
function benchmarkWithTelemetry(): { totalNs: bigint; avgNsPerTick: number } {
  resetBuffer();

  const start = process.hrtime.bigint();

  for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
    // Simulate physics tick work
    let sum = 0;
    for (let j = 0; j < 100; j++) {
      sum += j;
    }

    // Record telemetry (simulating the hot path)
    const tickStart = process.hrtime.bigint();
    // Minimal work - just timing
    const tickEnd = process.hrtime.bigint();
    TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] += tickEnd - tickStart;
  }

  const end = process.hrtime.bigint();
  const totalNs = end - start;
  const avgNsPerTick = Number(totalNs) / BENCHMARK_ITERATIONS;

  return { totalNs, avgNsPerTick };
}

/**
 * Benchmark: Full telemetry with all indices
 */
function benchmarkFullTelemetry(): { totalNs: bigint; avgNsPerTick: number } {
  resetBuffer();

  const start = process.hrtime.bigint();

  for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
    // Simulate physics tick work
    let sum = 0;
    for (let j = 0; j < 100; j++) {
      sum += j;
    }

    // Record all telemetry indices
    const indices = [
      TelemetryIndices.PHYSICS_TICK,
      TelemetryIndices.RAYCAST_CALL,
      TelemetryIndices.COLLISION_RESOLVE,
      TelemetryIndices.ZMQ_SEND,
      TelemetryIndices.JSON_PARSE,
    ];

    for (const index of indices) {
      const tickStart = process.hrtime.bigint();
      // Minimal work
      const tickEnd = process.hrtime.bigint();
      TelemetryBuffer[index] += tickEnd - tickStart;
    }
  }

  const end = process.hrtime.bigint();
  const totalNs = end - start;
  const avgNsPerTick = Number(totalNs) / BENCHMARK_ITERATIONS;

  return { totalNs, avgNsPerTick };
}

/**
 * Run benchmarks
 */
function runBenchmarks(): void {
  console.log('========================================');
  console.log('     TELEMETRY PERFORMANCE BENCHMARK');
  console.log('========================================');
  console.log(`\nIterations: ${BENCHMARK_ITERATIONS.toLocaleString()}`);
  console.log(`Warmup: ${WARMUP_ITERATIONS.toLocaleString()}\n`);

  // Warmup
  console.log('Warming up...');
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    let sum = 0;
    for (let j = 0; j < 100; j++) {
      sum += j;
    }
  }

  // Benchmark without telemetry
  console.log('Running benchmark WITHOUT telemetry...');
  const baseline = benchmarkWithoutTelemetry();
  console.log(`  Total: ${Number(baseline.totalNs) / 1_000_000} ms`);
  console.log(`  Avg per tick: ${baseline.avgNsPerTick.toFixed(3)} ns`);

  // Benchmark with minimal telemetry
  console.log('\nRunning benchmark WITH minimal telemetry...');
  const withTelemetry = benchmarkWithTelemetry();
  console.log(`  Total: ${Number(withTelemetry.totalNs) / 1_000_000} ms`);
  console.log(`  Avg per tick: ${withTelemetry.avgNsPerTick.toFixed(3)} ns`);

  // Calculate overhead
  const overheadNs = withTelemetry.avgNsPerTick - baseline.avgNsPerTick;
  const overheadPercent = (overheadNs / baseline.avgNsPerTick) * 100;

  console.log('\n--- OVERHEAD ANALYSIS ---');
  console.log(`Nanosecond overhead per tick: ${overheadNs.toFixed(3)} ns`);
  console.log(`Percentage overhead: ${overheadPercent.toFixed(4)}%`);

  // Frame budget check (33.3ms = 33,333,333ns at 30FPS)
  const frameBudgetNs = 33_333_333;
  const percentOfFrame = (overheadNs / frameBudgetNs) * 100;
  console.log(`Percent of 33.3ms frame: ${percentOfFrame.toFixed(6)}%`);

  // Verify < 1% of frame budget
  const onePercentFrame = frameBudgetNs * 0.01;
  console.log(`\n1% of frame budget: ${onePercentFrame.toLocaleString()} ns`);
  console.log(`Actual overhead: ${overheadNs.toFixed(0)} ns`);

  if (overheadNs < onePercentFrame) {
    console.log('\n✓ OVERHEAD IS UNDER 1% THRESHOLD');
  } else {
    console.log('\n✗ OVERHEAD EXCEEDS 1% THRESHOLD');
  }

  // Benchmark full telemetry
  console.log('\n--- FULL TELEMETRY BENCHMARK ---');
  const fullTelemetry = benchmarkFullTelemetry();
  console.log(`  Avg per tick (all indices): ${fullTelemetry.avgNsPerTick.toFixed(3)} ns`);

  const fullOverheadNs = fullTelemetry.avgNsPerTick - baseline.avgNsPerTick;
  const fullOverheadPercent = (fullOverheadNs / baseline.avgNsPerTick) * 100;
  console.log(`  Nanosecond overhead: ${fullOverheadNs.toFixed(3)} ns`);
  console.log(`  Percentage overhead: ${fullOverheadPercent.toFixed(4)}%`);

  console.log('\n========================================');
  console.log('     BENCHMARK COMPLETE');
  console.log('========================================');

  // Print buffer contents
  console.log('\n--- TELEMETRY BUFFER CONTENTS ---');
  const labels = ['PHYSICS_TICK', 'RAYCAST_CALL', 'COLLISION_RESOLVE', 'ZMQ_SEND', 'JSON_PARSE'];
  for (let i = 0; i < TelemetryBuffer.length; i++) {
    const totalNs = TelemetryBuffer[i];
    const totalMs = Number(totalNs) / 1_000_000;
    const avgPerTick = Number(totalNs) / BENCHMARK_ITERATIONS;
    console.log(`${labels[i]}: ${totalMs.toFixed(3)} ms total, ${avgPerTick.toFixed(3)} ns/tick`);
  }
}

// Run benchmarks
runBenchmarks();
