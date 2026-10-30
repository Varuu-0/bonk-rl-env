import { describe, expect, it } from 'vitest';
import {
  decodeNativeMapBinary,
  isNativeMapJson,
  validateNativeMapJson,
  NativeMapCodecError,
  type NativeMap,
} from '../../src/core/native-map-codec';

/**
 * Independent fixture writer. It follows the wire contract, not the production
 * reader, and exists only in this test file so binary fixtures remain visible.
 */
class FixtureWriter {
  private bytes: number[] = [];

  private number(value: number, size: number, write: (view: DataView, offset: number, value: number) => void): this {
    const buffer = new ArrayBuffer(size);
    write(new DataView(buffer), 0, value);
    this.bytes.push(...new Uint8Array(buffer));
    return this;
  }

  i16(value: number): this {
    return this.number(value, 2, (view, offset, n) => view.setInt16(offset, n, false));
  }

  i32(value: number): this {
    return this.number(value, 4, (view, offset, n) => view.setInt32(offset, n, false));
  }

  u32(value: number): this {
    return this.number(value, 4, (view, offset, n) => view.setUint32(offset, n, false));
  }

  f32(value: number): this {
    return this.number(value, 4, (view, offset, n) => view.setFloat32(offset, n, false));
  }

  f64(value: number): this {
    return this.number(value, 8, (view, offset, n) => view.setFloat64(offset, n, false));
  }

  bool(value: boolean | number): this {
    this.bytes.push(typeof value === 'number' ? value : value ? 1 : 0);
    return this;
  }

  utf(value: string): this {
    const encoded = new TextEncoder().encode(value);
    this.bytes.push(Math.floor(encoded.length / 256), encoded.length % 256, ...encoded);
    return this;
  }

  vector(x: number, y: number): this {
    return this.f64(x).f64(y);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function fixture(version: number, full = false): Uint8Array {
  const w = new FixtureWriter();
  w.i16(version).bool(true).bool(false);
  if (version >= 3) w.i16(2);
  if (version >= 4 && version <= 12) w.i16(31);
  else if (version >= 13) w.f32(30.5);
  if (version >= 9) w.bool(true);
  w.utf('rémix').utf('author\u0000x').u32(0xfedcba98).i16(-7).utf(`map-v${version}`).utf('作者');
  if (version >= 10) w.u32(4000000001).u32(3);
  if (version >= 4) w.i16(2).utf('first').utf('second');
  if (version >= 5) w.utf('arrows').i32(-123456789);
  if (version >= 7) w.bool(true);
  if (version >= 8) w.i32(27);
  w.i16(50).i16(3).i16(2).i16(-1).i16(2);

  if (!full) {
    w.i16(0).i16(0).i16(0).i16(0).i16(0).i16(0);
    return w.done();
  }

  // Box, circle, polygon: preserve array order and authored numeric values.
  w.i16(3);
  w.i16(1).f64(11).f64(22).vector(-3, 4).f64(0.25).bool(true);
  w.i16(2).f64(8.5).vector(9, -10).bool(false);
  w.i16(3).f64(1.5).f64(-0.75).vector(2, 3).i16(2).vector(-1, -2).vector(3, 4);

  w.i16(2);
  w.i16(-1)
    .utf('fixture-null')
    .f64(Number.MAX_VALUE)
    .i16(0)
    .f64(Number.MAX_VALUE)
    .f64(Number.MAX_VALUE)
    .u32(0xdeadbeef)
    .bool(false)
    .bool(true);
  if (version >= 11) w.bool(true);
  if (version >= 12) w.bool(false);
  w.i16(2).utf('fixture-player').f64(0.4).i16(2).f64(0.6).f64(0.7).u32(0x01020304).bool(true).bool(false);
  if (version >= 11) w.bool(false);
  if (version >= 12) w.bool(true);

  w.i16(1)
    .utf('d')
    .utf('body')
    .vector(1, -2)
    .f64(0.125)
    .f64(0.3)
    .bool(true)
    .f64(0.8)
    .f64(0.2)
    .vector(5, 6)
    .f64(-0.4)
    .f64(0.01)
    .f64(0.02)
    .bool(true)
    .bool(false)
    .vector(7, 8)
    .f64(120)
    .bool(false)
    .i16(-3)
    .bool(false)
    .bool(true)
    .bool(false)
    .bool(true);
  if (version >= 2) w.bool(false);
  if (version >= 14) {
    w.bool(true).vector(10, 20).bool(false).bool(true).bool(false);
    if (version >= 15) w.i16(42).f64(0.375);
  }
  // Deliberately repeated and negative indices: references, not validated IDs.
  w.i16(4).i16(1).i16(-1).i16(0).i16(1);

  w.i16(1).vector(-9, 10).vector(2, -3).i16(-5).bool(true).bool(false).bool(true).bool(false).bool(true).utf('spawn Ω');
  w.i16(1).utf('zone').f64(15).i16(-1);
  if (version >= 6) w.i16(3);

  // Exercise every supported joint layout, not just revolute/gear joints.
  w.i16(5);
  w.i16(1)
    .f64(-1)
    .f64(2)
    .f64(30)
    .f64(4)
    .bool(true)
    .bool(false)
    .vector(5, 6)
    .i16(1)
    .i16(-1)
    .bool(true)
    .f64(0.9)
    .bool(false);
  w.i16(2).f64(7).f64(0.2).vector(1, 2).vector(3, 4).i16(-1).i16(0).bool(false).f64(0.8).bool(true);
  w.i16(3).f64(1).f64(2).f64(3).f64(4).f64(5).f64(6).f64(7).f64(8).i16(0).i16(0).bool(true).f64(0.7).bool(false);
  w.i16(4).f64(1).f64(2).f64(3).f64(4).i16(0).i16(-1).bool(false).f64(0.6).bool(true);
  w.i16(5).utf('gear').i16(-1).i16(4).f64(1.25);
  return w.done();
}

function expectCodecError(run: () => unknown, code: NativeMapCodecError['code']): NativeMapCodecError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeMapCodecError);
    const codecError = error as NativeMapCodecError;
    expect(codecError.code).toBe(code);
    return codecError;
  }
  throw new Error(`Expected NativeMapCodecError(${code})`);
}

