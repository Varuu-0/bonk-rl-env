import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy, EMPTY_INPUT } from '../utils/test-helpers';

describe('Environment aiPlayerId wiring (#221)', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = null;
    }
  });

  it('aiPlayerId 1 makes the agent observe player 1 (blue spawn) while player 0 is the opponent (red spawn)', () => {
    env = new BonkEnvironment({ aiPlayerId: 1, numOpponents: 1, maxTicks: 100, randomOpponent: false });
    const obs = env.reset();

    // Default_Box blue AI spawn is (-200, -100) and the red opponent spawn
    // is (200, -100).
    expect(obs.opponents).toHaveLength(1);
    expect(obs.playerX).toBeCloseTo(-200, 6);
    expect(obs.playerY).toBeCloseTo(-100, 6);
    expect(obs.opponents[0].x).toBeCloseTo(200, 6);
    expect(obs.opponents[0].y).toBeCloseTo(-100, 6);

    // The observation's player fields must be the physics state of slot 1
    // (the configured AI slot), NOT the hardcoded slot 0. With the buggy
    // behavior slot 1 held the red-spawned opponent, so this fails loudly.
    const physics = (env as any).physics;
    const aiSlotState = physics.getPlayerState(1);
    expect(obs.playerX).toBe(aiSlotState.x);
    expect(obs.playerY).toBe(aiSlotState.y);
    const oppSlotState = physics.getPlayerState(0);
    expect(obs.opponents[0].x).toBe(oppSlotState.x);
    expect(obs.opponents[0].y).toBe(oppSlotState.y);

    // Inputs also land on the configured slot: a held right input moves the
    // slot-1 AI disc.
    const before = physics.getPlayerState(1);
    env.step({ ...EMPTY_INPUT, right: true });
    const after = physics.getPlayerState(1);
    expect(after.velX).toBeGreaterThan(before.velX);
    expect((env as any).aiPlayerId).toBe(1);
    expect((env as any).opponentIds).toEqual([0]);
  });

  it('out-of-range aiPlayerId fails loudly instead of being silently ignored', () => {
    // With 1 opponent the spawned slots are 0..1, so slot 2 cannot be the AI.
    expect(() => new BonkEnvironment({ aiPlayerId: 2, numOpponents: 1, maxTicks: 100 }))
      .toThrow(/aiPlayerId 2/);
  });

  it('non-integer aiPlayerId fails loudly', () => {
    expect(() => new BonkEnvironment({ aiPlayerId: 1.5 as any, numOpponents: 1, maxTicks: 100 }))
      .toThrow(/aiPlayerId 1.5/);
  });
});