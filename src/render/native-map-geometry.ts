/**
 * Native-map adapter for the detached M1/M2 rendering pipeline.
 *
 * Strict native JSON validation and createNewState normalization remain owned by
 * src/core. This module only projects the resulting world-metre state back into
 * authored map pixels so the existing geometry and SVG utilities can draw it.
 */
import * as fs from 'fs';
import { isNativeMapJson, NativeMap, validateNativeMapJson } from '../core/native-map-codec';
import {
  NativeBody,
  NativeJoint,
  NativeMapPhysics,
  NativeMapSource,
  NativePoint,
  normalizeNativeMap,
} from '../core/native-map-state';
import { Camera, mapToScreen } from './render-math';
import { buildGeometry, MapGeometryInput, ShapeGeom } from './map-geometry';

export interface NativeSpawnGeom {
  index: number;
  x: number;
  y: number;
  xv: number;
  yv: number;
  priority: number;
  teams: string[];
  name: string;
}

export interface NativeJointGeom {
  index: number;
  type: NativeJoint['type'];
  a: NativePoint;
  b: NativePoint;
}

export interface NativeRenderGeometry {
  input: MapGeometryInput;
  bodyTypes: Array<'static' | 'dynamic' | 'kinematic' | null>;
  spawns: NativeSpawnGeom[];
  joints: NativeJointGeom[];
  frameCapZones: number[];
  limitations: string[];
}

export interface NativeMapRenderData extends NativeRenderGeometry {
  map: NativeMap;
  physics: NativeMapPhysics;
}

