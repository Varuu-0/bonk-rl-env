/**
 * Native Bonk map physics state, independently normalized from the public map
 * schema. This module intentionally has no Box2D dependency: it is the durable,
 * renderer-independent state consumed by native-world.ts.
 *
 * The authored map uses pixels and body-relative anchors. Normalization follows
 * createNewState's ordering (including SafeTrig rounding), while per-tick state
 * remains in metres/radians. Sparse indices are data, not compaction hints.
 */
import { safeATan2, safeCos, safeSin, safeTan } from './safe-trig';

export type NativePoint = readonly [number, number];
export type NativeSlot<T> = T | null | undefined;

export interface NativeBodySettings {
  type: 's' | 'd' | 'k';
  n?: string;
  fric: number;
  fricp: boolean;
  re: number;
  de: number;
  ld: number;
  ad: number;
  fr: boolean;
  bu: boolean;
  f_c: number;
  f_p: boolean;
  f_1: boolean;
  f_2: boolean;
  f_3: boolean;
  f_4: boolean;
}

export interface NativeConstantForce {
  x: number;
  y: number;
  ct: number;
  /** Native polarity: false means rotate the vector into the body frame. */
  w: boolean;
}

export interface NativeForceZone {
  on: boolean;
  x: number;
  y: number;
  d: boolean;
  p: boolean;
  a: boolean;
  t: number;
  cf: number;
}

export interface NativeBody {
  s: NativeBodySettings;
  p: NativePoint;
  a: number;
  lv: NativePoint;
  av: number;
  cf: NativeConstantForce;
  fz: NativeForceZone;
  fx: readonly number[];
}

export interface NativeBoxShape {
  type: 'bx';
  c: NativePoint;
  a: number;
  w: number;
  h: number;
  sk: boolean;
}

export interface NativeCircleShape {
  type: 'ci';
  c: NativePoint;
  a: number;
  r: number;
  sk: boolean;
}

export interface NativePolygonShape {
  type: 'po';
  c: NativePoint;
  a: number;
  /** Normalization bakes scale, angle and centre into these local vertices. */
  s: number;
  v: readonly NativePoint[];
  sk: boolean;
}

export type NativeShape = NativeBoxShape | NativeCircleShape | NativePolygonShape;

export interface NativeFixture {
  sh: number;
  n?: string;
  fr: number | null;
  fp: boolean | null;
  re: number | null;
  de: number | null;
  f: number;
  d: boolean;
  np: boolean;
  ng: boolean;
  ig: boolean;
}

export interface NativeJointCommon {
  ba: number;
  bb: number;
  d: {
    cc: boolean;
    bf: number;
    /** Presentation-only draw-line flag; never consumed by Box2D. */
    dl?: boolean;
  };
}

export interface NativeRevoluteJoint extends NativeJointCommon {
  type: 'rv';
  aa: NativePoint;
  ab: NativePoint;
  /** Body-B angle minus body-A angle at normalization. */
  ra: number;
  d: NativeJointCommon['d'] & {
    el: boolean;
    la: number;
    ua: number;
    em: boolean;
    ms: number;
    mmt: number;
  };
}

export interface NativePrismaticJoint extends NativeJointCommon {
  type: 'p';
  /** Presentation-only editor label; absence is native state, not a default. */
  n?: string;
  aa: NativePoint;
  ab: NativePoint;
  axa: NativePoint;
  ra: number;
  /** Persistent native change-side state: 0 neutral, 1 upper, 2 lower. */
  cs: 0 | 1 | 2;
  d: NativeJointCommon['d'] & {
    el: boolean;
    lt: number;
    ut: number;
    em: boolean;
    ms: number;
    mmf: number;
    cd: boolean;
  };
}

export interface NativeDistanceJoint extends NativeJointCommon {
  type: 'd';
  aa: NativePoint;
  ab: NativePoint;
  /** Derived from the two initial world anchors, including ground anchors. */
  len: number;
  d: NativeJointCommon['d'] & {
    fh: number;
    dr: number;
  };
}

export interface NativeLinearPathJoint extends NativeJointCommon {
  type: 'lpj';
  /** Presentation-only editor label; absence is native state, not a default. */
  n?: string;
  /** Path anchor on body B, in metres (authored maps overwrite with body ba's position). */
  pax: number;
  pay: number;
  /** World-space path angle in radians. */
  pa: number;
  /** Motor force, in native force units after ppm² scaling. */
  pf: number;
  /** Presentation-only editor lower-path markers, retained verbatim. */
  pl: number;
  pu: number;
  /** Half the travel range, in metres (limits are ±plen). */
  plen: number;
  /** Motor speed, persisted each tick via GetMotorSpeed writeback. */
  pms: number;
}

