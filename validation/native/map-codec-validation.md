# Native map codec validation

Validated 2026-10-26 in `E:\Projects\bonk-rl-env`. The maintained decoder is `src/core/native-map-codec.ts`; its unit fixtures are in `tests/unit/native-map-codec.test.ts`.

## Transport contract and evidence boundary

- **Database (`dbv=2`)**: URI-safe LZString -> Base64 -> big-endian database binary. The binary is neither PSON nor zlib-compressed. Envelope fields authoritatively replace `m.dbid`, `m.dbv`, `m.n`, and `m.a`; direct payload decoding does not apply those envelope overrides.
- **Legacy (`dbv=1`)**: strict URI decode -> Base64 -> zlib -> legacy BonkView externalized objects -> pinned migrations -> original-style final merge.
- **PSON**: an independent reader with the exact pinned static dictionary and original merge semantics. PSON/legacy final merge starts from a blank map and resets `v` to 1; database binary retains its actual `v`.
- **Validation is not simulation support.** `native-json` validates optional fields independently when original merge output resets `v` to 1. The default `database-version` policy retains the v1-v15 binary-layout gates. Both reject unknown fields rather than silently discarding mechanics.

No production dependency on `bonk-game`, LZString, or PSON was added. No package or shared/session/state file was edited for this codec work.

## Maintained files

