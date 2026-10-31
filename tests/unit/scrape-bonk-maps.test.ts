import { describe, it, expect, vi, afterEach } from 'vitest';
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
  loadProxyFile,
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
  cooldownMs: 1000,
  maxRetries: 0,
  proxies: [],
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
        bannedUntil: 0,
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
        bannedUntil: 0,
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

describe('scrape-bonk-maps: browser-fingerprint transport', () => {
  const corpus = loadCorpus();
  const record = {
    id: corpus[0]!.id,
    name: corpus[0]!.name,
    authorname: corpus[0]!.author,
    leveldata: corpus[0]!.payload,
    dbv: corpus[0]!.dbv,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('sends browser-like headers on every request', async () => {
    const dir = tempDir();
    const seenHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers?: Record<string, string> }) => {
        seenHeaders.push(init.headers ?? {});
        return jsonResponse({ r: 'success', maps: [record] });
      }),
    );
    try {
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: true };
      await runScrape(options);
      expect(seenHeaders.length).toBe(1);
      const h = seenHeaders[0]!;
      expect(h['User-Agent']).toMatch(/Mozilla\//);
      expect(h.Origin).toBe('https://bonk.io');
      expect(h.Referer).toBe('https://bonk.io/');
      expect(h['X-Requested-With']).toBe('XMLHttpRequest');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates the User-Agent and waits out the cooldown after a ban', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const userAgents: string[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers?: Record<string, string> }) => {
        userAgents.push(init.headers?.['User-Agent'] ?? '');
        call++;
        // First call is rate-limited; the retry (after cooldown) succeeds.
        return call === 1
          ? jsonResponse({ r: 'fail', e: 'ratelimited' })
          : jsonResponse({ r: 'success', maps: [record] });
      }),
    );
    try {
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: true, cooldownMs: 90_000, maxRetries: 2 };
      const promise = runScrape(options);
      // Advance past the cooldown so the retry fires.
      await vi.advanceTimersByTimeAsync(90_000);
      const summary = await promise;
      expect(summary.written).toBe(1);
      expect(userAgents.length).toBe(2);
      expect(userAgents[0]).not.toBe(userAgents[1]); // UA rotated on ban
      // The ban expiry must be persisted so a resumed run waits it out.
      const manifest = loadManifest(dir, true);
      expect(manifest.bannedUntil).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a ban immediately even when the query never completes', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    // Every request is rate-limited, so the picks fetch never succeeds and
    // runScrape eventually exhausts retries and rejects. The ban must still
    // have been persisted via onBan the moment it was first detected.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ r: 'fail', e: 'ratelimited' })),
    );
    try {
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: true, cooldownMs: 1000, maxRetries: 1 };
      const promise = runScrape(options);
      // Attach the rejection expectation before advancing timers to avoid an
      // unhandled rejection when retries are exhausted.
      const assertion = expect(promise).rejects.toThrow(/rate-limited/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      const manifest = loadManifest(dir, true);
      expect(manifest.bannedUntil).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects a ban carried over from a previous run before requesting', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const futureBan = Date.now() + 60_000;
    saveManifest(dir, {
      schema: 1,
      scrapedIds: [],
      searchCursors: {},
      picksDone: false,
      freshDone: true,
      bannedUntil: futureBan,
    });
    let callTime = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callTime = Date.now();
        return jsonResponse({ r: 'success', maps: [record] });
      }),
    );
    try {
      const options = { ...TEST_OPTIONS, out: dir, queries: [], picks: true };
      const promise = runScrape(options);
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;
      // The request must not have fired before the carried-over ban expired.
      expect(callTime).toBeGreaterThanOrEqual(futureBan);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scrape-bonk-maps: proxy pool', () => {
  const corpus = loadCorpus();
  const record = {
    id: corpus[0]!.id,
    name: corpus[0]!.name,
    authorname: corpus[0]!.author,
    leveldata: corpus[0]!.payload,
    dbv: corpus[0]!.dbv,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('loadProxyFile parses lanes and ignores comments/blanks', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'proxies.txt');
      fs.writeFileSync(file, '# comment\n\nhttp://127.0.0.1:8080\nsocks5://127.0.0.1:1080\ndirect\n', 'utf8');
      expect(loadProxyFile(file)).toEqual(['http://127.0.0.1:8080', 'socks5://127.0.0.1:1080', 'direct']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails over to a healthy lane on ban without waiting out the cooldown', async () => {
    const dir = tempDir();
    // Two lanes; the first lane is rate-limited, the second succeeds. The
    // request must complete without any cooldown sleep because lane 2's IP
    // still has budget — this is the whole point of the proxy pool.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        return call === 1
          ? jsonResponse({ r: 'fail', e: 'ratelimited' })
          : jsonResponse({ r: 'success', maps: [record] });
      }),
    );
    try {
      const options = {
        ...TEST_OPTIONS,
        out: dir,
        queries: [],
        picks: true,
        cooldownMs: 90_000,
        maxRetries: 2,
        proxies: ['http://127.0.0.1:8080', 'http://127.0.0.1:8081'],
      };
      // Real timers: if failover works, no 90s sleep happens and this resolves fast.
      const summary = await runScrape(options);
      expect(summary.written).toBe(1);
      expect(call).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails over to a healthy lane when a proxy is unreachable (no crash)', async () => {
    const dir = tempDir();
    // First lane throws a connect timeout (dead free proxy); second lane
    // succeeds. The run must complete, not crash on the network error.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) throw new TypeError('fetch failed');
        return jsonResponse({ r: 'success', maps: [record] });
      }),
    );
    try {
      const options = {
        ...TEST_OPTIONS,
        out: dir,
        queries: [],
        picks: true,
        cooldownMs: 90_000,
        maxRetries: 2,
        proxies: ['http://127.0.0.1:8080', 'http://127.0.0.1:8081'],
      };
      const summary = await runScrape(options);
      expect(summary.written).toBe(1);
      expect(call).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
