/**
 * M4 — Detached render ticker.
 *
 * A renderer-side sampler that reads the latest (assumed-latest) snapshot from
 * a ring at its own cadence and passes it to a `render` callback. It never runs
 * inside the simulation's `tick()`/step loop and it never blocks a worker: it
 * only *reads* already-written snapshot slots. This is how thousands of parallel
 * matches can each render without slowing the sim — the sim only writes a ring
 * slot at a sampled sub-cadence, and each render thread samples at its own rate.
 */

import { readSnapshotCoherent } from './snapshot-ring';
import { buildSim, SimSnapshot } from './sim-layer';
import { buildGeometry, DrawCommand, MapGeometryInput } from './map-geometry';
import { Camera } from './render-math';

export interface DetachedRenderTarget {
  /** Clear the frame. */
  begin(): void;
  /** Draw geometry commands (map). */
  geometry(cmds: DrawCommand[]): void;
  /** Draw sim commands (discs, death circle). */
  sim(cmds: ReturnType<typeof buildSim>): void;
  /** Finalize the frame (flush / present). */
  end(): void;
}

export interface RenderFrameInput {
  geometry: MapGeometryInput;
  ring: SharedArrayBuffer;
  maxPlayers: number;
  cam: Camera;
  /** Cache of the map's death center (map px), read once. */
  deathCenter?: { x: number; y: number };
}

/**
 * A sampler that renders the highest slot written at or below `readSlot`.
 * Returns the rendered snapshot, or null if nothing new to render (same seqlock
 * generation — i.e. the slot holds no fresh write). This is a *pull* consumer: it
 * does no simulation work of its own.
 */
export class DetachedRenderSampler {
  private lastSeq = -1;

  constructor(
    private readonly frame: RenderFrameInput,
    private readonly target: DetachedRenderTarget,
  ) { }

  /** Sample the latest slot and render if a fresh write (seq) is present. */
  renderSlot(slotIndex: number, slotCount: number): SimSnapshot | null {
    const count = Math.max(1, Math.floor(slotCount));
    const scan = normalizeSlot(slotIndex, count);

    // Scan up to the whole ring (single pass) starting at the freshest slot and
    // moving backward, to find the most recent coherent (non-torn) write.
    // readSnapshotCoherent brackets the payload read between seq reads, so it
    // returns null on any torn write that lands mid-payload.
    const raw = (() => {
      for (let back = 0; back < count; back++) {
        const idx = ((scan - back) % count + count) % count;
        const candidate = readSnapshotCoherent(this.frame.ring, this.frame.maxPlayers, idx);
        if (candidate) return candidate;
      }
      return null;
    })();
    if (!raw) return null; // nothing coherent written yet

    // Never re-render a frame older than the last one (time-reversed guard).
    // Key the guard on the seqlock write generation (`seq`), which is monotonic
    // across episode resets. The sim tick is NOT monotonic across resets: every
    // `BonkEnvironment.reset()` rebuilds the world and restarts ticks at 0, so a
    // tick-keyed guard would suppress the entire next episode after a reset.
    // `seq` is `writeGen * 2` truncated to Int32 and wraps negative after 2^31
    // process-wide commits, so a delta beyond one Int32 cycle is a fresh write
    // after the wrap, while a small negative delta is a genuinely stale frame.
    if (raw.seq === this.lastSeq) return null;
    const seqDelta = raw.seq - this.lastSeq;
    if (seqDelta < 0 && seqDelta > -2147483648) return null;
    this.lastSeq = raw.seq;

    const simSnap: SimSnapshot = {
      tick: raw.tick,
      deathCenter: this.frame.deathCenter,
      discs: raw.discs.map((d, id) => ({ ...d, id })),
    };

    this.target.begin();
    this.target.geometry(buildGeometry(this.frame.geometry, this.frame.cam));
    this.target.sim(buildSim(simSnap, this.frame.cam));
    this.target.end();
    return simSnap;
  }
}

/**
 * Convenience: compute the next slot to sample for a fixed sub-cadence, given
 * ring size and sim tick cadence. E.g. render 1 in every `everyTicks` ticks.
 */
export function cadenceSlot(tick: number, everyTicks: number): number {
  return Math.floor(tick / everyTicks);
}

/** Normalize a slot index into [0, count) with positive modulo (guards negatives). */
export function normalizeSlot(slotIndex: number, slotCount: number): number {
  const count = Math.max(1, Math.floor(slotCount));
  return ((Math.floor(slotIndex) % count) + count) % count;
}