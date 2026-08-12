import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeMap } from '../../src/core/map-adapter';
import { PhysicsEngine, GROUND_BODY_NAME } from '../../src/core/physics-engine';

/**
 * Issue #285 regression — mapexporter gear joint emission.
 *
 * The mapexporter (a browser userscript, so it can't be imported) previously
 * dropped native gear joints: its `joints.forEach(...)` extraction had branches
 * for rv/d/lpj/lsj but no `g` branch, and `KNOWN.joint` didn't list `ja`/`jb`/`r`.
 * Every exported gear joint became `{type:"g", bodyA:null, bodyB:null, ...}`
 * with no referents or ratio, so normalizeMap couldn't resolve jointA/jointB and
 * the P2 engine silently skipped the joint.
 *
 * These tests pin the exporter's gear `jointDef` shape (replicated here verbatim
 * from Webscripts/mapexporter.js), assert the shipped userscript source still
 * emits ja/jb/r, and round-trip the exported joints through normalizeMap →
 * PhysicsEngine.addJoint to prove the gear joint actually gets created.
 */

const MAPEXPORTER = path.join(process.cwd(), 'Webscripts', 'mapexporter.js');

/**
 * Replica of the mapexporter joint extraction (Webscripts/mapexporter.js
 * joints.forEach body). Kept in lockstep with the userscript so a change on
 * either side of the exporter contract fails this test loudly.
 */
function extractJoints(joints: any[]): any[] {
  const physicsJoints: any[] = [];
  joints.forEach((jt: any, i: number) => {
    if (!jt) {
      physicsJoints.push(null);
      return;
    }
    const jointDef: any = {
      index: i,
      type: jt.type ?? null,
      bodyA: jt.ba ?? null,
      bodyB: jt.bb ?? null,
      data: jt.d ? JSON.parse(JSON.stringify(jt.d)) : null,
      length: jt.l ?? null,
    };
    if (jt.type === 'rv') {
      if (jt.d) {
        jointDef.lowerAngle = jt.d.la ?? null;
        jointDef.upperAngle = jt.d.ua ?? null;
        jointDef.maxMotorTorque = jt.d.mmt ?? null;
        jointDef.motorSpeed = jt.d.ms ?? null;
        jointDef.enableLimit = jt.d.el ?? null;
        jointDef.enableMotor = jt.d.em ?? null;
        jointDef.collideConnected = jt.d.cc ?? null;
        jointDef.breakForce = jt.d.bf ?? null;
        jointDef.deleteOnBreak = jt.d.dl ?? null;
      }
      jointDef.anchorA = jt.aa ? { x: jt.aa[0], y: jt.aa[1] } : null;
    } else if (jt.type === 'd') {
      if (jt.d) {
        jointDef.frequencyHz = jt.d.fh ?? null;
        jointDef.dampingRatio = jt.d.dr ?? null;
        jointDef.collideConnected = jt.d.cc ?? null;
        jointDef.breakForce = jt.d.bf ?? null;
        jointDef.deleteOnBreak = jt.d.dl ?? null;
      }
      jointDef.anchorA = jt.aa ? { x: jt.aa[0], y: jt.aa[1] } : null;
      jointDef.anchorB = jt.ab ? { x: jt.ab[0], y: jt.ab[1] } : null;
    } else if (jt.type === 'lpj') {
      if (jt.d) {
        jointDef.collideConnected = jt.d.cc ?? null;
        jointDef.breakForce = jt.d.bf ?? null;
        jointDef.deleteOnBreak = jt.d.dl ?? null;
      }
      jointDef.anchorA = { x: jt.pax ?? 0, y: jt.pay ?? 0 };
      jointDef.angle = jt.pa ?? null;
      jointDef.lowerTranslation = jt.pf ?? null;
      jointDef.lowerLimit = jt.pl ?? null;
      jointDef.upperLimit = jt.pu ?? null;
      jointDef.length = jt.plen ?? null;
      jointDef.maxMotorForce = jt.pms ?? null;
    } else if (jt.type === 'lsj') {
      if (jt.d) {
        jointDef.collideConnected = jt.d.cc ?? null;
        jointDef.breakForce = jt.d.bf ?? null;
        jointDef.deleteOnBreak = jt.d.dl ?? null;
      }
      jointDef.anchorA = { x: jt.sax ?? 0, y: jt.say ?? 0 };
      jointDef.frequency = jt.sf ?? null;
      jointDef.length = jt.slen ?? null;
    } else if (jt.type === 'g') {
      jointDef.ja = jt.ja ?? null;
      jointDef.jb = jt.jb ?? null;
      jointDef.ratio = jt.r ?? 1;
    }
    physicsJoints.push(jointDef);
  });
  return physicsJoints;
}

