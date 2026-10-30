import { inflateSync } from 'node:zlib';

/**
 * Strict decoders for Bonk's native map representations and outer transports.
 *
 * Database maps are signed, big-endian BonkView bytes wrapped in Base64 and
 * URI-safe LZString. Legacy maps instead use URI decoding, Base64, zlib and
 * legacy externalized BonkView objects. PSON is a separate representation with
 * its own static dictionary; none of these formats is guessed from another.
 *
 * Derived from the format behavior in .deobf/alpha2s.raw.js and the readable,
 * slot-accurate artifacts. This is an independent implementation, not a client
 * runtime adapter. It performs no coordinate conversion or physics mapping.
 */

export const NATIVE_MAP_MIN_VERSION = 1;
export const NATIVE_MAP_MAX_VERSION = 15;
export const DEFAULT_MAX_NATIVE_MAP_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_NATIVE_MAP_COLLECTION_LENGTH = 0x7fff;

export type NativeMapBinaryInput = Uint8Array | ArrayBuffer;
export type NativeMapVector = [number, number];

export interface NativeMapSettings {
  re: boolean;
  nc: boolean;
  pq: number;
  gd: number;
  fl: boolean;
}

export interface NativeMapMetadata {
  a: string;
  n: string;
  dbv: number;
  dbid: number;
  authid: number;
  date: string;
  rxid: number;
  rxn: string;
  rxa: string;
  rxdb: number;
  cr: string[];
  pub: boolean;
  mo: string;
  /** Added by database version 10. Absent, rather than defaulted, before then. */
  vu?: number;
  /** Added by database version 10. Absent, rather than defaulted, before then. */
  vd?: number;
}

export interface NativeMapBoxShape {
  type: 'bx';
  w: number;
  h: number;
  c: NativeMapVector;
  a: number;
  sk: boolean;
}

export interface NativeMapCircleShape {
  type: 'ci';
  r: number;
  c: NativeMapVector;
  sk: boolean;
}

export interface NativeMapPolygonShape {
  type: 'po';
  v: NativeMapVector[];
  s: number;
  a: number;
  c: NativeMapVector;
}

export type NativeMapShape = NativeMapBoxShape | NativeMapCircleShape | NativeMapPolygonShape | NativeMapChainShape;

/** Native JSON/PSON supports chain shapes; the database binary decoder does not. */
export interface NativeMapChainShape {
  type: 'ch';
  v: NativeMapVector[];
  s: number;
  a: number;
  c: NativeMapVector;
  l: boolean;
  sk: boolean;
}

/** Native PSON/JSON may carry joint labels that have no database-binary field. */
export interface NativeMapJointLabel {
  n?: string;
}

export interface NativeMapFixture {
  /** Signed shape-table reference; ordering and duplicates are significant. */
  sh: number;
  n: string;
  fr: number | null;
  fp: boolean | null;
  re: number | null;
  de: number | null;
  f: number;
  d: boolean;
  np: boolean;
  ng: boolean;
  /** Native JSON-only foot sound; not present in the database binary layout. */
  fs?: string;
  /** Native JSON-only platform zone; not present in the database binary layout. */
  zp?: number;
  /** Added by database version 12. Optional in generic native JSON. */
  ig?: boolean;
}

export interface NativeMapBody {
  p: NativeMapVector;
  a: number;
  lv: NativeMapVector;
  av: number;
  cf: { x: number; y: number; w: boolean; ct: number };
  /** Ordered signed fixture-table references; duplicates are retained. */
  fx: number[];
  fz: {
    on: boolean;
    x: number;
    y: number;
    d: boolean;
    p: boolean;
    a: boolean;
    t: number;
    cf: number;
  };
  s: {
    type: string;
    n: string;
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
  };
}

export interface NativeMapSpawn {
  x: number;
  y: number;
  xv: number;
  yv: number;
  priority: number;
  r: boolean;
  f: boolean;
  b: boolean;
  gr: boolean;
  ye: boolean;
  n: string;
}

export interface NativeMapCapZone {
  n: string;
  ty: number;
  l: number;
  /** Signed fixture reference; -1 is retained as authored. */
  i: number;
}

export interface NativeMapRevoluteJoint extends NativeMapJointLabel {
  type: 'rv';
  d: {
    la: number;
    ua: number;
    mmt: number;
    ms: number;
    el: boolean;
    em: boolean;
    cc: boolean;
    bf: number;
    dl: boolean;
  };
  ba: number;
  bb: number;
  aa: NativeMapVector;
}

/** Native JSON/PSON prismatic joint; there is no database-binary tag for it. */
export interface NativeMapPrismaticJoint extends NativeMapJointLabel {
  type: 'p';
  d: {
    el: boolean;
    lt: number;
    ut: number;
    em: boolean;
    mmf: number;
    ms: number;
    cc: boolean;
    bf: number;
    cd: boolean;
    dl?: boolean;
  };
  ba: number;
  bb: number;
  aa: NativeMapVector;
  ab: NativeMapVector;
  axa: NativeMapVector;
}

export interface NativeMapDistanceJoint extends NativeMapJointLabel {
  type: 'd';
  d: { fh: number; dr: number; cc: boolean; bf: number; dl: boolean };
  ba: number;
  bb: number;
  aa: NativeMapVector;
  ab: NativeMapVector;
}

export interface NativeMapLinearPistonJoint extends NativeMapJointLabel {
  type: 'lpj';
  d: { cc: boolean; bf: number; dl: boolean };
  ba: number;
  bb: number;
  pax: number;
  pay: number;
  pa: number;
  pf: number;
  pl: number;
  pu: number;
  plen: number;
  pms: number;
}

export interface NativeMapLinearSpringJoint extends NativeMapJointLabel {
  type: 'lsj';
  d: { cc: boolean; bf: number; dl: boolean };
  ba: number;
  bb: number;
  sax: number;
  say: number;
  sf: number;
  slen: number;
}

export interface NativeMapGearJoint {
  type: 'g';
  n: string;
  /** Signed joint-table references, including the native -1 default. */
  ja: number;
  jb: number;
  r: number;
}

export type NativeMapJoint =
  | NativeMapRevoluteJoint
  | NativeMapPrismaticJoint
  | NativeMapDistanceJoint
  | NativeMapLinearPistonJoint
  | NativeMapLinearSpringJoint
  | NativeMapGearJoint;

/** Native map JSON, before any downstream normalization or physics conversion. */
export interface NativeMap {
  v: number;
  s: NativeMapSettings;
  physics: {
    shapes: Array<NativeMapShape | null>;
    fixtures: Array<NativeMapFixture | null>;
    bodies: Array<NativeMapBody | null>;
    /** Ordered signed body references used by native body ordering. */
    bro: number[];
    joints: Array<NativeMapJoint | null>;
    ppm: number;
  };
  spawns: NativeMapSpawn[];
  capZones: NativeMapCapZone[];
  m: NativeMapMetadata;
}

export type NativeMapCodecErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OPTIONS'
  | 'INPUT_TOO_LARGE'
  | 'TRUNCATED_INPUT'
  | 'TRAILING_DATA'
  | 'MALFORMED_DATA'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_FEATURE'
  | 'LIMIT_EXCEEDED'
  | 'NON_JSON_VALUE'
  | 'INFLATION_ERROR';

/** A stable, machine-readable failure with the byte offset and native field path. */
export class NativeMapCodecError extends Error {
  override readonly name = 'NativeMapCodecError';
  readonly cause?: unknown;

  constructor(
    readonly code: NativeMapCodecErrorCode,
    message: string,
    readonly offset: number | null = null,
    readonly path: string | null = null,
    cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.cause = cause;
  }
}

export interface DecodeNativeMapOptions {
  /** Reject inputs larger than this before constructing a view. Default: 16 MiB. */
  maxInputBytes?: number;
  /** Maximum length of any one native collection. Default and wire maximum: 32767. */
  maxCollectionLength?: number;
  /** For framing callers only. Strict whole-map decoding is the default. */
  allowTrailingBytes?: boolean;
  /** Maximum decompressed bytes, intermediate Base64 text, or PSON string length. */
  maxIntermediateBytes?: number;
  /** Maximum recursively decoded PSON values. Default: 1,000,000. */
  maxPsonValues?: number;
  /** Maximum nested PSON arrays/objects. Default: 128. */
  maxPsonDepth?: number;
}

interface ResolvedOptions {
  maxInputBytes: number;
  maxCollectionLength: number;
  allowTrailingBytes: boolean;
  maxIntermediateBytes: number;
  maxPsonValues: number;
  maxPsonDepth: number;
}

function fail(
  code: NativeMapCodecErrorCode,
  message: string,
  offset: number | null = null,
  path: string | null = null,
  cause?: unknown,
): never {
  throw new NativeMapCodecError(code, message, offset, path, cause);
}

