/**
 * config-example-sanity.test.ts — Pins the user-facing config.example.json to
 * the verified native bonk.io physics values so a regression to the old
 * stale values (gravity 10, force 8, etc.) is caught.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const configPath = path.resolve(__dirname, '..', '..', 'config.example.json');
const raw = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(raw);

describe('config.example.json verified physics values', () => {
  it('gravityY is 20', () => {
    expect(config.physics.gravityY).toBe(20.0);
  });

  it('solverIterations is 2 and positionIterations is 6', () => {
    expect(config.physics.solverIterations).toBe(2);
    expect(config.physics.positionIterations).toBe(6);
  });

  it('player friction is 0 and restitution is 0.8', () => {
    expect(config.player.friction).toBe(0.0);
    expect(config.player.restitution).toBe(0.8);
  });

  it('player moveForce is 12', () => {
    expect(config.player.moveForce).toBe(12.0);
  });

  it('grapple maxDistance is 500 map units', () => {
    expect(config.grapple.maxDistance).toBe(500.0);
  });

  it('heavyMassMultiplier is a force multiplier of 0.7 (not mass)', () => {
    expect(config.player.heavyMassMultiplier).toBe(0.7);
  });

  it('player radius is documented as ppm-derived (kept for compat)', () => {
    // The engine derives the disc radius from the map ppm (default 12); the
    // config value is retained only for backward compatibility.
    expect(typeof config.player.radius).toBe('number');
  });
});
