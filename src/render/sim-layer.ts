/**
 * M3 — Live simulation layer.
 *
 * Turns a per-tick simulation snapshot into backend-agnostic draw primitives
 * (screen px) drawn *over* the M2 map geometry. Consumes the exact state the
 * PhysicsEngine already materializes after `tick()` — `PlayerState` fields
 * (x,y,angle,isHeavy,alive) — plus the map's death-circle center. No
 * simulation is run or advanced here: this is a pure read/transform of an
 * already-produced snapshot.
 *
 * Discs are drawn as filled circles of radius `ppm × scaleRatio` in the native
 * model; heavy discs get an outer ring; the death circle is an outline of
 * `OUT_OF_BOUNDS_RADIUS` map px about the map center.
 */

import { Camera, mapToScreen, OUT_OF_BOUNDS_RADIUS, DEFAULT_PPM } from './render-math';
import { DrawCommand } from './map-geometry';

export interface RenderDisc {
  id: number;
  x: number; // map px
  y: number;
  angle: number; // radians
  isHeavy: boolean;
  alive: boolean;
  /** Optional team color for the fill; falls back to playerIndex palette. */
  color?: number;
}

export interface SimSnapshot {
  tick: number;
  discs: RenderDisc[];
  /** Map center for the death circle, in map px. Defaults to origin. */
  deathCenter?: { x: number; y: number };
}

export type SimPrimitive =
  | { kind: 'disc'; sx: number; sy: number; r: number; angle: number; fill: string; stroke: string | null; heavy: boolean }
  | { kind: 'deathCircle'; sx: number; sy: number; r: number }
  | { kind: 'grapple'; x1: number; y1: number; x2: number; y2: number };

export type SimCommand = { z: number; primitive: SimPrimitive };

const DISC_COLORS = ['#4a90d9', '#d94a4a', '#5cb85c', '#f0ad4e', '#9b59b6'];

function discFill(id: number, color?: number): string {
  if (typeof color === 'number') return '#' + (color >>> 0).toString(16).padStart(6, '0');
  return DISC_COLORS[id % DISC_COLORS.length];
}

/**
 * Build a draw list for the sim snapshot, in screen px. `cam` must be the same
 * camera used for the M2 geometry so the layers align. `ppm` fixes the disc
 * radius (native: radius = ppm × scaleRatio, or in map px simply `ppm`, since
 * map px -> screen is `mapPx × ppm×ratio÷SCALE`).
 */
export function buildSim(snapshot: SimSnapshot, cam: Camera, ppm: number = DEFAULT_PPM): SimCommand[] {
  const commands: SimCommand[] = [];

  // Death circle first (background), centered on the map center.
  const center = snapshot.deathCenter || { x: 0, y: 0 };
  const dc = mapToScreen(center.x, center.y, cam);
  const dcRadius = OUT_OF_BOUNDS_RADIUS * cam.scale;
  commands.push({ z: 0, primitive: { kind: 'deathCircle', sx: dc.x, sy: dc.y, r: dcRadius } });

  // Discs are drawn only while alive, on top of the map (z high).
  snapshot.discs.forEach((d, i) => {
    if (!d.alive) return;
    const s = mapToScreen(d.x, d.y, cam);
    const r = ppm * cam.scale;
    commands.push({
      z: 100 + i,
      primitive: {
        kind: 'disc',
        sx: s.x,
        sy: s.y,
        r,
        angle: d.angle,
        fill: discFill(d.id, d.color),
        stroke: d.isHeavy ? '#ffd700' : '#000000',
        heavy: d.isHeavy,
      },
    });
  });

  return commands;
}