/**
 * Native Classic spawn selection for already-normalized static arenas.
 *
 * The arithmetic, candidate ordering, green/yellow fallback and repeated spawn
 * passes follow alpha2s.slot-accurate.js createNewState (4114-4258). In
 * particular, the seed advances once per authored spawn while ranking and
 * again for every deal attempt. Spawns are not consumed after dealing.
 *
 * This is deliberately not a MapDef converter: positions and velocities must
 * already be in world units (native createNewState's metre coordinate system).
 */

export type NativeTeam = 0 | 1 | 2 | 3 | 4 | 5;
export type NativeSlot<T> = T | null | undefined;

/** The native player fields used by createNewState. Extra presentation fields
 * are retained by the session, not consulted by spawn selection. */
export interface NativeSpawnPlayer {
  readonly id: number;
  readonly team: NativeTeam;
  /** True team 0 spectators never enter the native physics roster. */
  readonly spectator?: boolean;
}

/** Static, world-unit spawn data. `green` and `yellow` are authored values;
 * native fallback is applied during dealing, not by rewriting the input. */
export interface NativeSpawn {
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
  readonly priority: number;
  readonly ffa: boolean;
  readonly red: boolean;
  readonly blue: boolean;
  readonly green: boolean;
  readonly yellow: boolean;
}

export interface NativeSpawnAssignment {
  readonly playerId: number;
  readonly spawnIndex: number;
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
}

export interface NativeSpawnDeal {
  /** Native `state.seed` after ranking and all deal attempts. */
  readonly seed: number;
  /** Dense list of selected players; assignments still carry their sparse IDs. */
  readonly assignments: readonly NativeSpawnAssignment[];
}

export interface NativeSpawnInput {
  readonly spawns: readonly NativeSpawn[];
  readonly players: readonly NativeSpawnPlayer[];
  readonly seed: number;
  /** Native gameSettings.tea. False permits FFA as well as team-tagged players. */
  readonly teamsEnabled?: boolean;
}

function invalid(reason: string): never {
  throw new Error(`Invalid native spawn input: ${reason}`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function own(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) invalid(`${label}.${key} must be an own data property`);
  return descriptor.value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

const SPAWN_FIELDS = new Set(['x', 'y', 'xv', 'yv', 'priority', 'ffa', 'red', 'blue', 'green', 'yellow', 'n']);
const PLAYER_FIELDS = new Set([
  'id',
  'team',
  'spectator',
  'name',
  'color',
  'balance',
  'userName',
  'level',
  'ready',
  'avatar',
  'guest',
]);

function validateSpawn(value: unknown, index: number): NativeSpawn {
  const raw = record(value, `spawns[${index}]`);
  for (const key of Reflect.ownKeys(raw))
    if (typeof key !== 'string' || !SPAWN_FIELDS.has(key))
      invalid(`spawns[${index}] has unsupported field ${String(key)}`);
  const spawn: NativeSpawn = {
    x: finite(own(raw, 'x', `spawns[${index}]`), `spawns[${index}].x`),
    y: finite(own(raw, 'y', `spawns[${index}]`), `spawns[${index}].y`),
    xv: finite(own(raw, 'xv', `spawns[${index}]`), `spawns[${index}].xv`),
    yv: finite(own(raw, 'yv', `spawns[${index}]`), `spawns[${index}].yv`),
    priority: integer(own(raw, 'priority', `spawns[${index}]`), `spawns[${index}].priority`),
    ffa: boolean(own(raw, 'ffa', `spawns[${index}]`), `spawns[${index}].ffa`),
    red: boolean(own(raw, 'red', `spawns[${index}]`), `spawns[${index}].red`),
    blue: boolean(own(raw, 'blue', `spawns[${index}]`), `spawns[${index}].blue`),
    green: boolean(own(raw, 'green', `spawns[${index}]`), `spawns[${index}].green`),
    yellow: boolean(own(raw, 'yellow', `spawns[${index}]`), `spawns[${index}].yellow`),
  };
  return Object.freeze(spawn);
}

export function validateNativeSpawns(value: unknown): readonly NativeSpawn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024)
    invalid('spawns must be a nonempty array with at most 1024 entries');
  const result: NativeSpawn[] = [];
  for (let index = 0; index < value.length; index++)
    result.push(validateSpawn(own(value, String(index), 'spawns'), index));
  return Object.freeze(result);
}

