import { describe, expect, it, vi } from 'vitest';
import { createNativeMapSession, nativeMapToArena, nativeMapToStaticArena } from '../../src/core/native-map-session';
import { normalizeNativeMap } from '../../src/core/native-map-state';
import type { NativeDynamicArena, NativeStaticArena } from '../../src/core/native-session';

function fixture(sh: number, extra: Record<string, unknown> = {}): any {
  return {
    sh,
    n: `f${sh}`,
    fr: null,
    fp: null,
    re: null,
    de: null,
    f: 0xabcdef,
    d: false,
    np: false,
    ng: false,
    ig: false,
    ...extra,
  };
}
function body(type: string, p: number[], fx: number[], extra: Record<string, unknown> = {}): any {
  return {
    s: {
      type,
      n: `b${fx[0]}`,
      fric: 0.5,
      fricp: false,
      re: 0.2,
      de: 1,
      ld: 0,
      ad: 0,
      fr: false,
      bu: false,
      f_c: 1,
      f_p: true,
      f_1: true,
      f_2: true,
      f_3: true,
      f_4: true,
    },
    p,
    a: 0,
    lv: [0, 0],
    av: 0,
    cf: { x: 0, y: 0, ct: 0, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    fx,
    ...extra,
  };
}
function box(c: number[], w: number, h: number): any {
  return { type: 'bx', c, a: 0, w, h, sk: false };
}
function spawn(x: number, y: number, n: string): any {
  return { x, y, xv: 0, yv: 0, priority: 1, r: true, f: true, b: true, gr: false, ye: false, n };
}
function mapFor(name: 'moving-platform' | 'lethal-moving-fixture' | 'timed-capture' | 'instant-goal'): any {
  const map: any = {
    v: 15,
    s: { re: false, nc: false, fl: false, pq: 1, gd: 25 },
    physics: { ppm: 10, shapes: [], fixtures: [], bodies: [], joints: [], bro: [] },
    spawns: [],
    capZones: [],
    m: {
      a: 'validation',
      n: 'dynamic session',
      dbv: 2,
      dbid: -1,
      authid: -1,
      date: '',
      rxid: 0,
      rxn: '',
      rxa: '',
      rxdb: 1,
      cr: [],
      pub: false,
      mo: 'b',
    },
  };
  const p = map.physics;
  if (name === 'moving-platform') {
    p.shapes.push(box([0, 0], 400, 20));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('k', [0, 0], [0], { lv: [10, 0] }));
    map.spawns.push(spawn(-50, -30, 'left'), spawn(50, -30, 'right'));
  } else if (name === 'lethal-moving-fixture') {
    p.shapes.push(box([0, 0], 200, 20), box([-250, 0], 100, 20));
    p.fixtures.push(fixture(0, { d: true }), fixture(1));
    p.bodies.push(body('k', [0, 0], [0, 1], { lv: [10, 0] }));
    map.spawns.push(spawn(0, -20, 'lethal'), spawn(-250, -30, 'safe'));
    map.s.re = true;
  } else if (name === 'timed-capture') {
    p.shapes.push(box([0, 0], 400, 400), box([-300, 0], 100, 20));
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('s', [0, 0], [0, 1]));
    map.spawns.push(spawn(0, -100, 'owner'), spawn(-300, -100, 'other'));
    map.capZones.push({ n: 'timed', ty: 1, l: 1, i: 0 });
    map.s.fl = true;
    map.s.re = true;
  } else {
    p.shapes.push(box([0, 0], 100, 10), box([0, 0], 10, 10), box([-250, 0], 100, 20));
    p.fixtures.push(fixture(0), fixture(1), fixture(2));
    p.bodies.push(body('s', [0, 0], [0, 2]), body('d', [0, -10], [1]));
    map.spawns.push(spawn(-100, -100, 'loser'), spawn(-250, -30, 'winner'));
    map.capZones.push({ n: 'goal', ty: 2, l: 10, i: 0 });
    map.s.re = true;
  }
  p.bro = p.bodies.map((_: unknown, index: number) => index);
  return map;
}
function create(name: Parameters<typeof mapFor>[0], overrides: Record<string, unknown> = {}): any {
  return createNativeMapSession<NativeDynamicArena>({
    map: mapFor(name),
    players: [
      { id: 2, team: 1 },
      { id: 7, team: 2 },
    ],
    seed: 1,
    countdownTicks: 5,
    roundsToWin: 999,
    ...overrides,
  });
}

