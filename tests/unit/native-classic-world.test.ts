import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeClassicCapZones,
  createNativeClassicWorld,
  type NativeClassicWorld,
  type NativeClassicWorldResult,
} from '../../src/core/native-classic-world';
import { normalizeNativeMap, type NativeMapPhysics, type NativeMapSource } from '../../src/core/native-map-state';
import type { PhysicsDisc } from '../../src/core/classic-physics';

const worlds: NativeClassicWorld[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});
function makeWorld(): NativeClassicWorld {
  const world = createNativeClassicWorld();
  worlds.push(world);
  return world;
}
function fixture(overrides: Record<string, unknown> = {}): any {
  return {
    sh: 0,
    n: 'f',
    fr: null,
    fp: null,
    re: null,
    de: null,
    f: 1,
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
      type: 's',
      n: 'b',
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
    p: [0, 0],
    a: 0,
    lv: [0, 0],
    av: 0,
    cf: { x: 0, y: 0, ct: 0, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    fx: [0],
    ...overrides,
  };
}
function state(overrides: Record<string, unknown> = {}): NativeMapPhysics {
  const source: NativeMapSource = {
    physics: {
      ppm: 10,
      shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 400, h: 20, sk: false }],
      fixtures: [fixture()],
      bodies: [body()],
      joints: [],
      bro: [0],
      ss: [],
      ...overrides,
    },
  };
  const physics = normalizeNativeMap(source);
  physics.ftu = -1;
  return physics;
}
function disc(id: number, overrides: Partial<PhysicsDisc> = {}): PhysicsDisc {
  return {
    id,
    x: 36.5,
    y: 23,
    xv: 0,
    yv: 0,
    angle: 0,
    angularVelocity: 0,
    radius: 1,
    energy: 1000,
    heavy: false,
    alive: true,
    lhid: -1,
    lht: 0,
    sx: 36.5,
    sy: 23,
    sxv: 0,
    syv: 0,
    ni: false,
    ds: 0,
    da: 270,
    vt: 0,
    ...overrides,
  };
}
function inputs(discs: readonly PhysicsDisc[], bits = 0): Record<number, number> {
  return Object.fromEntries(discs.map((entry) => [entry.id, bits]));
}

function platformDisc(
  world: NativeClassicWorld,
  overrides: Record<string, unknown> = {},
  player = disc(0),
  options: Record<string, unknown> = {},
): NativeClassicWorldResult {
  return world.step(state(overrides), [player], inputs([player]), options);
}

