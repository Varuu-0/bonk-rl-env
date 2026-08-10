import { describe, it, expect } from 'vitest';
import {
  allocRing,
  writeSnapshot,
  readSnapshot,
  toSimSnapshot,
  DISC_FIELDS,
  RenderStateReader,
} from '../../src/render/snapshot-ring';
import { DetachedRenderSampler, cadenceSlot } from '../../src/render/render-sampler';
import { buildGeometry, geometryFromExport } from '../../src/render/map-geometry';
import { computeCamera } from '../../src/render/render-math';
import * as fs from 'fs';
import * as path from 'path';

function makeReader(state: Array<{ x: number; y: number; angle: number; isHeavy: boolean; alive: boolean }>, tick: number): RenderStateReader {
  return {
    getTick: () => tick,
    getDisc: (id: number) => state[id] ?? null,
  };
}

const ALIVE0 = { x: 10, y: 20, angle: 0.5, isHeavy: false, alive: true };
const DEAD1 = { x: -5, y: -8, angle: 0.1, isHeavy: true, alive: false };

describe('snapshot-ring (M4)', () => {
  it('round-trips a two-disc snapshot at a slot', () => {
    const buf = allocRing(8, 2);
    const reader = makeReader([ALIVE0, DEAD1], 42);
    writeSnapshot(buf, 2, 3, reader);
    const raw = readSnapshot(buf, 2, 3);
    expect(raw.tick).toBe(42);
    expect(raw.discs[0].x).toBeCloseTo(ALIVE0.x);
    expect(raw.discs[0].y).toBeCloseTo(ALIVE0.y);
    expect(raw.discs[0].angle).toBeCloseTo(ALIVE0.angle, 5);
    expect(raw.discs[0].isHeavy).toBe(false);
    expect(raw.discs[0].alive).toBe(true);
    // float32 round-trip of 0.1 is not exact; use tolerance.
    expect(raw.discs[1].x).toBeCloseTo(DEAD1.x);
    expect(raw.discs[1].y).toBeCloseTo(DEAD1.y);
    expect(raw.discs[1].angle).toBeCloseTo(DEAD1.angle, 5);
    expect(raw.discs[1].isHeavy).toBe(true);
    expect(raw.discs[1].alive).toBe(false);
  });

  it('writes missing discs as zeroed alive=false', () => {
    const buf = allocRing(4, 3);
    const reader = makeReader([ALIVE0], 7);
    writeSnapshot(buf, 3, 0, reader);
    const raw = readSnapshot(buf, 3, 0);
    expect(raw.discs[1].alive).toBe(false);
    expect(raw.discs[2].alive).toBe(false);
    expect(raw.discs[1].x).toBe(0);
  });

  it('per-slot size uses 1 header + 5 per disc', () => {
    const perSlot = 1 + 2 * DISC_FIELDS;
    const buf = allocRing(8, 2);
    expect(buf.byteLength).toBe(8 * perSlot * Float32Array.BYTES_PER_ELEMENT);
  });

  it('toSimSnapshot attaches ids for the sim layer', () => {
    const snap = toSimSnapshot({ tick: 5, discs: [ALIVE0, DEAD1] }, { x: 0, y: 0 });
    expect(snap.discs[0].id).toBe(0);
    expect(snap.discs[1].id).toBe(1);
    expect(snap.discs[1].alive).toBe(false);
  });

  it('cadenceSlot samples one in every N ticks', () => {
    expect(cadenceSlot(0, 5)).toBe(0);
    expect(cadenceSlot(4, 5)).toBe(0);
    expect(cadenceSlot(5, 5)).toBe(1);
    expect(cadenceSlot(14, 5)).toBe(2);
  });
});

describe('DetachedRenderSampler', () => {
  it('renders a new tick and skips unchanged ticks', () => {
    const ring = allocRing(8, 2);
    const cam = computeCamera(730, 500, 12);
    const calls: string[] = [];
    const map = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json'), 'utf8'));
    const geom = geometryFromExport(map);

    const sampler = new DetachedRenderSampler(
      { geometry: geom, ring, maxPlayers: 2, cam },
      {
        begin: () => calls.push('b'),
        geometry: (cmds) => calls.push(`g${cmds.length}`),
        sim: (cmds) => calls.push(`s${cmds.length}`),
        end: () => calls.push('e'),
      },
    );

    // tick 10 at slot 0
    const reader = makeReader([ALIVE0, DEAD1], 10);
    writeSnapshot(ring, 2, 0, reader);
    const first = sampler.renderSlot(0, 8);
    expect(first).not.toBeNull();
    expect(first!.tick).toBe(10);
    expect(calls).toContain('b');
    expect(calls.some(c => c.startsWith('g'))).toBe(true);
    expect(calls.some(c => c.startsWith('s'))).toBe(true);

    calls.length = 0;
    // Same tick again -> no render.
    const again = sampler.renderSlot(0, 8);
    expect(again).toBeNull();
    expect(calls).toHaveLength(0);

    // New tick -> renders.
    const reader2 = makeReader([ALIVE0, DEAD1], 11);
    writeSnapshot(ring, 2, 1, reader2);
    const second = sampler.renderSlot(1, 8);
    expect(second).not.toBeNull();
    expect(second!.tick).toBe(11);
  });

  it('only reads already-written state (never simulates)', () => {
    const ring = allocRing(4, 2);
    const cam = computeCamera(730, 500, 12);
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 2, cam },
      { begin: () => {}, geometry: () => {}, sim: () => {}, end: () => {} },
    );
    // Nothing written yet -> slot reads all-zero, tick 0. Caller decides not to
    // render an empty first frame; the sampler itself has no sim side effects.
    expect(() => sampler.renderSlot(0, 4)).not.toThrow();
  });
});