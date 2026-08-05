/**
 * worker-pool-transport-parity.test.ts — Regression coverage for issue #236
 *
 * The shared-memory transport used to publish observations and rewards
 * through Float32Array SAB records (Float32 quantization), while
 * message-passing forwarded the environment's Float64 values untouched.
 * Identical (seed, actions) therefore produced different numbers in the two
 * transports, silently breaking cross-transport deterministic replay. Both
 * transports now publish Float32 (message mode quantizes with Math.fround),
 * so every observation field and reward must be bit-identical (`===`) for
 * the same seed and action sequence.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

const OBS_FLOAT_FIELDS = [
  'playerX',
  'playerY',
  'playerVelX',
  'playerVelY',
  'playerAngle',
  'playerAngularVel',
  'arenaHalfWidth',
  'arenaHalfHeight',
];

const OPP_FLOAT_FIELDS = ['x', 'y', 'velX', 'velY'];

function assertObservationEqual(a: any, b: any): void {
  for (const field of OBS_FLOAT_FIELDS) {
    expect(a[field]).toBe(b[field]);
  }
  expect(a.playerIsHeavy).toBe(b.playerIsHeavy);
  expect(a.opponents).toHaveLength(b.opponents.length);
  for (let i = 0; i < a.opponents.length; i++) {
    for (const field of OPP_FLOAT_FIELDS) {
      expect(a.opponents[i][field]).toBe(b.opponents[i][field]);
    }
    expect(a.opponents[i].isHeavy).toBe(b.opponents[i].isHeavy);
    expect(a.opponents[i].alive).toBe(b.opponents[i].alive);
  }
  expect(a.tick).toBe(b.tick);
}

describe('transport precision parity (issue #236)', () => {
  it('returns bit-identical reset/step observations and rewards in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    const run = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        await pool.init(1, { maxTicks: 300, seed: 42, frameSkip: 2 }, useSharedMemory);
        const resetObs = (await pool.reset([42]))[0];
        const results = [];
        // Step [0] is the issue's repro (non-integer playerY, -0.001 time
        // penalty reward); step [2] exercises a directional input.
        results.push((await pool.step([0]))[0]);
        results.push((await pool.step([2]))[0]);
        return { resetObs, results, pool };
      } catch (e) {
        await pool.close();
        throw e;
      }
    };

    const shared = await run(true);
    const message = await run(false);

    assertObservationEqual(shared.resetObs, message.resetObs);
    expect(shared.resetObs.playerY).toBe(Math.fround(shared.resetObs.playerY));

    for (let i = 0; i < shared.results.length; i++) {
      const s = shared.results[i];
      const m = message.results[i];
      expect(s.done).toBe(m.done);
      expect(s.truncated).toBe(m.truncated);
      assertObservationEqual(s.observation, m.observation);
      expect(s.reward).toBe(m.reward);
      // Both transports report the canonical Float32 value, so e.g. the
      // -0.001 time penalty is the Float32-quantized -0.0010000000474974513.
      expect(s.reward).toBe(Math.fround(s.reward));
    }

    await shared.pool.close();
    await message.pool.close();
  });

  it('returns bit-identical terminal observations and rewards on terminal steps', async () => {
    if (!WorkerPool.isSupported()) return;

    const run = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        // maxTicks 1 makes the single step terminal in both transports.
        await pool.init(1, { maxTicks: 1, seed: 7 }, useSharedMemory);
        await pool.reset([7]);
        const result = (await pool.step([0]))[0];
        return { result, pool };
      } catch (e) {
        await pool.close();
        throw e;
      }
    };

    const shared = await run(true);
    const message = await run(false);

    expect(shared.result.done).toBe(true);
    expect(message.result.done).toBe(true);
    assertObservationEqual(shared.result.observation, message.result.observation);
    expect(shared.result.reward).toBe(message.result.reward);
    expect(shared.result.info.terminal_observation).toBeDefined();
    expect(message.result.info.terminal_observation).toBeDefined();
    assertObservationEqual(
      shared.result.info.terminal_observation,
      message.result.info.terminal_observation,
    );

    await shared.pool.close();
    await message.pool.close();
  });
});