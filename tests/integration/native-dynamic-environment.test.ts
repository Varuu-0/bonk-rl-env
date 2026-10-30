import { describe, expect, it } from 'vitest';
import { BonkEnvironment, type Observation, type StepResult } from '../../src/core/environment';

// Reuse the exact dynamic fixtures from the pinned-original differential. These
// tests deliberately exercise only the public environment surface, not its session.
const { publicConfig } = require('../../validation/native/compare-native-dynamic-environment.cjs') as {
  publicConfig: (name: string, overrides?: Record<string, unknown>) => Record<string, unknown>;
};

function fastObservation(observation: Observation): number[] {
  return [
    observation.playerX,
    observation.playerY,
    observation.playerVelX,
    observation.playerVelY,
    observation.playerAngle,
    observation.playerAngularVel,
    observation.playerIsHeavy ? 1 : 0,
    observation.opponents[0]!.x,
    observation.opponents[0]!.y,
    observation.opponents[0]!.velX,
    observation.opponents[0]!.velY,
    observation.opponents[0]!.isHeavy ? 1 : 0,
    observation.opponents[0]!.alive ? 1 : 0,
    observation.arenaHalfWidth,
    observation.arenaHalfHeight,
    observation.tick,
  ].map(Math.fround);
}

function expectFast(env: BonkEnvironment, observation: Observation): void {
  expect(Array.from(env.getObservationFast())).toEqual(fastObservation(observation));
}

