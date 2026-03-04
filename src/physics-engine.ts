/**
 * PhysicsEngine — Synchronous Box2D wrapper for the bonk.io RL environment.
 *
 * Wraps the `box2d` npm package (Box2DFlash v2.0 JS port, matching the
 * original bonk1-box2d AS3 source) into a clean, headless interface.
 *
 * Key design:
 *   - NO real-time clock. tick() is called manually by the RL loop.
 *   - Each tick() advances the world by exactly 1/30th of a second (30 TPS).
 *   - Player bodies are circles with configurable radius/density.
 *   - "Heavy" state doubles mass and applies downward force.
 */

// @ts-ignore — box2d has no type declarations
const box2d = require('box2d');

const {
  b2World,
  b2AABB,
  b2Vec2,
  b2BodyDef,
  b2CircleDef,
  b2PolygonDef,
  b2MassData,
  b2Body,
} = box2d;

// ─── Constants ───────────────────────────────────────────────────────
/** bonk.io runs at 30 ticks per second */
export const TPS = 30;
export const DT = 1 / TPS;

/** Box2D solver iterations per step (matches bonk defaults) */
export const SOLVER_ITERATIONS = 10;

/** Physics scale: pixels → metres (bonk uses ~30px per metre) */
export const SCALE = 30;

/** Gravity in m/s² (bonk.io default) */
export const GRAVITY_X = 0;
export const GRAVITY_Y = 10;

/** Default player circle radius in metres */
export const PLAYER_RADIUS = 0.5;

/** Default player density */
export const PLAYER_DENSITY = 1.0;

/** Heavy-state mass multiplier */
export const HEAVY_MASS_MULTIPLIER = 3.0;

/** Arena bounds (in metres). Players outside these are considered dead. */
export const ARENA_HALF_WIDTH = 25;
export const ARENA_HALF_HEIGHT = 20;

/** Movement force magnitude (Newtons applied per input direction) */
export const MOVE_FORCE = 8.0;

// ─── Types ───────────────────────────────────────────────────────────

export interface PlayerState {
  x: number;
  y: number;
  velX: number;
  velY: number;
  angle: number;
  angularVel: number;
  isHeavy: boolean;
  alive: boolean;
}

export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  heavy: boolean;
}

export interface PlatformDef {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  angle?: number;
}

// ─── PhysicsEngine ───────────────────────────────────────────────────

export class PhysicsEngine {
  private world: any;
  private playerBodies: Map<number, any> = new Map();
  private playerHeavyState: Map<number, boolean> = new Map();
  private playerAlive: Map<number, boolean> = new Map();
  private platformBodies: any[] = [];
  private tickCount: number = 0;

  constructor() {
    // Create world with AABB and gravity
    const worldAABB = new b2AABB();
    worldAABB.lowerBound.Set(-100, -100);
    worldAABB.upperBound.Set(100, 100);

    const gravity = new b2Vec2(GRAVITY_X, GRAVITY_Y);
    this.world = new b2World(worldAABB, gravity, true /* doSleep */);
  }

  /**
   * Add a static rectangular platform to the world.
   */
  addPlatform(def: PlatformDef): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(def.x / SCALE, def.y / SCALE);
    if (def.angle) bodyDef.angle = def.angle;

    const body = this.world.CreateBody(bodyDef);

    const shapeDef = new b2PolygonDef();
    shapeDef.SetAsBox(def.halfWidth / SCALE, def.halfHeight / SCALE);
    shapeDef.density = 0; // static
    shapeDef.friction = 0.3;
    shapeDef.restitution = 0.4;

