import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildGeometry, geometryFromExport, geometryFromMapDefBody, MapGeometryInput } from '../../src/render/map-geometry';
import { computeCamera } from '../../src/render/render-math';
import { renderFrameSvg } from '../../src/render/svg-rasterizer';
import { normalizeMap } from '../../src/core/map-adapter';

const MAPS = path.join(process.cwd(), 'maps');
const load = (f: string): any => JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8'));

describe('map-geometry (M2)', () => {
  const cam = computeCamera(730, 500, 12);

  it('maps a simple box body to a polygon command in screen px', () => {
    const map = load('bonk_Simple_1v1_123.json');
    const input = geometryFromExport(map);
    const cmds = buildGeometry(input, cam);
    // Simple 1v1: one body, one fixture, one rect.
    expect(cmds.length).toBe(1);
    const c = cmds[0];
    expect(c.primitive.kind).toBe('poly');
    expect(c.isCapZone).toBe(false);
    // The single platform at body.position (0,0), 260x20.
    const poly = c.primitive as { points: number[][] };
    const xs = poly.points.map(p => p[0]);
    const ys = poly.points.map(p => p[1]);
    // Camera centers origin at 365,250; scale 0.4. Half-width 130 -> 52 px.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(104);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(8);
  });

  it('respects bodyRenderOrder z-ordering', () => {
    const map = load('bonk_WDB__no_nothing__1232248.json');
    const input = geometryFromExport(map);
    const noBro = buildGeometry(input, cam);
    const withBro = buildGeometry({ ...input, bodyRenderOrder: map.bodyRenderOrder }, cam);
    expect(withBro.length).toBe(noBro.length);
    // z is monotonic by draw position.
    const zs = withBro.map(c => c.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
  });

  it('maps every fixture of the WDB map, including cap-zone outlines', () => {
    const map = load('bonk_WDB__no_nothing__1232248.json');
    const capZones = (map.capZones || []).map((c: any) => ({ index: c.index, fixtureIndex: c.fixtureIndex }));
    const input = geometryFromExport(map, capZones);
    const cmds = buildGeometry(input, cam);
    expect(cmds.length).toBeGreaterThan(0);
    const hasCap = cmds.some(c => c.isCapZone);
    expect(hasCap).toBe(true);
    const hasCircle = cmds.some(c => c.primitive.kind === 'circle');
    expect(hasCircle).toBe(true);
  });

  it('renders exporter polygon vertices to finite points', () => {
    const map = load('bonk_Gang_Grounds_2_0_37368.json');
    const input = geometryFromExport(map);
    const cmds = buildGeometry(input, cam);
    const polys = cmds.filter(c => c.primitive.kind === 'poly');
    expect(polys.length).toBeGreaterThan(0);
    // Every rendered polygon point must be finite (regression: exporter
    // {x,y} vertices were read as v[0]/v[1] => NaN points).
    for (const c of polys) {
      for (const [x, y] of (c.primitive as { points: number[][] }).points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('marks noPhysics fixtures as sensors without fading artwork', () => {
    const map = load('bonk_WeiRd_DeAth_BalL__80622.json');
    const input = geometryFromExport(map);
    const cmds = buildGeometry(input, cam);
    const sensors = cmds.filter(c => c.isSensor);
    expect(sensors.length).toBeGreaterThan(0);
  });

  it('preserves raw WDB geometry through normalized render metadata', () => {
    const map = load('bonk_WDB__No_Mapshake__716916.json');
    const rawCommands = buildGeometry(geometryFromExport(map), cam);
    const normalizedCommands = buildGeometry(geometryFromMapDefBody(normalizeMap(map)), cam);

    // The Signature body combines polygon-local transforms with overlapping
    // fixtures. Rendered SVG equality covers coordinates and paint order while
    // allowing normalized fixtures to retain their own z metadata.
    expect(renderFrameSvg(normalizedCommands, [], { width: 730, height: 500 }))
      .toEqual(renderFrameSvg(rawCommands, [], { width: 730, height: 500 }));
  });

  it('can tint lethal fixtures with a red stroke', () => {
    // Use a synthetic lethal fixture to assert the stroke path without relying
    // on a specific bundled map.
    const input: MapGeometryInput = {
      bodies: [{ index: 0, x: 0, y: 0, angle: 0, fixtureIndices: [0] }],
      fixtures: [{ index: 0, shapeIndex: 0, color: 0x123456, death: true }],
      shapes: [{ type: 'bx', cx: 0, cy: 0, angle: 0, width: 100, height: 20 }],
      bodyRenderOrder: [0],
    };
    const cmds = buildGeometry(input, cam);
    expect(cmds[0].primitive.stroke).toBe('#ff0000');
  });
});
