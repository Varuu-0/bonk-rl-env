/**
 * Strict raw native-map to static Classic session adapter.
 *
 * Authored pixels are normalized by native-map-state using createNewState's
 * arithmetic and SafeTrig. The flattened platforms retain native body/fixture
 * IDs and body/local transforms; they are not inferred from renderer geometry.
 * Unsupported mechanics fail before createNativeSession creates a world.
 */
import { validateNativeMapJson, type NativeMap } from './native-map-codec';
import { normalizeNativeMap, type NativeMapPhysics, type NativeMapSource, type NativeShape } from './native-map-state';
import {
  createNativeSession,
  type NativeSession,
  type NativeSessionPlayer,
  type NativeSessionOptions,
  type NativeSessionArena,
  type NativeSessionSnapshot,
  type NativeStaticArena,
} from './native-session';
import type { PhysicsPlatform, PhysicsProjectile } from './classic-physics';
import {
  createNativeModeSession,
  type NativeClassicMode,
  type NativeModeSession,
  type NativeModeSessionOptions,
  type NativeModeSessionSnapshot,
  type NativeModeSessionStep,
} from './native-mode-session';
import { safeCos, safeSin } from './safe-trig';

/** Session options with authored native map JSON in place of a flat arena. */
export type NativeMapSessionOptions = Omit<NativeSessionOptions, 'arena'> & {
  readonly map: NativeMap | unknown;
};

/** Explicit original gameSettings.mo, independent of map metadata m.mo. */
export interface NativeMapModeSessionOptions extends Omit<NativeModeSessionOptions, 'arena'> {
  readonly map: NativeMap | unknown;
}

/** Static raw-map session with the same interface as NativeMapSession. */
export interface NativeStaticMapModeSession extends NativeModeSession {
  readonly arena: NativeSessionArena;
}

/** A native session plus the immutable arena from which it was constructed. */
export interface NativeMapSession<A extends NativeSessionArena = NativeSessionArena> extends NativeSession {
  readonly arena: A;
}

