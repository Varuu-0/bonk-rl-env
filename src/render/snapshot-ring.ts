/**
 * M4 — Detached snapshot transport.
 *
 * A per-env, SharedArrayBuffer-backed ring of render snapshots. The simulation
 * host calls `write()` at a *sampled* sub-cadence (e.g. 10–30 Hz), NOT inside
 * `tick()` and NOT per Box2D step — so the sim hot path is never slowed. A
 * separate render thread/consumer reads the latest slot (`readLatest`) at its
 * own cadence and rasterizes.
 *
 * Each snapshot slot is laid out as an Int32 header `[seq, tick]` followed by
 * Float32 disc fields (x,y,angle,isHeavy,alive) for players 0..N-1.
 *
 *   - tick is stored as Int32 (not Float32) so long RL runs beyond 2^24 ticks
 *     stay exact (Float32 loses integer precision there).
 *   - seq (written LAST, a clone of tick while tick is the committed value)
 *     lets readers detect a mid-write torn read: read header, read payload,
 *     re-read header; if seq changed the write was partial and the frame is
 *     discarded rather than committed.
 *
 * A single AI + (numOpponents) slots are encoded; dead discs report alive=0 and
 * their frozen death position is preserved (the engine keeps it in
 * DetachedPlayerSnapshot). This adds the one field the observation lacks:
 * opponent `angle` (disc rotation), so the renderer draws spinning discs.
 */

export const DISC_FIELDS = 5; // x, y, angle, isHeavy, alive
export const HEADER_INTS = 2; // [seq, tick]
export const HEADER_FIELDS = HEADER_INTS; // (compat alias)

/** Bytes per disc field (Float32). */
const DISC_BYTES = 4;
/** Bytes for the Int32 header. */
const HEADER_BYTES = HEADER_INTS * 4;

/**
 * Build a SharedArrayBuffer for a snapshot ring with `slots` snapshots and
 * `maxPlayers` discs each. Layout per slot: Int32[2] header then Float32 discs.
 */
export function allocRing(slots: number, maxPlayers: number): SharedArrayBuffer {
  const perSlot = HEADER_BYTES + maxPlayers * DISC_FIELDS * DISC_BYTES;
  return new SharedArrayBuffer(slots * perSlot);
}

/** Bytes used by one snapshot slot. */
export function bytesPerSlot(maxPlayers: number): number {
  return HEADER_BYTES + maxPlayers * DISC_FIELDS * DISC_BYTES;
}

function slotHeader(buf: SharedArrayBuffer, maxPlayers: number, slotIndex: number): Int32Array {
  return new Int32Array(buf, slotIndex * bytesPerSlot(maxPlayers), HEADER_INTS);
}

function slotPayload(buf: SharedArrayBuffer, maxPlayers: number, slotIndex: number): Float32Array {
  return new Float32Array(
    buf,
    slotIndex * bytesPerSlot(maxPlayers) + HEADER_BYTES,
    maxPlayers * DISC_FIELDS,
  );
}

export interface RenderStateReader {
  /** Get the current tick. */
  getTick(): number;
  /** Get a disc's render state by player id; returns null if absent. */
  getDisc(id: number): { x: number; y: number; angle: number; isHeavy: boolean; alive: boolean } | null;
}

/** Module-level seqlock generation. Each committed write uses an even seq; an
 * in-progress write uses an odd seq so readers can detect a write in flight. */
let writeGen = 0;

/**
 * Write the current state (via `reader`) into ring slot `slotIndex`. Uses a
 * seqlock: mark the slot in-progress (odd seq), write the disc payload, then the
 * tick, then commit (even seq). A reader that sees an odd seq (or a changed even
 * seq across its read) discards the torn frame. Returns the slot index written.
 */
export function writeSnapshot(
  buf: SharedArrayBuffer,
  maxPlayers: number,
  slotIndex: number,
  reader: RenderStateReader,
): number {
  const header = slotHeader(buf, maxPlayers, slotIndex);
  const payload = slotPayload(buf, maxPlayers, slotIndex);
  // Mark in progress (odd seq) before touching the payload.
  writeGen += 1;
  header[0] = writeGen * 2 + 1;
  const tick = reader.getTick();
  for (let p = 0; p < maxPlayers; p++) {
    const d = reader.getDisc(p);
    const o = p * DISC_FIELDS;
    if (!d) {
      payload[o] = 0; payload[o + 1] = 0; payload[o + 2] = 0;
      payload[o + 3] = 0; payload[o + 4] = 0;
      continue;
    }
    payload[o] = d.x;
    payload[o + 1] = d.y;
    payload[o + 2] = d.angle;
    payload[o + 3] = d.isHeavy ? 1 : 0;
    payload[o + 4] = d.alive ? 1 : 0;
  }
  header[1] = tick;
  // Commit: even seq written last. seq ordering guarantees a reader that sees
  // the committed (even) seq on both sides of its payload read got a whole frame.
  header[0] = writeGen * 2;
  return slotIndex;
}

