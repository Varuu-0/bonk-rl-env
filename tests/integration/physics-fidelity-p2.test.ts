import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { normalizeMap } from '../../src/core/map-adapter';

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

  it('constructs a gear (g) joint over two revolute referents with the authored ratio', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'rv', name: 'r1', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, enableLimit: false, collideConnected: false }, bm);
      e.addJoint({ type: 'rv', name: 'r2', bodyA: 'plat_1', bodyB: 'cart_1', anchorA: { x: 100, y: 100 }, enableLimit: false, collideConnected: false }, bm);
      e.addJoint({ type: 'g', name: 'g0', bodyA: 'plat_0', bodyB: 'cart_0', jointA: 'r1', jointB: 'r2', ratio: 2, collideConnected: false }, bm);
    });
    expect(warnings).toHaveLength(0);
    const gear = (e as any).createdJoints.get('g0');
    expect(gear).toBeTruthy();
    expect(gear.m_type).toBe(6); // b2Joint.e_gearJoint
    expect(gear.m_ratio).toBe(2);
  });

  it('warns and skips a gear joint whose referent is a distance joint (not revolute/prismatic)', () => {
    const e = makeEngine();
    const bm = makeBodyMap(e);
    const warnings = captureWarn(() => {
      e.addJoint({ type: 'rv', name: 'r1', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, enableLimit: false, collideConnected: false }, bm);
      e.addJoint({ type: 'd', name: 'd1', bodyA: 'plat_0', bodyB: 'cart_0', anchorA: { x: 0, y: 100 }, anchorB: { x: 0, y: 140 }, collideConnected: false }, bm);
      e.addJoint({ type: 'g', name: 'bad_gear', bodyA: 'plat_0', bodyB: 'cart_0', jointA: 'r1', jointB: 'd1', ratio: 1, collideConnected: false }, bm);
    });
    // The distance referent must be rejected BEFORE b2GearJoint construction
    // (the port would otherwise throw on GetJointTranslation).
    expect(warnings.some(w => /revolute or prismatic/.test(w))).toBe(true);
    expect((e as any).createdJoints.has('bad_gear')).toBe(false);
  });

  it('forwards revolute limits, prismatic axis/referenceAngle, and distance length through normalizeMap', () => {
    const e = makeEngine();
    // Real exported-bonk format: bodies referenced by index, joints by type
    // with the flattened native field names the exporter emits (§33.8).
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 0, y: 0 }, enableLimit: true, lowerLimit: -0.5, upperLimit: 0.5 },
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 0 }, axis: { x: 0, y: 1 }, referenceAngle: 0.3, enableLimit: true, lowerTranslation: -50, upperTranslation: 50 },
        { bodyA: 0, bodyB: 1, type: 'd', anchorA: { x: 0, y: 0 }, anchorB: { x: 0, y: 30 }, length: 50 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    // Revolute: exporter lowerLimit/upperLimit must reach the joint's angles.
    const rv = (e as any).createdJoints.get('joint_0');
    expect(rv.m_lowerAngle).toBeCloseTo(-0.5, 5);
    expect(rv.m_upperAngle).toBeCloseTo(0.5, 5);
    // Prismatic: authored axis and referenceAngle must be forwarded.
    const pr = (e as any).createdJoints.get('joint_1');
    expect(pr.m_localXAxis1.y).toBeCloseTo(1, 5);
    expect(pr.m_localXAxis1.x).toBeCloseTo(0, 5);
    expect(pr.m_refAngle).toBeCloseTo(0.3, 5);
    // Distance: authored length applied after Initialize (px / scale).
    const ds = (e as any).createdJoints.get('joint_2');
    expect(ds.m_length).toBeCloseTo(50 / 30, 5);
  });

  it('normalizeMap forwards authored distance-joint frequencyHz/dampingRatio (#286)', () => {
    const e = makeEngine();
    // Exported d joint authored with spring tuning (d.fh=4 / d.dr=0.5) must
    // reach the engine's distance joint, which otherwise builds a rigid rod
    // (frequencyHz=0, dampingRatio=0) — #286.
    const sprung = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'd', anchorA: { x: 0, y: 0 }, anchorB: { x: 0, y: 30 }, frequencyHz: 4, dampingRatio: 0.5 },
      ],
    } as any) as any;
    const bm = new Map<string, any>();
    for (const b of sprung.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of sprung.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);
    const sprungJoint = (e as any).createdJoints.get('joint_0');
    expect(sprungJoint.m_frequencyHz).toBe(4);
    expect(sprungJoint.m_dampingRatio).toBeCloseTo(0.5, 5);
  });

  it('normalizeMap preserves rigid distance-joint defaults when fh/dr are absent or null (#286)', () => {
    // The exporter emits `frequencyHz: null` / `dampingRatio: null` for d joints
    // without authored tuning (mapexporter.js:565-566), so both the omitted-keys
    // form and the explicit-null form must build the rigid default (0/0).
    const cases: Array<Record<string, unknown>> = [
      { bodyA: 0, bodyB: 1, type: 'd', anchorA: { x: 0, y: 0 }, anchorB: { x: 0, y: 30 } },
      { bodyA: 0, bodyB: 1, type: 'd', anchorA: { x: 0, y: 0 }, anchorB: { x: 0, y: 30 }, frequencyHz: null, dampingRatio: null },
    ];
    for (const def of cases) {
      const e = makeEngine();
      const md = normalizeMap({
        bodies: [
          { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
          { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
        ],
        spawns: [{ x: 0, y: 0, blue: true, red: true }],
        physicsJoints: [def],
      } as any) as any;
      const bm = new Map<string, any>();
      for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
      const warnings = captureWarn(() => {
        for (const j of md.joints) { e.addJoint(j, bm); }
      });
      expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);
      const joint = (e as any).createdJoints.get('joint_0');
      expect(joint.m_frequencyHz).toBe(0);
      expect(joint.m_dampingRatio).toBe(0);
    }
  });

  it('resolves gear referents by index through the full normalizeMap pipeline', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 0, y: 0 } },
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 100, y: 0 } },
        { bodyA: 0, bodyB: 1, type: 'g', ja: 0, jb: 1, ratio: 3 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings).toHaveLength(0);
    const gear = (e as any).createdJoints.get('joint_2');
    expect(gear).toBeTruthy();
    expect(gear.m_type).toBe(6);
    expect(gear.m_ratio).toBe(3);
    // Both referents are revolute, so they land in m_revolute1/m_revolute2.
    expect(gear.m_revolute1).toBe((e as any).createdJoints.get('joint_0'));
    expect(gear.m_revolute2).toBe((e as any).createdJoints.get('joint_1'));
  });
});