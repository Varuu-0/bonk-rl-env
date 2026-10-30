/**
 * Football native session adapter.
 *
 * Wraps the verified FootballPhysics backend (src/core/football-physics.ts)
 * in the NativeSession interface consumed by the environment layer. Football
 * is a standalone native physics class selected by room gameSettings.ga == "f"
 * (alpha2s :39729/:39788); it has no map JSON — the pitch is hardcoded
 * (730x500 px, ppm 11). Native football requires teams 2 and 3; the roster is
 * validated accordingly.
 *
 * Match lifecycle mapping:
 * - `ftu` (kickoff countdown, 120) maps to the countdown phase.
 * - `fte` (goal freeze, 90) maps to the round-result phase; the native reset
 *   at fte==0 restores kickoff positions with scores preserved (rc++).
 * - Scores/round winners follow the native football contract: `scores[2]`
 *   (red) and `scores[3]` (blue); lscr carries the last scoring team.
 */
import {
  createFootballPhysics,
  createFootballState,
  type FootballInput,
  type FootballPhysics,
  type FootballState,
} from './football-physics';
import type {
  NativeSession,
  NativeSessionEvents,
  NativeSessionPlayer,
  NativeSessionSnapshot,
  NativeSessionStep,
} from './native-session';

export interface NativeFootballSessionOptions {
  /** Dense configuration entries; only teams 2 and 3 receive discs. */
  readonly players: readonly NativeSessionPlayer[];
  readonly seed: number;
  /** Native gameSettings.wl (1..9, or 999 for no score limit). */
  readonly roundsToWin?: number;
}

export interface NativeFootballSession extends NativeSession {
  /** The immutable football state backing the snapshot (ball, sts, ppm). */
  getState(): NativeSessionSnapshot & { readonly football: FootballState };
}

const OPTION_FIELDS = new Set(['players', 'seed', 'roundsToWin']);
const CANONICAL_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const MAX_ID = 0xffffffff;
const PPM = 11;

