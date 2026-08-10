import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { renderEnvFrameSvg } from '../../src/render/render-wiring';
import { safeDestroy } from '../utils/test-helpers';

describe('render-wiring (M5) env-path cap zones', () => {
  let env: BonkEnvironment | null = null;
  afterEach(() => {
    if (env) { env.close(); env = null; }
  });

  it('renders cap-zone outlines through the env load path', () => {
    // WeiRd ships cap zones on fixtureIndex 2/3 (the instant_red/blue walls).
    // The env normalizes mapData to MapDef (cap zones keyed by body name), so
    // this exercises geometryFromMapDefBody's name->index resolution.
    env = new BonkEnvironment({ mapPath: 'maps/bonk_WeiRd_DeAth_BalL__80622.json', numOpponents: 0, randomOpponent: false });
    const svg = renderEnvFrameSvg(env, { width: 730, height: 500 });
    // Cap-zone fixtures render as outlines (image is interior-empty). The
    // rasterizer emits them as polygon/circle with an explicit fill that is
    // transparent; assert we produced geometry and the title precedes content.
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<polygon');
    expect(svg.indexOf('<title>')).toBeLessThan(svg.indexOf('<defs>'));
    // Strike the previous structural guarantee: a finite, non-empty frame.
    expect(svg.length).toBeGreaterThan(200);
  });
});