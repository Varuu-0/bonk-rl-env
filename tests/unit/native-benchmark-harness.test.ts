import { describe, expect, it } from 'vitest';
import {
  createNativeStepperForBenchmark,
  DEFAULT_OPTIONS,
  makeNativeConfig,
  parseOptions,
  nativeBenchmarkMatrix,
  assertDurationSegmentReconciliation,
  runThroughputCase,
  type BenchmarkSegment,
  type StepCounters,
} from '../../benchmarks/native-benchmark-lib';
import { aggregateRates, runStabilityCase, segmentStatistics } from '../../benchmarks/native-stability';
import { readFileSync } from 'node:fs';
import { BonkEnvironment } from '../../src/core/environment';

const options = (overrides = {}) => ({
  ...DEFAULT_OPTIONS,
  workers: [1],
  warmupSteps: 1,
  steps: 2,
  resetCycles: 1,
  sampleMs: 1000,
  maxTicks: 4,
  seed: 11,
  ...overrides,
});

describe('native benchmark observer correctness', () => {
  it('counts actual matrix cases without discarded direct workers', () => {
    const parsed = parseOptions([
      '--envs',
      '1,2',
      '--workers',
      '1,2',
      '--transports',
      'direct,message',
      '--frame-skips',
      '1,3',
      '--repeats',
      '2',
    ]);
    expect(nativeBenchmarkMatrix({ ...parsed, repeats: 2 })).toHaveLength(24);
    expect(parsed.repeats).toBe(2);
    expect(() =>
      parseOptions([
        '--envs',
        '1,2',
        '--workers',
        '1,2,3,4',
        '--transports',
        'direct,message',
        '--frame-skips',
        '1,3',
        '--repeats',
        '3',
      ]),
    ).toThrow(/60 cases/);
  });

  it.each(['direct', 'message', 'shared'] as const)(
    '%s accepts hold-only batches and synchronizes trailing probes',
    async (transport) => {
      const config = makeNativeConfig(options({ maxTicks: 4 }), 3);
      const stepper = createNativeStepperForBenchmark(2, config, options({ maxTicks: 4 }), transport);
      try {
        await stepper.initialize();
        await stepper.warmup(1);
        const measured = await stepper.runForDuration(0.025, 0.025, () => {});
        expect(measured.batchCalls).toBeGreaterThan(0);
        expect(measured.agentApiSteps).toBe(measured.batchCalls * 2);
        expect(measured.nativeSessionTicks).toBe(measured.agentApiSteps - measured.terminalHoldSteps);
        expect(measured.perLaneNativeSessionTicks!.reduce((a, b) => a + b, 0)).toBe(measured.nativeSessionTicks);
        expect(measured.perLaneObservedRestarts!.reduce((a, b) => a + b, 0)).toBe(measured.autoResets);
        expect(measured.measuredMs).toBeGreaterThan(0);
        // Reuse without reset exercises every lane's post-probe history without
        // depending on how many calls happened to fit in the timed window.
        const next = await stepper.measure(2);
        expect(next.batchCalls).toBe(2);
        expect(next.agentApiSteps).toBe(4);
        expect(next.nativeSessionTicks).toBe(4 - next.terminalHoldSteps);
        expect(next.perLaneNativeSessionTicks!.reduce((a, b) => a + b, 0)).toBe(next.nativeSessionTicks);
        expect(next.perLaneObservedRestarts!.reduce((a, b) => a + b, 0)).toBe(next.autoResets);
        expect(next.perLaneNativeSessionTicks!.every((ticks) => ticks >= 0 && ticks <= 2)).toBe(true);
        await stepper.stabilize();
      } finally {
        await stepper.close();
      }
    },
    20000,
  );

  it.each(['direct', 'message', 'shared'] as const)(
    '%s synchronizes every lane after a hold-only trailing probe',
    async (transport) => {
      const holdOptions = options({ maxTicks: 1 });
      const config = { ...makeNativeConfig(holdOptions, 3), countdownTicks: 5 as const };
      const stepper = createNativeStepperForBenchmark(2, config, holdOptions, transport);
      try {
        await stepper.initialize();
        // Native schedule with countdownTicks=5,maxTicks=1,FS3:
        // advance+done, held done, held done/window complete.
        // The one-call warmup is entirely outside physics; its terminal
        // boundary is marked excluded without inserting an advancing probe.
        await stepper.warmup(1);
        const measured = await stepper.measure(2);
        // A valid window may consist entirely of terminal holds. Probe work
        // must not be counted as measured physics.
        expect(measured.batchCalls).toBe(2);
        expect(measured.perLaneNativeSessionTicks).toEqual([0, 0]);
        expect(measured.terminalHoldSteps).toBe(4);
        const next = await stepper.measure(2);
        expect(measured.autoResets).toBe(2);
        expect(next.batchCalls).toBe(2);
        expect(next.perLaneNativeSessionTicks).toEqual([0, 0]);
        expect(next.terminalHoldSteps).toBe(4);
        expect(next.trailingAutoResets).toBe(2);
        expect(next.autoResets).toBe(2);
        await stepper.stabilize();
      } finally {
        await stepper.close();
      }
    },
    20000,
  );

  it.each(['direct', 'message', 'shared'] as const)(
    '%s excludes probe-generated resets and warmup boundaries',
    async (transport) => {
      const boundaryOptions = options({ maxTicks: 4 });
      const config = { ...makeNativeConfig(boundaryOptions, 3), countdownTicks: 5 as const };
      const stepper = createNativeStepperForBenchmark(1, config, boundaryOptions, transport);
      try {
        await stepper.initialize();
        await stepper.warmup(1);
        const first = await stepper.measure(5);
        expect(first.nativeSessionTicks).toBe(3);
        expect(first.terminalHoldSteps).toBe(2);
        expect(first.autoResets).toBe(1);
        expect(first.trailingAutoResets).toBe(1);
        const next = await stepper.measure(1);
        expect(next.nativeSessionTicks).toBe(1);
        // Neither a reset consumed by the excluded probe nor a reset generated
        // by its immediately terminal result may enter the measured counters.
        expect(next.observedRestarts).toBe(0);
        expect(next.autoResets).toBe(0);
        expect(next.perLaneObservedRestarts).toEqual([0]);
        // Repeatedly split the same resident lifecycle at unrelated boundaries.
        // Every reset must belong to exactly one window, never probe work.
        for (const calls of [2, 1, 5, 1, 2, 4]) {
          const window = await stepper.measure(calls);
          expect(window.nativeSessionTicks).toBe(calls - window.terminalHoldSteps);
          expect(window.perLaneNativeSessionTicks).toHaveLength(1);
          expect(window.autoResets).toBe(window.observedRestarts);
          expect(window.perLaneObservedRestarts).toEqual([window.observedRestarts]);
          expect(window.autoResets).toBeGreaterThanOrEqual(window.trailingAutoResets ?? 0);
        }
      } finally {
        await stepper.close();
      }

      const immediateOptions = options({ maxTicks: 1 });
      const immediate = createNativeStepperForBenchmark(
        1,
        { ...makeNativeConfig(immediateOptions, 1), countdownTicks: 5 as const },
        immediateOptions,
        transport,
      );
      try {
        await immediate.initialize();
        await immediate.warmup(1);
        const first = await immediate.measure(1);
        expect(first.autoResets).toBe(1);
        expect(first.trailingAutoResets).toBe(1);
      } finally {
        await immediate.close();
      }
    },
    20000,
  );

  it('rejects zero-call windows before issuing a public batch', async () => {
    const stepper = createNativeStepperForBenchmark(1, makeNativeConfig(options(), 1), options(), 'direct');
    try {
      await stepper.initialize();
      await expect(stepper.warmup(0)).rejects.toThrow('Warmup calls must be a positive integer');
      await expect(stepper.measure(0)).rejects.toThrow('Measured calls must be a positive integer');
      const result = await stepper.measure(1);
      expect(result.batchCalls).toBe(1);
      expect(result.nativeSessionTicks).toBe(1);
    } finally {
      await stepper.close();
    }
  });

  it('aggregates total counters over measured time and keeps trends independent of segment duration', () => {
    const counters: StepCounters = {
      batchCalls: 12,
      agentApiSteps: 24,
      nativeSessionTicks: 23,
      terminalHoldSteps: 1,
      observedRestarts: 2,
      autoResets: 2,
      measuredMs: 3000,
      trailingAutoResets: 1,
      perLaneNativeSessionTicks: [11, 12],
      perLaneObservedRestarts: [1, 1],
      autoResetsPerLane: [1, 1],
    };
    const makeSegment = (
      durationMs: number,
      batchCalls: number,
      agentApiSteps: number,
      nativeSessionTicks: number,
      terminalHoldSteps: number,
      autoResets: number,
      perLaneNativeSessionTicks: number[],
      perLaneObservedRestarts: number[],
    ): BenchmarkSegment => {
      const segmentCounters = {
        batchCalls,
        agentApiSteps,
        nativeSessionTicks,
        terminalHoldSteps,
        observedRestarts: autoResets,
        autoResets,
        perLaneNativeSessionTicks,
        perLaneObservedRestarts,
      };
      return {
        durationMs,
        counters: segmentCounters,
        metrics: {
          batchCallsPerSecond: batchCalls / (durationMs / 1000),
          agentApiStepsPerSecond: agentApiSteps / (durationMs / 1000),
          nativeSessionTicksPerSecond: nativeSessionTicks / (durationMs / 1000),
          autoResetsPerSecond: autoResets / (durationMs / 1000),
          trailingResetClassificationPending: false,
        },
      };
    };
    const segments = [
      makeSegment(1000, 4, 8, 8, 0, 0, [4, 4], [0, 0]),
      makeSegment(1000, 4, 8, 8, 0, 1, [4, 4], [1, 0]),
      makeSegment(1000, 4, 8, 7, 1, 1, [3, 4], [0, 1]),
    ];
    assertDurationSegmentReconciliation(counters, segments, 2);
    expect(aggregateRates(counters).agentApiStepsPerSecond).toBe(8);
    expect(aggregateRates(counters).nativeSessionTicksPerSecond).toBeCloseTo(23 / 3);
    expect(segmentStatistics(segments, 'agent').durationWeightedLeastSquaresSlopePerSecond).toBeCloseTo(0);
    const splitFinal = [
      segments[0]!,
      segments[1]!,
      makeSegment(500, 2, 4, 4, 0, 1, [2, 2], [0, 1]),
      makeSegment(500, 2, 4, 3, 1, 0, [1, 2], [0, 0]),
    ];
    // Splitting a segment with identical rate preserves this duration-weighted
    // regression; aggregate totals remain exact as well.
    expect(segmentStatistics(splitFinal, 'agent').durationWeightedLeastSquaresSlopePerSecond).toBeCloseTo(0);
    assertDurationSegmentReconciliation(counters, splitFinal, 2);
    const badResets = segments.map((segment, index) =>
      index === 2 ? { ...segment, counters: { ...segment.counters, perLaneObservedRestarts: [0, 0] } } : segment,
    );
    expect(() => assertDurationSegmentReconciliation(counters, badResets, 2)).toThrow('segment reset mismatch');
  });

  it('dispatches sustained throughput by duration and records reconciled segments', async () => {
    const result = await runThroughputCase(
      'direct',
      1,
      1,
      0,
      options({
        sustained: true,
        warmupSteps: 1,
        steps: 1,
        warmupSeconds: 1,
        durationSeconds: 1,
        segmentSeconds: 1,
      }),
    );
    expect(result.workload).toMatchObject({ kind: 'duration', requestedWarmupSeconds: 1, requestedMeasuredSeconds: 1 });
    expect(result.counters.batchCalls).toBeGreaterThan(1);
    expect(result.counters.measuredMs).toBeGreaterThanOrEqual(900);
    expect(result.metrics.agentApiStepsPerSecond).toBe(
      result.counters.agentApiSteps / (result.counters.measuredMs! / 1000),
    );
    assertDurationSegmentReconciliation(result.counters, result.segments!, 1);
  }, 15000);

  it('can import the stability case without starting its CLI and preserves measured timing', async () => {
    const result = await runStabilityCase(
      'direct',
      1,
      3,
      0,
      options({ maxTicks: 4, warmupSeconds: 1, durationSeconds: 1, segmentSeconds: 1 }),
    );
    expect(result.status).toBe('PASS');
    expect(result.durationsMs.measuredSteppingMs).toBe(result.counters.measuredMs);
    expect(result.segments.at(-1)!.durationMs).toBeLessThanOrEqual(result.counters.measuredMs!);
  }, 15000);
});