function resolveOptions(options: DecodeNativeMapOptions): ResolvedOptions {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_NATIVE_MAP_BYTES;
  const maxCollectionLength = options.maxCollectionLength ?? DEFAULT_MAX_NATIVE_MAP_COLLECTION_LENGTH;

  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) {
    fail('INVALID_OPTIONS', 'maxInputBytes must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(maxCollectionLength) ||
    maxCollectionLength < 0 ||
    maxCollectionLength > DEFAULT_MAX_NATIVE_MAP_COLLECTION_LENGTH
  ) {
    fail(
      'INVALID_OPTIONS',
      `maxCollectionLength must be an integer from 0 to ${DEFAULT_MAX_NATIVE_MAP_COLLECTION_LENGTH}`,
    );
  }
  if (typeof options.allowTrailingBytes !== 'undefined' && typeof options.allowTrailingBytes !== 'boolean') {
    fail('INVALID_OPTIONS', 'allowTrailingBytes must be a boolean when provided');
  }

  const maxIntermediateBytes = options.maxIntermediateBytes ?? DEFAULT_MAX_NATIVE_MAP_BYTES;
  const maxPsonValues = options.maxPsonValues ?? 1_000_000;
  const maxPsonDepth = options.maxPsonDepth ?? 128;
  if (!Number.isSafeInteger(maxIntermediateBytes) || maxIntermediateBytes < 0) {
    fail('INVALID_OPTIONS', 'maxIntermediateBytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxPsonValues) || maxPsonValues < 1) {
    fail('INVALID_OPTIONS', 'maxPsonValues must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPsonDepth) || maxPsonDepth < 0) {
    fail('INVALID_OPTIONS', 'maxPsonDepth must be a non-negative safe integer');
  }

  return {
    maxInputBytes,
    maxCollectionLength,
    allowTrailingBytes: options.allowTrailingBytes ?? false,
    maxIntermediateBytes,
    maxPsonValues,
    maxPsonDepth,
  };
}

class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(input: Uint8Array) {
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  private require(size: number, path: string): void {
    if (this.remaining < size) {
      fail(
        'TRUNCATED_INPUT',
        `Truncated native map at ${path}: need ${size} byte(s), have ${this.remaining}`,
        this.offset,
        path,
      );
    }
  }

  u8(path: string): number {
    this.require(1, path);
    return this.view.getUint8(this.offset++);
  }

  boolean(path: string): boolean {
    const value = this.u8(path);
    if (value !== 0 && value !== 1) {
      fail('MALFORMED_DATA', `Invalid native boolean ${value} at ${path}`, this.offset - 1, path);
    }
    return value === 1;
  }

  i16(path: string): number {
    this.require(2, path);
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  i32(path: string): number {
    this.require(4, path);
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  u32(path: string): number {
    this.require(4, path);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  f32(path: string): number {
    this.require(4, path);
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    if (!Number.isFinite(value)) {
      fail('MALFORMED_DATA', `Non-finite float at ${path}`, this.offset - 4, path);
    }
    return value;
  }

  f64(path: string): number {
    this.require(8, path);
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    if (!Number.isFinite(value)) {
      fail('MALFORMED_DATA', `Non-finite double at ${path}`, this.offset - 8, path);
    }
    return value;
  }

  f32le(path: string): number {
    this.require(4, path);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    if (!Number.isFinite(value)) fail('MALFORMED_DATA', `Non-finite PSON float at ${path}`, this.offset - 4, path);
    return value;
  }

  rawF64(path: string): number {
    this.require(8, path);
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  f64le(path: string): number {
    this.require(8, path);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    if (!Number.isFinite(value)) fail('MALFORMED_DATA', `Non-finite PSON double at ${path}`, this.offset - 8, path);
    return value;
  }

  nullableF64(path: string): number | null {
    const value = this.f64(path);
    return value === Number.MAX_VALUE ? null : value;
  }

  vector(path: string): NativeMapVector {
    return [this.f64(`${path}[0]`), this.f64(`${path}[1]`)];
  }

  utf(path: string): string {
    const high = this.u8(`${path}.length`);
    const low = this.u8(`${path}.length`);
    const length = high * 256 + low;
    this.require(length, path);
    const start = this.offset;
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + start, length);
    this.offset += length;
    try {
      // Native strings are length-prefixed UTF-8, not UTF-16 code units.
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      return fail('MALFORMED_DATA', `Invalid UTF-8 at ${path}`, start, path, cause);
    }
  }
}

function blankMap(): NativeMap {
  return {
    v: 1,
    s: { re: false, nc: false, pq: 1, gd: 25, fl: false },
    physics: { shapes: [], fixtures: [], bodies: [], bro: [], joints: [], ppm: 12 },
    spawns: [],
    capZones: [],
    m: {
      a: 'noauthor',
      n: 'noname',
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
      mo: '',
    },
  };
}

function blankBody(): NativeMapBody {
  return {
    p: [0, 0],
    a: 0,
    lv: [0, 0],
    av: 0,
    cf: { x: 0, y: 0, w: true, ct: 0 },
    fx: [],
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    s: {
      type: 's',
      n: 'Unnamed',
      fric: 0.3,
      fricp: false,
      re: 0.8,
      de: 0.3,
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
  };
}

function collectionLength(reader: BinaryReader, path: string, maximum: number): number {
  const length = reader.i16(path);
  if (length < 0) {
    fail('MALFORMED_DATA', `Negative collection length ${length} at ${path}`, reader.position - 2, path);
  }
  if (length > maximum) {
    fail(
      'LIMIT_EXCEEDED',
      `Collection length ${length} exceeds configured maximum ${maximum} at ${path}`,
      reader.position - 2,
      path,
    );
  }
  return length;
}

function readShape(reader: BinaryReader, index: number, maximum: number): NativeMapShape {
  const path = `physics.shapes[${index}]`;
  const typeOffset = reader.position;
  const type = reader.i16(`${path}.type`);
  switch (type) {
    case 1:
      return {
        type: 'bx',
        w: reader.f64(`${path}.w`),
        h: reader.f64(`${path}.h`),
        c: reader.vector(`${path}.c`),
        a: reader.f64(`${path}.a`),
        sk: reader.boolean(`${path}.sk`),
      };
    case 2:
      return {
        type: 'ci',
        r: reader.f64(`${path}.r`),
        c: reader.vector(`${path}.c`),
        sk: reader.boolean(`${path}.sk`),
      };
    case 3: {
      const scale = reader.f64(`${path}.s`);
      const angle = reader.f64(`${path}.a`);
      const center = reader.vector(`${path}.c`);
      const length = collectionLength(reader, `${path}.v.length`, maximum);
      const vertices: NativeMapVector[] = [];
      for (let i = 0; i < length; i++) {
        vertices.push(reader.vector(`${path}.v[${i}]`));
      }
      return { type: 'po', v: vertices, s: scale, a: angle, c: center };
    }
    default:
      return fail(
        'UNSUPPORTED_FEATURE',
        `Unsupported native shape discriminator ${type} at ${path}`,
        typeOffset,
        `${path}.type`,
      );
  }
}

function readFixture(reader: BinaryReader, index: number, version: number): NativeMapFixture {
  const path = `physics.fixtures[${index}]`;
  const fixture: NativeMapFixture = {
    sh: reader.i16(`${path}.sh`),
    n: reader.utf(`${path}.n`),
    fr: reader.nullableF64(`${path}.fr`),
    fp: null,
    re: null,
    de: null,
    f: 0,
    d: false,
    np: false,
    ng: false,
  };

  const fpOffset = reader.position;
  const fp = reader.i16(`${path}.fp`);
  if (fp === 0) fixture.fp = null;
  else if (fp === 1) fixture.fp = false;
  else if (fp === 2) fixture.fp = true;
  else fail('MALFORMED_DATA', `Invalid fixture fp discriminator ${fp}`, fpOffset, `${path}.fp`);

  fixture.re = reader.nullableF64(`${path}.re`);
  fixture.de = reader.nullableF64(`${path}.de`);
  fixture.f = reader.u32(`${path}.f`);
  fixture.d = reader.boolean(`${path}.d`);
  fixture.np = reader.boolean(`${path}.np`);
  if (version >= 11) fixture.ng = reader.boolean(`${path}.ng`);
  if (version >= 12) fixture.ig = reader.boolean(`${path}.ig`);
  return fixture;
}

function readBody(reader: BinaryReader, index: number, version: number, maximum: number): NativeMapBody {
  const path = `physics.bodies[${index}]`;
  const body = blankBody();
  body.s.type = reader.utf(`${path}.s.type`);
  body.s.n = reader.utf(`${path}.s.n`);
  body.p = reader.vector(`${path}.p`);
  body.a = reader.f64(`${path}.a`);
  body.s.fric = reader.f64(`${path}.s.fric`);
  body.s.fricp = reader.boolean(`${path}.s.fricp`);
  body.s.re = reader.f64(`${path}.s.re`);
  body.s.de = reader.f64(`${path}.s.de`);
  body.lv = reader.vector(`${path}.lv`);
  body.av = reader.f64(`${path}.av`);
  body.s.ld = reader.f64(`${path}.s.ld`);
  body.s.ad = reader.f64(`${path}.s.ad`);
  body.s.fr = reader.boolean(`${path}.s.fr`);
  body.s.bu = reader.boolean(`${path}.s.bu`);
  body.cf.x = reader.f64(`${path}.cf.x`);
  body.cf.y = reader.f64(`${path}.cf.y`);
  body.cf.ct = reader.f64(`${path}.cf.ct`);
  body.cf.w = reader.boolean(`${path}.cf.w`);
  body.s.f_c = reader.i16(`${path}.s.f_c`);
  body.s.f_1 = reader.boolean(`${path}.s.f_1`);
  body.s.f_2 = reader.boolean(`${path}.s.f_2`);
  body.s.f_3 = reader.boolean(`${path}.s.f_3`);
  body.s.f_4 = reader.boolean(`${path}.s.f_4`);
  if (version >= 2) body.s.f_p = reader.boolean(`${path}.s.f_p`);
  if (version >= 14) {
    body.fz.on = reader.boolean(`${path}.fz.on`);
    if (body.fz.on) {
      body.fz.x = reader.f64(`${path}.fz.x`);
      body.fz.y = reader.f64(`${path}.fz.y`);
      body.fz.d = reader.boolean(`${path}.fz.d`);
      body.fz.p = reader.boolean(`${path}.fz.p`);
      body.fz.a = reader.boolean(`${path}.fz.a`);
      if (version >= 15) {
        body.fz.t = reader.i16(`${path}.fz.t`);
        body.fz.cf = reader.f64(`${path}.fz.cf`);
      }
    }
  }
  const fixtureCount = collectionLength(reader, `${path}.fx.length`, maximum);
  for (let i = 0; i < fixtureCount; i++) {
    body.fx.push(reader.i16(`${path}.fx[${i}]`));
  }
  return body;
}

function readSpawn(reader: BinaryReader, index: number): NativeMapSpawn {
  const path = `spawns[${index}]`;
  return {
    x: reader.f64(`${path}.x`),
    y: reader.f64(`${path}.y`),
    xv: reader.f64(`${path}.xv`),
    yv: reader.f64(`${path}.yv`),
    priority: reader.i16(`${path}.priority`),
    r: reader.boolean(`${path}.r`),
    f: reader.boolean(`${path}.f`),
    b: reader.boolean(`${path}.b`),
    gr: reader.boolean(`${path}.gr`),
    ye: reader.boolean(`${path}.ye`),
    n: reader.utf(`${path}.n`),
  };
}

function readCapZone(reader: BinaryReader, index: number, version: number): NativeMapCapZone {
  const path = `capZones[${index}]`;
  const zone: NativeMapCapZone = {
    n: reader.utf(`${path}.n`),
    ty: 1,
    l: reader.f64(`${path}.l`),
    i: reader.i16(`${path}.i`),
  };
  if (version >= 6) zone.ty = reader.i16(`${path}.ty`);
  return zone;
}

function readJoint(reader: BinaryReader, index: number): NativeMapJoint {
  const path = `physics.joints[${index}]`;
  const typeOffset = reader.position;
  const type = reader.i16(`${path}.type`);
  let joint: NativeMapJoint;

  switch (type) {
    case 1:
      joint = {
        type: 'rv',
        d: {
          la: reader.f64(`${path}.d.la`),
          ua: reader.f64(`${path}.d.ua`),
          mmt: reader.f64(`${path}.d.mmt`),
          ms: reader.f64(`${path}.d.ms`),
          el: reader.boolean(`${path}.d.el`),
          em: reader.boolean(`${path}.d.em`),
          cc: false,
          bf: 0,
          dl: true,
        },
        ba: 0,
        bb: 0,
        aa: reader.vector(`${path}.aa`),
      };
      break;
    case 2:
      joint = {
        type: 'd',
        d: {
          fh: reader.f64(`${path}.d.fh`),
          dr: reader.f64(`${path}.d.dr`),
          cc: false,
          bf: 0,
          dl: true,
        },
        ba: 0,
        bb: 0,
        aa: reader.vector(`${path}.aa`),
        ab: reader.vector(`${path}.ab`),
      };
      break;
    case 3:
      joint = {
        type: 'lpj',
        d: { cc: false, bf: 0, dl: true },
        ba: 0,
        bb: 0,
        pax: reader.f64(`${path}.pax`),
        pay: reader.f64(`${path}.pay`),
        pa: reader.f64(`${path}.pa`),
        pf: reader.f64(`${path}.pf`),
        pl: reader.f64(`${path}.pl`),
        pu: reader.f64(`${path}.pu`),
        plen: reader.f64(`${path}.plen`),
        pms: reader.f64(`${path}.pms`),
      };
      break;
    case 4:
      joint = {
        type: 'lsj',
        d: { cc: false, bf: 0, dl: true },
        ba: 0,
        bb: 0,
        sax: reader.f64(`${path}.sax`),
        say: reader.f64(`${path}.say`),
        sf: reader.f64(`${path}.sf`),
        slen: reader.f64(`${path}.slen`),
      };
      break;
    case 5:
      return {
        type: 'g',
        n: reader.utf(`${path}.n`),
        ja: reader.i16(`${path}.ja`),
        jb: reader.i16(`${path}.jb`),
        r: reader.f64(`${path}.r`),
      };
    default:
      return fail(
        'UNSUPPORTED_FEATURE',
        `Unsupported native joint discriminator ${type} at ${path}`,
        typeOffset,
        `${path}.type`,
      );
  }

  joint.ba = reader.i16(`${path}.ba`);
  joint.bb = reader.i16(`${path}.bb`);
  joint.d.cc = reader.boolean(`${path}.d.cc`);
  joint.d.bf = reader.f64(`${path}.d.bf`);
  joint.d.dl = reader.boolean(`${path}.d.dl`);
  return joint;
}

function decodeBytes(input: Uint8Array, options: ResolvedOptions): NativeMap {
  const reader = new BinaryReader(input);
  const map = blankMap();
  map.v = reader.i16('v');
  if (map.v < NATIVE_MAP_MIN_VERSION || map.v > NATIVE_MAP_MAX_VERSION) {
    fail(
      'UNSUPPORTED_VERSION',
      `Unsupported native map version ${map.v}; supported versions are ${NATIVE_MAP_MIN_VERSION}-${NATIVE_MAP_MAX_VERSION}`,
      0,
      'v',
    );
  }

  map.s.re = reader.boolean('s.re');
  map.s.nc = reader.boolean('s.nc');
  if (map.v >= 3) map.s.pq = reader.i16('s.pq');
  if (map.v >= 4 && map.v <= 12) map.s.gd = reader.i16('s.gd');
  else if (map.v >= 13) map.s.gd = reader.f32('s.gd');
  if (map.v >= 9) map.s.fl = reader.boolean('s.fl');

  map.m.rxn = reader.utf('m.rxn');
  map.m.rxa = reader.utf('m.rxa');
  map.m.rxid = reader.u32('m.rxid');
  map.m.rxdb = reader.i16('m.rxdb');
  map.m.n = reader.utf('m.n');
  map.m.a = reader.utf('m.a');
  if (map.v >= 10) {
    map.m.vu = reader.u32('m.vu');
    map.m.vd = reader.u32('m.vd');
  }
  if (map.v >= 4) {
    const count = collectionLength(reader, 'm.cr.length', options.maxCollectionLength);
    for (let i = 0; i < count; i++) map.m.cr.push(reader.utf(`m.cr[${i}]`));
  }
  if (map.v >= 5) {
    map.m.mo = reader.utf('m.mo');
    map.m.dbid = reader.i32('m.dbid');
  }
  if (map.v >= 7) map.m.pub = reader.boolean('m.pub');
  if (map.v >= 8) map.m.dbv = reader.i32('m.dbv');

  map.physics.ppm = reader.i16('physics.ppm');
  const broCount = collectionLength(reader, 'physics.bro.length', options.maxCollectionLength);
  for (let i = 0; i < broCount; i++) map.physics.bro.push(reader.i16(`physics.bro[${i}]`));

  const shapeCount = collectionLength(reader, 'physics.shapes.length', options.maxCollectionLength);
  for (let i = 0; i < shapeCount; i++) map.physics.shapes.push(readShape(reader, i, options.maxCollectionLength));

  const fixtureCount = collectionLength(reader, 'physics.fixtures.length', options.maxCollectionLength);
  for (let i = 0; i < fixtureCount; i++) map.physics.fixtures.push(readFixture(reader, i, map.v));

  const bodyCount = collectionLength(reader, 'physics.bodies.length', options.maxCollectionLength);
  for (let i = 0; i < bodyCount; i++) {
    map.physics.bodies.push(readBody(reader, i, map.v, options.maxCollectionLength));
  }

  const spawnCount = collectionLength(reader, 'spawns.length', options.maxCollectionLength);
  for (let i = 0; i < spawnCount; i++) map.spawns.push(readSpawn(reader, i));

  const capZoneCount = collectionLength(reader, 'capZones.length', options.maxCollectionLength);
  for (let i = 0; i < capZoneCount; i++) map.capZones.push(readCapZone(reader, i, map.v));

  const jointCount = collectionLength(reader, 'physics.joints.length', options.maxCollectionLength);
  for (let i = 0; i < jointCount; i++) map.physics.joints.push(readJoint(reader, i));

  if (!options.allowTrailingBytes && reader.remaining !== 0) {
    fail(
      'TRAILING_DATA',
      `Native map has ${reader.remaining} trailing byte(s) after physics.joints`,
      reader.position,
      'physics.joints',
    );
  }
  return map;
}

/**
 * Decode exactly one native database map from bytes into version-migrated native JSON.
 *
 * No PSON, Base64, LZString, zlib, browser, or bonk-game runtime is consulted.
 * Unsupported discriminants and malformed streams are never returned as holes.
 */
export function decodeNativeMapBinary(input: NativeMapBinaryInput, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    return fail('INVALID_INPUT', 'Native map input must be a Uint8Array or ArrayBuffer');
  }

  if (bytes.byteLength > resolved.maxInputBytes) {
    return fail(
      'INPUT_TOO_LARGE',
      `Native map input is ${bytes.byteLength} bytes; maximum is ${resolved.maxInputBytes}`,
      0,
    );
  }
  try {
    return decodeBytes(bytes, resolved);
  } catch (cause) {
    if (cause instanceof NativeMapCodecError) throw cause;
    return fail('MALFORMED_DATA', 'Unable to read native map binary input', null, null, cause);
  }
}

/** Concise alias for callers whose input contract is already explicitly binary. */
export const decodeNativeMap = decodeNativeMapBinary;

/* ------------------------------------------------------------------------- *
 * Strict string transports
 * ------------------------------------------------------------------------- */

const URI_LZ_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function textInput(input: unknown, label: string, options: ResolvedOptions): string {
  if (typeof input !== 'string') fail('INVALID_INPUT', `${label} must be a string`);
  if (input.length > options.maxInputBytes) {
    fail(
      'INPUT_TOO_LARGE',
      `${label} is ${input.length} UTF-16 code units; maximum is ${options.maxInputBytes}`,
      0,
      label,
    );
  }
  return input;
}

function decodeUriComponentStrict(input: string, options: ResolvedOptions, path: string): string {
  const bytes: number[] = [];
  const push = (byte: number, offset: number) => {
    bytes.push(byte);
    if (bytes.length > options.maxIntermediateBytes) {
      fail('LIMIT_EXCEEDED', `URI-decoded payload exceeds ${options.maxIntermediateBytes} bytes`, offset, path);
    }
  };
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code === 0x25) {
      if (index + 2 >= input.length) fail('TRUNCATED_INPUT', 'Truncated URI escape', index, path);
      const hex = input.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) fail('MALFORMED_DATA', `Invalid URI escape %${hex}`, index, path);
      push(Number.parseInt(hex, 16), index);
      index += 2;
      continue;
    }
    let codePoint = code;
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) fail('MALFORMED_DATA', 'Unpaired URI surrogate', index, path);
      codePoint = (code - 0xd800) * 0x400 + low - 0xdc00 + 0x10000;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('MALFORMED_DATA', 'Unpaired URI surrogate', index, path);
    }
    if (codePoint <= 0x7f) push(codePoint, index);
    else if (codePoint <= 0x7ff) {
      push(0xc0 | (codePoint >>> 6), index);
      push(0x80 | (codePoint & 0x3f), index);
    } else if (codePoint <= 0xffff) {
      push(0xe0 | (codePoint >>> 12), index);
      push(0x80 | ((codePoint >>> 6) & 0x3f), index);
      push(0x80 | (codePoint & 0x3f), index);
    } else {
      push(0xf0 | (codePoint >>> 18), index);
      push(0x80 | ((codePoint >>> 12) & 0x3f), index);
      push(0x80 | ((codePoint >>> 6) & 0x3f), index);
      push(0x80 | (codePoint & 0x3f), index);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch (cause) {
    return fail('MALFORMED_DATA', 'URI-decoded payload is not valid UTF-8', null, path, cause);
  }
}

function decodeBase64Strict(input: string, options: ResolvedOptions, path: string): Uint8Array {
  if (input.length % 4 !== 0) fail('MALFORMED_DATA', 'Base64 length must be a multiple of four', input.length, path);
  if (input.length > options.maxIntermediateBytes) {
    fail('LIMIT_EXCEEDED', `Base64 payload exceeds ${options.maxIntermediateBytes} bytes`, input.length, path);
  }
  const padding = input.length === 0 ? 0 : input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((input.length / 4) * 3 - padding);
  let outputOffset = 0;
  for (let offset = 0; offset < input.length; offset += 4) {
    const final = offset + 4 === input.length;
    const values: number[] = [];
    for (let index = 0; index < 4; index++) {
      const character = input[offset + index]!;
      if (character === '=') {
        if (!final || index < 2 || (index === 2 && input[offset + 3] !== '=')) {
          fail('MALFORMED_DATA', 'Invalid Base64 padding', offset + index, path);
        }
        values.push(0);
      } else {
        if (final && padding > 0 && index >= 4 - padding)
          fail('MALFORMED_DATA', 'Invalid Base64 padding', offset + index, path);
        const value = BASE64_ALPHABET.indexOf(character);
        if (value < 0)
          fail('MALFORMED_DATA', `Invalid Base64 character ${JSON.stringify(character)}`, offset + index, path);
        values.push(value);
      }
    }
    if (final && ((padding === 1 && (values[2]! & 3) !== 0) || (padding === 2 && (values[1]! & 15) !== 0))) {
      fail('MALFORMED_DATA', 'Non-zero unused bits in Base64 padding', offset, path);
    }
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (outputOffset < output.length) output[outputOffset++] = (triple >>> 16) & 0xff;
    if (outputOffset < output.length) output[outputOffset++] = (triple >>> 8) & 0xff;
    if (outputOffset < output.length) output[outputOffset++] = triple & 0xff;
  }
  return output;
}

/** Decode URI-safe LZString with explicit input, output, dictionary and EOF checks. */
function decompressUriLzString(input: string, options: ResolvedOptions, path: string): string {
  if (input.length === 0) fail('TRUNCATED_INPUT', 'Empty URI-LZString payload', 0, path);
  const chunks: string[] = [];
  let outputLength = 0;
  const append = (text: string, offset: number) => {
    outputLength += text.length;
    if (outputLength > options.maxIntermediateBytes) {
      fail('LIMIT_EXCEEDED', `LZString output exceeds ${options.maxIntermediateBytes} UTF-16 code units`, offset, path);
    }
    chunks.push(text);
  };
  let bitOffset = 0;
  const readBits = (count: number): number => {
    if (bitOffset + count > input.length * 6)
      fail('TRUNCATED_INPUT', `Truncated ${count}-bit LZString symbol`, bitOffset, path);
    let value = 0;
    for (let bit = 0; bit < count; bit++) {
      const character = input.charCodeAt(Math.floor(bitOffset / 6));
      const alphabetIndex = URI_LZ_ALPHABET.indexOf(String.fromCharCode(character));
      if (alphabetIndex < 0)
        fail('MALFORMED_DATA', 'Invalid URI-LZString alphabet character', Math.floor(bitOffset / 6), path);
      value |= ((alphabetIndex >>> (5 - (bitOffset % 6))) & 1) << bit;
      bitOffset++;
    }
    return value;
  };
  const dictionary: Array<string | undefined> = [undefined, undefined, undefined];
  let dictionarySize = 4;
  let bitCount = 3;
  let enlargeIn = 4;
  const initial = readBits(2);
  let current: string;
  if (initial === 0) current = String.fromCharCode(readBits(8));
  else if (initial === 1) current = String.fromCharCode(readBits(16));
  else {
    if (bitOffset !== input.length * 6) fail('TRAILING_DATA', 'Data follows empty LZString stream', bitOffset, path);
    return '';
  }
  dictionary[3] = current;
  append(current, bitOffset);
  let previous = current;
  while (true) {
    let code = readBits(bitCount);
    if (code === 0 || code === 1) {
      dictionary[dictionarySize++] = String.fromCharCode(readBits(code === 0 ? 8 : 16));
      code = dictionarySize - 1;
      enlargeIn--;
    } else if (code === 2) {
      const remaining = input.length * 6 - bitOffset;
      if (remaining >= 6) {
        const finalAlphabetIndex = URI_LZ_ALPHABET.indexOf(input[input.length - 1]!);
        if (finalAlphabetIndex < 0)
          fail('MALFORMED_DATA', 'Invalid final URI-LZString character', input.length - 1, path);
        // Some original encoders flush one extra all-zero six-bit character
        // after the end marker. Accept that zero padding, never arbitrary data.
        if (remaining !== 6 || finalAlphabetIndex !== 0) {
          fail('TRAILING_DATA', 'Characters follow the LZString end marker', bitOffset, path);
        }
      }
      while (bitOffset < input.length * 6) {
        if (readBits(1) !== 0) fail('MALFORMED_DATA', 'Non-zero LZString padding', bitOffset - 1, path);
      }
      return chunks.join('');
    }
    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount++;
    }
    let entry = dictionary[code];
    if (entry === undefined) {
      if (code !== dictionarySize)
        fail('MALFORMED_DATA', `Unknown LZString dictionary reference ${code}`, bitOffset, path);
      entry = previous + previous.charAt(0);
    }
    append(entry, bitOffset);
    dictionary[dictionarySize++] = previous + entry.charAt(0);
    enlargeIn--;
    previous = entry;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount++;
    }
  }
}

