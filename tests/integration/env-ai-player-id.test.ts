import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy, EMPTY_INPUT } from '../utils/test-helpers';
import type { MapDef } from '../../src/core/physics-engine';

const bundledWdbMapPath = path.resolve(__dirname, '..', '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');

describe('Environment aiPlayerId wiring (#221)', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = null;
    }
  });

  it('aiPlayerId 1 makes the agent observe player 1 (blue spawn) while player 0 is the opponent (red spawn)', () => {
    expect(fs.existsSync(bundledWdbMapPath)).toBe(true);
    env = new BonkEnvironment({ aiPlayerId: 1, numOpponents: 1, maxTicks: 100, randomOpponent: false });
    const obs = env.reset();

// The shipped WDB default map's blue AI spawn is (-100, 212.5) and the
    // red opponent spawn is (100, 212.5).
    expect(obs.opponents).toHaveLength(1);
    expect(obs.playerX).toBeCloseTo(-100, 6);
    expect(obs.playerY).toBeCloseTo(212.5, 6);
    expect(obs.opponents[0].x).toBeCloseTo(100, 6);
    expect(obs.opponents[0].y).toBeCloseTo(212.5, 6);

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

  it('keeps the AI disc on the g1 collision category whatever its slot', () => {
    // A g1-only barrier between the blue and red spawns: the AI (slot 1 here)
    // must still be blocked (AI disc = category g1), or the slot-based
    // category rule would let it pass as g2 (#221).
    const mapData: MapDef = {
      name: 'g1-barrier',
      spawnPoints: {
        team_blue: { x: -150, y: 0 },
        team_red: { x: 250, y: 0 },
      },
      bodies: [
        { name: 'barrier', type: 'rect', x: 0, y: 50, width: 20, height: 1200, static: true, collides: { g1: true, g2: false, g3: false, g4: false } },
        { name: 'floor', type: 'rect', x: 0, y: 500, width: 1000, height: 40, static: true },
      ],
    };
    env = new BonkEnvironment({ aiPlayerId: 1, numOpponents: 1, mapData, maxTicks: 400, randomOpponent: false });
    env.reset();
    for (let i = 0; i < 150; i++) {
      env.step({ ...EMPTY_INPUT, right: true });
    }
    const final = env.step(EMPTY_INPUT).observation;
    expect(final.playerX).toBeLessThan(0);
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
