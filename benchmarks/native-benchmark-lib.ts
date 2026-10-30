/** Measurement helpers for REAL raw-native environments, never mocked residents. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BonkEnvironment, type EnvironmentConfig, type StepResult } from '../src/core/environment';
import { WorkerPool } from '../src/core/worker-pool';

export const NATIVE_MAP_PATH = path.resolve(process.cwd(), 'maps', 'training-platform.json');
export type Transport = 'direct' | 'message' | 'shared';
export type Ownership = 'owned' | 'borrowed';

export interface BenchmarkOptions {
  envs: number[];
  workers: number[];
  transports: Transport[];
  frameSkips: number[];
  warmupSteps: number;
  steps: number;
  resetCycles: number;
  repeats: number;
  seed: number;
  maxTicks: number;
  ownership: Ownership;
  sampleMs: number;
  warmupSeconds: number;
  durationSeconds: number;
  segmentSeconds: number;
  sustained: boolean;
  diagnostics: boolean;
  outDir: string;
}

export const DEFAULT_OPTIONS: BenchmarkOptions = {
  envs: [1],
  workers: [1],
  transports: ['direct'],
  frameSkips: [1],
  warmupSteps: 128,
  steps: 512,
  resetCycles: 2,
  repeats: 1,
  seed: 11,
  maxTicks: 197,
  ownership: 'owned',
  sampleMs: 100,
  warmupSeconds: 2,
  durationSeconds: 10,
  segmentSeconds: 2,
  sustained: false,
  diagnostics: false,
  outDir: path.resolve(process.cwd(), 'benchmarks', 'results'),
};

export function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive safe integer; received ${JSON.stringify(value)}`);
  }
  return Number(value);
}

function integerList(value: string, name: string): number[] {
  const result = value.split(',').map((entry) => positiveInteger(entry, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicates`);
  return result;
}

export interface BenchmarkMatrixEntry {
  transport: Transport;
  n: number;
  frameSkip: number;
  workers: number;
  repeat: number;
}
export function nativeBenchmarkMatrix(options: BenchmarkOptions): BenchmarkMatrixEntry[] {
  return options.transports.flatMap((transport) =>
    options.envs.flatMap((n) =>
      options.frameSkips.flatMap((frameSkip) =>
        options.workers
          .filter((workers) => transport !== 'direct' || workers === options.workers[0])
          .flatMap((workers) =>
            Array.from({ length: options.repeats }, (_, repeat) => ({ transport, n, frameSkip, workers, repeat })),
          ),
      ),
    ),
  );
}

export function parseOptions(args: string[]): BenchmarkOptions {
  const result: BenchmarkOptions = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sustained') {
      result.sustained = true;
      continue;
    }
    if (arg === '--diagnostics') {
      result.diagnostics = true;
      continue;
    }
    if (!arg?.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    switch (key) {
      case 'envs':
        result.envs = integerList(value, arg);
        break;
      case 'workers':
        result.workers = integerList(value, arg);
        break;
      case 'frame-skips':
        result.frameSkips = integerList(value, arg);
        break;
      case 'warmup-steps':
        result.warmupSteps = positiveInteger(value, arg);
        break;
      case 'steps':
        result.steps = positiveInteger(value, arg);
        break;
      case 'reset-cycles':
        result.resetCycles = positiveInteger(value, arg);
        break;
      case 'repeats':
        result.repeats = positiveInteger(value, arg);
        break;
      case 'seed':
        result.seed = positiveInteger(value, arg);
        break;
      case 'max-ticks':
        result.maxTicks = positiveInteger(value, arg);
        break;
      case 'sample-ms':
        result.sampleMs = positiveInteger(value, arg);
        break;
      case 'warmup-seconds':
        result.warmupSeconds = positiveInteger(value, arg);
        break;
      case 'duration-seconds':
        result.durationSeconds = positiveInteger(value, arg);
        break;
      case 'segment-seconds':
        result.segmentSeconds = positiveInteger(value, arg);
        break;
      case 'out-dir':
        result.outDir = path.resolve(value);
        break;
      case 'ownership':
        if (value !== 'owned' && value !== 'borrowed') throw new Error('--ownership must be owned or borrowed');
        result.ownership = value;
        break;
      case 'transports':
        result.transports = value.split(',') as Transport[];
        if (
          new Set(result.transports).size !== result.transports.length ||
          result.transports.some((t) => !['direct', 'message', 'shared'].includes(t))
        ) {
          throw new Error('--transports accepts a unique comma-separated subset of direct,message,shared');
        }
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  if (result.frameSkips.some((n) => n !== 1 && n !== 3))
    throw new Error('Native benchmark supports frame-skips 1,3 only');
  if (result.ownership === 'borrowed' && result.transports.some((t) => t !== 'shared')) {
    throw new Error('borrowed ownership is a separate shared-transport-only case');
  }
  if (result.envs.some((n) => n > 2048)) throw new Error('Resident environment count exceeds the supported 2,048 cap');
  if (result.sustained && result.repeats < 3) throw new Error('Sustained throughput requires --repeats 3 or greater');
  const expanded = nativeBenchmarkMatrix(result).length;
  if (result.durationSeconds < result.segmentSeconds)
    throw new Error('--duration-seconds must be >= --segment-seconds');
  if (result.sustained && result.durationSeconds < 60)
    throw new Error('Sustained stability requires at least 60 measured seconds per case');
  const limit = result.sustained ? 64 : 32;
  if (expanded > limit)
    throw new Error(`Expanded matrix has ${expanded} cases; limit is ${limit}. Select cases explicitly`);
  if (result.sustained && result.steps * result.repeats > 1_000_000)
    throw new Error('Sustained step budget exceeds 1,000,000 per selected size');
  return result;
}

export function makeNativeConfig(options: BenchmarkOptions, frameSkip: number): EnvironmentConfig {
  return {
    mapPath: NATIVE_MAP_PATH,
    numOpponents: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: options.maxTicks,
    frameSkip,
    seed: options.seed,
    verboseTelemetry: false,
  } as EnvironmentConfig;
}

/** Fixed native Classic action bits; grapple (32) is deliberately excluded. */
export function actionAt(lane: number, call: number): number {
  const streams = [[0], [2], [0, 2, 2, 2, 16], [1], [4], [0, 8, 2, 16]];
  const stream = streams[lane % streams.length]!;
  return stream[call % stream.length]!;
}