function resolveBinaryInput(input: NativeMapBinaryInput, options: ResolvedOptions): Uint8Array {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else return fail('INVALID_INPUT', 'Native map input must be a Uint8Array or ArrayBuffer');
  if (bytes.byteLength > options.maxInputBytes) {
    fail('INPUT_TOO_LARGE', `Native map input is ${bytes.byteLength} bytes; maximum is ${options.maxInputBytes}`, 0);
  }
  return bytes;
}

/** Decode the dbv=2 text payload: URI-LZString -> Base64 -> database binary. */
export function decodeNativeMapDatabasePayload(payload: string, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  const text = textInput(payload, 'payload', resolved);
  const base64 = decompressUriLzString(text, resolved, 'payload.lzstring');
  return decodeNativeMapBinary(decodeBase64Strict(base64, resolved, 'payload.base64'), resolved);
}

/** Explicitly decode database binary from Base64, without applying LZString. */
export function decodeNativeMapDatabaseBase64(payload: string, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  const text = textInput(payload, 'payload', resolved);
  return decodeNativeMapBinary(decodeBase64Strict(text, resolved, 'payload.base64'), resolved);
}

export interface NativeMapEnvelope {
  dbv: string;
  name: string;
  author: string;
  id: string;
  payload: string;
}

/** Decode the five-field built-in map envelope and apply its authoritative metadata. */
export function decodeNativeMapEnvelope(
  envelope: string | NativeMapEnvelope,
  options: DecodeNativeMapOptions = {},
): NativeMap {
  const resolved = resolveOptions(options);
  let fields: NativeMapEnvelope;
  if (typeof envelope === 'string') {
    textInput(envelope, 'envelope', resolved);
    const split = envelope.split(',');
    if (split.length !== 5)
      fail('MALFORMED_DATA', `Native map envelope must have five fields, found ${split.length}`, null, 'envelope');
    fields = { dbv: split[0]!, name: split[1]!, author: split[2]!, id: split[3]!, payload: split[4]! };
  } else {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return fail('INVALID_INPUT', 'Native map envelope must be a string or a five-field object');
    }
    const raw = envelope as unknown as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!['dbv', 'name', 'author', 'id', 'payload'].includes(key)) {
        fail('UNSUPPORTED_FEATURE', `Unknown native map envelope field ${key}`, null, `envelope.${key}`);
      }
    }
    for (const key of ['dbv', 'name', 'author', 'id', 'payload']) {
      if (typeof raw[key] !== 'string')
        fail('MALFORMED_DATA', `Envelope ${key} must be a string`, null, `envelope.${key}`);
    }
    fields = envelope;
  }
  if (fields.dbv !== '1' && fields.dbv !== '2') {
    fail('UNSUPPORTED_VERSION', `Unsupported outer native map dbv ${fields.dbv}`, null, 'envelope.dbv');
  }
  if (!/^-?\d+$/.test(fields.id)) fail('MALFORMED_DATA', 'Envelope id must be a decimal integer', null, 'envelope.id');
  const id = Number(fields.id);
  if (!Number.isSafeInteger(id) || id < -0x80000000 || id > 0x7fffffff) {
    fail('MALFORMED_DATA', 'Envelope id must fit signed int32', null, 'envelope.id');
  }
  const map =
    fields.dbv === '1'
      ? decodeLegacyNativeMapPayload(fields.payload, resolved)
      : decodeNativeMapDatabasePayload(fields.payload, resolved);
  map.m.dbid = id;
  map.m.dbv = Number(fields.dbv);
  map.m.n = fields.name;
  map.m.a = fields.author;
  return map;
}

/* ------------------------------------------------------------------------- *
 * PSON with the pinned native static dictionary
 * ------------------------------------------------------------------------- */

/** Exact order of Map.dict in the pinned client. Do not sort or de-duplicate it. */
export const NATIVE_MAP_PSON_DICTIONARY = Object.freeze([
  'physics',
  'shapes',
  'fixtures',
  'bodies',
  'bro',
  'joints',
  'ppm',
  'lights',
  'spawns',
  'lasers',
  'capZones',
  'type',
  'w',
  'h',
  'c',
  'a',
  'v',
  'l',
  's',
  'sh',
  'fr',
  're',
  'de',
  'sn',
  'fc',
  'fm',
  'f',
  'd',
  'n',
  'bg',
  'lv',
  'av',
  'ld',
  'ad',
  'fr',
  'bu',
  'cf',
  'rv',
  'p',
  'd',
  'bf',
  'ba',
  'bb',
  'aa',
  'ab',
  'axa',
  'dr',
  'em',
  'mmt',
  'mms',
  'ms',
  'ut',
  'lt',
  'New body',
  'Box Shape',
  'Circle Shape',
  'Polygon Shape',
  'EdgeChain Shape',
  'priority',
  'Light',
  'Laser',
  'Cap Zone',
  'BG Shape',
  'Background Layer',
  'Rotate Joint',
  'Slider Joint',
  'Rod Joint',
  'Gear Joint',
  '65535',
  '16777215',
] as const);

class PsonReader extends BinaryReader {
  private values = 0;
  constructor(
    input: Uint8Array,
    private readonly options: ResolvedOptions,
  ) {
    super(input);
  }

  varuint(path: string): number {
    const start = this.position;
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.u8(path);
      if (index === 4 && (byte & 0xf0) !== 0) fail('MALFORMED_DATA', 'PSON varuint32 overflows 32 bits', start, path);
      value += (byte & 0x7f) * 2 ** (index * 7);
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) fail('MALFORMED_DATA', 'Noncanonical PSON varuint32', start, path);
        return value >>> 0;
      }
    }
    return fail('MALFORMED_DATA', 'Unterminated PSON varuint32', start, path);
  }

  string(path: string): string {
    const length = this.varuint(`${path}.length`);
    if (length > this.options.maxIntermediateBytes)
      fail('LIMIT_EXCEEDED', `PSON string exceeds configured limit`, this.position, path);
    const start = this.position;
    const bytes: number[] = [];
    for (let index = 0; index < length; index++) bytes.push(this.u8(path));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch (cause) {
      return fail('MALFORMED_DATA', 'Invalid UTF-8 in PSON string', start, path, cause);
    }
  }

  value(path: string, depth: number): unknown {
    if (++this.values > this.options.maxPsonValues)
      fail('LIMIT_EXCEEDED', 'PSON value count exceeds configured limit', this.position, path);
    if (depth > this.options.maxPsonDepth)
      fail('LIMIT_EXCEEDED', 'PSON nesting exceeds configured limit', this.position, path);
    const tagOffset = this.position;
    const tag = this.u8(path);
    if (tag <= 0xef) return (tag & 1) === 0 ? tag >>> 1 : -((tag + 1) >>> 1);
    if (tag === 0xf0) return null;
    if (tag === 0xf1) return true;
    if (tag === 0xf2) return false;
    if (tag === 0xf3) return {};
    if (tag === 0xf4) return [];
    if (tag === 0xf5) return '';
    if (tag === 0xf6) {
      const count = this.varuint(`${path}.keys.length`);
      if (count > this.options.maxCollectionLength)
        fail('LIMIT_EXCEEDED', `PSON object has ${count} keys`, tagOffset, path);
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      for (let index = 0; index < count; index++) {
        const key = this.value(`${path}.key[${index}]`, depth + 1);
        if (typeof key !== 'string')
          fail('UNSUPPORTED_FEATURE', 'Non-string PSON object keys are outside native map JSON', tagOffset, path);
        if (keys.has(key)) fail('MALFORMED_DATA', `Duplicate PSON object key ${JSON.stringify(key)}`, tagOffset, path);
        keys.add(key);
        result[key] = this.value(`${path}.${key}`, depth + 1);
      }
      return result;
    }
    if (tag === 0xf7) {
      const count = this.varuint(`${path}.length`);
      if (count > this.options.maxCollectionLength)
        fail('LIMIT_EXCEEDED', `PSON array has ${count} entries`, tagOffset, path);
      const result: unknown[] = [];
      for (let index = 0; index < count; index++) result.push(this.value(`${path}[${index}]`, depth + 1));
      return result;
    }
    if (tag === 0xf8) {
      const unsigned = this.varuint(path);
      return unsigned % 2 === 0 ? unsigned / 2 : -(unsigned + 1) / 2;
    }
    if (tag === 0xf9)
      return fail('UNSUPPORTED_FEATURE', 'PSON 64-bit long values are not native map JSON numbers', tagOffset, path);
    if (tag === 0xfa) return this.f32le(path);
    if (tag === 0xfb) return this.f64le(path);
    if (tag === 0xfc) return this.string(path);
    if (tag === 0xfd) {
      return fail('UNSUPPORTED_FEATURE', 'PSON string-add would mutate the pinned static dictionary', tagOffset, path);
    }
    if (tag === 0xfe) {
      const index = this.varuint(`${path}.dictionaryIndex`);
      if (index >= NATIVE_MAP_PSON_DICTIONARY.length)
        fail('MALFORMED_DATA', `Unknown PSON dictionary index ${index}`, tagOffset, path);
      return NATIVE_MAP_PSON_DICTIONARY[index];
    }
    return fail(
      'UNSUPPORTED_FEATURE',
      tag === 0xff ? 'PSON binary values are outside native map JSON' : `Unknown PSON tag ${tag}`,
      tagOffset,
      path,
    );
  }
}

// StaticPair decodes against one shared dictionary in the original. This
// independent reader rejects mutation-oriented STRING_ADD explicitly.

function decodePsonValue(input: NativeMapBinaryInput, options: ResolvedOptions): unknown {
  const reader = new PsonReader(resolveBinaryInput(input, options), options);
  const value = reader.value('pson', 0);
  if (reader.remaining !== 0)
    fail('TRAILING_DATA', `PSON has ${reader.remaining} trailing byte(s)`, reader.position, 'pson');
  return value;
}

export function decodeNativeMapPsonValue(input: NativeMapBinaryInput, options: DecodeNativeMapOptions = {}): unknown {
  return decodePsonValue(input, resolveOptions(options));
}

export function decodeNativeMapPson(input: NativeMapBinaryInput, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  return migratePsonNativeMap(decodePsonValue(input, resolved));
}

export function decodeNativeMapPsonPayload(payload: string, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  const text = textInput(payload, 'payload', resolved);
  const base64 = decompressUriLzString(text, resolved, 'payload.lzstring');
  return decodeNativeMapPson(decodeBase64Strict(base64, resolved, 'payload.base64'), resolved);
}

/* ------------------------------------------------------------------------- *
 * Legacy zlib/BonkView maps
 * ------------------------------------------------------------------------- */

interface LegacyShape {
  localX: number;
  localY: number;
  width: number;
  height: number;
  localAngle: number;
  shapeID: number;
  color: number;
  death: boolean;
  noPhysics: boolean;
}

function legacyShape(): LegacyShape {
  return {
    localX: 0,
    localY: 0,
    width: 0,
    height: 0,
    localAngle: 0,
    shapeID: 0,
    color: 0xff0000,
    death: false,
    noPhysics: false,
  };
}

interface LegacyPlatform {
  version: number;
  x: number;
  y: number;
  shapeArray: LegacyShape[];
  restitution: number;
  friction: number;
  density: number;
  angle: number;
  angularVelocity: number;
  isDynamic: boolean;
  xv: number;
  yv: number;
  linearDamping: number;
  angularDamping: number;
  rotates: boolean;
  rotatePivotX: number;
  rotatePivotY: number;
  stiffness: number;
  springy: boolean;
  springyUpper: number;
  springyLower: number;
  springyAnchorX: number;
  springyAnchorY: number;
  springyForce: number;
  path: boolean;
  pathAngle: number;
  pathUpper: number;
  pathLower: number;
  pathAnchorX: number;
  pathAnchorY: number;
  pathMaxSpeed: number;
  pathForce: number;
}

