'use strict';
/* Original-vs-independent native map codec differential.
 * Requires the pinned .deobf artifacts and validation-only lz-string@1.5.0 +
 * pson@2.0.0 packages. Package locations can be supplied with LZ_STRING_MODULE
 * and PSON_MODULE (absolute paths to package roots or resolved entry files).
 * Run from repository root: npx tsx validation/native/map-codec-differential.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const codec = require('../../src/core/native-map-codec.ts');
const { nativeMapToArena } = require('../../src/core/native-map-session.ts');
const root = path.resolve(__dirname, '../..');
const manifest = require('./map-codec-corpus.json');
for (const row of manifest.entries) {
  assert.equal(
    crypto.createHash('sha256').update(row.record).digest('hex'),
    row.recordSha256,
    `record hash ${row.index}`,
  );
  assert.equal(
    crypto.createHash('sha256').update(row.payload).digest('hex'),
    row.payloadSha256,
    `payload hash ${row.index}`,
  );
}
for (const [artifact, expected] of Object.entries(manifest.provenance.hashes)) {
  const actual = crypto
    .createHash('sha256')
    .update(
      fs.readFileSync(
        path.join(
          root,
          '.deobf',
          {
            raw: 'alpha2s.raw.js',
            readable: 'alpha2s.readable.js',
            slotAccurate: 'alpha2s.slot-accurate.js',
          }[artifact],
        ),
      ),
    )
    .digest('hex');
  assert.equal(actual, expected, `${artifact} source hash`);
}
function optionalRequire(name, variable) {
  if (process.env[variable]) return require(path.resolve(process.env[variable]));
  try {
    return require(name);
  } catch (error) {
    throw new Error(
      `Validation-only ${name} package is unavailable. Install it outside production dependencies or set ${variable}.`,
      { cause: error },
    );
  }
}
const LZString = optionalRequire('lz-string', 'LZ_STRING_MODULE');
const PSON = optionalRequire('pson', 'PSON_MODULE');
const source = fs.readFileSync(path.join(root, '.deobf/alpha2s.slot-accurate.js'), 'utf8');
const lines = source.split('\n');
const segment = (first, last) => lines.slice(first - 1, last).join('\n');
const context = vm.createContext({
  console,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
  window: {
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    pako: { inflate: (bytes) => zlib.inflateSync(bytes) },
  },
  LZString,
  game: { mapVersion: 15 },
  SafeTrig: { safeCos: Math.cos, safeSin: Math.sin },
});
function run(code, name) {
  return new vm.Script(code, { filename: name }).runInContext(context, { timeout: 30000 });
}
run(segment(6467, 6979), 'BonkView');
run(segment(7955, 8035), 'Bonk1Map');
run('var Shape; var Game; function MapEncoder() {}', 'map declarations');
run(segment(8046, 8277), 'Bonk legacy aliases');
run(segment(9658, 10849), 'MapEncoder codecs');
run(segment(10919, 11163), 'MapEncoder legacy migration');
context.corpus = manifest.entries.map(({ table, dbv, name, record, payload }) => ({
  table,
  dbv,
  name,
  record,
  payload,
}));
const results = run(
  `corpus.map((row) => {
  try {
    const map = row.dbv === 1 ? MapEncoder.fromOldString(row.payload) : MapEncoder.decodeFromDatabase(row.payload);
    const split = row.record.split(',');
    map.m.dbid = parseInt(split[3]); map.m.dbv = parseInt(split[0]); map.m.n = split[1]; map.m.a = split[2];
    return { map };
  } catch (error) { return { error: String(error), stack: error.stack }; }
})`,
  'all corpus decoding',
);
function firstDifference(actual, expected, fieldPath = '$') {
  if (Object.is(actual, expected)) return null;
  if (typeof actual !== typeof expected || actual === null || expected === null || typeof actual !== 'object')
    return { path: fieldPath, actual, expected };
  if (Array.isArray(actual) !== Array.isArray(expected)) return { path: fieldPath, actual, expected };
  if (Array.isArray(actual) && actual.length !== expected.length)
    return { path: `${fieldPath}.length`, actual: actual.length, expected: expected.length };
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const childPath = Array.isArray(actual) ? `${fieldPath}[${key}]` : `${fieldPath}.${key}`;
    if (Object.prototype.hasOwnProperty.call(actual, key) !== Object.prototype.hasOwnProperty.call(expected, key)) {
      return {
        path: childPath,
        actualPresent: Object.prototype.hasOwnProperty.call(actual, key),
        expectedPresent: Object.prototype.hasOwnProperty.call(expected, key),
      };
    }
    const difference = firstDifference(actual[key], expected[key], childPath);
    if (difference) return difference;
  }
  return null;
}
function canonical(value) {
  return JSON.stringify(value, (_key, entry) => (Object.is(entry, -0) ? { $negativeZero: true } : entry));
}
const failures = [];
const receipts = [];
const databaseVersions = {};
let votes = 0,
  innerGrapple = 0,
  activeForceZoneMaps = 0,
  activeForceZoneBodies = 0;
const fieldCoverage = new Map();
const jointTypes = {};
const shapeTypes = {};
function countFields(value, prefix = '') {
  if (Array.isArray(value)) {
    for (const entry of value) countFields(entry, `${prefix}[]`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const fieldPath = `${prefix}.${key}`;
    fieldCoverage.set(fieldPath, (fieldCoverage.get(fieldPath) || 0) + 1);
    countFields(entry, fieldPath);
  }
}
for (let index = 0; index < results.length; index++) {
  const oracle = results[index];
  const row = manifest.entries[index];
  try {
    if (oracle.error) throw new Error(`original failed: ${oracle.error}`);
    const actual = codec.decodeNativeMapEnvelope(row.record);
    const difference = firstDifference(actual, oracle.map);
    assert.equal(difference, null, JSON.stringify(difference));
    const validated = codec.validateNativeMapJson(actual, {
      featureGates: row.dbv === 1 ? 'native-json' : 'database-version',
    });
    assert.equal(firstDifference(validated, actual), null, 'validated map differs from decoded map');
    countFields(actual);
    for (const joint of actual.physics.joints) if (joint) jointTypes[joint.type] = (jointTypes[joint.type] || 0) + 1;
    for (const shape of actual.physics.shapes) if (shape) shapeTypes[shape.type] = (shapeTypes[shape.type] || 0) + 1;
    if (row.dbv === 2) {
      databaseVersions[actual.v] = (databaseVersions[actual.v] || 0) + 1;
      const bytes = Buffer.from(LZString.decompressFromEncodedURIComponent(row.payload), 'base64');
      const base64 = Buffer.from(bytes).toString('base64');
      assert.equal(LZString.compressToEncodedURIComponent(base64), row.payload, 'reference LZString recompression');
      assert.equal(
        firstDifference(codec.decodeNativeMapDatabaseBase64(base64), codec.decodeNativeMapDatabasePayload(row.payload)),
        null,
        'Base64 and URI-LZ payload layers differ',
      );
    }
    const hasVotes = actual.m.vu !== undefined || actual.m.vd !== undefined;
    const hasInnerGrapple = actual.physics.fixtures.some((entry) => entry?.ig === true);
    const forceZones = actual.physics.bodies.flatMap((entry, bodyIndex) =>
      entry?.fz.on ? [{ bodyIndex, fz: entry.fz }] : [],
    );
    if (hasVotes) votes++;
    if (hasInnerGrapple) innerGrapple++;
    if (forceZones.length) {
      activeForceZoneMaps++;
      activeForceZoneBodies += forceZones.length;
    }
    const arenaNames = new Set(['Partition Demolition', 'Arrow Columns II', 'DARUDE - SANDSTONE', 'Wobble Cross']);
    if (forceZones.length || arenaNames.has(row.name)) {
      const receipt = {
        index: row.index,
        table: row.table,
        tableIndex: row.tableIndex,
        name: row.name,
        dbv: row.dbv,
        binaryVersion: actual.v,
        hasVotes,
        hasInnerGrapple,
        forceZones,
      };
      try {
        const arena = nativeMapToArena(validated);
        receipt.arena = {
          accepted: true,
          ppm: arena.ppm,
          spawnCount: arena.spawns.length,
          normalizedPhysics: 'physics' in arena,
        };
      } catch (error) {
        receipt.arena = {
          accepted: false,
          error: error.constructor.name,
          code: error.code || null,
          path: error.path || null,
          message: error.message,
        };
        if (forceZones.length) {
          assert.equal(error.code, 'UNSUPPORTED_NATIVE_MECHANIC');
          assert.match(error.path || '', /\.fz\.on$/);
        } else throw error;
      }
      receipts.push(receipt);
    }
  } catch (error) {
    failures.push({
      index,
      table: row.table,
      name: row.name,
      dbv: row.dbv,
      error: error.name,
      difference: error.message,
      offset: error.offset,
      path: error.path,
    });
    if (failures.length <= 12) console.log('FAIL', failures.at(-1));
  }
}
const psonSamples = [];
for (const oracle of results) {
  if (psonSamples.length >= 12) break;
  if (oracle.error) continue;
  const map = oracle.map;
  const pair = new PSON.StaticPair(codec.NATIVE_MAP_PSON_DICTIONARY.slice());
  const psonBytes = pair.encode(JSON.parse(JSON.stringify(map))).toBuffer();
  const psonValue = codec.decodeNativeMapPsonValue(psonBytes);
  assert.equal(canonical(psonValue), canonical(map));
  const psonMap = codec.decodeNativeMapPson(psonBytes);
  const expected = run(`MapEncoder.mergeIntoNewMap(${JSON.stringify(map)})`, 'PSON map merge');
  const difference = firstDifference(psonMap, expected);
  assert.equal(difference, null, JSON.stringify(difference));
  const validated = codec.validateNativeMapJson(psonMap, { featureGates: 'native-json' });
  assert.equal(firstDifference(validated, psonMap), null);
  psonSamples.push({ map: map.m.n, bytes: psonBytes.length });
}
const report = {
  schema: 1,
  corpus: {
    records: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    uniqueTableAndRecord: manifest.counts.uniqueTableAndRecord,
  },
  databaseVersions,
  fieldPresence: Object.fromEntries([...fieldCoverage].sort(([a], [b]) => a.localeCompare(b))),
  jointTypes,
  shapeTypes,
  originalFeatures: {
    mapsWithVotes: votes,
    mapsWithInnerGrapple: innerGrapple,
    activeForceZoneMaps,
    activeForceZoneBodies,
  },
  arenaReceipts: receipts,
  pson: {
    samples: psonSamples,
    originalWireCapture: false,
    evidence:
      'Reference PSON 2.0.0 encoding of original-derived maps, compared against original merge execution. Not a live or original-produced PSON wire capture.',
  },
  sourceHashes: manifest.provenance.hashes,
  failures,
};
fs.writeFileSync(path.join(__dirname, 'map-codec-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`corpus ${results.length} pass ${results.length - failures.length} fail ${failures.length}`);
console.log('database versions', JSON.stringify(databaseVersions));
console.log('features', JSON.stringify(report.originalFeatures));
console.log(`PSON reference parity samples passed ${psonSamples.length}; no original wire capture`);
console.log(`arena receipts ${receipts.length}; active force-zone simulator support remains rejected`);
if (failures.length) process.exitCode = 1;
