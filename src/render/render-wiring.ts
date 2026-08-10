/**
 * M5 — Integration wiring.
 *
 * Adapts a `BonkEnvironment`'s already-materialized live `PlayerState` into the
 * detached snapshot ring, and provides a one-shot convenience to produce an SVG
 * frame for any camera/map. This is deliberately read-only against the env
 * (pulls `getPlayerState`, never drives tick()) so it can be driven by a
 * separate render thread at a sampled sub-cadence without slowing the sim.
 */

import { BonkEnvironment } from '../core/environment';
import { RenderStateReader } from './snapshot-ring';
import { buildGeometry, geometryFromExport } from './map-geometry';
import { buildSim, SimSnapshot } from './sim-layer';
import { renderFrameSvg, SvgRasterizerOptions } from './svg-rasterizer';
import { computeCamera, Camera } from './render-math';

export { computeCamera, Camera };

/**
 * Build a render-state reader over a live env. Reads the AI + each opponent's
 * current materialized state (including `angle`, which the observation drops
 * for opponents) with zero simulation — it only pulls already-computed values.
 */
export function createEnvReader(env: BonkEnvironment): RenderStateReader {
  const playerSlots = env['opponentIds'].length + 1;
  return {
    getTick: () => env['physics'].getTickCount(),
    getDisc: (id: number) => {
      if (id < 0 || id > playerSlots) return null;
      const s = env['physics'].getPlayerState(id);
      if (!s) return null;
      return { x: s.x, y: s.y, angle: s.angle, isHeavy: s.isHeavy, alive: s.alive };
    },
  };
}

/**
 * Build geometry input + death center from an env's loaded map data, once.
 * Returns { geometry, deathCenter } ready for the camera + geometry build.
 */
export interface EnvMapRender {
  geometry: ReturnType<typeof geometryFromExport>;
  deathCenter: { x: number; y: number } | undefined;
}

export function envMapRender(env: BonkEnvironment): EnvMapRender {
  const mapDef = (env as any).config.mapData;
  const deathCenter = mapDef?.physics?.deathCenter;
  return { geometry: geometryFromExport(mapDef), deathCenter: deathCenter || { x: 0, y: 0 } };
}

/** Build the disc render state from an env's live snapshot. */
export function envSimSnapshot(env: BonkEnvironment): SimSnapshot {
  const reader = createEnvReader(env);
  const playerSlots = (env as any).opponentIds.length + 1;
  return {
    tick: reader.getTick(),
    deathCenter: envMapRender(env).deathCenter,
    discs: Array.from({ length: playerSlots }, (_, id) => {
      const d = reader.getDisc(id);
      return d ? { id, ...d } : { id, x: 0, y: 0, angle: 0, isHeavy: false, alive: false };
    }),
  };
}

/**
 * Produce a single SVG frame for the current env state at `tick`, using an
 * auto-fit camera. Optionally pass a camera for a shared render thread.
 */
export function renderEnvFrameSvg(
  env: BonkEnvironment,
  options: { width?: number; height?: number; ppm?: number; camera?: Camera; title?: string } = {},
): string {
  const width = options.width ?? 730;
  const height = options.height ?? 500;
  const cam = options.camera ?? computeCamera(width, height, options.ppm);
  const { geometry, deathCenter } = envMapRender(env);
  const mapCmds = buildGeometry(geometry, cam);
  const simSnap = envSimSnapshot(env);
  simSnap.deathCenter = deathCenter;
  const simCmds = buildSim(simSnap, cam, options.ppm);
  const opts: SvgRasterizerOptions = { width, height, title: options.title ?? 'bonk-rl-env' };
  return renderFrameSvg(mapCmds, simCmds, opts);
}