export interface NativeLinearSpringJoint extends NativeJointCommon {
  type: 'lsj';
  /** Presentation-only editor label; absence is native state, not a default. */
  n?: string;
  /** Spring anchor on body B, in metres (authored maps overwrite with body ba's position). */
  sax: number;
  say: number;
  /** Spring force coefficient, in native force units after ppm² scaling. */
  sf: number;
  /** Spring natural length, in metres. */
  slen: number;
}

export type NativeJoint =
  NativeRevoluteJoint | NativePrismaticJoint | NativeDistanceJoint | NativeLinearPathJoint | NativeLinearSpringJoint;

export interface NativeShrink extends Array<number> {
  /** Authored shape index; retained as a tuple to match the native carrier. */
  0: number;
  /** Current full box width or circle radius, in metres. */
  1: number;
  length: 2;
}

export interface NativeMapPhysics {
  /** Native countdown carrier: cf applies only when ftu === -1. */
  ftu?: number;
  ppm: number;
  shapes: NativeSlot<NativeShape>[];
  fixtures: NativeSlot<NativeFixture>[];
  bodies: NativeSlot<NativeBody>[];
  joints: NativeSlot<NativeJoint>[];
  bro: readonly number[];
  ss: NativeShrink[];
}

/** Authored maps and stepped native states share this physics-state boundary. */
export interface NativeMapSource {
  /** Native countdown carrier: cf applies only when ftu === -1. */
  ftu?: number;
  physics: {
    ppm: number;
    shapes: readonly NativeSlot<NativeShape>[];
    fixtures: readonly NativeSlot<NativeFixture>[];
    bodies: readonly NativeSlot<NativeBody>[];
    joints?: readonly NativeSlot<NativeJoint | { type: string }>[];
    bro?: readonly number[];
    ss?: readonly NativeShrink[];
  };
}

export interface NormalizeNativeMapOptions {
  /**
   * Authored maps use map pixels. Stepped states are already normalized and
   * must pass false to avoid applying the conversion twice.
   */
  authored?: boolean;
}

function fail(reason: string): never {
  throw new Error(`Invalid native map state: ${reason}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function own(value: Record<string, unknown> | readonly unknown[], key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) fail(`${label}.${key} must be an own data property`);
  return descriptor.value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`);
  return value;
}

function point(value: unknown, label: string): NativePoint {
  if (!Array.isArray(value) || value.length !== 2) fail(`${label} must be a two-number array`);
  const read = (index: number): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) fail(`${label}[${index}] must be an own data property`);
    return descriptor.value;
  };
  return [number(read(0), `${label}[0]`), number(read(1), `${label}[1]`)];
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : bool(value, label);
}

function optionalString(raw: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  const value = own(raw, key, label);
  if (value !== undefined && typeof value !== 'string') fail(`${label}.${key} must be a string`);
  return value as string | undefined;
}

function rotate(x: number, y: number, angle: number): NativePoint {
  const cos = safeCos(angle);
  const sin = safeSin(angle);
  return [cos * x - sin * y, sin * x + cos * y];
}

function slots<T>(value: unknown, label: string, convert: (entry: unknown, index: number) => T): NativeSlot<T>[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const output: NativeSlot<T>[] = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) continue;
    const entry = own(value, String(index), label);
    // Native uses null for deleted joints and permits holes in every table.
    if (entry === null || entry === undefined) {
      output[index] = null;
      continue;
    }
    output[index] = convert(entry, index);
  }
  return output;
}

function normalizeShape(rawValue: unknown, index: number, ppm: number, authored: boolean): NativeShape {
  const label = `physics.shapes[${index}]`;
  const raw = record(rawValue, label);
  const type = own(raw, 'type', label);
  const c = point(own(raw, 'c', label), `${label}.c`);
  const centre: NativePoint = authored ? [c[0] / ppm, c[1] / ppm] : c;
  const angle = number(Object.prototype.hasOwnProperty.call(raw, 'a') ? own(raw, 'a', label) : 0, `${label}.a`);
  const sk = bool(Object.prototype.hasOwnProperty.call(raw, 'sk') ? own(raw, 'sk', label) : false, `${label}.sk`);
  if (type === 'bx') {
    const width = number(own(raw, 'w', label), `${label}.w`);
    const height = number(own(raw, 'h', label), `${label}.h`);
    if (width <= 0 || height <= 0) fail(`${label} dimensions must be positive`);
    return { type, c: centre, a: angle, w: authored ? width / ppm : width, h: authored ? height / ppm : height, sk };
  }
  if (type === 'ci') {
    const radius = number(own(raw, 'r', label), `${label}.r`);
    if (radius <= 0) fail(`${label}.r must be positive`);
    return { type, c: centre, a: angle, r: authored ? radius / ppm : radius, sk };
  }
  if (type === 'po') {
    const scale = number(Object.prototype.hasOwnProperty.call(raw, 's') ? own(raw, 's', label) : 1, `${label}.s`);
    const rawVertices = own(raw, 'v', label);
    if (!Array.isArray(rawVertices)) fail(`${label}.v must be an array`);
    const vertices: NativePoint[] = [];
    for (let vertexIndex = 0; vertexIndex < rawVertices.length; vertexIndex++) {
      let vertex = point(own(rawVertices, String(vertexIndex), `${label}.v`), `${label}.v[${vertexIndex}]`);
      if (authored) {
        const scaledX = (vertex[0] / ppm) * scale;
        const scaledY = (vertex[1] / ppm) * scale;
        const rotated = rotate(scaledX, scaledY, angle);
        vertex = [rotated[0] + centre[0], rotated[1] + centre[1]];
      }
      const previous = vertices[vertices.length - 1];
      // Native removes adjacent duplicates after transformation, including any
      // duplicates introduced by scaling/rounding, but does not close the loop.
      if (previous && previous[0] === vertex[0] && previous[1] === vertex[1]) continue;
      vertices.push(vertex);
    }
    return { type, c: centre, a: angle, s: scale, v: vertices, sk };
  }
  if (type === 'ch') fail(`${label} chain shapes are unsupported by native Physics.step`);
  fail(`${label}.type ${String(type)} is unsupported`);
}