    body.CreateShape(shapeDef);
    body.SetMassFromShapes();
    this.platformBodies.push(body);
  }

  /**
   * Add a dynamic circular player body.
   * Returns the player ID (0-indexed).
   */
  addPlayer(id: number, x: number, y: number): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(x / SCALE, y / SCALE);

    const body = this.world.CreateBody(bodyDef);

    const circleDef = new b2CircleDef();
    circleDef.radius = PLAYER_RADIUS;
    circleDef.density = PLAYER_DENSITY;
    circleDef.friction = 0.3;
    circleDef.restitution = 0.5;

    body.CreateShape(circleDef);
    body.SetMassFromShapes();

    // Allow rotation (bonk players spin)
    body.SetUserData({ playerId: id });

    this.playerBodies.set(id, body);
    this.playerHeavyState.set(id, false);
    this.playerAlive.set(id, true);
  }

  /**
   * Apply player inputs as forces on their body.
   */
  applyInput(playerId: number, input: PlayerInput): void {
    const body = this.playerBodies.get(playerId);
    if (!body || !this.playerAlive.get(playerId)) return;

    const pos = body.GetPosition();
    const force = new b2Vec2(0, 0);

    if (input.left) force.x -= MOVE_FORCE;
    if (input.right) force.x += MOVE_FORCE;
    if (input.up) force.y -= MOVE_FORCE;
    if (input.down) force.y += MOVE_FORCE;

    body.ApplyForce(force, pos);

    // Handle heavy state toggle
    const wasHeavy = this.playerHeavyState.get(playerId) || false;
    if (input.heavy && !wasHeavy) {
      this.setHeavy(playerId, true);
    } else if (!input.heavy && wasHeavy) {
      this.setHeavy(playerId, false);
    }
  }

  /**
   * Toggle heavy state: multiplies mass and applies downward force.
   */
  private setHeavy(playerId: number, heavy: boolean): void {
    const body = this.playerBodies.get(playerId);
    if (!body) return;

    this.playerHeavyState.set(playerId, heavy);

    if (heavy) {
      // Increase mass by multiplying density effect
      const massData = new b2MassData();
      massData.mass = body.GetMass() * HEAVY_MASS_MULTIPLIER;
      massData.center = body.GetLocalCenter();
      massData.I = body.GetInertia() * HEAVY_MASS_MULTIPLIER;
      body.SetMass(massData);
    } else {
      // Reset mass from shape definitions
      body.SetMassFromShapes();
    }
  }

  /**
   * Advance the physics simulation by exactly one tick (1/30s).
   * This is the core synchronous step — no real-time clock involved.
   */
  tick(): void {
    this.world.Step(DT, SOLVER_ITERATIONS);
    this.tickCount++;

    // Check for players out of bounds (dead)
    for (const [id, body] of this.playerBodies) {
      if (!this.playerAlive.get(id)) continue;

      const pos = body.GetPosition();
      if (
        Math.abs(pos.x) > ARENA_HALF_WIDTH ||
        Math.abs(pos.y) > ARENA_HALF_HEIGHT
      ) {
        this.playerAlive.set(id, false);
      }
    }
  }

  /**
   * Get the current state of a player.
   */
  getPlayerState(playerId: number): PlayerState {
    const body = this.playerBodies.get(playerId);
    if (!body) {
      return {
        x: 0, y: 0, velX: 0, velY: 0,
        angle: 0, angularVel: 0,
        isHeavy: false, alive: false,
      };
    }

    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();

    return {
      x: pos.x * SCALE,
      y: pos.y * SCALE,
      velX: vel.x * SCALE,
      velY: vel.y * SCALE,
      angle: body.GetAngle(),
      angularVel: body.GetAngularVelocity(),
      isHeavy: this.playerHeavyState.get(playerId) || false,
      alive: this.playerAlive.get(playerId) || false,
    };
  }

  /**
   * Get all alive player IDs.
   */
  getAlivePlayerIds(): number[] {
    const alive: number[] = [];
    for (const [id, isAlive] of this.playerAlive) {
      if (isAlive) alive.push(id);
    }
    return alive;
  }

  /**
   * Get the current tick number.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Reset the world — destroy all bodies, recreate a fresh world.
   */
  reset(): void {
    // Destroy all player bodies
    for (const [_id, body] of this.playerBodies) {
      this.world.DestroyBody(body);
    }
    this.playerBodies.clear();
    this.playerHeavyState.clear();
    this.playerAlive.clear();

    // Destroy all platform bodies
    for (const body of this.platformBodies) {
      this.world.DestroyBody(body);
    }
    this.platformBodies = [];

    this.tickCount = 0;
  }

  /**
   * Completely destroy the world for cleanup.
   */
  destroy(): void {
    this.reset();
    this.world = null;
  }
}
