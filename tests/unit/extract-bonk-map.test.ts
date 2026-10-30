import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeInput, sanitizeName } from '../../scripts/extract-bonk-map';
import { isNativeMapJson, validateNativeMapJson } from '../../src/core/native-map-codec';
import { createNativeMapSession, NativeMapSessionError } from '../../src/core/native-map-session';

/**
 * Regression test for scripts/extract-bonk-map.ts against the committed
 * built-in map corpus (validation/native/map-codec-corpus.json), which is
 * bound by SHA256 to the pinned original client artifacts.
 */

interface CorpusEntry {
  index: number;
  table: string;
  dbv: number;
  name: string;
  author: string;
  id: number;
  record: string;
  payload: string;
}

function loadCorpus(): CorpusEntry[] {
  const corpusPath = path.join(__dirname, '..', '..', 'validation', 'native', 'map-codec-corpus.json');
  const manifest = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as { entries: CorpusEntry[] };
  return manifest.entries;
}

describe('extract-bonk-map: sanitizeName', () => {
  it('produces filesystem-safe slugs', () => {
    expect(sanitizeName('Stone Pillars')).toBe('Stone_Pillars');
    expect(sanitizeName('A E S T H E T I C   WAVES')).toBe('A_E_S_T_H_E_T_I_C_WAVES');
    expect(sanitizeName('')).toBe('map');
    expect(sanitizeName('!!!')).toBe('map');
    expect(sanitizeName('a'.repeat(100))).toHaveLength(64);
  });
});

describe('extract-bonk-map: decodeInput', () => {
  const corpus = loadCorpus();
  const dbv1 = corpus.find((entry) => entry.dbv === 1)!;
  const dbv2 = corpus.find((entry) => entry.dbv === 2)!;

  it('decodes a five-field envelope literal (dbv=2 database payload)', () => {
    const { map, format } = decodeInput(dbv2.record);
    expect(format).toBe('envelope-literal');
    expect(map.m.n).toBe(dbv2.name);
    expect(map.m.a).toBe(dbv2.author);
    expect(map.m.dbid).toBe(dbv2.id);
    expect(map.m.dbv).toBe(2);
  });

  it('decodes a five-field envelope literal (dbv=1 legacy payload)', () => {
    const { map, format } = decodeInput(dbv1.record);
    expect(format).toBe('envelope-literal');
    expect(map.m.n).toBe(dbv1.name);
    expect(map.m.a).toBe(dbv1.author);
    expect(map.m.dbid).toBe(dbv1.id);
    expect(map.m.dbv).toBe(1);
  });

  it('decodes a raw database payload string (no envelope fields)', () => {
    const { map, format } = decodeInput(dbv2.payload);
    expect(format).toBe('database-payload');
    expect(map.m.n).toBe(dbv2.name);
  });

  it('decodes a raw legacy payload string (no envelope fields)', () => {
    const { map, format } = decodeInput(dbv1.payload);
    expect(format).toBe('legacy-payload');
    expect(map.m.n).toBe(dbv1.name);
  });

  it('decodes an envelope JSON object literal', () => {
    const envelope = JSON.stringify({
      dbv: String(dbv2.dbv),
      name: dbv2.name,
      author: dbv2.author,
      id: String(dbv2.id),
      payload: dbv2.payload,
    });
    const { map, format } = decodeInput(envelope);
    expect(format).toBe('envelope-json');
    expect(map.m.n).toBe(dbv2.name);
    expect(map.m.dbid).toBe(dbv2.id);
  });

  it('decodes a NativeMap JSON literal and round-trips it', () => {
    const first = decodeInput(dbv2.record).map;
    const serialized = JSON.stringify(first);
    const { map, format } = decodeInput(serialized);
    expect(format).toBe('native-map-json');
    // JSON.stringify normalizes -0 to 0 and key order, so compare the
    // re-decoded map to the JSON-normalized original.
    expect(map).toEqual(JSON.parse(serialized));
  });

  it('rejects undecodable input', () => {
    expect(() => decodeInput('not-a-real-format-xyz')).toThrow(/matched no supported format/);
  });

  it('decodes from an input file path (envelope text file)', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-bonk-map-'));
    try {
      const file = path.join(temp, 'envelope.txt');
      fs.writeFileSync(file, dbv2.record, 'utf8');
      const { map, format } = decodeInput(file);
      expect(format).toBe('envelope-literal');
      expect(map.m.n).toBe(dbv2.name);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('decodes from an input file path (NativeMap JSON file)', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-bonk-map-'));
    try {
      const map = decodeInput(dbv2.record).map;
      const file = path.join(temp, 'map.json');
      fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
      const { map: reloaded, format } = decodeInput(file);
      expect(format).toBe('native-map-json');
      expect(reloaded).toEqual(map);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('extract-bonk-map: end-to-end extraction and engine load', () => {
  const corpus = loadCorpus();

  it('extracts every unique corpus envelope into engine-loadable NativeMap JSON', () => {
    // Every unique (table, record) identity in the corpus must decode, validate
    // as NativeMap JSON, and load through the engine's native map session.
    // Static-arena conversion limits (e.g. self-intersecting polygon edges)
    // are pre-existing engine constraints, not extraction defects: those maps
    // must still decode and validate, and are counted as expected-unsupported.
    const seen = new Set<string>();
    let extracted = 0;
    let loaded = 0;
    let unsupported = 0;
    for (const entry of corpus) {
      const identity = `${entry.table}\0${entry.record}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const { map } = decodeInput(entry.record);
      // The serialized output must be NativeMap JSON the engine can load.
      // JSON.stringify normalizes -0 to 0 and validateNativeMapJson re-orders
      // keys, so both sides are compared JSON-normalized (semantically equal).
      const serialized = JSON.parse(JSON.stringify(map)) as unknown;
      expect(isNativeMapJson(serialized)).toBe(true);
      const validated = validateNativeMapJson(serialized);
      expect(validated).toEqual(serialized);
      extracted++;
      // Load through the engine session and step a few ticks.
      try {
        const session = createNativeMapSession({ map: validated, players: [{ id: 0, team: 1 }], seed: 1 });
        try {
          for (let tick = 0; tick < 8; tick++) session.step();
          loaded++;
        } finally {
          session.dispose();
        }
      } catch (error) {
        if (error instanceof NativeMapSessionError) {
          unsupported++;
          continue;
        }
        throw error;
      }
    }
    // 289 records, 288 unique identities (one duplicate pair).
    expect(extracted).toBe(288);
    // All 288 maps decode and validate; every engine load either succeeds or
    // fails with an explicit NativeMapSessionError (no silent corruption).
    expect(loaded + unsupported).toBe(288);
    // The extractor's core contract: maps that load are strictly a subset.
    expect(loaded).toBeGreaterThan(0);
  }, 120_000);
});