function legacyPlatform(): LegacyPlatform {
  return {
    version: 0,
    x: 0,
    y: 0,
    shapeArray: [],
    restitution: 0.8,
    friction: 0,
    density: 1,
    angle: 0,
    angularVelocity: 0,
    isDynamic: false,
    xv: 0,
    yv: 0,
    linearDamping: 0,
    angularDamping: 0,
    rotates: false,
    rotatePivotX: 0,
    rotatePivotY: 0,
    stiffness: 0,
    springy: false,
    springyUpper: 100,
    springyLower: -100,
    springyAnchorX: 0,
    springyAnchorY: 0,
    springyForce: 1_000_000,
    path: false,
    pathAngle: Math.PI / 2,
    pathUpper: 100,
    pathLower: -100,
    pathAnchorX: 0,
    pathAnchorY: 0,
    pathMaxSpeed: 50,
    pathForce: 1_000_000,
  };
}

interface LegacySpawn {
  x: number;
  y: number;
  xv: number;
  yv: number;
  ffa: boolean;
  blue: boolean;
  red: boolean;
  priority: number;
}
interface LegacyCapZone {
  version: number;
  radius: number;
  x: number;
  y: number;
  captureLimit: number;
  ownerID: number;
  framesToDetonate: number;
}
interface LegacyMap {
  version: number;
  mapname: string;
  author: string;
  platformArray: LegacyPlatform[];
  spawnArray: LegacySpawn[];
  platformNames: string[];
  spawnNames: string[];
  capZoneArray: LegacyCapZone[];
  capZoneNames: string[];
  gravity: number;
  ppm: number;
  discFriction: number;
  discRestitution: number;
  discDensity: number;
  discLinearDamping: number;
  discRadius: number;
  discAllForce: number;
  respawn: boolean;
  noCollide: boolean;
}

function legacyMap(): LegacyMap {
  return {
    version: 0,
    mapname: '',
    author: '',
    platformArray: [],
    spawnArray: [],
    platformNames: [],
    spawnNames: [],
    capZoneArray: [],
    capZoneNames: [],
    gravity: 20,
    ppm: 12,
    discFriction: 0,
    discRestitution: 0.8,
    discDensity: 1,
    discLinearDamping: 0,
    discRadius: 1,
    discAllForce: 12,
    respawn: false,
    noCollide: false,
  };
}

function legacyPlatformValue(value: unknown, path: string): LegacyPlatform {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray((value as LegacyPlatform).shapeArray)
  ) {
    return fail('MALFORMED_DATA', 'Legacy platform entry is not a Bonk1Platform object', null, path);
  }
  return value as LegacyPlatform;
}

function legacySpawnValue(value: unknown, path: string): LegacySpawn {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as LegacySpawn).x !== 'number'
  ) {
    return fail('MALFORMED_DATA', 'Legacy spawn entry is not a Bonk1Spawn object', null, path);
  }
  return value as LegacySpawn;
}

function legacyArray<T>(value: unknown, path: string, entry: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return fail('MALFORMED_DATA', 'Legacy field must be an array', null, path);
  return value.map((item, index) => entry(item, `${path}[${index}]`));
}

class LegacyBonkReader extends BinaryReader {
  private readonly aliases: string[] = [];
  private readonly strings: string[] = [];
  private captureZoneKeys: string[] = [];

  constructor(
    input: Uint8Array,
    private readonly options: ResolvedOptions,
  ) {
    super(input);
  }

  count(path: string): number {
    const count = this.i16(path);
    if (count < 0) fail('MALFORMED_DATA', `Negative legacy collection length ${count}`, this.position - 2, path);
    if (count > this.options.maxCollectionLength)
      fail('LIMIT_EXCEEDED', `Legacy collection exceeds configured limit`, this.position - 2, path);
    return count;
  }

  int29(path: string): number {
    const first = this.u8(path);
    if ((first & 0x80) === 0) return first;
    const second = this.u8(path);
    if ((second & 0x80) === 0) return ((first & 0x7f) << 7) | second;
    const third = this.u8(path);
    if ((third & 0x80) === 0) return ((first & 0x7f) << 14) | ((second & 0x7f) << 7) | third;
    const fourth = this.u8(path);
    // The native four-byte AMF integer is sign-extended from bit 28.
    return (((first & 0x7f) << 22) | ((second & 0x7f) << 15) | ((third & 0x7f) << 8) | fourth) - ((first & 0x40) << 23);
  }

  private amfLength(path: string): number {
    const start = this.position;
    let length = 0;
    while (true) {
      const part = (this.u8(path) - 1) / 2;
      if (!Number.isSafeInteger(part) || part < 0 || part > 64)
        fail('MALFORMED_DATA', 'Invalid legacy variable-length marker', start, path);
      length += part;
      if (length > this.options.maxCollectionLength)
        fail('LIMIT_EXCEEDED', 'Legacy array length exceeds configured collection limit', start, path);
      if (part !== 64) return length;
    }
  }

  private amfString(path: string): string {
    const start = this.position;
    const first = this.u8(path);
    if (first % 2 === 0) {
      const index = first / 2;
      if (index >= this.strings.length) fail('MALFORMED_DATA', `Unknown legacy string reference ${index}`, start, path);
      return this.strings[index]!;
    }
    let length = (first - 1) / 2;
    let chunk = length;
    while (chunk === 64) {
      chunk = (this.u8(path) - 1) / 2;
      if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk > 64)
        fail('MALFORMED_DATA', 'Invalid legacy string length', start, path);
      length += chunk;
    }
    if (length > this.options.maxIntermediateBytes)
      fail('LIMIT_EXCEEDED', 'Legacy string exceeds configured limit', start, path);
    const bytes: number[] = [];
    for (let index = 0; index < length; index++) bytes.push(this.u8(path));
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch (cause) {
      return fail('MALFORMED_DATA', 'Invalid legacy string UTF-8', start, path, cause);
    }
    this.strings.push(value);
    return value;
  }
  private alias(path: string): string {
    const start = this.position;
    const length = (this.u8(path) - 1) / 2;
    if (!Number.isSafeInteger(length) || length < 0 || length > 16)
      fail('MALFORMED_DATA', 'Invalid legacy class-alias length', start, path);
    const bytes: number[] = [];
    for (let index = 0; index < length; index++) bytes.push(this.u8(path));
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch (cause) {
      return fail('MALFORMED_DATA', 'Invalid legacy class alias UTF-8', start, path, cause);
    }
    this.aliases.push(value);
    if (!['gmp', 'ps', 'mspn', 'czs'].includes(value))
      fail('UNSUPPORTED_FEATURE', `Unknown legacy class alias ${value}`, start, path);
    return value;
  }

  private external(path: string, anonymous: boolean): LegacyMap | LegacyPlatform | LegacySpawn | LegacyCapZone {
    const start = this.position;
    const descriptor = this.u8(path);
    let name: string;
    let isAnonymous = anonymous;
    if (descriptor === 7) name = this.alias(path);
    else {
      if (descriptor > 128) {
        this.u8(path);
        name = this.alias(path);
        isAnonymous = true;
      } else {
        const index = (descriptor - 1) / 4;
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.aliases.length) {
          fail('MALFORMED_DATA', `Unknown implicit legacy class reference ${descriptor}`, start, path);
        }
        name = this.aliases[index]!;
      }
    }
    if (name === 'gmp') return this.readMap(path);
    if (name === 'ps') return this.readPlatform(path);
    if (name === 'mspn') return this.readSpawn(path);
    if (name === 'czs') {
      if (isAnonymous) {
        this.captureZoneKeys = [];
        for (let index = 0; index < 8; index++) {
          const length = (this.u8(`${path}.captureZoneKeys[${index}]`) - 1) / 2;
          if (!Number.isSafeInteger(length) || length < 0 || length > this.options.maxIntermediateBytes) {
            fail('MALFORMED_DATA', 'Invalid anonymous capture-zone key length', start, path);
          }
          const bytes: number[] = [];
          for (let byte = 0; byte < length; byte++) bytes.push(this.u8(path));
          try {
            this.captureZoneKeys.push(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));
          } catch (cause) {
            return fail('MALFORMED_DATA', 'Invalid capture-zone key UTF-8', start, path, cause);
          }
        }
      } else if (this.captureZoneKeys.length !== 8)
        fail('MALFORMED_DATA', 'Capture-zone keys have not been declared', start, path);
      return this.readCaptureZone(path);
    }
    return fail('UNSUPPORTED_FEATURE', `Unknown legacy class alias ${name}`, start, path);
  }

  object(path: string, depth = 0): unknown {
    if (depth > this.options.maxPsonDepth)
      fail('LIMIT_EXCEEDED', 'Legacy object nesting exceeds configured limit', this.position, path);
    const start = this.position;
    const type = this.u8(path);
    if (type === 0) return undefined;
    if (type === 1) return null;
    if (type === 2) return false;
    if (type === 3) return true;
    if (type === 6) return this.amfString(path);
    if (type === 10) return this.external(path, false);
    if (type !== 9)
      return fail('UNSUPPORTED_FEATURE', `Legacy readObject tag ${type} is not an object or array`, start, path);
    const count = this.amfLength(`${path}.length`);
    this.u8(`${path}.arrayType`);
    const values: unknown[] = [];
    for (let index = 0; index < count; index++) values.push(this.object(`${path}[${index}]`, depth + 1));
    return values;
  }

  private readMap(path: string): LegacyMap {
    const map = legacyMap();
    map.version = this.i16(`${path}.version`);
    if (map.version < 1 || map.version > 5)
      fail(
        'UNSUPPORTED_VERSION',
        `Unsupported legacy map version ${map.version}`,
        this.position - 2,
        `${path}.version`,
      );
    map.mapname = this.utf(`${path}.mapname`);
    if (map.mapname.length > 25) map.mapname = map.mapname.slice(0, 25);
    map.author = this.utf(`${path}.author`);
    if (map.author.length > 25) map.author = map.author.slice(0, 35);
    map.gravity = this.f64(`${path}.gravity`);
    map.ppm = Math.max(5, Math.min(30, this.f64(`${path}.ppm`)));
    map.discFriction = this.f64(`${path}.discFriction`);
    map.discRestitution = this.f64(`${path}.discRestitution`);
    map.discDensity = this.f64(`${path}.discDensity`);
    map.discLinearDamping = this.f64(`${path}.discLinearDamping`);
    map.discRadius = this.f64(`${path}.discRadius`);
    map.discAllForce = this.f64(`${path}.discAllForce`);
    const platforms = this.count(`${path}.platformArray.length`);
    for (let index = 0; index < platforms; index++) {
      map.platformArray.push(
        legacyPlatformValue(this.object(`${path}.platformArray[${index}]`), `${path}.platformArray[${index}]`),
      );
      map.platformNames.push(this.utf(`${path}.platformNames[${index}]`));
    }
    const spawns = this.count(`${path}.spawnArray.length`);
    for (let index = 0; index < spawns; index++) {
      map.spawnArray.push(
        legacySpawnValue(this.object(`${path}.spawnArray[${index}]`), `${path}.spawnArray[${index}]`),
      );
      map.spawnNames.push(this.utf(`${path}.spawnNames[${index}]`));
    }
    map.capZoneArray =
      map.version >= 2
        ? legacyArray(this.object(`${path}.capZoneArray`), `${path}.capZoneArray`, (item, itemPath) => {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) {
              return fail('MALFORMED_DATA', 'Legacy capture-zone entry is not an object', null, itemPath);
            }
            return item as LegacyCapZone;
          })
        : [];
    map.capZoneNames =
      map.version >= 3
        ? legacyArray(this.object(`${path}.capZoneNames`), `${path}.capZoneNames`, (item, itemPath) => {
            if (typeof item !== 'string')
              return fail('MALFORMED_DATA', 'Legacy capture-zone name must be a string', null, itemPath);
            return item;
          })
        : [];
    if (map.version === 4) {
      const shared = this.boolean(`${path}.sharedCollisionFlags`);
      map.noCollide = shared;
      map.respawn = shared;
    } else if (map.version > 4) {
      map.noCollide = this.boolean(`${path}.noCollide`);
      map.respawn = this.boolean(`${path}.respawn`);
    }
    return map;
  }

  private readPlatform(path: string): LegacyPlatform {
    const platform = legacyPlatform();
    platform.version = this.i16(`${path}.version`);
    if (platform.version < 1 || platform.version > 7)
      fail('UNSUPPORTED_VERSION', `Unsupported legacy platform version ${platform.version}`, this.position - 2, path);
    platform.x = this.f64(`${path}.x`);
    platform.y = this.f64(`${path}.y`);
    if (platform.version <= 3) {
      const shape = legacyShape();
      platform.shapeArray = [shape];
      shape.width = this.f64(`${path}.shape.width`);
      shape.height = this.f64(`${path}.shape.height`);
    } else {
      const shapes = this.count(`${path}.shapeArray.length`);
      for (let index = 0; index < shapes; index++) {
        const shape = legacyShape();
        shape.localX = this.f64(`${path}.shapeArray[${index}].localX`);
        shape.localY = this.f64(`${path}.shapeArray[${index}].localY`);
        shape.width = this.f64(`${path}.shapeArray[${index}].width`);
        shape.height = this.f64(`${path}.shapeArray[${index}].height`);
        shape.localAngle = this.f64(`${path}.shapeArray[${index}].localAngle`);
        shape.shapeID = this.i16(`${path}.shapeArray[${index}].shapeID`);
        shape.color = this.u32(`${path}.shapeArray[${index}].color`);
        shape.death = this.boolean(`${path}.shapeArray[${index}].death`);
        if (platform.version >= 7) shape.noPhysics = this.boolean(`${path}.shapeArray[${index}].noPhysics`);
        if (platform.version === 4 && shape.shapeID === 5) shape.height = Math.round(0.866 * shape.width);
        platform.shapeArray.push(shape);
      }
    }
    platform.restitution = this.f64(`${path}.restitution`);
    platform.density = this.f64(`${path}.density`);
    platform.friction = this.f64(`${path}.friction`);
    platform.angle = this.f64(`${path}.angle`);
    platform.angularVelocity = this.f64(`${path}.angularVelocity`);
    if (platform.version <= 3) {
      platform.shapeArray[0]!.shapeID = this.i16(`${path}.shape.shapeID`);
    }
    platform.isDynamic = this.boolean(`${path}.isDynamic`);
    if (platform.isDynamic) {
      platform.xv = this.f64(`${path}.xv`);
      platform.yv = this.f64(`${path}.yv`);
      platform.linearDamping = this.f64(`${path}.linearDamping`);
      platform.angularDamping = this.f64(`${path}.angularDamping`);
      platform.rotates = this.boolean(`${path}.rotates`);
      if (platform.rotates) {
        platform.rotatePivotX = this.f64(`${path}.rotatePivotX`);
        platform.rotatePivotY = this.f64(`${path}.rotatePivotY`);
        platform.stiffness = this.f64(`${path}.stiffness`);
      }
      if (platform.version >= 6) {
        platform.springy = this.boolean(`${path}.springy`);
        if (platform.springy) {
          platform.springyUpper = this.f64(`${path}.springyUpper`);
          platform.springyLower = -platform.springyUpper;
          platform.springyForce = this.f64(`${path}.springyForce`);
          platform.springyAnchorX = this.f64(`${path}.springyAnchorX`);
          platform.springyAnchorY = this.f64(`${path}.springyAnchorY`);
        }
        platform.path = this.boolean(`${path}.path`);
        if (platform.path) {
          platform.pathAngle = this.f64(`${path}.pathAngle`);
          platform.pathUpper = this.f64(`${path}.pathUpper`);
          platform.pathLower = -platform.pathUpper;
          platform.pathMaxSpeed = this.f64(`${path}.pathMaxSpeed`);
          platform.pathForce = this.f64(`${path}.pathForce`);
          platform.pathAnchorX = this.f64(`${path}.pathAnchorX`);
          platform.pathAnchorY = this.f64(`${path}.pathAnchorY`);
        }
      }
    }
    if (platform.version <= 3) {
      const shape = platform.shapeArray[0]!;
      if (platform.version >= 2) shape.color = this.u32(`${path}.shape.color`);
      else shape.color = platform.isDynamic ? 0x8bc34a : 0x58b173;
      if (platform.version >= 3) {
        this.i16(`${path}.legacyUnusedShort`);
        shape.death = this.boolean(`${path}.shape.death`);
      }
    }
    return platform;
  }

  private readSpawn(path: string): LegacySpawn {
    return {
      x: this.f64(`${path}.x`),
      y: this.f64(`${path}.y`),
      xv: this.f64(`${path}.xv`),
      yv: this.f64(`${path}.yv`),
      ffa: this.boolean(`${path}.ffa`),
      blue: this.boolean(`${path}.blue`),
      red: this.boolean(`${path}.red`),
      priority: this.i16(`${path}.priority`),
    };
  }

  private readCaptureZone(path: string): LegacyCapZone {
    const zone: LegacyCapZone = { version: 0, radius: 0, x: 0, y: 0, captureLimit: 0, ownerID: 0, framesToDetonate: 0 };
    for (let index = 0; index < 8; index++) {
      const key = this.captureZoneKeys[index]!;
      const tagOffset = this.position;
      const type = this.u8(`${path}.${key}.type`);
      if (type !== 4 && type !== 5)
        fail('UNSUPPORTED_FEATURE', `Unsupported legacy capture-zone value tag ${type}`, tagOffset, path);
      const value = type === 4 ? this.int29(`${path}.${key}`) : this.rawF64(`${path}.${key}`);
      switch (key) {
        case 'version':
          zone.version = value;
          break;
        case 'radius':
          zone.radius = value;
          break;
        case 'x':
          zone.x = value;
          break;
        case 'y':
          zone.y = value;
          break;
        case 'captureLimit':
          zone.captureLimit = value;
          break;
        case 'ownerID':
          zone.ownerID = value;
          break;
        case 'framesToDetonate':
          zone.framesToDetonate = value;
          break;
        case 'captureProgress':
        case 'playerID':
          // Present in the original anonymous eight-field records; migration does not consume them.
          break;
        default:
          fail('UNSUPPORTED_FEATURE', `Unknown legacy capture-zone key ${key}`, tagOffset, path);
      }
    }
    return zone;
  }
}