describe('native dynamic Classic map session', () => {
  it('steps moving map bodies and sparse-ID discs in one world with native countdown gating', () => {
    const map = mapFor('moving-platform');
    const session = create('moving-platform');
    try {
      const initial = session.getState();
      expect(initial.discs[2]?.id).toBe(2);
      expect(initial.discs[7]?.id).toBe(7);
      expect(initial.physics?.bodies[0]?.p).toEqual([36.5, 25]);
      expect(session.arena).not.toHaveProperty('platforms');
      for (let tick = 0; tick < 5; tick++) {
        const state = session.step({ 2: 2, 7: 0 });
        expect(state.physics?.bodies[0]?.p).toEqual([36.5, 25]);
        expect(state.discs[2]?.x).toBe(initial.discs[2]?.x);
      }
      const active = session.step({ 2: 2, 7: 0 }); // ftu 0 -> -1; still frozen
      expect(active.ftu).toBe(-1);
      expect(active.physics?.bodies[0]?.p).toEqual([36.5, 25]);
      const moving = session.step({ 2: 2, 7: 0 });
      expect(moving.physics?.bodies[0]?.p?.[0]).toBeCloseTo(36.5 + 1 / 3, 12);
      expect(moving.discs[2]?.x).not.toBe(initial.discs[2]?.x);
      expect(Object.isFrozen(moving.physics?.bodies[0]?.p)).toBe(true);
      expect(Object.isFrozen(moving.capZones)).toBe(true);
      expect(Object.keys(moving.players)).toEqual(['2', '7']);
      expect(nativeMapToArena(map)).toHaveProperty('physics');
    } finally {
      session.dispose();
    }
  });

  it('keeps static conversion and factory construction on the ClassicPhysics path', () => {
    const map = mapFor('moving-platform');
    map.physics.bodies[0].s.type = 's';
    map.physics.bodies[0].lv = [0, 0];
    const staticArena = nativeMapToStaticArena(map);
    expect(nativeMapToArena(map)).toEqual(staticArena);
    const physicsFactory = vi.fn(() => ({
      stepWorld: vi.fn((discs: any[], platforms: any[]) => ({ discs, platforms, deaths: [], projectiles: [] })),
      step: vi.fn(),
      stepDetailed: vi.fn(),
      dispose: vi.fn(),
    }));
    const dynamicWorldFactory = vi.fn();
    const session = createNativeMapSession<NativeStaticArena>({
      map,
      players: [{ id: 2, team: 1 }],
      seed: 1,
      physicsFactory,
      dynamicWorldFactory: dynamicWorldFactory as never,
    });
    expect(physicsFactory).toHaveBeenCalledOnce();
    expect(dynamicWorldFactory).not.toHaveBeenCalled();
    expect(session.arena.platforms).toHaveLength(1);
    session.dispose();
  });

  it('does not construct ClassicPhysics for a dynamic arena', () => {
    const physicsFactory = vi.fn();
    expect(() => create('moving-platform', { physicsFactory })).toThrow(/one NativeClassicWorld/);
    expect(physicsFactory).not.toHaveBeenCalled();
  });

  it('uses raw moving-fixture death presentation while respawning immediately', () => {
    const session = create('lethal-moving-fixture');
    try {
      let result: any;
      for (let tick = 0; tick < 12; tick++) {
        result = session.stepWithEvents({ 2: 0, 7: 0 });
        if (result.events.deaths.some((death: any) => death.m === 1)) break;
      }
      const death = result.events.deaths.find((entry: any) => entry.m === 1);
      const disc = result.state.discs[death.i];
      expect(death).toMatchObject({ f: 0, m: 1 });
      expect(disc).toMatchObject({ alive: true, ni: true, x: disc.sx, y: disc.sy, xv: disc.sxv, yv: disc.syv });
      expect([death.x, death.y, death.xv, death.yv]).not.toEqual([disc.x, disc.y, disc.xv, disc.yv]);
      expect(result.events.respawns).toContain(death.i);
      expect(result.state.fte).toBe(-1);
    } finally {
      session.dispose();
    }
  });

  it('reports timed capture contacts/progress/death without capture respawn', () => {
    const session = create('timed-capture');
    try {
      let contacts = 0;
      let result: any;
      for (let tick = 1; tick <= 70; tick++) {
        result = session.stepWithEvents({ 2: 4, 7: 0 });
        contacts += result.events.capZoneContacts.length;
        if (result.events.deaths.some((death: any) => death.m === 3)) break;
      }
      expect(contacts).toBeGreaterThan(0);
      expect(result.state.capZones[0]).toMatchObject({ p: 30, l: 30, f: 0 });
      const death = result.events.deaths.find((entry: any) => entry.m === 3);
      expect(death).toBeDefined();
      expect(result.state.discs[death.i]).toBeUndefined();
      expect(result.events.respawns).not.toContain(death.i);
    } finally {
      session.dispose();
    }
  });

  it('emits instant-goal contacts and capture elimination in the same shared step', () => {
    const session = create('instant-goal');
    try {
      let result: any;
      for (let tick = 0; tick < 12; tick++) {
        result = session.stepWithEvents({ 2: 0, 7: 0 });
        if (result.events.capZoneTeamGoals.length > 0) break;
      }
      expect(result.events.capZoneTeamGoals).toEqual([{ zone: 0, team: 2 }]);
      expect(result.events.deaths).toEqual([expect.objectContaining({ m: 3 })]);
      expect(result.state.fte).toBe(90);
      expect(result.state.discs[2]).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('resets normalized map motion and capture state on rollover without a solver call', () => {
    const map = mapFor('instant-goal');
    const arena = nativeMapToArena(map) as NativeDynamicArena;
    const normalized = normalizeNativeMap(map);
    const world = {
      step: vi.fn((physics: any, discs: any[]) => {
        if (physics.ftu === -1 && discs[7]) {
          return {
            physics,
            discs: discs.map((disc: any) => (disc?.id === 2 ? undefined : disc)),
            capZones: [],
            capZoneContacts: [],
            capZoneTeamGoals: [{ zone: 0, team: 2 }],
            hits: [],
            deaths: [{ id: 2, cause: 'capture', x: 1, y: 2, xv: 3, yv: 4 }],
          };
        }
        return {
          physics,
          discs,
          capZones: [{ ty: 2, p: 9, l: 300, i: 0, o: 2, ot: 1, f: 5 }],
          capZoneContacts: [],
          capZoneTeamGoals: [],
          hits: [],
          deaths: [],
        };
      }),
      dispose: vi.fn(),
    };
    const dynamicWorldFactory = vi.fn(() => world as any);
    const session = createNativeMapSession<NativeDynamicArena>({
      map,
      players: [
        { id: 2, team: 1 },
        { id: 7, team: 2 },
      ],
      seed: 1,
      countdownTicks: 5,
      roundsToWin: 999,
      dynamicWorldFactory,
    });
    try {
      expect(dynamicWorldFactory).toHaveBeenCalledOnce();
      for (let tick = 0; tick < 7; tick++) session.step({ 2: 0, 7: 0 });
      for (let tick = 0; tick < 91; tick++) session.step({ 2: 0, 7: 0 });
      const state = session.getState();
      expect(state.rc).toBe(1);
      expect(state.ftu).toBe(90);
      expect(state.physics).toEqual({ ...normalized, ftu: 90 });
      expect(state.capZones).toEqual([{ ty: 2, p: 0, l: 300, i: 0, o: -1, ot: -1, f: -1 }]);
      expect(world.step).toHaveBeenCalledTimes(97);
      expect(arena.physics.ftu).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('retains renderer-only bodies in the unified world without accepting an empty map', () => {
    const mixed = mapFor('moving-platform');
    mixed.physics.bodies[0].s.type = 's';
    mixed.physics.bodies[0].lv = [0, 0];
    mixed.physics.shapes.push(box([0, 0], 10, 10));
    mixed.physics.fixtures.push(fixture(1, { np: true }));
    mixed.physics.bodies.push(body('s', [100, 100], [1]));
    mixed.physics.bro.push(1);
    const arena = nativeMapToArena(mixed) as NativeDynamicArena;
    expect(arena.physics.fixtures[1]?.np).toBe(true);
    expect(arena).not.toHaveProperty('platforms');
    const empty = mapFor('moving-platform');
    empty.physics.fixtures[0].np = true;
    expect(() => nativeMapToArena(empty)).toThrow(/no physical fixtures/);
  });

  it('routes active force zones to the dynamic backend and accepts any map m.mo targeting', () => {
    const force = mapFor('moving-platform');
    force.physics.bodies[0].fz.on = true;
    // fz.on is simulated by the unified dynamic world (original :4940-4995).
    const arena = nativeMapToArena(force);
    expect((arena as any).physics.bodies[0].fz.on).toBe(true);
    const session = createNativeMapSession({ map: force, players: [{ id: 0, team: 1 }], seed: 1 });
    session.dispose();
    // m.mo is display/editor metadata (readable :27591/:11269/:33953); it
    // never gates physics, so an ard-targeted map runs under Classic too.
    const mode = mapFor('moving-platform');
    mode.m.mo = 'ard';
    const targeted = createNativeMapSession({ map: mode, players: [{ id: 2, team: 1 }], seed: 1 });
    targeted.dispose();
  });
});
