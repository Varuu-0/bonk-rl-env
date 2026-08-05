/**
 * worker-pool-info-parity.test.ts — Regression coverage for issue #205
 *
 * Shared-memory step results used to reconstruct `info` from a pooled
 * `{ tick: 0 }` template, silently dropping the documented info fields
 * (aiAlive, opponentsAlive, frameSkip, capZones, scoreBlue, scoreRed,
 * aiTeam) that message-passing mode returns from the environment's step().
 * Both transports must expose the same info dictionary for the same
 * environment state.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

const DOCUMENTED_INFO_KEYS = [
  'aiAlive',
  'aiTeam',
  'capZones',
  'frameSkip',
  'opponentsAlive',
  'scoreBlue',
  'scoreRed',
  'terminated',
  'tick',
];

describe('SAB step info parity with message-passing mode (issue #205)', () => {
  it('returns the full documented info dictionary on every step in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    const run = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        await pool.init(1, { maxTicks: 100, seed: 42, frameSkip: 2 }, useSharedMemory);
        await pool.reset([42]);
        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push((await pool.step([2]))[0]);
        }
        return results;
      } catch (e) {
        await pool.close();
        throw e;
      }
    };

    const shared = await run(true);
    const message = await run(false);

    expect(shared).toHaveLength(5);
    for (let i = 0; i < shared.length; i++) {
      const s = shared[i].info;
      const m = message[i].info;

      // Same key set, exactly the documented contract.
      expect(Object.keys(s).sort()).toEqual(DOCUMENTED_INFO_KEYS.slice().sort());
      expect(Object.keys(m).sort()).toEqual(DOCUMENTED_INFO_KEYS.slice().sort());
      expect(Object.keys(s).sort()).toEqual(Object.keys(m).sort());

      // Same values for the same seed and action (all fields are exact in
      // the SAB path: booleans, small ints, and the map-derived capZones).
      expect(s.tick).toBe(m.tick);
      expect(s.aiAlive).toBe(m.aiAlive);
      expect(s.opponentsAlive).toBe(m.opponentsAlive);
      expect(s.frameSkip).toBe(m.frameSkip);
      expect(s.capZones).toEqual(m.capZones);
      expect(s.scoreBlue).toBe(m.scoreBlue);
      expect(s.scoreRed).toBe(m.scoreRed);
      expect(s.aiTeam).toBe(m.aiTeam);
      expect(s.terminated).toBe(m.terminated);

      // Field types are the documented ones.
      expect(typeof s.aiAlive).toBe('boolean');
      expect(typeof s.opponentsAlive).toBe('number');
      expect(typeof s.frameSkip).toBe('number');
      expect(Array.isArray(s.capZones)).toBe(true);
      expect(typeof s.scoreBlue).toBe('number');
      expect(typeof s.scoreRed).toBe('number');
      expect(typeof s.aiTeam).toBe('string');
    }
  });

  it('terminal steps expose terminal_observation in both transports', async () => {
    if (!WorkerPool.isSupported()) return;

    const run = async (useSharedMemory: boolean) => {
      const pool = new WorkerPool(1);
      try {
        await pool.init(1, { maxTicks: 1 }, useSharedMemory);
        await pool.reset([1]);
        return (await pool.step([0]))[0];
      } catch (e) {
        await pool.close();
        throw e;
      }
    };

    const shared = await run(true);
    const message = await run(false);

    expect(shared.done).toBe(true);
    expect(message.done).toBe(true);
    expect(Object.keys(shared.info).sort()).toEqual(
      [...DOCUMENTED_INFO_KEYS, 'terminal_observation'].sort(),
    );
    expect(Object.keys(shared.info).sort()).toEqual(Object.keys(message.info).sort());
    expect(shared.info.terminal_observation).toBeDefined();
    expect(message.info.terminal_observation).toBeDefined();
    expect(shared.info.terminal_observation).toHaveProperty('playerX');
  });
});
