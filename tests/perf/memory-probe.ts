import { BonkEnvironment } from '../../src/core/environment';

// Memory measurement probe for the memory-stability perf test. It runs in a
// dedicated `node --expose-gc` process so `global.gc` is guaranteed and the
// measurement is isolated from the rest of the vitest suite (no shared-GC
// timing noise from concurrent forks). Growth is reported per memory category
// so native-side/external retention is covered, not just V8 `heapUsed`.
//
// Exit status: 0 when retained growth is under the 20 MB threshold, 1 otherwise.

function forceFullGC(): void {
  if (typeof global.gc !== 'function') {
    throw new Error('global.gc unavailable -- run with node --expose-gc');
  }
  global.gc();
  global.gc();
}

function runLoop(): void {
  const env = new BonkEnvironment({ maxTicks: 5000 });
  for (let i = 0; i < 50; i++) {
    env.reset();
    for (let j = 0; j < 100; j++) {
      env.step(0);
    }
  }
  env.close();
}

interface MemorySample {
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  rss: number;
}

function sample(): MemorySample {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
  };
}

// Warm-up pass so lazily initialized module/engine state is at baseline
// before the measured pass.
runLoop();
forceFullGC();
const before = sample();

runLoop();
forceFullGC();
const after = sample();

const mb = (bytes: number) => bytes / (1024 * 1024);
const diff = (key: keyof MemorySample) => mb(after[key] - before[key]);

const results = {
  heapUsedMB: diff('heapUsed'),
  externalMB: diff('external'),
  arrayBuffersMB: diff('arrayBuffers'),
  rssMB: diff('rss'),
  thresholdMB: 20,
};
// Write via process.stdout and exit via process.exitCode (natural process
// end) so the piped JSON report always flushes before the child terminates;
// process.exit() could truncate stdout and produce a flaky parse in the test.
process.stdout.write(`${JSON.stringify(results)}\n`);
process.exitCode =
  results.heapUsedMB >= results.thresholdMB || results.externalMB >= results.thresholdMB ? 1 : 0;