export interface MemorySample {
  stage: string;
  elapsedMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
}
export function memorySample(stage: string, started: bigint): MemorySample {
  const memory = process.memoryUsage();
  return {
    stage,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers,
  };
}

export class MemoryMonitor {
  readonly samples: MemorySample[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly started = process.hrtime.bigint()) {}
  sample(stage: string): MemorySample {
    const sample = memorySample(stage, this.started);
    this.samples.push(sample);
    return sample;
  }
  start(sampleMs: number): void {
    this.timer = setInterval(() => this.sample('interval'), sampleMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  summary(residents: number): Record<string, number | string> {
    const baseline = this.samples.find((s) => s.stage === 'preInit');
    const post = this.samples.filter((s) => s.stage === 'postInit').at(-1);
    const warmup = this.samples.filter((s) => s.stage === 'postWarmup').at(-1);
    const resets = this.samples.filter((s) => s.stage === 'postResetCycles').at(-1);
    const peak = Math.max(0, ...this.samples.map((s) => s.rssBytes));
    const base = baseline?.rssBytes ?? 0;
    return {
      scope:
        'Main-process RSS by lifecycle phase; worker-isolate heap is not aggregated; interval samples are observed, not absolute peaks or retained-memory/leak proof',
      baselineRssBytes: base,
      postInitRssBytes: post?.rssBytes ?? 0,
      constructionObservedDeltaBytes: (post?.rssBytes ?? 0) - base,
      constructionObservedDeltaBytesPerResident: ((post?.rssBytes ?? 0) - base) / residents,
      postWarmupRssBytes: warmup?.rssBytes ?? 0,
      postWarmupObservedDeltaBytes: (warmup?.rssBytes ?? 0) - base,
      postResetCyclesRssBytes: resets?.rssBytes ?? 0,
      postResetCyclesObservedDeltaBytes: (resets?.rssBytes ?? 0) - base,
      observedLifecyclePeakRssBytes: peak,
      observedLifecyclePeakDeltaBytes: Math.max(0, peak - base),
    };
  }
}

interface LaneState {
  previousDone: boolean;
  previousTick: number;
  previousAutoResetAfter: boolean;
  probeClassifiedReset: boolean;
  excludedResetPending: boolean;
  ticks: number;
  holds: number;
  restarts: number;
  finalDone: boolean;
}
export interface StepCounters {
  batchCalls: number;
  agentApiSteps: number;
  nativeSessionTicks: number;
  terminalHoldSteps: number;
  observedRestarts: number;
  autoResets: number;
  measuredMs?: number;
  trailingAutoResets?: number;
  autoResetsPerLane?: number[];
  perLaneNativeSessionTicks?: number[];
  perLaneObservedRestarts?: number[];
}
export interface BenchmarkSegment {
  durationMs: number;
  counters: StepCounters;
  metrics: {
    batchCallsPerSecond: number;
    agentApiStepsPerSecond: number;
    nativeSessionTicksPerSecond: number;
    autoResetsPerSecond: number;
    trailingResetClassificationPending: boolean;
  };
  memory?: MemorySample;
}
export interface NativeStepper {
  residents: number;
  initialize(): Promise<{ constructionMs: number; resetMs: number }>;
  warmup(calls: number): Promise<void>;
  measure(calls: number): Promise<StepCounters>;
  stabilize(): Promise<void>;
  resetCycles(cycles: number): Promise<number>;
  diagnostics(): Record<string, unknown>;
  runForDuration(
    seconds: number,
    segmentSeconds: number,
    onSegment: (segment: BenchmarkSegment) => void,
    classifyTrailingResets?: boolean,
  ): Promise<StepCounters>;
  close(): Promise<void>;
}

/** Reconcile every measured duration segment, including its partial tail. */
export function assertDurationSegmentReconciliation(
  counters: StepCounters,
  segments: readonly BenchmarkSegment[],
  residents: number,
): void {
  if (!(counters.measuredMs! > 0) || !Number.isFinite(counters.measuredMs)) {
    throw new Error('Missing finite internal measured duration');
  }
  if (segments.length === 0) throw new Error('Duration run produced no measured segment');
  const scalarKeys = [
    'batchCalls',
    'agentApiSteps',
    'nativeSessionTicks',
    'terminalHoldSteps',
    'observedRestarts',
    'autoResets',
  ] as const;
  for (const key of scalarKeys) {
    const sum = segments.reduce((total, segment) => total + segment.counters[key], 0);
    if (sum !== counters[key]) throw new Error(`Duration segment sum mismatch for ${key}: ${sum}`);
  }
  const laneTicks = counters.perLaneNativeSessionTicks ?? [];
  const laneResets = counters.perLaneObservedRestarts ?? [];
  if (laneTicks.length !== residents || laneResets.length !== residents) {
    throw new Error('Duration result lacks complete per-lane counters');
  }
  if (
    laneTicks.reduce((sum, ticks) => sum + ticks, 0) !== counters.nativeSessionTicks ||
    counters.nativeSessionTicks !== counters.agentApiSteps - counters.terminalHoldSteps
  ) {
    throw new Error('Duration per-lane/scalar tick counters do not reconcile');
  }
  if (
    laneResets.reduce((sum, resets) => sum + resets, 0) !== counters.autoResets ||
    counters.observedRestarts !== counters.autoResets
  ) {
    throw new Error('Duration per-lane/scalar reset counters do not reconcile');
  }
  if (
    counters.autoResetsPerLane !== undefined &&
    counters.autoResetsPerLane.some((resets, lane) => resets !== laneResets[lane])
  ) {
    throw new Error('Duration per-lane automatic reset aliases do not reconcile');
  }
  for (let lane = 0; lane < residents; lane++) {
    const ticks = segments.reduce((sum, segment) => sum + segment.counters.perLaneNativeSessionTicks![lane]!, 0);
    if (ticks !== laneTicks[lane]) throw new Error(`Duration segment tick mismatch for lane ${lane}`);
    const resets = segments.reduce((sum, segment) => sum + segment.counters.perLaneObservedRestarts![lane]!, 0);
    if (resets !== laneResets[lane]) throw new Error(`Duration segment reset mismatch for lane ${lane}`);
  }
  const measuredSegmentMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  if (Math.abs(measuredSegmentMs - counters.measuredMs!) > 1) {
    throw new Error('Duration segments do not reconcile with measured time');
  }
}

function finiteTree(value: unknown, location: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Non-finite public value at ${location}`);
  if (Array.isArray(value)) value.forEach((entry, index) => finiteTree(entry, `${location}[${index}]`));
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) finiteTree(child, `${location}.${key}`);
}

function validateReset(observations: unknown[], n: number): void {
  if (observations.length !== n) throw new Error(`Reset returned ${observations.length} residents, expected ${n}`);
  observations.forEach((observation, lane) => finiteTree(observation, `reset[${lane}]`));
}

function observerStepper(n: number, config: EnvironmentConfig, options: BenchmarkOptions) {
  let envs: BonkEnvironment[] = [];
  let pool: WorkerPool | undefined;
  let residency: Array<{ threadId: number; numEnvs: number; startId: number }> = [];
  let transport: Transport = 'direct';
  let states: LaneState[] = [];
  const makeStates = () =>
    Array.from({ length: n }, (): LaneState => ({
      previousDone: false,
      previousTick: 0,
      previousAutoResetAfter: false,
      probeClassifiedReset: false,
      excludedResetPending: false,
      ticks: 0,
      holds: 0,
      restarts: 0,
      finalDone: false,
    }));
  let actionCall = 0;
  const nextActionCall = () => actionCall++;
  const assertResult = (result: StepResult, lane: number, state: LaneState, count = true) => {
    finiteTree(result, `lane[${lane}]`);
    if (result.info.native !== true || result.info.nativeMode !== 'b')
      throw new Error(`Lane ${lane} is not raw-native Classic`);
    if (!['countdown', 'active', 'round-result', 'match-result'].includes(result.info.nativePhase))
      throw new Error(`Lane ${lane} invalid native phase`);
    if (!Number.isInteger(result.info.nativeRoundTick) || result.info.nativeRoundTick < 0)
      throw new Error(`Lane ${lane} invalid native round tick`);
    if (result.done && result.info.terminal_observation === undefined)
      throw new Error(`Lane ${lane} terminal result lacks terminal_observation`);
    if (typeof result.info.autoResetAfter !== 'boolean')
      throw new Error(`Lane ${lane} lacks explicit autoResetAfter boundary metadata`);
    const wasDone = state.previousDone;
    const reset = state.previousAutoResetAfter;
    const hold = wasDone && result.done && !reset;
    const baseline = (wasDone && !result.done) || reset ? 0 : state.previousTick;
    const delta = result.info.tick - baseline;
    if (delta !== (hold ? 0 : 1)) throw new Error(`Lane ${lane} session delta ${delta}, expected ${hold ? 0 : 1}`);
    if (reset && count && !state.probeClassifiedReset && !state.excludedResetPending) state.restarts++;
    if (count) state.excludedResetPending = false;
    if (count) {
      state.ticks += delta;
      state.holds += hold ? 1 : 0;
    }
    // A reset observed on probe entry is already classified by that probe. A
    // reset generated by the probe result also belongs entirely to excluded
    // work. Suppress both at the next measured boundary; either may occur on
    // any lane, and both can coincide for an immediately terminal episode.
    state.probeClassifiedReset = !count && (reset || result.info.autoResetAfter);
    state.previousDone = result.done;
    state.previousTick = result.info.tick;
    state.previousAutoResetAfter = result.info.autoResetAfter;
    state.finalDone = result.done;
    return { hold, restarted: reset };
  };
  const stepBatch = async (actions: number[]): Promise<StepResult[]> =>
    transport === 'direct'
      ? envs.map((env, lane) => {
          const result = env.step(actions[lane]!);
          if (result.done && !env.isTerminalHoldActive()) env.reset();
          return result;
        })
      : ((await pool!.step(actions, { ownership: options.ownership })) as StepResult[]);
  // Classification probes advance every pool lane. Validate and synchronize
  // every lane so a following window never observes a stale two-tick delta.
  const classificationProbe = async (pending: readonly number[]) => {
    if (!pending.length) return [];
    const results = await stepBatch(new Array(n).fill(0));
    if (results.length !== n) throw new Error(`Probe returned ${results.length} residents, expected ${n}`);
    return results.map((result, lane) => {
      const observed = assertResult(result, lane, states[lane]!, false);
      return pending.includes(lane) && observed.restarted;
    });
  };
  const run = async (calls: number, startCall: number, onBatch?: () => void): Promise<StepCounters> => {
    const counters: StepCounters = {
      batchCalls: 0,
      agentApiSteps: 0,
      nativeSessionTicks: 0,
      terminalHoldSteps: 0,
      observedRestarts: 0,
      autoResets: 0,
    };
    const beforeTicks = states.map((s) => s.ticks);
    const beforeRestarts = states.map((s) => s.restarts);
    for (let call = 0; call < calls; call++) {
      const actions = Array.from({ length: n }, (_, lane) => actionAt(lane, startCall + call));
      const results = await stepBatch(actions);
      if (results.length !== n) throw new Error(`Step returned ${results.length} residents, expected ${n}`);
      results.forEach((result, lane) => {
        if (assertResult(result, lane, states[lane]!).hold) counters.terminalHoldSteps++;
      });
      counters.batchCalls++;
      counters.agentApiSteps += n;
      onBatch?.();
    }
    counters.nativeSessionTicks = states.reduce((sum, state, lane) => sum + state.ticks - beforeTicks[lane]!, 0);
    counters.observedRestarts = states.reduce((sum, state, lane) => sum + state.restarts - beforeRestarts[lane]!, 0);
    counters.perLaneNativeSessionTicks = states.map((state, lane) => state.ticks - beforeTicks[lane]!);
    counters.perLaneObservedRestarts = states.map((state, lane) => state.restarts - beforeRestarts[lane]!);
    counters.autoResets = counters.observedRestarts;
    if (counters.nativeSessionTicks !== counters.agentApiSteps - counters.terminalHoldSteps)
      throw new Error('Session-tick identity violated');
    return counters;
  };
  return {
    get residents() {
      return n;
    },
    setTransport(value: Transport) {
      transport = value;
    },
    async initialize() {
      const constructionStart = performance.now();
      if (transport === 'direct') {
        envs = [];
        for (let lane = 0; lane < n; lane++) {
          envs.push(new BonkEnvironment(config));
          if (options.diagnostics) process.stdout.write(`\rConstructed ${lane + 1}/${n} direct native residents`);
        }
        residency = [{ threadId: 0, numEnvs: envs.length, startId: 0 }];
        if (options.diagnostics && n > 0) process.stdout.write('\n');
      } else {
        pool = new WorkerPool(options.workers[0]);
        await pool.init(n, config, transport === 'shared');
        if (pool.isUsingSharedMemory() !== (transport === 'shared'))
          throw new Error(`Transport fallback from ${transport} is forbidden`);
        residency = pool.getWorkerResidency().map((entry) => ({ ...entry }));
        const expected = Math.min(options.workers[0]!, n);
        if (
          residency.length !== expected ||
          new Set(residency.map((entry) => entry.threadId)).size !== expected ||
          residency.some(
            (entry) =>
              !Number.isInteger(entry.threadId) ||
              entry.threadId <= 0 ||
              !Number.isInteger(entry.numEnvs) ||
              entry.numEnvs < 1 ||
              !Number.isInteger(entry.startId) ||
              entry.startId < 0,
          )
        ) {
          throw new Error('Workers did not acknowledge a valid resident layout');
        }
        const ordered = [...residency].sort((a, b) => a.startId - b.startId);
        let nextStart = 0;
        for (const entry of ordered) {
          if (entry.startId !== nextStart) throw new Error('Worker resident ranges have a gap or overlap');
          nextStart += entry.numEnvs;
        }
        if (nextStart !== n) throw new Error(`Workers acknowledged ${nextStart} residents, expected ${n}`);
      }
      const resetStart = performance.now();
      const constructionMs = resetStart - constructionStart;
      const observations =
        transport === 'direct'
          ? envs.map((env, lane) => env.reset(options.seed + lane))
          : await pool!.reset(Array.from({ length: n }, (_, lane) => options.seed + lane));
      validateReset(observations, n);
      states = makeStates();
      actionCall = 0;
      return { constructionMs, resetMs: performance.now() - resetStart };
    },
    async warmup(calls: number) {
      if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Warmup calls must be a positive integer');
      await run(calls, actionCall, nextActionCall);
      // Warmup's final terminal result is already outside the measured
      // window. Resolve its pending reset without advancing a probe tick:
      // doing so would change the next episode's deterministic FS schedule.
      // Any reset generated by that terminal result is likewise excluded.
      for (const state of states) state.excludedResetPending ||= state.previousAutoResetAfter;
    },
    async runForDuration(
      seconds: number,
      segmentSeconds: number,
      onSegment: (segment: BenchmarkSegment) => void,
      classifyTrailingResets = true,
    ) {
      if (!(seconds > 0) || !(segmentSeconds > 0)) throw new Error('Duration and segment duration must be positive');
      const total: StepCounters = {
        batchCalls: 0,
        agentApiSteps: 0,
        nativeSessionTicks: 0,
        terminalHoldSteps: 0,
        observedRestarts: 0,
        autoResets: 0,
        perLaneNativeSessionTicks: Array.from({ length: n }, () => 0),
        perLaneObservedRestarts: Array.from({ length: n }, () => 0),
      };
      const started = performance.now();
      const deadline = performance.now() + seconds * 1000;
      let segmentStart = performance.now();
      let segmentDeadline = segmentStart + segmentSeconds * 1000;
      let segment: StepCounters = {
        ...total,
        perLaneNativeSessionTicks: [...total.perLaneNativeSessionTicks!],
        perLaneObservedRestarts: [...total.perLaneObservedRestarts!],
      };
      const numericKeys = [
        'batchCalls',
        'agentApiSteps',
        'nativeSessionTicks',
        'terminalHoldSteps',
        'observedRestarts',
        'autoResets',
      ] as const;
      const add = (to: StepCounters, from: StepCounters) => {
        for (const key of numericKeys) to[key] += from[key];
        for (let lane = 0; lane < n; lane++) {
          to.perLaneNativeSessionTicks![lane] += from.perLaneNativeSessionTicks![lane]!;
          to.perLaneObservedRestarts![lane] += from.perLaneObservedRestarts![lane]!;
        }
      };
      const difference = (
        left: StepCounters,
        right: StepCounters,
        key: (typeof numericKeys)[number] | 'perLaneNativeSessionTicks' | 'perLaneObservedRestarts',
        lane?: number,
      ) =>
        lane === undefined
          ? (left[key] as number) - (right[key] as number)
          : (left[key] as number[])[lane]! - (right[key] as number[])[lane]!;
      const rates = (delta: StepCounters, durationMs: number, final: boolean) => ({
        batchCallsPerSecond: delta.batchCalls / (durationMs / 1000),
        agentApiStepsPerSecond: delta.agentApiSteps / (durationMs / 1000),
        nativeSessionTicksPerSecond: delta.nativeSessionTicks / (durationMs / 1000),
        autoResetsPerSecond: delta.autoResets / (durationMs / 1000),
        trailingResetClassificationPending: !final,
      });
      const emitSegment = (now: number, final: boolean) => {
        const durationMs = now - segmentStart;
        const delta: StepCounters = {
          batchCalls: 0,
          agentApiSteps: 0,
          nativeSessionTicks: 0,
          terminalHoldSteps: 0,
          observedRestarts: 0,
          autoResets: 0,
          perLaneNativeSessionTicks: Array.from({ length: n }, () => 0),
          perLaneObservedRestarts: Array.from({ length: n }, () => 0),
        };
        for (const key of numericKeys) delta[key] = difference(total, segment, key);
        for (let lane = 0; lane < n; lane++) {
          delta.perLaneNativeSessionTicks![lane] = difference(total, segment, 'perLaneNativeSessionTicks', lane);
          delta.perLaneObservedRestarts![lane] = difference(total, segment, 'perLaneObservedRestarts', lane);
        }
        onSegment({ durationMs, counters: delta, metrics: rates(delta, durationMs, final) });
        segment = {
          ...total,
          perLaneNativeSessionTicks: [...total.perLaneNativeSessionTicks!],
          perLaneObservedRestarts: [...total.perLaneObservedRestarts!],
        };
        segmentStart = now;
        segmentDeadline = now + segmentSeconds * 1000;
      };
      while (performance.now() < deadline) {
        const now = performance.now();
        if (now >= segmentDeadline) emitSegment(now, false);
        const one = await run(1, actionCall, nextActionCall);
        add(total, one);
      }
      const measuredEnd = performance.now();
      let trailingAutoResets = 0;
      if (classifyTrailingResets) {
        // Resolve only the reset attribution of trailing terminal lanes. The
        // probe runs after the timed window; all of its advances and results
        // are excluded from measured counters and segment durations.
        const pending = states.flatMap((state, lane) => (state.finalDone ? [lane] : []));
        const resolved = await classificationProbe(pending);
        trailingAutoResets = resolved.filter(Boolean).length;
        for (let lane = 0; lane < n; lane++)
          if (resolved[lane]) {
            total.autoResets++;
            total.perLaneObservedRestarts![lane]!++;
          }
        total.observedRestarts += trailingAutoResets;
      } else {
        // Warmup is not a measurement window. Resolve its terminal boundary
        // without any probe, preserving the next deterministic FS schedule.
        for (const state of states) {
          state.probeClassifiedReset = false;
          state.excludedResetPending ||= state.previousAutoResetAfter;
        }
      }
      // Terminal-only windows are valid: a short frame-skip tail can contain
      // holds and an automatic restart without any advancing public result.
      // Keep zero as an observable rate; longer soak diagnostics separately
      // require actual aggregate progress across their complete window.
      total.trailingAutoResets = trailingAutoResets;
      total.autoResetsPerLane = total.perLaneObservedRestarts;
      total.measuredMs = measuredEnd - started;
      // Always emit the tail, including a run shorter than one segment. The
      // timestamp was captured before the excluded classification probe.
      emitSegment(measuredEnd, true);
      return total;
    },
    async measure(calls: number) {
      if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Measured calls must be a positive integer');
      const measuredStart = process.hrtime.bigint();
      const result = await run(calls, actionCall, nextActionCall);
      result.measuredMs = Number(process.hrtime.bigint() - measuredStart) / 1e6;
      // Terminal-only windows are valid. They must not be rejected merely
      // because no public result advances simulation. Liveness belongs to a
      // sufficiently long soak check, not an arbitrary measurement window.
      // One public classification batch resolves trailing auto-reset ambiguity;
      // it is deliberately excluded from every returned rate/counter.
      const pending = states.flatMap((state, lane) => (state.finalDone ? [lane] : []));
      const resolved = await classificationProbe(pending);
      for (let lane = 0; lane < n; lane++)
        if (resolved[lane]) {
          result.autoResets++;
          result.observedRestarts++;
          result.perLaneObservedRestarts![lane]!++;
        }
      result.trailingAutoResets = resolved.filter(Boolean).length;
      result.autoResetsPerLane = result.perLaneObservedRestarts;
      for (const state of states) {
        state.ticks = 0;
        state.holds = 0;
        state.restarts = 0;
      }
      return result;
    },
    async stabilize() {
      const pending = states.flatMap((state, lane) => (state.finalDone ? [lane] : []));
      await classificationProbe(pending);
    },
    async resetCycles(cycles: number) {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const observations =
          transport === 'direct'
            ? envs.map((env, lane) => env.reset(options.seed + lane + cycle * n))
            : await pool!.reset(Array.from({ length: n }, (_, lane) => options.seed + lane + cycle * n));
        validateReset(observations, n);
        states = makeStates();
        actionCall = 0;
      }
      return cycles * n;
    },
    diagnostics() {
      const workers = pool ? (pool as unknown as { workers: unknown[]; workerEnvs: number[] }) : undefined;
      return {
        residencyEvidence: pool ? 'worker-init-acknowledgment' : 'direct-construction-count',
        residency: residency.map((entry) => ({ ...entry })),
        actualWorkerCount: residency.length,
        acknowledgedResidents: residency.reduce((sum, entry) => sum + entry.numEnvs, 0),
        expectedActiveWorkers: pool ? Math.min(options.workers[0]!, n) : 1,
        ...(workers
          ? {
              privateLayoutCrossCheck: {
                actualWorkerCount: workers.workers.length,
                workerEnvs: [...workers.workerEnvs],
              },
            }
          : {}),
      };
    },
    async close() {
      for (const env of envs) env.close();
      envs = [];
      residency = [];
      await pool?.close();
      pool = undefined;
    },
  };
}

export function createNativeStepperForBenchmark(
  n: number,
  config: EnvironmentConfig,
  options: BenchmarkOptions,
  transport: Transport,
): NativeStepper {
  const stepper = observerStepper(n, config, options);
  stepper.setTransport(transport);
  return stepper;
}

export async function runThroughputCase(
  transport: Transport,
  n: number,
  frameSkip: number,
  repeat: number,
  options: BenchmarkOptions,
) {
  const started = process.hrtime.bigint();
  const memory = new MemoryMonitor(started);
  memory.sample('preInit');
  memory.start(options.sampleMs);
  const stepper = observerStepper(n, makeNativeConfig(options, frameSkip), options);
  stepper.setTransport(transport);
  const durations: Record<string, number> = {};
  let mark = performance.now();
  const elapsed = (key: string) => {
    const now = performance.now();
    durations[key] = now - mark;
    mark = now;
  };
  let counters: StepCounters | undefined;
  const segments: BenchmarkSegment[] = [];
  const workload = options.sustained
    ? {
        kind: 'duration',
        requestedWarmupSeconds: options.warmupSeconds,
        requestedMeasuredSeconds: options.durationSeconds,
        requestedSegmentSeconds: options.segmentSeconds,
      }
    : {
        kind: 'calls',
        requestedWarmupCalls: options.warmupSteps,
        requestedMeasuredCalls: options.steps,
      };
  try {
    const initialization = await stepper.initialize();
    Object.assign(durations, initialization);
    elapsed('initializationOverheadMs');
    memory.sample('postInit');
    if (options.sustained) {
      // Duration warmup is not a measurement window. Do not insert an extra
      // probe after it: that would change the next deterministic FS schedule.
      await stepper.runForDuration(options.warmupSeconds, options.warmupSeconds, () => {}, false);
    } else {
      await stepper.warmup(options.warmupSteps);
    }
    elapsed('warmupMs');
    memory.sample('postWarmup');
    counters = options.sustained
      ? await stepper.runForDuration(options.durationSeconds, options.segmentSeconds, (segment) => {
          segments.push({ ...segment, memory: memory.sample(`segment-${segments.length}`) });
        })
      : await stepper.measure(options.steps);
    if (options.sustained) {
      assertDurationSegmentReconciliation(counters, segments, n);
      const laneTicks = counters.perLaneNativeSessionTicks ?? [];
      if (laneTicks.some((ticks) => !(ticks > 0))) {
        throw new Error(`Sustained throughput lacks native progress on every resident: ${JSON.stringify(laneTicks)}`);
      }
    }
    const measuredMs = counters.measuredMs!;
    if (!(measuredMs > 0)) throw new Error('Missing internal measured-step timer');
    durations.measuredSteppingMs = measuredMs;
    const resetStart = process.hrtime.bigint();
    const residentResets = await stepper.resetCycles(options.resetCycles);
    durations.explicitResetMs = Number(process.hrtime.bigint() - resetStart) / 1e6;
    memory.sample('postResetCycles');
    const seconds = measuredMs / 1000;
    const diagnostics = stepper.diagnostics();
    if (
      (diagnostics.actualWorkerCount as number | undefined) !== undefined &&
      diagnostics.actualWorkerCount !== diagnostics.expectedActiveWorkers
    )
      throw new Error('Actual worker layout differs from requested');
    if (diagnostics.acknowledgedResidents !== n) throw new Error('Acknowledged resident count differs from requested');
    if (transport !== 'direct' && diagnostics.residencyEvidence !== 'worker-init-acknowledgment')
      throw new Error('Missing worker-reported residency');
    return {
      caseId: `${transport}-n${n}-fs${frameSkip}-repeat${repeat}`,
      status: 'PASS',
      transport,
      requestedTransport: transport,
      ownership: transport === 'message' ? 'owned' : options.ownership,
      residents: n,
      requestedWorkers: transport === 'direct' ? 0 : options.workers[0],
      frameSkip,
      repeat,
      ...diagnostics,
      workload: {
        ...workload,
        measuredMs,
        measuredSeconds: seconds,
        segmentCount: segments.length,
      },
      durationsMs: durations,
      counters: {
        ...counters,
        explicitResidentResets: residentResets,
        postWindowClassificationProbe: true,
        trailingResetAttributionAssignedToFinalSegment: options.sustained,
      },
      ...(options.sustained ? { segments } : {}),
      metrics: {
        batchCallsPerSecond: counters.batchCalls / seconds,
        agentApiStepsPerSecond: counters.agentApiSteps / seconds,
        nativeSessionTicksPerSecond: counters.nativeSessionTicks / seconds,
        terminalHoldSteps: counters.terminalHoldSteps,
        autoResetsPerSecond: counters.autoResets / seconds,
        explicitResetBatchCallsPerSecond: options.resetCycles / (durations.explicitResetMs! / 1000),
        explicitResidentResetsPerSecond: residentResets / (durations.explicitResetMs! / 1000),
        rateAggregation: options.sustained ? 'total-counters-over-total-measured-time' : 'single-call-window',
      },
      metricDefinitions: {
        nativeSessionTicksPerSecond:
          'Countdown- and rollover-inclusive native session advances; terminal holds excluded. Not solver-only Box2D TPS.',
        agentApiStepsPerSecond: 'All resident step results per second, including terminal holds.',
        autoResetsPerSecond: 'Observed restarts plus trailing resets classified by one excluded probe batch.',
      },
      memory: memory.summary(n),
      memorySamples: memory.samples,
    };
  } finally {
    const closeStart = performance.now();
    await stepper.close();
    durations.closeMs = performance.now() - closeStart;
    memory.sample('postClose');
    memory.stop();
  }
}

export function runMetadata(options: BenchmarkOptions, runId: string, kind: string): Record<string, unknown> {
  const map = readFileSync(NATIVE_MAP_PATH);
  let commit = 'unknown';
  let dirty: boolean | undefined;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0;
  } catch {
    /* metadata only */
  }
  // Hash source bytes actually loaded by this dirty-tree run. A commit hash
  // alone cannot identify uncommitted benchmark or engine behavior.
  const sourceFiles = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.js', '*.cjs', '*.json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const sources = Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.resolve(file)))
        .digest('hex'),
    ]),
  );
  return {
    schemaVersion: 1,
    runId,
    kind,
    createdAt: new Date().toISOString(),
    argv: process.argv,
    cwd: process.cwd(),
    options,
    map: { path: NATIVE_MAP_PATH, sha256: createHash('sha256').update(map).digest('hex') },
    git: { commit, dirty },
    sourceFiles: sources,
    sourceHashAlgorithm: 'sha256; tracked and non-ignored untracked TS/JS/CJS/JSON files',
    hardware: {
      platform: process.platform,
      arch: process.arch,
      release: require('node:os').release(),
      cpuModel: cpus()[0]?.model,
      logicalCpuCount: cpus().length,
      cpuSpeedMHz: cpus()[0]?.speed,
      totalMemoryBytes: totalmem(),
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      pid: process.pid,
      execArgv: process.execArgv,
      gcExposed: typeof global.gc === 'function',
    },
  };
}

export function writeReceiptNoOverwrite(outDir: string, prefix: string, receipt: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const id = `${prefix}-${new Date().toISOString().replace(/:/g, '-')}-${process.pid}-${randomUUID()}`;
  const final = path.join(outDir, `${id}.json`);
  const temporary = path.join(outDir, `.${id}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx');
    writeSync(descriptor, JSON.stringify(receipt, null, 2) + '\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, final);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* already linked or never created */
    }
  }
  return final;
}

export async function runThroughputMain(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runId = randomUUID();
  const matrix = nativeBenchmarkMatrix(options);
  console.log(JSON.stringify({ nativeBenchmarkMatrix: matrix }, null, 2));
  const receipt: Record<string, unknown> = {
    ...runMetadata(options, runId, 'native-throughput'),
    matrix,
    cases: [],
    status: 'PASS',
  };
  const cases = receipt.cases as unknown[];
  for (const entry of matrix) {
    const caseOptions = { ...options, workers: [entry.workers] };
    try {
      if (entry.transport === 'shared' && !WorkerPool.isSupported()) {
        cases.push({ ...entry, status: 'SKIP', reason: 'SharedArrayBuffer unsupported; no fallback used' });
        receipt.status = 'PASS_WITH_SKIPS';
        continue;
      }
      const result = await runThroughputCase(entry.transport, entry.n, entry.frameSkip, entry.repeat, caseOptions);
      cases.push(result);
      console.log(JSON.stringify({ case: result.caseId, status: result.status, metrics: result.metrics }));
    } catch (error) {
      receipt.status = 'FAIL';
      cases.push({
        ...entry,
        status: 'FAIL',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack, cause: (error as Error & { cause?: unknown }).cause }
            : String(error),
      });
      console.error(error);
    }
  }
  const file = writeReceiptNoOverwrite(options.outDir, 'native-throughput', receipt);
  console.log(`Native benchmark receipt: ${file}`);
  if (receipt.status !== 'PASS') process.exitCode = 1;
}
