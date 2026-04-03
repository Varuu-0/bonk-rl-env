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

import { globalProfiler, wrap, TelemetryIndices } from '../telemetry/profiler';
import { isTelemetryEnabled } from '../telemetry/telemetry-controller';

const {
  b2World,
  b2AABB,
  b2Vec2,
  b2BodyDef,
  b2CircleDef,
  b2PolygonDef,
  b2MassData,
  b2Body,
  b2DistanceJointDef,
  b2ContactListener,
  b2FilterData,
} = box2d;

// Monkey-patch b2BroadPhase.Query to guard against undefined bounds entries.
// The box2d JS port (Box2DFlash v2.0) can leave stale/undefined entries in
// the bounds array during DestroyProxy, causing "Cannot read properties of
// undefined (reading 'IsLower')" crashes during Step → Solve → SynchronizeShapes.
(() => {
  const b2BroadPhase = box2d.b2BroadPhase;

  // Guard Query (original fix)
  const _origQuery = b2BroadPhase.prototype.Query;
  b2BroadPhase.prototype.Query = function (
    lowerQueryOut: any, upperQueryOut: any,
    lowerValue: number, upperValue: number,
    bounds: any[], boundCount: number, axis: number,
  ) {
    try {
      _origQuery.call(this, lowerQueryOut, upperQueryOut, lowerValue, upperValue, bounds, boundCount, axis);
    } catch (e: any) {
      if (e instanceof TypeError && (e.message.includes("IsLower") || e.message.includes("value"))) {
        // Bounds array corrupted — skip this query to prevent cascading failures
      } else {
        throw e;
      }
    }
  };

  // Guard TestOverlap
  const _origTestOverlap = b2BroadPhase.prototype.TestOverlap;
  b2BroadPhase.prototype.TestOverlap = function (proxyA: number, proxyB: number) {
    try {
      return _origTestOverlap.call(this, proxyA, proxyB);
    } catch (e: any) {
      if (e instanceof TypeError && (e.message.includes("value") || e.message.includes("IsLower"))) {
        return false;  // Treat corrupted broadphase as no overlap
      }
      throw e;
    }
  };

  // Guard MoveProxy
  const _origMoveProxy = b2BroadPhase.prototype.MoveProxy;
  b2BroadPhase.prototype.MoveProxy = function (proxyId: number, aabb: any, displacement: any) {
    try {
      _origMoveProxy.call(this, proxyId, aabb, displacement);
    } catch (e: any) {
      if (e instanceof TypeError && (e.message.includes("value") || e.message.includes("IsLower"))) {
        // Broadphase corrupted — skip this move to prevent cascading failures
      } else {
        throw e;
      }
    }
  };

  // Guard DestroyProxy
  const _origDestroyProxy = b2BroadPhase.prototype.DestroyProxy;
  b2BroadPhase.prototype.DestroyProxy = function (proxyId: number) {
    try {
      _origDestroyProxy.call(this, proxyId);
    } catch (e: any) {
      if (e instanceof TypeError && (e.message.includes("value") || e.message.includes("IsLower"))) {
        // Broadphase corrupted — skip this destroy to prevent cascading failures
      } else {
        throw e;
      }
    }
  };
})();

// ─── Constants ───────────────────────────────────────────────────────
/** bonk.io runs at 30 ticks per second */
export const TPS = 30;
export const DT = 1 / TPS;

/** Box2D solver iterations per step (matches bonk defaults) */
export const SOLVER_ITERATIONS = 5;

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
export const HEAVY_MASS_MULTIPLIER = 3.0; // triples mass

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
  grapple: boolean;
}

