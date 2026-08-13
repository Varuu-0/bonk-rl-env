/**
 * native-trace.ts — P4 differential validation: the recorded-match trace format.
 *
 * A "native trace" is a faithful, versioned recording of one bonk.io round in
 * terms of what the real client exposes at runtime:
 *
 *  - the raw exported map (state.physics / gs.map) so the local engine can
 *    rebuild the identical world through `normalizeMap`,
 *  - the native map settings (`s`/`ms`: re, nc, pq, gd, fl),
 *  - one player record per disc slot (id + team),
 *  - per-tick disc kinematics sampled from the serialized `state.discs[i]`
 *    (LIVE_STATE_EXTRACTION §9.4: x,y,xv,yv,a,av,a1,a2,a1a,team,ds),
 *  - optionally the per-player Discrete(64) input bytes replayed alongside.
 *
 * Schema is versioned (bump `TRACE_SCHEMA_VERSION` with breaking changes).
 *
 * Grounding:
 *  - LIVE_STATE_EXTRACTION.md §9.4 — the exported disc field set.
 *  - LIVE_STATE_EXTRACTION.md §9.2  — alive == presence in state.discs.
 *  - LIVE_STATE_EXTRACTION.md §9.1  — tick = per-round rebase of native `fig`.
 *  - DEOBFUSCATION.md §33.1          — native settings defaults/guards.
 */
export const TRACE_SCHEMA = 'bonk.rl.env.native-trace';
export const TRACE_SCHEMA_VERSION = 1;

/** One disc snapshot at one tick (native map units; matching state.discs[i]). */
export interface NativeTraceDisc {
  /** Player/disc slot id (state.discs index). */
  id: number;
  /** Position in native map units. */
  x: number;
  y: number;
  /** Linear velocity in map units/tick-domain seconds. */
  xv: number;
  yv: number;
  /** Angle (radians). */
  a: number;
  /** Angular velocity (rad/s). */
  av: number;
  /** Heavy input bit (native `a1`). */
  a1?: boolean;
  /** Grapple input bit (native `a2`). */
  a2?: boolean;
  /** Grapple energy (native `a1a`). */
  a1a?: number;
  /** Team number. */
  team?: number;
  /** Disc state (native `ds`; 0 = normal). */
  ds?: number;
  /** Alive == present in state.discs (§9.2). */
  alive: boolean;
}

/** One tick of the match. */
export interface NativeTraceTick {
  /** Rebased per-round tick (0-based), mirroring the training obs tick. */
  t: number;
  /** Native monotonic frame (fig) if captured; optional. */
  fig?: number;
  /** Per-player Discrete(64) input byte (index = player id) if captured. */
  inputs?: number[];
  /** Disc snapshots, aligned by player id; null when the disc is absent. */
  discs: (NativeTraceDisc | null)[];
}

export interface NativeTracePlayer {
  id: number;
  team?: number;
}

export interface NativeTraceSpawn {
  id: number;
  x: number;
  y: number;
}

/** A recorded native match, versioned. */
export interface NativeTrace {
  schema: typeof TRACE_SCHEMA;
  version: number;
  /** Native physics tick rate. */
  tps: number;
  /** Raw exported map (as mapexporter emits it) so the engine can rebuild. */
  map: unknown;
  /** Native map settings (`s`/`ms`). */
  settings?: { re?: boolean; nc?: boolean; pq?: number; gd?: number; fl?: boolean };
  /** Player roster in disc-slot order. */
  players: NativeTracePlayer[];
  /** Spawn points per player id. */
  spawns: NativeTraceSpawn[];
  /** Ticks in ascending order. */
  ticks: NativeTraceTick[];
}

/** Optional per-tick per-player input; provided when recording the local input. */
export interface NativeTraceInputTick {
  t: number;
  inputs: number[];
}

export interface ParsedTrace {
  trace: NativeTrace;
  errors: string[];
}