describe('public dynamic native environment', () => {
  it('resets deterministically, observes the five-tick countdown, and advances the moving map', () => {
    const env = new BonkEnvironment(publicConfig('moving-platform'));
    const replay = new BonkEnvironment(publicConfig('moving-platform'));
    try {
      const initial = env.reset();
      expect(initial).toMatchObject({ playerY: -30, tick: 0 });
      expect([initial.playerX, initial.opponents[0]!.x].sort((a, b) => a - b)).toEqual([-50, 50]);
      expect(env.reset()).toEqual(initial);
      expect(replay.reset()).toEqual(initial);
      const trace: StepResult[] = [];
      const other: StepResult[] = [];
      for (let tick = 0; tick < 20; tick++) {
        trace.push(env.step(2));
        other.push(replay.step(2));
      }
      expect(trace).toEqual(other);
      expect(trace.slice(0, 5).every((step) => step.info.nativePhase === 'countdown')).toBe(true);
      expect(trace[5]!.info).toMatchObject({ nativePhase: 'active', nativeRoundTick: 6 });
      expect(trace[5]!.observation.playerX).toBe(initial.playerX);
      expect(trace[6]!.observation.playerX).not.toBe(initial.playerX);
      expect(Math.abs(trace[6]!.observation.playerVelX)).toBeGreaterThan(0);
      expectFast(env, trace.at(-1)!.observation);
      expect(env.reset()).toEqual(initial);
    } finally {
      env.close();
      replay.close();
    }
  });

  it('publishes capture progress, removed-player presentation, and a frozen elimination', () => {
    const env = new BonkEnvironment(publicConfig('timed-capture'));
    try {
      const initial = env.reset();
      expect(env.getNativeCapZoneCapacity()).toBe(1);
      expect(env.getStaticInfo()).toMatchObject({
        native: true,
        nativeMode: 'b',
        nativeCapZoneCapacity: 1,
      });
      expect(env.getStaticInfo()).not.toHaveProperty('nativeCapZones');
      let progress: StepResult | undefined;
      let end: StepResult | undefined;
      for (let tick = 1; tick <= 70; tick++) {
        const step = env.step(4);
        expect(step.info).not.toHaveProperty('nativeCapZoneCapacity');
        expect(step.info.capZones).toEqual([]);
        if (step.info.nativeCapZones[0].p > 0) progress ??= step;
        if (step.done) {
          end = step;
          break;
        }
      }
      expect(progress!.info.nativeCapZones[0]).toMatchObject({ ty: 1, l: 30, o: 2, ot: 2 });
      expect(progress!.info.nativeCapZones[0].p).toBeGreaterThan(0);
      expect(progress!.info.nativePhase).toBe('active');
      expect(end).toBeDefined();
      expect(end!.observation.tick).toBe(57);
      expect(end!).toMatchObject({ done: true, truncated: false, terminated: true });
      expect(end!.info).toMatchObject({
        aiAlive: false,
        opponentsAlive: 1,
        terminated: true,
        scoreBlue: 0,
        scoreRed: 1,
        nativePhase: 'round-result',
        nativeCapZones: [{ ty: 1, p: 30, l: 30, i: 0, o: 2, ot: 2, f: 0 }],
      });
      // Capture removed the original disc; retain its complete outgoing view.
      expect(end!.observation).toMatchObject({
        playerX: -300,
        playerY: -100,
        playerVelX: 0,
        playerVelY: 0,
      });
      expect(end!.observation.opponents[0]!.alive).toBe(true);
      expect(end!.info.terminal_observation).toEqual(end!.observation);
      expectFast(env, end!.observation);
      // FS1 resets its coalescing counter immediately; terminal freezing is
      // observable in every returned hold result, not this window predicate.
      expect(env.isTerminalHoldActive()).toBe(false);
      for (let hold = 0; hold < 10; hold++) {
        const frozen = env.step(0);
        expect(frozen).toMatchObject({ done: true, truncated: false, terminated: true, reward: 0 });
        expect(frozen.observation).toEqual(end!.observation);
        expect(frozen.info).toEqual(end!.info);
        expect(frozen.info.terminal_observation).toBe(frozen.observation);
        expectFast(env, frozen.observation);
      }
      expect(env.reset()).toEqual(initial);
      expect(env.isTerminalHoldActive()).toBe(false);
    } finally {
      env.close();
    }
  });

  it('exposes instant-goal capture state and the red score without reviving a removed disc', () => {
    const env = new BonkEnvironment(publicConfig('instant-goal'));
    try {
      let end: StepResult | undefined;
      for (let tick = 1; tick <= 12; tick++) {
        const step = env.step(0);
        if (step.done) {
          end = step;
          break;
        }
      }
      expect(end!.observation.tick).toBe(7);
      expect(end!).toMatchObject({ done: true, terminated: true, truncated: false });
      expect(end!.info).toMatchObject({
        aiAlive: false,
        opponentsAlive: 1,
        scoreBlue: 0,
        scoreRed: 1,
        nativePhase: 'round-result',
        nativeRoundTick: 7,
        nativeCapZones: [{ ty: 2, p: 0, l: 300, i: 0, o: -1, ot: -1, f: -1 }],
      });
      expect(end!.observation.playerX).toBe(-250);
      expect(end!.observation.playerY).not.toBe(-30);
      expect(end!.observation.playerVelY).not.toBe(0);
      expect(end!.info.terminal_observation).toEqual(end!.observation);
      expectFast(env, end!.observation);
      expect(env.step(0).observation).toEqual(end!.observation);
      expect(env.reset().tick).toBe(0);
    } finally {
      env.close();
    }
  });

  it.each(['lethal-moving-fixture', 'out-of-bounds'])(
    'presents %s death while native respawn leaves the episode running',
    (name) => {
      const env = new BonkEnvironment(publicConfig(name));
      try {
        const initial = env.reset();
        let death: StepResult | undefined;
        for (let tick = 0; tick < 20; tick++) {
          const step = env.step(0);
          expect(step.done).toBe(false);
          expect(step.terminated).toBe(false);
          if (!step.info.aiAlive || step.info.opponentsAlive === 0) {
            death = step;
            break;
          }
        }
        expect(death).toBeDefined();
        if (name === 'out-of-bounds') {
          expect(death!.observation.tick).toBe(1);
          expect(death!.info.aiAlive).toBe(true);
          expect(death!.info.opponentsAlive).toBe(0);
          expect(death!.observation.opponents[0]).toMatchObject({ x: 0, y: 249, velX: 0, velY: -200, alive: false });
          expect(death!.info.nativePhase).toBe('countdown');
        } else {
          expect(death!.observation.tick).toBe(7);
          expect(death!.observation.opponents[0]!.alive).toBe(false);
          expect(death!.observation.opponents[0]!.y).not.toBe(initial.opponents[0]!.y);
        }
        expectFast(env, death!.observation);
        const next = env.step(0);
        expect(next.done).toBe(false);
        expect(next.terminated).toBe(false);
        expect(next.info.aiAlive).toBe(true);
        expect(next.observation.tick).toBe(death!.observation.tick + 1);
        if (name === 'lethal-moving-fixture') {
          expect(next.observation.playerY).not.toBe(death!.observation.playerY);
        } else {
          expect(next.info.nativePhase).toBe('countdown');
        }
        expectFast(env, next.observation);
        expect(env.reset()).toEqual(initial);
      } finally {
        env.close();
      }
    },
  );

  it('retains a frameSkip3 action exactly like three frameSkip1 calls', () => {
    const config = publicConfig('moving-platform', { maxTicks: 40 });
    const held = new BonkEnvironment({ ...config, frameSkip: 3 });
    const explicit = new BonkEnvironment({ ...config, frameSkip: 1 });
    try {
      expect(held.reset()).toEqual(explicit.reset());
      for (let tick = 0; tick < 30; tick++) {
        const action = Math.floor(tick / 3) % 2 === 0 ? 2 : 1;
        // Opposite directions at non-boundary calls must not replace the held action.
        const actual = held.step(tick % 3 === 0 ? action : 3 - action);
        const expected = explicit.step(action);
        expect(actual.observation).toEqual(expected.observation);
        expect(actual.info).toEqual({ ...expected.info, frameSkip: 3 });
        expect(actual.done).toBe(expected.done);
        expect(actual.truncated).toBe(expected.truncated);
        expect(actual.terminated).toBe(expected.terminated);
        expectFast(held, actual.observation);
      }
    } finally {
      held.close();
      explicit.close();
    }
  });

  it('separates max-tick truncation from respawn and preserves its frozen hold', () => {
    const env = new BonkEnvironment(publicConfig('out-of-bounds', { maxTicks: 10 }));
    try {
      const initial = env.reset();
      let end: StepResult | undefined;
      for (let tick = 0; tick < 10; tick++) {
        const step = env.step(0);
        if (step.done) end = step;
      }
      expect(end).toBeDefined();
      expect(end!).toMatchObject({ done: true, truncated: true, terminated: false });
      expect(end!.observation.tick).toBe(10);
      expect(end!.info).toMatchObject({ tick: 10, terminated: false, frameSkip: 1 });
      expect(end!.info.terminal_observation).toEqual(end!.observation);
      const hold = env.step(0);
      expect(hold).toMatchObject({ done: true, truncated: true, terminated: false, reward: 0 });
      expect(hold.observation).toEqual(end!.observation);
      expect(hold.info).toEqual(end!.info);
      expectFast(env, hold.observation);
      expect(env.reset()).toEqual(initial);
    } finally {
      env.close();
    }
  });
});
