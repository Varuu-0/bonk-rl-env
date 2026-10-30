import { describe, expect, it } from 'vitest';
import {
  createClassicPhysics,
  type ClassicPhysicsOptions,
  type ClassicPhysicsWorld,
  type PhysicsDisc,
  type PhysicsPlatform,
} from '../../src/core/classic-physics';

const GRAVITY_Y = 20;
const TICK = 1 / 30;

function disc(overrides: Partial<PhysicsDisc> & { id: number }): PhysicsDisc {
  return {
    x: 0,
    y: 0,
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
    ...overrides,
  };
}

function box(overrides: Partial<PhysicsPlatform> & { id: number }): PhysicsPlatform {
  return {
    bodyId: overrides.id,
    bodyX: overrides.x ?? 0,
    bodyY: overrides.y ?? 0,
    bodyAngle: overrides.angle ?? 0,
    localX: 0,
    localY: 0,
    localAngle: 0,
    shape: 'box',
    x: 0,
    y: 0,
    width: 4,
    height: 0.2,
    angle: 0,
    color: 0,
    friction: 0.5,
    restitution: 0.2,
    lethal: false,
    ...overrides,
  };
}

function options(overrides: Partial<ClassicPhysicsOptions> = {}): ClassicPhysicsOptions {
  return { fly: false, noCollision: false, quality: 1, simulate: true, ...overrides };
}