function normalizeFixture(rawValue: unknown, index: number): NativeFixture {
  const label = `physics.fixtures[${index}]`;
  const raw = record(rawValue, label);
  const sh = integer(own(raw, 'sh', label), `${label}.sh`);
  if (sh < 0) fail(`${label}.sh must be nonnegative`);
  const f = number(Object.prototype.hasOwnProperty.call(raw, 'f') ? own(raw, 'f', label) : 0, `${label}.f`);
  return {
    sh,
    ...(optionalString(raw, 'n', label) === undefined ? {} : { n: optionalString(raw, 'n', label) }),
    fr: Object.prototype.hasOwnProperty.call(raw, 'fr') ? nullableNumber(own(raw, 'fr', label), `${label}.fr`) : null,
    fp: Object.prototype.hasOwnProperty.call(raw, 'fp') ? nullableBoolean(own(raw, 'fp', label), `${label}.fp`) : null,
    re: Object.prototype.hasOwnProperty.call(raw, 're') ? nullableNumber(own(raw, 're', label), `${label}.re`) : null,
    de: Object.prototype.hasOwnProperty.call(raw, 'de') ? nullableNumber(own(raw, 'de', label), `${label}.de`) : null,
    f,
    d: bool(Object.prototype.hasOwnProperty.call(raw, 'd') ? own(raw, 'd', label) : false, `${label}.d`),
    np: bool(Object.prototype.hasOwnProperty.call(raw, 'np') ? own(raw, 'np', label) : false, `${label}.np`),
    ng: bool(Object.prototype.hasOwnProperty.call(raw, 'ng') ? own(raw, 'ng', label) : false, `${label}.ng`),
    ig: bool(Object.prototype.hasOwnProperty.call(raw, 'ig') ? own(raw, 'ig', label) : false, `${label}.ig`),
  };
}

function normalizeForceZone(rawValue: unknown, label: string): NativeForceZone {
  if (rawValue === undefined) return { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 };
  const raw = record(rawValue, label);
  const zone: NativeForceZone = {
    on: bool(Object.prototype.hasOwnProperty.call(raw, 'on') ? own(raw, 'on', label) : false, `${label}.on`),
    x: number(Object.prototype.hasOwnProperty.call(raw, 'x') ? own(raw, 'x', label) : 0, `${label}.x`),
    y: number(Object.prototype.hasOwnProperty.call(raw, 'y') ? own(raw, 'y', label) : 0, `${label}.y`),
    d: bool(Object.prototype.hasOwnProperty.call(raw, 'd') ? own(raw, 'd', label) : true, `${label}.d`),
    p: bool(Object.prototype.hasOwnProperty.call(raw, 'p') ? own(raw, 'p', label) : true, `${label}.p`),
    a: bool(Object.prototype.hasOwnProperty.call(raw, 'a') ? own(raw, 'a', label) : true, `${label}.a`),
    t: number(Object.prototype.hasOwnProperty.call(raw, 't') ? own(raw, 't', label) : 0, `${label}.t`),
    cf: number(Object.prototype.hasOwnProperty.call(raw, 'cf') ? own(raw, 'cf', label) : 0, `${label}.cf`),
  };
  // A disabled zone is inert state and is retained for round-trip fidelity.
  // Active zones are applied at contact time by composed worlds (original
  // :4940-4995) and are validated rather than rejected here.
  return zone;
}