describe('native database map binary decoder', () => {
  it.each(Array.from({ length: 15 }, (_, index) => index + 1))(
    'decodes version %i with exact migration gates and complete input consumption',
    (version) => {
      const bytes = fixture(version);
      const map = decodeNativeMapBinary(bytes);
      expect(map.v).toBe(version);
      expect(map.s.pq).toBe(version >= 3 ? 2 : 1);
      expect(map.s.gd).toBe(version >= 13 ? 30.5 : version >= 4 ? 31 : 25);
      expect(map.s.fl).toBe(version >= 9);
      expect(map.m.vu).toBe(version >= 10 ? 4000000001 : undefined);
      expect(map.m.vd).toBe(version >= 10 ? 3 : undefined);
      expect('vu' in map.m).toBe(version >= 10);
      expect(map.m.cr).toEqual(version >= 4 ? ['first', 'second'] : []);
      expect(map.m.mo).toBe(version >= 5 ? 'arrows' : '');
      expect(map.m.dbid).toBe(version >= 5 ? -123456789 : -1);
      expect(map.m.pub).toBe(version >= 7);
      expect(map.m.dbv).toBe(version >= 8 ? 27 : 2);
      expect(map.physics).toEqual({ shapes: [], fixtures: [], bodies: [], bro: [2, -1, 2], joints: [], ppm: 50 });
      expect(map.spawns).toEqual([]);
      expect(map.capZones).toEqual([]);
      // Ensure the non-empty v15 cases below, not the writer, determine EOF.
      expect(decodeNativeMapBinary(bytes.slice().buffer)).toEqual(map);
    },
  );

  it.each([1, 10, 11, 12, 13, 14, 15])('decodes every entity layout with v%i feature defaults', (version) => {
    const map = decodeNativeMapBinary(fixture(version, true));
    expect(map.physics.shapes.map((shape) => shape!.type)).toEqual(['bx', 'ci', 'po']);
    expect(map.physics.shapes[2]!).toEqual({
      type: 'po',
      v: [
        [-1, -2],
        [3, 4],
      ],
      s: 1.5,
      a: -0.75,
      c: [2, 3],
    });
    expect(map.physics.fixtures[0]!).toMatchObject({
      sh: -1,
      fr: null,
      fp: null,
      re: null,
      de: null,
      f: 0xdeadbeef,
    });
    expect(map.physics.fixtures[1]!).toMatchObject({ sh: 2, fp: true, fr: 0.4, re: 0.6, de: 0.7 });
    expect(map.physics.fixtures.map((entry) => entry!.ng)).toEqual(version >= 11 ? [true, false] : [false, false]);
    expect(map.physics.fixtures.map((entry) => entry!.ig)).toEqual(
      version >= 12 ? [false, true] : [undefined, undefined],
    );
    expect(map.physics.fixtures.every((entry) => 'ig' in entry! === version >= 12)).toBe(true);

    const body = map.physics.bodies[0]!;
    expect(body.fx).toEqual([1, -1, 0, 1]);
    expect(body.s.f_c).toBe(-3);
    expect(body.s.f_p).toBe(version >= 2 ? false : true);
    expect(body.fz).toEqual(
      version >= 14
        ? {
            on: true,
            x: 10,
            y: 20,
            d: false,
            p: true,
            a: false,
            t: version >= 15 ? 42 : 0,
            cf: version >= 15 ? 0.375 : 0,
          }
        : { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    );
    expect(map.capZones).toEqual([{ n: 'zone', ty: version >= 6 ? 3 : 1, l: 15, i: -1 }]);
    expect(map.physics.joints.map((joint) => joint!.type)).toEqual(['rv', 'd', 'lpj', 'lsj', 'g']);
    expect(map.physics.joints[4]).toEqual({ type: 'g', n: 'gear', ja: -1, jb: 4, r: 1.25 });
    expect(map.physics.joints[2]).toMatchObject({ ba: 0, bb: 0, pms: 8, d: { cc: true, bf: 0.7, dl: false } });
  });

  it('uses Uint8Array bounds rather than ignoring unrelated bytes in its backing buffer', () => {
    const encoded = fixture(15, true);
    const storage = new Uint8Array(encoded.length + 9);
    storage.set([88, 88, 88, 88]);
    storage.set(encoded, 4);
    storage.set([99, 99, 99, 99, 99], encoded.length + 4);
    expect(decodeNativeMapBinary(storage.subarray(4, 4 + encoded.length))).toEqual(decodeNativeMapBinary(encoded));
  });

  it('retains valid legacy non-finite values but rejects non-finite physics numbers', () => {
    const legacy = decodeNativeMapBinary(fixture(15, true));
    expect(legacy.physics.fixtures[0]!.fr).toBeNull();

    const withInfinity = fixture(15, true);
    // Shape 0 w follows v(2), re/nc(2), pq(2), gd(4), fl(1), metadata and counts.
    const textLength = (text: string) => new TextEncoder().encode(text).length + 2;
    const shapeWOffset =
      2 +
      2 +
      2 +
      4 +
      1 +
      textLength('rémix') +
      textLength('author\u0000x') +
      4 +
      2 +
      textLength('map-v15') +
      textLength('作者') +
      4 +
      4 +
      2 +
      textLength('first') +
      textLength('second') +
      textLength('arrows') +
      4 +
      1 +
      4 +
      2 +
      2 +
      6 +
      2 +
      2;
    new DataView(withInfinity.buffer).setFloat64(shapeWOffset, Infinity, false);
    const error = expectCodecError(() => decodeNativeMapBinary(withInfinity), 'MALFORMED_DATA');
    expect(error.path).toBe('physics.shapes[0].w');
  });

  it('distinguishes unsupported versions, shape features, and joint features', () => {
    for (const version of [0, -1, 16, 32767]) {
      const error = expectCodecError(
        () => decodeNativeMapBinary(new FixtureWriter().i16(version).done()),
        'UNSUPPORTED_VERSION',
      );
      expect(error.path).toBe('v');
    }

    const unsupportedShape = fixture(1);
    const bytes = Array.from(unsupportedShape);
    // Empty v1 has six zero i16 collection counts at EOF. Insert shape count/type
    // immediately before fixture/body/spawn/capZone/joint counts.
    bytes.splice(bytes.length - 12, 0, 0, 1, 0, 4);
    const shapeError = expectCodecError(() => decodeNativeMapBinary(Uint8Array.from(bytes)), 'UNSUPPORTED_FEATURE');
    expect(shapeError.path).toBe('physics.shapes[0].type');

    const badJoint = fixture(1).slice();
    badJoint[badJoint.length - 2] = 0;
    badJoint[badJoint.length - 1] = 1;
    const withType = new Uint8Array(badJoint.length + 2);
    withType.set(badJoint);
    new DataView(withType.buffer).setInt16(withType.length - 2, 99, false);
    const jointError = expectCodecError(() => decodeNativeMapBinary(withType), 'UNSUPPORTED_FEATURE');
    expect(jointError.path).toBe('physics.joints[0].type');
  });

  it('rejects truncation at every byte boundary with a typed reason', () => {
    const bytes = fixture(15, true);
    for (let length = 0; length < bytes.length; length++) {
      const error = expectCodecError(() => decodeNativeMapBinary(bytes.subarray(0, length)), 'TRUNCATED_INPUT');
      expect(error.offset).toBeGreaterThanOrEqual(0);
      expect(error.path).toBeTruthy();
    }
  });

  it('rejects trailing bytes unless a framing caller explicitly permits them', () => {
    const bytes = fixture(15);
    const framed = new Uint8Array(bytes.length + 2);
    framed.set(bytes);
    framed.set([12, 34], bytes.length);
    const error = expectCodecError(() => decodeNativeMapBinary(framed), 'TRAILING_DATA');
    expect(error.offset).toBe(bytes.length);
    expect(decodeNativeMapBinary(framed, { allowTrailingBytes: true })).toEqual(decodeNativeMapBinary(bytes));
  });

  it('rejects corrupt booleans, fp discriminators, UTF-8, lengths, floats, and oversized inputs', () => {
    const booleanCorrupt = fixture(1).slice();
    booleanCorrupt[2] = 2;
    expectCodecError(() => decodeNativeMapBinary(booleanCorrupt), 'MALFORMED_DATA');

    const badUtf = fixture(1).slice();
    // v1: v/re/nc (4), rxn length (2), then first rxn byte.
    badUtf[6] = 0xff;
    expectCodecError(() => decodeNativeMapBinary(badUtf), 'MALFORMED_DATA');

    const badFp = fixture(15, true).slice();
    const fixtureName = new TextEncoder().encode('fixture-null');
    const nameOffset = badFp.findIndex(
      (value, index) => value === fixtureName[0] && fixtureName.every((byte, i) => badFp[index + i] === byte),
    );
    const fpOffset = nameOffset + fixtureName.length + 8;
    new DataView(badFp.buffer).setInt16(fpOffset, 3, false);
    const fpError = expectCodecError(() => decodeNativeMapBinary(badFp), 'MALFORMED_DATA');
    expect(fpError.path).toBe('physics.fixtures[0].fp');

    expectCodecError(
      () =>
        decodeNativeMapBinary(
          new FixtureWriter()
            .i16(1)
            .bool(0)
            .bool(0)
            .utf('')
            .utf('')
            .u32(0)
            .i16(0)
            .utf('')
            .utf('')
            .i16(12)
            .i16(-1)
            .done(),
        ),
      'MALFORMED_DATA',
    );

    const nonFiniteGravity = fixture(13).slice();
    // Gravity follows v(2), two booleans(2), pq(2).
    new DataView(nonFiniteGravity.buffer).setFloat32(6, NaN, false);
    expectCodecError(() => decodeNativeMapBinary(nonFiniteGravity), 'MALFORMED_DATA');

    expectCodecError(() => decodeNativeMapBinary(new Uint8Array(9), { maxInputBytes: 8 }), 'INPUT_TOO_LARGE');
    expectCodecError(() => decodeNativeMapBinary(new Uint8Array(0), { maxInputBytes: -1 }), 'INVALID_OPTIONS');
    expectCodecError(() => decodeNativeMapBinary(new Uint8Array(0), { maxCollectionLength: 32768 }), 'INVALID_OPTIONS');
    expectCodecError(() => decodeNativeMapBinary('AAEC' as unknown as Uint8Array), 'INVALID_INPUT');
  });

  it('enforces configured collection limits independently of the signed wire maximum', () => {
    const error = expectCodecError(
      () => decodeNativeMapBinary(fixture(1), { maxCollectionLength: 2 }),
      'LIMIT_EXCEEDED',
    );
    expect(error.path).toBe('physics.bro.length');
  });

  it('returns detached version-migrated native JSON, not shared input or approximate physics', () => {
    const bytes = fixture(15, true);
    const first: NativeMap = decodeNativeMapBinary(bytes);
    const second = decodeNativeMapBinary(bytes);
    expect(first).not.toBe(second);
    expect(first.physics.bodies).not.toBe(second.physics.bodies);
    expect(first.physics.bodies[0]!.fx).not.toBe(second.physics.bodies[0]!.fx);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.physics.bodies[0]!.p).toEqual([1, -2]); // No ppm conversion.
    bytes.fill(0);
    expect(first.physics.bodies[0]!.p).toEqual([1, -2]);
  });
});

