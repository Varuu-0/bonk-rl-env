/**
 * worker-pool-termination-flags.test.ts — Regression coverage for issue #208
 *
 * A death on the same tick maxTicks is reached must be reported as
 * terminated=true AND truncated=true (Gymnasium semantics: the two flags
 * are not mutually exclusive). The pool previously reconstructed
 * terminated as done && !truncated in both transports, destroying the
 * environment's own info.terminated and reclassifying the death as a pure
 * truncation, which made the Python client skip the terminal observation.
 *
 * The map spawns the AI 900 map units from the origin, beyond the 850-unit
 * death circle, so it dies on the very first tick; maxTicks=1 makes the
 * time limit fire on that same tick.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';
import { BonkEnvironment } from '../../src/core/environment';
import type { EnvironmentConfig } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';

const deathAtMaxTicksMap: MapDef = {
  name: 'death_at_tick1',
  spawnPoints: { team_blue: { x: 900, y: 0 }, team_red: { x: 200, y: -100 } },
  bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
};

const envConfig: EnvironmentConfig = { mapData: deathAtMaxTicksMap, numOpponents: 1, maxTicks: 1, seed: 42 };

describe('death exactly at maxTicks keeps both termination flags (issue #208)', () => {
  it('direct environment reports done, truncated and info.terminated', () => {
    const env = new BonkEnvironment(envConfig);
    env.reset(42);
    const res = env.step(0);
    expect(res.done).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.info.terminated).toBe(true);
    env.close();
  });

  const runThroughPool = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, envConfig, useSharedMemory);
      await pool.reset([42]);
      const [res] = await pool.step([0]);
      expect(res.done).toBe(true);
      expect(res.truncated).toBe(true);
      expect(res.terminated).toBe(true);
      expect(res.info.terminated).toBe(true);
      expect(res.info.terminal_observation).toBeDefined();
    } finally {
      await pool.close();
    }
  };

  it('message-passing mode preserves both flags and the terminal observation', async () => {
    await runThroughPool(false);
  });

  it('shared-memory mode preserves both flags and the terminal observation', async () => {
    if (!WorkerPool.isSupported()) return;
    await runThroughPool(true);
  });
});