function normalizeBody(rawValue: unknown, index: number, ppm: number, authored: boolean): NativeBody {
  const label = `physics.bodies[${index}]`;
  const raw = record(rawValue, label);
  const rawSettings = record(own(raw, 's', label), `${label}.s`);
  const settingsLabel = `${label}.s`;
  const type = own(rawSettings, 'type', settingsLabel);
  if (type !== 's' && type !== 'd' && type !== 'k') fail(`${settingsLabel}.type must be s, d or k`);
  const category = integer(own(rawSettings, 'f_c', settingsLabel), `${settingsLabel}.f_c`);
  if (category < 0 || category > 4) fail(`${settingsLabel}.f_c must be in [0, 4]`);
  const s: NativeBodySettings = {
    type,
    ...(optionalString(rawSettings, 'n', settingsLabel) === undefined
      ? {}
      : { n: optionalString(rawSettings, 'n', settingsLabel) }),
    fric: number(own(rawSettings, 'fric', settingsLabel), `${settingsLabel}.fric`),
    fricp: bool(own(rawSettings, 'fricp', settingsLabel), `${settingsLabel}.fricp`),
    re: number(own(rawSettings, 're', settingsLabel), `${settingsLabel}.re`),
    de: number(own(rawSettings, 'de', settingsLabel), `${settingsLabel}.de`),
    ld: number(own(rawSettings, 'ld', settingsLabel), `${settingsLabel}.ld`),
    ad: number(own(rawSettings, 'ad', settingsLabel), `${settingsLabel}.ad`),
    fr: bool(own(rawSettings, 'fr', settingsLabel), `${settingsLabel}.fr`),
    bu: bool(own(rawSettings, 'bu', settingsLabel), `${settingsLabel}.bu`),
    f_c: category,
    f_p: bool(own(rawSettings, 'f_p', settingsLabel), `${settingsLabel}.f_p`),
    f_1: bool(own(rawSettings, 'f_1', settingsLabel), `${settingsLabel}.f_1`),
    f_2: bool(own(rawSettings, 'f_2', settingsLabel), `${settingsLabel}.f_2`),
    f_3: bool(own(rawSettings, 'f_3', settingsLabel), `${settingsLabel}.f_3`),
    f_4: bool(own(rawSettings, 'f_4', settingsLabel), `${settingsLabel}.f_4`),
  };
  const p = point(own(raw, 'p', label), `${label}.p`);
  const lv = point(own(raw, 'lv', label), `${label}.lv`);
  const cfValue = Object.prototype.hasOwnProperty.call(raw, 'cf') ? own(raw, 'cf', label) : undefined;
  const cfRaw = cfValue === undefined ? undefined : record(cfValue, `${label}.cf`);
  const rawCF = {
    x: number(
      cfRaw && Object.prototype.hasOwnProperty.call(cfRaw, 'x') ? own(cfRaw, 'x', `${label}.cf`) : 0,
      `${label}.cf.x`,
    ),
    y: number(
      cfRaw && Object.prototype.hasOwnProperty.call(cfRaw, 'y') ? own(cfRaw, 'y', `${label}.cf`) : 0,
      `${label}.cf.y`,
    ),
    ct: number(
      cfRaw && Object.prototype.hasOwnProperty.call(cfRaw, 'ct') ? own(cfRaw, 'ct', `${label}.cf`) : 0,
      `${label}.cf.ct`,
    ),
    w: bool(
      cfRaw && Object.prototype.hasOwnProperty.call(cfRaw, 'w') ? own(cfRaw, 'w', `${label}.cf`) : true,
      `${label}.cf.w`,
    ),
  };
  const cf = authored ? { ...rawCF, x: rawCF.x / 30, y: rawCF.y / 30, ct: rawCF.ct / 30 } : rawCF;
  const fxValue = own(raw, 'fx', label);
  if (!Array.isArray(fxValue)) fail(`${label}.fx must be an array`);
  const fx = fxValue.map((value, fixtureIndex) => {
    const id = integer(value, `${label}.fx[${fixtureIndex}]`);
    if (id < 0) fail(`${label}.fx[${fixtureIndex}] must be nonnegative`);
    return id;
  });
  if (new Set(fx).size !== fx.length) fail(`${label}.fx contains a duplicate fixture`);
  const body: NativeBody = {
    s,
    p: authored ? [(p[0] + 365) / ppm, (p[1] + 250) / ppm] : p,
    a: number(own(raw, 'a', label), `${label}.a`),
    lv: type === 's' && authored ? [0, 0] : lv,
    av: type === 's' && authored ? 0 : number(own(raw, 'av', label), `${label}.av`),
    cf: type === 's' && authored ? { ...cf, x: 0, y: 0, ct: 0 } : cf,
    fz: normalizeForceZone(
      Object.prototype.hasOwnProperty.call(raw, 'fz') ? own(raw, 'fz', label) : undefined,
      `${label}.fz`,
    ),
    fx,
  };
  // Read av even for static authored bodies so malformed values cannot hide in
  // a field which normalization subsequently clears.
  if (type === 's' && authored) number(own(raw, 'av', label), `${label}.av`);
  return body;
}

