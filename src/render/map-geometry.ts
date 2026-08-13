/**
 * M2 — Map geometry layer.
 *
 * Turns an exported map (the flat `physicsBodies`/`physicsFixtures`/
 * `physicsShapes`/`capZones`/`bodyRenderOrder` structure the Bonk Map Exporter
 * writes) into a backend-agnostic draw list already in *screen px*. Each item
 * is a primitive command a rasterizer can consume directly (SVG, Canvas 2D,
 * PNG). Native `bodyRenderOrder` (`physics.bro`) is front-to-back, so this
 * module reverses it before emitting back-to-front painter commands. Each shape
 * is transformed by the body's position/angle and the shape's center/angle.
 *
 * No PIXI/canvas dependency: this module only produces plain objects.
 */

import { Camera, mapToScreen } from './render-math';

export type ShapeType = 'bx' | 'ci' | 'po';

export interface ShapeGeom {
  type: ShapeType;
  /** Shape-local center, rotates with the body, in map px. */
  cx: number;
  cy: number;
  /** Shape-local rotation, in radians, applied after the body rotation. */
  angle: number;
  width?: number; // bx
  height?: number; // bx
  radius?: number; // ci
  /** Raw polygon vertices (map px, before scale/angle/center). */
  vertices?: number[][];
  scale?: number; // po
}

export interface MapBodyGeom {
  index: number;
  x: number; // map px (body position)
  y: number;
  angle: number; // body angle, radians
  fixtureIndices: number[];
}

export interface FixtureGeom {
  index: number;
  shapeIndex: number;
  color: number;
  noPhysics?: boolean;
  death?: boolean;
}

export interface CapZoneGeom {
  index: number;
  fixtureIndex: number;
}

export interface MapGeometryInput {
  bodies?: MapBodyGeom[];
  fixtures?: FixtureGeom[];
  shapes?: ShapeGeom[];
  capZones?: CapZoneGeom[];
  /** Native front-to-back body order (`physics.bro`). */
  bodyRenderOrder?: number[];
}

export type Primitive =
  | { kind: 'rect'; sx: number; sy: number; w: number; h: number; angle: number; fill: string; stroke: string | null; lineWidth: number }
  | { kind: 'circle'; sx: number; sy: number; r: number; fill: string; stroke: string | null; lineWidth: number; angle: number }
  | { kind: 'poly'; sx: number; sy: number; points: number[][]; fill: string; stroke: string | null; lineWidth: number };

export interface DrawCommand {
  /** Z-order; commands are drawn low→high (body render order ascending). */
  z: number;
  primitive: Primitive;
  /** True when the fixture is a cap zone (outline, not fill). */
  isCapZone: boolean;
  /** True when the fixture is marked noPhysics in the source map. */
  isSensor: boolean;
}

const hex = (n: number | null | undefined, fallback = '#555555'): string => {
  if (typeof n !== 'number') return fallback;
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
};

/**
 * Expand a polygon's raw vertices into world map-px points: apply shape scale,
 * rotate by shape angle, translate by shape center, then by the body position
 * and body angle. Matches the native pipeline (rotate-by-angle then translate).
 */
function polyWorldPts(shape: ShapeGeom, body: MapBodyGeom): number[][] {
  const s = shape.scale ?? 1;
  const a = shape.angle || 0;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const cosB = Math.cos(body.angle);
  const sinB = Math.sin(body.angle);
  const inCx = shape.cx;
  const inCy = shape.cy;
  return (shape.vertices || []).map((v) => {
    const x0 = v[0] * s;
    const y0 = v[1] * s;
    // rotate within shape
    const rx = x0 * cosA - y0 * sinA;
    const ry = x0 * sinA + y0 * cosA;
    // shape center -> world
    const wx = rx + inCx;
    const wy = ry + inCy;
    // body rotation
    const bx = wx * cosB - wy * sinB;
    const by = wx * sinB + wy * cosB;
    // body position
    return [bx + body.x, by + body.y];
  });
}

/**
 * Compute the world (map-px) rect of a box under body+shape transform,
 * returning the four corners in map px.
 */
