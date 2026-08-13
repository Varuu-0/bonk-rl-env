import { describe, it, expect } from 'vitest';
import { PhysicsEngine, SCALE } from '../../src/core/physics-engine';
import { normalizeMap } from '../../src/core/map-adapter';
import { BonkEnvironment } from '../../src/core/environment';

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
    // `{x: NaN}`, string coordinates) and partially-valid anchors (`{x: 5, y: null}`).
    // makeAnchorA would compute a.x / scale = NaN for these; both the rv pivot
    // guard and the d branch must degrade the WHOLE anchor to the body origin —
    // no NaN coordinates may reach the joint def, and no coordinate may survive
    // a partially-valid anchor (`NaN ?? 0` stays NaN, so a bare `?? 0` would
    // not be enough for the d branch).
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
      ['j_partialx', { x: 5, y: null }],
      ['j_partialy', { x: null, y: 5 }],
    ] as [string, any][]) {
      e.addJoint({ type: 'rv', name, bodyA: 'bodyA', bodyB: 'bodyB', anchorA: anchor, enableLimit: false }, bm);
      e.addJoint({ type: 'd', name: name + '_d', bodyA: 'bodyA', bodyB: 'bodyB', anchorA: anchor, anchorB: anchor }, bm);
    }

    for (const name of ['j_empty', 'j_nullx', 'j_nully', 'j_nanx', 'j_nany', 'j_strx', 'j_stry', 'j_partialx', 'j_partialy']) {
      const rv = (e as any).createdJoints.get(name);
      const d = (e as any).createdJoints.get(name + '_d');
      expect(rv).toBeTruthy();
      expect(d).toBeTruthy();
      // Both branches degrade the malformed or partially-valid anchor to the
      // body origin: the rv pivot lands at local (0,0), and the d joint pins
      // both local anchors at (0,0) via the same whole-anchor finite check.
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

  it('keeps exported compound fixtures on one Box2D body and attaches the joint to it (#307)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'rect', x: -50, y: 0, width: 20, height: 10, static: false, density: 1 },
        { bodyIndex: 0, fixtureIndex: 1, name: 'Unnamed Shape', type: 'rect', x: 50, y: 0, width: 20, height: 10, static: false, density: 1 },
        { bodyIndex: 1, fixtureIndex: 2, name: 'Unnamed Shape', type: 'rect', x: 0, y: 100, width: 200, height: 10, static: true },
      ],
      physicsBodies: [
        {
          index: 0,
          name: 'compound',
          type: 'd',
          typeName: 'dynamic',
          position: { x: 0, y: 0 },
          fixtureIndices: [0, 1],
          fixtures: [
            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: -50, y: 0 }, angle: 0, width: 20, height: 10 } },
            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 50, y: 0 }, angle: 0, width: 20, height: 10 } },
          ],
        },
        {
          index: 1,
          name: 'anchor',
          type: 's',
          typeName: 'static',
          position: { x: 0, y: 100 },
          fixtureIndices: [2],
          fixtures: [
            { fixtureIndex: 2, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 200, height: 10 } },
          ],
        },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [{ type: 'lpj', bodyA: 0, bodyB: -1, anchorA: { x: 0, y: 0 }, axis: { x: 0, y: 1 } }],
    } as any) as any;

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    for (const joint of md.joints) e.addJoint(joint, bodyMap);

    const grouped = bodyMap.get(md.joints[0].bodyA);
    let shapeCount = 0;
    for (let shape = grouped.GetShapeList(); shape !== null; shape = shape.GetNext()) shapeCount++;
    const created = (e as any).createdJoints.get('joint_0');

    expect(shapeCount).toBe(2);
    expect(created).toBeTruthy();
    expect(created.m_body1).toBe(grouped);
    expect(grouped.GetPosition().x).toBeCloseTo(0, 5);
    expect(grouped.GetPosition().y).toBeCloseTo(0, 5);
  });

  it('resolves every bundled WDB ground joint to its authored native body (#307)', () => {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../maps/bonk_WDB__no_nothing__1232248.json'), 'utf8'));
    const md = normalizeMap(raw) as any;
    const e = makeEngine();

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    for (const joint of md.joints) e.addJoint(joint, bodyMap);

    expect(md.joints).toHaveLength(5);
    for (const [i, joint] of md.joints.entries()) {
      const nativeIndex = 8 + i;
      const aliases = md.bodies
        .filter((body: any) => body.nativeBody?.index === nativeIndex)
        .map((body: any) => body.name);
      const grouped = bodyMap.get(joint.bodyA);
      const created = (e as any).createdJoints.get(`joint_${i}`);
      let shapeCount = 0;
      for (let shape = grouped.GetShapeList(); shape !== null; shape = shape.GetNext()) shapeCount++;

      expect(joint.bodyB).toBe('');
      expect(joint.isGround).toBe(true);
      expect(joint.bodyA).toBe(aliases[0]);
      expect(joint.bodyA).not.toBe(aliases[aliases.length - 1]);
      expect(created.m_body1).toBe(grouped);
      expect(shapeCount).toBe(aliases.length);
    }
  });

  it('keeps a native grouped body when its first fixture is invalid, preserving the alias and joint (#307 review)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'polygon', x: -50, y: 0, vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], static: false, density: 1 },
        { bodyIndex: 0, fixtureIndex: 1, name: 'Unnamed Shape', type: 'rect', x: 50, y: 0, width: 20, height: 10, static: false, density: 1 },
      ],
      physicsBodies: [
        {
          index: 0,
          name: 'compound',
          type: 'd',
          typeName: 'dynamic',
          position: { x: 0, y: 0 },
          fixtureIndices: [0, 1],
          fixtures: [
            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'po', typeName: 'polygon', center: { x: -50, y: 0 }, angle: 0, scale: 1, vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }] } },
            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 50, y: 0 }, angle: 0, width: 20, height: 10 } },
          ],
        },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [{ type: 'lpj', bodyA: 0, bodyB: -1, anchorA: { x: 0, y: 0 }, axis: { x: 0, y: 1 } }],
    } as any) as any;

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    for (const joint of md.joints) e.addJoint(joint, bodyMap);

    // The invalid first fixture must NOT have destroyed the native body before
    // alias registration: the first alias resolves to the grouped body and the
    // joint still attaches to it.
    const grouped = bodyMap.get(md.joints[0].bodyA);
    expect(grouped).toBeTruthy();
    let shapeCount = 0;
    for (let shape = grouped.GetShapeList(); shape !== null; shape = shape.GetNext()) shapeCount++;
    const created = (e as any).createdJoints.get('joint_0');
    expect(shapeCount).toBe(1);
    expect(created).toBeTruthy();
    expect(created.m_body1).toBe(grouped);
    expect(grouped.GetPosition().x).toBeCloseTo(0, 5);
    expect(grouped.GetPosition().y).toBeCloseTo(0, 5);
  });

  it('places a native body\'s unresolvable fixture at the flat def coordinates, not the native origin (#307 review)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        // Fixture 0 has no entry in physicsFixtures or body.fixtures → its
        // nativeFixture is unresolvable; fixture 2 resolves to a fixture that
        // carries no shape geometry. Either way the engine must derive
        // placement from the flat (world) x/y instead of mixing native
        // position + flat geometry at the origin.
        { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'rect', x: 120, y: 40, width: 20, height: 10, static: false, density: 1 },
        { bodyIndex: 0, fixtureIndex: 1, name: 'Unnamed Shape', type: 'rect', x: 0, y: 40, width: 20, height: 10, static: false, density: 1 },
        { bodyIndex: 0, fixtureIndex: 2, name: 'Unnamed Shape', type: 'rect', x: 240, y: 40, width: 20, height: 10, static: false, density: 1 },
      ],
      physicsBodies: [
        {
          index: 0,
          name: 'body',
          type: 'd',
          typeName: 'dynamic',
          position: { x: 0, y: 40 },
          fixtureIndices: [0, 1, 2],
          fixtures: [
            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 20, height: 10 } },
            { fixtureIndex: 2, name: 'Unnamed Shape', shape: null },
          ],
        },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
    } as any) as any;

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    const grouped = bodyMap.get(md.bodies[0].name);
    expect(grouped).toBeTruthy();

    const box2d = require('box2d');
    const aabb = new box2d.b2AABB();
    const scale = (e as any).scale as number;
    const centers = [] as { x: number; y: number }[];
    for (let shape = grouped.GetShapeList(); shape !== null; shape = shape.GetNext()) {
      shape.ComputeAABB(aabb, grouped.GetXForm());
      centers.push({
        x: ((aabb.lowerBound.x + aabb.upperBound.x) / 2) * scale,
        y: ((aabb.lowerBound.y + aabb.upperBound.y) / 2) * scale,
      });
    }
    centers.sort((a, b) => a.x - b.x);
    expect(centers).toEqual([
      { x: 0, y: 40 },
      { x: 120, y: 40 },
      { x: 240, y: 40 },
    ]);
  });

  it('places native-fixture shapes at the adapter\'s world-space center for rotated/off-center fixtures (#307 review)', () => {
    const angle = Math.PI / 4;
    const e = makeEngine();
    const md = normalizeMap({
      physicsBodies: [
        {
          index: 0,
          name: 'rot',
          type: 's',
          typeName: 'static',
          position: { x: 100, y: 50 },
          angle,
          fixtureIndices: [0],
          fixtures: [
            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 100, y: 0 }, angle: 0, width: 20, height: 10 } },
          ],
        },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
    } as any) as any;

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    const grouped = bodyMap.get(md.bodies[0].name);
    expect(grouped).toBeTruthy();

    const box2d = require('box2d');
    const aabb = new box2d.b2AABB();
    const shape = grouped.GetShapeList();
    shape.ComputeAABB(aabb, grouped.GetXForm());
    const scale = (e as any).scale as number;
    const cx = ((aabb.lowerBound.x + aabb.upperBound.x) / 2) * scale;
    const cy = ((aabb.lowerBound.y + aabb.upperBound.y) / 2) * scale;
    // Cap-zone sensors are placed at fixtureDef.x + cx, so the shape's world
    // center must equal the adapter-emitted x/y (sensor alignment).
    expect(cx).toBeCloseTo(md.bodies[0].x, 4);
    expect(cy).toBeCloseTo(md.bodies[0].y, 4);
  });

  it('keeps the first native fixture alias as the grouped body user data (#307 review)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'rect', x: -50, y: 0, width: 20, height: 10, static: false, density: 1, isLethal: false },
        { bodyIndex: 0, fixtureIndex: 1, name: 'Unnamed Shape', type: 'rect', x: 50, y: 0, width: 20, height: 10, static: false, density: 1, isLethal: true },
      ],
      physicsBodies: [
        {
          index: 0,
          name: 'compound',
          type: 'd',
          typeName: 'dynamic',
          position: { x: 0, y: 0 },
          fixtureIndices: [0, 1],
          fixtures: [
            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: -50, y: 0 }, angle: 0, width: 20, height: 10 } },
            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 50, y: 0 }, angle: 0, width: 20, height: 10 } },
          ],
        },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
    } as any) as any;

    for (const body of md.bodies) e.addBody(body);
    const bodyMap = e.getBodyMap() as Map<string, any>;
    const grouped = bodyMap.get(md.bodies[0].name);
    const ud = grouped.GetUserData();
    expect(ud.isLethal).toBe(true);           // OR-accumulated across aliases
    expect(ud.name).toBe(md.bodies[0].name);  // first-alias identity
    expect(ud.x).toBe(-50);                   // no last-alias-wins geometry copy
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

  it('forwards exporter-format rv angle limits (lowerAngle/upperAngle) through normalizeMap', () => {
    // Regression: mapexporter.js emits lowerAngle/upperAngle for rv joints
    // (from native la/ua); the adapter must forward them or the joint is
    // built with equal 0/0 limits and locked rigid (issue #284).
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 100, y: 0 }, enableLimit: true, lowerAngle: -1.0, upperAngle: 1.0, enableMotor: true, motorSpeed: 10, maxMotorTorque: 50 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const rv = (e as any).createdJoints.get('joint_0');
    expect(rv.m_lowerAngle).toBeCloseTo(-1, 5);
    expect(rv.m_upperAngle).toBeCloseTo(1, 5);

    // The motor-driven gate must swing within the authored [-1, 1] window
    // rather than being welded rigid by equal 0/0 limits.
    const gate = bm.get('gate') as any;
    const start = gate.GetAngle();
    for (let i = 0; i < 120; i++) e.tick();
    expect(gate.GetAngle() - start).toBeGreaterThan(0.05);
  });

  it('derives the prismatic axis from the exported scalar angle (no axis field)', () => {
    const e = makeEngine();
    // Real exporter output: mapexporter.js emits `angle` (native pa), NEVER
    // `axis`. normalizeMap forwards angle and leaves axis undefined, so the
    // engine must derive the constraint axis from the authored angle, yielding
    // the native §33.8 local axis (cos(pa - bodyA.angle), sin(pa - bodyA.angle)).
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 0, y: 100, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        // Author a vertical piston: angle: pi/2, no axis — the exporter shape.
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 100 }, angle: Math.PI / 2,
          lowerTranslation: 0, lowerLimit: 0, upperLimit: 0, maxMotorForce: 0 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const pr = (e as any).createdJoints.get('joint_0');
    const pa = Math.PI / 2;
    // Authored vertical axis: cos(pi/2)=0, sin(pi/2)=1.
    expect(pr.m_localXAxis1.x).toBeCloseTo(Math.cos(pa), 5);
    expect(pr.m_localXAxis1.y).toBeCloseTo(Math.sin(pa), 5);
    expect(Math.abs(pr.m_localXAxis1.y)).toBeGreaterThan(0.9);
    expect(Math.abs(pr.m_localXAxis1.x)).toBeLessThan(0.1);
  });

  it('derives the prismatic axis relative to a rotated bodyA (pa - bodyA.angle)', () => {
    const e = makeEngine();
    // Author bodyA with a non-zero rotation so the `- bodyA.GetAngle()` term of
    // the native recipe (localAxisA = (cos(pa - bodyA.angle), sin(pa -
    // bodyA.angle))) is actually exercised. bodyB is ALSO rotated so that
    // Initialize()'s default referenceAngle (bodyB.angle - bodyA.angle = -0.1)
    // differs from the native override (-bodyA.angle = -0.4). normalizeMap
    // forwards body `angle` (map-adapter.ts), and addBody applies it to the
    // b2BodyDef.
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true, angle: 0.4 },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 0, y: 100, width: 20, height: 20, static: false, density: 1, angle: 0.3 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        // Author a vertical piston on a ROTATED wall: angle: pi/2, no axis.
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 100 }, angle: Math.PI / 2,
          lowerTranslation: 0, lowerLimit: 0, upperLimit: 0, maxMotorForce: 0 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const pr = (e as any).createdJoints.get('joint_0');
    const pa = Math.PI / 2;
    const ba = bm.get('wall') as any;
    const bb = bm.get('gate') as any;
    expect(ba.GetAngle()).toBeCloseTo(0.4, 5); // sanity: the rotation was applied
    expect(bb.GetAngle()).toBeCloseTo(0.3, 5);
    // Native §33.8: localAxisA = (cos(pa - bodyA.angle), sin(pa - bodyA.angle)).
    // Initialize() receives the world axis (cos pa, sin pa) and rotates it into
    // bodyA's local frame, so a subtracted-only (or double-subtracted) axis
    // fails here.
    expect(pr.m_localXAxis1.x).toBeCloseTo(Math.cos(pa - ba.GetAngle()), 5);
    expect(pr.m_localXAxis1.y).toBeCloseTo(Math.sin(pa - ba.GetAngle()), 5);
    // Native §33.8 also sets referenceAngle = -bodyA.GetAngle(). Because bodyB
    // is rotated, that differs from Initialize's default bodyB.angle -
    // bodyA.angle (-0.1), so deleting the override would fail this assertion.
    expect(pr.m_refAngle).toBeCloseTo(-ba.GetAngle(), 5);
    expect(pr.m_refAngle).not.toBeCloseTo(bb.GetAngle() - ba.GetAngle(), 5);
  });

  it('applies the native referenceAngle override for lsj on a rotated bodyA', () => {
    const e = makeEngine();
    // lsj exports NO angle (mapexporter emits sax/say/sf/slen), yet native
    // §33.8 sets def.referenceAngle = -bodyA.GetAngle() unconditionally for
    // lsj (DEOBFUSCATION.md:3472). Both bodies are rotated so the Initialize
    // default (bodyB.angle - bodyA.angle) differs from the native override.
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true, angle: 0.4 },
        { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 100, width: 20, height: 20, static: false, density: 1, angle: 0.3 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        // Real lsj exporter shape: sax/say/sf/slen, no angle.
        { bodyA: 0, bodyB: 1, type: 'lsj', anchorA: { x: 0, y: 100 }, anchorB: { x: 0, y: 130 },
          sax: 0, say: 100, sf: 100, slen: 30, collideConnected: false },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const lsj = (e as any).createdJoints.get('joint_0');
    const ba = bm.get('wall') as any;
    const bb = bm.get('spring') as any;
    expect(lsj).toBeTruthy();
    expect(lsj.m_type).toBe(2); // b2Joint.e_prismaticJoint
    // Native §33.8 lsj override: referenceAngle = -bodyA.GetAngle().
    expect(lsj.m_refAngle).toBeCloseTo(-ba.GetAngle(), 5);
    expect(lsj.m_refAngle).not.toBeCloseTo(bb.GetAngle() - ba.GetAngle(), 5);
  });

  it('applies the native referenceAngle override for a hand-authored lpj without an exported angle', () => {
    const e = makeEngine();
    // Hand-authored joint defs (like the rest of this suite) carry no `angle`
    // field, yet native §33.8 sets def.referenceAngle = -bodyA.GetAngle() for
    // lpj unconditionally (DEOBFUSCATION.md:3457). Both bodies are rotated so
    // Initialize()'s default (bodyB.angle - bodyA.angle) differs from the
    // native override.
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true, angle: 0.4 },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 0, y: 100, width: 20, height: 20, static: false, density: 1, angle: 0.3 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        // No `angle`, no `axis` — the exporter shape minus the axis scalar.
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 100 },
          lowerTranslation: 0, lowerLimit: 0, upperLimit: 0, maxMotorForce: 0 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const pr = (e as any).createdJoints.get('joint_0');
    const ba = bm.get('wall') as any;
    const bb = bm.get('gate') as any;
    expect(pr).toBeTruthy();
    // Native §33.8 lpj override applies regardless of the `angle` field.
    expect(pr.m_refAngle).toBeCloseTo(-ba.GetAngle(), 5);
    expect(pr.m_refAngle).not.toBeCloseTo(bb.GetAngle() - ba.GetAngle(), 5);
  });

  it('builds a vertical axis for the bundled map bonk_WeiRd_DeAth_BalL__80622.json lpj joint', () => {
    const e = makeEngine();
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../maps/bonk_WeiRd_DeAth_BalL__80622.json'), 'utf8'));
    const md = normalizeMap(raw) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body/i.test(w))).toHaveLength(0);

    const lpj = (e as any).createdJoints.get('joint_0');
    const pr = md.joints.find((j: any) => j.type === 'lpj');
    expect(pr).toBeTruthy();
    expect(pr.axis).toBeUndefined();
    expect(pr.angle).toBeCloseTo(Math.PI / 2, 5);
    // The joint's bodyA must be the first fixture alias for native body index 6,
    // not the last fixture alias from that compound body (the pre-#307
    // last-wins name map always selected the final flat fixture).
    const bodyAliases = md.bodies
      .filter((b: any) => b.nativeBody?.index === 6)
      .map((b: any) => b.name);
    expect(bodyAliases.length).toBeGreaterThan(1);
    expect(pr.bodyA).toBe(bodyAliases[0]);
    expect(pr.bodyA).not.toBe(bodyAliases[bodyAliases.length - 1]);
    const ba = bm.get(pr.bodyA) as any;
    expect(ba).toBeTruthy();
    expect(lpj.m_localXAxis1.x).toBeCloseTo(Math.cos(pr.angle - ba.GetAngle()), 5);
    expect(lpj.m_localXAxis1.y).toBeCloseTo(Math.sin(pr.angle - ba.GetAngle()), 5);
    // No referenceAngle assertion here: this lpj is ground-anchored (bodyB is
    // the angle-0 ground), so Initialize()'s default (bodyB.angle - bodyA.angle
    // = -bodyA.angle) always coincides with the native override and the
    // assertion would be degenerate. referenceAngle is covered by the rotated
    // lpj/lsj tests above.
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

  it('builds an exported lpj piston as a driven, limited prismatic joint (issue #281)', () => {
    // Exactly the field shape mapexporter.js now emits for an lpj: travel
    // ±plen as the translation limit, pf as maxMotorForce, pms as motorSpeed,
    // with the limit and motor enabled (DEOBFUSCATION §33.8 lpj).
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'piston', type: 'rect', x: 0, y: 30, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        {
          index: 0, type: 'lpj', bodyA: 0, bodyB: 1,
          anchorA: { x: 0, y: 0 }, angle: Math.PI / 2,  // axis derivation is #280
          lowerTranslation: -50, upperTranslation: 50,  // native ±plen
          length: 50,                                   // native plen (fallback source)
          maxMotorForce: 1000,                          // native pf
          motorSpeed: 3,                                // native pms
          enableLimit: true, enableMotor: true,
        },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    e.addJoint(md.joints[0], bm);
    const j: any = (e as any).createdJoints.get('joint_0');
    expect(j).toBeTruthy();
    expect(j.m_enableLimit).toBe(true);
    expect(j.m_lowerTranslation).toBeCloseTo(-50, 5);
    expect(j.m_upperTranslation).toBeCloseTo(50, 5);
    expect(j.m_enableMotor).toBe(true);
    expect(j.m_motorSpeed).toBeCloseTo(3, 5);
    expect(j.m_maxMotorForce).toBeCloseTo(1000, 5);
  });

  it('a motor-enabled lpj piston displaces along its axis under tick (issue #281)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'piston', type: 'rect', x: 0, y: 30, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        {
          index: 0, type: 'lpj', bodyA: 0, bodyB: 1,
          anchorA: { x: 0, y: 30 }, axis: { x: 1, y: 0 },  // horizontal to isolate motor from #280's axis
          lowerTranslation: -50, upperTranslation: 50,
          maxMotorForce: 1000, motorSpeed: 3,
          enableLimit: true, enableMotor: true,
        },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    e.addJoint(md.joints[0], bm);
    const piston = bm.get('piston') as any;
    const startX = piston.GetPosition().x;
    let moved = false;
    for (let i = 0; i < 120; i++) {
      e.tick();
      if (Math.abs(piston.GetPosition().x - startX) > 1 / 30) { moved = true; break; }
    }
    // Before the fix the motor was disabled (enableMotor=false, speed 0) and
    // the piston never moved; now the motor must drive it along its axis.
    expect(moved).toBe(true);
  });

  it('builds an exported lsj spring as a driven vertical-axis prismatic joint (issue #281)', () => {
    // mapexporter.js lsj output: vertical axis (0,1), ±slen travel (limit
    // disabled), motor enabled at speed 300 with sf as the force scale
    // (DEOBFUSCATION §33.8 lsj, lines 3468–3487).
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 40, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        {
          index: 0, type: 'lsj', bodyA: 0, bodyB: 1,
          anchorA: { x: 0, y: 40 },
          axis: { x: 0, y: 1 },
          lowerTranslation: -40, upperTranslation: 40,
          length: 40,
          enableLimit: false, enableMotor: true,
          motorSpeed: 300, maxMotorForce: 25,
        },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    e.addJoint(md.joints[0], bm);
    const j: any = (e as any).createdJoints.get('joint_0');
    expect(j).toBeTruthy();
    expect(j.m_enableLimit).toBe(false);
    expect(j.m_lowerTranslation).toBeCloseTo(-40, 5);
    expect(j.m_upperTranslation).toBeCloseTo(40, 5);
    expect(j.m_enableMotor).toBe(true);
    expect(j.m_motorSpeed).toBeCloseTo(300, 5);
    expect(j.m_maxMotorForce).toBeCloseTo(25, 5);
    expect(j.m_localXAxis1.x).toBeCloseTo(0, 5);
    expect(j.m_localXAxis1.y).toBeCloseTo(1, 5);
  });

  it('honors a prismatic length field as the symmetric translation limit when lower/upper are absent (issue #281)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'piston', type: 'rect', x: 0, y: 30, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 30 }, length: 50, enableLimit: true },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    e.addJoint(md.joints[0], bm);
    const j: any = (e as any).createdJoints.get('joint_0');
    expect(j.m_enableLimit).toBe(true);
    expect(j.m_lowerTranslation).toBeCloseTo(-50, 5);
    expect(j.m_upperTranslation).toBeCloseTo(50, 5);
  });

  it('a prismatic joint with a negative or zero length keeps the previous 0/0 range — never inverted (issue #281)', () => {
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'piston', type: 'rect', x: 0, y: 30, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 30 }, length: -50, enableLimit: true },
        { bodyA: 0, bodyB: 1, type: 'lpj', anchorA: { x: 0, y: 30 }, length: 0, enableLimit: true },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    for (const j of md.joints) { e.addJoint(j, bm); }
    for (const name of ['joint_0', 'joint_1']) {
      const j: any = (e as any).createdJoints.get(name);
      // Negative/zero lengths must not become a symmetric limit: the previous
      // 0/0 behavior is preserved so the range can never invert.
      expect(j.m_lowerTranslation).toBe(0);
      expect(j.m_upperTranslation).toBe(0);
      expect(j.m_lowerTranslation).toBeLessThanOrEqual(j.m_upperTranslation);
    }
  });

  it('skips null physicsJoints entries that the exporter emits for unexportable joints', () => {
    // The mapexporter (Webscripts/mapexporter.js:528-532) pushes a literal
    // `null` into physicsJoints for any joint it cannot export, keeping
    // raw-array indices stable. normalizeMap must skip these instead of
    // throwing on `j.bodyA`, so a map with an unexportable joint still
    // loads its bodies, spawns and cap zones (#283).
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        null,
        { bodyA: 0, bodyB: -1, type: 'lpj', anchorA: { x: 0, y: 0 } },
      ],
    } as any) as any;

    expect(md.joints).toHaveLength(1);
    // The surviving joint keeps its RAW array index so gear referents and
    // the engine's createdJoints resolution stay consistent.
    expect(md.joints[0].name).toBe('joint_1');
    expect(md.joints[0].type).toBe('lpj');
    expect(md.joints[0].isGround).toBe(true);

    const e = makeEngine();
    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body|no ground/i.test(w))).toHaveLength(0);
  });

  it('keeps gear referents indexed by the raw physicsJoints array when nulls are skipped', () => {
    // The gear's ja/jb are indices into the RAW exported physicsJoints array
    // (which includes the null the exporter pushed at position 0). Filtering
    // the null must not re-number the surviving joints, or joint_1/joint_2
    // would silently mis-wire to the wrong referents (#283).
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        null,
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 0, y: 0 } },
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 100, y: 0 } },
        { bodyA: 0, bodyB: 1, type: 'g', ja: 1, jb: 2, ratio: 3 },
      ],
    } as any) as any;

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings).toHaveLength(0);
    const gear = (e as any).createdJoints.get('joint_3');
    expect(gear).toBeTruthy();
    expect(gear.m_type).toBe(6);
    expect(gear.m_ratio).toBe(3);
    // Raw indices 1 and 2 are the two revolute referents, NOT the post-filter
    // positions 0 and 1.
    expect(gear.m_revolute1).toBe((e as any).createdJoints.get('joint_1'));
    expect(gear.m_revolute2).toBe((e as any).createdJoints.get('joint_2'));
  });

  it('constructs a BonkEnvironment from a map with a null joint without throwing', () => {
    // The programmatic mapData path (environment.ts) calls normalizeMap
    // unguarded, so a map with an unexportable joint must never crash the
    // BonkEnvironment constructor (#283).
    const exportedMap = {
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        null,
        { bodyA: 0, bodyB: -1, type: 'lpj', anchorA: { x: 0, y: 0 } },
      ],
    };
    let env: BonkEnvironment | undefined;
    expect(() => {
      env = new BonkEnvironment({ mapData: exportedMap as any, numOpponents: 0, seed: 1, maxTicks: 10 });
    }).not.toThrow();
    // The map is actually used (not silently replaced by the box fallback).
    expect((env as any).config.mapData.joints).toHaveLength(1);
    expect((env as any).config.mapData.bodies.map((b: any) => b.name)).toContain('wall');
  });

  it('drops a gear whose referents point at skipped null entries, with a warning', () => {
    // A gear's ja/jb are raw physicsJoints indices; when they land on a null
    // the exporter emitted, the referents resolve to nothing and the engine
    // must drop the gear with a warn instead of constructing a broken joint.
    const e = makeEngine();
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        null,
        { bodyA: 0, bodyB: 1, type: 'rv', anchorA: { x: 0, y: 0 } },
        null,
        { bodyA: 0, bodyB: 1, type: 'g', ja: 0, jb: 2, ratio: 3 },
      ],
    } as any) as any;

    // The gear keeps its raw index (joint_3) but neither referent resolves
    // because src[0] and src[2] are the skipped nulls.
    const gearDef = md.joints.find((j: any) => j.type === 'g');
    expect(gearDef).toBeTruthy();
    expect(gearDef.name).toBe('joint_3');
    expect(gearDef.jointA).toBeUndefined();
    expect(gearDef.jointB).toBeUndefined();

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.some(w => /Gear joint references missing referent joints/.test(w))).toBe(true);
    expect((e as any).createdJoints.has('joint_3')).toBe(false);
  });

  it('handles an all-null physicsJoints array without crashing', () => {
    // Every entry skipped -> joints is empty and the MapDef drops the field
    // entirely (joints.length > 0 guard), while the map still normalizes.
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [null, null, null],
    } as any) as any;

    expect(md).toBeTruthy();
    expect(md.name).toBe('Untitled Map');
    expect(md.spawnPoints).toBeTruthy();
    expect(md.bodies.map((b: any) => b.name)).toContain('wall');
    expect(md.joints).toBeUndefined();
  });

  it('tolerates dense physicsJoints entries that are literal undefined', () => {
    // A programmatic mapData can hand normalizeMap a DENSE physicsJoints array
    // containing literal `undefined` entries. (Sparse holes never reach the map
    // callback — Array.prototype.map skips them — so only a dense undefined can
    // exercise the guard.) The old null-only guard dereferenced these at
    // j.bodyA and threw the #283 TypeError; they must be skipped like nulls.
    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: [
        null,
        undefined,
        { bodyA: 0, bodyB: -1, type: 'lpj', anchorA: { x: 0, y: 0 } },
      ],
    } as any) as any;

    expect(md).toBeTruthy();
    expect(md.joints).toHaveLength(1);
    // The surviving joint keeps its RAW array index (2), not the post-filter
    // position 0.
    expect(md.joints[0].name).toBe('joint_2');
    expect(md.joints[0].type).toBe('lpj');
    expect(md.joints[0].isGround).toBe(true);

    const e = makeEngine();
    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.filter(w => /unknown joint type|unknown body|no ground/i.test(w))).toHaveLength(0);
  });
});
