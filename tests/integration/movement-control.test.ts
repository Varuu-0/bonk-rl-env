/**
 * movement-control.test.ts — Regression coverage for #234
 *
 * The verified mass-1 disc fixture (#212) plus the native §35.5 movement-force
 * base left a pure "up" input unable to overcome gravity (net Δv = +8·dt
 * downward), so the RL "up" bit only slowed the fall. The movement force is
 * now applied at a constant per-tick base `MOVE_FORCE` (×0.7 for heavy); the
 * §35.5 radius^2 scale is the disc mass ratio, which the mass-1 fixture pins
 * to 1 for every disc radius, so the applied force is radius/ppm-invariant and
 * no per-map `ppm` factor is applied.
 *
 * These tests pin, at the default configuration:
 * 1. a pure "up" input produces upward acceleration (playerY decreases);
 * 2. a pure "down" input accelerates the fall beyond idle gravity;
 * 3. up+heavy still ascends (0.7 × MOVE_FORCE > gravity);
 * 4. up ascends at non-default map `ppm` values (radius-invariance);
 * 5. the same holds through the full environment `step(4)` / `step(8)` path.
 */

import { describe, it, expect } from 'vitest';
import { PhysicsEngine, MapDef } from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy, UP_INPUT, DOWN_INPUT, EMPTY_INPUT } from '../utils/test-helpers';

const TICKS = 25;

/** Empty arena: only the player disc, no platforms (default gravity 20,
 * default ppm 12, verified mass-1 fixture). */
function makeBoxEngine(ppm?: number): PhysicsEngine {
  const engine = new PhysicsEngine();
  if (ppm !== undefined) {
    engine.setPpm(ppm);
  }
  engine.addPlayer(0, 0, 0);
  return engine;
}

function runInput(engine: PhysicsEngine, input: typeof UP_INPUT, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    engine.applyInput(0, input);
    engine.tick();
  }
  return engine.getPlayerState(0);
}

describe('Movement control (issue #234)', () => {
  it('pure up input moves the player upward at the default config', () => {
    const engine = makeBoxEngine();
    const state = runInput(engine, UP_INPUT, TICKS);
    // Spawned at y=0: net upward acceleration must drive y below spawn and
    // produce a negative (upward) velocity.
    expect(state.y).toBeLessThan(0);
    expect(state.velY).toBeLessThan(0);
    expect(state.alive).toBe(true);
    safeDestroy(engine);
  });

  it('up rises while idle falls, and down accelerates the fall', () => {
    const upEngine = makeBoxEngine();
    const downEngine = makeBoxEngine();
    const idleEngine = makeBoxEngine();

    const up = runInput(upEngine, UP_INPUT, TICKS);
    const down = runInput(downEngine, DOWN_INPUT, TICKS);
    const idle = runInput(idleEngine, EMPTY_INPUT, TICKS);

    // Up produces upward motion; idle gravity pulls downward; down beats idle.
    expect(up.y).toBeLessThan(0);
    expect(idle.y).toBeGreaterThan(0);
    expect(down.y).toBeGreaterThan(idle.y);
    expect(up.velY).toBeLessThan(0);
    // Down accelerates the fall: downward velocity exceeds idle gravity.
    expect(idle.velY).toBeGreaterThan(0);
    expect(down.velY).toBeGreaterThan(idle.velY);
    safeDestroy(upEngine);
    safeDestroy(downEngine);
    safeDestroy(idleEngine);
  });

  it('up with heavy still ascends (0.7 x MOVE_FORCE beats gravity)', () => {
    const engine = makeBoxEngine();
    const heavyUp: typeof UP_INPUT = { ...UP_INPUT, heavy: true };
    const state = runInput(engine, heavyUp, 60);
    // Net up-acceleration with heavy is (−30·0.7 + 20) = −1 m/s²: the disc
    // must still rise, just more slowly than pure up.
    expect(state.y).toBeLessThan(0);
    expect(state.velY).toBeLessThan(0);
    expect(state.alive).toBe(true);
    safeDestroy(engine);
  });

  it('up ascends at non-default map ppm values (radius-invariance)', () => {
    // The native radius^2 scale is the disc mass ratio; the mass-1 fixture
    // pins it to 1 for any disc radius, so up must lift at any ppm.
    for (const ppm of [9, 15]) {
      const engine = makeBoxEngine(ppm);
      const state = runInput(engine, UP_INPUT, TICKS);
      expect(state.y, `ppm ${ppm}`).toBeLessThan(0);
      expect(state.velY, `ppm ${ppm}`).toBeLessThan(0);
      safeDestroy(engine);
    }
  });

  it('environment step(4)/step(8): up ascends and down falls faster (reproduction of #234)', () => {
    const mapData: MapDef = {
      name: 'movement-control',
      spawnPoints: {
        team_blue: { x: 0, y: 0 },
        team_red: { x: 0, y: 200 },
      },
      bodies: [],
    };

    const envUp = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 1 });
    envUp.reset(1);
    const spawnY = envUp.step(0).observation.playerY;
    let upY = spawnY;
    for (let i = 0; i < TICKS; i++) upY = envUp.step(4).observation.playerY; // action 4 = up (bit 2)
    expect(upY).toBeLessThan(spawnY);
    envUp.close();

    const envDown = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 1 });
    envDown.reset(1);
    let downY = envDown.step(0).observation.playerY;
    for (let i = 0; i < TICKS; i++) downY = envDown.step(8).observation.playerY; // action 8 = down (bit 3)
    // Down must fall well past the spawn and further than up travels up.
    expect(downY).toBeGreaterThan(spawnY);
    expect(downY - spawnY).toBeGreaterThan(spawnY - upY);
    envDown.close();
  });
});