describe('strict native JSON recognition and validation', () => {
  it.each([1, 10, 11, 12, 13, 14, 15])('round-trips decoded v%i JSON without normalization', (version) => {
    const decoded = decodeNativeMapBinary(fixture(version, true));
    const json = JSON.parse(JSON.stringify(decoded)) as unknown;
    expect(isNativeMapJson(json)).toBe(true);
    const validated = validateNativeMapJson(json);
    expect(validated).toEqual(decoded);
    expect(validated).not.toBe(decoded);
    expect(validated.physics.bodies[0]).not.toBe(decoded.physics.bodies[0]);
  });

  it('recognizes but strictly rejects the exporter physicsBodies side channel', () => {
    const native = JSON.parse(JSON.stringify(decodeNativeMapBinary(fixture(15)))) as Record<string, unknown>;
    native.physicsBodies = [{ unsupportedNativeMechanic: true }];
    expect(isNativeMapJson(native)).toBe(true);
    const error = expectCodecError(() => validateNativeMapJson(native), 'UNSUPPORTED_FEATURE');
    expect(error.path).toBe('map.physicsBodies');
  });

  it('preserves holes, explicit nulls, ordering and signed duplicate references', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    native.physics.shapes = [null, native.physics.shapes[0]!];
    native.physics.fixtures = new Array(3);
    native.physics.fixtures[1] = null;
    native.physics.bodies[1] = null;
    native.physics.joints = [native.physics.joints[4]!, null];
    native.physics.bro = [1, -1, 1];
    native.physics.bodies[0]!.fx = [1, -1, 1];

    const validated = validateNativeMapJson(native);
    expect(validated.physics.shapes.length).toBe(2);
    expect(validated.physics.shapes[0]).toBeNull();
    expect(validated.physics.fixtures.length).toBe(3);
    expect(0 in validated.physics.fixtures).toBe(false);
    expect(1 in validated.physics.fixtures).toBe(true);
    expect(validated.physics.fixtures[1]).toBeNull();
    expect(2 in validated.physics.fixtures).toBe(false);
    expect(validated.physics.bodies[1]).toBeNull();
    expect(validated.physics.joints.map((joint) => joint?.type ?? null)).toEqual(['g', null]);
    expect(validated.physics.bro).toEqual([1, -1, 1]);
    expect(validated.physics.bodies[0]!.fx).toEqual([1, -1, 1]);
  });

  it('rejects unknown fields instead of silently dropping unsupported native mechanics', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    (native.physics.bodies[0] as NativeMap['physics']['bodies'][number] & Record<string, unknown>).futureMechanic = {
      enabled: true,
    };
    const error = expectCodecError(() => validateNativeMapJson(native), 'UNSUPPORTED_FEATURE');
    expect(error.path).toBe('physics.bodies[0].futureMechanic');
  });

  it('rejects malformed raw JSON values and future versions with typed paths', () => {
    expect(isNativeMapJson({ name: 'exporter-map', bodies: [] })).toBe(false);
    expect(isNativeMapJson(null)).toBe(false);

    const future = decodeNativeMapBinary(fixture(15));
    future.v = 16;
    expectCodecError(() => validateNativeMapJson(future), 'UNSUPPORTED_VERSION');

    const oldVotes = decodeNativeMapBinary(fixture(9));
    oldVotes.m.vu = 1;
    expectCodecError(() => validateNativeMapJson(oldVotes), 'UNSUPPORTED_FEATURE');

    const corrupt = decodeNativeMapBinary(fixture(15, true));
    corrupt.physics.bodies[0]!.p[0] = NaN;
    const error = expectCodecError(() => validateNativeMapJson(corrupt), 'MALFORMED_DATA');
    expect(error.path).toBe('physics.bodies[0].p[0]');
  });

  it('accepts native optional circle angle and polygon shrink state without normalization', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    (native.physics.shapes[1] as NativeMap['physics']['shapes'][number] & { a: number }).a = 0.5;
    (native.physics.shapes[2] as NativeMap['physics']['shapes'][number] & { sk: boolean }).sk = true;
    const validated = validateNativeMapJson(native);
    expect(validated.physics.shapes[1]).toHaveProperty('a', 0.5);
    expect(validated.physics.shapes[2]).toHaveProperty('sk', true);
  });
});