function boxWorldCorners(shape: ShapeGeom, body: MapBodyGeom): number[][] {
  const w = shape.width || 0;
  const h = shape.height || 0;
  const a = shape.angle || 0;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const cosB = Math.cos(body.angle);
  const sinB = Math.sin(body.angle);
  const corners: number[][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return corners.map((c) => {
    const x0 = c[0] * cosA - c[1] * sinA;
    const y0 = c[0] * sinA + c[1] * cosA;
    const px = x0 + shape.cx;
    const py = y0 + shape.cy;
    const bx = px * cosB - py * sinB;
    const by = px * sinB + py * cosB;
    return [bx + body.x, by + body.y];
  });
}

/**
 * Build a backend-agnostic draw list in screen px for a map geometry.
 */
export function buildGeometry(input: MapGeometryInput, cam: Camera): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const bodies = input.bodies || [];
  const fixtures = input.fixtures || [];
  const shapes = input.shapes || [];
  const capSet = new Set<number>((input.capZones || []).map(c => c.fixtureIndex));
  // Native `physics.bro` is front-to-back. SVG/Canvas paint later commands on
  // top, so reverse it to emit back-to-front. Inputs without native provenance
  // retain the legacy flattened body order.
  const paintOrder = input.bodyRenderOrder && input.bodyRenderOrder.length
    ? [...input.bodyRenderOrder].reverse()
    : bodies.map((_, i) => i);
  paintOrder.forEach((bodyIndex, orderPos) => {
    const body = bodies[bodyIndex];
    if (!body) return;
    for (const fIdx of (body.fixtureIndices || [])) {
      const fx = fixtures[fIdx];
      if (!fx) continue;
      const shape = shapes[fx.shapeIndex];
      if (!shape) continue;
      const isCap = capSet.has(fIdx);
      const isSensor = !!(fx.noPhysics);

      // Common transform: map the body position to screen and rotate about it.
      const sp = mapToScreen(body.x, body.y, cam);
      const stroke = isCap ? '#000000' : (fx.death ? '#ff0000' : null);
      // Cap-zone and death strokes scale with the camera like geometry does.
      const lineWidth = isCap ? cam.scale * 3 : (fx.death ? cam.scale * 3 : cam.scale * 2);
      // Native `np` skips a fixture from physics construction; it does not make
      // its artwork translucent. Decorative map logos commonly use this flag.
      const effectiveFill = hex(fx.color);

      let primitive: Primitive | null = null;
      if (shape.type === 'bx') {
        // Represent a rotated box as a polygon of its four world corners.
        const world = boxWorldCorners(shape, body);
        const pts = world.map(([x, y]) => {
          const s2 = mapToScreen(x, y, cam);
          return [s2.x, s2.y];
        });
        primitive = { kind: 'poly', sx: sp.x, sy: sp.y, points: pts, fill: effectiveFill, stroke, lineWidth };
      } else if (shape.type === 'ci') {
        // Circles honor their shape center offset: translate by the shape
        // center (rotated by the body angle) before drawing.
        const cosB = Math.cos(body.angle);
        const sinB = Math.sin(body.angle);
        const cx = shape.cx * cosB - shape.cy * sinB + body.x;
        const cy = shape.cx * sinB + shape.cy * cosB + body.y;
        const cs = mapToScreen(cx, cy, cam);
        const r = mapToScreenRadius(shape.radius || 0, cam);
        primitive = { kind: 'circle', sx: cs.x, sy: cs.y, r, fill: effectiveFill, stroke, lineWidth, angle: body.angle };
      } else if (shape.type === 'po') {
        const world = polyWorldPts(shape, body);
        const pts = world.map(([x, y]) => {
          const s2 = mapToScreen(x, y, cam);
          return [s2.x, s2.y];
        });
        primitive = { kind: 'poly', sx: sp.x, sy: sp.y, points: pts, fill: effectiveFill, stroke, lineWidth };
      }

      if (!primitive) continue;
      commands.push({ z: orderPos, primitive, isCapZone: isCap, isSensor });
    }
  });

  return commands;
}

function mapToScreenRadius(r: number, cam: Camera): number {
  // Shapes are authored in map px; a circle's radius maps via the same scale.
  return r * cam.scale;
}

/**
 * Convenience: normalize raw exported JSON into a geometry input if callers
 * pass the full exporter map (flat `physicsBodies` etc.). Left unpacked so M2
 * stays decoupled; callers with typed fields pass them directly.
 */
export function geometryFromExport(map: any, capZones?: CapZoneGeom[]): MapGeometryInput {
  // Engine-MapDef shape (src/core/physics-engine MapBodyDef): already-flattened
  // bodies with type 'rect'/'circle'/'polygon' and x/y in map px. Render each
  // as its own single-fixture body with the shape at body-local origin.
  if (!map.physicsBodies && Array.isArray(map.bodies)) {
    return geometryFromMapDefBody(map, capZones);
  }
  return {
    bodies: (map.physicsBodies || []).map((b: any, i: number) => ({
      index: b.index ?? i,
      x: b.position?.x ?? 0,
      y: b.position?.y ?? 0,
      angle: b.angle || 0,
      fixtureIndices: b.fixtureIndices || [],
    })),
    fixtures: (map.physicsFixtures || []).map((fx: any, i: number) => ({
      index: fx.index ?? i,
      shapeIndex: fx.shapeIndex,
      color: fx.color,
      noPhysics: fx.noPhysics,
      death: fx.death,
    })),
    shapes: (map.physicsShapes || []).map((s: any, i: number) => ({
      type: s.type,
      cx: s.center?.x ?? 0,
      cy: s.center?.y ?? 0,
      angle: s.angle || 0,
      width: s.width,
      height: s.height,
      radius: s.radius,
      // Exporter polygon vertices are {x,y} objects; store as [x,y] so the
      // shared polyWorldPts (v[0]/v[1]) renders them (was NaN for polygons).
      vertices: (s.vertices || []).map((v: any) =>
        Array.isArray(v) ? [v[0], v[1]] : [v.x, v.y]
      ),
      scale: s.scale,
    })),
    capZones: capZones || [],
    bodyRenderOrder: map.bodyRenderOrder,
  };
}