/**
 * Read back slot `slotIndex`. Returns `{ tick, discs, seq }`. The `seq` field
 * lets the caller detect a torn (partial) write by comparing it to a re-read —
 * for single-writer/single-reader, seq stable across the read implies coherence.
 */
export function readSnapshot(
  buf: SharedArrayBuffer,
  maxPlayers: number,
  slotIndex: number,
): { tick: number; seq: number; discs: Array<{ x: number; y: number; angle: number; isHeavy: boolean; alive: boolean }> } {
  const header = slotHeader(buf, maxPlayers, slotIndex);
  const payload = slotPayload(buf, maxPlayers, slotIndex);
  const seq = header[0];
  const tick = header[1];
  const discs = [];
  for (let p = 0; p < maxPlayers; p++) {
    const o = p * DISC_FIELDS;
    discs.push({ x: payload[o], y: payload[o + 1], angle: payload[o + 2], isHeavy: payload[o + 3] === 1, alive: payload[o + 4] === 1 });
  }
  return { tick, seq, discs };
}

/**
 * Torn-write-safe read for a single slot (seqlock). Writer marks in-progress
 * (odd seq), writes the payload + tick, then commits (even seq) last. Reader:
 *   read seq-before → read payload + tick → read seq-after
 * The frame is coherent only when both seq reads are even and equal: an odd
 * seq means a write is in flight; a changed even seq means a write committed
 * mid-read. Either way the (possibly torn) payload is discarded. Returns null
 * for unwritten (seq 0), in-progress (odd), or torn (changed) slots.
 */
export function readSnapshotCoherent(
  buf: SharedArrayBuffer,
  maxPlayers: number,
  slotIndex: number,
): { tick: number; seq: number; discs: Array<{ x: number; y: number; angle: number; isHeavy: boolean; alive: boolean }> } | null {
  const header = slotHeader(buf, maxPlayers, slotIndex);
  const seqBefore = header[0];
  // Unwritten slot, or a write currently in progress (odd seq): skip.
  if (seqBefore === 0 || seqBefore % 2 === 1) return null;
  const payload = slotPayload(buf, maxPlayers, slotIndex);
  const discs = [];
  for (let p = 0; p < maxPlayers; p++) {
    const o = p * DISC_FIELDS;
    discs.push({ x: payload[o], y: payload[o + 1], angle: payload[o + 2], isHeavy: payload[o + 3] === 1, alive: payload[o + 4] === 1 });
  }
  const tick = header[1];
  const seqAfter = header[0];
  // A write committed mid-read (even seq changed) or left it in progress (odd)
  // means the payload we just read was torn.
  //
  // NOTE (test coverage): the odd-seq rejection is deterministically
  // unit-tested, but the `seqAfter !== seqBefore` torn-commit branch can only
  // trigger when a real write commits *between* the `seqBefore` read (the
  // `seqBefore = header[0]` assignment above) and the `seqAfter` read here. A
  // synchronous unit test cannot interleave a second write inside a single read
  // call, so this branch is not covered by a plain unit test; it is exercised
  // by the concurrent worker stress test
  // (tests/integration/snapshot-ring-stress.test.ts) and by real detached
  // render consumers reading while the sim writes.
  if (seqAfter % 2 === 1 || seqAfter !== seqBefore) return null;
  return { tick, seq: seqBefore, discs };
}

/** Coherence check: seq is non-zero and unchanged between reads (no torn write). */
export function isCoherent(seq: number, stable: boolean): boolean {
  return seq !== 0 && stable;
}

/**
 * Decode a snapshot array into primitives for the M3 sim layer. Reuses the
 * death-center passed in (the map's cached center). Not required on the written
 * path — this is the read/render side.
 */
export function toSimSnapshot(
  raw: { tick: number; discs: Array<{ x: number; y: number; angle: number; isHeavy: boolean; alive: boolean }> },
  deathCenter?: { x: number; y: number },
): import('./sim-layer').SimSnapshot {
  return {
    tick: raw.tick,
    deathCenter: deathCenter || { x: 0, y: 0 },
    discs: raw.discs.map((d, id) => ({ id, ...d })),
  };
}