describe('native JSON-only source fields', () => {
  it('validates prismatic joints without claiming a database-binary representation', () => {
    const native = decodeNativeMapBinary(fixture(15));
    native.physics.joints = [
      {
        type: 'p',
        n: 'prismatic',
        ba: -1,
        bb: 0,
        aa: [1, 2],
        ab: [3, 4],
        axa: [0, 1],
        d: { el: true, lt: -10, ut: 10, em: false, mmf: 20, ms: 3, cc: true, bf: 4, cd: false },
      },
    ];
    const validated = validateNativeMapJson(native);
    expect(validated.physics.joints[0]).toEqual(native.physics.joints[0]);
    expect(validated.physics.joints[0]).not.toBe(native.physics.joints[0]);
  });

  it('validates chain shapes and fixture fs/zp while binary still rejects unknown tags', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    native.physics.shapes.push({
      type: 'ch',
      v: [
        [0, 0],
        [10, 10],
      ],
      s: 1,
      a: 0,
      c: [0, 0],
      l: false,
      sk: true,
    });
    native.physics.fixtures[0]!.fs = 'metal';
    native.physics.fixtures[0]!.zp = 3;
    const validated = validateNativeMapJson(native);
    expect(validated.physics.shapes[3]).toMatchObject({ type: 'ch', l: false, sk: true });
    expect(validated.physics.fixtures[0]).toMatchObject({ fs: 'metal', zp: 3 });
  });

  it('permits optional generic JSON ig and v10+ votes, but preserves their presence when supplied', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    delete native.physics.fixtures[0]!.ig;
    delete native.physics.fixtures[1]!.ig;
    delete native.m.vu;
    delete native.m.vd;
    const validated = validateNativeMapJson(native);
    expect('ig' in validated.physics.fixtures[0]!).toBe(false);
    expect('vu' in validated.m).toBe(false);
    expect('vd' in validated.m).toBe(false);
  });

  it('rejects explicit undefined instead of silently converting it to missing JSON', () => {
    const native = decodeNativeMapBinary(fixture(15));
    native.m.vu = undefined;
    const error = expectCodecError(() => validateNativeMapJson(native), 'NON_JSON_VALUE');
    expect(error.path).toBe('m.vu');
  });
});

