import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';

// A real bundled map, used as the end-to-end map-path fixture. The default
// config map (bonk_WDB__No_Mapshake__716916.json) is absent from maps/, so a
// path surface that reaches the loader must load this file instead of falling
// back to the Default_Box map (#199).
const SIMPLE_1V1 = path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json');

describe('Environment map-path wiring (#199)', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = null;
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
});