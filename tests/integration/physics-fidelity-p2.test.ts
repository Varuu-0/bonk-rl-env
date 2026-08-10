import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';

/**
 * P2 — Native joint-model fidelity (DEOBFUSCATION §33.8).
 *
 * The engine's addJoint now constructs every native joint family: revolute
 * (rv), distance (d), prismatic (lpj/lsj/p), and gear (g), AND supports
 * ground-anchored joints (bodyB=-1) via a synthetic static ground body instead
 * of dropping them. These tests verify each family constructs without error and
 * that a prismatic joint actually constrains a dynamic body to its axis.
 */

function makeEngine(): PhysicsEngine {
  return new PhysicsEngine();
}

function makeBodyMap(e: PhysicsEngine): Map<string, any> {
  e.addBody({ name: 'plat_0', type: 'rect', x: 0, y: 100, width: 40, height: 10, static: true, density: 0 } as any);
  e.addBody({ name: 'plat_1', type: 'rect', x: 100, y: 100, width: 40, height: 10, static: true, density: 0 } as any);
  e.addBody({ name: 'cart_0', type: 'rect', x: 0, y: 150, width: 20, height: 20, static: false, density: 1 } as any);
  e.addBody({ name: 'cart_1', type: 'rect', x: 100, y: 150, width: 20, height: 20, static: false, density: 1 } as any);
  return e.getBodyMap() as Map<string, any>;
}

/** Collect console.warn output during a callback, restoring the original after. */
function captureWarn(fn: () => void): string[] {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warnings.push(String(m));
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

describe('physics fidelity P2: joint model (DEOBFUSCATION §33.8)', () => {
  it('constructs a revolute (rv) joint with limits and motor', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'rv', name: 'j0', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, enableLimit: true, lowerAngle: -0.5, upperAngle: 0.5, enableMotor: true, motorSpeed: 5, maxMotorTorque: 10, collideConnected: false }, bm);
    });
    expect(warnings.filter(w => /unknown joint type/.test(w))).toHaveLength(0);
  });

  it('constructs a distance (d) joint', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'd', name: 'j1', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, anchorB: { x: 0, y: 140 }, frequencyHz: 4, dampingRatio: 0.5, length: 50, collideConnected: false }, bm);
    });
    expect(warnings.filter(w => /unknown joint type/.test(w))).toHaveLength(0);
  });

  it('constructs a prismatic (lpj) joint with limits, motor, and axis', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'lpj', name: 'j2', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, axis: { x: 1, y: 0 }, enableLimit: true, lowerTranslation: -50, upperTranslation: 50, enableMotor: true, motorSpeed: 10, maxMotorForce: 100, collideConnected: false }, bm);
    });
    expect(warnings.filter(w => /unknown joint type/.test(w))).toHaveLength(0);
  });

  it('supports a ground-anchored prismatic joint (bodyB=-1) without warning', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'lpj', name: 'ground_lpj', bodyA: 'cart_0', bodyB: '', isGround: true, anchorA: { x: 0, y: 150 }, axis: { x: 0, y: 1 }, enableLimit: true, lowerTranslation: -20, upperTranslation: 20, enableMotor: false, maxMotorForce: 0, collideConnected: false }, bm);
    });
    // Ground joints must not be dropped or warned about (the engine creates a
    // synthetic static ground body and anchors to it).
    expect(warnings.filter(w => /unknown joint|unknown body|no ground/i.test(w))).toHaveLength(0);
  });

  it('a prismatic joint constrains a dynamic body to its axis', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    // Cart at y=150, anchor at cart spawn, axis (1,0): gravity (down) is
    // off-axis and must be resisted — the cart's y stays pinned to the anchor.
    e.addJoint({ type: 'lpj', name: 'j_axis', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 150 }, axis: { x: 1, y: 0 }, enableLimit: true, lowerTranslation: -50, upperTranslation: 50, enableMotor: false, maxMotorForce: 0, collideConnected: false }, bm);
    const cart = bm.get('cart_0') as any;
    for (let i = 0; i < 60; i++) e.tick();
    const after = cart.GetPosition();
    const yMapPx = after.y * 30;
    expect(Math.abs(yMapPx - 150)).toBeLessThan(5);
    expect(Number.isFinite(after.x)).toBe(true);
  });
});