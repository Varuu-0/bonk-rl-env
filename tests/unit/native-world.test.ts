import { afterEach, describe, expect, it } from 'vitest';
import { createNativeWorld, type NativeWorld } from '../../src/core/native-world';
import { normalizeNativeMap, type NativeMapPhysics, type NativeMapSource } from '../../src/core/native-map-state';
import { createBackend } from '../../src/core/backend';
import { safeCos, safeSin } from '../../src/core/safe-trig';

const worlds: NativeWorld[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});
function makeWorld(): NativeWorld {
  const world = createNativeWorld();
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
      type: 'd',
      n: 'b',
      fric: 0.5,
      fricp: false,
      re: 0.8,
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
function map(overrides: Record<string, unknown> = {}): NativeMapSource {
  return {
    physics: {
      ppm: 10,
      shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false }],
      fixtures: [fixture()],
      bodies: [body()],
      joints: [],
      bro: [0],
      ss: [],
      ...overrides,
    },
  } as NativeMapSource;
}
function state(overrides: Record<string, unknown> = {}, ftu = -1): NativeMapPhysics {
  const normalized = normalizeNativeMap(map(overrides));
  normalized.ftu = ftu;
  return normalized;
}

describe('native dynamic world', () => {
  it('steps a free dynamic body with native gravity, damping and dt', () => {
    const world = makeWorld();
    const next = world.step(state({ bodies: [body({ lv: [2, -3], av: 4, s: { ...body().s, ld: 0.1, ad: 0.2 } })] }));
    // One dynamic box: mass=4, linear factor 1/(1+dt*ld), gravity enters first.
    const damping = 1 - 0.1 / 30;
    expect(next.bodies[0]?.lv[0]).toBeCloseTo(2 * damping, 13);
    expect(next.bodies[0]?.lv[1]).toBeCloseTo((-3 + 20 / 30) * damping, 13);
    expect(next.bodies[0]?.p[0]).toBeCloseTo(36.5 + (2 * damping) / 30, 13);
    expect(next.bodies[0]?.p[1]).toBeCloseTo(25 + ((-3 + 20 / 30) * damping) / 30, 13);
    expect(next.ftu).toBe(-1);
  });

  it('keeps all-np dynamic bodies static while preserving their slots', () => {
    const world = makeWorld();
    const next = world.step(state({ bodies: [body({ lv: [10, 20], av: 30 })], fixtures: [fixture({ np: true })] }));
    expect(next.bodies[0]).toMatchObject({ p: [36.5, 25], a: 0, lv: [10, 20], av: 30 });
    expect(next.bodies).toHaveLength(1);
    expect(next.fixtures[0]?.np).toBe(true);
  });

  it('applies local constant force every active tick, not just on initialization', () => {
    const world = makeWorld();
    let next = state({
      shapes: [
        { type: 'bx', c: [0, 0], a: 0.2, w: 100, h: 20, sk: true },
        { type: 'ci', c: [30, 0], a: 0, r: 6, sk: true },
      ],
      fixtures: [fixture({ sh: 0 }), fixture({ sh: 1 })],
      bodies: [
        body({
          p: [0, 0],
          a: Math.PI / 2,
          fx: [0, 1],
          s: { ...body().s, ld: 0.1, ad: 0.2 },
          cf: { x: 30, y: 0, ct: 6, w: false },
        }),
      ],
    });
    next = world.step(next);
    // Original two-tick reference (ld=0.1, ad=0.2): cf.ct participates in
    // ResetMassData's centre-of-mass velocity shift. It is not simply av+ct;
    // the oracle emits these values, and local matches them exactly.
    expect(next.bodies[0]?.lv[0]).toBe(0);
    expect(next.bodies[0]?.lv[1]).toBe(1.661111111111111);
    expect(next.bodies[0]?.av).toBe(0.19866666666666666);
    next = world.step(next);
    expect(next.bodies[0]?.lv[0]).toBe(-0.006600126);
    expect(next.bodies[0]?.lv[1]).toBe(3.3166633581851848);
    expect(next.bodies[0]?.av).toBe(0.39600888888888885);
  });

  it('gates cf on ftu -1 and shrink independently on ftu <= 0', () => {
    const world = makeWorld();
    const raw = map({
      shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 100, h: 20, sk: true }],
      bodies: [body({ cf: { x: 30, y: 0, ct: 0, w: true } })],
    });
    let current = normalizeNativeMap(raw);
    current.ftu = 1;
    let next = world.step(current);
    expect(next.ftu).toBe(0);
    expect(next.bodies[0]?.lv[0]).toBe(0);
    expect(next.ss).toEqual([]);
    next = world.step(next);
    expect(next.ftu).toBe(-1);
    expect(next.bodies[0]?.lv[0]).toBe(0);
    expect(next.ss).toEqual([[0, 9.97]]);
    next = world.step(next);
    expect(next.bodies[0]?.lv[0]).toBe(1);
    expect(next.ss[0]?.[0]).toBe(0);
    expect(next.ss[0]?.[1]).toBeCloseTo(9.94, 14);
  });

  it('advances circle shrink toward its native floor with deltaMs unchanged', () => {
    const world = makeWorld();
    const next = world.step(state({ shapes: [{ type: 'ci', c: [0, 0], a: 0, r: 6, sk: true }] }), { deltaMs: 30 });
    expect(next.ss).toEqual([[0, 0.585]]);
    const atFloor = world.step(next, { deltaMs: 120 });
    expect(atFloor.ss[0]?.[1]).toBeCloseTo(0.57, 14);
  });

  it('matches the RL-local backend for a compound polygon/circle dynamic body', () => {
    // Independent backend construction checks geometry/material/order without
    // comparing native-world to itself or to the legacy map adapter.
    const raw = map({
      shapes: [
        { type: 'bx', c: [0, 0], a: 0.3, w: 20, h: 10, sk: false },
        { type: 'ci', c: [20, 10], a: 0, r: 5, sk: false },
        {
          type: 'po',
          c: [0, 0],
          a: 0,
          s: 1,
          v: [
            [-10, -10],
            [10, -10],
            [0, 10],
          ],
          sk: false,
        },
      ],
      fixtures: [
        fixture({ sh: 0, fr: 0.2, fp: true, de: 2 }),
        fixture({ sh: 1, fr: 0.4, fp: false }),
        fixture({ sh: 2 }),
      ],
      bodies: [
        body({
          p: [20, -30],
          a: 0.4,
          lv: [0.3, -0.5],
          av: 0.7,
          fx: [0, 1, 2],
          s: { ...body().s, f_c: 2, f_p: false, fricp: true },
        }),
      ],
    });
    const initial = normalizeNativeMap(raw);
    initial.ftu = -1;
    const local = makeWorld().step(initial);
    const B = createBackend();
    const world = new B.Dynamics.b2World(new B.Common.Math.b2Vec2(0, 20));
    world.SetWarmStarting(false);
    const definition = new B.Dynamics.b2BodyDef();
    definition.type = B.Dynamics.b2Body.b2_dynamicBody;
    definition.position.Set(...initial.bodies[0]!.p);
    definition.angle = 0.4;
    definition.linearVelocity.Set(0.3, -0.5);
    definition.angularVelocity = 0.7;
    const bodyHandle = world.CreateBody(definition);
    const sourceBody = raw.physics.bodies[0]!;
    for (const fixtureIndex of sourceBody.fx) {
      const f = initial.fixtures[fixtureIndex]!;
      const shape = initial.shapes[f.sh]!;
      const fd = new B.Dynamics.b2FixtureDef();
      if (shape.type === 'bx') {
        const polygon = new B.Collision.Shapes.b2PolygonShape();
        const c = safeCos(shape.a),
          s = safeSin(shape.a);
        polygon.SetAsArray(
          [
            [shape.w / 2, -shape.h / 2],
            [shape.w / 2, shape.h / 2],
            [-shape.w / 2, shape.h / 2],
            [-shape.w / 2, -shape.h / 2],
          ].map(([x, y]) => new B.Common.Math.b2Vec2(c * x - s * y + shape.c[0], s * x + c * y + shape.c[1])),
        );
        fd.shape = polygon;
      } else if (shape.type === 'ci') {
        fd.shape = new B.Collision.Shapes.b2CircleShape(shape.r);
        fd.shape.SetLocalPosition(new B.Common.Math.b2Vec2(...shape.c));
      } else {
        const polygon = new B.Collision.Shapes.b2PolygonShape();
        polygon.SetAsArray(shape.v.map((p) => new B.Common.Math.b2Vec2(...p)));
        fd.shape = polygon;
      }
      fd.friction = (f.fp ?? sourceBody.s.fricp) ? -(f.fr ?? sourceBody.s.fric) : (f.fr ?? sourceBody.s.fric);
      fd.restitution = f.re ?? sourceBody.s.re;
      fd.density = f.de ?? sourceBody.s.de;
      fd.filter.categoryBits = Math.pow(2, sourceBody.s.f_c) * 2;
      fd.filter.maskBits = 65534;
      bodyHandle.CreateFixture(fd);
    }
    bodyHandle.SetLinearVelocity(new B.Common.Math.b2Vec2(0.3, -0.5));
    world.Step(1 / 30, 2, 6);
    expect(local.bodies[0]?.p[0]).toBeCloseTo(bodyHandle.GetPosition().x, 9);
    expect(local.bodies[0]?.p[1]).toBeCloseTo(bodyHandle.GetPosition().y, 9);
    expect(local.bodies[0]?.a).toBeCloseTo(bodyHandle.GetAngle(), 9);
    expect(local.bodies[0]?.lv[0]).toBeCloseTo(bodyHandle.GetLinearVelocity().x, 9);
    expect(local.bodies[0]?.av).toBeCloseTo(bodyHandle.GetAngularVelocity(), 9);
    const lastFixture = bodyHandle.GetFixtureList();
    expect(lastFixture.GetFriction()).toBe(-0.5);
    expect(lastFixture.GetFilterData().categoryBits).toBe(8);
    expect(lastFixture.GetFilterData().maskBits).toBe(65534);
  });

  it('creates and extracts stable d/rv/p joint slots with native p motor state', () => {
    const raw = map({
      bodies: [body(), body({ p: [30, 0], a: 0.2 })],
      joints: [
        {
          type: 'rv',
          ba: -1,
          bb: 0,
          aa: [0, 0],
          ab: [0, 0],
          d: { cc: false, bf: 0, el: false, la: -1, ua: 1, em: true, ms: 1, mmt: 100 },
        },
        null,
        { type: 'd', ba: 0, bb: 1, aa: [0, 0], ab: [0, 0], d: { cc: false, bf: 0, fh: 0, dr: 0.5 } },
        {
          type: 'p',
          ba: -1,
          bb: 1,
          aa: [30, 0],
          ab: [0, 0],
          axa: [1, 0],
          cs: 0,
          d: { cc: false, bf: 0, el: true, lt: -50, ut: 50, em: true, ms: 1, mmf: 1000, cd: true },
        },
      ],
    });
    const world = makeWorld();
    let next = world.stepAuthored(raw);
    expect(next.joints).toHaveLength(4);
    expect(next.joints[0]?.type).toBe('rv');
    expect(next.joints[1]).toBeNull();
    expect(next.joints[2]?.type).toBe('d');
    expect(next.joints[3]?.type).toBe('p');
    const motor = (next.joints[3] as any).d.ms;
    const cs = (next.joints[3] as any).cs;
    next = world.step(next);
    expect((next.joints[3] as any).d.ms).toBe(motor);
    expect((next.joints[3] as any).cs).toBe(cs);
    for (const body of next.bodies) {
      expect(body?.p.every(Number.isFinite)).toBe(true);
      expect(body?.lv.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(body?.av)).toBe(true);
    }
  });

  it('preserves holes when a break-force joint is removed', () => {
    const world = makeWorld();
    const next = world.step(
      state({
        joints: [
          null,
          {
            type: 'd',
            ba: -1,
            bb: 0,
            aa: [0, 0],
            ab: [0, 0],
            len: 0.01,
            d: { cc: false, bf: 1e-20, fh: 10000, dr: 0 },
          },
        ],
      }),
    );
    expect(next.joints).toHaveLength(2);
    expect(next.joints[0]).toBeNull();
    expect(next.joints[1]).toBeNull();
  });

  it('composes a disc and moving map bodies in one world before one shared step', () => {
    const initial = state({
      shapes: [{ type: 'bx', c: [0, 0], a: 0, w: 400, h: 20, sk: false }],
      bodies: [body({ lv: [1, 0], s: { ...body().s, type: 'k' } })],
    });
    const world = makeWorld();
    const calls: string[] = [];
    let discVelocity = 0;
    const next = world.stepWith(
      initial,
      { quality: 1 },
      {
        build(context) {
          calls.push('build');
          expect(context.bodies[0]).toBeUndefined();
          const B = context.backend;
          const definition = new B.Dynamics.b2BodyDef();
          definition.type = B.Dynamics.b2Body.b2_dynamicBody;
          definition.position.Set(36.5, 23);
          definition.fixedRotation = true;
          const disc = context.world.CreateBody(definition);
          const fixture = new B.Dynamics.b2FixtureDef();
          fixture.shape = new B.Collision.Shapes.b2CircleShape(1);
          fixture.density = 1 / Math.PI;
          fixture.friction = 0.001337;
          fixture.restitution = 0.95;
          disc.CreateFixture(fixture);
          expect(context.world.GetBodyList()).toBe(disc);
          return disc;
        },
        afterMap(context, disc) {
          calls.push('afterMap');
          expect(context.bodies[0]).toBeDefined();
          expect(context.fixtures[0].GetBody()).toBe(context.bodies[0]);
          expect(context.world.GetBodyList()).toBe(context.bodies[0]);
          expect(disc.GetPosition().y).toBe(23);
        },
        buildProjectiles() {
          calls.push('projectiles');
        },
        beforeStep() {
          calls.push('controls');
        },
        extract(_context, disc) {
          calls.push('extract');
          discVelocity = disc.GetLinearVelocity().y;
        },
        afterExtract() {
          calls.push('afterExtract');
        },
      },
    );
    expect(calls).toEqual(['build', 'afterMap', 'projectiles', 'controls', 'extract', 'afterExtract']);
    expect(next.bodies[0]?.p[0]).toBeCloseTo(36.5 + 1 / 30, 12);
    expect(next.bodies[0]?.p[1]).toBe(25);
    // Gravity and platform contact act on the disc during the same Step as the
    // map body, rather than in a separate post-map simulation.
    expect(discVelocity).toBeLessThan(20 / 30);
    expect(Number.isFinite(discVelocity)).toBe(true);
  });

  it('does not mutate inputs and supports explicit non-simulating rebuilds', () => {
    const world = makeWorld();
    const initial = state({ bodies: [body({ cf: { x: 30, y: 0, ct: 0, w: true } })] });
    const before = JSON.stringify(initial);
    const next = world.step(initial, { simulate: false });
    expect(JSON.stringify(initial)).toBe(before);
    expect(next.bodies[0]?.p).toEqual(initial.bodies[0]?.p);
    expect(next.bodies[0]?.lv[0]).toBe(1);
    expect(next.ss).toEqual([]);
    expect(() => world.step(initial, { quality: 3 as any })).toThrow(/quality/);
    world.dispose();
    expect(() => world.step(initial)).toThrow(/disposed/);
  });
});
