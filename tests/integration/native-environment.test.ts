import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BonkEnvironment } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';

const MAP_PATH = path.join(process.cwd(), 'maps', 'training-platform.json');
const map = (): NativeMap => JSON.parse(readFileSync(MAP_PATH, 'utf8')) as NativeMap;
const base = (overrides: Record<string, unknown> = {}) => ({
  mapData: map(),
  numOpponents: 1,
  seed: 1,
  randomOpponent: false,
  oppGrappleProb: 0,
  maxTicks: 500,
  ...overrides,
});

describe('public raw-native static/dynamic Classic environment', () => {
  it('converts authored spawns to public pixels and agrees with fast observations', () => {
    const env = new BonkEnvironment(base());
    try {
      const obs = env.reset();
      const session = (env as any).nativeSession;
      const native = session.getState().discs[0];
      expect([map().spawns[0].priority, map().spawns[1].priority]).toEqual([5, 5]);
      expect([obs.playerX, obs.playerY]).toEqual([150, -30]);
      expect([obs.playerVelX, obs.playerVelY]).toEqual([0, 0]);
      expect(obs.playerX).toBe(native.x * 12 - 365);
      expect(obs.playerY).toBe(native.y * 12 - 250);
      expect([obs.arenaHalfWidth, obs.arenaHalfHeight, obs.tick]).toEqual([365, 250, 0]);
      expect(Array.from(env.getObservationFast())).toEqual([
        150, -30, 0, 0, 0, 0, 0, -150, -30, 0, 0, 0, 1, 365, 250, 0,
      ]);
    } finally {
      env.close();
    }
  });

  it('is deterministic under reset and advances active native movement/heavy state', () => {
    const env = new BonkEnvironment(base());
    const replay = new BonkEnvironment(base());
    try {
      const initial = env.reset();
      // Call 91 publishes active but does not solve; call 92 is the first
      // solver-active call and must receive the movement input.
      const action = (i: number) => (i < 91 ? 0 : (i - 91) % 2 === 0 ? 2 : 16);
      const trace: unknown[] = [];
      for (let i = 0; i < 130; i++) trace.push(env.step(action(i)));
      const other: unknown[] = [];
      replay.reset();
      for (let i = 0; i < 130; i++) other.push(replay.step(action(i)));
      expect(trace).toEqual(other);
      const active = trace[90] as any;
      expect(active.info.nativePhase).toBe('active');
      expect(active.observation.tick).toBe(91);
      expect(active.observation.playerVelX).toBe(0);
      const moving = trace[91] as any;
      expect(moving.observation.tick).toBe(92);
      expect(moving.observation.playerVelX).toBeGreaterThan(0);
      expect((trace[92] as any).observation.playerIsHeavy).toBe(true);
      expect(env.reset(1)).toEqual(initial);
      expect(env.reset(1)).toEqual(replay.reset(1));
    } finally {
      env.close();
      replay.close();
    }
  });

  it('truncates, freezes terminal holds, resets, and rejects closed use', () => {
    const env = new BonkEnvironment(base({ maxTicks: 2, frameSkip: 3, numOpponents: 0 }));
    try {
      env.reset();
      expect(env.step(0).done).toBe(false);
      const end = env.step(0);
      expect(end).toMatchObject({ done: true, truncated: true, terminated: false });
      expect(end.info.tick).toBe(2);
      expect(end.observation.tick).toBe(2);
      expect(end.info.terminal_observation).toEqual(end.observation);
      expect(env.isTerminalHoldActive()).toBe(true);
      const hold = env.step(0);
      expect(hold).toMatchObject({ done: true, truncated: true, terminated: false, reward: 0 });
      expect(hold.info.tick).toBe(2);
      expect(hold.observation.tick).toBe(2);
      expect(env.reset().tick).toBe(0);
      env.close();
      env.close();
      expect(() => env.reset()).toThrow('closed');
      expect(() => env.step(0)).toThrow('closed');
    } finally {
      env.close();
    }
  });

  it('rejects native/legacy tuning collisions and unsupported grapple before simulation', () => {
    for (const config of [
      { ppm: 12 },
      { physics: { gravityY: 20 } },
      { arena: { boundsMargin: 5 } },
      { player: { moveForce: 30 } },
      { noCollide: true },
      { flipped: true },
      { respawnEnabled: true },
      { oppGrappleProb: 0.05 },
    ])
      expect(() => new BonkEnvironment(base(config))).toThrow(/native|Native/);
    const env = new BonkEnvironment(base());
    try {
      expect(() => env.step(32)).toThrow(/Unsupported native Classic action/);
      expect((env as any).nativeSnapshot.tick).toBe(0);
      expect(() =>
        env.step({ left: false, right: false, up: false, down: false, heavy: false, grapple: true }),
      ).toThrow(/grapple/);
    } finally {
      env.close();
    }
  });

  it('presents native lethal deaths with outgoing control and angular state', () => {
    const lethal = map();
    lethal.physics.fixtures[0]!.d = true;
    lethal.spawns.forEach((spawn) => {
      spawn.y = -20;
    });
    const env = new BonkEnvironment(base({ mapData: lethal, countdownTicks: 5 }));
    try {
      env.reset();
      let end: any;
      for (let tick = 0; tick < 20; tick++) {
        end = env.step(16);
        if (end.done) break;
      }
      expect(end.done).toBe(true);
      expect(end.terminated).toBe(true);
      expect(end.observation.playerIsHeavy).toBe(true);
      expect(end.observation.opponents[0].isHeavy).toBe(false);
      expect(end.observation.opponents[0].alive).toBe(false);
      const death = (env as any).nativeSession
        .getState()
        .discDeaths.find((entry: any) => entry.i === 0 && entry.f === 0);
      expect(death).toBeDefined();
      expect(end.observation.playerX).toBe(death.x * 12 - 365);
      expect(end.observation.playerY).toBe(death.y * 12 - 250);
      expect(end.observation.playerVelX).toBe(death.xv * 12);
      expect(end.observation.playerVelY).toBe(death.yv * 12);
      expect(end.info.aiAlive).toBe(false);
      expect(end.info.nativeRoundTick).toBe(end.observation.tick);
      expect(end.info.terminal_observation).toEqual(end.observation);
      expect(env.getObservationFast()[6]).toBe(1);
    } finally {
      env.close();
    }
  });

  it('routes supported dynamic maps through the unified native session', () => {
    const dynamic = map();
    dynamic.physics.bodies[0]!.s.type = 'd';
    const env = new BonkEnvironment(base({ mapData: dynamic }));
    try {
      const initial = env.reset();
      expect(initial.tick).toBe(0);
      expect((env as any).nativeSession.getState().physics).toBeDefined();
      expect(env.getObservationFast()[15]).toBe(0);
    } finally {
      env.close();
    }
  });

  it('simulates active force zones through the dynamic backend and rejects other unsupported mechanics', () => {
    const force = map();
    force.physics.bodies[0]!.fz.on = true;
    // fz.on is simulated by the unified dynamic world (original :4940-4995).
    const env = new BonkEnvironment(base({ mapData: force }));
    try {
      env.reset(1);
      const result = env.step(0);
      expect(result.info.native).toBe(true);
    } finally {
      env.close();
    }
    const cap = map();
    cap.capZones = [{ i: 0, ty: 1, l: 3 }] as any;
    expect(() => new BonkEnvironment(base({ mapData: cap }))).toThrow();
  });
});
