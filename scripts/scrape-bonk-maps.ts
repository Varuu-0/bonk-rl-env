/**
 * Scrape Bonk.io community maps into engine-loadable NativeMap JSON.
 *
 * Uses the same public map-list endpoints the game client itself calls
 * (discovered from the deobfuscated alpha2s.js call sites):
 *
 *   POST https://bonk2.io/scripts/map_getsearch.php
 *        searchsort=newest|best, searchstring=<q>, searchmapname=true|false,
 *        searchauthor=true|false, startingfrom=<offset>
 *        -> { r, maps: [{ id, name, authorname, leveldata, publisheddate,
 *             vu, vd, remixname, remixauthor, remixdb, remixid }], more }
 *        32 maps per page; leveldata is a dbv=2 database payload (or dbv=1
 *        legacy payload, distinguished by decode order, same as the client).
 *
 *   GET  https://bonk2.io/scripts/hotmaps/picks.txt
 *        -> { r, maps: [{ id, name, authorname, leveldata, dbv, ... }] }
 *        ~989 hand-picked maps in one request.
 *
 *   POST https://bonk2.io/scripts/map_getfresh.php  { startingfrom }
 *        -> newest maps (small window, ~219 maps).
 *
 * Each leveldata payload is decoded with the strict native map codec
 * (decodeNativeMapDatabasePayload, falling back to decodeLegacyNativeMapPayload
 * for dbv=1, exactly like the client's fromOldString/decodeFromDatabase split),
 * validated, stamped with server metadata (name/author/dbid/date/votes), and
 * written as NativeMap JSON loadable via `mapPath` / `mapData`.
 *
 * The endpoints rate-limit aggressive callers (observed: a burst of ~30 rapid
 * requests triggers a temporary `{"r":"fail","e":"ratelimited"}` window). The
 * scraper therefore serializes requests, honors a configurable inter-request
 * delay, treats `ratelimited` as retryable with exponential backoff, and is
 * fully resumable: an on-disk manifest records scraped map IDs and page
 * cursors, so re-running skips everything already collected.
 *
 * Usage:
 *   npx tsx scripts/scrape-bonk-maps.ts [options]
 *
 *   --out <dir>         Output directory (default: .local-artifacts/scraped-maps)
 *   --limit <n>         Stop after N new maps (default: 1000)
 *   --queries <a,b,c>   Comma-separated search strings (default: common chars)
 *   --sort newest|best  Search sort order (default: newest)
 *   --picks             Include hotmaps/picks.txt (default: true)
 *   --no-picks          Skip picks.txt
 *   --fresh             Include map_getfresh.php (default: false)
 *   --delay <ms>        Delay between requests (default: 1200)
 *   --max-retries <n>   Retries per request on rate-limit (default: 5)
 *   --resume            Resume from the manifest (default: true)
 *   --no-resume         Start fresh (clears the manifest)
 *   --json              Print the summary as a single JSON object
 *   --help              Show this help
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeNativeMapDatabasePayload,
  decodeLegacyNativeMapPayload,
  validateNativeMapJson,
  NativeMapCodecError,
  type NativeMap,
} from '../src/core/native-map-codec';

// ── Endpoint contracts (mirroring the game client's own calls) ──────────────

const SEARCH_ENDPOINT = 'https://bonk2.io/scripts/map_getsearch.php';
const PICKS_ENDPOINT = 'https://bonk2.io/scripts/hotmaps/picks.txt';
const FRESH_ENDPOINT = 'https://bonk2.io/scripts/map_getfresh.php';

/** Search page size used by the client (`I$w.v * 32`). */
const PAGE_SIZE = 32;
/** The client stops paginating search at 1000 (`startingfrom` > 1000 fails). */
const SEARCH_OFFSET_LIMIT = 1000;
/** Minimum search string length the server accepts (empty is rejected). */
const MIN_QUERY_LENGTH = 1;
/** Default queries: single characters that cover the overwhelming majority of
 * map names (letters/digits). The union across queries is deduplicated. */
const DEFAULT_QUERIES = ['a', 'e', 'i', 'o', 'u', '1', '2', 's', 't', 'n'];
const DEFAULT_SORT = 'newest';

interface SearchMapRecord {
  id: number;
  name: string;
  authorname: string;
  leveldata: string;
  publisheddate?: string;
  vu?: number;
  vd?: number;
}

interface SearchResponse {
  r: string;
  e?: string;
  maps?: SearchMapRecord[];
  more?: boolean;
}

interface PicksMapRecord extends SearchMapRecord {
  dbv?: number;
}