function jointBodies(raw: Record<string, unknown>, label: string): { ba: number; bb: number } {
  const ba = integer(own(raw, 'ba', label), `${label}.ba`);
  const bb = integer(own(raw, 'bb', label), `${label}.bb`);
  if (ba < -2 || bb < -2) fail(`${label} body indices must be -2, -1 or nonnegative`);
  return { ba, bb };
}

function jointBase(raw: Record<string, unknown>, label: string, ppm: number, authored: boolean) {
  const bodies = jointBodies(raw, label);
  const ba = authored && bodies.ba === -2 ? -1 : bodies.ba;
  const bb = authored && bodies.bb === -2 ? -1 : bodies.bb;
  const d = record(own(raw, 'd', label), `${label}.d`);
  const rawBreak = number(
    Object.prototype.hasOwnProperty.call(d, 'bf') ? own(d, 'bf', `${label}.d`) : 0,
    `${label}.d.bf`,
  );
  return {
    ba,
    bb,
    d,
    common: {
      cc: bool(Object.prototype.hasOwnProperty.call(d, 'cc') ? own(d, 'cc', `${label}.d`) : false, `${label}.d.cc`),
      bf: authored && rawBreak > 0 ? rawBreak / (ppm * ppm) : rawBreak,
      ...(Object.prototype.hasOwnProperty.call(d, 'dl')
        ? { dl: bool(own(d, 'dl', `${label}.d`), `${label}.d.dl`) }
        : {}),
    },
  };
}

