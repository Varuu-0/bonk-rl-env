import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validateNativeMapJson } from '../../src/core/native-map-codec';
import { buildGeometry } from '../../src/render/map-geometry';
import {
  detectNativeStateKind,
  fitNativeCamera,
  loadNativeMapForRender,
  nativeGeometryBounds,
  nativeMapRenderData,
  nativePointToScreen,
} from '../../src/render/native-map-geometry';
import { renderNativeMapSvg } from '../../src/render/native-map-preview';

const FIXTURE = path.join(process.cwd(), 'maps/native-render-fixture.json');
const REAL = path.join(process.cwd(), 'maps/training-platform.json');

describe('native map rendering', () => {
  const data = loadNativeMapForRender(FIXTURE);

  it('loads circles, boxes and polygons through the strict native path', () => {
    expect(data.physics.ppm).toBe(10);
    expect(data.input.shapes?.map((shape) => shape.type)).toEqual(['bx', 'ci', 'po', 'bx']);
    const commands = buildGeometry(data.input, { scale: 1, offsetX: 0, offsetY: 0 });
    expect(commands.some((command) => command.primitive.kind === 'circle')).toBe(true);
    expect(commands.filter((command) => command.primitive.kind === 'poly')).toHaveLength(4);
  });

  it('preserves compound fixtures, body rotation and shape-local transforms', () => {
    const body = data.input.bodies?.find((candidate) => candidate.index === 1);
    expect(body?.fixtureIndices).toEqual([1, 3]);
    expect(body?.angle).toBe(0.3);
    expect(data.input.shapes?.[1].cx).toBe(50);
    expect(data.input.shapes?.[1].cy).toBe(-50);
    expect(data.input.shapes?.[3].angle).toBe(0.35);
    // Authored body p (-120,-20) remains authored pixels, not world metres.
    expect(body?.x).toBe(-120);
    expect(body?.y).toBe(-20);
  });

  it('styles dynamic and kinematic bodies distinctly', () => {
    expect(data.bodyTypes).toEqual(['static', 'dynamic', 'kinematic', 'static']);
    const svg = renderNativeMapSvg(data);
    expect(svg).toContain('stroke="#4a90d9" stroke-width=');
    expect(svg).toContain('stroke="#b47ad6" stroke-width=');
    expect(svg).toContain('dynamic body');
    expect(svg).toContain('kinematic body');
  });

  it('distinguishes lethal and nonphysical fixtures', () => {
    expect(data.input.fixtures?.[2].death).toBe(true);
    expect(data.input.fixtures?.[3].noPhysics).toBe(true);
    const svg = renderNativeMapSvg(data);
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('fill-opacity="0.4"');
  });

  it('draws team spawns, velocity, capture geometry and whole-map zones', () => {
    expect(data.spawns[0].teams).toEqual(['red']);
    expect(data.spawns[1].teams).toEqual(['blue']);
    expect(data.input.capZones).toEqual([{ index: 0, fixtureIndex: 4 }]);
    expect(data.frameCapZones).toEqual([1]);
    const svg = renderNativeMapSvg(data);
    expect(svg).toContain('id="spawns"');
    expect(svg).toContain('red spawn [red] p5');
    expect(svg).toContain('id="capture-zones"');
    expect(svg).toContain('whole map');
    expect(svg).toContain('2 zones');
  });

  it('retains clockwise polygon winding and authored coordinate conversion', () => {
    const source = validateNativeMapJson(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
    const projected = data.input.shapes?.[2].vertices ?? [];
    const signedArea =
      projected.reduce((area, point, index) => {
        const next = projected[(index + 1) % projected.length];
        return area + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2;
    const sourceArea =
      source.physics.shapes[2]?.type === 'po'
        ? source.physics.shapes[2].v.reduce((area, point, index, vertices) => {
            const next = vertices[(index + 1) % vertices.length];
            return area + point[0] * next[1] - next[0] * point[1];
          }, 0) / 2
        : 0;
    expect(Math.sign(signedArea)).toBe(Math.sign(sourceArea));
    expect(data.input.bodies?.[0].x).toBe(0);
    expect(data.input.bodies?.[0].y).toBe(120);
  });

  it('fits the camera without distortion, clipping or unsafe empty bounds', () => {
    const bounds = nativeGeometryBounds(data);
    const camera = fitNativeCamera(bounds, 1000, 700);
    expect(nativePointToScreen([bounds.minX, bounds.minY], camera)[0]).toBeGreaterThanOrEqual(49.99);
    expect(nativePointToScreen([bounds.maxX, bounds.maxY], camera)[0]).toBeLessThanOrEqual(950.01);
    expect(nativePointToScreen([bounds.minX, bounds.minY], camera)[1]).toBeGreaterThanOrEqual(34.99);
    expect(nativePointToScreen([bounds.maxX, bounds.maxY], camera)[1]).toBeLessThanOrEqual(665.01);
    const unitX = nativePointToScreen([1, 0], camera)[0] - nativePointToScreen([0, 0], camera)[0];
    const unitY = nativePointToScreen([0, 1], camera)[1] - nativePointToScreen([0, 0], camera)[1];
    expect(unitX).toBeCloseTo(unitY);
    const empty = { ...data, input: {}, spawns: [], joints: [] };
    expect(nativeGeometryBounds(empty)).toEqual({ minX: -365, minY: -250, maxX: 365, maxY: 250 });
    expect(Number.isFinite(fitNativeCamera({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 1000, 700).scale)).toBe(true);
  });

  it('rejects malformed or unsupported native maps explicitly', () => {
    const source = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(() => nativeMapRenderData(validateNativeMapJson({ ...source, unexpected: true }))).toThrow(/unknown/i);
    expect(() => nativeMapRenderData(validateNativeMapJson({ ...source, v: 99 }))).toThrow(
      /unsupported native map version/,
    );
    expect(() => loadNativeMapForRender(path.join(process.cwd(), 'maps/bonk_Simple_1v1_123.json'))).toThrow(
      /missing the native map JSON structure/,
    );
  });

  it('renders a real repository native map with accurate metadata', () => {
    const real = loadNativeMapForRender(REAL);
    const svg = renderNativeMapSvg(real, { filename: 'training-platform.json' });
    expect(svg).toContain('native v15');
    expect(svg).toContain('1 bodies, 1 fixtures, 2 spawns, 0 zones, 0 joints');
    expect(svg).toContain('<polygon');
    expect(svg).toContain('Left Spawn [FFA/red/blue] p5');
  });

  it('auto-detects world-metre runtime states without shrinking geometry twice', () => {
    const authored = validateNativeMapJson(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
    expect(detectNativeStateKind(authored)).toBe('authored');
    // Construct a known normalized state: body positions in the positive
    // native world frame and a circle radius already measured in metres.
    const runtime = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    runtime.v = 1;
    runtime.m.vu = 1;
    runtime.m.vd = 1;
    runtime.physics.bodies = runtime.physics.bodies.map((body: any) => ({
      ...body,
      p: [(body.p[0] + 365) / 10, (body.p[1] + 250) / 10],
    }));
    runtime.physics.shapes = runtime.physics.shapes.map((shape: any) => ({
      ...shape,
      ...(shape.w === undefined ? {} : { w: shape.w / 10, h: shape.h / 10 }),
      ...(shape.r === undefined ? {} : { r: shape.r / 10 }),
      c: [shape.c[0] / 10, shape.c[1] / 10],
    }));
    const map = validateNativeMapJson(runtime, { featureGates: 'native-json' });
    // Authored rv joints derive ab during normalization; runtime states carry
    // it explicitly in body B's local frame.
    const joints = map.physics.joints.map((joint) => {
      if (!joint || joint.type !== 'rv') return joint;
      const a = runtime.physics.bodies[joint.ba];
      const b = runtime.physics.bodies[joint.bb];
      const world = [a.p[0] + joint.aa[0], a.p[1] + joint.aa[1]];
      const dx = world[0] - b.p[0],
        dy = world[1] - b.p[1];
      const cos = Math.cos(-b.a),
        sin = Math.sin(-b.a);
      return { ...joint, ab: [dx * cos - dy * sin, dx * sin + dy * cos] };
    });
    map.physics.joints = joints;
    expect(detectNativeStateKind(map)).toBe('normalized');
    const normalized = nativeMapRenderData(map, 'native-json', 'normalized');
    expect(normalized.stateKind).toBe('normalized');
    expect(normalized.input.bodies?.[1].x).toBe(-120);
    expect(normalized.input.bodies?.[1].y).toBe(-20);
    expect(normalized.input.shapes?.[1].radius).toBe(35);
    expect(renderNativeMapSvg(normalized)).toContain('Auto-detected normalized world-metre state');
    // Large authored maps cannot be classified as world-metre states merely
    // because some of their coordinates are small.
    const large = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    large.physics.bodies[0].p = [500, 0];
    expect(detectNativeStateKind(validateNativeMapJson(large))).toBe('authored');
    // The single-body signature is deliberately conservative.
    const single = JSON.parse(fs.readFileSync(REAL, 'utf8'));
    expect(detectNativeStateKind(validateNativeMapJson(single))).toBe('authored');
  });

  it('is deterministic for the same map and options', () => {
    const first = renderNativeMapSvg(data, { filename: 'fixture.json' });
    const second = renderNativeMapSvg(loadNativeMapForRender(FIXTURE), { filename: 'fixture.json' });
    expect(second).toBe(first);
    expect(first.startsWith('<svg')).toBe(true);
    expect(first.endsWith('</svg>')).toBe(true);
    expect(first).toContain('id="legend"');
    expect(first).toContain('id="joints"');
  });
});
