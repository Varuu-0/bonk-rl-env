import { describe, it, expect } from 'vitest';
import { PhysicsEngine, SCALE } from '../../src/core/physics-engine';
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

  it('rv/d anchors are body-relative offsets that track a rotating body, not world coordinates (#282)', () => {
    // No gravity: the two dynamic bodies move only from their authored
    // velocities, so the pivot assertions below are exact.
    const e = new PhysicsEngine({ gravityY: 0 });
    // bodyA starts 100 map px right of the world origin and is dynamic with
    // linear + angular velocity, so its pose changes every tick. A static
    // body could never expose a detached pivot — drive a moving, rotating
    // body to prove the world pivot really tracks it (§33.8).
    e.addBody({ name: 'bodyA', type: 'rect', x: 100, y: 0, width: 40, height: 10, static: false, density: 1, linearVelocity: { x: 0.5, y: 0 }, angularVelocity: 0.5 } as any);
    e.addBody({ name: 'bodyB', type: 'rect', x: 200, y: 0, width: 20, height: 20, static: false, density: 1 } as any);
    const bm = e.getBodyMap() as Map<string, any>;
    const bodyA = bm.get('bodyA') as any;

    e.addJoint({ type: 'rv', name: 'j_rv', bodyA: 'bodyA', bodyB: 'bodyB', anchorA: { x: 0, y: 50 }, enableLimit: false }, bm);
    e.addJoint({ type: 'd', name: 'j_d', bodyA: 'bodyA', bodyB: 'bodyB', anchorA: { x: 0, y: 50 }, anchorB: { x: 0, y: -50 }, length: 60 }, bm);
    // No authored length: the joint must still build (§33.7 d length default
    // = distance between the anchor world points in the bodies' frames).
    e.addJoint({ type: 'd', name: 'j_d_nolen', bodyA: 'bodyA', bodyB: 'bodyB', anchorA: { x: 0, y: 50 }, anchorB: { x: 0, y: -50 } }, bm);

    const rv = (e as any).createdJoints.get('j_rv');
    const d = (e as any).createdJoints.get('j_d');
    const dNolen = (e as any).createdJoints.get('j_d_nolen');
    expect(rv).toBeTruthy();
    expect(d).toBeTruthy();
    expect(dNolen).toBeTruthy();

    // The local anchor on bodyA must be exactly anchorA / SCALE — NOT
    // anchorA / SCALE − bodyA.position, which the old world-point
    // interpretation would pin at x = −100/30 here.
    expect(rv.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(rv.m_localAnchor1.y).toBeCloseTo(50 / SCALE, 5);
    // §33.8 d: aa/ab are local anchors in the connected bodies' frames.
    expect(d.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(d.m_localAnchor1.y).toBeCloseTo(50 / SCALE, 5);
    expect(d.m_localAnchor2.x).toBeCloseTo(0, 5);
    expect(d.m_localAnchor2.y).toBeCloseTo(-50 / SCALE, 5);
    // Authored length survives; without a length the anchor distance is used.
    expect(d.m_length).toBeCloseTo(60 / SCALE, 5);
    expect(dNolen.m_length).toBeCloseTo(Math.sqrt(100 * 100 + 100 * 100) / SCALE, 5);

    // Step the world: bodyA must actually move and rotate — otherwise the
    // post-tick pivot assertions below would be vacuous.
    for (let i = 0; i < 30; i++) e.tick();
    expect(bodyA.GetAngle()).not.toBeCloseTo(0, 2);
    const pos = bodyA.GetPosition();
    expect(pos.x).not.toBeCloseTo(100 / SCALE, 5);

    // The world pivot tracks the rotating body: it stays the authored
    // body-relative offset transformed by the CURRENT pose — never a fixed
    // world point (the joint's local anchor is invariant, and its world
    // position is exactly pos + R·(aa/SCALE) recomputed from the live pose).
    expect(rv.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(rv.m_localAnchor1.y).toBeCloseTo(50 / SCALE, 5);
    const angle = bodyA.GetAngle();
    const pivot = bodyA.GetWorldPoint(rv.m_localAnchor1);
    expect(pivot.x).toBeCloseTo(pos.x + (0 * Math.cos(angle) - (50 / SCALE) * Math.sin(angle)), 5);
    expect(pivot.y).toBeCloseTo(pos.y + (0 * Math.sin(angle) + (50 / SCALE) * Math.cos(angle)), 5);
    // The distance-joint anchor stays attached to the same body-frame point.
    const dPivot = bodyA.GetWorldPoint(d.m_localAnchor1);
    expect(dPivot.x).toBeCloseTo(pivot.x, 5);
    expect(dPivot.y).toBeCloseTo(pivot.y, 5);
  });

  it('rv/d joints without authored anchors pin the pivot at the body origin, not p + R·p (#282)', () => {
    // The exporter emits anchorA/anchorB: null for joints whose game
    // definition has no aa/ab (Webscripts/mapexporter.js:560), so this is the
    // path real maps take. bodyA sits off the world origin — the reported
    // regression (pivot = p + R·p) is invisible at the origin and would
    // misplace the pivot by the full body position here.
    const e = new PhysicsEngine({ gravityY: 0 });
    e.addBody({ name: 'bodyA', type: 'rect', x: 100, y: 0, width: 40, height: 10, static: false, density: 1, angularVelocity: 0.5 } as any);
    e.addBody({ name: 'bodyB', type: 'rect', x: 200, y: 0, width: 20, height: 20, static: false, density: 1 } as any);
    const bm = e.getBodyMap() as Map<string, any>;
    const bodyA = bm.get('bodyA') as any;

    e.addJoint({ type: 'rv', name: 'j_rv', bodyA: 'bodyA', bodyB: 'bodyB', enableLimit: false }, bm);
    // No anchors and no length: the d joint constrains the two body origins
    // to their initial separation (the default length), so nothing yanks.
    e.addJoint({ type: 'd', name: 'j_d', bodyA: 'bodyA', bodyB: 'bodyB' }, bm);

    const rv = (e as any).createdJoints.get('j_rv');
    const d = (e as any).createdJoints.get('j_d');
    expect(rv).toBeTruthy();
    expect(d).toBeTruthy();

    // No authored anchor → local anchor (0,0): the pivot is the body origin.
    // The double-add regression would leave rv.m_localAnchor1 at (100/30, 0).
    expect(rv.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(rv.m_localAnchor1.y).toBeCloseTo(0, 5);
    expect(d.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(d.m_localAnchor1.y).toBeCloseTo(0, 5);
    expect(d.m_localAnchor2.x).toBeCloseTo(0, 5);
    expect(d.m_localAnchor2.y).toBeCloseTo(0, 5);

    // And it stays pinned to the body frame while the body rotates.
    for (let i = 0; i < 30; i++) e.tick();
    expect(bodyA.GetAngle()).not.toBeCloseTo(0, 2);
    expect(rv.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(rv.m_localAnchor1.y).toBeCloseTo(0, 5);
    const pos = bodyA.GetPosition();
    expect(bodyA.GetWorldPoint(rv.m_localAnchor1).x).toBeCloseTo(pos.x, 5);
    expect(bodyA.GetWorldPoint(rv.m_localAnchor1).y).toBeCloseTo(pos.y, 5);
  });

  it('malformed truthy anchors degrade to the body origin, never a NaN pivot (#282)', () => {
    // The map adapter passes anchorA through verbatim (map-adapter.ts:318), so
    // hand-authored maps can carry truthy-but-invalid anchors (`{}`, `{x: null}`,
    // `{x: NaN}`, string coordinates). makeAnchorA would compute a.x / scale =
    // NaN for these; both the rv pivot guard and the d branch's anchorCoord
    // sanitizer must degrade them to the body origin — no NaN coordinates may
    // reach the joint def. (`NaN ?? 0` stays NaN, so a bare `?? 0` would not
    // be enough for the d branch.)
    const e = new PhysicsEngine({ gravityY: 0 });
    e.addBody({ name: 'bodyA', type: 'rect', x: 100, y: 0, width: 40, height: 10, static: false, density: 1, angularVelocity: 0.5 } as any);
    e.addBody({ name: 'bodyB', type: 'rect', x: 200, y: 0, width: 20, height: 20, static: false, density: 1 } as any);
    const bm = e.getBodyMap() as Map<string, any>;
    const bodyA = bm.get('bodyA') as any;

    for (const [name, anchor] of [
      ['j_empty', {}],
      ['j_nullx', { x: null, y: 0 }],
      ['j_nully', { x: 0, y: null }],
      ['j_nanx', { x: NaN, y: 0 }],
      ['j_nany', { x: 0, y: NaN }],
      ['j_strx', { x: 'abc', y: 0 }],
      ['j_stry', { x: 0, y: 'abc' }],
    ] as [string, any][]) {
      e.addJoint({ type: 'rv', name, bodyA: 'bodyA', bodyB: 'bodyB', anchorA: anchor, enableLimit: false }, bm);
      e.addJoint({ type: 'd', name: name + '_d', bodyA: 'bodyA', bodyB: 'bodyB', anchorA: anchor, anchorB: anchor }, bm);
    }

    for (const name of ['j_empty', 'j_nullx', 'j_nully', 'j_nanx', 'j_nany', 'j_strx', 'j_stry']) {
      const rv = (e as any).createdJoints.get(name);
      const d = (e as any).createdJoints.get(name + '_d');
      expect(rv).toBeTruthy();
      expect(d).toBeTruthy();
      // Both branches degrade the malformed anchor to the body origin: the rv
      // pivot lands at local (0,0) instead of NaN, and the d joint pins its
      // local anchors at (0,0) via the shared anchorCoord finite check.
      for (const a of [rv.m_localAnchor1, d.m_localAnchor1, d.m_localAnchor2]) {
        expect(Number.isFinite(a.x)).toBe(true);
        expect(Number.isFinite(a.y)).toBe(true);
        expect(a.x).toBeCloseTo(0, 5);
        expect(a.y).toBeCloseTo(0, 5);
      }
      expect(Number.isFinite(d.m_length)).toBe(true);
      expect(d.m_length).toBeCloseTo(100 / SCALE, 5);
    }

    // And the rv pivot stays finite and origin-pinned while the body rotates.
    for (let i = 0; i < 30; i++) e.tick();
    const rv = (e as any).createdJoints.get('j_empty');
    expect(bodyA.GetAngle()).not.toBeCloseTo(0, 2);
    expect(Number.isFinite(rv.m_localAnchor1.x)).toBe(true);
    expect(Number.isFinite(rv.m_localAnchor1.y)).toBe(true);
    expect(rv.m_localAnchor1.x).toBeCloseTo(0, 5);
    expect(rv.m_localAnchor1.y).toBeCloseTo(0, 5);
    const pos = bodyA.GetPosition();
    expect(Number.isFinite(bodyA.GetWorldPoint(rv.m_localAnchor1).x)).toBe(true);
    expect(bodyA.GetWorldPoint(rv.m_localAnchor1).x).toBeCloseTo(pos.x, 5);
    expect(bodyA.GetWorldPoint(rv.m_localAnchor1).y).toBeCloseTo(pos.y, 5);
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