export class NativeMapSessionError extends Error {
  override readonly name = 'NativeMapSessionError';
  constructor(
    readonly code: 'UNSUPPORTED_STATIC_CLASSIC_MAP' | 'UNSUPPORTED_NATIVE_MECHANIC',
    readonly path: string,
    reason: string,
  ) {
    super(`Unsupported native static Classic map at ${path}: ${reason}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function unsupported(path: string, reason: string): never {
  throw new NativeMapSessionError('UNSUPPORTED_STATIC_CLASSIC_MAP', path, reason);
}

function assertSupportedMechanics(map: NativeMap): void {
  // Active force zones are now simulated by the unified dynamic world
  // (original :4940-4995 contact-time force injection). The static converter
  // still rejects them; this pre-normalization taxonomy gate is retired.
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function material(value: number, kind: 'friction' | 'restitution', path: string): number {
  // Preserve native signed friction and restitution > 1 exactly. These are the
  // remaining ClassicPhysics input limits, not a native clamp or normalization.
  if (!Number.isFinite(value)) unsupported(path, 'material must be finite');
  if ((kind === 'friction' && value > 1) || (kind === 'restitution' && value < 0)) {
    unsupported(path, `effective ${kind} ${value} is outside ClassicPhysics' supported range`);
  }
  return value;
}

function assertDefaultCollision(body: NonNullable<NativeMapPhysics['bodies'][number]>, index: number): void {
  const path = `physics.bodies[${index}].s`;
  if (body.s.f_c !== 1)
    unsupported(`${path}.f_c`, `category ${body.s.f_c} cannot be represented by the Classic backend (requires 1)`);
  for (const key of ['f_p', 'f_1', 'f_2', 'f_3', 'f_4'] as const) {
    if (!body.s[key])
      unsupported(`${path}.${key}`, 'a non-default collision mask cannot be represented by the Classic backend');
  }
}

function assertStaticBody(body: NonNullable<NativeMapPhysics['bodies'][number]>, index: number): void {
  const path = `physics.bodies[${index}]`;
  if (body.cf.x !== 0 || body.cf.y !== 0 || body.cf.ct !== 0)
    unsupported(`${path}.cf`, 'active constant force requires the dynamic-world backend');
  if (body.fz.on) unsupported(`${path}.fz.on`, 'active force zones require the unified dynamic-world backend');
  if (body.s.type !== 's')
    unsupported(`${path}.s.type`, `body type ${body.s.type} requires the unified dynamic-world backend`);
  if (body.fx.length === 0) unsupported(`${path}.fx`, 'empty static bodies have no Classic arena representation');
  if (body.lv[0] !== 0 || body.lv[1] !== 0 || body.av !== 0)
    unsupported(path, 'a static body with residual velocity is unsupported');
  if (body.s.ld !== 0 || body.s.ad !== 0) {
    unsupported(`${path}.s`, 'nonzero damping has no representation in the static Classic backend');
  }
  assertDefaultCollision(body, index);
}

function assertFixture(fixture: NonNullable<NativeMapPhysics['fixtures'][number]>, index: number): void {
  const path = `physics.fixtures[${index}]`;
  if (fixture.np) unsupported(`${path}.np`, 'nonphysical fixtures require native renderer/no-physics semantics');
  if (fixture.ng) unsupported(`${path}.ng`, 'no-grapple fixtures are outside the bounded Classic backend');
  if (fixture.ig) unsupported(`${path}.ig`, 'inner-grapple fixtures are outside the bounded Classic backend');
}

function checkPolygon(shape: Extract<NativeShape, { type: 'po' }>, index: number): void {
  const path = `physics.shapes[${index}].v`;
  if (shape.v.length < 3) unsupported(path, 'native degenerate-polygon circle fallback is not a polygon platform');
  if (shape.v.length > 100) unsupported(path, 'more than 100 vertices exceeds the ClassicPhysics input contract');
  // Box2D consumes signed winding. Reject self-intersections rather than
  // reordering, convexifying or dropping any native vertices.
  const orientation = (
    a: readonly [number, number],
    b: readonly [number, number],
    c: readonly [number, number],
  ): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < shape.v.length; i++) {
    const a = shape.v[i]!;
    const b = shape.v[(i + 1) % shape.v.length]!;
    const c = shape.v[(i + 2) % shape.v.length]!;
    if (a[0] === b[0] && a[1] === b[1])
      unsupported(path, 'a closing or non-adjacent duplicate edge is unsupported by ClassicPhysics');
    if (orientation(a, b, c) === 0)
      unsupported(path, 'collinear consecutive vertices are not valid native Box2D polygon edges');
    for (let j = i + 1; j < shape.v.length; j++) {
      if (j === i || j === (i + 1) % shape.v.length || i === (j + 1) % shape.v.length) continue;
      const p = shape.v[j]!;
      const q = shape.v[(j + 1) % shape.v.length]!;
      const abP = orientation(a, b, p);
      const abQ = orientation(a, b, q);
      const pqA = orientation(p, q, a);
      const pqB = orientation(p, q, b);
      if (((abP > 0 && abQ < 0) || (abP < 0 && abQ > 0)) && ((pqA > 0 && pqB < 0) || (pqA < 0 && pqB > 0))) {
        unsupported(path, `edges ${i} and ${j} intersect; vertex decomposition is not implemented`);
      }
    }
  }
}