export interface MapBodyDef {
  name: string;
  type: 'rect' | 'circle' | 'polygon';
  x: number;
  y: number;
  width?: number;    // For rect
  height?: number;   // For rect
  radius?: number;   // For circle
  vertices?: { x: number; y: number }[]; // For polygon
  static: boolean;
  density?: number;
  restitution?: number;
  angle?: number;
  isLethal?: boolean;
  grappleMultiplier?: number;
  noPhysics?: boolean;           // When true, body should be a sensor (no collision response)
  noGrapple?: boolean;           // When true, cannot be grappled
  innerGrapple?: boolean;        // Inner grapple behavior
  friction?: number;             // Surface friction coefficient
  collides?: {                   // Collision group filtering
    g1: boolean;
    g2: boolean;
    g3: boolean;
    g4: boolean;
  };
  color?: number;                // Visual color (RGB as integer)
  surfaceName?: string;          // Surface type name
  linearDamping?: number;        // Body linear velocity drag
  angularDamping?: number;       // Body angular velocity drag
  linearVelocity?: { x: number; y: number }; // Starting velocity for dynamic bodies
  angularVelocity?: number;      // Starting rotational velocity
  collidesWithPlayers?: boolean; // If false, exclude player categories from maskBits
  aabb?: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; cx: number; cy: number }; // Pre-calculated AABB for polygons
}

export interface MapSpawnPoints {
  [team: string]: { x: number; y: number };
}

export interface MapDef {
  name: string;
  spawnPoints: MapSpawnPoints;
  bodies: MapBodyDef[];
  capZones?: Array<{ index: number; owner: string; type: number; fixture: string; shapeType: string }>;
  joints?: Array<{ type: string; bodyA: string; bodyB: string; anchorA?: { x: number; y: number }; anchorB?: { x: number; y: number }; localAnchorA?: { x: number; y: number }; localAnchorB?: { x: number; y: number }; length?: number; frequencyHz?: number; dampingRatio?: number; collideConnected?: boolean }>;
  physics?: { ppm?: number; bounds?: { width: number; height: number } };
}

// ─── PhysicsEngine ───────────────────────────────────────────────────

export class PhysicsEngine {
  private world: any;
  private playerBodies: Map<number, any> = new Map();
  private playerHeavyState: Map<number, boolean> = new Map();
  private playerAlive: Map<number, boolean> = new Map();
  private playerGrappleJoints: Map<number, any> = new Map();
  private playerTeams: Map<number, string> = new Map();
  private capZoneSensors: any[] = [];
  private lastScoredTeam: string | null = null;
  private platformBodies: any[] = [];
  private platformBodyMap: Map<string, any> = new Map();
  private tickCount: number = 0;
  private arenaHalfWidth: number = ARENA_HALF_WIDTH;
  private arenaHalfHeight: number = ARENA_HALF_HEIGHT;
  private _tempForce = new b2Vec2(0, 0);

  constructor() {
    // Create world with AABB and gravity
    const worldAABB = new b2AABB();
    worldAABB.lowerBound.Set(-1000, -1000);
    worldAABB.upperBound.Set(1000, 1000);

    const gravity = new b2Vec2(GRAVITY_X, GRAVITY_Y);
    this.world = new b2World(worldAABB, gravity, true /* doSleep */);

    // Set up collision listener for WDB lethal objects
    this.setupContactListener();
  }

  /**
   * Defines collision rules: lethal objects kill players.
   */
  private setupContactListener(): void {
    const listener = new b2ContactListener();
    listener.Add = (contact: any) => {
      try {
        globalProfiler.increment('collision_events');

        const shape1 = contact.shape1 || (contact.GetShape1 ? contact.GetShape1() : contact.GetFixtureA?.());
        const shape2 = contact.shape2 || (contact.GetShape2 ? contact.GetShape2() : contact.GetFixtureB?.());
        if (!shape1 || !shape2) return;

        const body1 = shape1.GetBody();
        const body2 = shape2.GetBody();
        if (!body1 || !body2) return;

        const ud1 = body1.GetUserData() || {};
        const ud2 = body2.GetUserData() || {};

        this.checkLethalCollision(ud1, ud2);
        this.checkLethalCollision(ud2, ud1);

        // CapZone scoring: detect when a dynamic (non-static, non-player) body enters a zone sensor
        if (ud1.isCapZone && ud2.playerId === undefined && !ud2.isCapZone) {
          if (ud1.zoneType === 2) this.lastScoredTeam = 'blue';
          else if (ud1.zoneType === 3) this.lastScoredTeam = 'red';
        } else if (ud2.isCapZone && ud1.playerId === undefined && !ud1.isCapZone) {
          if (ud2.zoneType === 2) this.lastScoredTeam = 'blue';
          else if (ud2.zoneType === 3) this.lastScoredTeam = 'red';
        }
      } catch (e) {
        // Ignore contact errors — some TOI contacts lack valid shapes
      }
    };

    this.world.SetContactListener(listener);
  }