// Transport fixture imports are appended separately to keep the original 46
// binary/JSON cases above unchanged and independently reviewable.
import { deflateSync } from 'node:zlib';
import {
  decodeLegacyNativeMapBytes,
  decodeLegacyNativeMapPayload,
  decodeNativeMapDatabaseBase64,
  decodeNativeMapDatabasePayload,
  decodeNativeMapEnvelope,
  decodeNativeMapPson,
  decodeNativeMapPsonPayload,
  decodeNativeMapPsonValue,
  NATIVE_MAP_PSON_DICTIONARY,
} from '../../src/core/native-map-codec';

// LZString 1.5.0 compressToEncodedURIComponent(fixture(1)'s Base64). This fixed
// reference string avoids a runtime or test dependency on the reference package.
const DATABASE_V1_URI_LZ =
  'ILCiCEWBxBjBnA8gBwEYHUA2AWEALPAEwA0AlAe1QGYBJYAUwAUB2WAV2QCsB6AagEUYGAGIB3ADLEAmgA8QqANYA3AFoAvcgHMaAVWABZTcAAiIcd26jgAYSh37doA';

class TransportFixtureWriter {
  readonly bytes: number[] = [];
  number(value: number, size: number, write: (view: DataView, offset: number, value: number) => void): this {
    const buffer = new ArrayBuffer(size);
    write(new DataView(buffer), 0, value);
    this.bytes.push(...new Uint8Array(buffer));
    return this;
  }
  u8(value: number): this {
    this.bytes.push(value);
    return this;
  }
  i16(value: number): this {
    return this.number(value, 2, (view, offset, n) => view.setInt16(offset, n, false));
  }
  f64(value: number): this {
    return this.number(value, 8, (view, offset, n) => view.setFloat64(offset, n, false));
  }
  f32le(value: number): this {
    return this.number(value, 4, (view, offset, n) => view.setFloat32(offset, n, true));
  }
  f64le(value: number): this {
    return this.number(value, 8, (view, offset, n) => view.setFloat64(offset, n, true));
  }
  utf(value: string): this {
    const bytes = new TextEncoder().encode(value);
    return this.u8(Math.floor(bytes.length / 256))
      .u8(bytes.length % 256)
      .raw(...bytes);
  }
  raw(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function amfInt29(value: number): number[] {
  if (value < 0 || value >= 0x20000000) throw new Error('fixture expects an unsigned int29 bit pattern');
  if (value < 0x80) return [value];
  if (value < 0x4000) return [(value >>> 7) | 0x80, value & 0x7f];
  if (value < 0x200000) return [(value >>> 14) | 0x80, ((value >>> 7) & 0x7f) | 0x80, value & 0x7f];
  return [(value >>> 22) | 0x80, ((value >>> 15) & 0x7f) | 0x80, ((value >>> 8) & 0x7f) | 0x80, value & 0xff];
}
function amfString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  const output = [6];
  let offset = 0;
  do {
    const count = Math.min(bytes.length - offset, 64);
    output.push(count * 2 + 1);
    offset += count;
  } while (offset < bytes.length);
  return [...output, ...bytes];
}
function amfAlias(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [7, bytes.length * 2 + 1, ...bytes];
}
function amfArray(...values: number[][]): number[] {
  const output = [9];
  let remaining = values.length;
  do {
    const count = Math.min(remaining, 64);
    output.push(count * 2 + 1);
    remaining -= count;
  } while (remaining > 0);
  output.push(1);
  for (const value of values) output.push(...value);
  return output;
}
function legacyCaptureFixture(zoneName = 'zone'): Uint8Array {
  const writer = new TransportFixtureWriter();
  writer
    .raw(10, ...amfAlias('gmp'))
    .i16(5)
    .utf('legacy')
    .utf('author');
  for (const value of [20, 12, 0, 0.8, 1, 0, 1, 12]) writer.f64(value);
  writer.i16(0).i16(0);
  const key = (value: string) => [value.length * 2 + 1, ...new TextEncoder().encode(value)];
  const keys = ['framesToDetonate', 'x', 'radius', 'version', 'y', 'captureLimit', 'captureProgress', 'ownerID'];
  const values = [
    4,
    ...amfInt29(0),
    4,
    ...amfInt29(-200 & 0x1fffffff),
    5,
    ...new TransportFixtureWriter().f64(2).done(),
    4,
    ...amfInt29(0),
    4,
    ...amfInt29(-195 & 0x1fffffff),
    4,
    ...amfInt29(1),
    5,
    ...new TransportFixtureWriter().f64(2).done(),
    4,
    ...amfInt29(0),
  ];
  writer
    .raw(...amfArray([10, 129, ...amfAlias('czs'), ...keys.flatMap(key), ...values]), ...amfArray(amfString(zoneName)))
    .u8(0)
    .u8(1);
  return writer.done();
}
function psonVaruint(value: number): number[] {
  const output: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    output.push(byte);
  } while (value !== 0);
  return output;
}
function psonString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [0xfc, ...psonVaruint(bytes.length), ...bytes];
}
function psonMetadataFixture(): Uint8Array {
  return Uint8Array.from([
    0xf6,
    1,
    ...psonString('m'),
    0xf6,
    6,
    ...psonString('a'),
    ...psonString('author'),
    ...psonString('n'),
    ...psonString('map'),
    ...psonString('cr'),
    0xf7,
    0,
    ...psonString('vu'),
    0xf8,
    10,
    ...psonString('vd'),
    0xf8,
    8,
    ...psonString('rxid'),
    0xfb,
    ...new TransportFixtureWriter().f64le(1234).done(),
  ]);
}