function localPlatform(
  body: NonNullable<NativeMapPhysics['bodies'][number]>,
  bodyId: number,
  fixture: NonNullable<NativeMapPhysics['fixtures'][number]>,
  fixtureId: number,
  shape: NativeShape,
  shapeId: number,
): PhysicsPlatform {
  if (shape.sk) unsupported(`physics.shapes[${shapeId}].sk`, 'shrinking shapes require the dynamic native world');
  const localX = shape.type === 'po' ? 0 : shape.c[0];
  const localY = shape.type === 'po' ? 0 : shape.c[1];
  const cos = safeCos(body.a);
  const sin = safeSin(body.a);
  const common = {
    id: fixtureId,
    bodyId,
    x: body.p[0] + cos * localX - sin * localY,
    y: body.p[1] + sin * localX + cos * localY,
    color: fixture.f,
    friction: material(
      (fixture.fr ?? body.s.fric) * ((fixture.fp ?? body.s.fricp) ? -1 : 1),
      'friction',
      `physics.fixtures[${fixtureId}].fr/fp`,
    ),
    restitution: material(fixture.re ?? body.s.re, 'restitution', `physics.fixtures[${fixtureId}].re`),
    lethal: fixture.d,
    bodyX: body.p[0],
    bodyY: body.p[1],
    bodyAngle: body.a,
    localX,
    localY,
  };
  if (shape.type === 'bx') {
    return Object.freeze({
      ...common,
      shape: 'box' as const,
      width: shape.w,
      height: shape.h,
      angle: body.a + shape.a,
      localAngle: shape.a,
    });
  }
  if (shape.type === 'ci') {
    return Object.freeze({
      ...common,
      shape: 'circle' as const,
      radius: shape.r,
      // Circle angle is inert, but retaining it keeps the transform carrier
      // complete and mirrors createNewState/native-world normalization.
      angle: body.a + shape.a,
      localAngle: shape.a,
    });
  }
  checkPolygon(shape, shapeId);
  return Object.freeze({
    ...common,
    shape: 'polygon' as const,
    vertices: Object.freeze(shape.v.map(([x, y]) => Object.freeze([x, y] as const))),
    angle: body.a,
    // Polygon scale, angle and centre were already baked by normalization;
    // applying shape.a or shape.c here would transform it twice.
    localAngle: 0,
  });
}

/**
 * Validate and convert raw native JSON to the exact static Classic arena seam.
 * No platform is synthesized and invalid references never become an empty map.
 * The original object and all of its nested arrays remain untouched.
 */
export function nativeMapToStaticArena(rawMap: NativeMap | unknown): NativeStaticArena {
  const map = validateNativeMapJson(rawMap);
  assertSupportedMechanics(map);
  // Map metadata m.mo is display/editor targeting only in the original: it is
  // read by the map-list UI (readable :27591/:27693/:28030/:28159/:28292), map
  // serialization (:11269/:11525) and the editor (:33953/:37079), and never
  // selects physics. Room gameSettings.mo (:5017 room options, :28978/:29448
  // lobby cycle, :5112 changeMode) is the sole physics-mode source. It is NOT
  // a gate here; a map authored for another mode runs under any room mode.
  if (map.s.pq !== 1 && map.s.pq !== 2) unsupported('s.pq', `quality ${map.s.pq} is not 1 or 2`);
  if (map.capZones.length > 0)
    unsupported('capZones', 'capture zones and instant goals are outside this static session');
  // These JSON-only fixture fields are consumed by native presentation but
  // intentionally omitted by normalizeNativeMap. Gate them before that lossy
  // projection so unsupported metadata can never disappear silently.
  for (let index = 0; index < map.physics.fixtures.length; index++) {
    const fixture = map.physics.fixtures[index];
    if (!fixture) continue;
    if (has(fixture, 'fs'))
      unsupported(
        `physics.fixtures[${index}].fs`,
        'foot-sound presentation is not represented by a native session arena',
      );
    if (has(fixture, 'zp'))
      unsupported(
        `physics.fixtures[${index}].zp`,
        'platform-zone metadata is not represented by a native session arena',
      );
  }

  // Normalization intentionally owns ppm fallback, SafeTrig geometry, sparse
  // slots, reference validation and authored-to-world arithmetic.
  const physics: NativeMapPhysics = normalizeNativeMap(map as NativeMapSource, { authored: true });
  if (physics.ss.length > 0) unsupported('physics.ss', 'active shrink carriers require the dynamic native world');
  for (let index = 0; index < physics.shapes.length; index++) {
    if (physics.shapes[index]?.sk)
      unsupported(`physics.shapes[${index}].sk`, 'shrinking shapes require the dynamic native world');
  }
  if (physics.joints.some((joint) => joint !== null && joint !== undefined)) {
    unsupported('physics.joints', 'all native joints are outside the static Classic backend');
  }
  const presentBodies = physics.bodies.filter((body) => body !== null && body !== undefined).length;
  if (physics.bro.length !== presentBodies || new Set(physics.bro).size !== physics.bro.length) {
    unsupported('physics.bro', 'body ordering must contain each present static body exactly once');
  }
  for (let index = 0; index < physics.bodies.length; index++) {
    const body = physics.bodies[index];
    if (body) assertStaticBody(body, index);
  }
  for (let index = 0; index < physics.fixtures.length; index++) {
    const fixture = physics.fixtures[index];
    if (fixture) assertFixture(fixture, index);
  }

  const fixtureOwners = new Map<number, number>();
  const platforms: PhysicsPlatform[] = [];
  for (let bodyId = 0; bodyId < physics.bodies.length; bodyId++) {
    const body = physics.bodies[bodyId];
    if (!body) continue;
    for (const fixtureId of body.fx) {
      const previousOwner = fixtureOwners.get(fixtureId);
      if (previousOwner !== undefined) {
        unsupported(
          `physics.bodies[${bodyId}].fx`,
          `fixture ${fixtureId} is already owned by body ${previousOwner}; duplicate bodies would change contact ordering`,
        );
      }
      fixtureOwners.set(fixtureId, bodyId);
      const fixture = physics.fixtures[fixtureId]!;
      const shape = physics.shapes[fixture.sh]!;
      platforms.push(localPlatform(body, bodyId, fixture, fixtureId, shape, fixture.sh));
    }
  }
  if (platforms.length === 0)
    unsupported('physics.bodies', 'map has no physical static fixtures; refusing to substitute an empty arena');
  if (map.spawns.length === 0)
    unsupported('spawns', 'map has no authored spawns; refusing to synthesize fallback positions');

  const spawns = map.spawns.map((spawn) =>
    Object.freeze({
      x: (spawn.x + 365) / physics.ppm,
      y: (spawn.y + 250) / physics.ppm,
      xv: spawn.xv / physics.ppm,
      yv: spawn.yv / physics.ppm,
      priority: spawn.priority,
      ffa: spawn.f,
      red: spawn.r,
      blue: spawn.b,
      green: spawn.gr,
      yellow: spawn.ye,
      ...(spawn.n === undefined ? {} : { n: spawn.n }),
    }),
  );
  return Object.freeze({
    ppm: physics.ppm,
    settings: Object.freeze({ respawn: map.s.re, noCollision: map.s.nc, fly: map.s.fl, quality: map.s.pq }),
    spawns: Object.freeze(spawns),
    platforms: Object.freeze(platforms),
    capZones: Object.freeze([]),
  });
}

