import { describe, it, expect } from 'vitest';
import {
  allocRing,
  writeSnapshot,
  readSnapshot,
  readSnapshotCoherent,
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

  it('per-slot layout is an Int32[2] header + Float32 discs', () => {
    // 2 Int32 header words (seq, tick) + 2 discs * 5 fields of Float32(4B).
    const perSlot = 2 * 4 + 2 * DISC_FIELDS * 4;
    const buf = allocRing(8, 2);
    expect(buf.byteLength).toBe(8 * perSlot);
  });

  it('stores the tick as a lossless Int32 (no float32 precision loss)', () => {
    const bigTick = 1 << 25; // > 2^24 where Float32 loses integer precision
    const buf = allocRing(4, 1);
    const reader = makeReader([ALIVE0], bigTick);
    writeSnapshot(buf, 1, 0, reader);
    const raw = readSnapshot(buf, 1, 0);
    expect(raw.tick).toBe(bigTick); // exact as Int32, not rounded
  });

  it('commits an even seq (ready) and reports the tick correctly', () => {
    const buf = allocRing(4, 1);
    const reader = makeReader([ALIVE0], 77);
    writeSnapshot(buf, 1, 0, reader);
    const raw = readSnapshot(buf, 1, 0);
    // Seqlock: committed seq is even and non-zero; tick is the Int32 value.
    expect(raw.seq).toBeGreaterThan(0);
    expect(raw.seq % 2).toBe(0);
    expect(raw.tick).toBe(77);
  });

  it('readSnapshotCoherent returns a frame for a fully written slot', () => {
    const buf = allocRing(4, 2);
    writeSnapshot(buf, 2, 1, makeReader([ALIVE0, DEAD1], 100));
    const coherent = readSnapshotCoherent(buf, 2, 1);
    expect(coherent).not.toBeNull();
    expect(coherent!.tick).toBe(100);
    expect(coherent!.discs[0].x).toBeCloseTo(ALIVE0.x);
    expect(coherent!.discs[1].alive).toBe(false);
  });

  it('readSnapshotCoherent returns null for an unwritten slot', () => {
    const buf = allocRing(4, 2);
    expect(readSnapshotCoherent(buf, 2, 3)).toBeNull();
  });

  it('readSnapshotCoherent rejects an in-progress write (odd seq)', () => {
    const buf = allocRing(4, 1);
    writeSnapshot(buf, 1, 0, makeReader([ALIVE0], 5));
    // Simulate a writer mid-frame: flip the committed even seq to odd (as
    // writeSnapshot does with `writeGen*2 + 1` before touching the payload).
    // The coherent read must skip because the slot is marked in-progress.
    const headerView = new Int32Array(buf, 0, 2);
    headerView[0] += 1; // even -> odd in-progress mark
    expect(readSnapshotCoherent(buf, 1, 0)).toBeNull();
  });

  it('readSnapshotCoherent accepts a stable committed (even) slot', () => {
    const buf = allocRing(4, 1);
    writeSnapshot(buf, 1, 0, makeReader([ALIVE0], 5));
    const headerView = new Int32Array(buf, 0, 2);
    // Confirm the committed seq is even; a stable even slot reads coherently.
    expect(headerView[0] % 2).toBe(0);
    const c = readSnapshotCoherent(buf, 1, 0);
    expect(c).not.toBeNull();
    expect(c!.tick).toBe(5);
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

  it('guards negative slot indices (no RangeError, positive modulo)', () => {
    const ring = allocRing(4, 1);
    const cam = computeCamera(730, 500, 12);
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 1, cam },
      { begin: () => {}, geometry: () => {}, sim: () => {}, end: () => {} },
    );
    const reader = makeReader([ALIVE0], 5);
    writeSnapshot(ring, 1, 0, reader);
    // A negative slot index must not throw; it normalizes to a valid slot.
    expect(() => sampler.renderSlot(-1, 4)).not.toThrow();
  });

  it('does not render a time-reversed (older) frame after a newer one', () => {
    const ring = allocRing(4, 2);
    const cam = computeCamera(730, 500, 12);
    const calls: string[] = [];
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 2, cam },
      { begin: () => calls.push('b'), geometry: () => {}, sim: () => {}, end: () => calls.push('e') },
    );
    // Render a newer frame first.
    writeSnapshot(ring, 2, 0, makeReader([ALIVE0, DEAD1], 20));
    const newer = sampler.renderSlot(0, 4);
    expect(newer).not.toBeNull();
    expect(newer!.tick).toBe(20);
    calls.length = 0;
    // An older/equal frame must be rejected (no time reversal).
    writeSnapshot(ring, 2, 1, makeReader([ALIVE0, DEAD1], 20));
    expect(sampler.renderSlot(1, 4)).toBeNull();
    writeSnapshot(ring, 2, 2, makeReader([ALIVE0, DEAD1], 19));
    expect(sampler.renderSlot(2, 4)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});