function normalizeJoint(
  rawValue: unknown,
  index: number,
  bodies: readonly NativeSlot<NativeBody>[],
  ppm: number,
  authored: boolean,
): NativeJoint | null {
  const label = `physics.joints[${index}]`;
  const raw = record(rawValue, label);
  const type = own(raw, 'type', label);
  if (type === 'g') fail(`${label}.type g is unsupported`);
  if (type !== 'rv' && type !== 'p' && type !== 'd' && type !== 'lpj' && type !== 'lsj')
    fail(`${label}.type ${String(type)} is unsupported`);
  const base = jointBase(raw, label, ppm, authored);
  const resolveBody = (id: number, side: string): NativeBody | null => {
    if (id === -1) return null;
    if (id === -2) return null;
    const body = bodies[id];
    if (!body) fail(`${label}.${side} references missing body ${id}`);
    return body;
  };
  const bodyA = resolveBody(base.ba, 'ba');
  const bodyB = resolveBody(base.bb, 'bb');
  // Native createNewState (alpha2s.slot-accurate.numeric.js :4302-4322): lpj
  // anchors are overwritten with body ba's normalized position, plen/pms are
  // pixel-to-metre conversions, pf is a ppm² force conversion; lsj mirrors
  // this with sax/say, slen and sf. Stepped states carry already-normalized
  // values which are preserved verbatim (authored: false).
  if (type === 'lpj') {
    const rawPAX = number(own(raw, 'pax', label), `${label}.pax`);
    const rawPAY = number(own(raw, 'pay', label), `${label}.pay`);
    const rawPA = number(own(raw, 'pa', label), `${label}.pa`);
    const rawPF = number(own(raw, 'pf', label), `${label}.pf`);
    const rawPL = number(own(raw, 'pl', label), `${label}.pl`);
    const rawPU = number(own(raw, 'pu', label), `${label}.pu`);
    const rawPLEN = number(own(raw, 'plen', label), `${label}.plen`);
    const rawPMS = number(own(raw, 'pms', label), `${label}.pms`);
    return {
      type,
      ba: base.ba,
      bb: base.bb,
      ...(optionalString(raw, 'n', label) === undefined ? {} : { n: optionalString(raw, 'n', label) }),
      pax: authored ? bodyA!.p[0] : rawPAX,
      pay: authored ? bodyA!.p[1] : rawPAY,
      pa: rawPA,
      pf: authored ? rawPF / (ppm * ppm) : rawPF,
      pl: rawPL,
      pu: rawPU,
      plen: authored ? rawPLEN / ppm : rawPLEN,
      pms: authored ? rawPMS / ppm : rawPMS,
      d: { ...base.common },
    };
  }
  if (type === 'lsj') {
    const rawSAX = number(own(raw, 'sax', label), `${label}.sax`);
    const rawSAY = number(own(raw, 'say', label), `${label}.say`);
    const rawSF = number(own(raw, 'sf', label), `${label}.sf`);
    const rawSLEN = number(own(raw, 'slen', label), `${label}.slen`);
    return {
      type,
      ba: base.ba,
      bb: base.bb,
      ...(optionalString(raw, 'n', label) === undefined ? {} : { n: optionalString(raw, 'n', label) }),
      sax: authored ? bodyA!.p[0] : rawSAX,
      say: authored ? bodyA!.p[1] : rawSAY,
      sf: authored ? rawSF / (ppm * ppm) : rawSF,
      slen: authored ? rawSLEN / ppm : rawSLEN,
      d: { ...base.common },
    };
  }
  const rawAA = point(own(raw, 'aa', label), `${label}.aa`);
  const aa = authored ? ([rawAA[0] / ppm, rawAA[1] / ppm] as NativePoint) : rawAA;
  if (type === 'rv') {
    let anchorB: NativePoint;
    let localA = aa;
    if (authored) {
      const worldAnchor = bodyA ? ([bodyA.p[0] + aa[0], bodyA.p[1] + aa[1]] as NativePoint) : aa;
      localA = bodyA ? rotate(aa[0], aa[1], -bodyA.a) : aa;
      if (bodyB) {
        const relative = [worldAnchor[0] - bodyB.p[0], worldAnchor[1] - bodyB.p[1]] as NativePoint;
        anchorB = rotate(relative[0], relative[1], -bodyB.a);
      } else {
        anchorB = worldAnchor;
      }
    } else {
      const rawAB = point(own(raw, 'ab', label), `${label}.ab`);
      anchorB = rawAB;
    }
    const d = base.d;
    let lower = number(own(d, 'la', `${label}.d`), `${label}.d.la`);
    let upper = number(own(d, 'ua', `${label}.d`), `${label}.d.ua`);
    let speed = number(own(d, 'ms', `${label}.d`), `${label}.d.ms`);
    if (authored) {
      lower = -lower;
      upper = -upper;
      speed = -speed;
      if (lower > upper) [lower, upper] = [upper, lower];
    }
    return {
      type,
      ba: base.ba,
      bb: base.bb,
      aa: localA,
      ab: anchorB,
      ra: authored
        ? (bodyB?.a ?? 0) - (bodyA?.a ?? 0)
        : number(Object.prototype.hasOwnProperty.call(raw, 'ra') ? own(raw, 'ra', label) : 0, `${label}.ra`),
      d: {
        ...base.common,
        el: bool(own(d, 'el', `${label}.d`), `${label}.d.el`),
        la: lower,
        ua: upper,
        em: bool(own(d, 'em', `${label}.d`), `${label}.d.em`),
        ms: speed,
        mmt: number(own(d, 'mmt', `${label}.d`), `${label}.d.mmt`),
      },
    };
  }
  if (type === 'p') {
    const rawAB = point(own(raw, 'ab', label), `${label}.ab`);
    const ab = authored ? ([rawAB[0] / ppm, rawAB[1] / ppm] as NativePoint) : rawAB;
    const rawAxis = point(own(raw, 'axa', label), `${label}.axa`);
    let axis = rawAxis;
    if (authored && bodyA) {
      const angle = safeATan2(rawAxis[1], rawAxis[0]) - bodyA.a;
      axis = [1, safeTan(angle)];
    }
    const d = base.d;
    const lower = number(own(d, 'lt', `${label}.d`), `${label}.d.lt`);
    const upper = number(own(d, 'ut', `${label}.d`), `${label}.d.ut`);
    const rawForce = number(own(d, 'mmf', `${label}.d`), `${label}.d.mmf`);
    const rawSpeed = number(own(d, 'ms', `${label}.d`), `${label}.d.ms`);
    const rawCS = Object.prototype.hasOwnProperty.call(raw, 'cs') ? integer(own(raw, 'cs', label), `${label}.cs`) : 0;
    if (rawCS !== 0 && rawCS !== 1 && rawCS !== 2) fail(`${label}.cs must be 0, 1 or 2`);
    return {
      type,
      ba: base.ba,
      bb: base.bb,
      aa,
      ab,
      axa: axis,
      ...(optionalString(raw, 'n', label) === undefined ? {} : { n: optionalString(raw, 'n', label) }),
      ra: authored
        ? (bodyB?.a ?? 0) - (bodyA?.a ?? 0)
        : number(Object.prototype.hasOwnProperty.call(raw, 'ra') ? own(raw, 'ra', label) : 0, `${label}.ra`),
      cs: authored ? 0 : rawCS,
      d: {
        ...base.common,
        el: bool(own(d, 'el', `${label}.d`), `${label}.d.el`),
        lt: authored ? lower / ppm : lower,
        ut: authored ? upper / ppm : upper,
        em: bool(own(d, 'em', `${label}.d`), `${label}.d.em`),
        ms: authored ? (rawSpeed / ppm) * 12 : rawSpeed,
        mmf: authored ? (rawForce / (ppm * ppm * ppm)) * 17280 : rawForce,
        cd: bool(Object.prototype.hasOwnProperty.call(d, 'cd') ? own(d, 'cd', `${label}.d`) : false, `${label}.d.cd`),
      },
    };
  }
  const rawAB = point(own(raw, 'ab', label), `${label}.ab`);
  const ab = authored ? ([rawAB[0] / ppm, rawAB[1] / ppm] as NativePoint) : rawAB;
  const d = base.d;
  const rawFrequency = number(own(d, 'fh', `${label}.d`), `${label}.d.fh`);
  let length: number;
  let frequency: number;
  if (authored) {
    const groundAB = base.bb === -1 ? ([ab[0] + 365 / ppm, ab[1] + 250 / ppm] as NativePoint) : ab;
    const rotatedA = rotate(aa[0], aa[1], bodyA?.a ?? 0);
    const rotatedB = rotate(groundAB[0], groundAB[1], bodyB?.a ?? 0);
    const aWorld = [(bodyA?.p[0] ?? 0) + rotatedA[0], (bodyA?.p[1] ?? 0) + rotatedA[1]];
    const bWorld = [(bodyB?.p[0] ?? 0) + rotatedB[0], (bodyB?.p[1] ?? 0) + rotatedB[1]];
    length = Math.hypot(aWorld[0] - bWorld[0], aWorld[1] - bWorld[1]);
    if (length === 0) length = 0.01;
    frequency = rawFrequency === 0 ? 10000 : 1 / rawFrequency;
  } else {
    length = number(own(raw, 'len', label), `${label}.len`);
    frequency = rawFrequency;
  }
  return {
    type,
    ba: base.ba,
    bb: base.bb,
    aa,
    ab: base.bb === -1 && authored ? [ab[0] + 365 / ppm, ab[1] + 250 / ppm] : ab,
    len: length,
    d: {
      ...base.common,
      fh: frequency,
      dr: number(own(d, 'dr', `${label}.d`), `${label}.d.dr`),
    },
  };
}