  private checkLethalCollision(playerData: any, staticData: any): void {
    if (playerData.playerId !== undefined && staticData.isLethal) {
      this.playerAlive.set(playerData.playerId, false);
      globalProfiler.increment('collision_lethal');
    }
  }

  /**
   * Add a static or dynamic body from a MapBodyDef to the world.
   */
  addBody(def: MapBodyDef): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(def.x / SCALE, def.y / SCALE);
    if (def.angle) bodyDef.angle = def.angle;
    bodyDef.linearDamping = def.linearDamping ?? 0;
    bodyDef.angularDamping = def.angularDamping ?? 0;

    const body = this.world.CreateBody(bodyDef);

    let shapeDef: any;
    if (def.type === 'rect') {
      shapeDef = new b2PolygonDef();
      const hw = (def.width || 0) / 2;
      const hh = (def.height || 0) / 2;
      shapeDef.SetAsBox(hw / SCALE, hh / SCALE);
     } else if (def.type === 'circle') {
       shapeDef = new b2CircleDef();
       shapeDef.radius = (def.radius || 0) / SCALE;
     } else if (def.type === 'polygon') {
       if (!def.vertices || def.vertices.length < 3) {
         console.warn(`Polygon body "${def.name}" has insufficient vertices (need >= 3)`);
         this.world.DestroyBody(body);
         return; // Skip invalid polygon
       }
       shapeDef = new b2PolygonDef();
       // Box2D supports max 8 vertices for convex polygons
       const maxVertices = Math.min(def.vertices.length, 8);
       for (let i = 0; i < maxVertices; i++) {
         const v = def.vertices[i];
         shapeDef.vertices[i].Set(v.x / SCALE, v.y / SCALE);
       }
       shapeDef.vertexCount = maxVertices;
     }

     shapeDef.density = def.static ? 0 : (def.density ?? 1.0);
     shapeDef.friction = def.friction ?? 0.3;
     const restitutionValue = def.restitution === -1 ? 0.4 : (def.restitution ?? 0.4);
     shapeDef.restitution = restitutionValue;

      // Handle noPhysics: true → make body a sensor (no collision response, but still triggers contact events)
      if (def.noPhysics) {
        shapeDef.isSensor = true;
      }

      // Apply collision filtering if specified
      if (def.collides || def.collidesWithPlayers === false) {
        const filter = new b2FilterData();
        filter.categoryBits = 0x0001; // Map bodies are category 1
        filter.maskBits = 0xFFFF; // Start with collide-all
        
        if (def.collides) {
          filter.maskBits = 0x0000;
          if (def.collides.g1) filter.maskBits |= 0x0002;
          if (def.collides.g2) filter.maskBits |= 0x0004;
          if (def.collides.g3) filter.maskBits |= 0x0008;
          if (def.collides.g4) filter.maskBits |= 0x0010;
        }
        
        // collidesWithPlayers=false → exclude player categories from mask
        if (def.collidesWithPlayers === false) {
          filter.maskBits &= ~0x0002; // exclude g1 (player 0)
          filter.maskBits &= ~0x0004; // exclude g2 (player 1+)
        }
        
        shapeDef.filter = filter;
      }