function migrateLegacyMap(map: LegacyMap): NativeMap {
  const result = blankMap();
  result.m.a = map.author;
  result.m.n = map.mapname;
  result.s.fl = map.discAllForce === 20;
  result.s.re = map.respawn;
  result.s.nc = map.noCollide;
  result.physics.ppm = map.ppm;
  for (let index = 0; index < map.spawnArray.length; index++) {
    const spawn = map.spawnArray[index]!;
    result.spawns.push({
      x: spawn.x,
      y: spawn.y,
      xv: spawn.xv,
      yv: spawn.yv,
      priority: spawn.priority,
      r: spawn.red,
      f: spawn.ffa,
      b: spawn.blue,
      gr: false,
      ye: false,
      n: map.spawnNames[index]!,
    });
  }
  for (let index = 0; index < map.platformArray.length; index++) {
    const platform = map.platformArray[index]!;
    const body = blankBody();
    body.s.type = platform.isDynamic ? 'd' : 's';
    body.s.n = map.platformNames[index]!;
    body.p = [platform.x, platform.y];
    body.lv = [platform.xv, platform.yv];
    body.a = platform.angle;
    body.av = platform.angularVelocity;
    body.s.ld = platform.linearDamping;
    body.s.ad = platform.angularDamping;
    body.s.de = platform.density;
    body.s.fric = platform.friction;
    body.s.re = platform.restitution;
    body.s.fr = false;
    body.s.bu = false;
    body.fx = [];
    result.physics.bodies.push(body);
    for (const shape of platform.shapeArray) {
      const width = Math.abs(shape.width);
      const height = Math.abs(shape.height);
      let converted: NativeMapShape;
      if (shape.shapeID === 1) converted = { type: 'ci', r: width, c: [0, 0], sk: false };
      else if (shape.shapeID === 2 || shape.shapeID === 4) {
        converted = { type: 'bx', w: width * 2, h: height * 2, c: [0, 0], a: 0, sk: shape.shapeID === 4 };
      } else if (shape.shapeID === 5) {
        converted = {
          type: 'po',
          v: [
            [width, 0],
            [-0.5 * width, height],
            [-0.5 * width, -height],
          ],
          s: 1,
          a: 0,
          c: [0, 0],
        };
      } else if (shape.shapeID === 6) {
        const corner = Math.min(2 * map.ppm, Math.min(width, height) * 0.4);
        const wc = width - corner;
        const hc = height - corner;
        // Preserve the pinned migration's alternating adjusted/unadjusted geometry.
        converted = {
          type: 'po',
          v: [
            [-width, -hc],
            [-wc, -height],
            [wc, -height],
            [width, -hc],
            [width, hc],
            [wc, height],
            [-wc, height],
            [-width, hc],
          ],
          s: 1,
          a: 0,
          c: [0, 0],
        };
      } else {
        return fail('UNSUPPORTED_FEATURE', `Unknown legacy shape ID ${shape.shapeID}`, null, 'legacy.platform.shapeID');
      }
      converted.c = [shape.localX, shape.localY];
      (converted as NativeMapShape & { a: number }).a = shape.localAngle;
      result.physics.shapes.push(converted);
      result.physics.fixtures.push({
        sh: result.physics.shapes.length - 1,
        n: '',
        fr: null,
        fp: null,
        re: null,
        de: null,
        f: shape.color,
        d: shape.death,
        np: shape.noPhysics,
        ng: false,
      });
      body.fx.push(result.physics.fixtures.length - 1);
    }
    if (platform.rotates) {
      result.physics.joints.push({
        type: 'rv',
        d: { la: 0, ua: 0, mmt: platform.stiffness, ms: 0, el: false, em: true, cc: false, bf: 0, dl: true },
        ba: result.physics.bodies.length - 1,
        bb: -1,
        aa: [platform.rotatePivotX, platform.rotatePivotY],
      });
    }
    if (platform.springy) {
      result.physics.joints.push({
        type: 'lsj',
        d: { cc: false, bf: 0, dl: true },
        ba: result.physics.bodies.length - 1,
        bb: -1,
        sax: platform.springyAnchorX,
        say: platform.springyAnchorY,
        sf: platform.springyForce,
        slen: platform.springyUpper,
      });
    }
    if (platform.path) {
      result.physics.joints.push({
        type: 'lpj',
        d: { cc: false, bf: 0, dl: true },
        ba: result.physics.bodies.length - 1,
        bb: -1,
        pax: 0,
        pay: 0,
        pa: platform.pathAngle,
        pf: platform.pathForce,
        pl: 0,
        pu: 0,
        plen: platform.pathUpper,
        pms: platform.pathMaxSpeed,
      });
    }
  }
  for (let index = result.physics.bodies.length - 1; index >= 0; index--) result.physics.bro.push(index);
  for (let index = 0; index < map.capZoneArray.length; index++) {
    const zone = map.capZoneArray[index]!;
    result.physics.shapes.push({ type: 'ci', r: zone.radius * map.ppm, c: [0, 0], sk: false });
    result.physics.fixtures.push({
      sh: result.physics.shapes.length - 1,
      n: 'Def Fix',
      fr: 0.3,
      fp: null,
      re: 0.8,
      de: 0.3,
      f: 0x4f7cac,
      d: false,
      np: false,
      ng: false,
    });
    const body = blankBody();
    body.fx = [result.physics.fixtures.length - 1];
    body.p = [zone.x, zone.y];
    body.s.f_1 = false;
    body.s.f_2 = false;
    body.s.f_3 = false;
    body.s.f_4 = false;
    result.physics.bodies.push(body);
    result.capZones.push({
      n: map.capZoneNames[index]!,
      l: zone.captureLimit,
      ty: 1,
      i: result.physics.fixtures.length - 1,
    });
    result.physics.bro.unshift(result.physics.bodies.length - 1);
  }
  return result;
}

export function decodeLegacyNativeMapBytes(
  input: NativeMapBinaryInput,
  options: DecodeNativeMapOptions = {},
): NativeMap {
  const resolved = resolveOptions(options);
  const reader = new LegacyBonkReader(resolveBinaryInput(input, resolved), resolved);
  const value = reader.object('legacy');
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray((value as LegacyMap).platformArray) ||
    typeof (value as LegacyMap).version !== 'number'
  ) {
    return fail('MALFORMED_DATA', 'Legacy root is not a Bonk1Map object', 0, 'legacy');
  }
  if (reader.remaining !== 0)
    fail('TRAILING_DATA', `Legacy BonkView has ${reader.remaining} trailing byte(s)`, reader.position, 'legacy');
  return migratePsonNativeMap(migrateLegacyMap(value as LegacyMap));
}
/** Decode a dbv=1 payload: strict URI decode -> Base64 -> zlib -> BonkView migration. */
export function decodeLegacyNativeMapPayload(payload: string, options: DecodeNativeMapOptions = {}): NativeMap {
  const resolved = resolveOptions(options);
  const text = textInput(payload, 'payload', resolved);
  const base64 = decodeUriComponentStrict(text, resolved, 'payload.uri');
  const compressed = decodeBase64Strict(base64, resolved, 'payload.base64');
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(compressed, { maxOutputLength: resolved.maxIntermediateBytes });
  } catch (cause) {
    return fail(
      'INFLATION_ERROR',
      cause instanceof Error && /output buffer/i.test(cause.message)
        ? `Legacy inflation exceeds configured output limit ${resolved.maxIntermediateBytes} bytes`
        : 'Unable to inflate legacy native map payload',
      0,
      'payload.zlib',
      cause,
    );
  }
  return decodeLegacyNativeMapBytes(inflated, resolved);
}

/* ------------------------------------------------------------------------- *
 * Native PSON map migration
 * ------------------------------------------------------------------------- */

type PsonMap = Record<string, unknown>;

const PSON_ROOT_KEYS = new Set(['v', 's', 'physics', 'spawns', 'capZones', 'm']);
const PSON_SETTING_KEYS = new Set(['re', 'nc', 'pq', 'gd', 'fl']);
const PSON_METADATA_KEYS = new Set([
  'a',
  'n',
  'dbv',
  'dbid',
  'authid',
  'date',
  'rxid',
  'rxn',
  'rxa',
  'rxdb',
  'cr',
  'pub',
  'mo',
  'vu',
  'vd',
]);
const PSON_BODY_KEYS = new Set(['p', 'a', 'lv', 'av', 'cf', 'fx', 'fz', 's']);
const PSON_FIXTURE_KEYS = new Set(['sh', 'n', 'fr', 'fp', 're', 'de', 'f', 'd', 'np', 'ng', 'ig', 'fs', 'zp']);

function psonObject(value: unknown, path: string): PsonMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('MALFORMED_DATA', `${path} must be a PSON object`, null, path);
  }
  return value as PsonMap;
}

function psonKeys(value: PsonMap, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      fail(
        'UNSUPPORTED_FEATURE',
        `Unknown PSON map field ${path}.${key}; refusing to discard it`,
        null,
        `${path}.${key}`,
      );
  }
}

function psonNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && value >= minimum && value <= maximum ? value : fallback;
}

function psonBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function psonString(value: unknown, fallback: string, maximum: number, inclusive = true): string {
  return typeof value === 'string' && (inclusive ? value.length <= maximum : value.length < maximum) ? value : fallback;
}

function psonVector(value: unknown, fallback: NativeMapVector, limit = 99999): NativeMapVector {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  if (value.every((entry) => typeof entry === 'number' && entry >= -limit && entry <= limit))
    return [value[0], value[1]];
  return fallback;
}

