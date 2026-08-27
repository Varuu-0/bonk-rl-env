/**
 * environment-seed-parity.test.ts — Regression coverage for issue #460
 *
 * The accepted seed domain [0, 0xFFFFFFFE] must behave identically through
 * the direct in-process BonkEnvironment API and WorkerPool.reset([seed]) in
 * BOTH transports: the same seed must resolve onto the same observation
 * trace everywhere, so a rollout recorded on one documented surface can be
 * replayed on every other. (Before #460 the direct API silently bit-cast
 * invalid seeds while the pool rejected them; valid seeds were already
 * parity-pinned by the frame-skip/trace suites — this pins the full
 * accepted domain including both boundaries.)
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { WorkerPool } from '../../src/core/worker-pool';

const PARITY_SEEDS = [0, 1, 42, 0x7ffffffe, 0xfffffffd, 0xfffffffe];
const STEPS = 30;

function directTrace(seed: number): number[] {
  const env = new BonkEnvironment({ numOpponents: 1, seed });
  env.reset(seed);
  const out: number[] = [];
  for (let i = 0; i < STEPS; i++) {
    const r = env.step(0);
    out.push(r.observation.playerX, r.observation.playerY);
  }
  env.close();
  // The pool transports quantize observations to Float32 (issue #236);
  // quantize the direct trace the same way so the traces are comparable.
  return out.map(Math.fround);
}

async function poolTrace(useSharedMemory: boolean, seed: number): Promise<number[]> {
  const pool = new WorkerPool(1);
  try {
    await pool.init(1, { numOpponents: 1 }, useSharedMemory);
    await pool.reset([seed]);
    const out: number[] = [];
    for (let i = 0; i < STEPS; i++) {
      const [r] = await pool.step([0]);
      out.push(r.observation.playerX, r.observation.playerY);
    }
    return out;
  } finally {
    await pool.close();
  }
}

describe('direct env vs WorkerPool seed parity (issue #460)', () => {
  it('message-passing mode: every accepted seed resolves onto the same trace', async () => {
    for (const seed of PARITY_SEEDS) {
      const expected = directTrace(seed);
      const actual = await poolTrace(false, seed);
      expect(actual).toEqual(expected);
    }
  }, 120000);

  it('shared-memory mode: every accepted seed resolves onto the same trace', async () => {
    if (!WorkerPool.isSupported()) return;
    for (const seed of PARITY_SEEDS) {
      const expected = directTrace(seed);
      const actual = await poolTrace(true, seed);
      expect(actual).toEqual(expected);
    }
  }, 120000);

  it('boundary seeds remain valid on every surface after #460', async () => {
    const envLow = new BonkEnvironment({ numOpponents: 1, seed: 0 });
    expect(() => envLow.reset(0)).not.toThrow();
    envLow.close();
    const envHigh = new BonkEnvironment({ numOpponents: 1, seed: 0xfffffffe });
    expect(() => envHigh.reset(0xfffffffe)).not.toThrow();
    envHigh.close();
  });
});
