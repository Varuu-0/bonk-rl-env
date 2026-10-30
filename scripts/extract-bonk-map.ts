/**
 * Extract a native Bonk.io map into engine-loadable NativeMap JSON.
 *
 * Auto-detects the input format and decodes it with the strict native map
 * codec, then writes the validated map so it can be loaded by the local
 * engine (mapPath / mapData) for map-parity checking.
 *
 * Accepted inputs (auto-detected, in order):
 *   1. An existing JSON file containing NativeMap JSON (v1-v15)
 *   2. A five-field native map envelope: dbv,name,author,id,payload
 *      (as a literal string, a text file, or a JSON file/object)
 *   3. A dbv=2 database payload (URI-LZString -> Base64 -> database binary)
 *   4. A dbv=1 legacy payload (URI decode -> Base64 -> zlib -> BonkView)
 *   5. A PSON payload (URI-LZString -> Base64 -> PSON)
 *   6. A raw Base64 database binary
 *
 * Usage:
 *   npx tsx scripts/extract-bonk-map.ts --in <path-or-literal> [--out <path>]
 *        [--mode b|sp|bs] [--ticks N] [--verify] [--json]
 *
 * --verify loads the extracted map through the native map session and steps
 * it N ticks (default 8) to prove the output is engine-loadable. --json
 * prints the summary as a single JSON object instead of human text.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeNativeMapEnvelope,
  decodeNativeMapDatabasePayload,
  decodeNativeMapDatabaseBase64,
  decodeNativeMapPsonPayload,
  decodeLegacyNativeMapPayload,
  isNativeMapJson,
  validateNativeMapJson,
  type NativeMap,
  type NativeMapEnvelope,
} from '../src/core/native-map-codec';
import { createNativeMapSession } from '../src/core/native-map-session';

interface CliOptions {
  input: string;
  output: string | null;
  mode: 'b' | 'sp' | 'bs';
  ticks: number;
  verify: boolean;
  json: boolean;
}

const USAGE = `Usage: npx tsx scripts/extract-bonk-map.ts --in <path-or-literal> [options]

Options:
  --in <value>     Map source: file path or literal payload/envelope string
  --out <path>     Output path (default: maps/extracted-<sanitized-name>.json)
  --mode b|sp|bs   Room mode used for --verify (default b)
  --ticks N        Ticks to step during --verify (default 8)
  --verify         Load the output through the engine and step it
  --json           Print the summary as JSON instead of human text
  --help           Show this help`;

/** Fatal input/usage error. main() converts this into exit code 1. */
export class ExtractBonkMapError extends Error {
  override readonly name = 'ExtractBonkMapError';
}

