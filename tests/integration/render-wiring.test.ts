import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { renderEnvFrameSvg, envMapRender } from '../../src/render/render-wiring';
import { safeDestroy } from '../utils/test-helpers';

describe('render-wiring (M5) env-path cap zones', () => {
  let env: BonkEnvironment | null = null;
  afterEach(() => {
    if (env) { env.close(); env = null; }
  });

  it('resolves cap zones through the env load path', () => {
    // WeiRd ships cap zones on fixtureIndex 2/3 (the instant_red/blue walls).
    // The env normalizes mapData to MapDef (cap zones keyed by body name), so
    // this exercises geometryFromMapDefBody's name->index resolution.
    env = new BonkEnvironment({ mapPath: 'maps/bonk_WeiRd_DeAth_BalL__80622.json', numOpponents: 0, randomOpponent: false });
    const { geometry } = envMapRender(env);
    // Cap zones must actually reach the geometry input (non-empty capZones with
    // numeric fixtureIndex that match a body). A regression dropping them would
    // give an empty list here regardless of how many <polygon> go to SVG.
    const capZones = geometry.capZones ?? [];
    const fixtures = geometry.fixtures ?? [];
    expect(capZones.length).toBeGreaterThan(0);
    for (const cz of capZones) {
      expect(typeof cz.fixtureIndex).toBe('number');
      // The resolved index must point at a real fixture/body slot.
      expect(cz.fixtureIndex).toBeGreaterThanOrEqual(0);
      expect(cz.fixtureIndex).toBeLessThan(fixtures.length);
    }
  });

  it('renders a finite env frame and orders <title> before <defs>', () => {
    env = new BonkEnvironment({ mapPath: 'maps/bonk_Simple_1v1_123.json', numOpponents: 0, randomOpponent: false });
    const svg = renderEnvFrameSvg(env, { width: 730, height: 500 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<polygon');
    expect(svg.indexOf('<title>')).toBeLessThan(svg.indexOf('<defs>'));
    expect(svg.length).toBeGreaterThan(200);
    expect(svg).not.toMatch(/NaN/);
  });
});