    body.CreateShape(shapeDef);
    body.SetMassFromShapes();
    body.SetUserData(def); // Stores isLethal and grappleMultiplier

    // Set initial velocity for dynamic bodies
    if (!def.static) {
      if (def.linearVelocity) {
        body.SetLinearVelocity(new b2Vec2(def.linearVelocity.x, def.linearVelocity.y));
      }
      if (def.angularVelocity !== undefined) {
        body.SetAngularVelocity(def.angularVelocity);
      }
    }

    this.platformBodies.push(body);
    if (def.name) this.platformBodyMap.set(def.name, body);
    this.calculateArenaBounds();
  }

  addCapZone(zone: { index: number; owner: string; type: number; fixture: string; shapeType: string }, x: number, y: number, width: number, height: number): void {
    const bodyDef = new b2BodyDef();
    bodyDef.position.Set(x / SCALE, y / SCALE);

    const body = this.world.CreateBody(bodyDef);

    const shapeDef = new b2PolygonDef();
    shapeDef.SetAsBox((width / 2) / SCALE, (height / 2) / SCALE);
    shapeDef.density = 0;
    shapeDef.isSensor = true;

    body.CreateShape(shapeDef);
    body.SetUserData({ isCapZone: true, zoneType: zone.type, zoneIndex: zone.index, owner: zone.owner });
    this.capZoneSensors.push(body);
  }

  setPlayerTeam(playerId: number, team: string): void {
    this.playerTeams.set(playerId, team);
  }

  getPlayerTeam(playerId: number): string | undefined {
    return this.playerTeams.get(playerId);
  }

  getTeamScored(): string | null {
    const scored = this.lastScoredTeam;
    this.lastScoredTeam = null;
    return scored;
  }

  /**
   * Calculate arena bounds based on map body extents.
   * Call this after adding all map bodies.
   */
  calculateArenaBounds(): void {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const body of this.platformBodies) {
      const aabb = new b2AABB();
      const transform = body.GetXForm();
      for (let shape = body.GetShapeList(); shape !== null; shape = shape.GetNext()) {
        shape.ComputeAABB(aabb, transform);
        minX = Math.min(minX, aabb.lowerBound.x);
        maxX = Math.max(maxX, aabb.upperBound.x);
        minY = Math.min(minY, aabb.lowerBound.y);
        maxY = Math.max(maxY, aabb.upperBound.y);
      }
    }

    if (isFinite(minX)) {
      const margin = 5; // 5 metres extra buffer
      this.arenaHalfWidth = Math.max(Math.abs(minX), Math.abs(maxX)) + margin;
      this.arenaHalfHeight = Math.max(Math.abs(minY), Math.abs(maxY)) + margin;
    }
  }

  /**
   * Set explicit map bounds from the map's physics.bounds.
   * Overrides dynamically calculated arena bounds.
   */
  setMapBounds(widthMetres: number, heightMetres: number): void {
    this.arenaHalfWidth = widthMetres / 2;
    this.arenaHalfHeight = heightMetres / 2;
  }

  getBodyMap(): Map<string, any> {
    return this.platformBodyMap;
  }

  /**
   * Add a joint between two named bodies from the map definition.
   * Looks up bodies by name in the platformBodyMap.
   */
  addJoint(def: { type: string; bodyA: string; bodyB: string; anchorA?: { x: number; y: number }; anchorB?: { x: number; y: number }; frequencyHz?: number; dampingRatio?: number; collideConnected?: boolean }, bodyMap: Map<string, any>): void {
    const bodyA = bodyMap.get(def.bodyA);
    const bodyB = bodyMap.get(def.bodyB);
    if (!bodyA || !bodyB) {
      console.warn(`Joint references unknown body: ${def.bodyA} or ${def.bodyB}`);
      return;
    }
    
    const anchorA = def.anchorA
      ? new b2Vec2(def.anchorA.x / SCALE, def.anchorA.y / SCALE)
      : bodyA.GetPosition();
    const anchorB = def.anchorB
      ? new b2Vec2(def.anchorB.x / SCALE, def.anchorB.y / SCALE)
      : bodyB.GetPosition();
    
    if (def.type === 'distance' || def.type === 'lpj') {
      const jd = new b2DistanceJointDef();
      jd.Initialize(bodyA, bodyB, anchorA, anchorB);
      jd.collideConnected = def.collideConnected ?? false;
      jd.frequencyHz = def.frequencyHz ?? 0;
      jd.dampingRatio = def.dampingRatio ?? 0;
      this.world.CreateJoint(jd);
    }
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

    // Assign collision category based on player ID
    // Player 0 = team g1 (category 0x0002), Player 1+ = team g2 (category 0x0004)
    const filter = new b2FilterData();
    filter.categoryBits = id === 0 ? 0x0002 : 0x0004;
    filter.maskBits = 0xFFFF; // Collide with everything by default
    circleDef.filter = filter;

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
    const force = this._tempForce;
    force.x = 0;
    force.y = 0;

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

    // Handle grapple toggle
    const hasGrapple = this.playerGrappleJoints.has(playerId);
    if (input.grapple && !hasGrapple) {
      this.fireGrapple(playerId);
    } else if (!input.grapple && hasGrapple) {
      this.releaseGrapple(playerId);
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
   * Fires a grapple raycast to attach to the nearest platform.
   * If it hits a grappleMultiplier surface, it acts as a slingshot instead.
   */
  private fireGrapple(playerId: number): void {
    const body = this.playerBodies.get(playerId);
    if (!body) return;

    globalProfiler.increment('grapple_fire');

    const startPos = body.GetPosition();

    // Find the nearest platform within 10m (Bonk.io grapple radius)
    // The grapple always hooks to the closest surface, not in the velocity direction
    let closestPlatform: any = null;
    let closestDist = Infinity;

    for (const pBody of this.platformBodies) {
      const pPos = pBody.GetPosition();
      const dx = pPos.x - startPos.x;
      const dy = pPos.y - startPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 10 && dist < closestDist) {
        const ud = pBody.GetUserData() || {};
        // Skip noGrapple and innerGrapple surfaces early
        if (ud.noGrapple || ud.innerGrapple) continue;
        closestDist = dist;
        closestPlatform = pBody;
      }
    }

    if (closestPlatform) {
      const ud = closestPlatform.GetUserData() || {};

      // Slingshot check (WDB mechanic)
      if (ud.grappleMultiplier === 99999) {
        body.ApplyImpulse(new b2Vec2(0, -50), startPos);
        return;
      }

      // Attach joint
      const jointDef = new b2DistanceJointDef();
      jointDef.Initialize(body, closestPlatform, startPos, closestPlatform.GetPosition());
      jointDef.collideConnected = true;
      // Bonk.io rope behaves like a somewhat elastic distance joint
      jointDef.frequencyHz = 4.0;
      jointDef.dampingRatio = 0.5;

      const joint = this.world.CreateJoint(jointDef);
      this.playerGrappleJoints.set(playerId, joint);
    }
  }

  private releaseGrapple(playerId: number): void {
    const joint = this.playerGrappleJoints.get(playerId);
    if (joint) {
      this.world.DestroyJoint(joint);
      this.playerGrappleJoints.delete(playerId);
    }
  }

  /**
   * Advance the physics simulation by exactly one tick (1/30s).
   * This is the core synchronous step — no real-time clock involved.
   */
    tick(): void {
        if (!this.world) return;
        this.world.Step(DT, SOLVER_ITERATIONS);
    this.tickCount++;

    // Check for players out of bounds (dead)
    for (const [id, body] of this.playerBodies) {
      if (!this.playerAlive.get(id)) continue;

      const pos = body.GetPosition();
      if (
        Math.abs(pos.x) > this.arenaHalfWidth ||
        Math.abs(pos.y) > this.arenaHalfHeight
      ) {
        this.playerAlive.set(id, false);
        globalProfiler.increment('death_out_of_bounds');
      }
    }

    if (isTelemetryEnabled()) {
      globalProfiler.gauge('active_joints', this.playerGrappleJoints.size);
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
   * Destroy all bodies on the existing world without replacing it.
   * Reuses the same b2World and b2BroadPhase — only the bodies and
   * their associated fixtures/shapes are removed and re-created.
   */
  destroyAllBodies(): void {
    // Destroy player bodies
    for (const [, body] of this.playerBodies) {
      try { this.world.DestroyBody(body); } catch { /* broadphase edge case */ }
    }
    this.playerBodies.clear();
    this.playerHeavyState.clear();
    this.playerAlive.clear();
    this.playerGrappleJoints.clear();

    // Destroy platform/map bodies
    for (const body of this.platformBodies) {
      try { this.world.DestroyBody(body); } catch { /* broadphase edge case */ }
    }
    this.platformBodies = [];
    this.platformBodyMap.clear();
    this.capZoneSensors = [];
    this.lastScoredTeam = null;
    this.tickCount = 0;
  }

  /**
   * Reset the world — discard the old world entirely and create a fresh one.
   * This avoids box2d broadphase corruption that occurs when destroying many
   * bodies (especially polygons and dynamic bodies) individually.
   */
  reset(): void {
    // Don't try to destroy bodies one-by-one — box2d broadphase gets corrupted
    // on complex maps. Just create a fresh world and let the old one be GC'd.
    const worldAABB = new b2AABB();
    worldAABB.lowerBound.Set(-1000, -1000);
    worldAABB.upperBound.Set(1000, 1000);
    const gravity = new b2Vec2(GRAVITY_X, GRAVITY_Y);
    this.world = new b2World(worldAABB, gravity, true);

    // Clear all state
    this.playerBodies.clear();
    this.playerHeavyState.clear();
    this.playerAlive.clear();
    this.playerGrappleJoints.clear();
    this.playerTeams.clear();
    this.capZoneSensors = [];
    this.lastScoredTeam = null;
    this.platformBodies = [];
    this.platformBodyMap = new Map();
    this.tickCount = 0;
  }

  /**
   * Completely destroy the world for cleanup.
   */
  destroy(): void {
    this.world = null;
  }
}

// ─── Telemetry Wrapping for Hot Paths ───────────────────────────────────

// Wrap selected PhysicsEngine methods for profiling
// Only enable wrapping when telemetry is explicitly enabled for performance
// Hooks are enabled lazily on first call to avoid module-load timing issues
const physicsProto = PhysicsEngine.prototype as any;
let hooksEnabled = false;

function enablePhysicsHooks(): void {
  if (hooksEnabled) return;
  
  if (!isTelemetryEnabled()) {
    return; // Skip wrapping when telemetry is disabled for performance
  }
  
  physicsProto.tick = wrap(TelemetryIndices.PHYSICS_TICK, physicsProto.tick);
  physicsProto.fireGrapple = wrap(TelemetryIndices.RAYCAST_CALL, physicsProto.fireGrapple);
  physicsProto.checkLethalCollision = wrap(
    TelemetryIndices.COLLISION_RESOLVE,
    physicsProto.checkLethalCollision,
  );
  hooksEnabled = true;
}

// Lazy hook installer - wraps methods on first access
// This ensures TelemetryController is initialized before hooks are enabled
function ensureHooks(): void {
  if (!hooksEnabled) {
    enablePhysicsHooks();
  }
}

// Wrap tick() to ensure hooks are enabled before first physics step
const originalTick = physicsProto.tick;
physicsProto.tick = function(...args: any[]) {
  ensureHooks();
  return originalTick.apply(this, args);
};
