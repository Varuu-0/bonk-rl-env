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
 *  - a null disc the engine agrees is dead counts as compared data when the
 *    trace previously showed that player alive (death-agreement tick),
 *  - the run PASSES only when every compared tick is within tolerance and at
 *    least one tick had comparable data (an all-skipped trace is not a pass).
 *
 * Grounding: coordinate reconciliation (§9.5) proves engine getPlayerState
 * units == native disc units 1:1, so diffs are compared directly in map units.
 */
import { BonkEnvironment } from '../environment';
import { normalizeMap } from '../map-adapter';
import type { PlayerInput } from '../physics-engine';
import { isNativeTraceDisc, isReplayableInputByte } from './native-trace';
import type { NativeTrace, NativeTraceDisc } from './native-trace';
import { decodeEncodedAction } from '../action-validation';

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
  /**
   * Per-slot failures that fail the tick, of two kinds: corrupt recorded
   * data (a malformed input byte, a malformed disc entry) and engine-vs-native
   * divergence ('native absent but engine alive', 'native present but engine
   * dead/absent', 'non-finite disc diff'). `id` is always a real player id —
   * whole-tick corruptions belong in `tickErrors`, not here.
   */
  playerErrors: Array<{ id: number; reason: string }>;
  /**
   * Whole-tick corruptions that fail the tick but belong to no player slot
   * (e.g. a present-but-non-array `inputs` container). Kept separate from
   * `playerErrors` so the player-id space stays un-overloaded.
   */
  tickErrors: string[];
  /** True when every compared disc was within tolerance. */
  withinTolerance: boolean;
}

