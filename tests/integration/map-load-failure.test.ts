import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';

describe('native map loading failures', () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it('rejects a missing explicit map instead of substituting an arena', () => {
    const mapPath = join(process.cwd(), 'maps', 'definitely-missing-native-map.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => new BonkEnvironment({ mapPath, numOpponents: 0 })).toThrow(`Failed to load Bonk map "${mapPath}"`);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('fallback box'));
  });

  it('rejects malformed JSON with its path and original cause', () => {
    directory = mkdtempSync(join(tmpdir(), 'bonk-invalid-map-'));
    const mapPath = join(directory, 'corrupt.json');
    writeFileSync(mapPath, '{ definitely not JSON', 'utf8');

    expect(() => new BonkEnvironment({ mapPath, numOpponents: 0 })).toThrow(
      /Failed to load Bonk map .*corrupt\.json.*(?:Unexpected|Expected property name)/s,
    );
  });

  it('propagates map-contract rejection rather than silently omitting mechanics', () => {
    const mapData = {
      v: 15,
      s: { re: false, nc: false, pq: 1, gd: 2, fl: false },
      physics: { ppm: 12, shapes: [], fixtures: [], bodies: [], joints: [], bro: [] },
      spawns: [],
      capZones: [],
      m: { n: 'unsupported', a: 'test' },
      physicsBodies: [{ unsupportedNativeMechanic: true }],
    };

    expect(() => new BonkEnvironment({ mapData: mapData as any, numOpponents: 0 })).toThrow();
  });
});