| File                          | Purpose                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map-codec-extract.cjs`       | Rebuilds the original-corpus manifest and enforces all three pinned source hashes.                                                                                                                                     |
| `map-codec-corpus.json`       | 289 exact envelopes plus table/index, record/payload SHA256, source line, UTF-16 offset, true UTF-8 byte offset, matching slot-accurate locator, outer `dbv`, and duplicate identity.                                  |
| `map-codec-differential.cjs`  | Executes pinned slot-accurate oracle routines, compares decoded values without JSON-cloning oracle state, checks schema and database transport layers, samples PSON, and records decode -> validate -> arena outcomes. |
| `map-codec-results.json`      | Machine-readable differential, field/type coverage, PSON, and arena receipts.                                                                                                                                          |
| `map-codec-test-results.json` | Vitest JSON receipt for all 56 unit cases, including malformed transports and limits.                                                                                                                                  |

## Provenance

| Pinned artifact                   | SHA256                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| `.deobf/alpha2s.raw.js`           | `e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e` |
| `.deobf/alpha2s.readable.js`      | `2097916f16311692a5a457690e3bd8377ac0d07e7d58ad95490c73ff74baadd3` |
| `.deobf/alpha2s.slot-accurate.js` | `9da97285e3c5ea36a88ef99e9927d4a513be913ebc376aae9696282f86c37f89` |

The original-produced built-in records were recovered from the readable/slot-accurate artifacts and bound to the pinned raw hash. **The raw artifact does not contain literal map strings; this is not raw-substring extraction.** Oracle execution uses pinned slot-accurate routines, not direct raw-decoder execution.

Source ranges executed by the differential (slot-accurate lines): BonkView 6467-6979; Bonk1Map 7955-8035; legacy aliases/capture zones 8046-8277; database/factories/merge 9658-10849; legacy migration 10919-11163. `Map.dict` is at 7496-7567.

## Original-corpus results

`corpus 289 pass 289 fail 0`; 288 unique `table + record` pairs. The duplicate is linked explicitly in the manifest. All 175 reference LZString recompressions matched the original database payload bytes. All entries passed the appropriate post-decode schema policy.

| Table                  | Records |
| ---------------------- | ------: |
| `mapStrings`           |      97 |
| `arrowMapStrings`      |      33 |
| `grappleMapStrings`    |     159 |
| Legacy outer `dbv=1`   |     114 |
| Database outer `dbv=2` |     175 |

| Original database binary `v` | Records |
| ---------------------------- | ------: |
| 4                            |       2 |
| 5                            |       1 |
| 7                            |       3 |
| 8                            |       2 |
| 9                            |       3 |
| 10                           |      14 |
| 12                           |      14 |
| 13                           |      76 |
| 14                           |      60 |

There are no original-produced database fixtures here for v1, v2, v3, v6, v11, or v15. The unit suite retains independent synthetic coverage of every v1-v15 layout. Original legacy maps all merge to `v=1`; this does not establish original database-binary v1 coverage.

### Fields and entity types

The complete structural field-presence counts are in `map-codec-results.json`. Arrays use `[]` in the path, so defaults and genuinely absent optional fields remain distinguishable.

- Votes: 164 records contain `m.vu`/`m.vd`.
- `ig`: 31 records contain an active inner-grapple fixture; 6,548 fixture entries carry the field (including false).
- Active force zones: 6 maps, 25 bodies. Observed samples are binary v14.
- Joints: `rv` 357, `d` 321, `lpj` 270, `lsj` 20. No original gear-joint or prismatic `p` instance appears in this corpus.
- Shapes: `bx` 7,382, `ci` 3,768, `po` 2,506. No original `ch` instance appears in this corpus.
- Original anonymous legacy capture records use eight declared keys. The decoder consumes the original migration fields and does not require a guessed telemetry key. Unused nonfinite telemetry is not promoted into map physics.
- JSON-only joint labels, common joint fields, `ch`, `p`, and v15 force-zone countdown/coefficient layouts have explicit synthetic tests, not original-corpus claims.

### PSON evidence and gap

Twelve reference samples passed primitive/value parity and original-merge parity. Evidence is **PSON 2.0.0 reference encoding of original-derived maps plus original merge execution**. No original-produced PSON wire fixture or live server capture was found. This is not a live-interoperability claim. Long, binary, and mutation-oriented `STRING_ADD` remain explicitly unsupported.

## Decode -> validate -> arena receipts

These receipts use the current read-only `nativeMapToArena` boundary. They do not assert that every accepted codec field has simulator semantics.

| Original map         | Votes | Active `ig` | Active `fz` bodies | Arena outcome                                  |
| -------------------- | ----- | ----------- | -----------------: | ---------------------------------------------- |
| Partition Demolition | yes   | no          |                  0 | accepted; ppm 12, 8 spawns                     |
| Arrow Columns II     | yes   | no          |                  0 | accepted; ppm 8, 7 spawns                      |
| DARUDE - SANDSTONE   | yes   | no          |                  0 | accepted; ppm 15, 6 spawns                     |
| Wobble Cross         | yes   | yes         |                  0 | accepted; ppm 12, 7 spawns, normalized physics |
| Tub Jump             | yes   | yes         |                  1 | typed rejection at `physics.bodies[0].fz.on`   |
| Cloverloaded         | yes   | no          |                  1 | typed rejection at `physics.bodies[5].fz.on`   |
| Uncanny              | yes   | no          |                  8 | typed rejection at `physics.bodies[0].fz.on`   |
| Thalassophobia       | yes   | no          |                  3 | typed rejection at `physics.bodies[0].fz.on`   |
| Soft Conveyor 2      | yes   | no          |                 10 | typed rejection at `physics.bodies[0].fz.on`   |
| Infinity             | yes   | no          |                  2 | typed rejection at `physics.bodies[22].fz.on`  |

All six active-force-zone cases produce `NativeMapSessionError`, code `UNSUPPORTED_NATIVE_MECHANIC`, at the specific `fz.on` path. Active force zones require contact-time force injection; codec acceptance is not simulator support. Complete per-body force-zone values and arena metadata are in `map-codec-results.json`.

## Malformed-input receipts

`map-codec-test-results.json` records 56/56 passing cases. The ten new transport/PSON/schema cases join the original 46 cases unchanged in intent. Covered failures include:

- Base64 invalid length/alphabet/padding and nonzero unused bits; URI invalid escapes, invalid UTF-8, truncation, and trailing data.
- URI-LZ invalid alphabet, truncation, nonzero padding, arbitrary trailing data, and dictionary/EOF handling.
- Binary truncation at every byte boundary, trailing bytes, corrupt booleans, discriminators, UTF-8, nonfinite physics values, versions, and unsupported tags.
- PSON noncanonical/overflowing varints, duplicate/non-string keys, unknown dictionary indices, invalid UTF-8/nonfinite numbers, unsupported long/binary/string-add tags, and trailing data.
- Legacy truncation at every byte boundary, unsupported aliases/tags, malformed roots and arrays, dynamic capture keys, signed int29, and zlib failures.
- Distinct input/intermediate/inflation/collection/string/value/depth limit errors; no catch-all conversion of malformed data into holes or default maps.

## Exact commands and current results

Run from repository root. Validation-only reference packages are not production dependencies; supply package roots through `LZ_STRING_MODULE` and `PSON_MODULE` or make `lz-string@1.5.0` and `pson@2.0.0` resolvable only to the harness.

```powershell
node validation/native/map-codec-extract.cjs
# wrote 289 entries; 288 unique identities

npx vitest run tests/unit/native-map-codec.test.ts --reporter=json --outputFile=validation/native/map-codec-test-results.json
# exit 0; 1 file passed; 56/56 tests passed

npx vitest run tests/integration/map-load-failure.test.ts
# exit 0; 1 file passed; 3/3 tests passed

npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node src/core/native-map-codec.ts
# exit 0

npm run typecheck
# exit 0

$env:LZ_STRING_MODULE='C:\Users\varun\AppData\Local\npm-cache\_npx\bd01c429fe43cc88\node_modules\lz-string'
$env:PSON_MODULE='C:\Users\varun\AppData\Local\npm-cache\_npx\f3ab77d9927b2f2b\node_modules\pson'
npx tsx validation/native/map-codec-differential.cjs
# exit 0; corpus 289 pass 289 fail 0
# 12 PSON reference parity samples; 10 arena receipts
```

The absolute package paths above are this machine's validation-only setup, not source imports. Regenerate the manifest before the differential after any extraction-rule change; the differential independently verifies every record/payload hash and all three source hashes.
