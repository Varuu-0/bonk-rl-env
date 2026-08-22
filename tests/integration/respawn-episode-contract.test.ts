/**
 * respawn-episode-contract.test.ts — Issue #339 regression coverage.
 *
 * P3b respawning (`settings.re` or `respawnEnabled: true`) used to hide every
 * OOB (death type 4) and lethal-collision (death type 1) death from the
 * environment: `PhysicsEngine.tick()` detected the death and respawned the
 * disc in the SAME pass, so `BonkEnvironment.step()` — a pure post-tick
 * observer — always saw `alive: true` / `deathType: 0`. As a result
 * `killReward`/`deathPenalty` never fired and `aiAlive`/`opponentsAlive`
 * stayed true.
 *
 * The fix makes the death observable by deferring the respawn: the death pass
 * leaves the disc dead (body still present) for the rest of the tick it died
 * in, and the engine respawns it at the start of the FOLLOWING tick. The
 * episode-level contract therefore matches the documented reward contract —
 * `killReward`/`deathPenalty` fire and `aiAlive`/`opponentsAlive` reflect the
 * death on the dying step — while the episode does NOT terminate on a
 * transient respawn death: the round continues with the respawned disc,
 * matching native `re` semantics (coordinated with the #341/#371 death
 * contract). Only a permanent death terminates: cap-zone elimination (type 3),
 * respawning disabled, or an invalid spawn point that detached immediately.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { PhysicsEngine, GRAVITY_Y, DT, SCALE, TPS } from '../../src/core/physics-engine';
import { WorkerPool } from '../../src/core/worker-pool';
import type { MapDef } from '../../src/core/physics-engine';
import type { EnvironmentConfig } from '../../src/core/environment';

/** Deterministic static-wall arena (x ±515 / y ±300 map px, no floor). */
const RESPAWN_MAP: MapDef = {
  name: 'respawn-episode-map',
  spawnPoints: {
    team_blue: { x: -200, y: -100 },
    team_red: { x: 200, y: -100 },
  },
  bodies: [
    { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
    { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
  ],
  settings: { re: true },
};

/** World position far beyond the 850/scale OOB death circle (≈28.3 world units). */
const OOB_WORLD_X = 200;

/** One tick of gravity drift (no floor under a spawn) keeps the disc within 2 map px. */
const SPAWN_TOLERANCE = 2;

/** Action bit 2 = up (environment decodeAction encoding). */
const ACTION_UP = 4;

function teleportOob(env: BonkEnvironment, id: number): void {
  const physics: any = (env as any).physics;
  physics.playerBodies.get(id).SetXForm(new (require('box2d').b2Vec2)(OOB_WORLD_X, 0), 0);
}

function makeEnv(partial: any): BonkEnvironment {
  return new BonkEnvironment({ numOpponents: 1, seed: 7, randomOpponent: false, ...partial });
}

function expectAtSpawn(state: { x: number; y: number }, spawnX: number, spawnY: number): void {
  expect(Math.abs(state.x - spawnX)).toBeLessThan(1);
  expect(Math.abs(state.y - spawnY)).toBeLessThan(SPAWN_TOLERANCE);
}

describe('respawn deaths are observable and rewarded (issue #339)', () => {
  it('map-driven settings.re: AI OOB death fires deathPenalty and continues', () => {
    const env = makeEnv({ mapData: RESPAWN_MAP });
    try {
      env.reset(7);
      expect((env as any).physics.respawnEnabled).toBe(true);
      teleportOob(env, 0);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.info.opponentsAlive).toBe(1);
      expect(r.reward).toBeCloseTo(-1.001, 3);
      expect(r.done).toBe(false);
      expect(r.info.terminated).toBe(false);
      expect(r.observation.playerX).toBeGreaterThan(1000);
      const cont = env.step(0);
      expect(cont.done).toBe(false);
      expect(cont.info.terminated).toBe(false);
      expect(cont.info.aiAlive).toBe(true);
      expectAtSpawn({ x: cont.observation.playerX, y: cont.observation.playerY }, -200, -100);
    } finally {
      env.close();
    }
  });

  it('explicit respawnEnabled config: AI OOB death is observable too', () => {
    const env = makeEnv({
      mapData: { ...RESPAWN_MAP, settings: {} },
      respawnEnabled: true,
    });
    try {
      env.reset(7);
      expect((env as any).physics.respawnEnabled).toBe(true);
      teleportOob(env, 0);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.reward).toBeCloseTo(-1.001, 3);
      expect(r.done).toBe(false);
      expect(r.info.terminated).toBe(false);
      const cont = env.step(0);
      expect(cont.info.aiAlive).toBe(true);
      expectAtSpawn({ x: cont.observation.playerX, y: cont.observation.playerY }, -200, -100);
    } finally {
      env.close();
    }
  });

  it('opponent OOB death fires killReward and continues', () => {
    const env = makeEnv({ mapData: RESPAWN_MAP });
    try {
      env.reset(7);
      teleportOob(env, 1);
      const r = env.step(0);
      expect(r.info.opponentsAlive).toBe(0);
      expect(r.info.aiAlive).toBe(true);
      expect(r.reward).toBeCloseTo(0.999, 3);
      expect(r.done).toBe(false);
      expect(r.info.terminated).toBe(false);
      expect(r.observation.opponents[0].alive).toBe(false);
      const cont = env.step(0);
      expect(cont.done).toBe(false);
      expect(cont.info.opponentsAlive).toBe(1);
      expect(cont.observation.opponents[0].alive).toBe(true);
      expectAtSpawn(cont.observation.opponents[0], 200, -100);
    } finally {
      env.close();
    }
  });

  it('lethal-collision death (type 1) on a respawn map is observable and rewarded', () => {
    const lethalMap: MapDef = {
      name: 'lethal-respawn-map',
      spawnPoints: { team_blue: { x: -200, y: -100 }, team_red: { x: 200, y: -100 } },
      bodies: [{ name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true }],
      settings: { re: true },
    };
    const env = makeEnv({ mapData: lethalMap, numOpponents: 0 });
    try {
      env.reset(7);
      const physics: any = (env as any).physics;
      physics.playerBodies.get(0).SetXForm(new (require('box2d').b2Vec2)(0, 0), 0);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.reward).toBeCloseTo(-1.001, 3);
      expect(r.done).toBe(false);
      expect(r.info.terminated).toBe(false);
      const cont = env.step(0);
      expect(cont.info.aiAlive).toBe(true);
      expectAtSpawn({ x: cont.observation.playerX, y: cont.observation.playerY }, -200, -100);
    } finally {
      env.close();
    }
  });

  it('control: without respawn the same death terminates (unchanged behavior)', () => {
    const env = makeEnv({ mapData: { ...RESPAWN_MAP, settings: {} } });
    try {
      env.reset(7);
      expect((env as any).physics.respawnEnabled).toBe(false);
      teleportOob(env, 0);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.reward).toBeCloseTo(-1.001, 3);
      expect(r.done).toBe(true);
      expect(r.info.terminated).toBe(true);
    } finally {
      env.close();
    }
  });

  it('an invalid (OOB) spawn point with respawn enabled still terminates (permanent detach)', () => {
    // The AI spawns 900 map units from the origin, beyond the 850-unit
    // death circle: the respawn guard detaches it immediately instead of
    // deferring, so this death must remain a terminating permanent death.
    const oobSpawnMap: MapDef = {
      name: 'respawn-invalid-spawn-map',
      spawnPoints: { team_blue: { x: 900, y: 0 }, team_red: { x: 200, y: -100 } },
      bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
      settings: { re: true },
    };
    const env = makeEnv({ mapData: oobSpawnMap });
    try {
      env.reset(7);
      expect((env as any).physics.respawnEnabled).toBe(true);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.reward).toBeCloseTo(-1.001, 3);
      expect(r.done).toBe(true);
      expect(r.info.terminated).toBe(true);
    } finally {
      env.close();
    }
  });

  it('cap-zone eliminations (type 3) on a respawn map still terminate', () => {
    const env = makeEnv({ mapData: RESPAWN_MAP });
    try {
      env.reset(7);
      const physics: any = (env as any).physics;
      physics.playerAlive.set(0, false);
      physics.playerDeathType.set(0, 3);
      const r = env.step(0);
      expect(r.info.aiAlive).toBe(false);
      expect(r.done).toBe(true);
      expect(r.info.terminated).toBe(true);
      expect(r.reward).toBeCloseTo(-0.001, 3);
    } finally {
      env.close();
    }
  });
});

