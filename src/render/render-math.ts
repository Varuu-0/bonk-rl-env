/**
 * M1 — Coordinate & camera transforms.
 *
 * Pure world↔screen mapping used by every render layer. There is deliberately
 * no rendering here, no state, and no physics import beyond scalar constants:
 * it only maps between the three coordinate spaces the sim and the native
 * client use, so every layer shares one ground-truth transform.
 *
 * Spaces:
 *   - map px (M): authored/exported map units; the PhysicsEngine surfaces
 *     `getPlayerState().x/y` in map px, and bodies/arena bounds are map px.
 *   - world m: what Box2D uses internally = map px ÷ SCALE.
 *   - screen px (S): the fitted canvas, Y-down, origin at canvas center,
 *     matching the native 730×500 logical canvas (DEOBFUSCATION §33.5, §34.5).
 *
 * The native render scale is `ppm × scaleRatio` where `scaleRatio` is a
 * renderer-global fit computed from the canvas size against the 730×500
 * (1.46 aspect) logical canvas. We reproduce that so a fitted canvas zooms
 * exactly like bonk.io.
 */

import { SCALE } from '../core/physics-engine';

/** Default native player disc radius in game units (bonk.io `ppm`). */
export const DEFAULT_PPM = 12;

/** Native logical canvas size (bonk.io editor canvas, 1.46 aspect). */
export const BASE_WIDTH = 730;
export const BASE_HEIGHT = 500;
export const BASE_ASPECT = BASE_WIDTH / BASE_HEIGHT;

/** Out-of-bounds death circle radius in map px (native: 850 units). */
export const OUT_OF_BOUNDS_RADIUS = 850;

export interface Camera {
  /** Screen px per map px (>=1, fractional, or sub-1 zoom) used to draw the map onto the canvas. */
  scale: number;
  /** Screen-px offset that centers the map origin at the canvas center. */
  offsetX: number;
  /** Screen-px offset that centers the map origin at the canvas center. */
  offsetY: number;
}

/** Map px → world metres. */
export function toWorld(x: number, y: number): { x: number; y: number } {
  return { x: x / SCALE, y: y / SCALE };
}

/** World metres → map px. */
export function fromWorld(x: number, y: number): { x: number; y: number } {
  return { x: x * SCALE, y: y * SCALE };
}

/**
 * Compute the renderer fit (`scaleRatio`) for a canvas of the given pixel size.
 * Mirrors the native `resizeRenderer()`: when aspect <= 1.46 fit by width,
 * otherwise fit by height against the 730×500 logical canvas.
 */
export function computeScaleRatio(canvasWidth: number, canvasHeight: number): number {
  // NaN fails `< = 0`, so guard with isFinite to keep NaN dimensions from
  // producing a NaN ratio/camera.
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight)
    || canvasWidth <= 0 || canvasHeight <= 0) return 1;
  const aspect = canvasWidth / canvasHeight;
  if (aspect <= BASE_ASPECT) {
    return canvasWidth / BASE_WIDTH;
  }
  return (BASE_ASPECT * canvasHeight) / BASE_WIDTH;
}

/**
 * Native screen-coord scale: world-metres geometry is drawn at `ppm * scaleRatio`.
 * A world-metre box of size 1 draws at `scale` screen px per map px units are
 * `ppm × scaleRatio / 1`... Concretely, a length of `L` map px renders as
 * `L × (ppm × scaleRatio) / SCALE` screen px. This is the transform the client
 * applies (`pixelScale = physics.ppm * scaleRatio`, body * pixelScale).
 */
export function mapPxToScreen(mapPx: number, ppm: number, scaleRatio: number): number {
  return mapPx * ((ppm * scaleRatio) / SCALE);
}

/**
 * Build a Camera for the given canvas pixel size and ppm. The map world origin
 * (0,0) is placed at the canvas center (Y-down screen), and both axes are scaled
 * by `ppm × scaleRatio ÷ SCALE` so a fitted canvas zooms like the native client.
 */
export function computeCamera(
  canvasWidth: number,
  canvasHeight: number,
  ppm: number = DEFAULT_PPM,
): Camera {
  const scaleRatio = computeScaleRatio(canvasWidth, canvasHeight);
  const safePpm = Number.isFinite(ppm) && ppm > 0 ? ppm : DEFAULT_PPM;
  const scale = (safePpm * scaleRatio) / SCALE;
  return {
    scale,
    offsetX: canvasWidth / 2,
    offsetY: canvasHeight / 2,
  };
}

/**
 * Map a point in map px to screen px using a camera. Y-down is automatic here
 * because the canvas draw surface is Y-down and the camera keeps an upright
 * (non-flipped) transform — the map pump pulls a box with +Y at the bottom,
 * same as the sim's map px.
 */
export function mapToScreen(
  x: number,
  y: number,
  cam: Camera,
): { x: number; y: number } {
  return { x: cam.offsetX + x * cam.scale, y: cam.offsetY + y * cam.scale };
}

/** Inverse of `mapToScreen`. Safely clamps a degenerate (zero/NaN) scale. */
export function screenToMap(
  sx: number,
  sy: number,
  cam: Camera,
): { x: number; y: number } {
  const s = Number.isFinite(cam.scale) && cam.scale !== 0 ? cam.scale : 1;
  return { x: (sx - cam.offsetX) / s, y: (sy - cam.offsetY) / s };
}

/** Rotate a vector (in map px) by an angle in radians. */
export function rotate(x: number, y: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}