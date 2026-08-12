import { describe, it, expect } from 'vitest';
import { extractMap } from '../../Webscripts/mapexporter.js';

/**
 * mapexporter joint-field mapping (issue #281).
 *
 * The exporter's `extractMap` is exported for Node tests (the browser-only UI
 * bootstrap is skipped when `window`/`document` are absent), so the exact
 * native → exported field mapping for lpj/lsj joints is verified directly:
 * native pf → maxMotorForce, pms → motorSpeed, plen/slen → ±travel limits,
 * with sign-clamped travel so the limit range can never invert.
 */

function extractWithJoint(joint: Record<string, unknown>): any {
  return extractMap({
    physics: {
      ppm: 30,
      bodies: [],
      joints: [joint],
    },
  } as any);
}

describe('mapexporter joint export (issue #281)', () => {
  it('maps a native lpj to a driven, limited prismatic joint', () => {
    const mapDef = extractWithJoint({
      type: 'lpj',
      ba: 0, bb: 1,
      pa: Math.PI / 2,
      pax: 0, pay: 0,
      plen: 50,
      pf: 1000,
      pms: 3,
    });
    const j = mapDef.physicsJoints[0];
    expect(j.type).toBe('lpj');
    expect(j.lowerTranslation).toBe(-50);
    expect(j.upperTranslation).toBe(50);
    expect(j.enableLimit).toBe(true);
    expect(j.enableMotor).toBe(true);
    expect(j.maxMotorForce).toBe(1000);
    expect(j.motorSpeed).toBe(3);
    expect(j.lowerTranslation).toBeLessThan(j.upperTranslation);
  });

  it('sign-clamps a negative native lpj plen so the limit range never inverts', () => {
    const mapDef = extractWithJoint({
      type: 'lpj',
      ba: 0, bb: 1,
      pa: Math.PI / 2,
      pax: 0, pay: 0,
      plen: -50,
      pf: 1000,
      pms: 3,
    });
    const j = mapDef.physicsJoints[0];
    expect(j.lowerTranslation).toBe(-50);
    expect(j.upperTranslation).toBe(50);
    expect(j.enableLimit).toBe(true);
    expect(j.lowerTranslation).toBeLessThan(j.upperTranslation);
  });

  it('does not enable the limit when plen is missing or zero (keeps pistons unconstrained)', () => {
    const missing = extractWithJoint({
      type: 'lpj',
      ba: 0, bb: 1,
      pa: 0,
      pax: 0, pay: 0,
      pf: 100,
      pms: 2,
    });
    const zero = extractWithJoint({
      type: 'lpj',
      ba: 0, bb: 1,
      pa: 0,
      pax: 0, pay: 0,
      plen: 0,
      pf: 100,
      pms: 2,
    });
    for (const j of [missing.physicsJoints[0], zero.physicsJoints[0]]) {
      expect(j.enableLimit).toBe(false);
      expect(j.lowerTranslation).toBeCloseTo(0, 5);
      expect(j.upperTranslation).toBeCloseTo(0, 5);
      expect(j.enableMotor).toBe(true);
      expect(j.lowerTranslation).toBeLessThanOrEqual(j.upperTranslation);
    }
  });

  it('never emits an inverted or locked limit range for any native plen (issue #281)', () => {
    // Table-driven property check mirroring the review finding: a negative,
    // missing or zero plen must never produce lower > upper, and the limit is
    // only enabled when there is positive travel.
    const cases: Array<{ plen?: unknown; enableLimit: boolean; lower: number; upper: number }> = [
      { plen: undefined, enableLimit: false, lower: 0, upper: 0 },
      { plen: 0, enableLimit: false, lower: 0, upper: 0 },
      { plen: 50, enableLimit: true, lower: -50, upper: 50 },
      { plen: -50, enableLimit: true, lower: -50, upper: 50 },
      { plen: -1000, enableLimit: true, lower: -1000, upper: 1000 },
    ];
    for (const c of cases) {
      const joint: Record<string, unknown> = {
        type: 'lpj',
        ba: 0, bb: 1,
        pa: 0,
        pax: 0, pay: 0,
        pf: 100,
        pms: 2,
      };
      if (c.plen !== undefined) joint.plen = c.plen;
      const j = extractWithJoint(joint).physicsJoints[0];
      expect(j.enableLimit).toBe(c.enableLimit);
      expect(j.lowerTranslation).toBeCloseTo(c.lower, 5);
      expect(j.upperTranslation).toBeCloseTo(c.upper, 5);
      expect(j.lowerTranslation).toBeLessThanOrEqual(j.upperTranslation);
    }
  });

  it('maps a native lsj to a driven vertical-axis prismatic joint with sign-clamped travel', () => {
    const mapDef = extractWithJoint({
      type: 'lsj',
      ba: 0, bb: 1,
      sax: 0, say: 0,
      slen: -40,
      sf: 25,
    });
    const j = mapDef.physicsJoints[0];
    expect(j.type).toBe('lsj');
    expect(j.axis).toEqual({ x: 0, y: 1 });
    expect(j.lowerTranslation).toBe(-40);
    expect(j.upperTranslation).toBe(40);
    expect(j.enableLimit).toBe(false);
    expect(j.enableMotor).toBe(true);
    expect(j.motorSpeed).toBe(300);
    expect(j.maxMotorForce).toBe(25);
    expect(j.lowerTranslation).toBeLessThan(j.upperTranslation);
  });
});
