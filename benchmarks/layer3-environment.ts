/**
 * Layer 3: Single-Thread Environment Throughput
 *
 * Measures BonkEnvironment.step() which includes physics tick,
 * observation extraction, reward calculation, action decoding,
 * and frame skip logic. No worker threads or IPC overhead.
 *
 * Episodes are kept live for the whole measurement window: whenever a
 * step reports done the loop resets (via stepLive), because a settled
 * environment replays its terminal result with zero physics work (#421).
 * SPS counts only live physics steps.
 *
 * Layer: 3 — Environment
 * Run:   npx tsx benchmarks/layer3-environment.ts
 */

import { BonkEnvironment } from '../src/core/environment';
import {
  BenchmarkResult,
  BenchmarkSuite,
  createSuite,
  recordResult,
  finalizeSuite,
  emitSuite,
  formatSuiteSummary,
  stepLive,
} from '../src/utils/bench-report';

const STEPS = 2_000;
const WARMUP = 50;

/**
 * Live-physics pass gates (#421). The measured quantity is sustained
 * Box2D-backed stepping on the default map — same order as the
 * PhysicsEngine.tick() SLA baseline (~22,600 TPS) plus observation/reward
 * overhead. These match the ci-bench-check L3 SLA fail limit so a
 * standalone run and the SLA report agree on where regression starts; the
 * old no-op-inflated gates (>15k/20k SPS) validated terminal-hold fiction.
 */
const LIVE_SPS_GATE = 2_800;
const FRAME_SKIP_SPS_GATE = 2_800;

function benchEnvironmentStep(): BenchmarkResult {
  const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 1 });
  env.reset();

  let warmupResets = 0;
  for (let i = 0; i < WARMUP; i++) {
    if (stepLive(env, Math.floor(Math.random() * 64)).reset) warmupResets++;
  }

  let liveSteps = 0;
  let resets = 0;
  const start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    const outcome = stepLive(env, Math.floor(Math.random() * 64));
    if (outcome.live) liveSteps++;
    if (outcome.reset) resets++;
  }
  const elapsed = performance.now() - start;
  // Only physics-executing steps count toward throughput; with frameSkip=1
  // every measured step is live (the terminal step itself advances physics
  // before the immediate reset).
  const sps = liveSteps / (elapsed / 1000);
  const usPerStep = (elapsed / liveSteps) * 1000;

  return {
    layer: 3,
    name: 'BonkEnvironment.step() (1 AI + 1 opponent)',
    passed: sps > LIVE_SPS_GATE,
    status: sps > LIVE_SPS_GATE ? 'PASS' : 'FAIL',
    durationMs: elapsed,
    metrics: [
      { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
      { label: 'Avg step time', value: +usPerStep.toFixed(1), unit: 'us' },
      { label: 'Steps', value: STEPS, unit: '' },
      { label: 'Live steps', value: liveSteps, unit: '' },
      { label: 'Episodes completed', value: resets, unit: '' },
    ],
  };
}

function benchEnvironmentWithFrameSkip(): BenchmarkResult {
  const env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
  env.reset();

  for (let i = 0; i < WARMUP; i++) {
    stepLive(env, Math.floor(Math.random() * 64));
  }

  let liveSteps = 0;
  let resets = 0;
  const start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    const outcome = stepLive(env, Math.floor(Math.random() * 64));
    if (outcome.live) liveSteps++;
    if (outcome.reset) resets++;
  }
  const elapsed = performance.now() - start;
  // frameSkip > 1 holds the done result for the remainder of each action
  // cycle before resetting (#228); those replay steps run no physics and
  // are excluded from the throughput numerator.
  const sps = liveSteps / (elapsed / 1000);
  const usPerStep = (elapsed / liveSteps) * 1000;

  return {
    layer: 3,
    name: 'BonkEnvironment.step() (frameSkip=3)',
    passed: sps > FRAME_SKIP_SPS_GATE,
    status: sps > FRAME_SKIP_SPS_GATE ? 'PASS' : 'FAIL',
    durationMs: elapsed,
    metrics: [
      { label: 'SPS', value: Math.round(sps), unit: 'steps/sec' },
      { label: 'Avg step time', value: +usPerStep.toFixed(1), unit: 'us' },
      { label: 'Steps', value: STEPS, unit: '' },
      { label: 'Live steps', value: liveSteps, unit: '' },
      { label: 'Episodes completed', value: resets, unit: '' },
    ],
  };
}

function main(): void {
  const suiteStart = performance.now();
  const suite = createSuite(3, 'Environment', 'BonkEnvironment step throughput (no IPC)');

  recordResult(suite, benchEnvironmentStep());
  recordResult(suite, benchEnvironmentWithFrameSkip());

  finalizeSuite(suite, performance.now() - suiteStart);
  console.log(formatSuiteSummary(suite));
  emitSuite(suite, 'benchmarks/results/layer3.json');
  process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main();