/** Collect console.warn output during a callback, restoring the original after. */
function captureWarn(fn: () => void): string[] {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warnings.push(String(m));
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

describe('mapexporter gear joint emission (issue #285)', () => {
  it('extracts a native gear joint with ja/jb/ratio and no ba/bb (§33.8 tag 5)', () => {
    const nativeGear = { type: 'g', n: 'Gear Joint', ja: 0, jb: 1, r: 3 };
    const [joint] = extractJoints([nativeGear]);
    expect(joint.type).toBe('g');
    expect(joint.bodyA).toBeNull();
    expect(joint.bodyB).toBeNull();
    expect(joint.ja).toBe(0);
    expect(joint.jb).toBe(1);
    expect(joint.ratio).toBe(3);
  });

  it('shipped mapexporter.js still lists ja/jb/r/n and emits ja/jb/r for gear joints', () => {
    const source = fs.readFileSync(MAPEXPORTER, 'utf8');
    expect(source).toContain(`'ja','jb','r','n',`);
    expect(source).toContain(`} else if (jt.type === 'g') {`);
    expect(source).toContain(`jointDef.ja = jt.ja ?? null;`);
    expect(source).toContain(`jointDef.jb = jt.jb ?? null;`);
    expect(source).toContain(`jointDef.ratio = jt.r ?? 1;`);
  });

  it('round-trips an exported gear joint through normalizeMap into a working b2GearJoint', () => {
    const e = new PhysicsEngine();
    // Exporter output for a native joint list: two rv referents plus a gear
    // joint (which carries no ba/bb, only ja/jb/r).
    const exported = extractJoints([
      { type: 'rv', ba: 0, bb: 1, aa: [0, 0] },
      { type: 'rv', ba: 0, bb: 1, aa: [100, 0] },
      { type: 'g', ja: 0, jb: 1, r: 3 },
    ]);

    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: exported,
    } as any) as any;

    const gear = md.joints[2];
    expect(gear.type).toBe('g');
    expect(gear.jointA).toBe('joint_0');
    expect(gear.jointB).toBe('joint_1');
    expect(gear.ratio).toBe(3);
    // Bodies derived from the referent joints (native factory behavior), so the
    // engine's body resolution doesn't drop the gear joint.
    expect(gear.bodyA).toBe('wall');
    expect(gear.bodyB).toBe('gate');

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings).toHaveLength(0);

    const created = (e as any).createdJoints.get('joint_2');
    expect(created).toBeTruthy();
    expect(created.m_type).toBe(6); // b2Joint.e_gearJoint
    expect(created.m_ratio).toBe(3);
    expect(created.m_revolute1).toBe((e as any).createdJoints.get('joint_0'));
    expect(created.m_revolute2).toBe((e as any).createdJoints.get('joint_1'));
  });

  it('keeps a gear joint whose referent is anchored to the static ground (bodyA=-1)', () => {
    const e = new PhysicsEngine();
    // Native fixed-axle pattern: the first revolute referent is bolted to the
    // static ground body (ba = -1 per §33.8), so the gear's derived bodyA must
    // resolve to the synthetic ground body instead of being dropped.
    const exported = extractJoints([
      { type: 'rv', ba: -1, bb: 1, aa: [0, 0] },
      { type: 'rv', ba: 0, bb: 1, aa: [100, 0] },
      { type: 'g', ja: 0, jb: 1, r: 3 },
    ]);

    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: exported,
    } as any) as any;

    const gear = md.joints[2];
    expect(gear.jointA).toBe('joint_0');
    expect(gear.jointB).toBe('joint_1');
    expect(gear.ratio).toBe(3);
    expect(gear.bodyA).toBe(GROUND_BODY_NAME);
    expect(gear.bodyB).toBe('gate');

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings).toHaveLength(0);

    // The ground-anchored referent itself must have been created too.
    expect((e as any).createdJoints.get('joint_0')).toBeTruthy();
    const created = (e as any).createdJoints.get('joint_2');
    expect(created).toBeTruthy();
    expect(created.m_type).toBe(6); // b2Joint.e_gearJoint
    expect(created.m_ratio).toBe(3);
    expect(created.m_revolute1).toBe((e as any).createdJoints.get('joint_0'));
    expect(created.m_revolute2).toBe((e as any).createdJoints.get('joint_1'));
  });

  it('keeps a gear joint whose second referent is anchored to the static ground (bodyB=-1)', () => {
    const e = new PhysicsEngine();
    // Mirror of the A-side ground case: the second revolute referent is bolted
    // to the static ground body (bb = -1 per §33.8), exercising the engine's
    // bodyB === GROUND_BODY_NAME branch in addJoint.
    const exported = extractJoints([
      { type: 'rv', ba: 0, bb: 1, aa: [0, 0] },
      { type: 'rv', ba: 0, bb: -1, aa: [100, 0] },
      { type: 'g', ja: 0, jb: 1, r: 3 },
    ]);

    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: exported,
    } as any) as any;

    const gear = md.joints[2];
    expect(gear.jointA).toBe('joint_0');
    expect(gear.jointB).toBe('joint_1');
    expect(gear.ratio).toBe(3);
    expect(gear.bodyA).toBe('wall');
    expect(gear.bodyB).toBe(GROUND_BODY_NAME);

    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings).toHaveLength(0);

    // The ground-anchored referent itself must have been created too.
    expect((e as any).createdJoints.get('joint_1')).toBeTruthy();
    const created = (e as any).createdJoints.get('joint_2');
    expect(created).toBeTruthy();
    expect(created.m_type).toBe(6); // b2Joint.e_gearJoint
    expect(created.m_ratio).toBe(3);
    expect(created.m_revolute1).toBe((e as any).createdJoints.get('joint_0'));
    expect(created.m_revolute2).toBe((e as any).createdJoints.get('joint_1'));
  });

  it('treats a malformed negative referent body (e.g. -2) as unresolvable, not ground', () => {
    const e = new PhysicsEngine();
    const exported = extractJoints([
      { type: 'rv', ba: -2, bb: 1, aa: [0, 0] },
      { type: 'rv', ba: 0, bb: 1, aa: [100, 0] },
      { type: 'g', ja: 0, jb: 1, r: 3 },
    ]);

    const md = normalizeMap({
      bodies: [
        { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
        { bodyIndex: 1, name: 'gate', type: 'rect', x: 100, y: 0, width: 20, height: 20, static: false, density: 1 },
      ],
      spawns: [{ x: 0, y: 0, blue: true, red: true }],
      physicsJoints: exported,
    } as any) as any;

    // Only -1 is ground (§33.8); -2 must NOT bind to the ground body.
    expect(md.joints[0].bodyA).not.toBe(GROUND_BODY_NAME);
    expect(md.joints[2].bodyA).not.toBe(GROUND_BODY_NAME);
    // The malformed referent joint is dropped (unknown body warning), and the
    // gear then warns about its missing referent — never silently created.
    const bm = new Map<string, any>();
    for (const b of md.bodies) { e.addBody(b); bm.set(b.name, e.getBodyMap().get(b.name)); }
    const warnings = captureWarn(() => {
      for (const j of md.joints) { e.addJoint(j, bm); }
    });
    expect(warnings.some(w => /unknown body/.test(w))).toBe(true);
    expect((e as any).createdJoints.has('joint_2')).toBe(false);
  });
});
