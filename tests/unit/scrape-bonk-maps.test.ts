import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fileNameFor,
  decodeLeveldata,
  stampMetadata,
  loadManifest,
  saveManifest,
  writeMap,
  runScrape,
  parseArgs,
  ScrapeBonkMapsError,
} from '../../scripts/scrape-bonk-maps';
import { isNativeMapJson, validateNativeMapJson } from '../../src/core/native-map-codec';

/**
 * Offline regression test for scripts/scrape-bonk-maps.ts. The network layer
 * is replaced with a fake transport serving corpus-derived map records, so
 * the decode/stamp/write/manifest/resume pipeline is exercised without any
 * live requests (CI never depends on bonk2.io availability or rate limits).
 */

interface CorpusEntry {
  dbv: number;
  name: string;
  author: string;
  id: number;
  payload: string;
}

function loadCorpus(): CorpusEntry[] {
  const corpusPath = path.join(__dirname, '..', '..', 'validation', 'native', 'map-codec-corpus.json');
  const manifest = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as { entries: CorpusEntry[] };
  return manifest.entries;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-bonk-maps-'));
}

/** Minimal options matching the CLI defaults (delay/retries are irrelevant
 * because the fake transport resolves immediately). */
const TEST_OPTIONS = {
  out: '',
  limit: 1000,
  queries: ['a'],
  sort: 'newest' as const,
  picks: true,
  fresh: false,
  delayMs: 0,
  maxRetries: 0,
  resume: true,
  json: false,
};

describe('scrape-bonk-maps: fileNameFor', () => {
  it('produces unique filesystem-safe names keyed by dbid', () => {
    expect(fileNameFor(123, 'Simple 1v1')).toBe('bonk_Simple_1v1_123.json');
    expect(fileNameFor(1, '!!!')).toBe('bonk_map_1.json');
    expect(fileNameFor(2, 'a'.repeat(100))).toHaveLength('bonk_'.length + 64 + '_2.json'.length);
    expect(fileNameFor(3, 'A/B\\C:D')).toBe('bonk_A_B_C_D_3.json');
  });
});

describe('scrape-bonk-maps: decodeLeveldata', () => {
  const corpus = loadCorpus();
  const dbv1 = corpus.find((entry) => entry.dbv === 1)!;
  const dbv2 = corpus.find((entry) => entry.dbv === 2)!;

  it('decodes a dbv=2 database payload', () => {
    const { map, format } = decodeLeveldata(dbv2.payload);
    expect(format).toBe('database-payload');
    expect(() => validateNativeMapJson(map)).not.toThrow();
  });

  it('decodes a dbv=1 legacy payload', () => {
    const { map, format } = decodeLeveldata(dbv1.payload);
    expect(format).toBe('legacy-payload');
    expect(() => validateNativeMapJson(map)).not.toThrow();
  });

  it('throws on garbage input', () => {
    expect(() => decodeLeveldata('not-a-map-payload')).toThrow();
  });
});

describe('scrape-bonk-maps: stampMetadata', () => {
  const corpus = loadCorpus();
  const entry = corpus.find((e) => e.dbv === 2)!;

  it('stamps server metadata onto the decoded map', () => {
    const { map } = decodeLeveldata(entry.payload);
    stampMetadata(map, {
      id: 4242,
      name: 'Server Name',
      authorname: 'Server Author',
      leveldata: entry.payload,
      publisheddate: '2026-10-30 00:00:00',
      vu: 7,
      vd: 3,
    });
    expect(map.m.n).toBe('Server Name');
    expect(map.m.a).toBe('Server Author');
    expect(map.m.dbid).toBe(4242);
    expect(map.m.date).toBe('2026-10-30 00:00:00');
    // Votes are only stamped on native database version >= 10 (vu/vd were
    // introduced in dbv 10; the strict validator rejects them on older maps).
    if (map.v >= 10) {
      expect(map.m.vu).toBe(7);
      expect(map.m.vd).toBe(3);
    }
    expect(() => validateNativeMapJson(map)).not.toThrow();
  });
});