describe('native outer transports and legacy migration', () => {
  it('decodes fixed reference URI-LZ and Base64 database payloads and applies envelope metadata', () => {
    const bytes = fixture(1);
    const base64 = Buffer.from(bytes).toString('base64');
    const expected = decodeNativeMapBinary(bytes);
    expect(decodeNativeMapDatabaseBase64(base64)).toEqual(expected);
    expect(decodeNativeMapDatabasePayload(DATABASE_V1_URI_LZ)).toEqual(expected);
    const invalidFlush = `${DATABASE_V1_URI_LZ}B`;
    expectCodecError(() => decodeNativeMapDatabasePayload(invalidFlush), 'TRAILING_DATA');
    const envelope = decodeNativeMapEnvelope(`2,outer name,outer author,-42,${DATABASE_V1_URI_LZ}`);
    expect(envelope.m).toMatchObject({ n: 'outer name', a: 'outer author', dbid: -42, dbv: 2, rxn: 'rémix' });
    expect(
      decodeNativeMapEnvelope({ dbv: '2', name: 'object', author: 'fields', id: '7', payload: DATABASE_V1_URI_LZ }).m,
    ).toMatchObject({ n: 'object', a: 'fields', dbid: 7 });
  });

  it('decodes zlib/BonkView with signed int29, dynamic cap-zone keys and original v1 merge', () => {
    const bytes = legacyCaptureFixture();
    const decoded = decodeLegacyNativeMapBytes(bytes);
    expect(decoded.v).toBe(1);
    expect(decoded.physics.bodies[0]!.p).toEqual([-200, -195]);
    expect(decoded.physics.shapes[0]).toEqual({ type: 'ci', r: 24, c: [0, 0], sk: false });
    expect(decoded.capZones).toEqual([{ n: 'zone', ty: 1, l: 1, i: 0 }]);
    expect(decoded.physics.fixtures[0]).toMatchObject({ n: 'Def Fix', sh: 0, fr: 0.3, re: 0.8, de: 0.3 });
    const payload = encodeURIComponent(deflateSync(bytes).toString('base64'));
    expect(decodeLegacyNativeMapPayload(payload)).toEqual(decoded);
    const envelope = decodeNativeMapEnvelope(`1,envelope name,envelope author,-42,${payload}`);
    expect(envelope.m).toMatchObject({ n: 'envelope name', a: 'envelope author', dbid: -42, dbv: 1 });
  });

  it('rejects malformed database transport alphabets, padding, truncation and trailing data', () => {
    const base64 = Buffer.from(fixture(1)).toString('base64');
    for (const corrupt of ['A', 'A===', 'AA=A', 'AA!A', 'AB==']) {
      expectCodecError(() => decodeNativeMapDatabaseBase64(corrupt), 'MALFORMED_DATA');
    }
    expectCodecError(() => decodeNativeMapDatabasePayload(''), 'TRUNCATED_INPUT');
    expectCodecError(() => decodeNativeMapDatabasePayload('!'), 'MALFORMED_DATA');
    expectCodecError(() => decodeNativeMapDatabasePayload(`${DATABASE_V1_URI_LZ}B`), 'TRAILING_DATA');
    expectCodecError(() => decodeNativeMapDatabasePayload(`${DATABASE_V1_URI_LZ}AAAA`), 'TRAILING_DATA');
    const nonzeroPadding = `${DATABASE_V1_URI_LZ.slice(0, -1)}B`;
    expectCodecError(() => decodeNativeMapDatabasePayload(nonzeroPadding), 'MALFORMED_DATA');
    expectCodecError(() => decodeNativeMapDatabasePayload(base64), 'MALFORMED_DATA');
    expectCodecError(() => decodeNativeMapEnvelope('3,n,a,1,x'), 'UNSUPPORTED_VERSION');
    expectCodecError(() => decodeNativeMapEnvelope('2,n,a,2147483648,x'), 'MALFORMED_DATA');
  });

  it('keeps URI, inflation, legacy graph and limit failures distinct and typed', () => {
    const bytes = legacyCaptureFixture();
    const payload = encodeURIComponent(deflateSync(bytes).toString('base64'));
    expectCodecError(() => decodeLegacyNativeMapPayload('%'), 'TRUNCATED_INPUT');
    expectCodecError(() => decodeLegacyNativeMapPayload('%GG'), 'MALFORMED_DATA');
    expectCodecError(() => decodeLegacyNativeMapPayload('%FF'), 'MALFORMED_DATA');
    expectCodecError(() => decodeLegacyNativeMapPayload('AA=='), 'INFLATION_ERROR');
    const largeLegacy = legacyCaptureFixture('x'.repeat(500));
    const largePayload = encodeURIComponent(deflateSync(largeLegacy).toString('base64'));
    expectCodecError(
      () => decodeLegacyNativeMapPayload(largePayload, { maxIntermediateBytes: 300 }),
      'INFLATION_ERROR',
    );
    expectCodecError(() => decodeLegacyNativeMapPayload(`${payload}A`), 'MALFORMED_DATA');
    for (let length = 0; length < bytes.length; length++) {
      expectCodecError(() => decodeLegacyNativeMapBytes(bytes.subarray(0, length)), 'TRUNCATED_INPUT');
    }
    expectCodecError(() => decodeLegacyNativeMapBytes(new Uint8Array([...bytes, 0])), 'TRAILING_DATA');
    const badRoot = bytes.slice();
    badRoot[3] = 120; // gmp -> xmp: a syntactically valid but wrong root object.
    expectCodecError(() => decodeLegacyNativeMapBytes(badRoot), 'UNSUPPORTED_FEATURE');
    expectCodecError(() => decodeLegacyNativeMapBytes(new Uint8Array([9, 1, 1])), 'MALFORMED_DATA');
    const unsupportedAlias = bytes.slice();
    unsupportedAlias[4] = 120;
    expectCodecError(() => decodeLegacyNativeMapBytes(unsupportedAlias), 'UNSUPPORTED_FEATURE');
    const unsupportedTag = bytes.slice();
    unsupportedTag[0] = 4;
    expectCodecError(() => decodeLegacyNativeMapBytes(unsupportedTag), 'UNSUPPORTED_FEATURE');
    expectCodecError(() => decodeLegacyNativeMapBytes(bytes, { maxPsonDepth: 0 }), 'LIMIT_EXCEEDED');
    expectCodecError(() => decodeLegacyNativeMapBytes(largeLegacy, { maxIntermediateBytes: 32 }), 'LIMIT_EXCEEDED');
    expectCodecError(() => decodeLegacyNativeMapBytes(bytes, { maxCollectionLength: 0 }), 'LIMIT_EXCEEDED');
    const malformedNames = bytes.slice();
    const namesOffset = malformedNames.findIndex(
      (value, index) => value === 9 && malformedNames[index + 1] === 3 && malformedNames[index + 3] === 6,
    );
    expect(namesOffset).toBeGreaterThan(0);
    malformedNames[namesOffset + 3] = 4; // Cap-zone names must be AMF strings.
    expectCodecError(() => decodeLegacyNativeMapBytes(malformedNames), 'UNSUPPORTED_FEATURE');
  });
});