function clonePhysics(physics: NativeMapPhysics): NativeMapPhysics {
  // Sparse table indices are semantic. Clone each present slot separately,
  // retaining both explicit nulls and holes instead of densifying either one.
  const copySlots = <T>(values: readonly NativeSlot<T>[], copy: (value: T) => T): NativeSlot<T>[] => {
    const result: NativeSlot<T>[] = new Array(values.length);
    for (let index = 0; index < values.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(values, String(index))) continue;
      const value = values[index];
      result[index] = value == null ? value : copy(value);
    }
    return result;
  };
  return {
    ppm: physics.ppm,
    ...(physics.ftu === undefined ? {} : { ftu: physics.ftu }),
    shapes: copySlots(
      physics.shapes,
      (shape) =>
        ({
          ...shape,
          c: [...shape.c] as NativePoint,
          ...(shape.type === 'po' ? { v: shape.v.map((v) => [...v] as NativePoint) } : {}),
        }) as NativeShape,
    ),
    fixtures: copySlots(physics.fixtures, (fixture) => ({ ...fixture })),
    bodies: copySlots(physics.bodies, (body) => ({
      ...body,
      s: { ...body.s },
      p: [...body.p] as NativePoint,
      lv: [...body.lv] as NativePoint,
      cf: { ...body.cf },
      fz: { ...body.fz },
      fx: [...body.fx],
    })),
    joints: copySlots(
      physics.joints,
      (joint) =>
        ({
          ...joint,
          d: { ...joint.d },
          ...(joint.type === 'rv' || joint.type === 'p' || joint.type === 'd'
            ? {
                aa: [...joint.aa] as NativePoint,
                ab: [...joint.ab] as NativePoint,
              }
            : {}),
          ...(joint.type === 'p' ? { axa: [...joint.axa] as NativePoint } : {}),
        }) as NativeJoint,
    ),
    bro: [...physics.bro],
    ss: physics.ss.map((entry) => [entry[0], entry[1]] as NativeShrink),
  };
}

/** Deep-clone a validated state at a tick boundary without re-normalizing it. */
export function cloneNativeMapPhysics(physics: NativeMapPhysics): NativeMapPhysics {
  return clonePhysics(physics);
}

/**
 * Strictly validate and normalize a native map. The default (`authored: true`)
 * performs the createNewState pixel conversion. A stepped map is accepted with
 * `{ authored: false }`; joint anchors and derived distance lengths are then
 * already local/world-normalized and are preserved verbatim.
 */
