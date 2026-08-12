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

  it('skips a genuinely stale (lower-seq) frame after a newer one', () => {
    const ring = allocRing(4, 2);
    const cam = computeCamera(730, 500, 12);
    const calls: string[] = [];
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 2, cam },
      { begin: () => calls.push('b'), geometry: () => {}, sim: () => {}, end: () => calls.push('e') },
    );
    // Write an older frame to slot 0 first.
    writeSnapshot(ring, 2, 0, makeReader([ALIVE0, DEAD1], 12));
    // Then a newer frame to slot 1.
    writeSnapshot(ring, 2, 1, makeReader([ALIVE0, DEAD1], 20));
    const newer = sampler.renderSlot(1, 4);
    expect(newer).not.toBeNull();
    expect(newer!.tick).toBe(20);
    calls.length = 0;
    // A genuinely stale ring position (slot 0 holds an older write with a lower
    // seqlock seq) must still be rejected.
    expect(sampler.renderSlot(0, 4)).toBeNull();
    expect(calls).toHaveLength(0);
    // Re-sampling the already-rendered slot is skipped (same seq).
    expect(sampler.renderSlot(1, 4)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps rendering across consecutive episode resets (tick restarts at 0)', () => {
    const ring = allocRing(8, 2);
    const cam = computeCamera(730, 500, 12);
    const calls: string[] = [];
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 2, cam },
      { begin: () => calls.push('b'), geometry: () => {}, sim: () => {}, end: () => calls.push('e') },
    );

    const epTicks: Array<Array<number>> = [
      [0, 5, 10, 15, 20, 25],       // episode 1
      [0, 5, 10, 15, 20, 25, 30, 40], // episode 2: sim resets, ticks restart at 0
    ];

    for (const ep of epTicks) {
      const rendered: number[] = [];
      for (const t of ep) {
        const slot = Math.floor(t / 5) % 8;
        writeSnapshot(ring, 2, slot, makeReader([ALIVE0, DEAD1], t));
        if (sampler.renderSlot(slot, 8)) rendered.push(t);
      }
      // Every frame of the brand-new episode must render, even though the ticks
      // restarted at 0 (which the old tick-keyed guard suppressed entirely).
      expect(rendered).toEqual(ep);
    }
  });

  it('survives the Int32 seq wrap (writeGen * 2 truncation)', () => {
    const ring = allocRing(4, 2);
    const cam = computeCamera(730, 500, 12);
    const calls: string[] = [];
    const sampler = new DetachedRenderSampler(
      { geometry: { bodies: [], fixtures: [], shapes: [] }, ring, maxPlayers: 2, cam },
      { begin: () => calls.push('b'), geometry: () => {}, sim: () => {}, end: () => calls.push('e') },
    );
    // Per-slot header ints: [seq, tick] followed by 2 discs * 5 Float32 fields.
    const slotHeader = (slot: number) => new Int32Array(ring, slot * (2 + 2 * 5) * 4, 2);
    // Plant the final positive seq before the wrap: writeGen * 2 with writeGen
    // at 2^30 - 1 gives 2147483646, the largest even Int32.
    writeSnapshot(ring, 2, 0, makeReader([ALIVE0, DEAD1], 900));
    slotHeader(0)[0] = 2147483646;
    expect(sampler.renderSlot(0, 4)).not.toBeNull();
    expect(sampler.renderSlot(0, 4)).toBeNull(); // same seq -> stale

    calls.length = 0;
    // A small negative delta within one seq cycle is a genuinely stale frame
    // and must stay rejected.
    writeSnapshot(ring, 2, 1, makeReader([ALIVE0, DEAD1], 901));
    slotHeader(1)[0] = 2147483644;
    expect(sampler.renderSlot(1, 4)).toBeNull();
    expect(calls).toHaveLength(0);

    // After the wrap the stored seq is negative (writeGen * 2 = 2^31 truncates
    // to Int32 min). The delta beyond one Int32 cycle is a fresh write and must
    // render — the naive `seq <= lastSeq` guard would freeze the sampler here.
    writeSnapshot(ring, 2, 2, makeReader([ALIVE0, DEAD1], 902));
    slotHeader(2)[0] = -2147483648;
    const afterWrap = sampler.renderSlot(2, 4);
    expect(afterWrap).not.toBeNull();
    expect(afterWrap!.tick).toBe(902);
  });
});
