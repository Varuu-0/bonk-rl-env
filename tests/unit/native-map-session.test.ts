import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createNativeMapSession,
  nativeMapToStaticArena,
  nativeMapToArena,
  NativeMapSessionError,
} from '../../src/core/native-map-session';
import { normalizeNativeMap } from '../../src/core/native-map-state';
import { safeCos, safeSin } from '../../src/core/safe-trig';

const training = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../maps/training-platform.json'), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function baseMap(): any {
  const raw = clone(training);
  return {
    ...raw,
    s: { ...raw.s, pq: 1 },
    m: { ...raw.m, mo: 'b' },
    physics: {
      ...raw.physics,
      ppm: 10,
      shapes: [shape('bx')],
      fixtures: [{ ...raw.physics.fixtures[0], sh: 0, fr: null, fp: null, re: null, de: null, f: 123456 }],
      bodies: [
        {
          ...raw.physics.bodies[0],
          p: [-80, 30],
          a: 0.21,
          fx: [0],
          s: { ...raw.physics.bodies[0].s, fric: 0.45, fricp: false, re: 0.7, de: 2 },
        },
      ],
      bro: [0],
      joints: [],
    },
    spawns: [
      { ...raw.spawns[0], x: -111, y: 37, xv: 44, yv: -22, priority: 7, f: true, r: true, b: true, gr: true, ye: true },
    ],
  };
}

function shape(type: string, values: Record<string, unknown> = {}): any {
  if (type === 'ci') return { type, c: [20, -10], r: 25, sk: false, ...values };
  if (type === 'po')
    return {
      type,
      c: [5, 10],
      a: -0.41,
      s: 0.75,
      v: [
        [-30, -20],
        [35, -20],
        [35, 30],
        [0, 8],
        [-30, 30],
      ],
      sk: false,
      ...values,
    };
  return { type: 'bx', c: [12, -7], a: 0.37, w: 140, h: 24, sk: false, ...values };
}

function withShape(map: any, value: any): any {
  map.physics.shapes[0] = value;
  return map;
}

function expectUnsupported(map: any, path: string | RegExp): void {
  try {
    nativeMapToStaticArena(map);
  } catch (error) {
    expect(error).toBeInstanceOf(NativeMapSessionError);
    expect((error as NativeMapSessionError).code).toBe('UNSUPPORTED_STATIC_CLASSIC_MAP');
    if (typeof path === 'string') expect((error as NativeMapSessionError).path).toContain(path);
    else expect((error as NativeMapSessionError).path).toMatch(path);
    return;
  }
  throw new Error(`Expected unsupported map at ${String(path)}`);
}

