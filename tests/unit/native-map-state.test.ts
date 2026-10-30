import { describe, expect, it } from 'vitest';
import { normalizeNativeMap, cloneNativeMapPhysics, type NativeMapSource } from '../../src/core/native-map-state';
import { safeCos, safeSin, safeTan, safeATan2 } from '../../src/core/safe-trig';

function fixture(overrides: Record<string, unknown> = {}): any {
  return {
    sh: 0,
    n: 'f',
    fr: null,
    fp: null,
    re: null,
    de: null,
    f: 123,
    d: false,
    np: false,
    ng: false,
    ig: false,
    ...overrides,
  };
}
function body(overrides: Record<string, unknown> = {}): any {
  return {
    s: {
      type: 'd',
      n: 'b',
      fric: 0.4,
      fricp: false,
      re: 0.2,
      de: 1,
      ld: 0.1,
      ad: 0.2,
      fr: false,
      bu: true,
      f_c: 1,
      f_p: true,
      f_1: true,
      f_2: true,
      f_3: true,
      f_4: true,
    },
    p: [0, 0],
    a: 0,
    lv: [1, 2],
    av: 3,
    cf: { x: 30, y: -60, ct: 90, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    fx: [0],
    ...overrides,
  };
}
function source(overrides: Record<string, unknown> = {}): NativeMapSource {
  return {
    physics: {
      ppm: 10,
      shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 20, h: 10, sk: false }],
      fixtures: [fixture()],
      bodies: [body()],
      joints: [],
      bro: [0],
      ss: [],
      ...overrides,
    },
  } as NativeMapSource;
}
function joint(overrides: Record<string, unknown> = {}): any {
  return {
    type: 'rv',
    ba: 0,
    bb: -1,
    aa: [10, 20],
    ab: [0, 0],
    d: { cc: false, bf: 0, el: false, la: -1, ua: 1, em: false, ms: 2, mmt: 3 },
    ...overrides,
  };
}