describe('unified native Classic/map world', () => {
  it('collides a live disc with a kinematic map body in the same step', () => {
    const initial = state({ bodies: [body({ s: { ...body().s, type: 'k' }, lv: [10, 0] })] });
    const before = JSON.stringify(initial);
    const result = makeWorld().step(initial, [disc(0)], { 0: 0 });
    expect(result.physics.bodies[0]?.p[0]).toBeCloseTo(36.5 + 10 / 30, 12);
    expect(result.discs[0]?.y).toBeLessThan(23.02);
    expect(result.discs[0]?.yv).toBeLessThan(20 / 30);
    expect(result.deaths).toEqual([]);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('keeps native sparse disc IDs and their team/contact state', () => {
    const physics = state();
    const players: (PhysicsDisc | undefined)[] = new Array(5);
    players[2] = disc(2, { x: 35.5, y: 23, xv: 4 });
    players[4] = disc(4, { x: 37.5, y: 23, xv: -4 });
    const world = makeWorld();
    const result = world.step(physics, players, { 2: 0, 4: 0 }, { teams: [1, 1, 1, 1, 1] });
    expect(result.discs).toHaveLength(5);
    expect(0 in result.discs).toBe(false);
    expect(result.discs[2]?.lhid).toBe(4);
    expect(result.discs[4]?.lhid).toBe(2);
    expect(result.discs[2]?.lht).toBe(120);
    expect(result.hits).toEqual([
      { player: 2, other: 4 },
      { player: 4, other: 2 },
    ]);
  });

  it('preserves a recent-contact reference to an eliminated round-entry player', () => {
    const players: (PhysicsDisc | undefined)[] = [];
    players[2] = disc(2, { lhid: 7, lht: 119 });
    const world = makeWorld();
    expect(() => world.step(state(), players, { 2: 0 })).toThrow(/lhid/);
    const result = world.step(state(), players, { 2: 0 }, { knownPlayerIds: [2, 7] });
    expect(result.discs[2]?.lhid).toBe(7);
    expect(result.discs[2]?.lht).toBe(118);
    expect(result.discs[7]).toBeUndefined();
    expect(() => world.step(state(), players, { 2: 0 }, { knownPlayerIds: [2, 8] })).toThrow(/lhid/);
  });

  it('suppresses same-team and nc contact without manufacturing last-hit events', () => {
    for (const options of [{ noCollision: true }, { teamCollision: true, teams: [2, 2] }]) {
      const players = [disc(0, { x: 35.5 }), disc(1, { x: 37.5 })];
      const result = makeWorld().step(state(), players, inputs(players), options);
      expect(result.discs.every((entry) => entry?.lhid === -1 && entry.lht === 0)).toBe(true);
      expect(result.hits).toEqual([]);
    }
  });

  it('kills on a moving lethal fixture and preserves raw pre-respawn death state', () => {
    const result = platformDisc(makeWorld(), { fixtures: [fixture({ d: true })] }, disc(0), { respawn: true });
    expect(result.deaths).toHaveLength(1);
    expect(result.deaths[0]).toMatchObject({ id: 0, cause: 'lethal-contact' });
    expect(result.deaths[0]?.y).toBeLessThan(23);
    expect(result.discs[0]).toMatchObject({ alive: true, ni: true, x: 36.5, y: 23, xv: 0, yv: 0 });
  });

  it('applies OOB after capture and never respawns a capture cause', () => {
    const oob = platformDisc(makeWorld(), {}, disc(0, { x: 36.5, y: 51 }), { respawn: true });
    expect(oob.deaths[0]?.cause).toBe('out-of-world');
    expect(oob.discs[0]).toMatchObject({ alive: true, ni: true, y: 23 });
    const radial = platformDisc(makeWorld(), {}, disc(0, { x: 200, y: 23 }), { radialBounds: false });
    expect(radial.deaths).toEqual([]);
    const capturePhysics = state({ shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 400, h: 400, sk: false }] });
    const capture = makeWorld().step(
      capturePhysics,
      [disc(0, { y: 15 })],
      { 0: 0 },
      { respawn: true },
      {
        capZones: [{ ty: 1, p: 1, l: 1, i: 0, o: 0, ot: 2, f: 0 }],
      },
    );
    expect(capture.discs[0]).toBeUndefined();
    expect(capture.deaths[0]?.cause).toBe('capture');
    const both = makeWorld().step(
      capturePhysics,
      [disc(0, { y: 51 })],
      { 0: 0 },
      { respawn: true },
      {
        capZones: [{ ty: 1, p: 1, l: 1, i: 0, o: 0, ot: 2, f: 0 }],
      },
    );
    expect(both.deaths[0]?.cause).toBe('out-of-world');
    expect(both.discs[0]).toMatchObject({ alive: true, ni: true, y: 23 });
  });

  it('creates native cap carriers with deduplication and missing-fixture rejection', () => {
    const physics = state({ fixtures: [fixture(), fixture({ sh: 0 }), fixture({ np: true })] });
    const zones = createNativeClassicCapZones(
      [
        { n: 'one', ty: 1, l: 2, i: 0 },
        { n: 'duplicate', ty: 1, l: 5, i: 0 },
        { n: 'missing', ty: 1, l: 1, i: 99 },
        { n: 'two', ty: 2, l: 3, i: 1 },
        { n: 'np retained', ty: 1, l: 1, i: 2 },
      ],
      physics,
    );
    expect(zones).toEqual([
      { ty: 1, p: 0, l: 60, i: 0, o: -1, ot: -1, f: -1 },
      { ty: 2, p: 0, l: 90, i: 1, o: -1, ot: -1, f: -1 },
      { ty: 1, p: 0, l: 30, i: 2, o: -1, ot: -1, f: -1 },
    ]);
  });

  it('collects timed cap contact, completes capture, and delays the cause by 20 ticks', () => {
    const physics = state({ shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 400, h: 400, sk: false }] });
    const world = makeWorld();
    let result = world.step(
      physics,
      [disc(0, { y: 15 }), disc(1, { x: 100, y: 15 })],
      { 0: 0, 1: 0 },
      { radialBounds: false },
      {
        authoredCapZones: [{ ty: 1, l: 1 / 30, i: 0 }],
      },
    );
    expect(result.capZoneContacts).toEqual([{ zone: 0, fixtureId: 0, disc: 0 }]);
    expect(result.capZones[0]).toMatchObject({ p: 1, l: 1, o: 0, ot: 1, f: 20 });
    expect(result.deaths).toEqual([]);
    for (let tick = 0; tick < 21; tick++) {
      result = world.step(
        result.physics,
        result.discs,
        { 0: 0, 1: 0 },
        { radialBounds: false },
        { capZones: result.capZones },
      );
    }
    expect(result.capZones[0]?.f).toBe(0);
    expect(result.deaths.some((death) => death.id === 1 && death.cause === 'capture')).toBe(true);
  });

  it('rejects cap fixtures for jumping while allowing ordinary moving geometry', () => {
    const physics = state({ shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 400, h: 20, sk: false }] });
    const world = makeWorld();
    const jump = world.step(physics, [disc(0, { y: 23 })], { 0: 4 });
    const cap = world.step(physics, [disc(0, { y: 23 })], { 0: 4 }, {}, { authoredCapZones: [{ ty: 1, l: 1, i: 0 }] });
    expect(jump.discs[0]?.yv).toBeLessThan(-9);
    expect(cap.discs[0]?.yv).toBeGreaterThan(0);
  });

  it('emits instant-goal team events and capture causes from map-body contact', () => {
    const physics = state({
      shapes: [
        { type: 'bx', c: [0, 0], a: 0, w: 100, h: 10, sk: false },
        { type: 'bx', c: [0, 0], a: 0, w: 10, h: 10, sk: false },
      ],
      fixtures: [fixture(), fixture({ sh: 1 })],
      bodies: [body({ p: [0, 0] }), body({ p: [0, -10], fx: [1], s: { ...body().s, type: 'd' } })],
      bro: [0, 1],
    });
    const result = makeWorld().step(
      physics,
      [disc(0), disc(1)],
      { 0: 0, 1: 0 },
      { teams: [1, 2] },
      {
        authoredCapZones: [{ ty: 2, l: 10, i: 0 }],
      },
    );
    expect(result.capZoneTeamGoals).toEqual([{ zone: 0, team: 2 }]);
    expect(result.deaths).toContainEqual(expect.objectContaining({ id: 0, cause: 'capture' }));
    expect(result.discs[0]).toBeUndefined();
    expect(result.discs[1]).toMatchObject({ alive: true });
  });

  it('rejects unsupported mechanics and malformed inputs before simulation', () => {
    const world = makeWorld();
    const player = disc(0);
    expect(() => world.step(state(), [player], { 0: 32 })).toThrow(/secondary input/);
    expect(() => world.step(state(), [player], { 0: 0 }, { mode: 'v' as any })).toThrow(/mode b/);
    expect(() => world.step(state(), [{ ...player, ds: 1 }], { 0: 0 })).toThrow(/non-Classic/);
    // Active force zones are now simulated (original :4940-4995); a full step
    // with an fz body must succeed rather than reject.
    world.step(
      state({ bodies: [body({ fz: { on: true, x: 1, y: 0, d: true, p: true, a: true, t: 0, cf: 0 } })] }),
      [player],
      { 0: 0 },
    );
    expect(() => world.step(state(), [player], { 0: 0 }, {}, { projectiles: [{} as never] })).toThrow(/projectiles/);
    expect(() => world.step(state(), [player], { 0: 0 }, { simulate: false })).toThrow(/simulate.*ftu/);
    const countdown = state();
    countdown.ftu = 2;
    expect(() => world.step(countdown, [player], { 0: 0 }, { simulate: true })).toThrow(/simulate.*ftu/);
    world.dispose();
    expect(() => world.step(state(), [player], { 0: 0 })).toThrow(/disposed/);
  });
});