describe('strict native raw-map static Classic arena', () => {
  it('uses exact spawn conversion and preserves raw inputs', () => {
    const map = baseMap();
    const before = JSON.stringify(map);
    const arena = nativeMapToStaticArena(map);
    expect(arena.spawns[0]).toEqual({
      x: (-111 + 365) / 10,
      y: (37 + 250) / 10,
      xv: 4.4,
      yv: -2.2,
      priority: 7,
      ffa: true,
      red: true,
      blue: true,
      green: true,
      yellow: true,
      n: 'Left Spawn',
    });
    expect(arena.ppm).toBe(10);
    expect(arena.settings).toEqual({ respawn: false, noCollision: false, fly: false, quality: 1 });
    expect(JSON.stringify(map)).toBe(before);
    expect(Object.isFrozen(arena.spawns[0])).toBe(true);
  });

  it('converts a transformed box using native body-local geometry and inherited materials', () => {
    const arena = nativeMapToStaticArena(baseMap());
    const p = arena.platforms[0]!;
    expect(p).toMatchObject({
      id: 0,
      bodyId: 0,
      shape: 'box',
      width: 14,
      height: 2.4,
      bodyX: 28.5,
      bodyY: 28,
      bodyAngle: 0.21,
      localX: 1.2,
      localY: -0.7,
      localAngle: 0.37,
      angle: 0.58,
      x: 28.5 + safeCos(0.21) * 1.2 - safeSin(0.21) * -0.7,
      y: 28 + safeSin(0.21) * 1.2 + safeCos(0.21) * -0.7,
      friction: 0.45,
      restitution: 0.7,
      lethal: false,
      color: 123456,
    });
  });

  it('uses normalized SafeTrig polygon vertices without applying c/a twice', () => {
    const map = withShape(baseMap(), shape('po'));
    const arena = nativeMapToStaticArena(map);
    const polygon = normalizeNativeMap(map).shapes[0]!;
    expect(polygon.type).toBe('po');
    const p = arena.platforms[0]!;
    expect(p.shape).toBe('polygon');
    expect(p.vertices).toEqual(polygon.type === 'po' ? polygon.v : []);
    expect(p.localX).toBe(0);
    expect(p.localY).toBe(0);
    expect(p.localAngle).toBe(0);
    expect(p.angle).toBe(0.21);
    expect(p.vertices!.length).toBe(5); // Deliberately concave: no convexification.
  });

  it('retains sparse shape/fixture/body IDs, shared-body fixtures and native body order', () => {
    const map = baseMap();
    const body = map.physics.bodies[0];
    map.physics.shapes = [null, shape('ci'), shape('bx', { c: [-40, 20], a: -0.3 }), null, shape('po')];
    map.physics.fixtures = [
      null,
      { ...map.physics.fixtures[0], sh: 1 },
      { ...map.physics.fixtures[0], sh: 2, fr: 0.2, fp: false, re: 0.3 },
      null,
      { ...map.physics.fixtures[0], sh: 4, fr: null, fp: null, re: null },
    ];
    map.physics.bodies = [
      null,
      { ...body, p: [-80, 30], fx: [1, 2] },
      null,
      { ...body, p: [100, -40], a: -0.2, fx: [4] },
    ];
    map.physics.bro = [3, 1];
    const arena = nativeMapToStaticArena(map);
    expect(arena.platforms.map((p) => [p.id, p.bodyId])).toEqual([
      [1, 1],
      [2, 1],
      [4, 3],
    ]);
    expect(arena.platforms[0]).toMatchObject({
      shape: 'circle',
      radius: 2.5,
      localX: 2,
      localY: -1,
      friction: 0.45,
      restitution: 0.7,
    });
    expect(arena.platforms[1]).toMatchObject({ shape: 'box', friction: 0.2, restitution: 0.3 });
    expect(arena.platforms[2]).toMatchObject({ shape: 'polygon', bodyX: 46.5, bodyY: 21, bodyAngle: -0.2 });
    expect(() => createNativeMapSession({ map, players: [{ id: 17, team: 1 }], seed: 1 }).dispose()).not.toThrow();
  });

  it('creates a functioning sparse-ID native session from raw JSON', () => {
    const map = baseMap();
    map.spawns.push({ ...map.spawns[0], x: 80, priority: 4, n: 'other' });
    const session = createNativeMapSession({
      map,
      players: [
        { id: 19, team: 1 },
        { id: 3, team: 1 },
      ],
      seed: 1,
      countdownTicks: 5,
    });
    const state = session.getState();
    expect(state.discs.map((disc) => disc?.id).filter((id) => id !== undefined)).toHaveLength(2);
    expect(state.discs[19]?.x).toBe(state.discs[19]?.sx);
    expect(state.discs[3]?.x).toBe(state.discs[3]?.sx);
    expect(state.discs[19]?.x).not.toBe(state.discs[3]?.x);
    expect(session.arena).toEqual(nativeMapToStaticArena(map));
    expect(session.step({ 19: 2, 3: 1 }).tick).toBe(1);
    session.dispose();
    expect(session.getState().discs).toHaveLength(0);
  });

  it('does not substitute an empty map, fallback spawn or second fixture owner', () => {
    const noBodies = baseMap();
    noBodies.physics.bodies = [];
    noBodies.physics.bro = [];
    expectUnsupported(noBodies, 'physics.bodies');
    const noSpawns = baseMap();
    noSpawns.spawns = [];
    expectUnsupported(noSpawns, 'spawns');
    const duplicate = baseMap();
    duplicate.physics.bodies.push({ ...duplicate.physics.bodies[0], fx: [0] });
    duplicate.physics.bro = [0, 1];
    expectUnsupported(duplicate, 'physics.bodies[1].fx');
  });

  it.each([
    [
      'dynamic body',
      (map: any) => {
        map.physics.bodies[0].s.type = 'd';
      },
      '.s.type',
    ],
    [
      'kinematic body',
      (map: any) => {
        map.physics.bodies[0].s.type = 'k';
      },
      '.s.type',
    ],
    [
      'active force',
      (map: any) => {
        map.physics.bodies[0].s.type = 'd';
        map.physics.bodies[0].cf.x = 10;
      },
      '.cf',
    ],
    [
      'force zone',
      (map: any) => {
        map.physics.bodies[0].fz.on = true;
      },
      'STATIC_FZ_DYNAMIC_BACKEND',
    ],
    [
      'shrink',
      (map: any) => {
        map.physics.shapes[0].sk = true;
      },
      '.sk',
    ],
    [
      'nonphysical',
      (map: any) => {
        map.physics.fixtures[0].np = true;
      },
      '.np',
    ],
    [
      'no grapple',
      (map: any) => {
        map.physics.fixtures[0].ng = true;
      },
      '.ng',
    ],
    [
      'inner grapple',
      (map: any) => {
        map.physics.fixtures[0].ig = true;
      },
      '.ig',
    ],
    [
      'cap zone',
      (map: any) => {
        map.capZones = [{ n: 'zone', ty: 1, l: 10, i: 0 }];
      },
      'capZones',
    ],
    [
      'category',
      (map: any) => {
        map.physics.bodies[0].s.f_c = 2;
      },
      '.f_c',
    ],
    [
      'player mask',
      (map: any) => {
        map.physics.bodies[0].s.f_p = false;
      },
      '.f_p',
    ],
    [
      'category mask',
      (map: any) => {
        map.physics.bodies[0].s.f_3 = false;
      },
      '.f_3',
    ],
    [
      'friction above one',
      (map: any) => {
        map.physics.fixtures[0].fr = 1.5;
      },
      '.fr/fp',
    ],
    [
      'negative restitution',
      (map: any) => {
        map.physics.fixtures[0].re = -0.5;
      },
      '.re',
    ],
    [
      'chain',
      (map: any) => {
        map.physics.shapes[0] = shape('po', { type: 'ch', l: false });
      },
      'Invalid native map state',
    ],
    [
      'joint',
      (map: any) => {
        map.physics.joints = [
          {
            type: 'rv',
            ba: 0,
            bb: -1,
            aa: [0, 0],
            d: { cc: false, bf: 0, dl: true, la: 0, ua: 0, el: false, em: false, ms: 0, mmt: 0 },
          },
        ];
      },
      'physics.joints',
    ],
    [
      'degenerate polygon',
      (map: any) => {
        map.physics.shapes[0] = shape('po', {
          v: [
            [0, 0],
            [10, 0],
          ],
        });
      },
      '.v',
    ],
    [
      'incomplete bro',
      (map: any) => {
        map.physics.bro = [];
      },
      'physics.bro',
    ],
    [
      'duplicate bro',
      (map: any) => {
        map.physics.bro = [0, 0];
      },
      'physics.bro',
    ],
    [
      'foot sound',
      (map: any) => {
        map.physics.fixtures[0].fs = 'metal';
      },
      '.fs',
    ],
    [
      'platform zone metadata',
      (map: any) => {
        map.physics.fixtures[0].zp = 2;
      },
      '.zp',
    ],
  ])('rejects %s without silently dropping it', (_name, mutate, path) => {
    const map = baseMap();
    mutate(map);
    if (path === 'Invalid native map state') expect(() => nativeMapToStaticArena(map)).toThrow(path);
    else if (path === 'STATIC_FZ_DYNAMIC_BACKEND') {
      try {
        nativeMapToStaticArena(map);
        throw new Error('Expected static force-zone rejection');
      } catch (error) {
        expect(error).toMatchObject({ code: 'UNSUPPORTED_STATIC_CLASSIC_MAP', path: 'physics.bodies[0].fz.on' });
      }
    } else expectUnsupported(map, path);
  });

  it('rejects force zones at the static seam and routes them to the dynamic backend', () => {
    const map = baseMap();
    map.physics.bodies[0].fz.on = true;
    // The static converter still rejects: fz requires contact-time force
    // injection owned by the unified dynamic world (original :4940-4995).
    try {
      nativeMapToStaticArena(map);
      throw new Error('Expected static active force-zone rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMapSessionError);
      expect(error).toMatchObject({ code: 'UNSUPPORTED_STATIC_CLASSIC_MAP', path: 'physics.bodies[0].fz.on' });
    }
    // The arena converter routes the map to the unified dynamic backend.
    const arena = nativeMapToArena(map);
    expect(arena.settings).toBeDefined();
    expect((arena as any).platforms).toBeUndefined();
  });

  it('preserves signed friction and restitution above one through conversion and stepping', () => {
    const map = baseMap();
    map.physics.bodies[0].s.fricp = true;
    map.physics.fixtures[0].re = 1.25;
    const arena = nativeMapToStaticArena(map);
    expect(arena.platforms[0]).toMatchObject({ friction: -0.45, restitution: 1.25 });
    map.physics.fixtures[0].fr = -0.3;
    map.physics.fixtures[0].fp = false;
    const session = createNativeMapSession({ map, players: [{ id: 0, team: 1 }], seed: 1 });
    expect(session.arena.platforms[0]).toMatchObject({ friction: -0.3, restitution: 1.25 });
    expect(session.step({ 0: 0 }).tick).toBe(1);
    session.dispose();
  });

  it('accepts default friction polarity and does not validate discarded raw static velocity as motion', () => {
    const map = baseMap();
    map.physics.bodies[0].lv = [123, -456];
    map.physics.bodies[0].av = 3;
    map.physics.bodies[0].cf = { x: 99, y: -99, ct: 7, w: false };
    map.physics.fixtures[0].fp = false;
    const arena = nativeMapToStaticArena(map);
    expect(arena.platforms[0]!.friction).toBe(0.45);
    expect(arena.platforms[0]!.bodyAngle).toBe(0.21);
  });

  it('rejects malformed native JSON at the codec boundary', () => {
    expect(() => nativeMapToStaticArena({ ...baseMap(), physicsBodies: [] })).toThrow('unknown native map field');
    expect(() => nativeMapToStaticArena(null)).toThrow('must be an object');
  });

  it('treats map m.mo as display metadata and routes sp/bs dynamic maps through the unified world', () => {
    // Native evidence: m.mo never selects physics (readable :27591 UI,
    // :11269/:11525 serialization, :33953 editor; room gameSettings.mo
    // :5017/:28978/:29448 is the sole mode source). A map authored for
    // another mode runs under any room mode.
    const targeted = baseMap();
    targeted.m.mo = 'ard';
    expect(() => nativeMapToStaticArena(targeted)).not.toThrow();
    expect(() => nativeMapToArena(targeted)).not.toThrow();
    const session = createNativeMapSession({ map: targeted, players: [{ id: 0, team: 1 }], seed: 1 });
    session.dispose();
    // sp/bs with a dynamic body: the unified world owns the mode mechanics.
    const dynamic = baseMap();
    dynamic.m.mo = 'sp';
    dynamic.physics.bodies[0].s.type = 'd';
    for (const mode of ['sp', 'bs'] as const) {
      const modeSession = createNativeMapSession({ map: dynamic, players: [{ id: 0, team: 1 }], seed: 1, mode });
      expect(modeSession.arena).toHaveProperty('physics');
      modeSession.step({ 0: 0 });
      modeSession.dispose();
    }
    // The default mode b keeps the dynamic unified-world routing as before.
    const classic = createNativeMapSession({ map: dynamic, players: [{ id: 0, team: 1 }], seed: 1 });
    expect(classic.arena).toHaveProperty('physics');
    classic.step({ 0: 0 });
    classic.dispose();
  });
});
