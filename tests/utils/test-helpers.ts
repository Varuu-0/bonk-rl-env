import { PhysicsEngine, PlayerInput, MapBodyDef } from '../../src/core/physics-engine';

export const EMPTY_INPUT: PlayerInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  heavy: false,
  grapple: false,
};

export const RIGHT_INPUT: PlayerInput = { ...EMPTY_INPUT, right: true };
export const LEFT_INPUT: PlayerInput = { ...EMPTY_INPUT, left: true };
export const UP_INPUT: PlayerInput = { ...EMPTY_INPUT, up: true };
export const DOWN_INPUT: PlayerInput = { ...EMPTY_INPUT, down: true };
export const HEAVY_INPUT: PlayerInput = { ...EMPTY_INPUT, heavy: true };
export const GRAPPLE_INPUT: PlayerInput = { ...EMPTY_INPUT, grapple: true };

export function makeWall(
  engine: PhysicsEngine,
  x: number,
  collides?: { g1?: boolean; g2?: boolean; g3?: boolean; g4?: boolean },
): MapBodyDef {
  const def: MapBodyDef = {
    name: `wall_${x}`,
    type: 'rect',
    x,
    y: 0,
    width: 10,
    height: 400,
    static: true,
    collides,
  };
  engine.addBody(def);
  return def;
}

export function makePlatform(
  engine: PhysicsEngine,
  x: number,
  y: number,
  w: number,
  h: number,
  overrides?: Partial<MapBodyDef>,
): MapBodyDef {
  const def: MapBodyDef = {
    name: `platform_${x}_${y}`,
    type: 'rect',
    x,
    y,
    width: w,
    height: h,
    static: true,
    ...overrides,
  };
  engine.addBody(def);
  return def;
}

export function addBall(
  engine: PhysicsEngine,
  x: number,
  y: number,
  _vx = 0,
  _vy = 0,
): number {
  return engine.addPlayer(x, y, 0);
}

export function safeDestroy(engine: PhysicsEngine | null): void {
  if (!engine) return;
  try {
    engine.destroy();
  } catch {
    // Box2D cleanup errors are expected
  }
}

export function encodeAction(input: PlayerInput): number {
  let action = 0;
  if (input.left) action |= 1;
  if (input.right) action |= 2;
  if (input.up) action |= 4;
  if (input.down) action |= 8;
  if (input.heavy) action |= 16;
  if (input.grapple) action |= 32;
  return action;
}

export function decodeAction(action: number): PlayerInput {
  return {
    left: (action & 1) !== 0,
    right: (action & 2) !== 0,
    up: (action & 4) !== 0,
    down: (action & 8) !== 0,
    heavy: (action & 16) !== 0,
    grapple: (action & 32) !== 0,
  };
}