function sessionSpawns(map: NativeMap, physics: NativeMapPhysics): NativeSessionArena['spawns'] {
  return Object.freeze(
    map.spawns.map((spawn) =>
      Object.freeze({
        x: (spawn.x + 365) / physics.ppm,
        y: (spawn.y + 250) / physics.ppm,
        xv: spawn.xv / physics.ppm,
        yv: spawn.yv / physics.ppm,
        priority: spawn.priority,
        ffa: spawn.f,
        red: spawn.r,
        blue: spawn.b,
        green: spawn.gr,
        yellow: spawn.ye,
        ...(spawn.n === undefined ? {} : { n: spawn.n }),
      }),
    ),
  );
}

/**
 * Convert authored maps for the full session. The strict static seam remains
 * unchanged; only mechanics owned by NativeWorld select the unified backend.
 * Room modes sp and bs run their mode mechanics inside the unified world
 * (native step reads gameSettings.mo at :7221 via the settings argument, and
 * the unified world implements the same sp/bs branches); ar, ard and v have
 * no unified-world mechanics, so their maps stay on the static converter and
 * dynamic mechanics are rejected loudly instead of being silently dropped.
 */
export function nativeMapToArena(rawMap: NativeMap | unknown, roomMode: 'b' | 'sp' | 'bs' = 'b'): NativeSessionArena {
  const map = validateNativeMapJson(rawMap);
  assertSupportedMechanics(map);
  if (roomMode !== 'b' && roomMode !== 'sp' && roomMode !== 'bs') {
    unsupported(
      'roomMode',
      `room mode ${JSON.stringify(roomMode)} has no unified dynamic-world mechanics; Arrow, Death Arrow and VTOL require a static arena`,
    );
  }
  if (map.s.pq !== 1 && map.s.pq !== 2) unsupported('s.pq', `quality ${map.s.pq} is not 1 or 2`);
  for (let index = 0; index < map.physics.fixtures.length; index++) {
    const fixture = map.physics.fixtures[index];
    if (!fixture) continue;
    if (has(fixture, 'fs'))
      unsupported(
        `physics.fixtures[${index}].fs`,
        'foot-sound presentation is not represented by a native session arena',
      );
    if (has(fixture, 'zp'))
      unsupported(
        `physics.fixtures[${index}].zp`,
        'platform-zone metadata is not represented by a native session arena',
      );
  }
  const physics = normalizeNativeMap(map as NativeMapSource, { authored: true });
  const dynamic =
    roomMode !== 'b' ||
    map.capZones.length > 0 ||
    physics.ss.length > 0 ||
    physics.shapes.some((shape) => shape?.sk === true) ||
    physics.joints.some((joint) => joint !== null && joint !== undefined) ||
    physics.bodies.some((body) => body !== null && body !== undefined && body.fz.on) ||
    physics.bodies.some(
      (body) =>
        body !== null &&
        body !== undefined &&
        (body.s.type !== 's' ||
          body.s.f_c !== 1 ||
          !body.s.f_p ||
          !body.s.f_1 ||
          !body.s.f_2 ||
          !body.s.f_3 ||
          !body.s.f_4 ||
          (body.s.type === 's' &&
            (body.cf.x !== 0 || body.cf.y !== 0 || body.cf.ct !== 0 || body.s.ld !== 0 || body.s.ad !== 0)) ||
          body.fx.every((id) => physics.fixtures[id]!.np)),
    ) ||
    physics.fixtures.some(
      (fixture) => fixture !== null && fixture !== undefined && (fixture.np || fixture.ng || fixture.ig),
    ) ||
    physics.bodies.some(
      (body) =>
        body !== null &&
        body !== undefined &&
        body.fx.some((id) => {
          const fixture = physics.fixtures[id]!;
          const shape = physics.shapes[fixture.sh]!;
          const friction = (fixture.fr ?? body.s.fric) * ((fixture.fp ?? body.s.fricp) ? -1 : 1);
          const restitution = fixture.re ?? body.s.re;
          return (
            friction > 1 || restitution < 0 || (shape.type === 'po' && (shape.v.length < 3 || shape.v.length > 100))
          );
        }),
    );
  if (!dynamic) {
    // All remaining static-converter failures are substantive unsupported or
    // malformed mechanics (for example degenerate/self-crossing polygons).
    return nativeMapToStaticArena(map);
  }
  if (map.spawns.length === 0)
    unsupported('spawns', 'map has no authored spawns; refusing to synthesize fallback positions');
  const fixtureOwners = new Set<number>();
  let physicalFixtures = 0;
  for (const body of physics.bodies) {
    if (!body) continue;
    for (const id of body.fx) {
      if (fixtureOwners.has(id)) unsupported('physics.bro', `fixture ${id} has more than one body owner`);
      fixtureOwners.add(id);
      if (!physics.fixtures[id]!.np) physicalFixtures++;
      const shape = physics.shapes[physics.fixtures[id]!.sh]!;
      if (shape.type === 'po') checkPolygon(shape, physics.fixtures[id]!.sh);
    }
  }
  if (physicalFixtures === 0)
    unsupported('physics.bodies', 'map has no physical fixtures; refusing to substitute an empty arena');
  return Object.freeze({
    ppm: physics.ppm,
    settings: Object.freeze({ respawn: map.s.re, noCollision: map.s.nc, fly: map.s.fl, quality: map.s.pq }),
    spawns: sessionSpawns(map, physics),
    physics,
    capZones: Object.freeze(map.capZones.map((zone) => Object.freeze({ ...zone }))),
  });
}