function invalid(reason: string): never {
  throw new Error(`Invalid native football session input: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) invalid(`${label}.${key} must be an own data property`);
  return descriptor.value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

function validatePlayers(value: unknown): readonly NativeSessionPlayer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024)
    invalid('players must contain 1..1024 dense entries');
  const seen = new Set<number>();
  const players: NativeSessionPlayer[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = isRecord(value[index]) ? (value[index] as Record<string, unknown>) : null;
    if (!raw) invalid(`players[${index}] must be a plain object`);
    const id = integer(ownData(raw, 'id', `players[${index}]`), `players[${index}].id`);
    const team = integer(ownData(raw, 'team', `players[${index}]`), `players[${index}].team`);
    if (id < 0 || id > MAX_ID || seen.has(id)) invalid(`players[${index}].id must be unique and in [0, ${MAX_ID}]`);
    seen.add(id);
    if (team !== 2 && team !== 3) invalid(`players[${index}].team must be 2 or 3 (native football teams)`);
    if (
      Object.prototype.hasOwnProperty.call(raw, 'spectator') &&
      typeof ownData(raw, 'spectator', `players[${index}]`) !== 'boolean'
    ) {
      invalid(`players[${index}].spectator must be boolean`);
    }
    players.push(Object.freeze({ ...raw, id, team } as NativeSessionPlayer));
  }
  const team2 = players.filter((player) => player.team === 2 && !player.spectator).length;
  const team3 = players.filter((player) => player.team === 3 && !player.spectator).length;
  if (team2 === 0 || team3 === 0)
    invalid('native football requires at least one non-spectator on each of team 2 and team 3');
  return Object.freeze(players);
}

/**
 * Construct a native football session. Inputs are six-bit decoded records per
 * player (left/right/up/down/action/action2); action is the kick, action2
 * zeroes the movement force.
 */
export function createNativeFootballSession(options: NativeFootballSessionOptions): NativeFootballSession {
  if (!isRecord(options)) invalid('options must be a plain object');
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_FIELDS.has(key)) invalid(`options has unsupported field ${String(key)}`);
  }
  const players = validatePlayers(ownData(options, 'players', 'options'));
  const seed = integer(ownData(options, 'seed', 'options'), 'options.seed');
  if (seed < 0 || seed > MAX_ID) invalid(`options.seed must be in [0, ${MAX_ID}]`);
  const roundsToWin = Object.prototype.hasOwnProperty.call(options, 'roundsToWin')
    ? integer(ownData(options, 'roundsToWin', 'options'), 'options.roundsToWin')
    : 3;
  if (!((roundsToWin >= 1 && roundsToWin <= 9) || roundsToWin === 999))
    invalid('options.roundsToWin must be in [1, 9] or 999');

  const physics: FootballPhysics = createFootballPhysics();
  // Sparse roster by player array index (native football indexes discs by the
  // player array position, not by player.id).
  const roster: (NativeSessionPlayer | undefined)[] = [];
  for (const player of players) roster[player.id] = player;
  const sparsePlayers: (NativeSessionPlayer | undefined)[] = [];
  for (let index = 0; index < players.length; index++) sparsePlayers[index] = players[index];
  let state: FootballState = createFootballState(sparsePlayers, seed);
  let tick = 0;
  let matchComplete = false;
  let lastRoundResult: { winner: number | null; draw: boolean; score: number | null } | null = null;
  let disposed = false;

  function snapshot(): NativeSessionSnapshot & { readonly football: FootballState } {
    const roundResult = lastRoundResult === null ? null : Object.freeze({ ...lastRoundResult });
    return Object.freeze({
      tick,
      roundTick: tick,
      seed: state.seed,
      ftu: state.ftu,
      fte: state.fte,
      rl: tick,
      rc: state.rc ?? 0,
      lscr: state.lscr,
      winner: matchComplete ? state.lscr : null,
      draw: false,
      scores: Object.freeze([undefined, undefined, state.scores[2], state.scores[3]]),
      players: Object.freeze(roster.map((player) => (player === undefined ? undefined : Object.freeze({ ...player })))),
      discs: Object.freeze(
        state.discs.map((disc, index) =>
          disc === undefined
            ? undefined
            : Object.freeze({
                // Football discs are indexed by player array position; the public disc
                // id is that slot's player id.
                id: state.players[index]!.id,
                x: disc.x,
                y: disc.y,
                xv: disc.xv,
                yv: disc.yv,
                angle: 0,
                angularVelocity: 0,
                radius: 1,
                energy: 1000,
                heavy: false,
                alive: true,
                lhid: -1,
                lht: 0,
                ni: state.ni,
              }),
        ),
      ),
      platforms: Object.freeze([]),
      discDeaths: Object.freeze([]),
      phase:
        state.fte >= 0 ? ('round-result' as const) : state.ftu === -1 ? ('active' as const) : ('countdown' as const),
      matchComplete,
      roundResult,
      lastRoundResult: roundResult,
      football: state,
    });
  }

  function normalizeInputs(inputs: Readonly<Record<number, number>> | undefined): Map<number, FootballInput> {
    const raw = inputs ?? {};
    if (!isRecord(raw)) invalid('inputs must be a plain object');
    if (Object.getOwnPropertySymbols(raw).length > 0) invalid('inputs must not have symbol fields');
    const result = new Map<number, FootballInput>();
    for (const key of Object.getOwnPropertyNames(raw)) {
      if (!CANONICAL_DECIMAL_ID.test(key))
        invalid(`inputs key ${JSON.stringify(key)} is not a canonical decimal player ID`);
      const id = Number(key);
      if (!roster[id]) invalid(`inputs contains unknown player ${key}`);
      const value = ownData(raw, key, 'inputs');
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 63)
        invalid(`inputs[${key}] must be an integer in [0, 63]`);
      result.set(id, {
        left: (value & 1) !== 0,
        right: (value & 2) !== 0,
        up: (value & 4) !== 0,
        down: (value & 8) !== 0,
        action: (value & 16) !== 0,
        action2: (value & 32) !== 0,
      });
    }
    for (const player of players) {
      if (!player.spectator && !result.has(player.id))
        result.set(player.id, { left: false, right: false, up: false, down: false, action: false, action2: false });
    }
    return result;
  }

  function stepWithEvents(inputs: Readonly<Record<number, number>> = {}): NativeSessionStep {
    if (disposed) throw new Error('Native football session has been disposed');
    if (matchComplete) {
      return Object.freeze({ state: snapshot(), events: emptyEvents() });
    }
    const normalized = normalizeInputs(inputs);
    // Football physics indexes discs by the player array index; translate the
    // id-keyed public inputs to the sparse array positions.
    const indexed: Record<number, FootballInput> = {};
    for (const [id, input] of normalized) {
      const index = players.findIndex((player) => player.id === id);
      if (index >= 0 && !players[index]!.spectator) indexed[index] = input;
    }
    const previousLscr = state.lscr;
    const previousRc = state.rc ?? 0;
    state = physics.step(state, indexed);
    tick++;
    // A goal changes lscr; the round result is the scoring team. The event is
    // emitted on the scoring tick so the environment can score immediately.
    let goalResult: { winner: number; draw: boolean; score: number | null } | null = null;
    if (state.lscr !== previousLscr && (state.lscr === 2 || state.lscr === 3)) {
      goalResult = Object.freeze({ winner: state.lscr, draw: false, score: state.scores[state.lscr] ?? null });
      lastRoundResult = goalResult;
    }
    // Native gameComplete timing (readable :4430320/:4430629): the host fires
    // gameComplete when it processes a state whose fte==0 and the leading
    // score has reached gameSettings.wl (gt==2), then returns — the goal-freeze
    // reset that the next physics step would perform never runs. The scoring
    // tick itself only starts the 90-tick goal freeze. matchComplete therefore
    // flips when the step OUTPUT reaches fte==0 (90 ticks after the goal), and
    // the early-return below keeps the reset from firing: the final state is
    // the frozen goal state, exactly like the native results screen.
    if (
      !matchComplete &&
      state.fte === 0 &&
      ((state.scores[2] ?? 0) >= roundsToWin || (state.scores[3] ?? 0) >= roundsToWin)
    ) {
      matchComplete = true;
    }
    const events: NativeSessionEvents = Object.freeze({
      deaths: Object.freeze([]),
      respawns: Object.freeze(state.ni ? players.map((player) => player.id) : []),
      roundResult: goalResult,
      lastRoundResult: lastRoundResult === null ? null : Object.freeze({ ...lastRoundResult }),
      newRound: (state.rc ?? 0) !== previousRc,
      capZoneContacts: Object.freeze([]),
      capZoneTeamGoals: Object.freeze([]),
    });
    return Object.freeze({ state: snapshot(), events });
  }

  function emptyEvents(): NativeSessionEvents {
    return Object.freeze({
      deaths: Object.freeze([]),
      respawns: Object.freeze([]),
      roundResult: null,
      lastRoundResult: lastRoundResult === null ? null : Object.freeze({ ...lastRoundResult }),
      newRound: false,
      capZoneContacts: Object.freeze([]),
      capZoneTeamGoals: Object.freeze([]),
    });
  }

  return Object.freeze({
    getState: snapshot,
    getEvents: (): NativeSessionEvents => emptyEvents(),
    step(inputs: Readonly<Record<number, number>> = {}): NativeSessionSnapshot {
      return stepWithEvents(inputs).state;
    },
    stepWithEvents,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      physics.dispose();
    },
  });
}