function fail(message: string): never {
  throw new ExtractBonkMapError(message);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    input: '',
    output: null,
    mode: 'b',
    ticks: 8,
    verify: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === '--in' || arg === '-i') {
      options.input = argv[++i] ?? fail('--in requires a value');
    } else if (arg === '--out' || arg === '-o') {
      options.output = argv[++i] ?? fail('--out requires a value');
    } else if (arg === '--mode' || arg === '-m') {
      const mode = argv[++i] ?? fail('--mode requires a value');
      if (mode !== 'b' && mode !== 'sp' && mode !== 'bs') fail(`--mode must be b, sp, or bs (got ${mode})`);
      options.mode = mode;
    } else if (arg === '--ticks') {
      const ticks = argv[++i] ?? fail('--ticks requires a value');
      const parsed = Number(ticks);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100000) {
        fail(`--ticks must be an integer in [0, 100000] (got ${ticks})`);
      }
      options.ticks = parsed;
    } else if (arg === '--verify') {
      options.verify = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      fail(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if (!options.input) fail(`--in is required\n\n${USAGE}`);
  return options;
}

/** Read a file as UTF-8 text, tolerating a BOM, with a clear error on failure. */
function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    return fail(`cannot read input file "${file}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse JSON with a helpful error identifying the source. */
function parseJsonText(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** True when the value is a five-field envelope object. */
function isEnvelopeObject(value: unknown): value is NativeMapEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.dbv === 'string' &&
    typeof raw.name === 'string' &&
    typeof raw.author === 'string' &&
    typeof raw.id === 'string' &&
    typeof raw.payload === 'string'
  );
}

/** Decode an already-parsed JSON value: NativeMap JSON or envelope object. */
function decodeParsedJson(parsed: unknown, source: string): { map: NativeMap; format: string } {
  if (isNativeMapJson(parsed)) return { map: validateNativeMapJson(parsed), format: 'native-map-json' };
  if (isEnvelopeObject(parsed)) return { map: decodeNativeMapEnvelope(parsed), format: 'envelope-json' };
  return fail(`${source} is JSON but is neither NativeMap JSON nor a five-field map envelope`);
}

/** Attempt to decode a text literal as each supported native format, in order. */
function decodeLiteral(text: string, source: string): { map: NativeMap; format: string } {
  const trimmed = text.trim();
  // JSON literal (NativeMap object or envelope object pasted directly).
  if (trimmed.startsWith('{')) {
    return decodeParsedJson(parseJsonText(trimmed, `${source} (JSON literal)`), `${source} (JSON literal)`);
  }
  // Five-field envelope: dbv,name,author,id,payload.
  const envelope = tryDecodeEnvelope(trimmed);
  if (envelope) return { map: envelope, format: 'envelope-literal' };
  // Database payload (dbv=2): URI-LZString -> Base64 -> binary.
  try {
    return { map: decodeNativeMapDatabasePayload(trimmed), format: 'database-payload' };
  } catch {
    /* fall through to the next format */
  }
  // PSON payload: URI-LZString -> Base64 -> PSON.
  try {
    return { map: decodeNativeMapPsonPayload(trimmed), format: 'pson-payload' };
  } catch {
    /* fall through */
  }
  // Legacy payload (dbv=1): URI decode -> Base64 -> zlib -> BonkView.
  try {
    return { map: decodeLegacyNativeMapPayload(trimmed), format: 'legacy-payload' };
  } catch {
    /* fall through */
  }
  // Raw Base64 database binary.
  try {
    return { map: decodeNativeMapDatabaseBase64(trimmed), format: 'database-base64' };
  } catch {
    /* fall through */
  }
  return fail(
    `${source}: input matched no supported format. Supported: NativeMap JSON file/literal, ` +
      `five-field envelope (dbv,name,author,id,payload), dbv=2 database payload, ` +
      `dbv=1 legacy payload, PSON payload, or raw Base64 database binary.`,
  );
}

/**
 * Decode a five-field envelope. Native envelopes are exactly five
 * comma-separated fields (the original client and the corpus extractor both
 * split on ',' and require five fields), so that split is tried first. A
 * tolerant comma-scan fallback covers hand-made envelopes whose name or
 * author contains a comma; the first split the strict decoder accepts wins.
 */
function tryDecodeEnvelope(text: string): NativeMap | null {
  const split = text.split(',');
  if (split.length === 5) {
    try {
      return decodeNativeMapEnvelope({
        dbv: split[0]!,
        name: split[1]!,
        author: split[2]!,
        id: split[3]!,
        payload: split[4]!,
      });
    } catch {
      return null; // five fields, but not a decodable envelope
    }
  }
  if (split.length < 5 || split.length > 12) return null; // not plausibly an envelope
  const dbv = split[0]!;
  if (dbv !== '1' && dbv !== '2') return null;
  // name ends at comma c, author at comma d, id at comma k; payload follows k.
  for (let c = 1; c < split.length - 2; c++) {
    for (let d = c; d < split.length - 1; d++) {
      for (let k = d + 1; k < split.length; k++) {
        const id = split[k]!;
        if (!/^-?\d+$/.test(id)) continue;
        try {
          return decodeNativeMapEnvelope({
            dbv,
            name: split.slice(1, c + 1).join(','),
            author: split.slice(c + 1, d + 1).join(','),
            id,
            payload: split.slice(k + 1).join(','),
          });
        } catch {
          // wrong comma split: keep scanning
        }
      }
    }
  }
  return null;
}

/** Attempt to decode the input, treating it as a file path or a literal. */
export function decodeInput(input: string): { map: NativeMap; format: string } {
  // 1. Existing file (NativeMap JSON, envelope JSON, or payload/envelope text).
  const couldBeFile = input.length <= 4096 && !/[\r\n]/.test(input);
  if (couldBeFile && fs.existsSync(input)) {
    const text = readTextFile(input);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return decodeParsedJson(parseJsonText(trimmed, `input file "${input}"`), `input file "${input}"`);
    }
    // Plain text file: treat its contents as a literal payload/envelope.
    return decodeLiteral(trimmed, `input file "${input}"`);
  }
  // 2. Literal string: envelope, database payload, legacy payload, PSON, or base64.
  return decodeLiteral(input, 'input');
}

/** Sanitize a map name into a filesystem-safe slug. */
export function sanitizeName(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'map';
}

function defaultOutputPath(map: NativeMap): string {
  return path.join('maps', `extracted-${sanitizeName(map.m.n)}.json`);
}

/** Count populated (non-hole) slots in a native slot arrays. */
function countSlots(slots: readonly unknown[]): number {
  let count = 0;
  for (const slot of slots) if (slot !== undefined && slot !== null) count++;
  return count;
}

interface ExtractionSummary {
  format: string;
  output: string;
  version: number;
  mapName: string;
  author: string;
  dbid: number;
  dbv: number;
  mode: string;
  ppm: number;
  shapes: number;
  fixtures: number;
  bodies: number;
  joints: number;
  spawns: number;
  capZones: number;
  verified: boolean;
  verifyTicks: number;
  verifyError: string | null;
}

function buildSummary(
  map: NativeMap,
  format: string,
  output: string,
  verify: VerificationResult | null,
): ExtractionSummary {
  return {
    format,
    output,
    version: map.v,
    mapName: map.m.n,
    author: map.m.a,
    dbid: map.m.dbid,
    dbv: map.m.dbv,
    mode: map.m.mo,
    ppm: map.physics.ppm,
    shapes: countSlots(map.physics.shapes),
    fixtures: countSlots(map.physics.fixtures),
    bodies: countSlots(map.physics.bodies),
    joints: countSlots(map.physics.joints),
    spawns: map.spawns.length,
    capZones: map.capZones.length,
    verified: verify?.ok ?? false,
    verifyTicks: verify?.ticks ?? 0,
    verifyError: verify?.error ?? null,
  };
}

interface VerificationResult {
  ok: boolean;
  ticks: number;
  error: string | null;
}

/** Load the extracted file through the engine's native map session and step it. */
function verifyOutput(outputPath: string, mode: 'b' | 'sp' | 'bs', ticks: number): VerificationResult {
  try {
    const parsed = parseJsonText(readTextFile(outputPath), `output file "${outputPath}"`);
    if (!isNativeMapJson(parsed)) return { ok: false, ticks: 0, error: 'output is not NativeMap JSON' };
    const map = validateNativeMapJson(parsed);
    const session = createNativeMapSession({ map, players: [{ id: 0, team: 1 }], seed: 1, mode });
    try {
      for (let i = 0; i < ticks; i++) session.step();
      return { ok: true, ticks, error: null };
    } finally {
      session.dispose();
    }
  } catch (error) {
    return { ok: false, ticks: 0, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

function humanSummary(summary: ExtractionSummary): string {
  const lines = [
    `Extracted: ${summary.mapName} by ${summary.author}`,
    `  Format:  ${summary.format}`,
    `  Output:  ${summary.output}`,
    `  Version: v${summary.version} (dbv ${summary.dbv}, dbid ${summary.dbid})`,
    `  Mode:    ${summary.mode}`,
    `  Physics: ppm=${summary.ppm} shapes=${summary.shapes} fixtures=${summary.fixtures} bodies=${summary.bodies} joints=${summary.joints}`,
    `  Spawns:  ${summary.spawns}  Cap zones: ${summary.capZones}`,
  ];
  if (summary.verified) {
    lines.push(`  Verify:  OK - loaded via createNativeMapSession and stepped ${summary.verifyTicks} ticks`);
  } else if (summary.verifyError) {
    lines.push(`  Verify:  FAILED - ${summary.verifyError}`);
  }
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const { map, format } = decodeInput(options.input);
  const output = options.output ?? defaultOutputPath(map);
  const resolvedOutput = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
  const directory = path.dirname(resolvedOutput);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  let verify: VerificationResult | null = null;
  if (options.verify) verify = verifyOutput(resolvedOutput, options.mode, options.ticks);
  const summary = buildSummary(map, format, output, verify);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(`${humanSummary(summary)}\n`);
  }
  if (verify && !verify.ok) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof ExtractBonkMapError) {
      process.stderr.write(`extract-bonk-map: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