function migratePsonNativeMap(value: unknown): NativeMap {
  const source = psonObject(value, 'pson');
  psonKeys(source, PSON_ROOT_KEYS, 'pson');
  const map = blankMap();
  // The pinned merge starts from getBlankMap(); source.v is not consulted.
  if (source.s !== undefined) {
    const settings = psonObject(source.s, 's');
    psonKeys(settings, PSON_SETTING_KEYS, 's');
    map.s.re = psonBoolean(settings.re, map.s.re);
    map.s.nc = psonBoolean(settings.nc, map.s.nc);
    map.s.pq = psonNumber(settings.pq, map.s.pq, 1, 2);
    // Preserve the pinned merge predicate, including its pq/gravity typo.
    if (typeof settings.gd === 'number' && settings.gd >= 2 && typeof settings.pq === 'number' && settings.pq <= 100)
      map.s.gd = settings.gd;
    map.s.fl = psonBoolean(settings.fl, map.s.fl);
  }
  if (source.m !== undefined) {
    const metadata = psonObject(source.m, 'm');
    psonKeys(metadata, PSON_METADATA_KEYS, 'm');
    map.m.a = psonString(metadata.a, map.m.a, 15);
    map.m.n = psonString(metadata.n, map.m.n, 25);
    map.m.rxn = psonString(metadata.rxn, map.m.rxn, 25);
    map.m.rxa = psonString(metadata.rxa, map.m.rxa, 15);
    map.m.rxid = psonNumber(metadata.rxid, map.m.rxid, 0, 9_999_999_999);
    map.m.rxdb = metadata.rxdb === 1 || metadata.rxdb === 2 ? metadata.rxdb : map.m.rxdb;
    if (!Array.isArray(metadata.cr)) fail('MALFORMED_DATA', 'PSON m.cr must be an array', null, 'm.cr');
    for (const contributor of metadata.cr) {
      if (typeof contributor === 'string' && contributor.length <= 15) map.m.cr.push(contributor);
    }
    map.m.mo = psonString(metadata.mo, map.m.mo, 5);
    if (typeof metadata.dbid === 'number') map.m.dbid = metadata.dbid;
    if (typeof metadata.vu === 'number') map.m.vu = metadata.vu;
    if (typeof metadata.vd === 'number') map.m.vd = metadata.vd;
  }
  if (source.physics !== undefined) {
    const physics = psonObject(source.physics, 'physics');
    psonKeys(physics, new Set(['shapes', 'fixtures', 'bodies', 'bro', 'joints', 'ppm']), 'physics');
    if (physics.shapes !== undefined) {
      if (!Array.isArray(physics.shapes))
        fail('MALFORMED_DATA', 'PSON shapes must be an array', null, 'physics.shapes');
      for (let index = 0; index < Math.min(physics.shapes.length, 1000); index++) {
        const raw = physics.shapes[index];
        if (!raw) continue;
        const shape = psonObject(raw, `physics.shapes[${index}]`);
        if (shape.type === 'bx') {
          psonKeys(shape, new Set(['type', 'w', 'h', 'c', 'a', 'sk']), `physics.shapes[${index}]`);
          map.physics.shapes[index] = {
            type: 'bx',
            w: psonNumber(shape.w, 10, Number.MIN_VALUE, 99999),
            h: psonNumber(shape.h, 40, Number.MIN_VALUE, 99999),
            c: psonVector(shape.c, [0, 0]),
            a: psonNumber(shape.a, 0, -999, 999),
            sk: psonBoolean(shape.sk, false),
          };
        } else if (shape.type === 'ci') {
          psonKeys(shape, new Set(['type', 'r', 'c', 'sk', 'a']), `physics.shapes[${index}]`);
          map.physics.shapes[index] = {
            type: 'ci',
            r: Math.min(2000, psonNumber(shape.r, 25, Number.MIN_VALUE, 99999)),
            c: psonVector(shape.c, [0, 0]),
            sk: psonBoolean(shape.sk, false),
          };
        } else if (shape.type === 'po' || shape.type === 'ch') {
          psonKeys(
            shape,
            shape.type === 'po'
              ? new Set(['type', 'v', 's', 'a', 'c', 'sk'])
              : new Set(['type', 'v', 's', 'a', 'c', 'l', 'sk']),
            `physics.shapes[${index}]`,
          );
          if (!Array.isArray(shape.v))
            fail('MALFORMED_DATA', 'PSON polygon vertices must be an array', null, `physics.shapes[${index}].v`);
          let valid = true;
          for (let vertex = 0; vertex < Math.min(shape.v.length, 100); vertex++) {
            const entry = shape.v[vertex];
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              entry.some((n) => typeof n !== 'number' || n < -99999 || n > 99999)
            )
              valid = false;
          }
          const vertices = valid
            ? (shape.v as NativeMapVector[]).map((entry) => [entry[0], entry[1]] as NativeMapVector)
            : [];
          map.physics.shapes[index] = {
            type: shape.type,
            v: vertices,
            s: psonNumber(shape.s, 1, -999, 999),
            a: psonNumber(shape.a, 0, -999, 999),
            c: psonVector(shape.c, [0, 0]),
            ...(shape.type === 'ch' ? { l: psonBoolean(shape.l, false), sk: false } : {}),
          } as NativeMapShape;
        } else {
          fail(
            'UNSUPPORTED_FEATURE',
            `Unknown PSON shape type ${String(shape.type)}`,
            null,
            `physics.shapes[${index}].type`,
          );
        }
      }
    }
    if (physics.fixtures !== undefined) {
      if (!Array.isArray(physics.fixtures))
        fail('MALFORMED_DATA', 'PSON fixtures must be an array', null, 'physics.fixtures');
      for (let index = 0; index < Math.min(physics.fixtures.length, 1000); index++) {
        const raw = physics.fixtures[index];
        if (!raw) continue;
        const fixture = psonObject(raw, `physics.fixtures[${index}]`);
        psonKeys(fixture, PSON_FIXTURE_KEYS, `physics.fixtures[${index}]`);
        if (typeof fixture.sh !== 'number' || !Number.isSafeInteger(fixture.sh) || !map.physics.shapes[fixture.sh])
          continue;
        const converted: NativeMapFixture = {
          sh: fixture.sh,
          n: psonString(fixture.n, 'Def Fix', 30),
          fr: fixture.fr === null ? null : psonNumber(fixture.fr, 0.3, 0, 99999),
          fp: psonBoolean(fixture.fp, null as unknown as boolean),
          re: fixture.re === null ? null : psonNumber(fixture.re, 0.8, -99999, 99999),
          de: fixture.de === null ? null : psonNumber(fixture.de, 0.3, 0, 99999),
          f: psonNumber(fixture.f, 0x4f7cac, 0, 0xffffff),
          d: psonBoolean(fixture.d, false),
          np: psonBoolean(fixture.np, false),
          ng: psonBoolean(fixture.ng, false),
        };
        if (typeof fixture.fp !== 'boolean') converted.fp = null;
        if (typeof fixture.fp !== 'boolean') converted.fp = null;
        if (typeof fixture.fs === 'string') converted.fs = fixture.fs;
        if (typeof fixture.zp === 'number' && fixture.zp > -1000 && fixture.zp < 1000) converted.zp = fixture.zp;
        if (typeof fixture.ig === 'boolean') converted.ig = fixture.ig;
        map.physics.fixtures[index] = converted;
      }
    }
    if (physics.bodies !== undefined) {
      if (!Array.isArray(physics.bodies))
        fail('MALFORMED_DATA', 'PSON bodies must be an array', null, 'physics.bodies');
      for (let index = 0; index < Math.min(physics.bodies.length, 300); index++) {
        const raw = physics.bodies[index];
        if (!raw) continue;
        const body = psonObject(raw, `physics.bodies[${index}]`);
        psonKeys(body, PSON_BODY_KEYS, `physics.bodies[${index}]`);
        const settings = psonObject(body.s, `physics.bodies[${index}].s`);
        psonKeys(
          settings,
          new Set([
            'type',
            'n',
            'fric',
            'fricp',
            're',
            'de',
            'ld',
            'ad',
            'fr',
            'bu',
            'f_c',
            'f_p',
            'f_1',
            'f_2',
            'f_3',
            'f_4',
          ]),
          `physics.bodies[${index}].s`,
        );
        const converted = blankBody();
        if (settings.type === 's' || settings.type === 'd' || settings.type === 'k') converted.s.type = settings.type;
        converted.s.n = psonString(settings.n, converted.s.n, 30);
        converted.p = body.p as NativeMapVector;
        converted.a = psonNumber(body.a, 0, -9999, 9999);
        converted.lv = body.lv as NativeMapVector;
        converted.av = psonNumber(body.av, 0, -9999, 9999);
        converted.s.ld = psonNumber(settings.ld, 0, -99999, 99999);
        converted.s.ad = psonNumber(settings.ad, 0, -99999, 99999);
        converted.s.fric = psonNumber(settings.fric, 0.3, -99999, 99999);
        converted.s.fricp = psonBoolean(settings.fricp, false);
        converted.s.de = psonNumber(settings.de, 0.3, -99999, 99999);
        converted.s.re = psonNumber(settings.re, 0.8, -99999, 99999);
        converted.s.fr = psonBoolean(settings.fr, false);
        converted.s.bu = psonBoolean(settings.bu, false);
        if (typeof body.cf === 'object' && body.cf !== null && !Array.isArray(body.cf)) {
          const cf = psonObject(body.cf, `physics.bodies[${index}].cf`);
          psonKeys(cf, new Set(['x', 'y', 'w', 'ct']), `physics.bodies[${index}].cf`);
          converted.cf.x = psonNumber(cf.x, 0, -999999, 999998.9999999999);
          converted.cf.y = psonNumber(cf.y, 0, -999999, 999998.9999999999);
          converted.cf.w = psonBoolean(cf.w, true);
          converted.cf.ct = psonNumber(cf.ct, 0, -999999, 999998.9999999999);
        }
        if (Array.isArray(body.fx)) {
          for (let reference = 0; reference < Math.min(body.fx.length, 100); reference++) {
            const id = body.fx[reference];
            if (typeof id === 'number' && map.physics.fixtures[id]) converted.fx.push(id);
          }
        }
        converted.s.f_c = typeof settings.f_c === 'number' ? settings.f_c : 1;
        converted.s.f_p = psonBoolean(settings.f_p, true);
        converted.s.f_1 = psonBoolean(settings.f_1, true);
        converted.s.f_2 = psonBoolean(settings.f_2, true);
        converted.s.f_3 = psonBoolean(settings.f_3, true);
        converted.s.f_4 = psonBoolean(settings.f_4, true);
        if (typeof body.fz === 'object' && body.fz !== null && !Array.isArray(body.fz)) {
          const fz = psonObject(body.fz, `physics.bodies[${index}].fz`);
          psonKeys(fz, new Set(['on', 'x', 'y', 'd', 'p', 'a', 't', 'cf']), `physics.bodies[${index}].fz`);
          converted.fz.on = psonBoolean(fz.on, false);
          converted.fz.x = psonNumber(fz.x, 0, -999999, 999998.9999999999);
          converted.fz.y = psonNumber(fz.y, 0, -999999, 999998.9999999999);
          converted.fz.d = psonBoolean(fz.d, true);
          converted.fz.p = psonBoolean(fz.p, true);
          converted.fz.a = psonBoolean(fz.a, true);
          converted.fz.t = psonNumber(fz.t, 0, 0, 3);
          converted.fz.cf = psonNumber(fz.cf, 0, 0, 999998.9999999999);
        }
        map.physics.bodies[index] = converted;
      }
    }
    if (Array.isArray(physics.bro)) {
      for (const id of physics.bro) if (typeof id === 'number' && map.physics.bodies[id]) map.physics.bro.push(id);
    }
    if (physics.joints !== undefined) {
      if (!Array.isArray(physics.joints))
        fail('MALFORMED_DATA', 'PSON joints must be an array', null, 'physics.joints');
      for (let index = 0; index < Math.min(physics.joints.length, 100); index++) {
        const raw = physics.joints[index];
        if (!raw) continue;
        const joint = psonObject(raw, `physics.joints[${index}]`);
        if (joint.type === 'g') continue; // The source migrates gear joints in its second pass.
        if (!(
          (joint.ba === -1 || (typeof joint.ba === 'number' && map.physics.bodies[joint.ba])) &&
          (joint.bb === -1 || (typeof joint.bb === 'number' && map.physics.bodies[joint.bb]))
        ))
          continue;
        const d = psonObject(joint.d, `physics.joints[${index}].d`);
        if (joint.type === 'rv') {
          psonKeys(joint, new Set(['type', 'n', 'd', 'ba', 'bb', 'aa']), `physics.joints[${index}]`);
          psonKeys(d, new Set(['la', 'ua', 'mmt', 'ms', 'el', 'em', 'cc', 'bf', 'dl']), `physics.joints[${index}].d`);
          map.physics.joints[index] = {
            type: 'rv',
            d: {
              la: psonNumber(d.la, 0, -999, 999),
              ua: psonNumber(d.ua, 0, -999, 999),
              mmt: psonNumber(d.mmt, 0, -99999999, 99999999),
              ms: psonNumber(d.ms, 0, -99999999, 99999999),
              el: psonBoolean(d.el, false),
              em: psonBoolean(d.em, false),
              cc: psonBoolean(d.cc, false),
              bf: psonNumber(d.bf, 0, 0, 99999999),
              dl: psonBoolean(d.dl, true),
            },
            ba: joint.ba as number,
            bb: joint.bb as number,
            aa: psonVector(joint.aa, [0, 0]),
          };
        } else if (joint.type === 'p') {
          psonKeys(joint, new Set(['type', 'n', 'd', 'ba', 'bb', 'aa', 'ab', 'axa']), `physics.joints[${index}]`);
          psonKeys(
            d,
            new Set(['el', 'lt', 'ut', 'em', 'mmf', 'ms', 'cc', 'bf', 'cd', 'dl']),
            `physics.joints[${index}].d`,
          );
          const converted: NativeMapPrismaticJoint = {
            type: 'p',
            d: {
              el: psonBoolean(d.el, true),
              lt: psonNumber(d.lt, -100, -99999, 99999),
              ut: psonNumber(d.ut, 100, -99999, 99999),
              em: psonBoolean(d.em, false),
              mmf: psonNumber(d.mmf, 0, -99999999, 99999999),
              ms: psonNumber(d.ms, 0, -99999999, 99999999),
              cc: psonBoolean(d.cc, false),
              bf: psonNumber(d.bf, 0, 0, 99999999),
              cd: psonBoolean(d.cd, false),
              dl: psonBoolean(d.dl, true),
            },
            ba: joint.ba as number,
            bb: joint.bb as number,
            aa: psonVector(joint.aa, [0, 0]),
            ab: psonVector(joint.ab, [0, 0]),
            axa: psonVector(joint.axa, [0, 1], 999),
          };
          if (typeof joint.n === 'string') converted.n = joint.n;
          if (typeof d.dl !== 'boolean') delete converted.d.dl;
          map.physics.joints[index] = converted;
        } else if (joint.type === 'd') {
          psonKeys(joint, new Set(['type', 'n', 'd', 'ba', 'bb', 'aa', 'ab']), `physics.joints[${index}]`);
          psonKeys(d, new Set(['fh', 'dr', 'cc', 'bf', 'dl']), `physics.joints[${index}].d`);
          map.physics.joints[index] = {
            type: 'd',
            d: {
              fh: psonNumber(d.fh, 0, -99999, 99999),
              dr: psonNumber(d.dr, 0, -99999, 99999),
              cc: psonBoolean(d.cc, false),
              bf: psonNumber(d.bf, 0, 0, 99999999),
              dl: psonBoolean(d.dl, true),
            },
            ba: joint.ba as number,
            bb: joint.bb as number,
            aa: psonVector(joint.aa, [0, 0]),
            ab: psonVector(joint.ab, [0, 0]),
          };
        } else if (joint.type === 'lsj' || joint.type === 'lpj') {
          psonKeys(d, new Set(['cc', 'bf', 'dl']), `physics.joints[${index}].d`);
          const common = {
            d: { cc: psonBoolean(d.cc, false), bf: psonNumber(d.bf, 0, 0, 99999999), dl: psonBoolean(d.dl, true) },
            ba: joint.ba as number,
            bb: joint.bb as number,
          };
          if (joint.type === 'lsj') {
            psonKeys(
              joint,
              new Set(['type', 'n', 'd', 'ba', 'bb', 'sax', 'say', 'sf', 'slen']),
              `physics.joints[${index}]`,
            );
            map.physics.joints[index] = {
              type: 'lsj',
              ...common,
              sax: psonNumber(joint.sax, 0, -99999999, 99999999),
              say: psonNumber(joint.say, 0, -99999999, 99999999),
              sf: psonNumber(joint.sf, 0, -99999999, 99999999),
              slen: psonNumber(joint.slen, 0, -99999999, 99999999),
            };
          } else {
            psonKeys(
              joint,
              new Set(['type', 'n', 'd', 'ba', 'bb', 'pax', 'pay', 'pa', 'pf', 'pl', 'pu', 'plen', 'pms']),
              `physics.joints[${index}]`,
            );
            map.physics.joints[index] = {
              type: 'lpj',
              ...common,
              pax: psonNumber(joint.pax, 0, -99999999, 99999999),
              pay: psonNumber(joint.pay, 0, -99999999, 99999999),
              pa: psonNumber(joint.pa, 0, -99999999, 99999999),
              pf: psonNumber(joint.pf, 0, -99999999, 99999999),
              pl: psonNumber(joint.pl, 0, -99999999, 99999999),
              pu: psonNumber(joint.pu, 0, -99999999, 99999999),
              plen: psonNumber(joint.plen, 0, -99999999, 99999999),
              pms: psonNumber(joint.pms, 0, -99999999, 99999999),
            };
          }
        } else {
          fail(
            'UNSUPPORTED_FEATURE',
            `Unknown PSON joint type ${String(joint.type)}`,
            null,
            `physics.joints[${index}].type`,
          );
        }
      }
      for (let index = 0; index < Math.min(physics.joints.length, 100); index++) {
        const raw = physics.joints[index];
        if (!raw) continue;
        const joint = psonObject(raw, `physics.joints[${index}]`);
        if (joint.type !== 'g') continue;
        psonKeys(joint, new Set(['type', 'n', 'ja', 'jb', 'r']), `physics.joints[${index}]`);
        map.physics.joints[index] = {
          type: 'g',
          n: psonString(joint.n, 'Gear Joint', 30, false),
          ja: psonNumber(joint.ja, -1, 0, 100),
          jb: psonNumber(joint.jb, -1, 0, 100),
          r: psonNumber(joint.r, 1, -99999999, 99999999),
        };
      }
    }
    map.physics.ppm = psonNumber(physics.ppm, 12, 5, 30);
  }
  if (source.spawns !== undefined) {
    if (!Array.isArray(source.spawns)) fail('MALFORMED_DATA', 'PSON spawns must be an array', null, 'spawns');
    for (let index = 0; index < Math.min(source.spawns.length, 100); index++) {
      const raw = source.spawns[index];
      if (!raw) continue;
      const spawn = psonObject(raw, `spawns[${index}]`);
      psonKeys(spawn, new Set(['x', 'y', 'xv', 'yv', 'priority', 'r', 'f', 'b', 'gr', 'ye', 'n']), `spawns[${index}]`);
      map.spawns[index] = {
        x: psonNumber(spawn.x, 400, -10000, 10000),
        y: psonNumber(spawn.y, 300, -10000, 10000),
        xv: psonNumber(spawn.xv, 0, -10000, 10000),
        yv: psonNumber(spawn.yv, 0, -10000, 10000),
        priority: psonNumber(spawn.priority, 5, 0, 10000),
        r: psonBoolean(spawn.r, true),
        f: psonBoolean(spawn.f, true),
        b: psonBoolean(spawn.b, true),
        gr: psonBoolean(spawn.gr, false),
        ye: psonBoolean(spawn.ye, false),
        n: psonString(spawn.n, 'Spawn', 60, false),
      };
    }
  }
  if (source.capZones !== undefined) {
    if (!Array.isArray(source.capZones)) fail('MALFORMED_DATA', 'PSON capZones must be an array', null, 'capZones');
    for (let index = 0; index < Math.min(source.capZones.length, 50); index++) {
      const raw = source.capZones[index];
      if (!raw) continue;
      const zone = psonObject(raw, `capZones[${index}]`);
      psonKeys(zone, new Set(['n', 'ty', 'l', 'i']), `capZones[${index}]`);
      let reference = -1;
      if (typeof zone.i === 'number' && map.physics.fixtures[zone.i]) reference = zone.i;
      map.capZones[index] = {
        n: psonString(zone.n, 'Cap Zone', 30, false),
        ty: psonNumber(zone.ty, 1, 1, 5),
        l: psonNumber(zone.l, 10, 0.01, 1000),
        i: reference,
      };
    }
  }
  return map;
}

