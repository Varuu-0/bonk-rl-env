/**
 * capture-recorder.ts — P4 capture harness: per-tick recording of native disc
 * state into a NativeTrace.
 *
 * The recorder consumes ONE object per tick, shaped like the live client's
 * serialized `state.discs[i]` (field set verified in
 * LIVE_STATE_EXTRACTION §9.4: x,y,xv,yv,a,av,a1,a2,a1a,team,ds), plus the
 * per-round rebased tick. It appends a NativeTraceTick and can also record the
 * local/secondary player Discrete(64) input byte so the replay comparator can
 * reproduce the inputs deterministically.
 *
 * This is the offline-testable core of the capture harness: the same mapping a
 * browser userscript performs (see Webscripts/rl-trace-capture.user.js) is
 * exercised here against deterministic fixture state, so the harness logic is
 * validated without a live match.
 */
import type {
  NativeTrace,
  NativeTraceDisc,
  NativeTracePlayer,
  NativeTraceSpawn,
  NativeTraceTick,
} from './native-trace';
import { TRACE_SCHEMA, TRACE_SCHEMA_VERSION } from './native-trace';

/** One native disc object as read from `state.discs[i]` (§9.4 field set). */
export interface NativeDiscState {
  x?: number;
  y?: number;
  xv?: number;
  yv?: number;
  a?: number;
  av?: number;
  a1?: unknown;   // heavy input bit (boolean in the live export)
  a2?: unknown;   // grapple input bit (boolean in the live export)
  a1a?: number;   // grapple energy
  team?: number;
  ds?: number;
}

export interface NativeStateTick {
  /** Per-round rebased tick (0-based), produced by the bridge's fig rebase. */
  t: number;
  /** Native monotonic frame (fig) if the injector captured it. */
  fig?: number;
  /** state.discs: index-aligned; a missing entry means the disc is absent. */
  discs: (NativeDiscState | undefined)[];
  /** Optional Discrete(64) input per player id for deterministic replay. */
  inputs?: Record<number, number>;
}

export interface RecorderSettings {
  tps?: number;
  map: unknown;
  settings?: { re?: boolean; nc?: boolean; pq?: number; gd?: number; fl?: boolean };
  players: NativeTracePlayer[];
  spawns: NativeTraceSpawn[];
}

/**
 * Incremental recorder that turns per-tick native state into a NativeTrace.
 */
export class NativeTraceRecorder {
  private readonly settings: RecorderSettings;
  private ticks: NativeTraceTick[] = [];

  constructor(settings: RecorderSettings) {
    this.settings = settings;
  }

  /** Append one tick's disc states. */
  push(state: NativeStateTick): void {
    const discs: (NativeTraceDisc | null)[] = [];
    for (let id = 0; id < state.discs.length; id++) {
      const d = state.discs[id];
      if (d === undefined || d === null) {
        discs.push(null);
      } else {
        discs.push({
          id,
          x: d.x ?? 0,
          y: d.y ?? 0,
          xv: d.xv ?? 0,
          yv: d.yv ?? 0,
          a: d.a ?? 0,
          av: d.av ?? 0,
          a1: d.a1 === true,
          a2: d.a2 === true,
          a1a: typeof d.a1a === 'number' ? d.a1a : undefined,
          team: d.team,
          ds: d.ds,
          alive: true,
        });
      }
    }

    const tick: NativeTraceTick = {
      t: state.t,
      discs,
    };
    if (typeof state.fig === 'number') tick.fig = state.fig;
    if (state.inputs) {
      const inputs: number[] = [];
      for (const id of Object.keys(state.inputs)) {
        inputs[Number(id)] = state.inputs[Number(id)];
      }
      tick.inputs = inputs;
    }
    this.ticks.push(tick);
  }

  /** Finalize into a serializable NativeTrace. */
  toTrace(): NativeTrace {
    return {
      schema: TRACE_SCHEMA,
      version: TRACE_SCHEMA_VERSION,
      tps: this.settings.tps ?? 30,
      map: this.settings.map,
      settings: this.settings.settings,
      players: this.settings.players,
      spawns: this.settings.spawns,
      ticks: this.ticks,
    };
  }
}