function validatePlayers(value: unknown): readonly NativeSpawnPlayer[] {
  if (!Array.isArray(value) || value.length > 1024) invalid('players must be an array with at most 1024 entries');
  const seen = new Set<number>();
  const players: NativeSpawnPlayer[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = record(own(value, String(index), 'players'), `players[${index}]`);
    for (const key of Reflect.ownKeys(raw))
      if (typeof key !== 'string' || !PLAYER_FIELDS.has(key))
        invalid(`players[${index}] has unsupported field ${String(key)}`);
    const id = integer(own(raw, 'id', `players[${index}]`), `players[${index}].id`);
    if (id < 0 || id > 0xffffffff) invalid(`players[${index}].id must be in [0, 4294967295]`);
    if (seen.has(id)) invalid(`duplicate player ID ${id}`);
    seen.add(id);
    const team = integer(own(raw, 'team', `players[${index}]`), `players[${index}].team`);
    if (team < 0 || team > 5) invalid(`players[${index}].team must be in [0, 5]`);
    const spectator = Object.prototype.hasOwnProperty.call(raw, 'spectator')
      ? own(raw, 'spectator', `players[${index}]`)
      : false;
    if (typeof spectator !== 'boolean') invalid(`players[${index}].spectator must be boolean`);
    players.push(Object.freeze({ id, team: team as NativeTeam, spectator }));
  }
  return Object.freeze(players);
}

function eligible(spawn: NativeSpawn, team: NativeTeam, hasGreen: boolean, hasYellow: boolean): boolean {
  if (team === 0) return false;
  if (team === 1) return spawn.ffa;
  if (team === 2) return spawn.red;
  if (team === 3) return spawn.blue;
  if (team === 4) return hasGreen ? spawn.green : spawn.red;
  return hasYellow ? spawn.yellow : spawn.blue;
}

/**
 * Select a spawn for each eligible player. This preserves native input order,
 * including sparse player IDs; it never sorts IDs to make a dense roster.
 * Players with no compatible authored spawn produce no disc, as in native
 * createNewState. Supplying an entirely unspawnable roster is an invalid arena.
 */
export function dealNativeSpawns(input: NativeSpawnInput): NativeSpawnDeal {
  const raw = record(input, 'input');
  const spawns = validateNativeSpawns(own(raw, 'spawns', 'input'));
  const players = validatePlayers(own(raw, 'players', 'input'));
  let seed = integer(own(raw, 'seed', 'input'), 'seed');
  if (seed < 0 || seed > 0xffffffff) invalid('seed must be in [0, 4294967295]');
  const teamsEnabled = Object.prototype.hasOwnProperty.call(raw, 'teamsEnabled')
    ? own(raw, 'teamsEnabled', 'input')
    : false;
  if (typeof teamsEnabled !== 'boolean') invalid('teamsEnabled must be boolean');

  const hasGreen = spawns.some((spawn) => spawn.green);
  const hasYellow = spawns.some((spawn) => spawn.yellow);
  const ranked = spawns
    .map((spawn, spawnIndex) => {
      // Native performs += origin then /= ppm in createNewState. A caller that
      // already has native normalized data must not repeat that conversion.
      seed = (seed * 7) % 101;
      return { spawn, spawnIndex, priority: spawn.priority + (seed % 10) / 10 };
    })
    .sort((a, b) => b.priority - a.priority || a.spawnIndex - b.spawnIndex);

  // Native accepts FFA teams 2..5 when tea=false, but only 2..5 when tea=true.
  const pending = players
    .filter(
      (player) =>
        !player.spectator &&
        (!teamsEnabled || player.team >= 2) &&
        spawns.some((spawn) => eligible(spawn, player.team, hasGreen, hasYellow)),
    )
    .map((player) => player.id);
  if (pending.length === 0) throw new Error('Unsupported native static arena: no active player has an eligible spawn');

  const chosen = new Map<number, NativeSpawnAssignment>();
  while (pending.length > 0) {
    const before = pending.length;
    for (const entry of ranked) {
      if (pending.length === 0) break;
      const candidates = pending.filter((id) =>
        eligible(entry.spawn, players.find((player) => player.id === id)!.team, hasGreen, hasYellow),
      );
      if (candidates.length === 0) continue;
      let choice: number | undefined;
      do {
        seed = (seed * 7) % 101;
        // /9 is source-proven. A zero remainder can select one past the end;
        // native retries until its null selected slot check succeeds.
        choice = candidates[Math.floor(((seed % 10) / 9) * candidates.length)];
      } while (choice === undefined);
      chosen.set(
        choice,
        Object.freeze({
          playerId: choice,
          spawnIndex: entry.spawnIndex,
          x: entry.spawn.x,
          y: entry.spawn.y,
          xv: entry.spawn.xv,
          yv: entry.spawn.yv,
        }),
      );
      pending.splice(pending.indexOf(choice), 1);
    }
    if (pending.length === before) throw new Error('Invalid native spawn input: dealing made no progress');
  }

  // Native sparse discs are indexed by ID; returning dense assignments here
  // avoids accidentally treating a sparse array's holes as player records.
  const assignments = players.filter((player) => chosen.has(player.id)).map((player) => chosen.get(player.id)!);
  return Object.freeze({ seed, assignments: Object.freeze(assignments) });
}