/* ------------------------------------------------------------------------- *
 * Strict native JSON input
 * ------------------------------------------------------------------------- */
type JsonRecord = Record<string, unknown>;

function jsonFail(path: string, message: string, code: NativeMapCodecErrorCode = 'MALFORMED_DATA'): never {
  return fail(code, `${path}: ${message}`, null, path);
}

function jsonRecord(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return jsonFail(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return jsonFail(path, 'must be a plain object');
  }
  return value as JsonRecord;
}

function jsonOwn(raw: JsonRecord | readonly unknown[], key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor || !('value' in descriptor)) {
    return jsonFail(`${path}.${key}`, 'must be a present own data property');
  }
  if (descriptor.value === undefined) {
    return jsonFail(`${path}.${key}`, 'undefined is not native JSON data', 'NON_JSON_VALUE');
  }
  return descriptor.value;
}

function jsonKeys(raw: JsonRecord, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key)) {
      jsonFail(`${path}.${key}`, 'unknown native map field; refusing to discard it', 'UNSUPPORTED_FEATURE');
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) jsonFail(`${path}.${key}`, 'is required');
  }
}

function jsonNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) jsonFail(path, 'must be a finite number');
  return value;
}

function jsonInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) jsonFail(path, 'must be a safe integer');
  return value as number;
}

function jsonInt16(value: unknown, path: string): number {
  const result = jsonInteger(value, path);
  if (result < -0x8000 || result > 0x7fff) jsonFail(path, 'must fit the native signed int16 representation');
  return result;
}

function jsonInt32(value: unknown, path: string): number {
  const result = jsonInteger(value, path);
  if (result < -0x80000000 || result > 0x7fffffff) jsonFail(path, 'must fit the native signed int32 representation');
  return result;
}

function jsonUint32(value: unknown, path: string): number {
  const result = jsonInteger(value, path);
  if (result < 0 || result > 0xffffffff) jsonFail(path, 'must fit the native unsigned int32 representation');
  return result;
}

function jsonBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') jsonFail(path, 'must be boolean');
  return value;
}

function jsonString(value: unknown, path: string): string {
  if (typeof value !== 'string') jsonFail(path, 'must be a string');
  return value;
}

function jsonNullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : jsonNumber(value, path);
}

function jsonNullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : jsonBoolean(value, path);
}

function jsonVector(value: unknown, path: string): NativeMapVector {
  if (!Array.isArray(value) || value.length !== 2) jsonFail(path, 'must be a two-number array');
  return [jsonNumber(jsonOwn(value, '0', path), `${path}[0]`), jsonNumber(jsonOwn(value, '1', path), `${path}[1]`)];
}

function jsonInt16Array(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) jsonFail(path, 'must be an array');
  const result: number[] = [];
  for (let index = 0; index < value.length; index++) {
    result.push(jsonInt16(jsonOwn(value, String(index), path), `${path}[${index}]`));
  }
  return result;
}

function jsonStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) jsonFail(path, 'must be an array');
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    result.push(jsonString(jsonOwn(value, String(index), path), `${path}[${index}]`));
  }
  return result;
}

function jsonSlots<T>(value: unknown, path: string, convert: (entry: unknown, index: number) => T): Array<T | null> {
  if (!Array.isArray(value)) jsonFail(path, 'must be an array');
  // Array(length), rather than map(), preserves holes as holes. JSON text cannot
  // encode a hole, but already-parsed native maps can and native deletion uses it.
  const result: Array<T | null> = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) continue;
    const entry = jsonOwn(value, String(index), path);
    result[index] = entry === null ? null : convert(entry, index);
  }
  return result;
}

function jsonShape(value: unknown, index: number): NativeMapShape {
  const path = `physics.shapes[${index}]`;
  const raw = jsonRecord(value, path);
  const type = jsonOwn(raw, 'type', path);
  if (type === 'bx') {
    jsonKeys(raw, ['type', 'w', 'h', 'c', 'a', 'sk'], [], path);
    return {
      type,
      w: jsonNumber(jsonOwn(raw, 'w', path), `${path}.w`),
      h: jsonNumber(jsonOwn(raw, 'h', path), `${path}.h`),
      c: jsonVector(jsonOwn(raw, 'c', path), `${path}.c`),
      a: jsonNumber(jsonOwn(raw, 'a', path), `${path}.a`),
      sk: jsonBoolean(jsonOwn(raw, 'sk', path), `${path}.sk`),
    };
  }
  if (type === 'ci') {
    jsonKeys(raw, ['type', 'r', 'c', 'sk'], ['a'], path);
    const result: NativeMapCircleShape = {
      type,
      r: jsonNumber(jsonOwn(raw, 'r', path), `${path}.r`),
      c: jsonVector(jsonOwn(raw, 'c', path), `${path}.c`),
      sk: jsonBoolean(jsonOwn(raw, 'sk', path), `${path}.sk`),
    };
    if (Object.prototype.hasOwnProperty.call(raw, 'a')) {
      // Circle angle has no rendering/physics meaning, but is native JSON state.
      (result as NativeMapCircleShape & { a: number }).a = jsonNumber(jsonOwn(raw, 'a', path), `${path}.a`);
    }
    return result;
  }
  if (type === 'po' || type === 'ch') {
    jsonKeys(
      raw,
      type === 'po' ? ['type', 'v', 's', 'a', 'c'] : ['type', 'v', 's', 'a', 'c', 'l', 'sk'],
      type === 'po' ? ['sk'] : [],
      path,
    );
    const verticesValue = jsonOwn(raw, 'v', path);
    if (!Array.isArray(verticesValue)) jsonFail(`${path}.v`, 'must be an array');
    const vertices: NativeMapVector[] = [];
    for (let i = 0; i < verticesValue.length; i++) {
      vertices.push(jsonVector(jsonOwn(verticesValue, String(i), `${path}.v`), `${path}.v[${i}]`));
    }
    const common = {
      v: vertices,
      s: jsonNumber(jsonOwn(raw, 's', path), `${path}.s`),
      a: jsonNumber(jsonOwn(raw, 'a', path), `${path}.a`),
      c: jsonVector(jsonOwn(raw, 'c', path), `${path}.c`),
    };
    if (type === 'ch') {
      return {
        ...common,
        type,
        l: jsonBoolean(jsonOwn(raw, 'l', path), `${path}.l`),
        sk: jsonBoolean(jsonOwn(raw, 'sk', path), `${path}.sk`),
      };
    }
    const result: NativeMapPolygonShape = { type, ...common };
    if (Object.prototype.hasOwnProperty.call(raw, 'sk')) {
      (result as NativeMapPolygonShape & { sk: boolean }).sk = jsonBoolean(jsonOwn(raw, 'sk', path), `${path}.sk`);
    }
    return result;
  }
  return jsonFail(`${path}.type`, `unsupported native shape ${String(type)}`, 'UNSUPPORTED_FEATURE');
}

function jsonFixture(
  value: unknown,
  index: number,
  featureGates: 'database-version' | 'native-json',
  version: number,
): NativeMapFixture {
  const path = `physics.fixtures[${index}]`;
  const raw = jsonRecord(value, path);
  jsonKeys(raw, ['sh', 'n', 'fr', 'fp', 're', 'de', 'f', 'd', 'np', 'ng'], ['ig', 'fs', 'zp'], path);
  if (featureGates === 'database-version' && version < 12 && Object.prototype.hasOwnProperty.call(raw, 'ig')) {
    jsonFail(`${path}.ig`, 'requires native database version 12 or newer', 'UNSUPPORTED_FEATURE');
  }
  const result: NativeMapFixture = {
    sh: jsonInt16(jsonOwn(raw, 'sh', path), `${path}.sh`),
    n: jsonString(jsonOwn(raw, 'n', path), `${path}.n`),
    fr: jsonNullableNumber(jsonOwn(raw, 'fr', path), `${path}.fr`),
    fp: jsonNullableBoolean(jsonOwn(raw, 'fp', path), `${path}.fp`),
    re: jsonNullableNumber(jsonOwn(raw, 're', path), `${path}.re`),
    de: jsonNullableNumber(jsonOwn(raw, 'de', path), `${path}.de`),
    f: jsonUint32(jsonOwn(raw, 'f', path), `${path}.f`),
    d: jsonBoolean(jsonOwn(raw, 'd', path), `${path}.d`),
    np: jsonBoolean(jsonOwn(raw, 'np', path), `${path}.np`),
    ng: jsonBoolean(jsonOwn(raw, 'ng', path), `${path}.ng`),
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'fs')) result.fs = jsonString(jsonOwn(raw, 'fs', path), `${path}.fs`);
  if (Object.prototype.hasOwnProperty.call(raw, 'zp')) result.zp = jsonNumber(jsonOwn(raw, 'zp', path), `${path}.zp`);
  if (Object.prototype.hasOwnProperty.call(raw, 'ig')) {
    result.ig = jsonBoolean(jsonOwn(raw, 'ig', path), `${path}.ig`);
  }
  return result;
}

function jsonBody(
  value: unknown,
  index: number,
  featureGates: 'database-version' | 'native-json',
  version: number,
): NativeMapBody {
  const path = `physics.bodies[${index}]`;
  const raw = jsonRecord(value, path);
  jsonKeys(raw, ['p', 'a', 'lv', 'av', 'cf', 'fx', 'fz', 's'], [], path);
  const cfRaw = jsonRecord(jsonOwn(raw, 'cf', path), `${path}.cf`);
  jsonKeys(cfRaw, ['x', 'y', 'w', 'ct'], [], `${path}.cf`);
  const fzRaw = jsonRecord(jsonOwn(raw, 'fz', path), `${path}.fz`);
  jsonKeys(fzRaw, ['on', 'x', 'y', 'd', 'p', 'a', 't', 'cf'], [], `${path}.fz`);
  const sRaw = jsonRecord(jsonOwn(raw, 's', path), `${path}.s`);
  jsonKeys(
    sRaw,
    ['type', 'n', 'fric', 'fricp', 're', 'de', 'ld', 'ad', 'fr', 'bu', 'f_c', 'f_p', 'f_1', 'f_2', 'f_3', 'f_4'],
    [],
    `${path}.s`,
  );

  const fz: NativeMapBody['fz'] = {
    on: jsonBoolean(jsonOwn(fzRaw, 'on', path), `${path}.fz.on`),
    x: jsonNumber(jsonOwn(fzRaw, 'x', path), `${path}.fz.x`),
    y: jsonNumber(jsonOwn(fzRaw, 'y', path), `${path}.fz.y`),
    d: jsonBoolean(jsonOwn(fzRaw, 'd', path), `${path}.fz.d`),
    p: jsonBoolean(jsonOwn(fzRaw, 'p', path), `${path}.fz.p`),
    a: jsonBoolean(jsonOwn(fzRaw, 'a', path), `${path}.fz.a`),
    t: jsonInt16(jsonOwn(fzRaw, 't', path), `${path}.fz.t`),
    cf: jsonNumber(jsonOwn(fzRaw, 'cf', path), `${path}.fz.cf`),
  };
  if (featureGates === 'database-version' && version < 14 && fz.on)
    jsonFail(`${path}.fz.on`, 'active force zones require version 14 or newer', 'UNSUPPORTED_FEATURE');
  if (featureGates === 'database-version' && version < 15 && fz.on && (fz.t !== 0 || fz.cf !== 0)) {
    jsonFail(`${path}.fz`, 'force-zone countdown/coefficient require version 15', 'UNSUPPORTED_FEATURE');
  }
  return {
    p: jsonVector(jsonOwn(raw, 'p', path), `${path}.p`),
    a: jsonNumber(jsonOwn(raw, 'a', path), `${path}.a`),
    lv: jsonVector(jsonOwn(raw, 'lv', path), `${path}.lv`),
    av: jsonNumber(jsonOwn(raw, 'av', path), `${path}.av`),
    cf: {
      x: jsonNumber(jsonOwn(cfRaw, 'x', path), `${path}.cf.x`),
      y: jsonNumber(jsonOwn(cfRaw, 'y', path), `${path}.cf.y`),
      w: jsonBoolean(jsonOwn(cfRaw, 'w', path), `${path}.cf.w`),
      ct: jsonNumber(jsonOwn(cfRaw, 'ct', path), `${path}.cf.ct`),
    },
    fx: jsonInt16Array(jsonOwn(raw, 'fx', path), `${path}.fx`),
    fz,
    s: {
      type: jsonString(jsonOwn(sRaw, 'type', path), `${path}.s.type`),
      n: jsonString(jsonOwn(sRaw, 'n', path), `${path}.s.n`),
      fric: jsonNumber(jsonOwn(sRaw, 'fric', path), `${path}.s.fric`),
      fricp: jsonBoolean(jsonOwn(sRaw, 'fricp', path), `${path}.s.fricp`),
      re: jsonNumber(jsonOwn(sRaw, 're', path), `${path}.s.re`),
      de: jsonNumber(jsonOwn(sRaw, 'de', path), `${path}.s.de`),
      ld: jsonNumber(jsonOwn(sRaw, 'ld', path), `${path}.s.ld`),
      ad: jsonNumber(jsonOwn(sRaw, 'ad', path), `${path}.s.ad`),
      fr: jsonBoolean(jsonOwn(sRaw, 'fr', path), `${path}.s.fr`),
      bu: jsonBoolean(jsonOwn(sRaw, 'bu', path), `${path}.s.bu`),
      f_c: jsonInt16(jsonOwn(sRaw, 'f_c', path), `${path}.s.f_c`),
      f_p: jsonBoolean(jsonOwn(sRaw, 'f_p', path), `${path}.s.f_p`),
      f_1: jsonBoolean(jsonOwn(sRaw, 'f_1', path), `${path}.s.f_1`),
      f_2: jsonBoolean(jsonOwn(sRaw, 'f_2', path), `${path}.s.f_2`),
      f_3: jsonBoolean(jsonOwn(sRaw, 'f_3', path), `${path}.s.f_3`),
      f_4: jsonBoolean(jsonOwn(sRaw, 'f_4', path), `${path}.s.f_4`),
    },
  };
}

function jsonSpawn(value: unknown, index: number): NativeMapSpawn {
  const path = `spawns[${index}]`;
  const raw = jsonRecord(value, path);
  jsonKeys(raw, ['x', 'y', 'xv', 'yv', 'priority', 'r', 'f', 'b', 'gr', 'ye', 'n'], [], path);
  return {
    x: jsonNumber(jsonOwn(raw, 'x', path), `${path}.x`),
    y: jsonNumber(jsonOwn(raw, 'y', path), `${path}.y`),
    xv: jsonNumber(jsonOwn(raw, 'xv', path), `${path}.xv`),
    yv: jsonNumber(jsonOwn(raw, 'yv', path), `${path}.yv`),
    priority: jsonInt16(jsonOwn(raw, 'priority', path), `${path}.priority`),
    r: jsonBoolean(jsonOwn(raw, 'r', path), `${path}.r`),
    f: jsonBoolean(jsonOwn(raw, 'f', path), `${path}.f`),
    b: jsonBoolean(jsonOwn(raw, 'b', path), `${path}.b`),
    gr: jsonBoolean(jsonOwn(raw, 'gr', path), `${path}.gr`),
    ye: jsonBoolean(jsonOwn(raw, 'ye', path), `${path}.ye`),
    n: jsonString(jsonOwn(raw, 'n', path), `${path}.n`),
  };
}