interface PicksResponse {
  r: string;
  maps?: PicksMapRecord[];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliOptions {
  out: string;
  limit: number;
  queries: string[];
  sort: 'newest' | 'best';
  picks: boolean;
  fresh: boolean;
  delayMs: number;
  maxRetries: number;
  resume: boolean;
  json: boolean;
}

const USAGE = `Usage: npx tsx scripts/scrape-bonk-maps.ts [options]

Options:
  --out <dir>         Output directory (default: .local-artifacts/scraped-maps)
  --limit <n>         Stop after N new maps (default: 1000)
  --queries <a,b,c>   Comma-separated search strings (default: common chars)
  --sort newest|best  Search sort order (default: newest)
  --picks             Include hotmaps/picks.txt (default: true)
  --no-picks          Skip picks.txt
  --fresh             Include map_getfresh.php (default: false)
  --delay <ms>        Delay between requests (default: 1200)
  --max-retries <n>   Retries per request on rate-limit (default: 5)
  --resume            Resume from the manifest (default: true)
  --no-resume         Start fresh (clears the manifest)
  --json              Print the summary as a single JSON object
  --help              Show this help`;

/** Fatal usage/input error. main() converts this into exit code 1. */
export class ScrapeBonkMapsError extends Error {
  override readonly name = 'ScrapeBonkMapsError';
}

function fail(message: string): never {
  throw new ScrapeBonkMapsError(message);
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    out: '.local-artifacts/scraped-maps',
    limit: 1000,
    queries: DEFAULT_QUERIES,
    sort: DEFAULT_SORT,
    picks: true,
    fresh: false,
    delayMs: 1200,
    maxRetries: 5,
    resume: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i] ?? fail('--out requires a value');
    } else if (arg === '--limit' || arg === '-l') {
      const raw = argv[++i] ?? fail('--limit requires a value');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
        fail(`--limit must be an integer in [1, 1000000] (got ${raw})`);
      }
      options.limit = parsed;
    } else if (arg === '--queries' || arg === '-q') {
      const raw = argv[++i] ?? fail('--queries requires a value');
      const queries = raw
        .split(',')
        .map((q) => q.trim())
        .filter((q) => q.length >= MIN_QUERY_LENGTH);
      if (queries.length === 0) fail(`--queries must contain at least one non-empty string (got ${raw})`);
      options.queries = queries;
    } else if (arg === '--sort') {
      const sort = argv[++i] ?? fail('--sort requires a value');
      if (sort !== 'newest' && sort !== 'best') fail(`--sort must be newest or best (got ${sort})`);
      options.sort = sort;
    } else if (arg === '--picks') {
      options.picks = true;
    } else if (arg === '--no-picks') {
      options.picks = false;
    } else if (arg === '--fresh') {
      options.fresh = true;
    } else if (arg === '--delay') {
      const raw = argv[++i] ?? fail('--delay requires a value');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 600_000) {
        fail(`--delay must be an integer in [0, 600000] ms (got ${raw})`);
      }
      options.delayMs = parsed;
    } else if (arg === '--max-retries') {
      const raw = argv[++i] ?? fail('--max-retries requires a value');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
        fail(`--max-retries must be an integer in [0, 100] (got ${raw})`);
      }
      options.maxRetries = parsed;
    } else if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--no-resume') {
      options.resume = false;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      fail(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

// ── Rate-limited HTTP layer ─────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POST a form and parse the JSON response, retrying rate-limit responses
 * with exponential backoff. Any non-success `r` other than ratelimited is a
 * hard error (matches the client's "Fetch error" path). */
async function postForm(url: string, form: Record<string, string>, options: CliOptions): Promise<unknown> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) await sleep(options.delayMs * 2 ** attempt);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    if (!response.ok) fail(`HTTP ${response.status} from ${url}`);
    const json = (await response.json()) as { r?: string; e?: string };
    if (json.r === 'ratelimited' || json.e === 'ratelimited') continue; // retry with backoff
    return json;
  }
  return fail(`rate-limited by ${url} after ${options.maxRetries + 1} attempts; increase --delay`);
}

/** GET and parse a JSON response with the same rate-limit retry policy. */
async function getJson(url: string, options: CliOptions): Promise<unknown> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) await sleep(options.delayMs * 2 ** attempt);
    const response = await fetch(url);
    if (!response.ok) fail(`HTTP ${response.status} from ${url}`);
    const json = (await response.json()) as { r?: string; e?: string };
    if (json.r === 'ratelimited' || json.e === 'ratelimited') continue;
    return json;
  }
  return fail(`rate-limited by ${url} after ${options.maxRetries + 1} attempts; increase --delay`);
}

// ── Manifest (resumability) ─────────────────────────────────────────────────

interface Manifest {
  schema: 1;
  scrapedIds: number[];
  /** Per-query search cursors: next `startingfrom` to request. */
  searchCursors: Record<string, number>;
  picksDone: boolean;
  freshDone: boolean;
}

