/**
 * Independently written Football physics tick.
 *
 * The algorithm is reconstructed from the retained reference at
 * `.deobf/alpha2s.slot-accurate.numeric.js` (FootballPhysics.createNewState
 * :12864-12926, FootballPhysics.prototype.step :13333-13544, Ball :13545-13589,
 * FootballPlayer :13590-13717, FootballWall :13718-13935) and uses the packaged
 * modified Box2D backend. Football is a standalone physics class: one world
 * with gravity (0,0), a hardcoded pitch (730x500 px, ppm 11), a ball, players
 * and wall/goal-post fixtures. It deliberately does not import match
 * lifecycle, spawn selection or any map loader.
 *
 * The world is rebuilt from the supplied state on every step, mirroring the
 * native `novakReset()` + recreate pattern. All inputs are validated before
 * the world is touched. Bodies are destroyed after state extraction; the next
 * step recreates the solver/contact bookkeeping as in the reference.
 */

import { createBackend } from './backend';

/** Native football player disc state (sparse by player array index). */
export interface FootballPlayerDisc {
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
  readonly team: number;
  readonly kickReady: boolean;
}

/** Native football ball state. */
export interface FootballBall {
  readonly x: number;
  readonly y: number;
  readonly xv: number;
  readonly yv: number;
}

/** Native football sound entry (presentation-only, part of the state contract). */
export interface FootballSound {
  readonly i: string;
  readonly v?: number;
  readonly p?: string;
  readonly f: number;
}

/** Roster entry consumed by createNewState (team 2 or 3 only). */
export interface FootballPlayer {
  readonly id: number;
  readonly team: number;
}

/** Native football state, shaped like the original FootballPhysics state. */
export interface FootballState {
  readonly scores: number[];
  readonly goalHeight: number;
  readonly borderThickness: number;
  readonly borderThicknessXInner: number;
  readonly borderThicknessYInner: number;
  readonly ppm: number;
  fte: number;
  ftu: number;
  lscr: number;
  ni: boolean;
  readonly ball: FootballBall;
  readonly players: readonly (FootballPlayer | undefined)[];
  readonly seed: number;
  readonly discs: readonly (FootballPlayerDisc | undefined)[];
  readonly sts: readonly FootballSound[];
  rc?: number;
  /** Room-level roster of players who left mid-match (native C19 check).
   *  Disc indices listed here are skipped entirely: no body, no input, no
   *  output, and their entries are dropped from the output players table. */
  readonly playersLeft?: readonly number[];
}

/** Decoded six-bit native input. */
export interface FootballInput {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly action: boolean;
  readonly action2: boolean;
}

export interface FootballPhysics {
  /** Advance one 1/30s tick; returns the next immutable state. */
  step(state: FootballState, inputs: Readonly<Record<number, FootballInput>>): FootballState;
  dispose(): void;
}

const GRAVITY_X = 0;
const GRAVITY_Y = 0;
const PPM = 11;
const PITCH_WIDTH = 730;
const PITCH_HEIGHT = 500;
const GOAL_HEIGHT = 13;
const BORDER_THICKNESS = 5;
const BORDER_THICKNESS_X_INNER = 25;
const BORDER_THICKNESS_Y_INNER = 70;
const KICKOFF_COUNTDOWN = 120;
const GOAL_FREEZE = 90;
const BALL_RADIUS = 0.7;
const BALL_MASS = 0.6;
const BALL_RESTITUTION = 0.4;
const BALL_DAMPING = 0.6;
const BALL_CATEGORY = 4;
const PLAYER_RADIUS = 1;
const PLAYER_MASS = 1.05;
const PLAYER_RESTITUTION = 0.4;
const PLAYER_DAMPING = 2.4;
const PLAYER_CATEGORY = 2;
const MOVE_FORCE = 32;
const ACTION_SLOWDOWN = 0.7;
const KICK_REACH_EXTRA = 0.6;
const KICK_IMPULSE = 15;
const WALL_FRICTION = 0;
const WALL_RESTITUTION = 0.8;
const WALL_MASK = 4;
const POST_FRICTION = 0;
const POST_RESTITUTION = 0.9;
const POST_MASK = 6;
const POST_RADIUS = 8;
const BOUNCE_IMPULSE_THRESHOLD = 1;
const BOUNCE_SOUND_FRAMES = 5;
const KICK_SOUND_FRAMES = 10;
const GOAL_SOUND_FRAMES = 5;
const STEP_DURATION = 30;
const VELOCITY_ITERATIONS = 2;
const POSITION_ITERATIONS = 6;
const MAX_ID = 0xffffffff;

