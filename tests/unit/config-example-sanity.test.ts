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

  it('solverIterations is 2', () => {
    expect(config.physics.solverIterations).toBe(2);
  });

  it('player friction is 0.001337 and restitution is 0.95 (verified live fixture)', () => {
    expect(config.player.friction).toBe(0.001337);
    expect(config.player.restitution).toBe(0.95);
  });

  it('player moveForce is 30 (heavy-lift threshold 20/0.7 rounded up, issue #234)', () => {
    expect(config.player.moveForce).toBe(30.0);
  });

  it('no stale player density key (density is derived as 1/(pi*r^2))', () => {
    expect(config.player.density).toBeUndefined();
  });

  it('documents grapple maxDistance as the 10-unit native target window', () => {
    expect(config.grapple.maxDistance).toBe(10.0);
    expect(config.grapple._doc_maxDistance).toContain('not consumed');
  });

  it('grapple joint tuning matches verified swingF=2 / swingD=0', () => {
    expect(config.grapple.jointFrequencyHz).toBe(2.0);
    expect(config.grapple.jointDampingRatio).toBe(0.0);
    expect(config.grapple.slingshotImpulse).toBeUndefined();
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