/** Read and strictly decode an authored native map without repairing it. */
export function loadNativeMapForRender(mapPath: string): NativeMapRenderData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot load native map ${mapPath}: ${(error as Error).message}`);
  }
  if (!isNativeMapJson(parsed)) {
    throw new Error(`Cannot render ${mapPath} as a native map: missing the native map JSON structure`);
  }
  const map = validateNativeMapJson(parsed);
  return nativeMapRenderData(map);
}

/** Project a validated native map through the engine's authored-map normalizer. */
export function nativeMapRenderData(map: NativeMap): NativeMapRenderData {
  const physics = normalizeNativeMap(map as NativeMapSource, { authored: true });
  const ppm = physics.ppm;
  const input: MapGeometryInput = {
    bodies: physics.bodies
      .map((body, index) =>
        body
          ? {
              index,
              x: body.p[0] * ppm - 365,
              y: body.p[1] * ppm - 250,
              angle: body.a,
              fixtureIndices: [...body.fx],
            }
          : null,
      )
      .filter((body): body is NonNullable<typeof body> => body !== null),
    fixtures: physics.fixtures
      .map((fixture, index) =>
        fixture
          ? {
              index,
              shapeIndex: fixture.sh,
              color: fixture.f,
              noPhysics: fixture.np,
              death: fixture.d,
            }
          : null,
      )
      .filter((fixture): fixture is NonNullable<typeof fixture> => fixture !== null),
    shapes: physics.shapes
      .map((shape): ShapeGeom | null => {
        if (!shape) return null;
        if (shape.type === 'bx') {
          return {
            type: 'bx',
            cx: shape.c[0] * ppm,
            cy: shape.c[1] * ppm,
            angle: shape.a,
            width: shape.w * ppm,
            height: shape.h * ppm,
          };
        }
        if (shape.type === 'ci') {
          return { type: 'ci', cx: shape.c[0] * ppm, cy: shape.c[1] * ppm, angle: 0, radius: shape.r * ppm };
        }
        // Normalized polygon vertices already contain shape scale/angle/centre.
        if (shape.v.length < 3) {
          // Match native-world's origin-centred radius-two fallback.
          return { type: 'ci', cx: 0, cy: 0, angle: 0, radius: 2 * ppm };
        }
        return { type: 'po', cx: 0, cy: 0, angle: 0, scale: 1, vertices: shape.v.map(([x, y]) => [x * ppm, y * ppm]) };
      })
      .filter((shape): shape is ShapeGeom => shape !== null),
    capZones: map.capZones
      .map((zone, index) => ({ index, fixtureIndex: zone.i }))
      .filter((zone) => zone.fixtureIndex >= 0),
    bodyRenderOrder: [...physics.bro],
  };

  const bodyTypes = physics.bodies.map((body) => {
    if (!body) return null;
    if (body.s.type === 's' || !body.fx.some((id) => physics.fixtures[id]?.np === false)) return 'static' as const;
    return body.s.type === 'd' ? ('dynamic' as const) : ('kinematic' as const);
  });
  const spawns = map.spawns.map((spawn, index) => ({
    index,
    x: spawn.x,
    y: spawn.y,
    xv: spawn.xv,
    yv: spawn.yv,
    priority: spawn.priority,
    teams: [
      spawn.f ? 'FFA' : '',
      spawn.r ? 'red' : '',
      spawn.b ? 'blue' : '',
      spawn.gr ? 'green' : '',
      spawn.ye ? 'yellow' : '',
    ].filter(Boolean),
    name: spawn.n,
  }));
  const joints = physics.joints
    .map((joint, index) => (joint ? nativeJointGeometry(joint, index, physics) : null))
    .filter((joint): joint is NativeJointGeom => joint !== null);
  const frameCapZones = map.capZones.map((zone, index) => (zone.i === -1 ? index : -1)).filter((index) => index >= 0);
  const limitations: string[] = [];
  if (physics.ss.length > 0) limitations.push('Initial geometry is drawn; shrink animation is not simulated.');
  if (physics.bodies.some((body) => body?.fz.on)) limitations.push('Force zones are not visually represented.');
  if (frameCapZones.length > 0) limitations.push('Capture zones with fixture -1 are shown on the map frame.');
  return { map, physics, input, bodyTypes, spawns, joints, frameCapZones, limitations };
}

function bodyAnchor(bodyIndex: number, local: NativePoint, physics: NativeMapPhysics): NativePoint {
  const ppm = physics.ppm;
  const body = bodyIndex >= 0 ? physics.bodies[bodyIndex] : null;
  if (!body) return [local[0] * ppm - 365, local[1] * ppm - 250];
  const cos = Math.cos(body.a);
  const sin = Math.sin(body.a);
  return [
    (body.p[0] + local[0] * cos - local[1] * sin) * ppm - 365,
    (body.p[1] + local[0] * sin + local[1] * cos) * ppm - 250,
  ];
}

function nativeJointGeometry(joint: NativeJoint, index: number, physics: NativeMapPhysics): NativeJointGeom {
  if (joint.type === 'lpj') {
    return {
      index,
      type: joint.type,
      a: bodyAnchor(joint.ba, [0, 0], physics),
      b: bodyAnchor(joint.bb, [joint.pax, joint.pay], physics),
    };
  }
  if (joint.type === 'lsj') {
    return {
      index,
      type: joint.type,
      a: bodyAnchor(joint.ba, [0, 0], physics),
      b: bodyAnchor(joint.bb, [joint.sax, joint.say], physics),
    };
  }
  return {
    index,
    type: joint.type,
    a: bodyAnchor(joint.ba, joint.aa, physics),
    b: bodyAnchor(joint.bb, joint.ab, physics),
  };
}

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Compute authored-pixel bounds from the same transformed commands that are drawn. */
export function nativeGeometryBounds(data: NativeRenderGeometry): MapBounds {
  const identity: Camera = { scale: 1, offsetX: 0, offsetY: 0 };
  const commands = buildGeometry(data.input, identity);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const include = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const command of commands) {
    const primitive = command.primitive;
    if (primitive.kind === 'circle') {
      include(primitive.sx - primitive.r, primitive.sy - primitive.r);
      include(primitive.sx + primitive.r, primitive.sy + primitive.r);
    } else if (primitive.kind === 'poly') {
      primitive.points.forEach(([x, y]) => include(x, y));
    } else {
      include(primitive.sx, primitive.sy);
      include(primitive.sx + primitive.w, primitive.sy + primitive.h);
    }
  }
  data.spawns.forEach((spawn) => {
    include(spawn.x - 12, spawn.y - 12);
    include(spawn.x + 12, spawn.y + 12);
  });
  data.joints.forEach((joint) => {
    include(...joint.a);
    include(...joint.b);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { minX: -365, minY: -250, maxX: 365, maxY: 250 };
  }
  return { minX, minY, maxX, maxY };
}

/** Fit bounds into a canvas with equal axis scales and a five-percent margin. */
export function fitNativeCamera(bounds: MapBounds, width: number, height: number, margin = 0.05): Camera {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 730;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 500;
  const safeMargin = Number.isFinite(margin) ? Math.max(0, Math.min(0.45, margin)) : 0.05;
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  const scale = Math.max(
    1e-6,
    Math.min((safeWidth * (1 - 2 * safeMargin)) / spanX, (safeHeight * (1 - 2 * safeMargin)) / spanY),
  );
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  return { scale, offsetX: safeWidth / 2 - centreX * scale, offsetY: safeHeight / 2 - centreY * scale };
}

export function nativePointToScreen(point: NativePoint, camera: Camera): NativePoint {
  const screen = mapToScreen(point[0], point[1], camera);
  return [screen.x, screen.y];
}