describe('respawn happens on the following tick (issue #339 fix semantics)', () => {
  it('the death is observable on the death tick; the disc returns to spawn on the next tick', () => {
    const engine = new PhysicsEngine({ respawnEnabled: true });
    try {
      engine.addPlayer(0, -200, -100);
      const anyEng: any = engine;
      anyEng.playerBodies.get(0).SetXForm(new (require('box2d').b2Vec2)(OOB_WORLD_X, 0), 0);

      engine.tick();
      // Death tick: alive=false, deathType=4, body still present (queued).
      expect(engine.getPlayerState(0).alive).toBe(false);
      expect(engine.getPlayerState(0).deathType).toBe(4);
      expect(anyEng.playerBodies.has(0)).toBe(true);
      expect(engine.isPendingRespawn(0)).toBe(true);

      // Following tick: respawned at the spawn, alive, deathType cleared,
      // grapple cleared. One tick of gravity drift (the test arena has no
      // floor under the spawn) can pull the disc slightly below the spawn
      // point, so assert it is back at the spawn region — not at the
      // death spot (6000, 0).
      engine.tick();
      const st = engine.getPlayerState(0);
      expect(st.alive).toBe(true);
      expect(st.deathType).toBe(0);
      expect(engine.isPendingRespawn(0)).toBe(false);
      expectAtSpawn(st, -200, -100);
      expect(Math.abs(st.velX)).toBeLessThan(1);
      expect(engine.hasGrappleJoint(0)).toBe(false);
    } finally {
      engine.destroy();
    }
  });

  it('cap-zone eliminations (death type 3) stay permanent even with the delayed respawn', () => {
    const engine = new PhysicsEngine({ respawnEnabled: true });
    try {
      engine.addPlayer(0, 0, 0);
      const anyEng: any = engine;
      anyEng.playerAlive.set(0, false);
      anyEng.playerDeathType.set(0, 3);
      engine.tick();
      engine.tick();
      expect(engine.getPlayerState(0).alive).toBe(false);
      expect(engine.getPlayerState(0).deathType).toBe(3);
      expect(anyEng.playerBodies.has(0)).toBe(false);
      expect(engine.isPendingRespawn(0)).toBe(false);
    } finally {
      engine.destroy();
    }
  });
});

