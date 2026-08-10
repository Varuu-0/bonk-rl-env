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

import { readSnapshot } from './snapshot-ring';
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
 * Returns the rendered snapshot, or null if nothing new to render (same tick).
 * This is a *pull* consumer: it does no simulation work of its own.
 */
export class DetachedRenderSampler {
  private lastTick = -1;

  constructor(
    private readonly frame: RenderFrameInput,
    private readonly target: DetachedRenderTarget,
  ) { }

  /** Sample the latest given slot and render if its tick advanced. */
  renderSlot(slotIndex: number, slotCount: number): SimSnapshot | null {
    const raw = readSnapshot(this.frame.ring, this.frame.maxPlayers, slotIndex % slotCount);
    if (raw.tick === this.lastTick) return null; // nothing new this cadence
    this.lastTick = raw.tick;

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