/**
 * Parse and validate a native trace object (from JSON). Returns the typed trace
 * plus a list of validation errors. Throws on a structurally-unsound input
 * (non-object, missing schema marker, non-array fields). Null/non-object
 * entries inside players, spawns, and ticks are reported as errors and omitted
 * from the returned trace, so downstream iteration stays safe even when a
 * caller ignores the errors. The embedded map is normalized by the replay
 * comparator (which owns the normalizeMap import).
 */
export function parseNativeTrace(raw: unknown): ParsedTrace {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('native trace must be a JSON object');
  }
  const t = raw as NativeTrace;

  if (t.schema !== TRACE_SCHEMA) {
    errors.push(`expected schema "${TRACE_SCHEMA}", got "${String(t.schema)}"`);
  }
  if (typeof t.version !== 'number') {
    errors.push('version must be a number');
  } else if (t.version !== TRACE_SCHEMA_VERSION) {
    errors.push(`unsupported schema version ${t.version} (this build reads v${TRACE_SCHEMA_VERSION})`);
  }
  if (!(t.tps > 0)) errors.push('tps must be a positive number');
  if (!Array.isArray(t.players)) errors.push('players must be an array');
  if (!Array.isArray(t.spawns)) errors.push('spawns must be an array');
  if (!Array.isArray(t.ticks)) errors.push('ticks must be an array');

  if (errors.length === 0) {
    if (t.map === null || typeof t.map !== 'object' || Array.isArray(t.map)) {
      errors.push('map must be an object (the raw exported map)');
    }
    const seenIds = new Set<number>();
    for (const p of t.players) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        errors.push('player entries must be objects');
        continue;
      }
      if (typeof p.id !== 'number' || p.id < 0) errors.push('player id must be a non-negative number');
      if (seenIds.has(p.id)) errors.push(`duplicate player id ${p.id}`);
      seenIds.add(p.id);
    }
    for (const s of t.spawns) {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        errors.push('spawn entries must be objects');
        continue;
      }
      if (typeof s.id !== 'number' || s.id < 0) errors.push(`spawn id invalid: ${String(s.id)}`);
      if (typeof s.x !== 'number' || !Number.isFinite(s.x)) errors.push(`spawn ${s.id} x must be a finite number`);
      if (typeof s.y !== 'number' || !Number.isFinite(s.y)) errors.push(`spawn ${s.id} y must be a finite number`);
    }
    for (const tick of t.ticks) {
      if (tick === null || typeof tick !== 'object' || Array.isArray(tick)) {
        errors.push('tick entries must be objects');
        continue;
      }
      if (typeof tick.t !== 'number' || tick.t < 0) errors.push(`tick index invalid: ${String(tick.t)}`);
      if (!Array.isArray(tick.discs)) errors.push(`tick ${tick.t} has no discs array`);
    }
  }

  const trace: NativeTrace = {
    schema: TRACE_SCHEMA,
    version: TRACE_SCHEMA_VERSION,
    tps: t.tps,
    map: t.map,
    settings: t.settings,
    players: Array.isArray(t.players)
      ? t.players.filter((p): p is NativeTracePlayer => p !== null && typeof p === 'object' && !Array.isArray(p))
      : [],
    spawns: Array.isArray(t.spawns)
      ? t.spawns.filter((s): s is NativeTraceSpawn => s !== null && typeof s === 'object' && !Array.isArray(s))
      : [],
    ticks: Array.isArray(t.ticks)
      ? t.ticks.filter((tk): tk is NativeTraceTick => tk !== null && typeof tk === 'object' && !Array.isArray(tk))
      : [],
  };

  return { trace, errors };
}

/** Serialize a trace to a JSON string (stable key order via a plain object). */
export function serializeNativeTrace(trace: NativeTrace): string {
  return JSON.stringify(structuredCloneSafe(trace), null, 2);
}

function structuredCloneSafe<T>(v: T): T {
  // Keep the write dependency-free: JSON round-trip is fine for this pure
  // serialize path (numbers/booleans/arrays only).
  return JSON.parse(JSON.stringify(v)) as T;
}
