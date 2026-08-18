/**
 * direct-step-terminated.test.ts — Regression coverage for issue #391
 *
 * `BonkEnvironment.step()` result objects never carried a top-level
 * `terminated` boolean, even though WorkerPool.step() (both transports), the
 * ZMQ IPC bridge and the Python client all normalize it. Direct-API callers
 * reading `res.terminated` got `undefined`, making natural deaths
 * indistinguishable from "not terminated" without the undocumented
 * `info.terminated` fallback.
 *
 * This suite pins the direct environment to the same truth semantics the
 * pooled/IPC/Python surfaces expose: a top-level `terminated` field that is
 * a real own boolean property on every step, true for natural (permanent)
 * deaths — including a death on the same tick maxTicks fires (#208) — and
 * false for pure truncations, non-terminal steps, and the terminal-hold
 * tail. Parity with the pooled path is asserted in both transports for the
 * same seeded rollout.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';
import { BonkEnvironment } from '../../src/core/environment';
import type { EnvironmentConfig } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';

// Spawns the AI 900 map units from the origin, beyond the 850-unit OOB death
// circle, so it dies permanently on the very first tick (the position used by
// worker-pool-termination-flags.test.ts). maxTicks stays well above 1 so the
// death is a pure termination (truncated=false).
const naturalDeathMap: MapDef = {
  name: 'direct_step_terminated_death',
  spawnPoints: { team_blue: { x: 900, y: 0 }, team_red: { x: 200, y: -100 } },
  bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
};

const deathConfig: EnvironmentConfig = {
  mapData: naturalDeathMap,
  numOpponents: 1,
  maxTicks: 100,
  seed: 42,
};

// Both discs spawn well inside the death circle and far apart, with the
// opponent policy disabled so no contact can happen; a run survives to the
// time limit.
const survivalMap: MapDef = {
  name: 'direct_step_terminated_survival',
  spawnPoints: { team_blue: { x: -100, y: 0 }, team_red: { x: 100, y: 0 } },
  bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
};

const survivalConfig: EnvironmentConfig = {
  mapData: survivalMap,
  numOpponents: 1,
  maxTicks: 100,
  seed: 42,
  randomOpponent: false,
};

const truncationConfig: EnvironmentConfig = {
  mapData: survivalMap,
  numOpponents: 1,
  maxTicks: 1,
  seed: 42,
  randomOpponent: false,
};

// Death on the exact tick maxTicks fires: AI spawns beyond the OOB circle
// and maxTicks=1, so the same step must report terminated=true AND
// truncated=true (Gymnasium semantics, #208) — the flags are not mutually
// exclusive and the top-level terminated must not degrade into a pure
// truncation.
const deathAtMaxTicksConfig: EnvironmentConfig = {
  mapData: naturalDeathMap,
  numOpponents: 1,
  maxTicks: 1,
  seed: 42,
};

describe('direct step() results carry a top-level terminated boolean (issue #391)', () => {
  it('natural death step reports terminated=true with truncated=false', () => {
    const env = new BonkEnvironment(deathConfig);
    try {
      env.reset(42);
      const res = env.step(0);
      expect(res.done).toBe(true);
      expect(res.truncated).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(res, 'terminated')).toBe(true);
      expect(res.terminated).toBe(true);
      expect(res.terminated).toBe(res.info.terminated);
      expect(res.info.terminated).toBe(true);
    } finally {
      env.close();
    }
  });

  it('non-terminal step reports terminated=false as an own property', () => {
    const env = new BonkEnvironment(survivalConfig);
    try {
      env.reset(42);
      const res = env.step(0);
      expect(res.done).toBe(false);
      expect(res.truncated).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(res, 'terminated')).toBe(true);
      expect(res.terminated).toBe(false);
      expect(res.terminated).toBe(res.info.terminated);
    } finally {
      env.close();
    }
  });

  it('pure truncation at maxTicks reports terminated=false', () => {
    const env = new BonkEnvironment(truncationConfig);
    try {
      env.reset(42);
      const res = env.step(0);
      expect(res.done).toBe(true);
      expect(res.truncated).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(res, 'terminated')).toBe(true);
      expect(res.terminated).toBe(false);
      expect(res.terminated).toBe(res.info.terminated);
    } finally {
      env.close();
    }
  });

  it('death on the same tick maxTicks fires reports both flags (issue #208)', () => {
    const env = new BonkEnvironment(deathAtMaxTicksConfig);
    try {
      env.reset(42);
      const res = env.step(0);
      expect(res.done).toBe(true);
      expect(res.truncated).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(res, 'terminated')).toBe(true);
      expect(res.terminated).toBe(true);
      expect(res.terminated).toBe(res.info.terminated);
      expect(res.info.terminated).toBe(true);
    } finally {
      env.close();
    }
  });

  it('terminal hold tail keeps top-level terminated in sync with info.terminated', () => {
    const env = new BonkEnvironment(deathConfig);
    try {
      env.reset(42);
      const end = env.step(0);
      expect(end.done).toBe(true);
      expect(end.terminated).toBe(true);

      // The hold path (terminalReached) must report the recorded terminal
      // cause at the top level on every subsequent step until reset (#197).
      for (let i = 0; i < 3; i++) {
        const res = env.step(0);
        expect(res.done).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(res, 'terminated')).toBe(true);
        expect(res.terminated).toBe(true);
        expect(res.terminated).toBe(res.info.terminated);
      }
    } finally {
      env.close();
    }
  });
});

describe('direct terminated flag matches the pooled normalization (issue #391)', () => {
  const runThroughPool = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, deathConfig, useSharedMemory);
      await pool.reset([42]);
      const [p] = await pool.step([0]);
      expect(p.done).toBe(true);
      expect(p.truncated).toBe(false);
      expect(p.terminated).toBe(true);
      expect(p.terminated).toBe(p.info.terminated);
      expect(p.info.terminated).toBe(true);
    } finally {
      await pool.close();
    }
  };

  it('message-passing pooled result agrees with the direct environment', async () => {
    await runThroughPool(false);
  });

  it('shared-memory pooled result agrees with the direct environment', async () => {
    if (!WorkerPool.isSupported()) return;
    await runThroughPool(true);
  });
});