describe('inputs are honored on the respawn tick (issue #409)', () => {
  it('CONTROL: while alive, up changes velocity vs no-op', () => {
    const upEnv = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    const noopEnv = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    try {
      upEnv.reset(7);
      noopEnv.reset(7);
      const up = upEnv.step(ACTION_UP);
      const noop = noopEnv.step(0);
      expect(up.info.aiAlive).toBe(true);
      expect(noop.info.aiAlive).toBe(true);
      expect(up.observation.playerVelY).not.toBe(noop.observation.playerVelY);
    } finally {
      upEnv.close();
      noopEnv.close();
    }
  });

  it('DEFECT: on the respawn tick, up must change velocity vs no-op', () => {
    // Death tick (no-op) on both envs; the FOLLOWING step is the respawn
    // tick — the disc is visible at its spawn there, so the action sent
    // for that tick must reach its body (#409). Pre-fix, the alive-guard
    // in applyInput dropped it because playerAlive was still false during
    // step()'s input phase.
    const upEnv = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    const noopEnv = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    try {
      upEnv.reset(7);
      teleportOob(upEnv, 0);
      expect(upEnv.step(0).info.aiAlive).toBe(false);
      const respawnUp = upEnv.step(ACTION_UP);

      noopEnv.reset(7);
      teleportOob(noopEnv, 0);
      expect(noopEnv.step(0).info.aiAlive).toBe(false);
      const respawnNoop = noopEnv.step(0);

      expect(respawnUp.info.aiAlive).toBe(true);
      expect(respawnNoop.info.aiAlive).toBe(true);
      expect(respawnUp.observation.playerVelY).not.toBe(respawnNoop.observation.playerVelY);
      expect(respawnUp.observation.playerY).toBeLessThan(respawnNoop.observation.playerY);
    } finally {
      upEnv.close();
      noopEnv.close();
    }
  });

  it('a moving action held after an OOB death carries the respawned disc', () => {
    const moving = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    const idle = makeEnv({ mapData: RESPAWN_MAP, frameSkip: 1 });
    try {
      moving.reset(7);
      teleportOob(moving, 0);
      expect(moving.step(0).info.aiAlive).toBe(false);
      let lastMoving = moving.step(0); // respawn tick first...
      for (let i = 1; i < 10; i++) lastMoving = moving.step(ACTION_UP);

      idle.reset(7);
      teleportOob(idle, 0);
      expect(idle.step(0).info.aiAlive).toBe(false);
      let lastIdle = idle.step(0);
      for (let i = 1; i < 10; i++) lastIdle = idle.step(0);

      expect(lastMoving.info.aiAlive).toBe(true);
      expect(lastIdle.info.aiAlive).toBe(true);
      expect(lastMoving.observation.playerY).toBeLessThan(lastIdle.observation.playerY - 3);
    } finally {
      moving.close();
      idle.close();
    }
  });
});