describe('native PSON primitive reader and merge', () => {
  it('decodes primitives, little-endian numbers, dictionary order and exact static strings', () => {
    const values = [0xf6, 8];
    const expected: Record<string, unknown> = {};
    const entries: Array<[string, number[], unknown]> = [
      ['smallPositive', [16], 8],
      ['smallNegative', [17], -9],
      ['null', [0xf0], null],
      ['true', [0xf1], true],
      ['false', [0xf2], false],
      ['emptyObject', [0xf3], {}],
      ['emptyArray', [0xf4], []],
      ['emptyString', [0xf5], ''],
    ];
    for (const [key, encoding, value] of entries) {
      values.push(...psonString(key), ...encoding);
      expected[key] = value;
    }
    expect(decodeNativeMapPsonValue(Uint8Array.from(values))).toEqual(expected);
    expect(decodeNativeMapPsonValue(Uint8Array.from([0xf8, ...psonVaruint(0xffffffff)]))).toBe(-2147483648);
    expect(decodeNativeMapPsonValue(Uint8Array.from([0xfa, ...new TransportFixtureWriter().f32le(-2.5).done()]))).toBe(
      -2.5,
    );
    expect(decodeNativeMapPsonValue(Uint8Array.from([0xfb, ...new TransportFixtureWriter().f64le(1e100).done()]))).toBe(
      1e100,
    );
    expect(decodeNativeMapPsonValue(Uint8Array.from([0xfe, 0]))).toBe('physics');
    expect(decodeNativeMapPsonValue(Uint8Array.from([0xfe, NATIVE_MAP_PSON_DICTIONARY.length - 1]))).toBe('16777215');
    expect(NATIVE_MAP_PSON_DICTIONARY.indexOf('fr')).not.toBe(NATIVE_MAP_PSON_DICTIONARY.lastIndexOf('fr'));
    expect(NATIVE_MAP_PSON_DICTIONARY.indexOf('d')).not.toBe(NATIVE_MAP_PSON_DICTIONARY.lastIndexOf('d'));
    expect(NATIVE_MAP_PSON_DICTIONARY.slice(0, 11)).toEqual([
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
    ]);
    const utf = Uint8Array.from([0xfc, 2, 0xc3, 0xa9]);
    expect(decodeNativeMapPsonValue(utf)).toBe('é');
  });

  it('resets source v through original merge and validates newer optional fields by native-json policy', () => {
    const value = decodeNativeMapPsonValue(psonMetadataFixture()) as Record<string, any>;
    expect(value.m).toEqual({ a: 'author', n: 'map', cr: [], vu: 5, vd: 4, rxid: 1234 });
    value.v = 14;
    value.physics = {
      shapes: [{ type: 'ci', r: 4, c: [0, 0], sk: false }],
      fixtures: [{ sh: 0, ig: true, fr: null, re: null, de: null }],
      bodies: [],
      bro: [],
      joints: [],
      ppm: 12,
    };
    value.m.cr = [];
    const bytes = encodePsonFixture(value);
    const merged = decodeNativeMapPson(bytes);
    expect(merged.v).toBe(1);
    expect(merged.m.vu).toBe(5);
    expect(merged.m.vd).toBe(4);
    expect(merged.physics.fixtures[0]!.ig).toBe(true);
    expect(merged.physics.fixtures[0]!.fr).toBeNull();
    expect(() => validateNativeMapJson(merged)).toThrow(NativeMapCodecError);
    const validated = validateNativeMapJson(merged, { featureGates: 'native-json' });
    expect(validated).toEqual(merged);
  });

  it('decodes the PSON URI-LZ transport with a fixed reference wrapper', () => {
    const merged = decodeNativeMapPson(psonMetadataFixture());
    // LZString 1.5.0 wrapper for this fixture's Base64; no package dependency.
    const wrapper =
      'JwcwEgHAgg6gzAJgEIDcDuSCaAzNBxTADQDUAGAQz2AE8B6KAMQFd6A5AFyIBFoBbV6sDQ8oAOwBaARgDUUAE7QJAa1kArCEjAApACzkYAFQDsUU2aQBJJaSgBeIA';
    expect(decodeNativeMapPsonPayload(wrapper)).toEqual(merged);
  });

  it('rejects noncanonical integers, overflow, duplicate keys and unsupported PSON features', () => {
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0xf8, 0x80, 0])), 'MALFORMED_DATA');
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf8, 0xff, 0xff, 0xff, 0xff, 0x10])),
      'MALFORMED_DATA',
    );
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf8, 0x80, 0x80, 0x80, 0x80, 0])),
      'MALFORMED_DATA',
    );
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf6, 2, ...psonString('x'), 0, ...psonString('x'), 1])),
      'MALFORMED_DATA',
    );
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0xf6, 1, 0, 0])), 'UNSUPPORTED_FEATURE');
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xfe, NATIVE_MAP_PSON_DICTIONARY.length])),
      'MALFORMED_DATA',
    );
    for (const tag of [0xf9, 0xfd, 0xff])
      expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([tag])), 'UNSUPPORTED_FEATURE');
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0, 0])), 'TRAILING_DATA');
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0xfb, 1, 2])), 'TRUNCATED_INPUT');
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0xfc, 1, 0xff])), 'MALFORMED_DATA');
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0xfa, 0, 0, 0x80, 0x7f])), 'MALFORMED_DATA');
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf7, 2, 0, 0]), { maxCollectionLength: 1 }),
      'LIMIT_EXCEEDED',
    );
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf7, 1, 0xf7, 0]), { maxPsonDepth: 0 }),
      'LIMIT_EXCEEDED',
    );
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xf7, 1, 0]), { maxPsonValues: 1 }),
      'LIMIT_EXCEEDED',
    );
    expectCodecError(
      () => decodeNativeMapPsonValue(Uint8Array.from([0xfc, 2, 65, 65]), { maxIntermediateBytes: 1 }),
      'LIMIT_EXCEEDED',
    );
    expectCodecError(() => decodeNativeMapPsonValue(Uint8Array.from([0, 0]), { maxInputBytes: 1 }), 'INPUT_TOO_LARGE');
  });
});