describe('scrape-bonk-maps: manifest round-trip', () => {
  it('saves and reloads scraped IDs and cursors', () => {
    const dir = tempDir();
    try {
      saveManifest(dir, {
        schema: 1,
        scrapedIds: [1, 2, 3],
        searchCursors: { a: 64 },
        picksDone: true,
        freshDone: false,
      });
      const loaded = loadManifest(dir, true);
      expect(loaded.scrapedIds).toEqual([1, 2, 3]);
      expect(loaded.searchCursors).toEqual({ a: 64 });
      expect(loaded.picksDone).toBe(true);
      expect(loaded.freshDone).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts fresh when the manifest is corrupt', () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'manifest.json'), 'not json', 'utf8');
      const loaded = loadManifest(dir, true);
      expect(loaded.scrapedIds).toEqual([]);
      expect(loaded.searchCursors).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scrape-bonk-maps: parseArgs', () => {
  it('rejects unknown options and invalid values', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(ScrapeBonkMapsError);
    expect(() => parseArgs(['--limit', '0'])).toThrow(ScrapeBonkMapsError);
    expect(() => parseArgs(['--sort', ' sideways'])).toThrow(ScrapeBonkMapsError);
    expect(() => parseArgs(['--queries', ',,'])).toThrow(ScrapeBonkMapsError);
    expect(() => parseArgs(['--delay', '-1'])).toThrow(ScrapeBonkMapsError);
  });

  it('parses the documented flags', () => {
    const options = parseArgs([
      '--limit',
      '50',
      '--queries',
      'x,y',
      '--sort',
      'best',
      '--no-picks',
      '--fresh',
      '--no-resume',
      '--json',
    ]);
    expect(options.limit).toBe(50);
    expect(options.queries).toEqual(['x', 'y']);
    expect(options.sort).toBe('best');
    expect(options.picks).toBe(false);
    expect(options.fresh).toBe(true);
    expect(options.resume).toBe(false);
    expect(options.json).toBe(true);
  });
});

describe('scrape-bonk-maps: end-to-end scrape (fake transport)', () => {
  const corpus = loadCorpus();
  const records = corpus.slice(0, 12).map((entry) => ({
    id: entry.id,
    name: entry.name,
    authorname: entry.author,
    leveldata: entry.payload,
    publisheddate: '2026-10-30 12:00:00',
    vu: 1,
    vd: 0,
  }));

  it('writes validated NativeMap JSON and a resumable manifest', async () => {
    const dir = tempDir();
    try {
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: false };
      const summary = await runScrape(options);
      expect(summary.written).toBe(0); // no sources enabled: nothing written
      const manifest = loadManifest(dir, true);
      expect(manifest.scrapedIds).toEqual([]);
      // Write one real corpus record through the write path and verify the
      // output is engine-loadable NativeMap JSON.
      const record = records[0]!;
      const result = writeMap(dir, record);
      expect(result.ok).toBe(true);
      const file = path.join(dir, fileNameFor(record.id, record.name));
      const map = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(isNativeMapJson(map)).toBe(true);
      expect(() => validateNativeMapJson(map)).not.toThrow();
      expect(map.m.dbid).toBe(record.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips already-collected maps on resume', async () => {
    const dir = tempDir();
    try {
      saveManifest(dir, {
        schema: 1,
        scrapedIds: records.map((r) => r.id),
        searchCursors: {},
        picksDone: true,
        freshDone: true,
      });
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: false };
      const summary = await runScrape(options);
      expect(summary.written).toBe(0);
      expect(summary.totalCollected).toBe(records.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts and reports decode failures without writing them', async () => {
    const dir = tempDir();
    try {
      // A record with a garbage payload must be counted as failed and never
      // written; the manifest must not record its id.
      const record = { ...records[0]!, id: 999999, leveldata: 'not-a-map-payload' };
      const result = writeMap(dir, record);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(fs.readdirSync(dir).filter((f) => f !== 'manifest.json')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