function jsonCapZone(value: unknown, index: number): NativeMapCapZone {
  const path = `capZones[${index}]`;
  const raw = jsonRecord(value, path);
  jsonKeys(raw, ['n', 'ty', 'l', 'i'], [], path);
  return {
    n: jsonString(jsonOwn(raw, 'n', path), `${path}.n`),
    ty: jsonInt16(jsonOwn(raw, 'ty', path), `${path}.ty`),
    l: jsonNumber(jsonOwn(raw, 'l', path), `${path}.l`),
    i: jsonInt16(jsonOwn(raw, 'i', path), `${path}.i`),
  };
}

function jsonJointCommon(
  raw: JsonRecord,
  path: string,
  optionalDl = false,
): Pick<NativeMapRevoluteJoint, 'ba' | 'bb'> & { d: { cc: boolean; bf: number; dl: boolean } } {
  const dRaw = jsonRecord(jsonOwn(raw, 'd', path), `${path}.d`);
  return {
    ba: jsonInt16(jsonOwn(raw, 'ba', path), `${path}.ba`),
    bb: jsonInt16(jsonOwn(raw, 'bb', path), `${path}.bb`),
    d: {
      cc: jsonBoolean(jsonOwn(dRaw, 'cc', path), `${path}.d.cc`),
      bf: jsonNumber(jsonOwn(dRaw, 'bf', path), `${path}.d.bf`),
      dl:
        optionalDl && !Object.prototype.hasOwnProperty.call(dRaw, 'dl')
          ? true
          : jsonBoolean(jsonOwn(dRaw, 'dl', path), `${path}.d.dl`),
    },
  };
}

function jsonJoint(value: unknown, index: number): NativeMapJoint {
  const path = `physics.joints[${index}]`;
  const raw = jsonRecord(value, path);
  const type = jsonOwn(raw, 'type', path);
  if (type === 'g') {
    jsonKeys(raw, ['type', 'n', 'ja', 'jb', 'r'], [], path);
    return {
      type,
      n: jsonString(jsonOwn(raw, 'n', path), `${path}.n`),
      ja: jsonInt16(jsonOwn(raw, 'ja', path), `${path}.ja`),
      jb: jsonInt16(jsonOwn(raw, 'jb', path), `${path}.jb`),
      r: jsonNumber(jsonOwn(raw, 'r', path), `${path}.r`),
    };
  }

  if (type !== 'rv' && type !== 'd' && type !== 'lpj' && type !== 'lsj' && type !== 'p') {
    return jsonFail(`${path}.type`, `unsupported native joint ${String(type)}`, 'UNSUPPORTED_FEATURE');
  }
  const dRaw = jsonRecord(jsonOwn(raw, 'd', path), `${path}.d`);
  const common = jsonJointCommon(raw, path, type === 'p');
  if (type === 'p') {
    jsonKeys(raw, ['type', 'd', 'ba', 'bb', 'aa', 'ab', 'axa'], ['n'], path);
    jsonKeys(dRaw, ['el', 'lt', 'ut', 'em', 'mmf', 'ms', 'cc', 'bf', 'cd'], ['dl'], `${path}.d`);
    const result: NativeMapPrismaticJoint = {
      type,
      d: {
        ...common.d,
        el: jsonBoolean(jsonOwn(dRaw, 'el', path), `${path}.d.el`),
        lt: jsonNumber(jsonOwn(dRaw, 'lt', path), `${path}.d.lt`),
        ut: jsonNumber(jsonOwn(dRaw, 'ut', path), `${path}.d.ut`),
        em: jsonBoolean(jsonOwn(dRaw, 'em', path), `${path}.d.em`),
        mmf: jsonNumber(jsonOwn(dRaw, 'mmf', path), `${path}.d.mmf`),
        ms: jsonNumber(jsonOwn(dRaw, 'ms', path), `${path}.d.ms`),
        cd: jsonBoolean(jsonOwn(dRaw, 'cd', path), `${path}.d.cd`),
      },
      ba: common.ba,
      bb: common.bb,
      aa: jsonVector(jsonOwn(raw, 'aa', path), `${path}.aa`),
      ab: jsonVector(jsonOwn(raw, 'ab', path), `${path}.ab`),
      axa: jsonVector(jsonOwn(raw, 'axa', path), `${path}.axa`),
    };
    if (Object.prototype.hasOwnProperty.call(raw, 'n')) result.n = jsonString(jsonOwn(raw, 'n', path), `${path}.n`);
    if (!Object.prototype.hasOwnProperty.call(dRaw, 'dl')) delete result.d.dl;
    return result;
  }
  if (type === 'rv') {
    jsonKeys(raw, ['type', 'd', 'ba', 'bb', 'aa'], ['n'], path);
    jsonKeys(dRaw, ['la', 'ua', 'mmt', 'ms', 'el', 'em', 'cc', 'bf', 'dl'], [], `${path}.d`);
    return jsonJointLabel(
      raw,
      {
        ...common,
        type,
        d: {
          ...common.d,
          la: jsonNumber(jsonOwn(dRaw, 'la', path), `${path}.d.la`),
          ua: jsonNumber(jsonOwn(dRaw, 'ua', path), `${path}.d.ua`),
          mmt: jsonNumber(jsonOwn(dRaw, 'mmt', path), `${path}.d.mmt`),
          ms: jsonNumber(jsonOwn(dRaw, 'ms', path), `${path}.d.ms`),
          el: jsonBoolean(jsonOwn(dRaw, 'el', path), `${path}.d.el`),
          em: jsonBoolean(jsonOwn(dRaw, 'em', path), `${path}.d.em`),
        },
        aa: jsonVector(jsonOwn(raw, 'aa', path), `${path}.aa`),
      },
      path,
    );
  }
  if (type === 'd') {
    jsonKeys(raw, ['type', 'd', 'ba', 'bb', 'aa', 'ab'], ['n'], path);
    jsonKeys(dRaw, ['fh', 'dr', 'cc', 'bf', 'dl'], [], `${path}.d`);
    return jsonJointLabel(
      raw,
      {
        ...common,
        type,
        d: {
          ...common.d,
          fh: jsonNumber(jsonOwn(dRaw, 'fh', path), `${path}.d.fh`),
          dr: jsonNumber(jsonOwn(dRaw, 'dr', path), `${path}.d.dr`),
        },
        aa: jsonVector(jsonOwn(raw, 'aa', path), `${path}.aa`),
        ab: jsonVector(jsonOwn(raw, 'ab', path), `${path}.ab`),
      },
      path,
    );
  }
  if (type === 'lpj') {
    jsonKeys(raw, ['type', 'd', 'ba', 'bb', 'pax', 'pay', 'pa', 'pf', 'pl', 'pu', 'plen', 'pms'], ['n'], path);
    jsonKeys(dRaw, ['cc', 'bf', 'dl'], [], `${path}.d`);
    return jsonJointLabel(
      raw,
      {
        ...common,
        type,
        pax: jsonNumber(jsonOwn(raw, 'pax', path), `${path}.pax`),
        pay: jsonNumber(jsonOwn(raw, 'pay', path), `${path}.pay`),
        pa: jsonNumber(jsonOwn(raw, 'pa', path), `${path}.pa`),
        pf: jsonNumber(jsonOwn(raw, 'pf', path), `${path}.pf`),
        pl: jsonNumber(jsonOwn(raw, 'pl', path), `${path}.pl`),
        pu: jsonNumber(jsonOwn(raw, 'pu', path), `${path}.pu`),
        plen: jsonNumber(jsonOwn(raw, 'plen', path), `${path}.plen`),
        pms: jsonNumber(jsonOwn(raw, 'pms', path), `${path}.pms`),
      },
      path,
    );
  }
  jsonKeys(raw, ['type', 'd', 'ba', 'bb', 'sax', 'say', 'sf', 'slen'], ['n'], path);
  jsonKeys(dRaw, ['cc', 'bf', 'dl'], [], `${path}.d`);
  return jsonJointLabel(
    raw,
    {
      ...common,
      type,
      sax: jsonNumber(jsonOwn(raw, 'sax', path), `${path}.sax`),
      say: jsonNumber(jsonOwn(raw, 'say', path), `${path}.say`),
      sf: jsonNumber(jsonOwn(raw, 'sf', path), `${path}.sf`),
      slen: jsonNumber(jsonOwn(raw, 'slen', path), `${path}.slen`),
    },
    path,
  );
}

function jsonJointLabel(raw: JsonRecord, result: NativeMapJoint, path: string): NativeMapJoint {
  if (Object.prototype.hasOwnProperty.call(raw, 'n')) result.n = jsonString(jsonOwn(raw, 'n', path), `${path}.n`);
  return result;
}

export interface ValidateNativeMapJsonOptions {
  /**
   * `database-version` applies binary-layout feature gates using map.v.
   * `native-json` validates fields independently for original PSON/legacy merge
   * output, whose v resets to 1 even when it retains newer optional fields.
   */
  featureGates?: 'database-version' | 'native-json';
}

/** Recognition is intentionally cheap; call validateNativeMapJson before use. */
export function isNativeMapJson(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as JsonRecord;
  if (typeof raw.v !== 'number' || raw.s === null || typeof raw.s !== 'object' || Array.isArray(raw.s)) return false;
  if (raw.physics === null || typeof raw.physics !== 'object' || Array.isArray(raw.physics)) return false;
  if (!Array.isArray(raw.spawns) || !Array.isArray(raw.capZones)) return false;
  return raw.m !== null && typeof raw.m === 'object' && !Array.isArray(raw.m);
}

/**
 * Validate already-parsed native map JSON and deep-clone it into detached data.
 * This validates the supplied v1-v15 schema; unlike binary decoding it does not
 * infer migrations or claim that every generic JSON source used those versions.
 * Native JSON/PSON additionally permits `p` joints, `ch` shapes, fixture fs/zp,
 * and optional fields that have no database-binary representation.
 * By default, `database-version` feature gates apply the binary-layout rules
 * using map.v. `native-json` instead validates optional fields independently for
 * original PSON/legacy merge output, whose v resets to 1. Neither policy claims
 * simulator support for accepted fields.
 * Unknown fields are rejected: especially `physicsBodies`, which belongs to the
 * exporter facade and must never cause native `physics.bodies` to be emptied.
 */
export function validateNativeMapJson(value: unknown, options: ValidateNativeMapJsonOptions = {}): NativeMap {
  const featureGates = options.featureGates ?? 'database-version';
  if (featureGates !== 'database-version' && featureGates !== 'native-json') {
    fail('INVALID_OPTIONS', 'featureGates must be database-version or native-json', null, 'featureGates');
  }
  const root = jsonRecord(value, 'map');
  jsonKeys(root, ['v', 's', 'physics', 'spawns', 'capZones', 'm'], [], 'map');
  const version = jsonInteger(jsonOwn(root, 'v', 'map'), 'v');
  if (version < NATIVE_MAP_MIN_VERSION || version > NATIVE_MAP_MAX_VERSION) {
    jsonFail('v', `unsupported native map version ${version}`, 'UNSUPPORTED_VERSION');
  }

  const sRaw = jsonRecord(jsonOwn(root, 's', 'map'), 's');
  jsonKeys(sRaw, ['re', 'nc', 'pq', 'gd', 'fl'], [], 's');
  const s: NativeMapSettings = {
    re: jsonBoolean(jsonOwn(sRaw, 're', 's'), 's.re'),
    nc: jsonBoolean(jsonOwn(sRaw, 'nc', 's'), 's.nc'),
    pq: jsonInt16(jsonOwn(sRaw, 'pq', 's'), 's.pq'),
    gd: jsonNumber(jsonOwn(sRaw, 'gd', 's'), 's.gd'),
    fl: jsonBoolean(jsonOwn(sRaw, 'fl', 's'), 's.fl'),
  };

  const mRaw = jsonRecord(jsonOwn(root, 'm', 'map'), 'm');
  jsonKeys(
    mRaw,
    ['a', 'n', 'dbv', 'dbid', 'authid', 'date', 'rxid', 'rxn', 'rxa', 'rxdb', 'cr', 'pub', 'mo'],
    ['vu', 'vd'],
    'm',
  );
  if (
    featureGates === 'database-version' &&
    version < 10 &&
    (Object.prototype.hasOwnProperty.call(mRaw, 'vu') || Object.prototype.hasOwnProperty.call(mRaw, 'vd'))
  ) {
    jsonFail('m', 'vu/vd require native database version 10 or newer', 'UNSUPPORTED_FEATURE');
  }
  const m: NativeMapMetadata = {
    a: jsonString(jsonOwn(mRaw, 'a', 'm'), 'm.a'),
    n: jsonString(jsonOwn(mRaw, 'n', 'm'), 'm.n'),
    dbv: jsonInt32(jsonOwn(mRaw, 'dbv', 'm'), 'm.dbv'),
    dbid: jsonInt32(jsonOwn(mRaw, 'dbid', 'm'), 'm.dbid'),
    authid: jsonInt32(jsonOwn(mRaw, 'authid', 'm'), 'm.authid'),
    date: jsonString(jsonOwn(mRaw, 'date', 'm'), 'm.date'),
    rxid: jsonUint32(jsonOwn(mRaw, 'rxid', 'm'), 'm.rxid'),
    rxn: jsonString(jsonOwn(mRaw, 'rxn', 'm'), 'm.rxn'),
    rxa: jsonString(jsonOwn(mRaw, 'rxa', 'm'), 'm.rxa'),
    rxdb: jsonInt16(jsonOwn(mRaw, 'rxdb', 'm'), 'm.rxdb'),
    cr: jsonStringArray(jsonOwn(mRaw, 'cr', 'm'), 'm.cr'),
    pub: jsonBoolean(jsonOwn(mRaw, 'pub', 'm'), 'm.pub'),
    mo: jsonString(jsonOwn(mRaw, 'mo', 'm'), 'm.mo'),
  };
  if (featureGates === 'native-json' || version >= 10) {
    if (Object.prototype.hasOwnProperty.call(mRaw, 'vu')) m.vu = jsonUint32(jsonOwn(mRaw, 'vu', 'm'), 'm.vu');
    if (Object.prototype.hasOwnProperty.call(mRaw, 'vd')) m.vd = jsonUint32(jsonOwn(mRaw, 'vd', 'm'), 'm.vd');
  }

  const physicsRaw = jsonRecord(jsonOwn(root, 'physics', 'map'), 'physics');
  jsonKeys(physicsRaw, ['shapes', 'fixtures', 'bodies', 'bro', 'joints', 'ppm'], [], 'physics');
  const physics: NativeMap['physics'] = {
    shapes: jsonSlots(jsonOwn(physicsRaw, 'shapes', 'physics'), 'physics.shapes', jsonShape),
    fixtures: jsonSlots(jsonOwn(physicsRaw, 'fixtures', 'physics'), 'physics.fixtures', (entry, index) =>
      jsonFixture(entry, index, featureGates, version),
    ),
    bodies: jsonSlots(jsonOwn(physicsRaw, 'bodies', 'physics'), 'physics.bodies', (entry, index) =>
      jsonBody(entry, index, featureGates, version),
    ),
    bro: jsonInt16Array(jsonOwn(physicsRaw, 'bro', 'physics'), 'physics.bro'),
    joints: jsonSlots(jsonOwn(physicsRaw, 'joints', 'physics'), 'physics.joints', jsonJoint),
    ppm: jsonInt16(jsonOwn(physicsRaw, 'ppm', 'physics'), 'physics.ppm'),
  };
  const spawnsValue = jsonOwn(root, 'spawns', 'map');
  if (!Array.isArray(spawnsValue)) jsonFail('spawns', 'must be an array');
  const spawns: NativeMapSpawn[] = [];
  for (let i = 0; i < spawnsValue.length; i++) spawns.push(jsonSpawn(jsonOwn(spawnsValue, String(i), 'spawns'), i));
  const capZonesValue = jsonOwn(root, 'capZones', 'map');
  if (!Array.isArray(capZonesValue)) jsonFail('capZones', 'must be an array');
  const capZones: NativeMapCapZone[] = [];
  for (let i = 0; i < capZonesValue.length; i++)
    capZones.push(jsonCapZone(jsonOwn(capZonesValue, String(i), 'capZones'), i));

  return { v: version, s, physics, spawns, capZones, m };
}