describe('native map normalization', () => {
  it('converts bodies and constant-force carriers without mutating authored input', () => {
    const raw = source();
    const before = JSON.stringify(raw);
    const state = normalizeNativeMap(raw);
    expect(state.ppm).toBe(10);
    expect(state.bodies[0]).toMatchObject({ p: [36.5, 25], lv: [1, 2], av: 3, cf: { x: 1, y: -2, ct: 3, w: true } });
    expect(state.bodies[0]?.s).toMatchObject({ type: 'd', fric: 0.4, de: 1, bu: true });
    expect(JSON.stringify(raw)).toBe(before);
    expect(state.bodies[0]).not.toBe((raw.physics.bodies as any[])[0]);
  });

  it('uses native fallback ppm and clears static velocity/force after validating it', () => {
    const raw = source({ ppm: 1, bodies: [body({ p: [10, 20], lv: [7, 8], av: 9, s: { ...body().s, type: 's' } })] });
    const state = normalizeNativeMap(raw);
    expect(state.ppm).toBe(15);
    expect(state.bodies[0]?.p).toEqual([25, 18]);
    expect(state.bodies[0]?.lv).toEqual([0, 0]);
    expect(state.bodies[0]?.av).toBe(0);
    expect(state.bodies[0]?.cf).toMatchObject({ x: 0, y: 0, ct: 0, w: true });
  });

  it('bakes polygon scale, safe angle and centre and removes adjacent duplicates', () => {
    const raw = source({
      shapes: [
        {
          type: 'po',
          c: [10, 20],
          a: Math.PI / 2,
          s: 2,
          v: [
            [0, 0],
            [10, 0],
            [10, 0],
            [10, 20],
          ],
          sk: false,
        },
      ],
    });
    const shape = normalizeNativeMap(raw).shapes[0]!;
    expect(shape.type).toBe('po');
    if (shape.type !== 'po') throw new Error('unreachable');
    const cos = safeCos(Math.PI / 2);
    const sin = safeSin(Math.PI / 2);
    expect(shape.v).toEqual([
      [1, 2],
      [cos * 2 + 1, sin * 2 + 2],
      [cos * 2 - sin * 4 + 1, sin * 2 + cos * 4 + 2],
    ]);
    expect(shape.c).toEqual([1, 2]);
  });

  it('normalizes revolute anchors into body-local coordinates and native motor polarity', () => {
    const a = 0.25;
    const b = -0.5;
    const raw = source({
      bodies: [body({ a, p: [0, 0] }), body({ a: b, p: [20, 30], fx: [0] })],
      joints: [joint({ ba: 0, bb: 1, aa: [10, 20] })],
    });
    const normalized = normalizeNativeMap(raw);
    const result = normalized.joints[0]! as Extract<
      import('../../src/core/native-map-state').NativeJoint,
      { type: 'rv' }
    >;
    expect(result.type).toBe('rv');
    const world = [36.5 + 1, 25 + 2];
    const relative = [world[0] - 38.5, world[1] - 28];
    const aa = [safeCos(-a) - safeSin(-a) * 2, safeSin(-a) + safeCos(-a) * 2];
    const ab = [
      safeCos(-b) * relative[0] - safeSin(-b) * relative[1],
      safeSin(-b) * relative[0] + safeCos(-b) * relative[1],
    ];
    expect(result.aa[0]).toBeCloseTo(aa[0], 14);
    expect(result.aa[1]).toBeCloseTo(aa[1], 14);
    expect(result.ab[0]).toBeCloseTo(ab[0], 14);
    expect(result.ab[1]).toBeCloseTo(ab[1], 14);
    expect(result).toMatchObject({ ra: b - a, d: { la: -1, ua: 1, ms: -2 } });
  });

  it('normalizes -2 endpoints to ground and preserves explicit holes/null slots', () => {
    const shapes: any[] = new Array(4);
    shapes[1] = { type: 'ci', c: [0, 0], a: 0, r: 10, sk: false };
    shapes[3] = null;
    const raw = source({
      shapes,
      fixtures: [null, fixture({ sh: 1 })],
      bodies: [null, body({ fx: [1] })],
      bro: [1],
      joints: [null, joint({ ba: -2, bb: 1 })],
    });
    const state = normalizeNativeMap(raw);
    expect(state.shapes).toHaveLength(4);
    expect(0 in state.shapes).toBe(false);
    expect(state.shapes[3]).toBeNull();
    expect(state.joints[0]).toBeNull();
    expect(state.joints[1]).toMatchObject({ ba: -1, bb: 1 });
  });

  it('derives distance length/frequency and applies the ground-anchor origin convention', () => {
    const raw = source({
      joints: [
        joint({ type: 'd', ba: -1, bb: 0, aa: [0, 0], ab: [-365, -250], d: { cc: false, bf: 0, fh: 2, dr: 0.7 } }),
      ],
    });
    const state = normalizeNativeMap(raw);
    expect(state.joints[0]).toMatchObject({ type: 'd', ab: [-36.5, -25], d: { fh: 0.5, dr: 0.7 } });
    // Ground A is (0,0), while the authored ground B anchor receives the
    // native origin offset before both world anchor points are measured.
    expect((state.joints[0] as any).len).toBe(0.01);
  });

  it('normalizes prismatic force, limits, axis and persistent motor fields', () => {
    const raw = source({
      bodies: [body({ a: 0.5 })],
      joints: [
        joint({
          type: 'p',
          ba: 0,
          bb: -1,
          aa: [0, 0],
          ab: [0, 0],
          axa: [0, 1],
          cs: 2,
          d: { cc: true, bf: 100, el: true, lt: -20, ut: 40, em: true, ms: 2, mmf: 500, cd: true },
        }),
      ],
    });
    const result = normalizeNativeMap(raw).joints[0]!;
    expect(result.type).toBe('p');
    if (result.type !== 'p') throw new Error('unreachable');
    expect(result.axa[0]).toBe(1);
    expect(result.axa[1]).toBe(safeTan(safeATan2(1, 0) - 0.5));
    expect(result.d.lt).toBe(-2);
    expect(result.d.ut).toBe(4);
    expect(result.d.ms).toBeCloseTo(2.4, 14);
    expect(result.d.bf).toBe(1);
    expect(result.d.cd).toBe(true);
    expect(result.d.mmf).toBeCloseTo((500 / 1000) * 17280, 12);
    expect(result.cs).toBe(0);
    expect(result.ra).toBe(-0.5);
  });

  it('retains native joint presentation metadata without inventing defaults', () => {
    const variants = [
      joint({ d: { ...joint().d, dl: false } }),
      joint({
        type: 'p',
        n: 'authored prism',
        aa: [0, 0],
        ab: [0, 0],
        axa: [0, 1],
        d: { cc: false, bf: 0, el: false, lt: 0, ut: 10, em: false, ms: 0, mmf: 0, cd: false, dl: true },
      }),
      joint({ type: 'd', d: { cc: false, bf: 0, fh: 2, dr: 0.7, dl: false } }),
    ];
    const normalized = normalizeNativeMap(source({ joints: variants }));
    expect(normalized.joints.map((entry) => entry?.d.dl)).toEqual([false, true, false]);
    expect(normalized.joints[1]).toMatchObject({ type: 'p', n: 'authored prism' });
    const optional = joint({
      type: 'p',
      aa: [0, 0],
      ab: [0, 0],
      axa: [0, 1],
      d: { cc: false, bf: 0, el: false, lt: 0, ut: 10, em: false, ms: 0, mmf: 0, cd: false },
    });
    const retained = normalizeNativeMap(source({ joints: [optional] })).joints[0]!;
    expect('dl' in retained.d).toBe(false);
    expect('n' in retained).toBe(false);
    expect(
      normalizeNativeMap({ physics: { ...normalizeNativeMap(source({ joints: variants })) } }, { authored: false })
        .joints,
    ).toEqual(normalized.joints);
    expect(() => normalizeNativeMap(source({ joints: [joint({ d: { ...joint().d, dl: 1 } })] }))).toThrow(
      /d\.dl must be boolean/,
    );
    expect(() => normalizeNativeMap(source({ joints: [{ ...optional, n: 3 }] }))).toThrow(/\.n must be a string/);
  });

  it('validates normalized state without scaling it twice and deep-clones carriers', () => {
    const state = normalizeNativeMap(source({ shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 20, h: 10, sk: true }] }));
    state.ftu = -1;
    state.ss = [[0, 5]];
    const clone = normalizeNativeMap({ physics: state }, { authored: false });
    expect(clone).toEqual(state);
    expect(clone).not.toBe(state);
    expect(clone.ss[0]).not.toBe(state.ss[0]);
    const clonedAgain = cloneNativeMapPhysics(clone);
    clonedAgain.bodies[0]!.lv = [99, 99];
    expect(clone.bodies[0]?.lv).toEqual([1, 2]);
  });

  it('retains disabled and active force zones for contact-time application', () => {
    expect(normalizeNativeMap(source()).bodies[0]?.fz.on).toBe(false);
    // lpj/lsj are now normalized (native createNewState :4302-4322); only the
    // gear joint remains rejected here.
    expect(() => normalizeNativeMap(source({ joints: [joint({ type: 'g' })] }))).toThrow(/g is unsupported/);
    const active = normalizeNativeMap(source({ bodies: [body({ fz: { ...body().fz, on: true } })] }));
    expect(active.bodies[0]?.fz.on).toBe(true);
    expect(() => normalizeNativeMap(source({ shapes: [{ type: 'ch', c: [0, 0], a: 0, sk: false, v: [] }] }))).toThrow(
      /chain shapes/,
    );
  });

  it('normalizes lpj and lsj joints with createNewState unit conversions', () => {
    // Native createNewState (:4302-4322): pax/pay := body ba position (already
    // normalized metres), plen/pms/slen /= ppm, pf/sf /= ppm².
    const raw = source({
      bodies: [body({ p: [30, 40], fx: [0] })],
      joints: [
        joint({ type: 'lpj', ba: 0, bb: -1, pax: 5, pay: 6, pa: 0.7, pf: 900, pl: 1, pu: 2, plen: 60, pms: 30 }),
        joint({ type: 'lsj', ba: 0, bb: -1, sax: 5, say: 6, sf: 250, slen: 45 }),
      ],
    });
    const state = normalizeNativeMap(raw);
    const lpj = state.joints[0]!;
    expect(lpj.type).toBe('lpj');
    if (lpj.type !== 'lpj') throw new Error('unreachable');
    // Body 0 authored p is (30+365)/ppm, (40+250)/ppm — the same normalized
    // position the native createNewState writes into pax/pay.
    expect(lpj.pax).toBeCloseTo((30 + 365) / 10, 14);
    expect(lpj.pay).toBeCloseTo((40 + 250) / 10, 14);
    expect(lpj.pa).toBe(0.7);
    expect(lpj.pf).toBeCloseTo(900 / 100, 14);
    expect(lpj.pl).toBe(1);
    expect(lpj.pu).toBe(2);
    expect(lpj.plen).toBeCloseTo(60 / 10, 14);
    expect(lpj.pms).toBeCloseTo(30 / 10, 14);
    const lsj = state.joints[1]!;
    expect(lsj.type).toBe('lsj');
    if (lsj.type !== 'lsj') throw new Error('unreachable');
    expect(lsj.sax).toBeCloseTo((30 + 365) / 10, 14);
    expect(lsj.say).toBeCloseTo((40 + 250) / 10, 14);
    expect(lsj.sf).toBeCloseTo(250 / 100, 14);
    expect(lsj.slen).toBeCloseTo(45 / 10, 14);
    // Stepped states round-trip verbatim without a second scaling.
    const stepped = normalizeNativeMap({ physics: state }, { authored: false });
    expect(stepped.joints).toEqual(state.joints);
    // lpj/lsj joints clone without aa/ab/axa carriers.
    const cloned = cloneNativeMapPhysics(state);
    expect(cloned.joints[0]).toEqual(state.joints[0]);
    expect(cloned.joints[1]).toEqual(state.joints[1]);
  });

  it('rejects malformed references, duplicate shrink carriers and non-finite values before simulation', () => {
    expect(() => normalizeNativeMap(source({ bodies: [body({ fx: [1] })] }))).toThrow(/missing fixture/);
    expect(() => normalizeNativeMap(source({ bodies: [body({ lv: [NaN, 0] })] }))).toThrow(/finite/);
    expect(() =>
      normalizeNativeMap(
        source({
          shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 20, h: 10, sk: true }],
          ss: [
            [0, 2],
            [0, 3],
          ],
        }),
      ),
    ).toThrow(/duplicate/);
  });
});
