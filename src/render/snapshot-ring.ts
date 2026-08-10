/**
 * M4 — Detached snapshot transport.
 *
 * A per-env, SharedArrayBuffer-backed ring of render snapshots. The simulation
 * host calls `write()` at a *sampled* sub-cadence (e.g. 10–30 Hz), NOT inside
 * `tick()` and NOT per Box2D step — so the sim hot path is never slowed. A
 * separate render thread/consumer reads the latest slot (`readLatest`) at its
 * own cadence and rasterizes.
 *
 * Each snapshot is a fixed-layout Float32Array:
 *   [0]=tick, [1..]=disc fields (x,y,angle,isHeavy,alive) for players 0..N-1
 * A single AI + (numOpponents) slots are encoded; dead discs report alive=0 and
 * their frozen death position is preserved (the engine keeps it in
 * DetachedPlayerSnapshot). This adds the one field the observation lacks:
 * opponent `angle` (disc rotation), so the renderer draws spinning discs.
 */

export const DISC_FIELDS = 5; // x, y, angle, isHeavy, alive
export const HEADER_FIELDS = 1; // tick
export const FIELDS_PER_DISC = DISC_FIELDS;

/**
 * Build a SharedArrayBuffer for a snapshot ring with `slots` snapshots and
 * `maxPlayers` discs each. Returns the buffer (size computed precisely).
 */
export function allocRing(slots: number, maxPlayers: number): SharedArrayBuffer {
  const perSlot = HEADER_FIELDS + maxPlayers * DISC_FIELDS;
  return new SharedArrayBuffer(slots * perSlot * Float32Array.BYTES_PER_ELEMENT);
}

export interface RenderStateReader {
  /** Get the current tick. */
  getTick(): number;
  /** Get a disc's render state by player id; returns null if absent. */
  getDisc(id: number): { x: number; y: number; angle: number; isHeavy: boolean; alive: boolean } | null;
}

/**
 * Write the current state (via `reader`) into ring slot `slotIndex`. Returns
 * the slot index written. Pure write; no allocation when `slotIndex` is
 * precomputed. Cheap enough for a sub-cadence capture.
 */
export function writeSnapshot(
  buf: SharedArrayBuffer,
  maxPlayers: number,
  slotIndex: number,
  reader: RenderStateReader,
): number {
  const slot = bufSlotView(buf, maxPlayers, slotIndex);
  slot[0] = reader.getTick();
  const base = HEADER_FIELDS;
  for (let p = 0; p < maxPlayers; p++) {
    const d = reader.getDisc(p);
    const o = base + p * DISC_FIELDS;
    if (!d) {
      slot[o] = 0; slot[o + 1] = 0; slot[o + 2] = 0;
      slot[o + 3] = 0; slot[o + 4] = 0;
      continue;
    }
    slot[o] = d.x;
    slot[o + 1] = d.y;
    slot[o + 2] = d.angle;
    slot[o + 3] = d.isHeavy ? 1 : 0;
    slot[o + 4] = d.alive ? 1 : 0;
  }
  return slotIndex;
}

/** Read back slot `slotIndex` as a structured render snapshot. */
export function readSnapshot(
  buf: SharedArrayBuffer,
  maxPlayers: number,
  slotIndex: number,
): { tick: number; discs: Array<{ x: number; y: number; angle: number; isHeavy: boolean; alive: boolean }> } {
  const slot = bufSlotView(buf, maxPlayers, slotIndex);
  const discs = [];
  const base = HEADER_FIELDS;
  for (let p = 0; p < maxPlayers; p++) {
    const o = base + p * DISC_FIELDS;
    discs.push({ x: slot[o], y: slot[o + 1], angle: slot[o + 2], isHeavy: slot[o + 3] === 1, alive: slot[o + 4] === 1 });
  }
  return { tick: slot[0], discs };
}

function bufSlotView(buf: SharedArrayBuffer, maxPlayers: number, slotIndex: number): Float32Array {
  const perSlot = HEADER_FIELDS + maxPlayers * DISC_FIELDS;
  return new Float32Array(buf, slotIndex * perSlot * Float32Array.BYTES_PER_ELEMENT, perSlot);
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