function shapeTypeOf(type: string): ShapeType {
  if (type === 'rect') return 'bx';
  if (type === 'circle') return 'ci';
  if (type === 'polygon') return 'po';
  return 'bx';
}

/**
 * Build a geometry input from the engine's normalized MapDef (as exposed by
 * env.config.mapData). Bodies are flattened primitives: x/y already world map
 * px, shapes already at body-local origin, so emit one synthetic fixture per
 * body with a shape centered at (0,0). Exported maps additionally retain an
 * exact render-only native shape projection for decorative geometry.
 */
export function geometryFromMapDefBody(map: any, capZones?: CapZoneGeom[]): MapGeometryInput {
  const bodies: MapBodyGeom[] = [];
  const fixtures: FixtureGeom[] = [];
  const shapes: ShapeGeom[] = [];
  let bodyRenderOrder: number[] | undefined;
  const mapBodies = map.bodies || [];
  const hasNativeRenderOrder = Array.isArray(map.bodyRenderOrder) && map.bodyRenderOrder.length > 0;
  const bodiesByRenderIndex = hasNativeRenderOrder ? new Map<number, number[]>() : undefined;
  mapBodies.forEach((b: any, i: number) => {
    const renderShape = b.renderShape;
    const st = shapeTypeOf(renderShape?.type ?? b.type);
    const radius = st === 'ci' ? (renderShape?.radius ?? b.radius) : undefined;
    const w = st === 'bx' ? (renderShape?.width ?? b.width) : undefined;
    const h = st === 'bx' ? (renderShape?.height ?? b.height) : undefined;
    const sourceVertices = renderShape?.vertices ?? b.vertices ?? [];
    const verts = st === 'po'
      ? sourceVertices.map((v: { x: number; y: number } | number[]) =>
        Array.isArray(v) ? [v[0], v[1]] : [v.x, v.y]
      )
      : undefined;
    const center = renderShape?.center;
    bodies.push({
      index: i,
      x: renderShape?.bodyPosition?.x ?? (b.x ?? 0),
      y: renderShape?.bodyPosition?.y ?? (b.y ?? 0),
      angle: renderShape?.bodyAngle ?? (b.angle ?? 0),
      fixtureIndices: [i],
    });
    shapes.push({
      type: st,
      cx: center?.x ?? 0,
      cy: center?.y ?? 0,
      angle: renderShape?.angle ?? 0,
      width: w,
      height: h,
      radius,
      vertices: verts,
      scale: renderShape?.scale ?? 1,
    });
    fixtures.push({ index: i, shapeIndex: i, color: b.color ?? 0xaaaaaa, noPhysics: b.noPhysics, death: b.isLethal });
    if (bodiesByRenderIndex && typeof b.renderBodyIndex === 'number') {
      const fixtureBodies = bodiesByRenderIndex.get(b.renderBodyIndex);
      if (fixtureBodies) fixtureBodies.push(i);
      else bodiesByRenderIndex.set(b.renderBodyIndex, [i]);
    }
  });

  if (bodiesByRenderIndex) {
    // A normalized MapDef flattens each source body fixture into one body.
    // Expand the native front-to-back order onto those fixture bodies. Any body
    // missing from the source order is retained behind the ordered set.
    const ordered = new Set<number>();
    bodyRenderOrder = [];
    for (const sourceBodyIndex of map.bodyRenderOrder) {
      const fixtureBodies = bodiesByRenderIndex.get(sourceBodyIndex) ?? [];
      // buildGeometry reverses native front-to-back body order for SVG paint.
      // Reverse the flattened fixture entries here so that reversal does not
      // also invert their native order within a single source body.
      for (let fixtureIndex = fixtureBodies.length - 1; fixtureIndex >= 0; fixtureIndex -= 1) {
        const i = fixtureBodies[fixtureIndex];
        bodyRenderOrder.push(i);
        ordered.add(i);
      }
    }
    mapBodies.forEach((_: any, i: number) => {
      if (!ordered.has(i)) bodyRenderOrder!.push(i);
    });
  }

  // In the flattened MapDef, each body IS its own fixture (index i). Cap zones
  // reference that body by `fixture` NAME (MapDef contract), so resolve the name
  // to the body's array index and treat that fixture as the cap-zone fixture —
  // otherwise cap-zone outlines never render on the env load path (#review).
  const nameToBodyIndex = new Map<string, number>();
  (mapBodies as any[]).forEach((b, i) => {
    if (b && typeof b.name === 'string') nameToBodyIndex.set(b.name, i);
  });
  const resolvedCapZones = (capZones || []).map((cz) => {
    const idxFromName = typeof (cz as any).fixture === 'string'
      ? nameToBodyIndex.get((cz as any).fixture)
      : undefined;
    const slot = idxFromName;
    return { index: cz.index, fixtureIndex: slot ?? cz.fixtureIndex };
  });

  return { bodies, fixtures, shapes, capZones: resolvedCapZones, bodyRenderOrder };
}
