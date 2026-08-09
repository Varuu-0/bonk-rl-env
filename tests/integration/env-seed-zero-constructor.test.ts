import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

function trajectory(env: BonkEnvironment, steps: number): number[][] {
  const obs = env.reset();
  const out: number[][] = [[obs.playerX, obs.playerY, obs.playerVelX, obs.playerVelY]];
  for (let i = 0; i < steps; i++) {
    const r = env.step(0);
    out.push([
      r.observation.playerX,
      r.observation.playerY,
      r.observation.playerVelX,
      r.observation.playerVelY,
    ]);
  }
  return out;
}

describe('Constructor seed 0 determinism (#200)', () => {
  let envs: BonkEnvironment[] = [];

  afterEach(async () => {
    for (const env of envs) {
      await env.close();
    }
    envs = [];
  });

  it('two constructor-seeded-0 environments produce identical trajectories', () => {
    const a = new BonkEnvironment({ seed: 0, numOpponents: 1, maxTicks: 200 });
    const b = new BonkEnvironment({ seed: 0, numOpponents: 1, maxTicks: 200 });
    envs = [a, b];

    expect(trajectory(a, 60)).toEqual(trajectory(b, 60));
  });

  it('constructor seed 0 uses the same PRNG seeding as reset(0)', () => {
    const seeded0 = new BonkEnvironment({ seed: 0, numOpponents: 1, maxTicks: 200 });
    // Constructor picks a random seed here, but reset(0) reseeds to 0 exactly
    // like the seeded-0 constructor path must.
    const reseeded = new BonkEnvironment({ numOpponents: 1, maxTicks: 200 });
    reseeded.reset(0);
    envs = [seeded0, reseeded];

    expect(trajectory(seeded0, 60)).toEqual(trajectory(reseeded, 60));
  });
});
