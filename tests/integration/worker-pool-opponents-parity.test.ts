/**
 * worker-pool-opponents-parity.test.ts — Regression coverage for issue #210
 *
 * The shared-memory observation record used to be a fixed 16-float layout
 * with a single opponent slot, so with numOpponents > 1 the default
 * transport silently returned observations with exactly one opponent while
 * message-passing mode returned all of them. The record is now sized from
 * the configured opponent count (first opponent at offsets 7-12, extras
 * appended after the tick at 16+), and both transports must produce the
 * same observation content for the same seed.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';
import { BonkEnvironment } from '../../src/core/environment';
import { SharedMemoryManager } from '../../src/ipc/shared-memory';

describe('canonical numOpponents normalization', () => {
  it('the environment spawn count always matches the SAB layout count', () => {
    for (const raw of [1, 3, 2.9, 0, -2, NaN, undefined, '3']) {
      const env = new BonkEnvironment({ maxTicks: 10, numOpponents: raw as any });
      const obs = env.reset();
      const expected = SharedMemoryManager.normalizeNumOpponents(raw);
      expect(obs.opponents.length).toBe(expected);
      expect(env.getObservationFast().length).toBe(SharedMemoryManager.floatsPerEnv(raw));
    }
  });
});

describe('SAB multi-opponent parity (issue #210)', () => {
  it('returns every opponent in reset and step observations in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    const run = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        await pool.init(1, { maxTicks: 300, numOpponents: 3, seed: 42 }, useSharedMemory);
        const resetObs = (await pool.reset([42]))[0];
        expect(resetObs.opponents.length).toBe(3);

        const stepLens: number[] = [];
        for (let i = 0; i < 5; i++) {
          stepLens.push((await pool.step([2]))[0].observation.opponents.length);
        }
        return { resetObs, stepLens, pool };
      } catch (e) {
        await pool.close();
        throw e;
      }
    };

    const shared = await run(true);
    const message = await run(false);

    expect(shared.resetObs.opponents.length).toBe(3);
    expect(message.resetObs.opponents.length).toBe(3);
    expect(shared.stepLens).toEqual([3, 3, 3, 3, 3]);
    expect(message.stepLens).toEqual([3, 3, 3, 3, 3]);

    // The additional opponents carry real, non-zero state on both sides.
    for (const obs of [shared.resetObs, message.resetObs]) {
      for (let i = 1; i < 3; i++) {
        expect(obs.opponents[i].alive).toBe(true);
        expect(typeof obs.opponents[i].x).toBe('number');
      }
    }

    // Same seed -> same trajectories; the SAB path quantizes to Float32.
    const messageReset = message.resetObs;
    for (let i = 0; i < 3; i++) {
      const a = shared.resetObs.opponents[i];
      const b = messageReset.opponents[i];
      expect(a.x).toBeCloseTo(b.x, 2);
      expect(a.y).toBeCloseTo(b.y, 2);
      expect(a.velX).toBeCloseTo(b.velX, 2);
      expect(a.velY).toBeCloseTo(b.velY, 2);
      expect(a.isHeavy).toBe(b.isHeavy);
      expect(a.alive).toBe(b.alive);
    }

    await shared.pool.close();
    await message.pool.close();
  });

  it('extracts every opponent block from the multi-opponent SAB layout', () => {
    const pool = new WorkerPool(1);
    (pool as any)._obsNumOpponents = 3;
    (pool as any)._obsFloatsPerEnv = 28;
    (pool as any).initObsPool(1);

    // Env 0 record: 28 floats. Player block 0-6, opponent 0 at 7-12, arena
    // 13-14, tick 15, opponent 1 at 16-21, opponent 2 at 22-27.
    const obs = new Float32Array(28);
    for (let k = 0; k < 28; k++) obs[k] = 100 + k;
    obs[26] = 0; // opponent 2 not alive
    const o = (pool as any).extractObservation(obs, 0, 0);

    expect(o.opponents).toHaveLength(3);
    expect(o.opponents[0].x).toBe(107);
    expect(o.opponents[0].y).toBe(108);
    expect(o.opponents[0].alive).toBe(obs[12] === 1 ? true : false);
    expect(o.opponents[1].x).toBe(116);
    expect(o.opponents[1].y).toBe(117);
    expect(o.opponents[1].alive).toBe(obs[21] === 1 ? true : false);
    expect(o.opponents[2].x).toBe(122);
    expect(o.opponents[2].y).toBe(123);
    expect(o.opponents[2].alive).toBe(false);
    expect(o.arenaHalfWidth).toBe(113);
    expect(o.tick).toBe(115);

    // The same template is reused and correctly re-read for a second env
    // (worker-local SAB index 1 -> record offset 28; env 1 values 228..255).
    const obs2 = new Float32Array(56);
    for (let k = 0; k < 56; k++) obs2[k] = 200 + k;
    const o2 = (pool as any).extractObservation(obs2, 1, 0);
    expect(o2.playerX).toBe(228);
    expect(o2.opponents[2].x).toBe(250);
  });

  it('sizes getObservationFast for the configured opponent count', () => {
    const env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 3 });
    env.reset();
    const fastObs = env.getObservationFast();
    expect(fastObs).toBeInstanceOf(Float32Array);
    expect(fastObs.length).toBe(28);

    const obs = env.reset();
    for (let i = 0; i < 3; i++) {
      const base = i === 0 ? 7 : 16 + 6 * (i - 1);
      expect(fastObs[base]).toBe(obs.opponents[i].x);
      expect(fastObs[base + 1]).toBe(obs.opponents[i].y);
      expect(fastObs[base + 5]).toBe(obs.opponents[i].alive ? 1 : 0);
    }
    // Arena and tick keep their fixed offsets.
    expect(fastObs[13]).toBeGreaterThan(0);
    expect(fastObs[15]).toBe(0);
    env.step(0);
    expect(env.getObservationFast()[15]).toBe(1);
  });
});