export function normalizeNativeMap(source: NativeMapSource, options: NormalizeNativeMapOptions = {}): NativeMapPhysics {
  const authored = options.authored !== false;
  const root = record(source, 'map');
  const rawPhysics = record(own(root, 'physics', 'map'), 'map.physics');
  const rawPPM = own(rawPhysics, 'ppm', 'map.physics');
  const suppliedPPM = number(rawPPM, 'map.physics.ppm');
  const ppm = suppliedPPM >= 2 && suppliedPPM <= 300 ? suppliedPPM : 15;
  const shapes = slots(own(rawPhysics, 'shapes', 'map.physics'), 'physics.shapes', (value, index) =>
    normalizeShape(value, index, ppm, authored),
  );
  const fixtures = slots(own(rawPhysics, 'fixtures', 'map.physics'), 'physics.fixtures', normalizeFixture);
  const bodies = slots(own(rawPhysics, 'bodies', 'map.physics'), 'physics.bodies', (value, index) =>
    normalizeBody(value, index, ppm, authored),
  );
  const joints = slots(
    Object.prototype.hasOwnProperty.call(rawPhysics, 'joints') ? own(rawPhysics, 'joints', 'map.physics') : [],
    'physics.joints',
    (value, index) => normalizeJoint(value, index, bodies, ppm, authored),
  );

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    const body = bodies[bodyIndex];
    if (!body) continue;
    for (const fixtureIndex of body.fx) {
      const fixture = fixtures[fixtureIndex];
      if (!fixture) fail(`physics.bodies[${bodyIndex}].fx references missing fixture ${fixtureIndex}`);
      if (!shapes[fixture.sh]) fail(`physics.fixtures[${fixtureIndex}].sh references missing shape ${fixture.sh}`);
    }
  }
  for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
    const fixture = fixtures[fixtureIndex];
    if (fixture && !shapes[fixture.sh])
      fail(`physics.fixtures[${fixtureIndex}].sh references missing shape ${fixture.sh}`);
  }
  for (let jointIndex = 0; jointIndex < joints.length; jointIndex++) {
    const joint = joints[jointIndex];
    if (!joint) continue;
    if (joint.ba === -2 || joint.bb === -2) {
      if (!authored) fail(`physics.joints[${jointIndex}] has an unresolved deleted body reference`);
      joints[jointIndex] = null;
      continue;
    }
    if (
      joint.ba < -1 ||
      joint.bb < -1 ||
      (joint.ba >= 0 && !bodies[joint.ba]) ||
      (joint.bb >= 0 && !bodies[joint.bb])
    ) {
      fail(`physics.joints[${jointIndex}] references a missing body`);
    }
    if (joint.ba === -1 && joint.bb === -1) fail(`physics.joints[${jointIndex}] cannot connect ground to itself`);
  }

  const rawBRO = Object.prototype.hasOwnProperty.call(rawPhysics, 'bro') ? own(rawPhysics, 'bro', 'map.physics') : [];
  if (!Array.isArray(rawBRO)) fail('map.physics.bro must be an array');
  const bro = rawBRO.map((value, index) => {
    const bodyIndex = integer(value, `map.physics.bro[${index}]`);
    if (bodyIndex < 0 || !bodies[bodyIndex]) fail(`map.physics.bro[${index}] references a missing body`);
    return bodyIndex;
  });
  const rawSS = Object.prototype.hasOwnProperty.call(rawPhysics, 'ss') ? own(rawPhysics, 'ss', 'map.physics') : [];
  if (!Array.isArray(rawSS)) fail('map.physics.ss must be an array');
  const seenShrink = new Set<number>();
  const ss: NativeShrink[] = rawSS.map((value, index) => {
    const pair = point(value, `map.physics.ss[${index}]`);
    const shapeIndex = integer(pair[0], `map.physics.ss[${index}][0]`);
    const size = number(pair[1], `map.physics.ss[${index}][1]`);
    const shape = shapes[shapeIndex];
    if (!shape || (shape.type !== 'bx' && shape.type !== 'ci') || !shape.sk)
      fail(`map.physics.ss[${index}] references a non-shrinking shape`);
    if (size <= 0) fail(`map.physics.ss[${index}][1] must be positive`);
    if (seenShrink.has(shapeIndex)) fail(`map.physics.ss contains duplicate shape ${shapeIndex}`);
    seenShrink.add(shapeIndex);
    return [shapeIndex, size];
  });
  return clonePhysics({
    ppm,
    ...(Object.prototype.hasOwnProperty.call(rawPhysics, 'ftu')
      ? { ftu: integer(own(rawPhysics, 'ftu', 'map.physics'), 'map.physics.ftu') }
      : Object.prototype.hasOwnProperty.call(root, 'ftu')
        ? { ftu: integer(own(root, 'ftu', 'map'), 'map.ftu') }
        : {}),
    shapes,
    fixtures,
    bodies,
    joints,
    bro,
    ss,
  });
}