/**
 * Construct a static raw-map session for an explicit original gameSettings.mo.
 * Map metadata m.mo remains an independent display/editor declaration and
 * never selects this room-level physics mode. Modes sp and bs are routed to
 * the dynamic unified-world session when the map needs it (their mechanics
 * live in NativeClassicWorld); ar, ard and v keep the strict static converter
 * so unsupported dynamic mechanics are rejected instead of silently dropped.
 */
export function createNativeMapModeSession(options: NativeMapModeSessionOptions): NativeStaticMapModeSession {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid native map mode session options: expected an object with map, players and seed');
  }
  const raw = options as NativeMapModeSessionOptions & { arena?: unknown };
  if (has(raw, 'arena')) unsupported('options.arena', 'pass either an authored map or an arena, never both');
  const { map, mode, ...sessionOptions } = raw;
  if (mode !== 'b' && mode !== 'sp' && mode !== 'bs' && mode !== undefined) {
    // Arrow, Death Arrow and VTOL mechanics are not implemented in the
    // unified dynamic world; a dynamic map would silently drop them. The
    // strict static converter below rejects those mechanics instead.
    const staticArena = nativeMapToStaticArena(map);
    const session = createNativeModeSession({ ...sessionOptions, arena: staticArena, mode });
    return Object.freeze({
      arena: staticArena,
      getState: session.getState,
      getEvents: session.getEvents,
      step: session.step,
      stepWithEvents: session.stepWithEvents,
      dispose: session.dispose,
    });
  }
  const roomMode = (mode ?? 'b') as 'b' | 'sp' | 'bs';
  const arena = nativeMapToArena(map, roomMode);
  if ('physics' in arena) {
    // sp/bs on a dynamic map: the unified world owns the mode mechanics.
    // The base NativeSession snapshot has no projectile table; expose an
    // empty one so the mode-session contract stays uniform.
    const session = createNativeSession({ ...sessionOptions, arena, mode: roomMode } as NativeSessionOptions);
    const emptyProjectiles: readonly (PhysicsProjectile | undefined)[] = Object.freeze([]);
    const withProjectiles = (base: NativeSessionSnapshot): NativeModeSessionSnapshot =>
      Object.freeze({ ...base, projectiles: emptyProjectiles });
    return Object.freeze({
      arena,
      getState: (): NativeModeSessionSnapshot => withProjectiles(session.getState()),
      getEvents: session.getEvents,
      step: (inputs?: Readonly<Record<number, number>>): NativeModeSessionSnapshot =>
        withProjectiles(session.step(inputs)),
      stepWithEvents: (inputs?: Readonly<Record<number, number>>): NativeModeSessionStep => {
        const result = session.stepWithEvents(inputs);
        return Object.freeze({ ...result, state: withProjectiles(result.state) });
      },
      dispose: session.dispose,
    });
  }
  const session = createNativeModeSession({ ...sessionOptions, arena, mode: roomMode });
  return Object.freeze({
    arena,
    getState: session.getState,
    getEvents: session.getEvents,
    step: session.step,
    stepWithEvents: session.stepWithEvents,
    dispose: session.dispose,
  });
}