// Small independently written PSON/LZ writers used only for transport tests.
function encodePsonFixture(value: unknown): Uint8Array {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -120 && value <= 119)
      return Uint8Array.from([value >= 0 ? value * 2 : -value * 2 - 1]);
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
      return Uint8Array.from([0xf8, ...psonVaruint(value >= 0 ? value * 2 : -value * 2 - 1)]);
    return Uint8Array.from([0xfb, ...new TransportFixtureWriter().f64le(value).done()]);
  }
  if (typeof value === 'string') return Uint8Array.from(psonString(value));
  if (value === null) return Uint8Array.from([0xf0]);
  if (typeof value === 'boolean') return Uint8Array.from([value ? 0xf1 : 0xf2]);
  if (Array.isArray(value))
    return Uint8Array.from([
      0xf7,
      ...psonVaruint(value.length),
      ...value.flatMap((entry) => [...encodePsonFixture(entry)]),
    ]);
  const entries = Object.entries(value as Record<string, unknown>);
  return Uint8Array.from([
    0xf6,
    ...psonVaruint(entries.length),
    ...entries.flatMap(([key, entry]) => [...psonString(key), ...encodePsonFixture(entry)]),
  ]);
}

describe('native JSON joint and feature preservation', () => {
  it('retains joint labels and common distance fields without inventing missing fields', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    for (const [index, joint] of native.physics.joints.entries()) {
      if (!joint || joint.type === 'g') continue;
      joint.n = `joint-${index}`;
      joint.d.cc = true;
      joint.d.bf = 1.5;
      if (joint.type === 'd') joint.d.dl = false;
    }
    const validated = validateNativeMapJson(native);
    expect(validated.physics.joints).toEqual(native.physics.joints);
    expect((validated.physics.joints[1] as any).n).toBe('joint-1');
    expect((validated.physics.joints[1] as any).d.dl).toBe(false);
  });

  it('applies votes, ig and force-zone version gates only in database-version policy', () => {
    const native = decodeNativeMapBinary(fixture(15, true));
    native.v = 1;
    native.m.vu = 17;
    native.m.vd = 4;
    native.physics.bodies[0]!.fz = { on: true, x: 10, y: 20, d: false, p: true, a: false, t: 2, cf: 0.5 };
    for (const expectedPath of ['m', 'physics.fixtures[0].ig', 'physics.bodies[0].fz.on']) {
      const copy = JSON.parse(JSON.stringify(native));
      if (expectedPath === 'm')
        copy.physics.fixtures.forEach((entry: any) => {
          delete entry.ig;
        });
      if (expectedPath.endsWith('ig')) {
        delete copy.m.vu;
        delete copy.m.vd;
        copy.physics.bodies[0].fz.on = false;
      }
      if (expectedPath.endsWith('on')) {
        delete copy.m.vu;
        delete copy.m.vd;
        copy.physics.fixtures.forEach((entry: any) => {
          delete entry.ig;
        });
      }
      const error = expectCodecError(() => validateNativeMapJson(copy), 'UNSUPPORTED_FEATURE');
      expect(error.path).toBe(expectedPath);
    }
    const validated = validateNativeMapJson(native, { featureGates: 'native-json' });
    expect(validated).toEqual(native);
    const invalid = JSON.parse(JSON.stringify(native));
    invalid.m.vu = -1;
    expectCodecError(() => validateNativeMapJson(invalid, { featureGates: 'native-json' }), 'MALFORMED_DATA');
    expectCodecError(() => validateNativeMapJson(native, { featureGates: 'other' as any }), 'INVALID_OPTIONS');
  });
});
