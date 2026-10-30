/** Deadline-driven stability for actual raw-native resident environments. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WorkerPool } from '../src/core/worker-pool';
import {
  makeNativeConfig,
  MemoryMonitor,
  parseOptions,
  runMetadata,
  writeReceiptNoOverwrite,
  createNativeStepperForBenchmark,
  DEFAULT_OPTIONS,
  nativeBenchmarkMatrix,
  type BenchmarkOptions,
  assertDurationSegmentReconciliation,
  type BenchmarkSegment,
  type StepCounters,
  type Transport,
} from './native-benchmark-lib';
import path from 'node:path';

/** Descriptive segment dispersion plus a regression against elapsed seconds. */
export function segmentStatistics(segments: readonly BenchmarkSegment[], rate: 'agent' | 'ticks') {
  if (segments.length === 0) return { count: 0 };
  const key = rate === 'agent' ? 'agentApiStepsPerSecond' : 'nativeSessionTicksPerSecond';
  const values = segments.map((segment) => segment.metrics[key]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const elapsedMs: number[] = [];
  let totalMs = 0;
  for (const segment of segments) {
    if (!(segment.durationMs > 0) || !Number.isFinite(segment.durationMs)) {
      throw new Error('Statistics require finite positive segment durations');
    }
    totalMs += segment.durationMs;
    elapsedMs.push(totalMs);
  }
  const midpoints = segments.map((segment, index) => (elapsedMs[index]! - segment.durationMs / 2) / 1000);
  const totalWeight = totalMs / 1000;
  const weightedMean = (entries: number[]) =>
    entries.reduce((sum, value, index) => sum + value * (segments[index]!.durationMs / 1000), 0) / totalWeight;
  const xMean = weightedMean(midpoints);
  const yMean = weightedMean(values);
  const denominator = midpoints.reduce(
    (sum, value, index) => sum + (segments[index]!.durationMs / 1000) * (value - xMean) ** 2,
    0,
  );
  const slopePerSecond =
    denominator === 0
      ? 0
      : midpoints.reduce(
          (sum, value, index) =>
            sum + (segments[index]!.durationMs / 1000) * (value - xMean) * (values[index]! - yMean),
          0,
        ) / denominator;
  return {
    count: values.length,
    meanUnweightedSegmentRate: mean,
    min: Math.min(...values),
    max: Math.max(...values),
    coefficientOfVariationPercent: mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100,
    durationWeightedLeastSquaresSlopePerSecond: slopePerSecond,
    durationWeightedSlopeToMeanRatioPerSecond: yMean === 0 ? 0 : slopePerSecond / yMean,
    trendWeighting: 'segment-duration-seconds-at-segment-midpoints',
  };
}

export function aggregateRates(counters: StepCounters) {
  if (!(counters.measuredMs! > 0)) throw new Error('Aggregate rates require a positive measured duration');
  const seconds = counters.measuredMs! / 1000;
  return {
    batchCallsPerSecond: counters.batchCalls / seconds,
    agentApiStepsPerSecond: counters.agentApiSteps / seconds,
    nativeSessionTicksPerSecond: counters.nativeSessionTicks / seconds,
    autoResetsPerSecond: counters.autoResets / seconds,
    aggregation: 'total-counters-over-total-measured-time',
  };
}

export async function runStabilityCase(
  transport: Transport,
  n: number,
  frameSkip: number,
  repeat: number,
  options: BenchmarkOptions,
) {
  // Construct a case through the same real resident backend used by throughput.
  const started = process.hrtime.bigint();
  const memory = new MemoryMonitor(started);
  memory.sample('preInit');
  memory.start(options.sampleMs);
  const stepper = createNativeStepperForBenchmark(n, makeNativeConfig(options, frameSkip), options, transport);
  const segments: BenchmarkSegment[] = [];
  let durations: Record<string, number> = {};
  try {
    let mark = performance.now();
    const initialization = await stepper.initialize();
    Object.assign(durations, initialization);
    memory.sample('postInit');
    mark = performance.now();
    await stepper.runForDuration(options.warmupSeconds, options.warmupSeconds, () => {}, false);
    durations.warmupMs = performance.now() - mark;
    memory.sample('postWarmup');
    mark = performance.now();
    const counters = await stepper.runForDuration(options.durationSeconds, options.segmentSeconds, (segment) => {
      segments.push({ ...segment, memory: memory.sample(`segment-${segments.length}`) });
    });
    // Sustained evidence requires aggregate liveness on every real lane. The
    // generic measurement helper still permits deterministic hold-only short
    // windows; that exception is not a stability pass.
    const laneTicks = counters.perLaneNativeSessionTicks ?? [];
    if (laneTicks.length !== n || laneTicks.some((ticks) => !(ticks > 0))) {
      throw new Error(`Stability window lacks native progress on every resident: ${JSON.stringify(laneTicks)}`);
    }
    assertDurationSegmentReconciliation(counters, segments, n);
    durations.measuredSteppingMs = counters.measuredMs!;
    mark = performance.now();
    const explicitResidentResets = await stepper.resetCycles(options.resetCycles);
    durations.explicitResetMs = performance.now() - mark;
    memory.sample('postResetCycles');
    return {
      caseId: `stability-${transport}-n${n}-fs${frameSkip}-repeat${repeat}`,
      status: 'PASS',
      transport,
      requestedTransport: transport,
      ownership: transport === 'message' ? 'owned' : options.ownership,
      residents: n,
      requestedWorkers: transport === 'direct' ? 0 : options.workers[0],
      frameSkip,
      repeat,
      ...stepper.diagnostics(),
      workload: {
        kind: 'duration',
        requestedWarmupSeconds: options.warmupSeconds,
        requestedMeasuredSeconds: options.durationSeconds,
        requestedSegmentSeconds: options.segmentSeconds,
        measuredMs: counters.measuredMs,
        measuredSeconds: counters.measuredMs! / 1000,
        segmentCount: segments.length,
      },
      durationsMs: durations,
      counters: {
        ...counters,
        explicitResidentResets,
        postWindowClassificationProbe: true,
        trailingResetAttributionAssignedToFinalSegment: true,
      },
      segments,
      statistics: {
        aggregateRates: aggregateRates(counters),
        agentApiStepsPerSecond: segmentStatistics(segments, 'agent'),
        nativeSessionTicksPerSecond: segmentStatistics(segments, 'ticks'),
        trendDefinition:
          'Duration-weighted ordinary least squares of segment rate against segment midpoint in elapsed seconds. Aggregate rates separately use total counters / total measured time.',
      },
      memory: memory.summary(n),
      memorySamples: memory.samples,
      interpretation:
        'Descriptive samples only. No memory-leak verdict from one final RSS sample; trailing reset attribution may be assigned to the final segment.',
    };
  } finally {
    const mark = performance.now();
    await stepper.close();
    durations.closeMs = performance.now() - mark;
    memory.sample('postClose');
    memory.stop();
  }
}

export async function runStabilityMain(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  const matrix = nativeBenchmarkMatrix(options);
  console.log(JSON.stringify({ nativeStabilityMatrix: matrix }, null, 2));
  const receipt: Record<string, unknown> = {
    ...runMetadata(options, randomUUID(), 'native-stability'),
    matrix,
    cases: [],
    status: 'PASS',
  };
  const cases = receipt.cases as unknown[];
  for (const entry of matrix) {
    try {
      if (entry.transport === 'shared' && !WorkerPool.isSupported()) {
        cases.push({ ...entry, status: 'SKIP', reason: 'SharedArrayBuffer unsupported; no fallback' });
        receipt.status = 'PASS_WITH_SKIPS';
        continue;
      }
      const result = await runStabilityCase(entry.transport, entry.n, entry.frameSkip, entry.repeat, {
        ...options,
        workers: [entry.workers],
      });
      cases.push(result);
      console.log(JSON.stringify({ case: result.caseId, status: result.status, statistics: result.statistics }));
    } catch (error) {
      receipt.status = 'FAIL';
      cases.push({
        ...entry,
        status: 'FAIL',
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      });
      console.error(error);
    }
  }
  const file = writeReceiptNoOverwrite(options.outDir, 'native-stability', receipt);
  console.log(`Native stability receipt: ${file}`);
  if (receipt.status === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runStabilityMain().catch((error) => {
    console.error(error);
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf('--out-dir');
    const outDir =
      outputIndex >= 0 && args[outputIndex + 1] ? path.resolve(args[outputIndex + 1]!) : DEFAULT_OPTIONS.outDir;
    let options: BenchmarkOptions | undefined;
    try {
      options = parseOptions(args);
    } catch {
      /* Preserve the original parse/validation error. */
    }
    try {
      const file = writeReceiptNoOverwrite(outDir, 'native-stability-driver-failure', {
        ...runMetadata(options ?? { ...DEFAULT_OPTIONS, outDir }, randomUUID(), 'native-stability-driver-failure'),
        status: 'FAIL',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack, cause: (error as Error & { cause?: unknown }).cause }
            : String(error),
      });
      console.error(`Native stability failure receipt: ${file}`);
    } catch (receiptError) {
      console.error('Failed to persist stability failure receipt', receiptError);
    }
    process.exitCode = 1;
  });
}
