'use strict';
/* Rebuild map-codec-corpus.json from the pinned, read-only client artifacts.
 * This validation-only extractor never writes to the source corpus directory.
 * Invocation from repository root: node validation/native/map-codec-extract.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const sourcePath = (name) => path.join(root, '.deobf', name);
const sources = {
  raw: fs.readFileSync(sourcePath('alpha2s.raw.js')),
  readable: fs.readFileSync(sourcePath('alpha2s.readable.js')),
  slotAccurate: fs.readFileSync(sourcePath('alpha2s.slot-accurate.js')),
};
const expected = {
  raw: 'e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e',
  readable: '2097916f16311692a5a457690e3bd8377ac0d07e7d58ad95490c73ff74baadd3',
  slotAccurate: '9da97285e3c5ea36a88ef99e9927d4a513be913ebc376aae9696282f86c37f89',
};
const hashes = {};
for (const [key, bytes] of Object.entries(sources)) {
  hashes[key] = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hashes[key] !== expected[key]) throw new Error(`Pinned ${key} SHA256 mismatch: ${hashes[key]}`);
}
const pattern =
  /(?:Maps|V5k|t\$e\.Length)(?:\["(mapStrings|arrowMapStrings|grappleMapStrings)"\]|\.(mapStrings|arrowMapStrings|grappleMapStrings))(?:\["push"\]|\.push)\(\s*("(?:\\.|[^"\\])*")\s*\)/g;
function extract(bytes) {
  const text = bytes.toString('utf8');
  const rows = [];
  for (const match of text.matchAll(pattern)) {
    const record = JSON.parse(match[3]);
    const fields = record.split(',');
    if (fields.length !== 5) throw new Error(`Expected five envelope fields at UTF-16 index ${match.index}`);
    rows.push({
      table: match[1] || match[2],
      record,
      payload: fields[4],
      dbv: fields[0],
      name: fields[1],
      author: fields[2],
      id: fields[3],
      sourceLine: text.slice(0, match.index).split('\n').length,
      sourceUtf16Offset: match.index,
      sourceByteOffset: Buffer.byteLength(text.slice(0, match.index), 'utf8'),
    });
  }
  return rows;
}
const readable = extract(sources.readable);
const slotAccurate = extract(sources.slotAccurate);
if (readable.length !== 289 || slotAccurate.length !== readable.length)
  throw new Error(`Expected 289 records, found ${readable.length}/${slotAccurate.length}`);
const identity = (row) => `${row.table}\0${row.record}`;
const unique = new Set(readable.map(identity));
if (unique.size !== 288) throw new Error(`Expected 288 unique table+record identities, found ${unique.size}`);
const slotByIdentity = new Map();
for (const row of slotAccurate) {
  const key = identity(row);
  const matches = slotByIdentity.get(key) || [];
  matches.push(row);
  slotByIdentity.set(key, matches);
}
const seen = new Map();
const firstByIdentity = new Map();
const tableIndices = new Map();
const entries = readable.map((row, index) => {
  const key = identity(row);
  const duplicateIndex = seen.get(key) || 0;
  const slot = slotByIdentity.get(key)?.[duplicateIndex];
  if (!slot)
    throw new Error(`No matching slot-accurate record for ${row.table}/${row.name} occurrence ${duplicateIndex}`);
  seen.set(key, duplicateIndex + 1);
  const tableIndex = tableIndices.get(row.table) || 0;
  tableIndices.set(row.table, tableIndex + 1);
  const entry = {
    index,
    table: row.table,
    tableIndex,
    dbv: Number(row.dbv),
    name: row.name,
    author: row.author,
    id: Number(row.id),
    record: row.record,
    payload: row.payload,
    recordSha256: crypto.createHash('sha256').update(row.record).digest('hex'),
    payloadSha256: crypto.createHash('sha256').update(row.payload).digest('hex'),
    source: {
      artifact: 'alpha2s.readable.js',
      sha256: hashes.readable,
      line: row.sourceLine,
      utf16Offset: row.sourceUtf16Offset,
      utf8ByteOffset: row.sourceByteOffset,
    },
    slotAccurate: {
      artifact: 'alpha2s.slot-accurate.js',
      sha256: hashes.slotAccurate,
      line: slot.sourceLine,
      utf16Offset: slot.sourceUtf16Offset,
      utf8ByteOffset: slot.sourceByteOffset,
    },
    duplicateOfTableAndRecord: duplicateIndex === 0 ? null : firstByIdentity.get(key),
  };
  if (duplicateIndex === 0) firstByIdentity.set(key, index);
  return entry;
});
const counts = (key) =>
  Object.fromEntries(
    [...new Set(entries.map(key))]
      .sort()
      .map((value) => [String(value), entries.filter((entry) => key(entry) === value).length]),
  );
const manifest = {
  schema: 1,
  provenance: {
    description:
      'Original built-in map envelopes extracted from readable and slot-accurate artifacts, bound by SHA256 to the pinned raw artifact. The raw artifact does not contain these strings literally; this is not raw-substring extraction.',
    sourceDirectory: '.deobf',
    hashes,
    rawLiteralSubstringExtraction: false,
    oracle: 'Pinned slot-accurate routines executed by map-codec-differential.cjs, not the raw decoder itself.',
    recordIdentity: 'table + exact five-field record; 289 entries, 288 unique identities.',
  },
  decoderEvidence:
    'map-codec-differential.cjs measures native binary versions, field presence and downstream arena receipts; this extractor does not infer decoder semantics.',
  counts: {
    records: entries.length,
    uniqueTableAndRecord: unique.size,
    tables: counts((x) => x.table),
    outerDbv: counts((x) => x.dbv),
  },
  entries,
};
const output = path.join(__dirname, 'map-codec-corpus.json');
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${path.relative(root, output)}: ${entries.length} entries; ${unique.size} unique identities`);
console.log(JSON.stringify(manifest.counts));