export interface DifferentialVerdict {
  /** True when the trace had comparable data and replayed within tolerance. */
  pass: boolean;
  ticksCompared: number;
  ticksOutsideTolerance: number;
  /** Worst error per field across all compared discs (data rows). */
  worst: {
    dx: number;
    dy: number;
    dvx: number;
    dvy: number;
    da: number;
    dav: number;
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
export function buildTraceEnvironment(trace: NativeTrace, opts: ComparatorOptions = {}): BonkEnvironment {
  // Merge the trace's native settings (and any explicit overrides) into the
  // RAW map's settings before normalization, so the adapter's settings
  // sanitizer forwards them into mapDef.settings — the only path
  // BonkEnvironment reads pq/re/nc/gd/fl from (environment.ts:
  // physicsQuality <- mapData.settings.pq). Passing settings through the
  // config.physics object is silently dropped by the environment. The map is
  // shallow-cloned so the caller's trace object is never mutated.
  const rawMap: any = trace.map;
  const mapObj: any = rawMap !== null && typeof rawMap === 'object' && !Array.isArray(rawMap) ? { ...rawMap } : rawMap;
  const overrides = { ...(trace.settings ?? {}), ...(opts.settingsOverrides ?? {}) };
  if (Object.keys(overrides).length > 0 && mapObj !== null && typeof mapObj === 'object') {
    mapObj.settings = { ...(mapObj.settings ?? {}), ...overrides };
  }
  const mapDef = normalizeMap(mapObj);
  const players = trace.players.map((p) => p.id);

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
  return decodeEncodedAction(bits ?? 0);
}

/**
 * Comparator-side disc gate: a disc only counts as replayable/comparable when
 * it is a fully-valid native disc AND its `id` matches the array slot it sits
 * in (the slot-alignment invariant `parseNativeTrace` enforces at parse time).
 * A misaligned disc must not drive replayed inputs or be compared against the
 * player of its slot — treat it exactly like any other malformed entry.
 */
function isAlignedTraceDisc(value: unknown, slot: number): value is NativeTraceDisc {
  if (!isNativeTraceDisc(value)) return false;
  return value.id === slot;
}

/**
 * Replay a native trace through a fresh environment and compare every tick.
 * Returns the verdict plus per-tick diffs for inspection.
 */
export function compareTrace(trace: NativeTrace, opts: ComparatorOptions = {}): DifferentialVerdict {
  const tol = { ...DEFAULT_TOLERANCES, ...(opts.tolerances ?? {}) };
  const env = buildTraceEnvironment(trace, opts);
  try {
    const physics: any = (env as any).physics;
    const perTick: TickComparison[] = [];
    let ticksOutsideTolerance = 0;
    let skippedNoData = 0;
    const worst = { dx: 0, dy: 0, dvx: 0, dvy: 0, da: 0, dav: 0 };
    // Players the native trace has shown alive so far. A later null entry for
    // such a player (with the engine agreeing it is dead) is a death-agreement
    // tick — informative compared data, not a no-data skip — so a replay that
    // faithfully reproduces mid-run deaths still counts every tick.
    const aliveSeen = new Set<number>();

    for (const recorded of trace.ticks) {
      // Drain deferred respawns BEFORE applying this tick's inputs (#430):
      // mirrors BonkEnvironment.step()'s #409 ordering. A disc queued by the
      // previous tick's death pass must be alive at its spawn when applyInput
      // runs, or the recorded revival-tick input byte is silently dropped by
      // the engine's alive-guard and the replay diverges from native/engine.
      // tick()'s own drain is idempotent, so this extra call is a no-op
      // whenever nothing is queued.
      physics.processRespawns();

      // Replay this tick's inputs for each recorded player. A corrupt byte
      // must not drive replay (#450): the slot falls back to the neutral
      // action — the same fallback a missing byte takes — and is flagged
      // below, failing the tick loudly instead of silently executing a
      // fabricated button press. The bytes are vetted in one O(n) pass up
      // front (inputs.length is caller-controlled, so no includes() rescan
      // per slot), and the vetting is independent of disc state: a corrupt
      // byte on a null or misaligned slot is corruption all the same.
      // A present-but-non-array container (which parseNativeTrace rejects
      // outright) is a tick-level corruption, flagged once below — outside
      // the aligned-disc loop, so a tick with zero aligned discs still fails
      // instead of silently passing on a trace the parser rejected.
      const inputs = Array.isArray(recorded.inputs) ? recorded.inputs : [];
      const inputsMalformed = recorded.inputs !== undefined && !Array.isArray(recorded.inputs);
      const corruptBytes = new Set<number>();
      for (let id = 0; id < inputs.length; id++) {
        if (!isReplayableInputByte(inputs[id])) corruptBytes.add(id);
      }
      for (let id = 0; id < recorded.discs.length; id++) {
        if (!isAlignedTraceDisc(recorded.discs[id], id)) continue;
        if (inputsMalformed) {
          // Present-but-non-array input set: neutral fallback per aligned
          // slot; the tick-level flag below carries the failure.
          physics.applyInput(id, decodeInput(0));
        } else if (id >= inputs.length) {
          // No recorded byte for this slot: the documented neutral fallback.
          physics.applyInput(id, decodeInput(undefined));
        } else if (corruptBytes.has(id)) {
          physics.applyInput(id, decodeInput(0));
        } else {
          physics.applyInput(id, decodeInput(inputs[id]));
        }
      }
      // Neutral input for any traced player without a record so the world still
      // advances (matches the no-data fallback path).
      physics.tick();

      const compared: DiscAxesDiff[] = [];
      const mismatches: TickComparison['playerErrors'] = [];
      const tickErrors: string[] = [];
      let withinTolerance = true;
      let deathAgreements = 0;

      // Corrupt input bytes (#450) fail the tick: the replayed slot was
      // downgraded to the neutral fallback, so the tick cannot be vouched
      // for even when the kinematic diff happens to stay within tolerance.
      // The vetting pass is disc-independent, so bytes on null or misaligned
      // slots are flagged too — they are unplayable by definition.
      for (const id of corruptBytes) {
        mismatches.push({ id, reason: 'malformed input byte' });
        withinTolerance = false;
      }
      // Malformed input-set container (#450): a whole-tick corruption carried
      // as a tick-level error instead of a per-player entry — it belongs to no
      // player slot, so the sentinel id would overload the contract. Flagged
      // once, outside the aligned-disc loop, so a tick with zero aligned discs
      // still fails instead of silently passing on a trace parseNativeTrace
      // rejects. The tick stays comparable data (tickErrors counts toward
      // hadData below), so it lands in ticksOutsideTolerance — never in
      // skippedNoData.
      if (inputsMalformed) {
        tickErrors.push('malformed input set');
        withinTolerance = false;
      }

      // The discs array is index-aligned by player id: entries[i] is player i.
      recorded.discs.forEach((rec, id) => {
        if (rec === null || rec === undefined) {
          // Native says the disc is absent this tick. It must be absent in the
          // engine too — a living engine disc here is a mismatch that fails
          // the tick (and therefore the verdict): death agreement is part of
          // the differential gate, not informational noise.
          const st = physics.getPlayerState(id);
          if (st && st.alive) {
            mismatches.push({ id, reason: 'native absent but engine alive' });
            withinTolerance = false;
          } else if (aliveSeen.has(id)) {
            // The trace previously showed this player alive and the engine
            // killed it on the same tick: the replay reproduced the native
            // death, so this tick counts as compared data.
            deathAgreements++;
          }
          return;
        }
        if (!isAlignedTraceDisc(rec, id)) {
          mismatches.push({ id, reason: 'malformed disc entry' });
          withinTolerance = false;
          return;
        }
        aliveSeen.add(id);
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
        if (
          !Number.isFinite(row.dx) ||
          !Number.isFinite(row.dy) ||
          !Number.isFinite(row.dvx) ||
          !Number.isFinite(row.dvy) ||
          !Number.isFinite(row.da) ||
          !Number.isFinite(row.dav)
        ) {
          mismatches.push({ id, reason: 'non-finite disc diff' });
          withinTolerance = false;
          return;
        }
        compared.push(row);
        worst.dx = Math.max(worst.dx, row.dx);
        worst.dy = Math.max(worst.dy, row.dy);
        worst.dvx = Math.max(worst.dvx, row.dvx);
        worst.dvy = Math.max(worst.dvy, row.dvy);
        worst.da = Math.max(worst.da, row.da);
        worst.dav = Math.max(worst.dav, row.dav);

        if (
          row.dx > tol.position ||
          row.dy > tol.position ||
          row.dvx > tol.velocity ||
          row.dvy > tol.velocity ||
          row.da > tol.angle ||
          row.dav > tol.angularVelocity
        ) {
          withinTolerance = false;
        }
      });

      // A tick carrying a tick-level error is comparable data (its corruption
      // was examined and failed the gate), so it must land in
      // ticksCompared/ticksOutsideTolerance — never in skippedNoData, whose
      // count is reserved for ticks with genuinely nothing to examine.
      const hadData = compared.length > 0 || mismatches.length > 0 || tickErrors.length > 0 || deathAgreements > 0;
      if (!hadData) skippedNoData++;
      if (!withinTolerance) ticksOutsideTolerance++;
      perTick.push({
        tick: recorded.t,
        compared,
        playerErrors: mismatches,
        tickErrors,
        withinTolerance,
      });
    }

    const comparedTicks = perTick.length - skippedNoData;
    return {
      // A trace with no comparable ticks cannot establish a differential pass.
      pass: ticksOutsideTolerance === 0 && comparedTicks > 0,
      // Actual compared ticks: skips the no-data ticks that contributed nothing.
      ticksCompared: comparedTicks,
      ticksOutsideTolerance,
      worst,
      perTick,
      skippedNoData,
    };
  } finally {
    env.close();
  }
}