describe('worker transports surface respawn deaths (issue #339)', () => {
  // The AI/opponent spawns directly inside a lethal fixture (a valid spawn
  // inside the OOB circle), so it dies by lethal collision (death type 1)
  // on the very first tick while respawning is enabled — the respawn path
  // the bug used to swallow. A spawn-side OOB detach would surface the
  // death even before the fix; only the respawn path erases it. The first
  // step's contract is identical whether the respawn subsequently loops or
  // detaches, so the assertions stay valid under the separate #351 fix.
  const aiDeathMap: MapDef = {
    name: 'respawn_ai_death_tick1',
    spawnPoints: { team_blue: { x: 0, y: 0 }, team_red: { x: 200, y: -100 } },
    bodies: [{ name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true }],
    settings: { re: true },
  };

  const oppDeathMap: MapDef = {
    name: 'respawn_opp_death_tick1',
    spawnPoints: { team_blue: { x: -100, y: 0 }, team_red: { x: 0, y: 0 } },
    bodies: [{ name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true }],
    settings: { re: true },
  };

  const aiDeathConfig: EnvironmentConfig = {
    mapData: aiDeathMap,
    numOpponents: 1,
    maxTicks: 500,
    seed: 42,
    randomOpponent: false,
  };

  const oppDeathConfig: EnvironmentConfig = {
    mapData: oppDeathMap,
    numOpponents: 1,
    maxTicks: 500,
    seed: 42,
    randomOpponent: false,
  };

  const runAiDeathThroughPool = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, aiDeathConfig, useSharedMemory);
      await pool.reset([42]);
      const [res] = await pool.step([0]);
      expect(res.done).toBe(false);
      expect(res.terminated).toBe(false);
      expect(res.info.terminated).toBe(false);
      expect(res.info.aiAlive).toBe(false);
      expect(res.info.opponentsAlive).toBe(1);
      expect(res.reward).toBeCloseTo(-1.001, 3);
    } finally {
      await pool.close();
    }
  };

  const runOppDeathThroughPool = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, oppDeathConfig, useSharedMemory);
      await pool.reset([42]);
      const [res] = await pool.step([0]);
      expect(res.done).toBe(false);
      expect(res.terminated).toBe(false);
      expect(res.info.terminated).toBe(false);
      expect(res.info.aiAlive).toBe(true);
      expect(res.info.opponentsAlive).toBe(0);
      expect(res.reward).toBeCloseTo(0.999, 3);
    } finally {
      await pool.close();
    }
  };

  it('message-passing mode: AI death fires deathPenalty and stays observable', async () => {
    await runAiDeathThroughPool(false);
  });

  it('shared-memory mode: AI death fires deathPenalty and stays observable', async () => {
    if (!WorkerPool.isSupported()) return;
    await runAiDeathThroughPool(true);
  });

  it('message-passing mode: opponent kill fires killReward and stays observable', async () => {
    await runOppDeathThroughPool(false);
  });

  it('shared-memory mode: opponent kill fires killReward and stays observable', async () => {
    if (!WorkerPool.isSupported()) return;
    await runOppDeathThroughPool(true);
  });

  // Issue #409: the respawn tick itself must honor the commanded action.
  // The AI spawns above a lethal floor (spawn point valid and clear of the
  // fixture, so the deferred respawn succeeds), falls onto it while stepping
  // no-op until its type-1 death is observed, then the NEXT step — the tick
  // in which the disc reappears at spawn — is driven with `up` vs no-op
  // across two otherwise identical pools. The respawned disc must move.
  const poolInputMap: MapDef = {
    name: 'respawn_pool_input_map',
    spawnPoints: { team_blue: { x: -200, y: -100 }, team_red: { x: 200, y: -100 } },
    bodies: [
      {
        name: 'lethalFloor',
        type: 'rect',
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        isLethal: true,
      },
    ],
    settings: { re: true },
  };

  const poolInputConfig: EnvironmentConfig = {
    mapData: poolInputMap,
    numOpponents: 0,
    maxTicks: 500,
    seed: 42,
    randomOpponent: false,
    frameSkip: 1,
  };

  // Upper-bound the fall duration from geometry and engine constants instead
  // of a magic step count (#409 review): the AI falls from its spawn onto the
  // lethal floor below, so the budget scales with distance/gravity and a stale
  // tuning change fails with an explanation instead of a bare alive assertion.
  // Exact px-space kinematics: Box2D integrates in world units (map px /
  // SCALE) with a per-tick velocity gain of GRAVITY_Y*DT world-units/s, so in
  // observation px the drop after n ticks is SCALE*GRAVITY_Y*DT^2*n(n+1)/2
  // (verified against the engine trajectory). Do NOT simplify SCALE*DT^2 to
  // DT — that identity only holds while SCALE === TPS (#409 review). Solve
  // the quadratic for n and add a small margin for the disc radius and
  // discretization.
  const lethalFloor = poolInputMap.bodies[0]!;
  const blueSpawn = poolInputMap.spawnPoints.team_blue!;
  const fallPx = lethalFloor.y - (lethalFloor.height ?? 0) / 2 - blueSpawn.y;
  const pxPerTickQuadratic = SCALE * GRAVITY_Y * DT * DT;
  const ticksToFloor = Math.ceil((-1 + Math.sqrt(1 + (8 * fallPx) / pxPerTickQuadratic)) / 2);
  const maxFallSteps = ticksToFloor + 4;

  const runToRespawnTickThenStep = async (useSharedMemory: boolean, respawnAction: number) => {
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, poolInputConfig, useSharedMemory);
      await pool.reset([42]);
      let res = (await pool.step([0]))[0];
      for (let i = 0; i < maxFallSteps && res.info.aiAlive; i++) {
        res = (await pool.step([0]))[0];
      }
      expect(res.done).toBe(false);
      expect(
        res.info.aiAlive,
        `AI did not reach the lethal floor within ${maxFallSteps} no-op steps ` +
          `(fall ${fallPx} px at gravity ${GRAVITY_Y}, scale ${SCALE}, ${TPS} tps) — ` +
          'the budget assumes the default physics tuning',
      ).toBe(false);
      const [respawnTick] = await pool.step([respawnAction]);
      return respawnTick;
    } finally {
      await pool.close();
    }
  };

  const expectRespawnTickResponds = (
    up: Awaited<ReturnType<typeof runToRespawnTickThenStep>>,
    noop: Awaited<ReturnType<typeof runToRespawnTickThenStep>>,
  ) => {
    expect(up.info.aiAlive).toBe(true);
    expect(noop.info.aiAlive).toBe(true);
    expect(up.observation.playerVelY).not.toBe(noop.observation.playerVelY);
    expect(up.observation.playerY).toBeLessThan(noop.observation.playerY);
  };

  it('message-passing mode: the respawn tick responds to the commanded action', async () => {
    expectRespawnTickResponds(
      await runToRespawnTickThenStep(false, ACTION_UP),
      await runToRespawnTickThenStep(false, 0),
    );
  });

  it('shared-memory mode: the respawn tick responds to the commanded action', async () => {
    if (!WorkerPool.isSupported()) return;
    expectRespawnTickResponds(await runToRespawnTickThenStep(true, ACTION_UP), await runToRespawnTickThenStep(true, 0));
  });
});