const EMPTY_MANIFEST: Manifest = { schema: 1, scrapedIds: [], searchCursors: {}, picksDone: false, freshDone: false };

function manifestPath(outDir: string): string {
  return path.join(outDir, 'manifest.json');
}

export function loadManifest(outDir: string, resume: boolean): Manifest {
  const file = manifestPath(outDir);
  if (!resume || !fs.existsSync(file)) return { ...EMPTY_MANIFEST, scrapedIds: [], searchCursors: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    if (parsed.schema !== 1) return { ...EMPTY_MANIFEST, scrapedIds: [], searchCursors: {} };
    return {
      schema: 1,
      scrapedIds: Array.isArray(parsed.scrapedIds) ? parsed.scrapedIds : [],
      searchCursors: typeof parsed.searchCursors === 'object' && parsed.searchCursors ? parsed.searchCursors : {},
      picksDone: parsed.picksDone === true,
      freshDone: parsed.freshDone === true,
    };
  } catch {
    return { ...EMPTY_MANIFEST, scrapedIds: [], searchCursors: {} };
  }
}

export function saveManifest(outDir: string, manifest: Manifest): void {
  fs.writeFileSync(manifestPath(outDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ── Decode + write ──────────────────────────────────────────────────────────

/** Sanitize a map name into a filesystem-safe slug (same policy as
 * extract-bonk-map.ts, plus the dbid for uniqueness). */
export function fileNameFor(id: number, name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return `bonk_${slug.length > 0 ? slug : 'map'}_${id}.json`;
}

/** Decode a leveldata payload: dbv=2 database payload first, dbv=1 legacy
 * payload second — the same order the client's map loader uses. */
export function decodeLeveldata(leveldata: string): { map: NativeMap; format: 'database-payload' | 'legacy-payload' } {
  try {
    return { map: decodeNativeMapDatabasePayload(leveldata), format: 'database-payload' };
  } catch {
    return { map: decodeLegacyNativeMapPayload(leveldata), format: 'legacy-payload' };
  }
}

/** Stamp server metadata onto the decoded map, mirroring the client's
 * map-list loader (X6Z/c3d): name, author, dbid, date, votes. Votes are only
 * stamped on native database version >= 10 — the strict validator rejects
 * vu/vd on older maps (they were introduced in dbv 10). */
export function stampMetadata(map: NativeMap, record: SearchMapRecord): NativeMap {
  map.m.n = record.name;
  map.m.a = record.authorname;
  map.m.dbid = record.id;
  if (record.publisheddate) map.m.date = record.publisheddate;
  if (map.v >= 10) {
    if (typeof record.vu === 'number') map.m.vu = record.vu;
    if (typeof record.vd === 'number') map.m.vd = record.vd;
  }
  return map;
}

interface WriteResult {
  ok: boolean;
  error?: string;
}

/** Decode, validate, stamp, and write one map. Returns whether it succeeded. */
export function writeMap(outDir: string, record: SearchMapRecord): WriteResult {
  try {
    const { map } = decodeLeveldata(record.leveldata);
    stampMetadata(map, record);
    validateNativeMapJson(map);
    const file = path.join(outDir, fileNameFor(record.id, record.name));
    fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof NativeMapCodecError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: message };
  }
}

// ── Scraping sources ────────────────────────────────────────────────────────

interface ScrapeStats {
  requested: number;
  written: number;
  skipped: number;
  failed: number;
  failures: string[];
}

function newStats(): ScrapeStats {
  return { requested: 0, written: 0, skipped: 0, failed: 0, failures: [] };
}

/** Scrape picks.txt: one request, ~989 curated maps. */
async function scrapePicks(outDir: string, seen: Set<number>, stats: ScrapeStats, options: CliOptions): Promise<void> {
  const json = (await getJson(PICKS_ENDPOINT, options)) as PicksResponse;
  if (json.r !== 'success' || !Array.isArray(json.maps)) fail(`picks.txt returned r=${json.r}`);
  for (const record of json.maps) {
    stats.requested++;
    if (seen.has(record.id)) {
      stats.skipped++;
      continue;
    }
    const result = writeMap(outDir, record);
    if (result.ok) {
      seen.add(record.id);
      stats.written++;
    } else {
      stats.failed++;
      stats.failures.push(`picks id=${record.id} name=${record.name}: ${result.error}`);
    }
  }
}

/** Scrape map_getfresh.php: newest maps, small window. */
async function scrapeFresh(outDir: string, seen: Set<number>, stats: ScrapeStats, options: CliOptions): Promise<void> {
  let offset = 0;
  for (;;) {
    const json = (await postForm(FRESH_ENDPOINT, { startingfrom: String(offset) }, options)) as SearchResponse;
    if (json.r !== 'success' || !Array.isArray(json.maps)) fail(`map_getfresh returned r=${json.r}`);
    if (json.maps.length === 0) break;
    for (const record of json.maps) {
      stats.requested++;
      if (seen.has(record.id)) {
        stats.skipped++;
        continue;
      }
      const result = writeMap(outDir, record);
      if (result.ok) {
        seen.add(record.id);
        stats.written++;
      } else {
        stats.failed++;
        stats.failures.push(`fresh id=${record.id} name=${record.name}: ${result.error}`);
      }
    }
    if (json.more !== true) break;
    offset += json.maps.length;
    await sleep(options.delayMs);
  }
}

/** Scrape map_getsearch.php for one query, page by page, until the server's
 * 1000-offset ceiling or the map limit is reached. */
async function scrapeSearchQuery(
  query: string,
  outDir: string,
  seen: Set<number>,
  stats: ScrapeStats,
  manifest: Manifest,
  options: CliOptions,
  limitReached: () => boolean,
): Promise<void> {
  let offset = manifest.searchCursors[query] ?? 0;
  while (offset <= SEARCH_OFFSET_LIMIT && !limitReached()) {
    const json = (await postForm(
      SEARCH_ENDPOINT,
      {
        searchsort: options.sort,
        searchstring: query,
        searchmapname: 'true',
        searchauthor: 'false',
        startingfrom: String(offset),
      },
      options,
    )) as SearchResponse;
    if (json.r !== 'success') fail(`map_getsearch returned r=${json.r} for query "${query}"`);
    const maps = json.maps ?? [];
    if (maps.length === 0) break;
    for (const record of maps) {
      stats.requested++;
      if (seen.has(record.id)) {
        stats.skipped++;
        continue;
      }
      if (limitReached()) break;
      const result = writeMap(outDir, record);
      if (result.ok) {
        seen.add(record.id);
        stats.written++;
      } else {
        stats.failed++;
        stats.failures.push(`search q="${query}" id=${record.id} name=${record.name}: ${result.error}`);
      }
    }
    offset += maps.length;
    manifest.searchCursors[query] = offset;
    saveManifest(outDir, manifest);
    if (json.more !== true || offset > SEARCH_OFFSET_LIMIT) break;
    await sleep(options.delayMs);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

export interface ScrapeSummary {
  outDir: string;
  requested: number;
  written: number;
  skipped: number;
  failed: number;
  totalCollected: number;
  failures: string[];
}

export async function runScrape(options: CliOptions): Promise<ScrapeSummary> {
  const outDir = path.isAbsolute(options.out) ? options.out : path.resolve(process.cwd(), options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = loadManifest(outDir, options.resume);
  const seen = new Set(manifest.scrapedIds);
  const stats = newStats();
  const limitReached = (): boolean => stats.written >= options.limit;

  // Picks first: one request covers ~989 curated maps.
  if (options.picks && !manifest.picksDone && !limitReached()) {
    await scrapePicks(outDir, seen, stats, options);
    manifest.picksDone = true;
    manifest.scrapedIds = [...seen];
    saveManifest(outDir, manifest);
  }

  // Fresh window (opt-in): newest maps beyond the search ceiling.
  if (options.fresh && !manifest.freshDone && !limitReached()) {
    await scrapeFresh(outDir, seen, stats, options);
    manifest.freshDone = true;
    manifest.scrapedIds = [...seen];
    saveManifest(outDir, manifest);
  }

  // Search: each query pages through up to 1000 offsets (32 maps per page).
  for (const query of options.queries) {
    if (limitReached()) break;
    await scrapeSearchQuery(query, outDir, seen, stats, manifest, options, limitReached);
    manifest.scrapedIds = [...seen];
    saveManifest(outDir, manifest);
  }

  manifest.scrapedIds = [...seen];
  saveManifest(outDir, manifest);
  return {
    outDir,
    requested: stats.requested,
    written: stats.written,
    skipped: stats.skipped,
    failed: stats.failed,
    totalCollected: seen.size,
    failures: stats.failures.slice(0, 20),
  };
}

function humanSummary(summary: ScrapeSummary): string {
  const lines = [
    `Scraped Bonk.io maps -> ${summary.outDir}`,
    `  Requested: ${summary.requested}`,
    `  Written:   ${summary.written} (new this run)`,
    `  Skipped:   ${summary.skipped} (already collected)`,
    `  Failed:    ${summary.failed}`,
    `  Total:     ${summary.totalCollected} maps in the manifest`,
  ];
  if (summary.failures.length > 0) {
    lines.push(`  Failure details (first ${summary.failures.length}):`);
    for (const failure of summary.failures) lines.push(`    - ${failure}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runScrape(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(`${humanSummary(summary)}\n`);
  }
  if (summary.failed > 0) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof ScrapeBonkMapsError) {
      process.stderr.write(`scrape-bonk-maps: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  });
}
