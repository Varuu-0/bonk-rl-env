import { describe, it, expect } from 'vitest';
import {
  BASE_WIDTH,
  BASE_HEIGHT,
  BASE_ASPECT,
  DEFAULT_PPM,
  OUT_OF_BOUNDS_RADIUS,
  toWorld,
  fromWorld,
  computeScaleRatio,
  computeCamera,
  mapToScreen,
  screenToMap,
  mapPxToScreen,
  rotate,
} from '../../src/render/render-math';
import { SCALE as ENGINE_SCALE } from '../../src/core/physics-engine';

describe('render-math (M1)', () => {
  it('world<->map round-trips at SCALE=30', () => {
    expect(ENGINE_SCALE).toBe(30);
    const m = { x: 150, y: -90 };
    const w = toWorld(m.x, m.y);
    expect(w).toEqual({ x: 5, y: -3 });
    const back = fromWorld(w.x, w.y);
    expect(back.x).toBeCloseTo(m.x);
    expect(back.y).toBeCloseTo(m.y);
  });

  it('scaleRatio fits width on wide canvases and height on tall ones', () => {
    // 730x500 (exact 1.46) fits by width -> ratio 1
    expect(computeScaleRatio(730, 500)).toBeCloseTo(1);
    // At 1460x1000 (aspect 1.46) ratio is 2 (width-fit).
    expect(computeScaleRatio(1460, 1000)).toBeCloseTo(2);
    // 1460x500 has aspect 2.92 > 1.46 -> height-fit against 730x500.
    expect(computeScaleRatio(1460, 500)).toBeCloseTo(1.0);
    // Wide-and-very-tall: height-fit dominates.
    expect(computeScaleRatio(2000, 500)).toBeCloseTo(1.0);
  });

  it('exposes the documented native constants', () => {
    expect(BASE_WIDTH).toBe(730);
    expect(BASE_HEIGHT).toBe(500);
    expect(BASE_ASPECT).toBeCloseTo(1.46);
    expect(DEFAULT_PPM).toBe(12);
    expect(OUT_OF_BOUNDS_RADIUS).toBe(850);
  });

  it('camera centers the map origin and scales by ppm*ratio/SCALE', () => {
    // 730x500 canvas at ppm 12 -> ratio 1 -> scale 12/30 = 0.4
    const cam = computeCamera(730, 500, 12);
    expect(cam.scale).toBeCloseTo(0.4);
    expect(cam.offsetX).toBe(365);
    expect(cam.offsetY).toBe(250);

    // A point at map origin (0,0) lands at canvas center.
    const s = mapToScreen(0, 0, cam);
    expect(s.x).toBeCloseTo(365);
    expect(s.y).toBeCloseTo(250);

    // A map point 30 px to the right moves 30*0.4=12 screen px right.
    const right = mapToScreen(30, 0, cam);
    expect(right.x).toBeCloseTo(365 + 12);
    expect(right.y).toBeCloseTo(250);
  });

  it('screenToMap inverts mapToScreen', () => {
    const cam = computeCamera(800, 600, 12);
    const p = { x: 123, y: -45 };
    const s = mapToScreen(p.x, p.y, cam);
    const back = screenToMap(s.x, s.y, cam);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('mapPxToScreen matches the native pixelScale model', () => {
    // A 260 px box at ppm 12 ratio 1 -> 260 * (12/30) = 104 screen px.
    const len = mapPxToScreen(260, 12, 1);
    expect(len).toBeCloseTo(104);
  });

  it('rotate applies standard 2D rotation', () => {
    const r = rotate(1, 0, Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
  });
});