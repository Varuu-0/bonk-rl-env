/**
 * replay-comparator.ts — P4 differential validation: replay a recorded native
 * trace against the local engine and compare per-tick disc state.
 *
 * The comparator rebuilds the traced world by running the same construction
 * path the environment uses (normalizeMap → BonkEnvironment), seeds each
 * player at the traced spawn, replays the recorded Discrete(64) inputs per
 * tick (falling back to a neutral input when the trace has none), then compares
 * the engine's per-player `getPlayerState()` against the recorded disc
 * kinematics at every tick.
 *
 * Verdicts:
 *  - per-field tolerances (position map px, velocity map px/s, angle rad,
 *    angular velocity rad/s) — each tick must be within ALL tolerances,
 *  - a missing native disc where the engine reports alive (or vice versa) is a
 *    mismatch,
 *  - the run PASSES only when every compared tick is within tolerance.
 *
 * Grounding: coordinate reconciliation (§9.5) proves engine getPlayerState
 * units == native disc units 1:1, so diffs are compared directly in map units.
 */
import { BonkEnvironment } from '../environment';
import { normalizeMap } from '../map-adapter';
import type { PlayerInput } from '../physics-engine';
import type { NativeTrace } from './native-trace';

// Same port the engine binds (physics-engine.ts:15): b2Vec2 for re-seeding.
const box2d = require('box2d');
const b2Vec2 = box2d.b2Vec2;

export interface DifferentialTolerances {
  /** Position error per axis in map px. */
  position: number;
  /** Velocity error per axis in map px/s. */
  velocity: number;
  /** Angle error in radians. */
  angle: number;
  /** Angular-velocity error in rad/s. */
  angularVelocity: number;
}

export interface DiscAxesDiff {
  id: number;
  dx: number;
  dy: number;
  dvx: number;
  dvy: number;
  da: number;
  dav: number;
}

export interface TickComparison {
  tick: number;
  compared: DiscAxesDiff[];
  mismatches: Array<{ id: number; reason: string }>;
  /** True when every compared disc was within tolerance. */
  withinTolerance: boolean;
}

export interface DifferentialVerdict {
  /** True when the whole trace replayed within tolerance (and no mismatch). */
  pass: boolean;
  ticksCompared: number;
  ticksOutsideTolerance: number;
  /** Worst error per field across all compared discs (data rows). */
  worst: {
    dx: number; dy: number; dvx: number; dvy: number; da: number; dav: number;
  };
  perTick: TickComparison[];
  /** Count of ticks skipped because the trace carried no inputs and no discs. */
  skippedNoData: number;
}

export interface ComparatorOptions {
  seed?: number;
  tolerances?: Partial<DifferentialTolerances>;
  /** Override map settings from the trace (normally trace.settings wins). */
  settingsOverrides?: { pq?: number };
  /** Called after environment construction and player seeding (test hooks). */
  onReady?: (env: BonkEnvironment) => void;
}

const DEFAULT_TOLERANCES: DifferentialTolerances = {
  position: 0.5,
  velocity: 1.0,
  angle: 0.05,
  angularVelocity: 0.5,
};

/**
 * Rebuild the traced world inside a fresh BonkEnvironment and seed every traced
 * player at its recorded spawn, returning an environment whose `step` advances
 * the same physics the native trace describes. The caller owns close().
 */
export function buildTraceEnvironment(
  trace: NativeTrace,
  opts: ComparatorOptions = {},
): BonkEnvironment {
  // Merge the trace's native settings (and any explicit overrides) into the
  // RAW map's settings before normalization, so the adapter's settings
  // sanitizer forwards them into mapDef.settings — the only path
  // BonkEnvironment reads pq/re/nc/gd/fl from (environment.ts:
  // physicsQuality <- mapData.settings.pq). Passing settings through the
  // config.physics object is silently dropped by the environment. The map is
  // shallow-cloned so the caller's trace object is never mutated.
  const rawMap: any = trace.map;
  const mapObj: any = (rawMap !== null && typeof rawMap === 'object' && !Array.isArray(rawMap))
    ? { ...rawMap }
    : rawMap;
  const overrides = { ...(trace.settings ?? {}), ...(opts.settingsOverrides ?? {}) };
  if (Object.keys(overrides).length > 0 && mapObj !== null && typeof mapObj === 'object') {
    mapObj.settings = { ...(mapObj.settings ?? {}), ...overrides };
  }
  const mapDef = normalizeMap(mapObj);
  const players = trace.players.map(p => p.id);

  const env = new BonkEnvironment({
    numOpponents: Math.max(0, players.length - 1),
    seed: opts.seed ?? 42,
    mapData: mapDef as any,
    randomOpponent: false,
    maxTicks: trace.ticks.length + 8,
  } as any);

  // reset() spawns players at map spawn points; re-position each engine body to
  // the exact native spawn (map units / scale) so the replay starts from the
  // recorded state, mirroring the native round start.
  const physics: any = (env as any).physics;
  const scale: number = physics.scale;
  for (const spawn of trace.spawns) {
    const body = physics.playerBodies?.get(spawn.id);
    if (body) {
      // Port API: SetXForm(position, angle) — the b2XForm-based equivalent of
      // SetPosition (this port has no SetPosition, see box2dnode b2Body).
      body.SetXForm(new b2Vec2(spawn.x / scale, spawn.y / scale), 0);
      body.SetLinearVelocity(new b2Vec2(0, 0));
      body.SetAngularVelocity(0);
      body.WakeUp();
    }
  }

  opts.onReady?.(env);
  return env;
}

