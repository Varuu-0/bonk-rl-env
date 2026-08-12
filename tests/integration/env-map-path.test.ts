import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

// A real bundled map, used as the end-to-end map-path fixture.
const SIMPLE_1V1 = path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json');
const DEFAULT_WDB = path.join(process.cwd(), 'maps', 'bonk_WDB__No_Mapshake__716916.json');

describe('Environment map-path wiring (#199)', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = null;
    }
  });

  it('loads the shipped WDB map for a default-config environment (#315)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      env = new BonkEnvironment({ numOpponents: 0, seed: 1 });

      expect((env as any).config.mapPath).toBe(DEFAULT_WDB);
      expect((env as any).config.mapData.name).toBe('WDB (No Mapshake)');
      expect((env as any).physics.getBodyMap().size).toBeGreaterThan(1);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('using fallback box'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('loads the file referenced by defaultMapPath (--map / DEFAULT_MAP_PATH surface)', () => {
    env = new BonkEnvironment({ defaultMapPath: SIMPLE_1V1, numOpponents: 0 });

    // Simple 1v1 has exactly 1 map body (Default_Box has 3), so the body
    // count proves the file was actually loaded rather than box-fallback.
    expect((env as any).physics.getBodyMap().size).toBe(1);
    expect((env as any).config.mapData.name).toBe('Simple 1v1');
    expect((env as any).config.mapPath).toBe(SIMPLE_1V1);
  });

  it('loads the file referenced by mapPath (programmatic per-env override)', () => {
    env = new BonkEnvironment({ mapPath: SIMPLE_1V1, numOpponents: 0 });

    expect((env as any).physics.getBodyMap().size).toBe(1);
    expect((env as any).config.mapData.name).toBe('Simple 1v1');
  });

  it('loads a repo-relative map path independently of the process cwd', () => {
    const original = process.cwd();
    try {
      process.chdir(os.tmpdir());
      env = new BonkEnvironment({ mapPath: 'maps/bonk_Simple_1v1_123.json', numOpponents: 0 });
    } finally {
      process.chdir(original);
    }

    expect((env as any).config.mapPath).toBe(
      path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json'),
    );
    expect((env as any).physics.getBodyMap().size).toBe(1);
    expect((env as any).config.mapData.name).toBe('Simple 1v1');
  });

  it('loads a repo-relative defaultMapPath (--map / DEFAULT_MAP_PATH surface)', () => {
    env = new BonkEnvironment({ defaultMapPath: 'maps/bonk_Simple_1v1_123.json', numOpponents: 0 });

    expect((env as any).physics.getBodyMap().size).toBe(1);
    expect((env as any).config.mapData.name).toBe('Simple 1v1');
  });
});