describe('Classic physics static tick', () => {
  it('uses explicit local transforms for grouped fixture bodies', () => {
    const grouped = createClassicPhysics();
    const flat = createClassicPhysics();
    const transform = { bodyX: 0, bodyY: 1, bodyAngle: 0, localY: 0, localAngle: 0 };
    const fixtures = [
      box({ id: 0, bodyId: 0, x: -3, y: 1, ...transform, localX: -3 }),
      box({ id: 1, bodyId: 0, x: 3, y: 1, ...transform, localX: 3 }),
    ];
    let a = [disc({ id: 0, x: -3 })];
    let b = [disc({ id: 0, x: -3 })];
    try {
      for (let i = 0; i < 30; i++) {
        a = grouped.step(a, fixtures, { 0: 0 }, options());
        b = flat.step(b, [box({ id: 0, x: -3, y: 1 }), box({ id: 1, x: 3, y: 1 })], { 0: 0 }, options());
        expect(a).toEqual(b);
      }
      expect(() =>
        grouped.step(
          a,
          [
            {
              id: 0,
              bodyId: 0,
              shape: 'box',
              x: -3,
              y: 1,
              width: 4,
              height: 0.2,
              angle: 0,
              color: 0,
              friction: 0.5,
              restitution: 0.2,
              lethal: false,
            },
            fixtures[1],
          ],
          { 0: 0 },
          options(),
        ),
      ).toThrow(/explicit local transforms/);
    } finally {
      grouped.dispose();
      flat.dispose();
    }
  });
  it('integrates gravity with native linear damping', () => {
    const physics = createClassicPhysics();
    let state = [disc({ id: 0 })];
    let y = 0;
    let velocity = 0;
    for (let tick = 0; tick < 10; tick++) {
      velocity = (velocity + GRAVITY_Y * TICK) * (1 - TICK * 0.01);
      y += TICK * velocity;
      state = physics.step(state, [], { 0: 0 }, options());
      expect(state[0].x).toBe(0);
      expect(state[0].xv).toBe(0);
      expect(state[0].y).toBeCloseTo(y, 12);
      expect(state[0].yv).toBeCloseTo(velocity, 12);
    }
    physics.dispose();
  });

  it('applies the native balance-to-radius clamp on every tick regardless of incoming radius', () => {
    const physics = createClassicPhysics();
    const cases: Array<[readonly number[], number]> = [
      [[-100], 0.05],
      [[-95], 0.05],
      [[100], 2],
      [[], 1],
    ];
    try {
      for (const [balances, expected] of cases) {
        let state = physics.step([disc({ id: 0, radius: 7 })], [], { 0: 0 }, options({ balances }));
        expect(state[0].radius).toBeCloseTo(expected, 12);
        for (let tick = 0; tick < 5; tick++) {
          state = physics.step([{ ...state[0], radius: 9 }], [], { 0: 0 }, options({ balances }));
          expect(state[0].radius).toBeCloseTo(expected, 12);
        }
      }
    } finally {
      physics.dispose();
    }
  });

  it('scales movement force with the radius-squared mass area', () => {
    const normal = createClassicPhysics();
    const large = createClassicPhysics();
    try {
      const initial = disc({ id: 0, x: -5 });
      const base = normal.step([initial], [], { 0: 2 }, options({ balances: [0] }))[0];
      const scaled = large.step([initial], [], { 0: 2 }, options({ balances: [100] }))[0];
      expect(base.radius).toBe(1);
      expect(scaled.radius).toBe(2);
      expect(base.xv).toBeGreaterThan(0);
      expect(scaled.xv).toBeCloseTo(base.xv, 12);
    } finally {
      normal.dispose();
      large.dispose();
    }
  });

  it('applies heavy force and drains/recharges the energy meter', () => {
    const physics = createClassicPhysics();
    let state = [disc({ id: 0, x: -10 }), disc({ id: 1, x: 10 })];

    state = physics.step(state, [], { 0: 2, 1: 2 | 16 }, options());
    expect(state[0].energy).toBe(1000);
    expect(state[1].energy).toBe(990);
    expect(state[1].xv).toBeCloseTo((8.4 / 4.663 / 30) * (1 - 0.01 / 30), 12);
    expect(state[1].heavy).toBe(true);
    expect(state[0].xv).toBeGreaterThan(state[1].xv * 3);

    state = physics.step(state, [], { 0: 2, 1: 2 | 16 }, options());
    expect(state[1].energy).toBe(980);

    state = physics.step(state, [], { 0: 2, 1: 2 }, options());
    expect(state[1].energy).toBe(985);
    state = physics.step(state, [], { 0: 2, 1: 2 }, options());
    expect(state[1].energy).toBe(990);
    expect(state[1].heavy).toBe(false);
    physics.dispose();
  });

  it('increments Arrow draw state, wraps aim and stops at the native ceiling', () => {
    const physics = createClassicPhysics();
    try {
      let state = physics.step(
        [disc({ id: 0, ds: 99, da: 355, energy: 1000 })],
        [],
        { 0: 1 | 32 },
        options({ mode: 'ar' }),
      )[0];
      expect(state.ds).toBe(100);
      expect(state.da).toBe(350);

      state = physics.step([state], [], { 0: 1 | 32 }, options({ mode: 'ar' }))[0];
      expect(state.ds).toBe(100);
      expect(state.da).toBe(345);

      const wrappedLeft = physics.step(
        [disc({ id: 0, ds: 0, da: 3, energy: 1000 })],
        [],
        { 0: 1 | 32 },
        options({ mode: 'ar' }),
      )[0];
      expect(wrappedLeft.ds).toBe(1);
      expect(wrappedLeft.da).toBe(358);

      const wrappedRight = physics.step(
        [disc({ id: 0, ds: 0, da: 357, energy: 1000 })],
        [],
        { 0: 2 | 32 },
        options({ mode: 'ard' }),
      )[0];
      expect(wrappedRight.ds).toBe(1);
      expect(wrappedRight.da).toBe(2);

      const simultaneous = physics.step(
        [disc({ id: 0, ds: 1, da: 0, energy: 1000 })],
        [],
        { 0: 1 | 2 | 32 },
        options({ mode: 'ar' }),
      )[0];
      expect(simultaneous.ds).toBe(2);
      expect(simultaneous.da).toBe(0);
      const simultaneousWrap = physics.step(
        [disc({ id: 0, ds: 1, da: 358, energy: 1000 })],
        [],
        { 0: 1 | 2 | 32 },
        options({ mode: 'ard' }),
      )[0];
      expect(simultaneousWrap.ds).toBe(2);
      expect(simultaneousWrap.da).toBe(358);

      const charging = physics.step(
        [disc({ id: 0, ds: 40, da: 90, energy: 600 })],
        [],
        { 0: 1 | 32 },
        options({ mode: 'ard' }),
      )[0];
      expect(charging.ds).toBe(40);
      expect(charging.da).toBe(90);
      expect(charging.energy).toBe(608);
    } finally {
      physics.dispose();
    }
  });

  it('fires one native Arrow on release and advances its frame', () => {
    const physics = createClassicPhysics();
    const drawing = disc({ id: 0, ds: 100, da: 90, energy: 1000 });
    try {
      const released = physics.stepWorld([drawing], [], { 0: 0 }, options({ mode: 'ar' }));
      expect(released.discs[0].ds).toBe(0);
      expect(released.discs[0].energy).toBe(500);
      expect(released.projectiles!).toHaveLength(1);
      expect(released.projectiles![0]).toMatchObject({ did: 0, fte: 150, type: 'arrow', a: Math.PI / 2, av: 0 });
      expect(released.projectiles![0]!.xv).toBeCloseTo(0, 12);
      expect(released.projectiles![0]!.yv).toBe(115);

      const next = physics.stepWorld(released.discs, released.platforms, { 0: 0 }, options({ mode: 'ar' }), {
        projectiles: released.projectiles,
      });
      expect(next.projectiles!).toHaveLength(1);
      expect(next.projectiles![0]!.fte).toBe(149);
      expect(next.projectiles![0]!.y).toBeGreaterThan(released.projectiles![0]!.y);
      expect(() => physics.step([drawing], [], { 0: 0 }, options({ mode: 'b' }))).not.toThrow();
    } finally {
      physics.dispose();
    }
  });

  it('excludes the energy-heavy density bonus while an Arrow is drawn', () => {
    const classic = createClassicPhysics();
    const notDrawing = createClassicPhysics();
    const drawing = createClassicPhysics();
    const base = disc({ id: 0, x: -10, energy: 600 });
    try {
      const classicState = classic.step([base], [], { 0: 2 | 16 }, options({ mode: 'b' }))[0];
      const notDrawingState = notDrawing.step([base], [], { 0: 2 | 16 }, options({ mode: 'ar' }))[0];
      const drawingState = drawing.step([{ ...base, ds: 50 }], [], { 0: 2 | 16 | 32 }, options({ mode: 'ar' }))[0];

      expect(notDrawingState.xv).toBeLessThan(classicState.xv);
      expect(notDrawingState.energy).toBe(608);
      expect(drawingState.energy).toBe(608);
      expect(drawingState.ds).toBe(50);
      expect(drawingState.xv).toBe(0);
    } finally {
      classic.dispose();
      notDrawing.dispose();
      drawing.dispose();
    }
  });

  it('maps VTOL direction bits to the native vt states', () => {
    const physics = createClassicPhysics();
    const cases: Array<[number, number]> = [
      [0, 0],
      [4, 3],
      [1 | 4, 2],
      [2 | 4, 1],
      [8, 4],
      [1 | 8, 6],
      [2 | 8, 5],
      [1, 2],
      [2, 1],
      [1 | 2, 3],
    ];
    try {
      for (const [bits, vt] of cases) {
        const [state] = physics.step([disc({ id: 0 })], [], { 0: bits }, options({ mode: 'v', simulate: true }));
        expect(state.vt, `input bits ${bits}`).toBe(vt);
      }
      const held = physics.step([disc({ id: 0, vt: 3 })], [], { 0: 4 }, options({ mode: 'v', simulate: false }))[0];
      expect(held.vt).toBe(3);
      expect(held.yv).toBe(0);
    } finally {
      physics.dispose();
    }
  });

  it('applies native VTOL wing impulses along the body angle with full/weak pairs', () => {
    const physics = createClassicPhysics();
    const base = disc({ id: 0 });
    try {
      const up = physics.step([base], [], { 0: 4 }, options({ mode: 'v' }))[0];
      const down = physics.step([base], [], { 0: 8 }, options({ mode: 'v' }))[0];
      expect(up.vt).toBe(3);
      expect(up.yv).toBeLessThan(0);
      expect(up.xv).toBe(0);
      expect(down.vt).toBe(4);
      expect(down.yv).toBeGreaterThan(0);

      const left = physics.step([base], [], { 0: 1 }, options({ mode: 'v' }))[0];
      const right = physics.step([base], [], { 0: 2 }, options({ mode: 'v' }))[0];
      expect(left.vt).toBe(2);
      expect(right.vt).toBe(1);
      expect(left.angularVelocity).not.toBe(0);
      expect(right.angularVelocity).not.toBe(0);
      expect(Math.abs(left.angularVelocity)).toBeCloseTo(Math.abs(right.angularVelocity), 12);
      expect(Math.sign(left.angularVelocity)).toBe(-Math.sign(right.angularVelocity));

      const symmetric = physics.step([base], [], { 0: 4 }, options({ mode: 'v' }))[0];
      expect(symmetric.angularVelocity).toBe(0);

      const rotated = physics.step([disc({ id: 0, angle: Math.PI / 2 })], [], { 0: 4 }, options({ mode: 'v' }))[0];
      expect(rotated.xv).toBeGreaterThan(0);
    } finally {
      physics.dispose();
    }
  });

  it('gives VTOL wings static contact fixtures that the Classic disc does not have', () => {
    const vtol = createClassicPhysics();
    const classic = createClassicPhysics();
    const floor = box({ id: 0, x: 1.5, y: -0.7, width: 1, height: 0.2 });
    const initial = disc({ id: 0, x: -0.1, y: -0.5, yv: -2 });
    try {
      const vtolState = vtol.step([initial], [floor], { 0: 0 }, options({ mode: 'v' }))[0];
      const classicState = classic.step([initial], [floor], { 0: 0 }, options({ mode: 'b' }))[0];
      expect(vtolState.angularVelocity).not.toBe(0);
      expect(classicState.angularVelocity).toBe(0);
      expect(vtolState.y).not.toBe(classicState.y);
    } finally {
      vtol.dispose();
      classic.dispose();
    }
  });

  it('unlocks angular velocity propagation only in VTOL mode', () => {
    const vtol = createClassicPhysics();
    const classic = createClassicPhysics();
    const initial = disc({ id: 0, angle: 0.3, angularVelocity: 2 });
    const corner = box({ id: 0, x: 0.7, y: -0.7, width: 0.2, height: 0.2 });
    try {
      const vtolState = vtol.step([initial], [], { 0: 0 }, options({ mode: 'v' }))[0];
      expect(vtolState.angle).toBeGreaterThan(0.3);
      expect(vtolState.angularVelocity).toBeGreaterThan(0);

      const classicState = classic.step([disc({ id: 0 })], [corner], { 0: 0 }, options({ mode: 'b' }))[0];
      expect(classicState.angularVelocity).toBe(0);
      expect(classicState.angle).toBeCloseTo(0, 12);
    } finally {
      vtol.dispose();
      classic.dispose();
    }
  });

  it('jumps only when the downward ray reaches an eligible static fixture', () => {
    const ground = createClassicPhysics();
    const air = createClassicPhysics();
    const platform = box({ id: 0, x: 0, y: 0.7, width: 10, height: 0.2 });
    const grounded = ground.step(
      [disc({ id: 0, y: 0, radius: 0.5 })],
      [platform],
      { 0: 4 },
      options({ balances: [-50] }),
    )[0];
    const airborne = air.step([disc({ id: 0, y: 0, radius: 0.5 })], [], { 0: 4 }, options({ balances: [-50] }))[0];
    expect(grounded.yv).toBeLessThan(-5);
    expect(airborne.yv).toBeGreaterThan(0);
    ground.dispose();
    air.dispose();
  });

  it('records disc-disc last hits and starts their 120-tick timer', () => {
    const physics = createClassicPhysics();
    const [first, second] = physics.step(
      [disc({ id: 0, x: -0.5 }), disc({ id: 1, x: 0.5 })],
      [],
      { 0: 0, 1: 0 },
      options(),
    );

    expect(first).toMatchObject({ lhid: 1, lht: 120 });
    expect(second).toMatchObject({ lhid: 0, lht: 120 });
    physics.dispose();
  });

  it('decays the last-hit timer before creation even when not simulating', () => {
    const physics = createClassicPhysics();
    let state = [disc({ id: 0, x: -10, lhid: 1, lht: 2 }), disc({ id: 1, x: 10, lhid: 0, lht: 1 })];

    state = physics.step(state, [], { 0: 0, 1: 0 }, options({ simulate: false }));
    expect(state.map(({ lhid, lht }) => ({ lhid, lht }))).toEqual([
      { lhid: 1, lht: 1 },
      { lhid: -1, lht: 0 },
    ]);

    state = physics.step(state, [], { 0: 0, 1: 0 }, options({ simulate: false }));
    expect(state.map(({ lhid, lht }) => ({ lhid, lht }))).toEqual([
      { lhid: -1, lht: 0 },
      { lhid: -1, lht: 0 },
    ]);
    physics.dispose();
  });

  it('disables disc-disc contacts through BeginContact without attribution when noCollision is set', () => {
    const collides = createClassicPhysics();
    const passes = createClassicPhysics();
    const initial = [disc({ id: 0, x: -0.5 }), disc({ id: 1, x: 0.5 })];

    let withCollision = initial;
    let withoutCollision = initial;
    for (let tick = 0; tick < 20; tick++) {
      withCollision = collides.step(withCollision, [], { 0: 0, 1: 0 }, options());
      withoutCollision = passes.step(withoutCollision, [], { 0: 0, 1: 0 }, options({ noCollision: true }));
    }

    expect(Math.abs(withCollision[0].x - withCollision[1].x)).toBeGreaterThan(1.001);
    expect(Math.abs(withoutCollision[0].x - withoutCollision[1].x)).toBeCloseTo(1, 12);
    expect(withoutCollision.every((item) => item.lhid === -1 && item.lht === 0)).toBe(true);
    collides.dispose();
    passes.dispose();
  });

  it('flags lethal fixture contact per disc and leaves non-lethal contact alive', () => {
    const lethal = createClassicPhysics();
    const safe = createClassicPhysics();
    const lethalPlatform = box({ id: 0, x: 0, y: 1, width: 10, lethal: true });
    const safePlatform = box({ id: 0, x: 0, y: 1, width: 10, lethal: false });

    let lethalState = [disc({ id: 0, y: 0, radius: 0.5 })];
    let safeState = [disc({ id: 0, y: 0, radius: 0.5 })];
    for (let tick = 0; tick < 20; tick++) {
      lethalState = lethal.step(lethalState, [lethalPlatform], { 0: 0 }, options({ balances: [-50] }));
      safeState = safe.step(safeState, [safePlatform], { 0: 0 }, options({ balances: [-50] }));
    }

    expect(lethalState[0].alive).toBe(false);
    expect(lethalState[0]).toMatchObject({ lhid: -1, lht: 0 });
    expect(safeState[0].alive).toBe(true);
    lethal.dispose();
    safe.dispose();
  });

  it('native-independent: immediately restores the authored spawn on a lethal death when respawn is enabled', () => {
    const physics = createClassicPhysics();
    const platform = box({ id: 0, x: 0, y: 1, width: 10, lethal: true });
    const initial = disc({ id: 0, x: 0, y: 0, sx: 4, sy: -2, sxv: 0.5, syv: -0.25, radius: 0.5 });
    try {
      let state = [initial];
      let world: ClassicPhysicsWorld | undefined;
      for (let tick = 0; tick < 60; tick++) {
        world = physics.stepWorld(state, [platform], { 0: 0 }, options({ respawn: true, balances: [-50] }));
        state = world.discs;
        if (world.deaths!.length > 0) break;
      }
      expect(world!.deaths).toHaveLength(1);
      expect(world!.deaths![0]).toMatchObject({ id: 0, cause: 'lethal-contact' });
      for (const field of ['x', 'y', 'xv', 'yv'] as const) expect(Number.isFinite(world!.deaths![0][field])).toBe(true);
      expect(world!.deaths![0]).not.toMatchObject({ x: 4, y: -2, xv: 0.5, yv: -0.25 });
      expect(world!.discs[0]).toMatchObject({
        alive: true,
        ni: true,
        x: 4,
        y: -2,
        xv: 0.5,
        yv: -0.25,
        sx: 4,
        sy: -2,
        sxv: 0.5,
        syv: -0.25,
      });

      const next = physics.stepWorld(state, [], { 0: 0 }, options({ respawn: true, balances: [-50] }));
      expect(next.discs[0].ni).toBe(false);
      expect(next.discs[0].alive).toBe(true);
      expect(next.discs[0].sx).toBe(4);
      expect(next.discs[0].syv).toBe(-0.25);
    } finally {
      physics.dispose();
    }
  });

  it('native-independent: leaves a lethal death permanent when respawn is disabled', () => {
    const physics = createClassicPhysics();
    const platform = box({ id: 0, x: 0, y: 1, width: 10, lethal: true });
    const initial = disc({ id: 0, x: 0, y: 0, sx: 4, sy: -2, radius: 0.5 });
    try {
      let state = [initial];
      let world: ClassicPhysicsWorld | undefined;
      for (let tick = 0; tick < 60; tick++) {
        world = physics.stepWorld(state, [platform], { 0: 0 }, options({ balances: [-50] }));
        state = world.discs;
        if (world.deaths!.length > 0) break;
      }
      expect(world!.deaths).toHaveLength(1);
      expect(world!.deaths![0]).toMatchObject({ id: 0, cause: 'lethal-contact' });
      for (const field of ['x', 'y', 'xv', 'yv'] as const) expect(Number.isFinite(world!.deaths![0][field])).toBe(true);
      expect(world!.deaths![0]).not.toMatchObject({ x: 4, y: -2, xv: 0.5, yv: -0.25 });
      expect(world!.discs[0]).toMatchObject({ alive: false, ni: false });
      expect(world!.discs[0].x).not.toBe(4);
    } finally {
      physics.dispose();
    }
  });

  it('native-independent: applies native floor/radial bounds gates only when ppm is supplied', () => {
    const physics = createClassicPhysics();
    const ppm = 12;
    try {
      const onFloor = physics.stepWorld(
        [disc({ id: 0, x: 0, y: 500 / ppm, sx: 0, sy: 0 })],
        [],
        { 0: 0 },
        options({ ppm, simulate: false }),
      );
      expect(onFloor.deaths).toEqual([]);
      expect(onFloor.discs[0].alive).toBe(true);

      const belowFloor = physics.stepWorld(
        [disc({ id: 0, x: 0, y: 500 / ppm + 1e-6, sx: 0, sy: 0 })],
        [],
        { 0: 0 },
        options({ ppm, simulate: false, respawn: true }),
      );
      expect(belowFloor.deaths).toEqual([{ id: 0, cause: 'out-of-world', x: 0, y: 500 / ppm + 1e-6, xv: 0, yv: 0 }]);
      expect(belowFloor.discs[0]).toMatchObject({ alive: true, ni: true, x: 0, y: 0 });

      const radialEdge = physics.stepWorld(
        [disc({ id: 0, x: 365 / ppm + 850 / ppm, y: 250 / ppm, sx: 0, sy: 0 })],
        [],
        { 0: 0 },
        options({ ppm, simulate: false }),
      );
      expect(radialEdge.deaths).toEqual([]);
      expect(radialEdge.discs[0].alive).toBe(true);

      const radialX = 365 / ppm + 850 / ppm + 1e-6;
      const radialY = 250 / ppm;
      const radialOutside = physics.stepWorld(
        [disc({ id: 0, x: radialX, y: radialY, sx: 0, sy: 0 })],
        [],
        { 0: 0 },
        options({ ppm, simulate: false }),
      );
      expect(radialOutside.deaths).toEqual([{ id: 0, cause: 'out-of-world', x: radialX, y: radialY, xv: 0, yv: 0 }]);
      expect(radialOutside.discs[0].alive).toBe(false);
      expect(radialOutside.discs[0].ni).toBe(false);

      const unbounded = physics.stepWorld(
        [disc({ id: 0, x: 0, y: 500 / ppm + 1e-6 })],
        [],
        { 0: 0 },
        options({ simulate: false }),
      );
      expect(unbounded.deaths).toEqual([]);
      expect(unbounded.discs[0].alive).toBe(true);
    } finally {
      physics.dispose();
    }
  });

  it('native-independent: gives out-of-world precedence over a lethal contact in the same step', () => {
    const physics = createClassicPhysics();
    const ppm = 12;
    const lethal = box({ id: 0, x: 0, y: 60, width: 20, height: 20, lethal: true });
    const initial = disc({ id: 0, x: 0, y: 60, sx: 0, sy: 0, radius: 0.5 });
    try {
      const lethalOnly = physics.stepWorld([initial], [lethal], { 0: 0 }, options({ respawn: true }));
      expect(lethalOnly.deaths).toEqual([
        { id: 0, cause: 'lethal-contact', x: 1.2, y: 60.02221481481482, xv: 0, yv: 0.6664444444444444 },
      ]);

      const world = physics.stepWorld([initial], [lethal], { 0: 0 }, options({ ppm, respawn: true }));
      expect(world.deaths).toEqual([
        { id: 0, cause: 'out-of-world', x: 1.2, y: 60.02221481481482, xv: 0, yv: 0.6664444444444444 },
      ]);
      expect(world.discs[0]).toMatchObject({ alive: true, ni: true, x: 0, y: 0 });
    } finally {
      physics.dispose();
    }
  });

  it('keeps two instances independent when their ticks interleave', () => {
    const expected = createClassicPhysics();
    const first = createClassicPhysics();
    const second = createClassicPhysics();
    const initial = [disc({ id: 0 }), disc({ id: 1, x: 3, y: -1 })];
    const platform = box({ id: 0, x: 0, y: 4, width: 12 });

    const inputsFor = (tick: number) => ({ 0: tick % 2 === 0 ? 2 : 4, 1: tick % 3 === 0 ? 1 : 8 });
    let baseline = initial;
    const expectedStates: PhysicsDisc[][] = [];
    for (let tick = 0; tick < 30; tick++) {
      baseline = expected.step(baseline, [platform], inputsFor(tick), options());
      expectedStates.push(baseline);
    }

    let firstState = initial;
    let secondState = initial;
    for (let tick = 0; tick < 30; tick++) {
      firstState = first.step(firstState, [platform], inputsFor(tick), options());
      secondState = second.step(secondState, [platform], inputsFor(tick), options());
      expect(firstState).toEqual(expectedStates[tick]);
      expect(secondState).toEqual(expectedStates[tick]);
    }
    expected.dispose();
    first.dispose();
    second.dispose();
  });

  it('returns dead records without simulating them', () => {
    const physics = createClassicPhysics();
    const dead = disc({ id: 0, x: 4, y: 5, xv: 6, yv: 7, angle: 8, energy: 400, alive: false });
    const [result] = physics.step([dead], [box({ id: 0, x: 4, y: 8 })], { 0: 31 }, options());
    expect(result).toEqual({ ...dead, sx: 4, sy: 5, sxv: 6, syv: 7, ni: false, ds: 0, da: 270, vt: 0 });
    physics.dispose();
  });

  it('rebuilds its world from fresh state on the next tick', () => {
    const physics = createClassicPhysics();
    const initial = [disc({ id: 0, x: 1, y: -2, xv: 0.5, yv: -0.25 })];
    const first = physics.step(initial, [], { 0: 2 }, options());

    let state = initial;
    for (let tick = 0; tick < 5; tick++) {
      state = physics.step(state, [box({ id: 0, x: 0, y: 3 })], { 0: 4 | 1 }, options());
    }

    const again = physics.step(initial, [], { 0: 2 }, options());
    expect(again).toEqual(first);
    physics.dispose();
  });

  it('never emits non-finite numbers for a busy static scene', () => {
    const physics = createClassicPhysics();
    const platforms = [
      box({ id: 0, bodyId: 0, x: 0, y: 3, width: 20, height: 0.4 }),
      {
        id: 1,
        bodyId: 1,
        bodyX: -3,
        bodyY: 1,
        bodyAngle: 0,
        localX: 0,
        localY: 0,
        localAngle: 0,
        shape: 'circle' as const,
        x: -3,
        y: 1,
        radius: 1.5,
        angle: 0,
        color: 0,
        friction: 0.4,
        restitution: 0.6,
        lethal: false,
      },
    ];
    let state = [disc({ id: 0, x: -1, y: 0, radius: 1 }), disc({ id: 1, x: 1.5, y: 0.5, radius: 0.8 })];
    for (let tick = 0; tick < 30; tick++) {
      state = physics.step(
        state,
        platforms,
        { 0: tick % 4 === 0 ? 2 : 12, 1: tick % 3 === 0 ? 4 : 1 },
        options({ fly: true, noCollision: tick % 2 === 0, quality: tick % 2 === 0 ? 1 : 2, balances: [0, -20] }),
      );
      for (const item of state) {
        for (const key of ['x', 'y', 'xv', 'yv', 'angle', 'angularVelocity', 'radius', 'energy'] as const) {
          expect(Number.isFinite(item[key])).toBe(true);
        }
        expect(item.energy).toBeGreaterThanOrEqual(0);
        expect(item.energy).toBeLessThanOrEqual(1000);
        expect(typeof item.alive).toBe('boolean');
      }
    }
    physics.dispose();
  });

  it('feeds back actual static body transforms through sustained CCD contact', () => {
    const floor: PhysicsPlatform = {
      id: 0,
      bodyId: 0,
      shape: 'box',
      bodyX: 365 / 12,
      bodyY: 250 / 12,
      bodyAngle: 0,
      localX: 0,
      localY: 0,
      localAngle: 0,
      x: 365 / 12,
      y: 250 / 12,
      width: 480 / 12,
      height: 24 / 12,
      angle: 0,
      color: 0,
      friction: 0.5,
      restitution: 0.8,
      lethal: false,
    };
    const initialDiscs = [disc({ id: 0, x: 355 / 12, y: 220 / 12 }), disc({ id: 1, x: 375 / 12, y: 220 / 12 })];
    const inputs = { 0: 2, 1: 1 };
    const initialPlatforms = [floor];

    function run(feedback = true): {
      world: ClassicPhysicsWorld;
      drift: { tick: number; before: number; after: number } | null;
    } {
      const physics = createClassicPhysics();
      let world: ClassicPhysicsWorld = { discs: initialDiscs, platforms: initialPlatforms };
      let drift: { tick: number; before: number; after: number } | null = null;
      try {
        for (let tick = 1; tick <= 160; tick++) {
          const before = world.platforms[0].bodyY!;
          const result = physics.stepWorld(world.discs, world.platforms, inputs, options({ quality: 2 }));
          const after = result.platforms[0].bodyY!;
          if (drift === null && after !== before) drift = { tick, before, after };
          world = { discs: result.discs, platforms: feedback ? result.platforms : initialPlatforms };
        }
        return { world, drift };
      } finally {
        physics.dispose();
      }
    }

    const first = run();
    const second = run();
    const withoutFeedback = run(false);
    expect(first.drift).not.toBeNull();
    expect(first.drift!.tick).toBeGreaterThan(1);
    expect(first.world.discs.some((disc) => disc.lht > 0)).toBe(true);
    expect(first.drift!.after).not.toBe(first.drift!.before);
    expect(first.world.platforms[0].bodyY).toBe(first.drift!.after);
    expect(second.drift).toEqual(first.drift);
    expect(second.world.discs).toEqual(first.world.discs);
    expect(second.world.platforms).toEqual(first.world.platforms);
    expect(withoutFeedback.world.platforms[0].bodyY).toBe(floor.bodyY);
    expect(withoutFeedback.world.discs).not.toEqual(first.world.discs);
  });

  it('keeps step compatible while exposing frozen plain platform copies', () => {
    const physics = createClassicPhysics();
    const explicit = box({ id: 0, x: 0, y: 1 });
    const flattened: PhysicsPlatform = {
      id: 0,
      bodyId: 0,
      shape: 'box',
      x: 0,
      y: 1,
      width: 4,
      height: 0.2,
      angle: 0,
      color: 0,
      friction: 0.5,
      restitution: 0.2,
      lethal: false,
    };
    try {
      const discsOnly = physics.step([disc({ id: 0, y: -2 })], [explicit], { 0: 0 }, options({ simulate: false }));
      const detailed = physics.stepDetailed(
        [disc({ id: 0, y: -2 })],
        [explicit],
        { 0: 0 },
        options({ simulate: false }),
      );
      expect(discsOnly).toEqual(detailed.discs);
      expect(physics.stepWorld([disc({ id: 0, y: -2 })], [explicit], { 0: 0 }, options({ simulate: false }))).toEqual(
        detailed,
      );

      const fallback = physics.stepWorld([disc({ id: 0, y: -2 })], [flattened], { 0: 0 }, options({ simulate: false }));
      expect(fallback.platforms[0]).toMatchObject({
        bodyX: 0,
        bodyY: 1,
        bodyAngle: 0,
        localX: 0,
        localY: 0,
        localAngle: 0,
        x: 0,
        y: 1,
        angle: 0,
      });

      expect(Object.isFrozen(detailed.platforms)).toBe(true);
      expect(detailed.platforms).toHaveLength(1);
      const record = detailed.platforms[0] as unknown as Record<string, unknown>;
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      expect(Object.keys(record).sort()).toEqual(
        [
          'angle',
          'bodyAngle',
          'bodyId',
          'bodyX',
          'bodyY',
          'color',
          'friction',
          'height',
          'id',
          'lethal',
          'localAngle',
          'localX',
          'localY',
          'restitution',
          'shape',
          'width',
          'x',
          'y',
        ].sort(),
      );
      for (const value of Object.values(record)) {
        expect(['number', 'boolean', 'string']).toContain(typeof value);
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
      expect(record).not.toBe(explicit);
      expect(() =>
        physics.stepWorld([disc({ id: 0 })], [{ ...flattened, bodyX: 0 } as PhysicsPlatform], { 0: 0 }, options()),
      ).toThrow(/all transforms/);
    } finally {
      physics.dispose();
    }
  });

  it('keeps sparse balance/team arrays indexed by native player ID without densifying discs', () => {
    const physics = createClassicPhysics();
    const balances: number[] = [];
    balances[19] = 100;
    balances[3] = 0;
    const teams: number[] = [];
    teams[19] = 2;
    const initial = [disc({ id: 19, x: -4 }), disc({ id: 3, x: 4 })];
    try {
      const first = physics.step(initial, [], { 19: 2, 3: 2 }, options({ balances, teams }));
      expect(first.map(({ id, radius }) => ({ id, radius }))).toEqual([
        { id: 19, radius: 2 },
        { id: 3, radius: 1 },
      ]);
      expect(first[0].xv).toBeCloseTo(first[1].xv, 12);

      const missing = physics.step(
        [disc({ id: 19 }), disc({ id: 3 })],
        [],
        { 19: 0, 3: 0 },
        options({ balances: [], teams: [] }),
      );
      expect(missing.map(({ id, radius }) => ({ id, radius }))).toEqual([
        { id: 19, radius: 1 },
        { id: 3, radius: 1 },
      ]);

      const inherited: number[] = [];
      inherited[3] = 100;
      Object.setPrototypeOf(inherited, { 19: 100 });
      const withDefault = physics.step(
        [disc({ id: 19 }), disc({ id: 3 })],
        [],
        { 19: 0, 3: 0 },
        options({ balances: inherited, teams }),
      );
      expect(withDefault[0].radius).toBe(1);
      expect(withDefault[1].radius).toBe(2);

      const accessor: number[] = [];
      Object.defineProperty(accessor, '3', { get: () => 100 });
      expect(() => physics.step(initial, [], { 19: 0, 3: 0 }, options({ balances: accessor }))).toThrow(
        /own data property/,
      );
      expect(() => physics.step(initial, [], { 19: 0, 3: 0 }, options({ teams: accessor }))).toThrow(
        /own data property/,
      );
    } finally {
      physics.dispose();
    }
  });

  it('passes native signed friction and restitution above one through real static contact', () => {
    const negativeFriction = createClassicPhysics();
    const control = createClassicPhysics();
    const highRestitution = createClassicPhysics();
    const initial = disc({ id: 0, x: 0, y: -1, xv: 1, yv: -3 });
    const floor = box({ id: 0, y: 1, width: 40, height: 2, friction: -0.3, restitution: 0 });
    try {
      let signed = initial;
      let ordinary = initial;
      let bouncy = initial;
      for (let tick = 0; tick < 8; tick++) {
        signed = negativeFriction.step([signed], [floor], { 0: 0 }, options())[0];
        ordinary = control.step([ordinary], [{ ...floor, friction: 0.5, restitution: 0.8 }], { 0: 0 }, options())[0];
        bouncy = highRestitution.step(
          [bouncy],
          [{ ...floor, friction: 0.5, restitution: 1.25 }],
          { 0: 0 },
          options(),
        )[0];
      }
      expect(signed.xv).toBeCloseTo(0.3148373514616898, 12);
      expect(ordinary.xv).toBeCloseTo(0.9973364423712346, 12);
      expect(signed.xv).toBeLessThan(ordinary.xv * 0.5);
      expect(bouncy.yv).toBeCloseTo(-2.9166627816647224, 12);
      expect(bouncy.yv).toBeLessThan(ordinary.yv);
      expect(ordinary.yv).toBeCloseTo(-2.2166637140651884, 12);
    } finally {
      negativeFriction.dispose();
      control.dispose();
      highRestitution.dispose();
    }
  });

  it('retains finite and unrequested material bounds while accepting the native extensions', () => {
    const physics = createClassicPhysics();
    const initial = [disc({ id: 0 })];
    try {
      expect(() =>
        physics.step(
          initial,
          [box({ id: 0, friction: -0.3, restitution: 1.25 })],
          { 0: 0 },
          options({ simulate: false }),
        ),
      ).not.toThrow();
      for (const field of ['friction', 'restitution'] as const) {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          expect(() =>
            physics.step(initial, [box({ id: 0, [field]: value })], { 0: 0 }, options({ simulate: false })),
          ).toThrow(new RegExp(`platforms\\[0\\]\\.${field} must be a finite number`));
        }
      }
      expect(() =>
        physics.step(initial, [box({ id: 0, friction: 1.0001 })], { 0: 0 }, options({ simulate: false })),
      ).toThrow(/friction must be at most 1/);
      expect(() =>
        physics.step(initial, [box({ id: 0, restitution: -0.0001 })], { 0: 0 }, options({ simulate: false })),
      ).toThrow(/restitution must be non-negative/);
    } finally {
      physics.dispose();
    }
  });

  it('rejects malformed state before mutating the world', () => {
    const physics = createClassicPhysics();
    const valid = [disc({ id: 0 })];
    expect(() => physics.step([disc({ id: 0 }), disc({ id: 0 })], [], { 0: 0 }, options())).toThrow(/duplicate/);
    expect(() => physics.step(valid, [], {}, options())).toThrow(/missing input/);
    expect(() => physics.step([disc({ id: 0, x: Number.NaN })], [], { 0: 0 }, options())).toThrow(/finite/);
    expect(() => physics.step([disc({ id: 0, lhid: 0 })], [], { 0: 0 }, options())).toThrow(/another native player id/);
    // Native retains last-hit attribution to an eliminated round-entry disc.
    const attributed = physics.step([disc({ id: 0, lhid: 1, lht: 120 })], [], { 0: 0 }, options());
    expect(attributed[0]).toMatchObject({ lhid: 1, lht: 119 });
    expect(() => physics.step([disc({ id: 0, lhid: 0.5 })], [], { 0: 0 }, options())).toThrow(/lhid/);
    expect(() => physics.step([disc({ id: 0, lht: -1 })], [], { 0: 0 }, options())).toThrow(/lht/);
    expect(() => physics.step([disc({ id: 0, lht: 121 })], [], { 0: 0 }, options())).toThrow(/lht/);
    expect(() => physics.step([disc({ id: 0, lht: 1.5 })], [], { 0: 0 }, options())).toThrow(/lht/);
    expect(() => physics.step(valid, [], { 0: 0 }, { ...options(), extra: true } as never)).toThrow(/unsupported/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ quality: 3 as never }))).toThrow(/quality/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ balances: [-101] }))).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ balances: [101] }))).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ balances: [1.5] }))).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ balances: [Number.NaN] }))).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, options({ balances: ['0' as never] }))).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, { ...options(), balances: null } as never)).toThrow(/balances/);
    expect(() => physics.step(valid, [], { 0: 0 }, options())).not.toThrow();
    physics.dispose();
  });
});