/** Construct a native Classic session directly from strict raw native JSON. */
export function createNativeMapSession<A extends NativeSessionArena = NativeStaticArena>(
  options: NativeMapSessionOptions & {
    dynamicWorldFactory?: A extends NativeStaticArena ? never : NativeSessionOptions['dynamicWorldFactory'];
  } & { mode?: 'b' | 'sp' | 'bs' },
): NativeMapSession<A> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid native map session options: expected an object with map, players and seed');
  }
  const raw = options as NativeMapSessionOptions & { arena?: unknown; mode?: 'b' | 'sp' | 'bs' };
  if (has(raw, 'arena')) unsupported('options.arena', 'pass either an authored map or an arena, never both');
  const { map, mode, ...sessionOptions } = raw;
  const roomMode = mode ?? 'b';
  if (roomMode !== 'b' && roomMode !== 'sp' && roomMode !== 'bs') {
    unsupported(
      'options.mode',
      `room mode ${JSON.stringify(roomMode)} has no unified dynamic-world mechanics; Arrow, Death Arrow and VTOL require a static arena`,
    );
  }
  const arena = nativeMapToArena(map, roomMode);
  const session = createNativeSession({
    ...sessionOptions,
    arena,
    ...(roomMode === 'b' ? {} : { mode: roomMode }),
  } as NativeSessionOptions);
  return Object.freeze({
    arena: arena as A,
    getState: session.getState,
    getEvents: session.getEvents,
    step: session.step,
    stepWithEvents: session.stepWithEvents,
    dispose: session.dispose,
  });
}

export type { NativeSession, NativeSessionPlayer } from './native-session';