function invalid(reason: string): never {
  throw new Error(`Invalid football physics input: ${reason}`);
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

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a finite number`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

const STATE_FIELDS = new Set([
  'scores',
  'goalHeight',
  'borderThickness',
  'borderThicknessXInner',
  'borderThicknessYInner',
  'ppm',
  'fte',
  'ftu',
  'lscr',
  'ni',
  'ball',
  'players',
  'seed',
  'discs',
  'sts',
  'rc',
  'playersLeft',
]);
const DISC_FIELDS = new Set(['x', 'y', 'xv', 'yv', 'team', 'kickReady']);
const BALL_FIELDS = new Set(['x', 'y', 'xv', 'yv']);
const SOUND_FIELDS = new Set(['i', 'v', 'p', 'f', 'pl']);
const INPUT_FIELDS = new Set(['left', 'right', 'up', 'down', 'action', 'action2']);

function readPlayers(value: unknown): (FootballPlayer | undefined)[] {
  if (!Array.isArray(value)) invalid('state.players must be an array');
  const players: (FootballPlayer | undefined)[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.value === undefined) continue;
    if (!('value' in descriptor)) invalid(`state.players[${index}] must be an own data property`);
    const raw = descriptor.value;
    const label = `state.players[${index}]`;
    if (!isRecord(raw)) invalid(`${label} must be a plain object`);
    const id = integer(ownData(raw, 'id', label), `${label}.id`);
    const team = integer(ownData(raw, 'team', label), `${label}.team`);
    if (id < 0 || id > MAX_ID) invalid(`${label}.id must be in [0, ${MAX_ID}]`);
    if (seen.has(id)) invalid(`${label}.id ${id} is duplicated`);
    seen.add(id);
    // Native football only counts teams 2 and 3; other teams are skipped by
    // createNewState but retained in the sparse players table.
    players[index] = { id, team };
  }
  return players;
}

function readDiscs(
  value: unknown,
  players: readonly (FootballPlayer | undefined)[],
): (FootballPlayerDisc | undefined)[] {
  if (!Array.isArray(value)) invalid('state.discs must be an array');
  const discs: (FootballPlayerDisc | undefined)[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.value === undefined) continue;
    if (!('value' in descriptor)) invalid(`state.discs[${index}] must be an own data property`);
    const raw = descriptor.value;
    const label = `state.discs[${index}]`;
    if (!isRecord(raw)) invalid(`${label} must be a plain object`);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !DISC_FIELDS.has(key)) invalid(`${label} has unsupported field ${String(key)}`);
    }
    if (!players[index]) invalid(`${label} has no matching players[${index}] entry`);
    discs[index] = Object.freeze({
      x: finite(ownData(raw, 'x', label), `${label}.x`),
      y: finite(ownData(raw, 'y', label), `${label}.y`),
      xv: finite(ownData(raw, 'xv', label), `${label}.xv`),
      yv: finite(ownData(raw, 'yv', label), `${label}.yv`),
      team: integer(ownData(raw, 'team', label), `${label}.team`),
      kickReady: boolean(ownData(raw, 'kickReady', label), `${label}.kickReady`),
    });
  }
  return discs;
}

function readSounds(value: unknown): FootballSound[] {
  if (!Array.isArray(value)) invalid('state.sts must be an array');
  return value.map((raw, index) => {
    const label = `state.sts[${index}]`;
    if (!isRecord(raw)) invalid(`${label} must be a plain object`);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !SOUND_FIELDS.has(key)) invalid(`${label} has unsupported field ${String(key)}`);
    }
    const i = ownData(raw, 'i', label);
    if (typeof i !== 'string') invalid(`${label}.i must be a string`);
    const f = integer(ownData(raw, 'f', label), `${label}.f`);
    if (f < 0) invalid(`${label}.f must be nonnegative`);
    const sound: FootballSound = { i, f };
    if (Object.prototype.hasOwnProperty.call(raw, 'v')) {
      const v = ownData(raw, 'v', label);
      if (typeof v !== 'number' || !Number.isFinite(v)) invalid(`${label}.v must be a finite number`);
      (sound as { v?: number }).v = v;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'p')) {
      const p = ownData(raw, 'p', label);
      if (typeof p !== 'string') invalid(`${label}.p must be a string`);
      (sound as { p?: string }).p = p;
    }
    return Object.freeze(sound);
  });
}

function readState(value: unknown): FootballState {
  if (!isRecord(value)) invalid('state must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !STATE_FIELDS.has(key)) invalid(`state has unsupported field ${String(key)}`);
  }
  const scores = ownData(value, 'scores', 'state');
  if (!Array.isArray(scores) || scores.length !== 4) invalid('state.scores must be an array of four entries');
  const scoreValues: number[] = [];
  for (let index = 0; index < scores.length; index++) {
    const score = finite(
      ownData(scores as unknown as Record<string, unknown>, String(index), 'state.scores'),
      `state.scores[${index}]`,
    );
    if (score < 0) invalid(`state.scores[${index}] must be nonnegative`);
    scoreValues.push(score);
  }
  const goalHeight = integer(ownData(value, 'goalHeight', 'state'), 'state.goalHeight');
  const borderThickness = integer(ownData(value, 'borderThickness', 'state'), 'state.borderThickness');
  const borderThicknessXInner = integer(
    ownData(value, 'borderThicknessXInner', 'state'),
    'state.borderThicknessXInner',
  );
  const borderThicknessYInner = integer(
    ownData(value, 'borderThicknessYInner', 'state'),
    'state.borderThicknessYInner',
  );
  const ppm = finite(ownData(value, 'ppm', 'state'), 'state.ppm');
  if (ppm <= 0) invalid('state.ppm must be positive');
  const fte = integer(ownData(value, 'fte', 'state'), 'state.fte');
  const ftu = integer(ownData(value, 'ftu', 'state'), 'state.ftu');
  const lscr = integer(ownData(value, 'lscr', 'state'), 'state.lscr');
  const ni = boolean(ownData(value, 'ni', 'state'), 'state.ni');
  if (fte < -1) invalid('state.fte must be at least -1');
  if (ftu < -1) invalid('state.ftu must be at least -1');
  const rawBall = ownData(value, 'ball', 'state');
  if (!isRecord(rawBall)) invalid('state.ball must be a plain object');
  for (const key of Reflect.ownKeys(rawBall)) {
    if (typeof key !== 'string' || !BALL_FIELDS.has(key)) invalid(`state.ball has unsupported field ${String(key)}`);
  }
  const ball = Object.freeze({
    x: finite(ownData(rawBall, 'x', 'state.ball'), 'state.ball.x'),
    y: finite(ownData(rawBall, 'y', 'state.ball'), 'state.ball.y'),
    xv: finite(ownData(rawBall, 'xv', 'state.ball'), 'state.ball.xv'),
    yv: finite(ownData(rawBall, 'yv', 'state.ball'), 'state.ball.yv'),
  });
  const seed = integer(ownData(value, 'seed', 'state'), 'state.seed');
  if (seed < 0 || seed > MAX_ID) invalid(`state.seed must be in [0, ${MAX_ID}]`);
  const players = readPlayers(ownData(value, 'players', 'state'));
  const discs = readDiscs(ownData(value, 'discs', 'state'), players);
  const sts = readSounds(ownData(value, 'sts', 'state'));
  const rc = Object.prototype.hasOwnProperty.call(value, 'rc')
    ? integer(ownData(value, 'rc', 'state'), 'state.rc')
    : undefined;
  const playersLeft = Object.prototype.hasOwnProperty.call(value, 'playersLeft')
    ? readPlayersLeft(ownData(value, 'playersLeft', 'state'), players)
    : undefined;
  return {
    scores: scoreValues,
    goalHeight,
    borderThickness,
    borderThicknessXInner,
    borderThicknessYInner,
    ppm,
    fte,
    ftu,
    lscr,
    ni,
    ball,
    players,
    seed,
    discs,
    sts,
    ...(rc === undefined ? {} : { rc }),
    ...(playersLeft === undefined ? {} : { playersLeft }),
  };
}

/** Native C19 (readable ~3074466): playersLeft carries player IDs; the disc
 *  loop checks disc indices against it. Both are accepted here: IDs map to
 *  disc indices through the players table, and indices are checked directly. */
function readPlayersLeft(value: unknown, players: readonly (FootballPlayer | undefined)[]): readonly number[] {
  if (!Array.isArray(value)) invalid('state.playersLeft must be an array');
  const result: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = ownData(value as unknown as Record<string, unknown>, String(index), 'state.playersLeft');
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0)
      invalid(`state.playersLeft[${index}] must be a nonnegative integer`);
    result.push(entry);
  }
  return Object.freeze(result);
}

function readInputs(value: unknown, players: readonly (FootballPlayer | undefined)[]): Map<number, FootballInput> {
  if (!isRecord(value)) invalid('inputs must be a plain object keyed by player index');
  if (Object.getOwnPropertySymbols(value).length > 0) invalid('symbol input keys are not supported');
  const known = new Set<number>();
  for (let index = 0; index < players.length; index++) if (players[index]) known.add(index);
  const inputs = new Map<number, FootballInput>();
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(key))
      invalid(`input key ${JSON.stringify(key)} is not a canonical decimal player index`);
    const index = Number(key);
    if (!known.has(index)) invalid(`input for unknown player index ${key}`);
    const raw = ownData(value, key, 'inputs');
    if (!isRecord(raw)) invalid(`inputs[${key}] must be a plain object`);
    for (const field of Reflect.ownKeys(raw)) {
      if (typeof field !== 'string' || !INPUT_FIELDS.has(field))
        invalid(`inputs[${key}] has unsupported field ${String(field)}`);
    }
    inputs.set(
      index,
      Object.freeze({
        left: boolean(ownData(raw, 'left', `inputs[${key}]`), `inputs[${key}].left`),
        right: boolean(ownData(raw, 'right', `inputs[${key}]`), `inputs[${key}].right`),
        up: boolean(ownData(raw, 'up', `inputs[${key}]`), `inputs[${key}].up`),
        down: boolean(ownData(raw, 'down', `inputs[${key}]`), `inputs[${key}].down`),
        action: boolean(ownData(raw, 'action', `inputs[${key}]`), `inputs[${key}].action`),
        action2: boolean(ownData(raw, 'action2', `inputs[${key}]`), `inputs[${key}].action2`),
      }),
    );
  }
  for (const index of known) {
    if (!inputs.has(index)) invalid(`missing input for player index ${index}`);
  }
  return inputs;
}

/**
 * Native FootballPhysics.createNewState (:12864-12926). Players on teams other
 * than 2/3 never receive a disc; team 3 spawns left, team 2 right, with the
 * native ceil(count/2)*80 y-offset parity flips. The ball starts centred.
 */
export function createFootballState(players: readonly (FootballPlayer | undefined)[], seed: number): FootballState {
  if (!Array.isArray(players)) invalid('players must be an array');
  const validated = readPlayers(players);
  const playerCount = [0, 0, 0, 0];
  const discs: (FootballPlayerDisc | undefined)[] = [];
  for (let index = 0; index < validated.length; index++) {
    const player = validated[index];
    if (!player) continue;
    const team = player.team;
    if (team !== 2 && team !== 3) continue;
    const xOffset = team === 3 ? -250 : 250;
    const xPos = PITCH_WIDTH / 2 + xOffset;
    let yOffset = Math.ceil(playerCount[team] / 2) * 80;
    if (team === 2) {
      if (playerCount[team] % 2 === 0) yOffset = -yOffset;
    } else {
      if (playerCount[team] % 2 === 1) yOffset = -yOffset;
    }
    const yPos = PITCH_HEIGHT / 2 + yOffset;
    discs[index] = Object.freeze({
      x: xPos / PPM,
      y: yPos / PPM,
      xv: 0,
      yv: 0,
      team,
      kickReady: true,
    });
    playerCount[team]++;
  }
  return Object.freeze({
    scores: [0, 0, 0, 0],
    goalHeight: GOAL_HEIGHT,
    borderThickness: BORDER_THICKNESS,
    borderThicknessXInner: BORDER_THICKNESS_X_INNER,
    borderThicknessYInner: BORDER_THICKNESS_Y_INNER,
    ppm: PPM,
    fte: -1,
    ftu: KICKOFF_COUNTDOWN,
    lscr: -1,
    ni: true,
    ball: Object.freeze({ x: PITCH_WIDTH / 2 / PPM, y: PITCH_HEIGHT / 2 / PPM, xv: 0, yv: 0 }),
    players: validated.map((player) => (player === undefined ? undefined : Object.freeze({ ...player }))),
    seed,
    discs: Object.freeze(discs),
    sts: [],
  });
}

/** Construct the native-faithful football physics backend. */
export function createFootballPhysics(): FootballPhysics {
  const B = createBackend();
  const Vec2 = B.Common.Math.b2Vec2;
  let world: any = new B.Dynamics.b2World(new Vec2(GRAVITY_X, GRAVITY_Y));
  world.SetWarmStarting(false);

  // Native contact listener (:13349-13370): ball contacts with normal impulse
  // above 1 emit footBounce sounds. Presentation-only, no physics effect.
  const listener: Record<string, (contact: any, impulse: any) => void> = {};
  let soundsThisStep: FootballSound[] = [];
  listener.PostSolve = (contact: any, impulse: any): void => {
    const bodyA = contact.GetFixtureA().GetBody();
    const bodyB = contact.GetFixtureB().GetBody();
    const dataA = bodyA.GetUserData();
    const dataB = bodyB.GetUserData();
    if (dataA?.type === 'ball' || dataB?.type === 'ball') {
      const value = impulse.normalImpulses[0];
      if (value > BOUNCE_IMPULSE_THRESHOLD) {
        soundsThisStep.push({ i: 'footBounce', v: value, f: BOUNCE_SOUND_FRAMES });
      }
    }
  };
  listener.EndContact = (): void => {};
  listener.PreSolve = (): void => {};
  listener.BeginContact = (): void => {};

  const Body = B.Dynamics.b2Body;
  const CircleShape = B.Collision.Shapes.b2CircleShape;
  const PolygonShape = B.Collision.Shapes.b2PolygonShape;
  const BodyDef = B.Dynamics.b2BodyDef;
  const FixtureDef = B.Dynamics.b2FixtureDef;

  let disposed = false;

  function step(rawState: unknown, rawInputs: Readonly<Record<number, FootballInput>>): FootballState {
    if (disposed) throw new Error('Football physics instance has been disposed');
    const state = readState(rawState);
    const inputs = readInputs(rawInputs, state.players);

    soundsThisStep = [];
    world.novakReset();
    world.SetContactListener(listener);

    // ── Wall (FootballWall :13718-13935) ───────────────────────────────────
    const ppm = state.ppm;
    const wallWidth = (PITCH_WIDTH - state.borderThickness * 2 - state.borderThicknessXInner * 2) / ppm;
    const wallHeight = (PITCH_HEIGHT - state.borderThickness * 2 - state.borderThicknessYInner * 2) / ppm;
    // Native wall thickness is the literal 5 / ppm (readable FootballWall:
    // `T4c.b2PrismaticJoint = (function (a0, a1) { return a1 / a0; })(T4c.swingF, 5)`),
    // NOT state.borderThickness — the state field only feeds the wallWidth/
    // wallHeight computations above. Using the state field here would
    // diverge for any non-default borderThickness.
    const thick5 = 5 / ppm;
    const goalHeight = state.goalHeight;
    const thick8 = POST_RADIUS / ppm;
    const wallDef = new BodyDef();
    wallDef.type = Body.b2_staticBody;
    wallDef.position.Set(PITCH_WIDTH / 2 / ppm, PITCH_HEIGHT / 2 / ppm);
    const wallBody = world.CreateBody(wallDef);
    const wallFixture = new FixtureDef();
    wallFixture.friction = WALL_FRICTION;
    wallFixture.restitution = WALL_RESTITUTION;
    wallFixture.filter.maskBits = WALL_MASK;
    const wallShape = new PolygonShape();
    wallFixture.shape = wallShape;
    // Native wall rects (:13758-13863); rect2/4/5 are reversed after construction.
    const rects: { points: [number, number][]; reversed: boolean }[] = [
      {
        points: [
          [wallWidth / 2 + thick5, -wallHeight / 2],
          [-wallWidth / 2 - thick5, -wallHeight / 2],
          [-wallWidth / 2 - thick5, -wallHeight / 2 - thick5],
          [wallWidth / 2 + thick5, -wallHeight / 2 - thick5],
        ],
        reversed: false,
      },
      {
        points: [
          [wallWidth / 2 + thick5, wallHeight / 2],
          [-wallWidth / 2 - thick5, wallHeight / 2],
          [-wallWidth / 2 - thick5, wallHeight / 2 + thick5],
          [wallWidth / 2 + thick5, wallHeight / 2 + thick5],
        ],
        reversed: true,
      },
      {
        points: [
          [-wallWidth / 2, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
          [-wallWidth / 2 - thick5, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
          [-wallWidth / 2 - thick5, -wallHeight / 2],
          [-wallWidth / 2, -wallHeight / 2],
        ],
        reversed: false,
      },
      {
        points: [
          [wallWidth / 2, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
          [wallWidth / 2 + thick5, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
          [wallWidth / 2 + thick5, -wallHeight / 2],
          [wallWidth / 2, -wallHeight / 2],
        ],
        reversed: true,
      },
      {
        points: [
          [-wallWidth / 2, wallHeight / 2 - (wallHeight - goalHeight) / 2],
          [-wallWidth / 2 - thick5, wallHeight / 2 - (wallHeight - goalHeight) / 2],
          [-wallWidth / 2 - thick5, wallHeight / 2],
          [-wallWidth / 2, wallHeight / 2],
        ],
        reversed: true,
      },
      {
        points: [
          [wallWidth / 2, wallHeight / 2 - (wallHeight - goalHeight) / 2],
          [wallWidth / 2 + thick5, wallHeight / 2 - (wallHeight - goalHeight) / 2],
          [wallWidth / 2 + thick5, wallHeight / 2],
          [wallWidth / 2, wallHeight / 2],
        ],
        reversed: false,
      },
    ];
    for (const rect of rects) {
      const vertices = rect.points.map(([x, y]) => new Vec2(x, y));
      if (rect.reversed) vertices.reverse();
      wallShape.SetAsArray(vertices);
      wallBody.CreateFixture(wallFixture);
    }
    const goalCircle = new CircleShape(thick8);
    const postFixture = new FixtureDef();
    postFixture.friction = POST_FRICTION;
    postFixture.restitution = POST_RESTITUTION;
    postFixture.filter.maskBits = POST_MASK;
    postFixture.shape = goalCircle;
    const postPositions: [number, number][] = [
      [-wallWidth / 2, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
      [wallWidth / 2, -wallHeight / 2 + (wallHeight - goalHeight) / 2],
      [-wallWidth / 2, wallHeight / 2 - (wallHeight - goalHeight) / 2],
      [wallWidth / 2, wallHeight / 2 - (wallHeight - goalHeight) / 2],
    ];
    for (const [x, y] of postPositions) {
      goalCircle.SetLocalPosition(new Vec2(x, y));
      wallBody.CreateFixture(postFixture);
    }
    wallBody.SetUserData({ type: 'wall' });

    // ── Ball (Ball :13545-13589) ───────────────────────────────────────────
    const ballDef = new BodyDef();
    ballDef.type = Body.b2_dynamicBody;
    ballDef.position.Set(state.ball.x, state.ball.y);
    const ballBody = world.CreateBody(ballDef);
    const ballFixture = new FixtureDef();
    ballFixture.shape = new CircleShape(BALL_RADIUS);
    ballFixture.restitution = BALL_RESTITUTION;
    ballFixture.density = BALL_MASS / (Math.PI * BALL_RADIUS * BALL_RADIUS);
    ballFixture.friction = 0;
    ballFixture.filter.categoryBits = BALL_CATEGORY;
    ballBody.CreateFixture(ballFixture);
    ballBody.SetLinearVelocity(new Vec2(state.ball.xv, state.ball.yv));
    ballBody.SetUserData({ type: 'ball' });
    ballBody.SetFixedRotation(true);
    ballBody.SetLinearDamping(BALL_DAMPING);
    ballBody.SetBullet(true);

    // ── Players (FootballPlayer :13590-13717) ──────────────────────────────
    // Native C19 (readable ~3070600): disc indices listed in playersLeft are
    // skipped entirely — no body is created, no input is applied, no output
    // is recorded. Their players-table entries are also dropped from the
    // output state.
    const playersLeft = new Set<number>();
    if (state.playersLeft) {
      for (const entry of state.playersLeft) {
        playersLeft.add(entry);
        // Native playersLeft carries player IDs; map them to disc indices.
        for (let index = 0; index < state.players.length; index++) {
          if (state.players[index]?.id === entry) playersLeft.add(index);
        }
      }
    }
    const playerBodies = new Map<number, any>();
    const playerKickReady = new Map<number, boolean>();
    for (let index = 0; index < state.discs.length; index++) {
      const disc = state.discs[index];
      if (!disc) continue;
      if (playersLeft.has(index)) continue;
      const playerDef = new BodyDef();
      playerDef.type = Body.b2_dynamicBody;
      playerDef.position.Set(disc.x, disc.y);
      playerDef.fixedRotation = true;
      playerDef.linearDamping = PLAYER_DAMPING;
      playerDef.linearVelocity.x = disc.xv;
      playerDef.linearVelocity.y = disc.yv;
      playerDef.bullet = true;
      const playerBody = world.CreateBody(playerDef);
      const playerShape = new CircleShape();
      playerShape.SetRadius(PLAYER_RADIUS);
      const playerFixture = new FixtureDef();
      playerFixture.shape = playerShape;
      playerFixture.friction = 0;
      playerFixture.restitution = PLAYER_RESTITUTION;
      playerFixture.density = PLAYER_MASS / (Math.PI * PLAYER_RADIUS * PLAYER_RADIUS);
      playerFixture.filter.categoryBits = PLAYER_CATEGORY;
      playerBody.CreateFixture(playerFixture);
      playerBody.SetUserData({ type: 'disc', arrayID: index });
      playerBodies.set(index, playerBody);
      playerKickReady.set(index, disc.kickReady);
    }

    // ── Inputs and kick (native :13392-13406, :13624-13677) ────────────────
    if (state.ftu === -1) {
      for (const [index, input] of inputs) {
        const playerBody = playerBodies.get(index);
        if (!playerBody) continue;
        // applyInputs (:13624-13647): force 32, action x0.7, action2 zero.
        const force = new Vec2(0, 0);
        if (input.left) force.x = -MOVE_FORCE;
        else if (input.right) force.x = MOVE_FORCE;
        if (input.up) force.y = -MOVE_FORCE;
        else if (input.down) force.y = MOVE_FORCE;
        if (input.action) force.Multiply(ACTION_SLOWDOWN);
        if (input.action2) {
          force.x = 0;
          force.y = 0;
        }
        playerBody.ApplyForce(force, playerBody.GetWorldCenter());
        // doKick (:13649-13677): reach 0.7 + 1 + 0.6, impulse magnitude 15
        // along (player - ball), one-per-press with kickReady re-arm.
        let kickReady = playerKickReady.get(index)!;
        if (input.action && kickReady) {
          const playerPos = playerBody.GetPosition().Copy();
          playerPos.Subtract(ballBody.GetPosition());
          const length = Math.abs(playerPos.Length());
          if (length < BALL_RADIUS + PLAYER_RADIUS + KICK_REACH_EXTRA) {
            const ballImpulse = playerPos.Copy().GetNegative();
            const mod = length / KICK_IMPULSE;
            ballImpulse.x = ballImpulse.x / mod;
            ballImpulse.y = ballImpulse.y / mod;
            ballBody.ApplyImpulse(ballImpulse, ballBody.GetPosition());
            kickReady = false;
            soundsThisStep.push({ i: 'footKick', v: 1, f: KICK_SOUND_FRAMES });
          }
        }
        if (!input.action) kickReady = true;
        playerKickReady.set(index, kickReady);
      }
    }

    // ── Step (native :13407-13410) ─────────────────────────────────────────
    if (state.ftu === -1) {
      world.Step(1 / STEP_DURATION, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    }
    world.ClearForces();

    // ── clampToPitch (native :13412-13416, :13678-13697) ───────────────────
    for (const [index, playerBody] of playerBodies) {
      const position = playerBody.GetPosition();
      const velocity = playerBody.GetLinearVelocity();
      if (position.x < 0 + PLAYER_RADIUS) {
        position.x = 0 + PLAYER_RADIUS;
        velocity.x = 0;
      }
      if (position.x > PITCH_WIDTH / ppm - PLAYER_RADIUS) {
        position.x = PITCH_WIDTH / ppm - PLAYER_RADIUS;
        velocity.x = 0;
      }
      if (position.y < 0 + PLAYER_RADIUS) {
        position.y = 0 + PLAYER_RADIUS;
        velocity.y = 0;
      }
      if (position.y > PITCH_HEIGHT / ppm - PLAYER_RADIUS) {
        position.y = PITCH_HEIGHT / ppm - PLAYER_RADIUS;
        velocity.y = 0;
      }
    }

    // ── Goal detection (native :13417-13447) ───────────────────────────────
    const scores = state.scores.slice();
    let lscr = state.lscr;
    let isGoal = false;
    if (state.ftu === -1 && state.fte === -1) {
      const ballX = ballBody.GetPosition().x;
      if (ballX < (state.borderThickness + state.borderThicknessXInner) / ppm) {
        scores[2]!++;
        lscr = 2;
        isGoal = true;
        soundsThisStep.push({ i: 'footGoal', v: 1, p: 'l', f: GOAL_SOUND_FRAMES });
      }
      if (ballX > (PITCH_WIDTH - state.borderThickness - state.borderThicknessXInner) / ppm) {
        scores[3]!++;
        lscr = 3;
        isGoal = true;
        soundsThisStep.push({ i: 'footGoal', v: 1, p: 'r', f: GOAL_SOUND_FRAMES });
      }
    }

    // ── State assembly (native :13448-13531) ───────────────────────────────
    // Sound decay: entries with f > 0 survive with f-1, then new sounds append.
    // Native (readable ~3075628) preserves i, f-1, v, p AND pl on every
    // decayed entry; the port must not drop pl.
    const sts: FootballSound[] = [];
    for (const sound of state.sts) {
      if (sound.f > 0) {
        const decayed: FootballSound = { i: sound.i, f: sound.f - 1 };
        if (sound.v !== undefined) (decayed as { v?: number }).v = sound.v;
        if (sound.p !== undefined) (decayed as { p?: string }).p = sound.p;
        if ((sound as { pl?: number }).pl !== undefined)
          (decayed as { pl?: number }).pl = (sound as { pl?: number }).pl;
        sts.push(Object.freeze(decayed));
      }
    }
    for (const sound of soundsThisStep) sts.push(Object.freeze({ ...sound }));
    const discs: (FootballPlayerDisc | undefined)[] = [];
    for (const [index, playerBody] of playerBodies) {
      discs[index] = Object.freeze({
        x: playerBody.GetPosition().x,
        y: playerBody.GetPosition().y,
        xv: playerBody.GetLinearVelocity().x,
        yv: playerBody.GetLinearVelocity().y,
        team: state.discs[index]!.team,
        kickReady: playerKickReady.get(index)!,
      });
    }
    let newStep: FootballState = {
      scores,
      goalHeight: state.goalHeight,
      borderThickness: state.borderThickness,
      borderThicknessXInner: state.borderThicknessXInner,
      borderThicknessYInner: state.borderThicknessYInner,
      ppm: state.ppm,
      lscr,
      seed: state.seed,
      ni: false,
      sts: Object.freeze(sts),
      // Native C19 filter (readable ~3075628): the output players table drops
      // entries whose id is in playersLeft. The disc table already omits them
      // (no body was created).
      players: state.playersLeft
        ? state.players.map((player) =>
            player !== undefined && state.playersLeft!.includes(player.id) ? undefined : player,
          )
        : state.players,
      ball: Object.freeze({
        x: ballBody.GetPosition().x,
        y: ballBody.GetPosition().y,
        xv: ballBody.GetLinearVelocity().x,
        yv: ballBody.GetLinearVelocity().y,
      }),
      discs: Object.freeze(discs),
      fte: isGoal ? GOAL_FREEZE : Math.max(-1, state.fte - 1),
      ftu: Math.max(-1, state.ftu - 1),
    };
    // Goal-freeze reset (native :13520-13531): createNewState with surviving
    // players, scores preserved. rc increments by one on the reset tick.
    if (state.fte === 0) {
      const surviving = newStep.players;
      const reset = createFootballState(surviving, state.seed);
      newStep = Object.freeze({
        ...reset,
        scores,
        ...(state.rc === undefined ? {} : { rc: (state.rc ?? 0) + 1 }),
      });
    }
    newStep = Object.freeze(newStep);

    // ── Teardown (native :13532-13542) ─────────────────────────────────────
    world.DestroyBody(ballBody);
    for (const playerBody of playerBodies.values()) world.DestroyBody(playerBody);
    world.DestroyBody(wallBody);
    return newStep;
  }

  return {
    step,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      soundsThisStep = [];
      world.novakReset();
      world = null;
    },
  };
}