function decodeInput(bits: number | undefined): PlayerInput {
  const b = bits ?? 0;
  return {
    left: !!(b & 1),
    right: !!(b & 2),
    up: !!(b & 4),
    down: !!(b & 8),
    heavy: !!(b & 16),
    grapple: !!(b & 32),
  };
}

/**
 * Replay a native trace through a fresh environment and compare every tick.
 * Returns the verdict plus per-tick diffs for inspection.
 */
export function compareTrace(
  trace: NativeTrace,
  opts: ComparatorOptions = {},
): DifferentialVerdict {
  const tol = { ...DEFAULT_TOLERANCES, ...(opts.tolerances ?? {}) };
  const env = buildTraceEnvironment(trace, opts);
  try {
    const physics: any = (env as any).physics;
    const perTick: TickComparison[] = [];
    let ticksOutsideTolerance = 0;
    let skippedNoData = 0;
    const worst = { dx: 0, dy: 0, dvx: 0, dvy: 0, da: 0, dav: 0 };

    for (const recorded of trace.ticks) {
      // Replay this tick's inputs for each recorded player.
      const inputs = recorded.inputs ?? [];
      for (let id = 0; id < recorded.discs.length; id++) {
        if (recorded.discs[id]) physics.applyInput(id, decodeInput(inputs[id]));
      }
      // Neutral input for any traced player without a record so the world still
      // advances (matches the no-data fallback path).
      physics.tick();

      const compared: DiscAxesDiff[] = [];
      const mismatches: TickComparison['mismatches'] = [];
      let withinTolerance = true;

      // The discs array is index-aligned by player id: entries[i] is player i.
      recorded.discs.forEach((rec, id) => {
        if (!rec) {
          // Native says the disc is absent this tick. It must be absent in the
          // engine too — a living engine disc here is a mismatch that fails
          // the tick (and therefore the verdict): death agreement is part of
          // the differential gate, not informational noise.
          const st = physics.getPlayerState(id);
          if (st && st.alive) {
            mismatches.push({ id, reason: 'native absent but engine alive' });
            withinTolerance = false;
          }
          return;
        }
        const st = physics.getPlayerState(id);
        if (!st || !st.alive) {
          mismatches.push({ id, reason: 'native present but engine dead/absent' });
          withinTolerance = false;
          return;
        }
        const row: DiscAxesDiff = {
          id,
          dx: Math.abs(st.x - rec.x),
          dy: Math.abs(st.y - rec.y),
          dvx: Math.abs(st.velX - rec.xv),
          dvy: Math.abs(st.velY - rec.yv),
          da: Math.abs(st.angle - rec.a),
          dav: Math.abs(st.angularVel - rec.av),
        };
        compared.push(row);
        worst.dx = Math.max(worst.dx, row.dx);
        worst.dy = Math.max(worst.dy, row.dy);
        worst.dvx = Math.max(worst.dvx, row.dvx);
        worst.dvy = Math.max(worst.dvy, row.dvy);
        worst.da = Math.max(worst.da, row.da);
        worst.dav = Math.max(worst.dav, row.dav);

        if (
          row.dx > tol.position || row.dy > tol.position ||
          row.dvx > tol.velocity || row.dvy > tol.velocity ||
          row.da > tol.angle || row.dav > tol.angularVelocity
        ) {
          withinTolerance = false;
        }
      });

      const hadData = compared.length > 0 || mismatches.length > 0;
      if (!hadData) skippedNoData++;
      if (!withinTolerance) ticksOutsideTolerance++;
      perTick.push({ tick: recorded.t, compared, mismatches, withinTolerance });
    }

    return {
      pass: ticksOutsideTolerance === 0,
      ticksCompared: perTick.length,
      ticksOutsideTolerance,
      worst,
      perTick,
      skippedNoData,
    };
  } finally {
    env.close();
  }
}