import { createBackend } from './backend';
import { DT } from '../shared/units';
import { safeCos, safeSin, safeATan2 } from './safe-trig';
import {
  cloneNativeMapPhysics,
  normalizeNativeMap,
  type NativeBody,
  type NativeJoint,
  type NativeMapPhysics,
  type NativeMapSource,
  type NativeShape,
} from './native-map-state';

export interface NativeWorldStepOptions {
  /** Defaults to the native active-round gate: the input ftu is exactly -1. */
  simulate?: boolean;
  /** Native map quality: q1 = 2/6 solver iterations, q2 = 15/15. */
  quality?: 1 | 2;
  /** Physics.step boundary; normally 30 ms. stepScale must be a positive integer. */
  deltaMs?: number;
  stepScale?: number;
}

export interface NativeWorldBuildContext {
  /** The sole world used by both map bodies and composed discs/projectiles. */
  readonly world: any;
  /** RL-local isolated backend, including SafeTrig-injected Box2D classes. */
  readonly backend: any;
  readonly ground: any;
  /** Arrays retain authored indices, including holes and deleted joints. */
  readonly bodies: readonly any[];
  readonly fixtures: readonly any[];
  readonly shapes: readonly any[];
  readonly joints: readonly any[];
  readonly physics: NativeMapPhysics;
  readonly options: Readonly<Required<NativeWorldStepOptions>>;
}

export interface NativeWorldComposition<T> {
  /** Disc construction, before native map bodies. */
  build?(context: NativeWorldBuildContext): T;
  /** Cap tags and grapple construction after map bodies/joints. */
  afterMap?(context: NativeWorldBuildContext, carrier: T): void;
  /** Existing projectile construction, after grapples and before controls. */
  buildProjectiles?(context: NativeWorldBuildContext, carrier: T): void;
  /** Player controls, contact-dependent actions and new projectile releases. */
  beforeStep?(context: NativeWorldBuildContext, carrier: T): void;
  /** Read composed state after Step/ClearForces and map extraction. */
  extract?(context: NativeWorldBuildContext, carrier: T): void;
  /** Native death/capture/round lifecycle follows map/joint extraction. */
  afterExtract?(context: NativeWorldBuildContext, carrier: T, physics: NativeMapPhysics): void;
}

export interface NativeWorld {
  /** Advance one native tick from an already normalized, renderer-free state. */
  step(physics: NativeMapPhysics, options?: NativeWorldStepOptions): NativeMapPhysics;
  /** Compose players/projectiles with map bodies in this same rebuilt world. */
  stepWith<T = undefined>(
    physics: NativeMapPhysics,
    options: NativeWorldStepOptions | undefined,
    composition: NativeWorldComposition<T>,
  ): NativeMapPhysics;
  /** Convenience raw-v15 boundary; normalization is completed before Box2D is touched. */
  stepAuthored(map: NativeMapSource, options?: NativeWorldStepOptions): NativeMapPhysics;
  dispose(): void;
}

function invalid(reason: string): never {
  throw new Error(`Invalid native world input: ${reason}`);
}

/** Current dimensions consumed by world construction; original shape sizes stay authored. */
export function nativeShapeExtent(
  shape: NativeShape,
  shapeIndex: number,
  shrink: readonly (readonly [number, number])[],
): number | undefined {
  if (shape.type === 'po') return undefined;
  let extent = shape.type === 'bx' ? shape.w : shape.r;
  if (shape.sk) {
    for (const entry of shrink) {
      if (entry[0] === shapeIndex) {
        extent = entry[1];
        break;
      }
    }
  }
  return extent;
}

function shrunkExtent(shape: NativeShape, shapeIndex: number, physics: NativeMapPhysics): number | undefined {
  if (shape.type === 'po') return undefined;
  return nativeShapeExtent(shape, shapeIndex, physics.ss);
}

export function createNativeWorld(): NativeWorld {
  const B = createBackend();
  const Vec2 = B.Common.Math.b2Vec2;
  const Body = B.Dynamics.b2Body;
  const BodyDef = B.Dynamics.b2BodyDef;
  const FixtureDef = B.Dynamics.b2FixtureDef;
  const CircleShape = B.Collision.Shapes.b2CircleShape;
  const PolygonShape = B.Collision.Shapes.b2PolygonShape;
  const RevoluteJointDef = B.Dynamics.Joints.b2RevoluteJointDef;
  const PrismaticJointDef = B.Dynamics.Joints.b2PrismaticJointDef;
  const DistanceJointDef = B.Dynamics.Joints.b2DistanceJointDef;
  let world: any = new B.Dynamics.b2World(new Vec2(0, 20));
  world.SetWarmStarting(false);
  let disposed = false;

  function buildShapes(physics: NativeMapPhysics): any[] {
    const shapes: any[] = Array.from({ length: physics.shapes.length });
    for (let index = 0; index < physics.shapes.length; index++) {
      const shape = physics.shapes[index];
      if (!shape) continue;
      if (shape.type === 'bx') {
        const polygon = new PolygonShape();
        const halfWidth = shrunkExtent(shape, index, physics)! / 2;
        const halfHeight = shape.h / 2;
        const cos = safeCos(shape.a);
        const sin = safeSin(shape.a);
        // Native's clockwise-from-top-right order is retained, not SetAsBox's
        // ordering; tied manifold selection depends on this construction.
        const vertices = [
          [halfWidth, -halfHeight],
          [halfWidth, halfHeight],
          [-halfWidth, halfHeight],
          [-halfWidth, -halfHeight],
        ].map(([x, y]) => new Vec2(cos * x - sin * y + shape.c[0], sin * x + cos * y + shape.c[1]));
        polygon.SetAsArray(vertices);
        polygon.arrayID = index;
        shapes[index] = polygon;
      } else if (shape.type === 'ci') {
        const circle = new CircleShape();
        circle.SetRadius(shrunkExtent(shape, index, physics)!);
        circle.SetLocalPosition(new Vec2(shape.c[0], shape.c[1]));
        circle.arrayID = index;
        shapes[index] = circle;
      } else {
        if (shape.v.length >= 3) {
          const polygon = new PolygonShape();
          polygon.SetAsArray(shape.v.map(([x, y]) => new Vec2(x, y)));
          polygon.arrayID = index;
          shapes[index] = polygon;
        } else {
          // Native uses an origin-centred radius-two fallback for a degenerate
          // polygon; shape.c/a are not applied a second time.
          const circle = new CircleShape();
          circle.SetRadius(2);
          circle.arrayID = index;
          shapes[index] = circle;
        }
      }
    }
    return shapes;
  }

  function bodyType(body: NativeBody, physics: NativeMapPhysics): number {
    if (body.s.type === 's') return Body.b2_staticBody;
    // Native forces a nominally dynamic/kinematic body with only np fixtures to
    // static. The created empty body still has a stable index and pose carrier.
    const hasPhysics = body.fx.some((fixture) => physics.fixtures[fixture]?.np === false);
    if (!hasPhysics) return Body.b2_staticBody;
    return body.s.type === 'd' ? Body.b2_dynamicBody : Body.b2_kinematicBody;
  }

  function buildBodies(
    physics: NativeMapPhysics,
    shapes: readonly any[],
    applyConstantForce: boolean,
    fixtures: any[],
    bodies: any[],
  ): any[] {
    for (let index = 0; index < physics.bodies.length; index++) {
      const state = physics.bodies[index];
      if (!state) continue;
      const definition = new BodyDef();
      definition.type = bodyType(state, physics);
      definition.position.Set(state.p[0], state.p[1]);
      definition.angle = state.a;
      definition.linearVelocity.Set(state.lv[0], state.lv[1]);
      definition.angularVelocity = state.av;
      definition.linearDamping = state.s.ld;
      definition.angularDamping = state.s.ad;
      definition.fixedRotation =
        state.s.fr && !physics.joints.some((joint) => joint && (joint.ba === index || joint.bb === index));
      definition.bullet = state.s.bu;
      definition.userData = { type: 'phys', arrayID: index };
      const body = world.CreateBody(definition);
      bodies[index] = body;
      for (const fixtureIndex of state.fx) {
        const fixtureState = physics.fixtures[fixtureIndex];
        if (!fixtureState) invalid(`body ${index} references missing fixture ${fixtureIndex}`);
        if (fixtureState.np) continue;
        const shape = shapes[fixtureState.sh];
        if (!shape) invalid(`fixture ${fixtureIndex} references missing shape ${fixtureState.sh}`);
        const fixture = new FixtureDef();
        const baseFriction = fixtureState.fr !== null ? fixtureState.fr : state.s.fric;
        const negative = fixtureState.fp !== null ? fixtureState.fp : state.s.fricp;
        fixture.friction = negative ? -baseFriction : baseFriction;
        fixture.restitution = fixtureState.re !== null ? fixtureState.re : state.s.re;
        fixture.density = fixtureState.de !== null ? fixtureState.de : state.s.de;
        if (fixture.density <= 0) fixture.density = 0.0001;
        fixture.isSensor = false;
        fixture.filter.categoryBits = Math.pow(2, state.s.f_c) * 2;
        fixture.filter.maskBits = 65535;
        if (state.s.f_p === false) fixture.filter.maskBits -= 1;
        if (state.s.f_1 === false) fixture.filter.maskBits -= 4;
        if (state.s.f_2 === false) fixture.filter.maskBits -= 8;
        if (state.s.f_3 === false) fixture.filter.maskBits -= 16;
        if (state.s.f_4 === false) fixture.filter.maskBits -= 32;
        fixture.filter.groupIndex = 0;
        fixture.userData = {
          arrayID: fixtureIndex,
          color: fixtureState.f,
          death: fixtureState.d,
          noPhysics: fixtureState.np,
          noGrapple: fixtureState.ng,
          innerGrapple: fixtureState.ig,
        };
        fixture.shape = shape;
        fixtures[fixtureIndex] = body.CreateFixture(fixture);
      }
      // This second assignment is native and follows fixture mass assignment.
      body.SetLinearVelocity(new Vec2(state.lv[0], state.lv[1]));
      if (applyConstantForce) {
        const force = state.cf;
        if (force.x !== 0 || force.y !== 0) {
          let vector = new Vec2(force.x, force.y);
          if (force.w === false) vector = body.GetWorldVector(vector);
          // cf is a direct per-rebuild velocity carrier, not ApplyForce and not
          // a mass-scaled impulse. No persistent world force is accumulated.
          body.GetLinearVelocity().x += vector.x;
          body.GetLinearVelocity().y += vector.y;
        }
        if (force.ct !== 0) body.SetAngularVelocity(body.GetAngularVelocity() + force.ct);
      }
    }
    return bodies;
  }

  function createJoint(joint: NativeJoint, bodies: readonly any[], ground: any): any {
    const bodyA = joint.ba === -1 ? ground : bodies[joint.ba];
    const bodyB = joint.bb === -1 ? ground : bodies[joint.bb];
    if (!bodyA || !bodyB) invalid('joint references a missing body');
    if (joint.type === 'rv') {
      const definition = new RevoluteJointDef();
      definition.bodyA = bodyA;
      definition.bodyB = bodyB;
      definition.localAnchorA.Set(joint.aa[0], joint.aa[1]);
      definition.localAnchorB.Set(joint.ab[0], joint.ab[1]);
      // Native deliberately leaves referenceAngle at its Box2D default (0),
      // rather than assigning the normalized ra carrier here.
      definition.enableLimit = joint.d.el;
      definition.lowerAngle = joint.d.la;
      definition.upperAngle = joint.d.ua;
      definition.enableMotor = joint.d.em;
      definition.motorSpeed = joint.d.ms;
      definition.maxMotorTorque = joint.d.mmt;
      definition.collideConnected = joint.d.cc === true;
      return world.CreateJoint(definition);
    }
    if (joint.type === 'p') {
      const definition = new PrismaticJointDef();
      definition.bodyA = bodyA;
      definition.bodyB = bodyB;
      definition.localAnchorA.Set(joint.aa[0], joint.aa[1]);
      definition.localAnchorB.Set(joint.ab[0], joint.ab[1]);
      definition.localAxisA.Set(joint.axa[0], joint.axa[1]);
      definition.referenceAngle = 0;
      definition.enableLimit = joint.d.el;
      definition.lowerTranslation = joint.d.lt;
      definition.upperTranslation = joint.d.ut;
      definition.enableMotor = joint.d.em;
      definition.motorSpeed = joint.d.ms;
      definition.maxMotorForce = joint.d.mmf;
      definition.collideConnected = joint.d.cc === true;
      const handle = world.CreateJoint(definition);
      const data = { changeSide: joint.cs };
      if (joint.d.cd && joint.d.el) {
        const translation = handle.GetJointTranslation();
        if ((joint.cs === 0 || joint.cs === 1) && translation > 0 && translation / joint.d.ut > 0.99) {
          handle.SetMotorSpeed(-handle.GetMotorSpeed());
          data.changeSide = 2;
        } else if ((joint.cs === 0 || joint.cs === 2) && translation < 0 && translation / joint.d.lt > 0.99) {
          handle.SetMotorSpeed(-handle.GetMotorSpeed());
          data.changeSide = 1;
        }
      }
      handle.SetUserData(data);
      return handle;
    }
    if (joint.type === 'lpj') {
      // Native step (alpha2s.slot-accurate.numeric.js :5689-5739): a motorized
      // prismatic whose axis is the path angle rotated into body A's frame,
      // anchored at (0,0) on body A and (pax,pay) on body B, limited to ±plen,
      // with motor force pf and speed pms. When the joint sits at a limit
      // against the motor's direction, the motor reverses and body A's linear
      // velocity is zeroed before CreateJoint.
      const definition = new PrismaticJointDef();
      definition.bodyA = bodyA;
      definition.bodyB = bodyB;
      definition.localAnchorA.Set(0, 0);
      definition.localAnchorB.Set(joint.pax, joint.pay);
      definition.referenceAngle = -bodyA.GetAngle();
      definition.upperTranslation = joint.plen;
      definition.lowerTranslation = -joint.plen;
      definition.enableLimit = true;
      const jointAngle = joint.pa - bodyA.GetAngle();
      const axisX = safeCos(jointAngle);
      const axisY = safeSin(jointAngle);
      definition.localAxisA.Set(axisX, axisY);
      definition.enableMotor = true;
      definition.maxMotorForce = joint.pf;
      definition.motorSpeed = joint.pms;
      const xModifier = joint.pax + safeCos(joint.pa) * -joint.plen;
      const yModifier = joint.pay + safeSin(joint.pa) * -joint.plen;
      const jointPos = bodyA.GetPosition().Copy();
      jointPos.Subtract(new Vec2(xModifier, yModifier));
      const jointPosLength = jointPos.Length();
      let chk = jointPosLength / (joint.plen * 2);
      chk -= 0.5;
      chk *= 2;
      if ((joint.pms < 0 && chk > 0.99) || (joint.pms > 0 && chk < -0.99)) {
        definition.motorSpeed = -definition.motorSpeed;
        bodyA.SetLinearVelocity(new Vec2(0, 0));
      }
      return world.CreateJoint(definition);
    }
    if (joint.type === 'lsj') {
      // Native step (:5741-5800): a vertical-axis prismatic spring. The motor
      // force scales with the normalized stretch k = (len/(2·slen) − 0.5)·2,
      // where len is the signed distance from body A's position to the spring
      // anchor offset by (sax,say) − R(θ)·slen (θ = bodyA angle − π/2); the
      // sign flips when the anchor angle falls outside [−π, 0) ∪ (π, 2π).
      // motorSpeed is 300, or −300 when k > 0.
      const definition = new PrismaticJointDef();
      definition.bodyA = bodyA;
      definition.bodyB = bodyB;
      definition.localAnchorA.Set(0, 0);
      definition.localAnchorB.Set(joint.sax, joint.say);
      definition.referenceAngle = -bodyA.GetAngle();
      definition.upperTranslation = joint.slen;
      definition.lowerTranslation = -joint.slen;
      definition.enableLimit = false;
      definition.localAxisA.Set(0, 1);
      definition.enableMotor = true;
      definition.maxMotorForce = joint.sf;
      definition.motorSpeed = 300;
      const angle = bodyA.GetAngle() - Math.PI / 2;
      const anchorX = joint.sax + safeCos(angle) * -joint.slen;
      const anchorY = joint.say + safeSin(angle) * -joint.slen;
      const jointPos = bodyA.GetPosition().Copy();
      jointPos.Subtract(new Vec2(anchorX, anchorY));
      let length = jointPos.Length();
      let atanAngle = safeATan2(jointPos.y, jointPos.x) - bodyA.GetAngle();
      atanAngle = atanAngle % (2 * Math.PI);
      if ((atanAngle < 0 && atanAngle >= -Math.PI) || atanAngle > Math.PI) {
        // length stays positive
      } else {
        length = -length;
      }
      let motorForceModifier = length / (joint.slen * 2);
      motorForceModifier -= 0.5;
      motorForceModifier *= 2;
      definition.maxMotorForce = joint.sf * Math.abs(motorForceModifier);
      if (motorForceModifier > 0) {
        definition.motorSpeed = -300;
      }
      return world.CreateJoint(definition);
    }
    const definition = new DistanceJointDef();
    definition.bodyA = bodyA;
    definition.bodyB = bodyB;
    definition.localAnchorA.Set(joint.aa[0], joint.aa[1]);
    definition.localAnchorB.Set(joint.ab[0], joint.ab[1]);
    definition.length = joint.len;
    definition.frequencyHz = joint.d.fh;
    definition.dampingRatio = joint.d.dr;
    definition.collideConnected = joint.d.cc === true;
    return world.CreateJoint(definition);
  }

  function readOptions(options: NativeWorldStepOptions, physics: NativeMapPhysics): Required<NativeWorldStepOptions> {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid('options must be an object');
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== 'string' || !['simulate', 'quality', 'deltaMs', 'stepScale'].includes(key))
        invalid(`unsupported option ${String(key)}`);
    }
    const simulate = options.simulate ?? physics.ftu === -1;
    const quality = options.quality ?? 1;
    const deltaMs = options.deltaMs ?? 30;
    const stepScale = options.stepScale ?? 1;
    if (typeof simulate !== 'boolean') invalid('simulate must be boolean');
    if (quality !== 1 && quality !== 2) invalid('quality must be 1 or 2');
    if (!Number.isFinite(deltaMs) || deltaMs === 0) invalid('deltaMs must be finite and nonzero');
    if (!Number.isSafeInteger(stepScale) || stepScale < 1 || stepScale > 120)
      invalid('stepScale must be an integer in [1, 120]');
    return { simulate, quality, deltaMs, stepScale };
  }

  function step(
    rawPhysics: NativeMapPhysics,
    rawOptions: NativeWorldStepOptions = {},
    composition: NativeWorldComposition<any> = {},
  ): NativeMapPhysics {
    if (disposed) throw new Error('Native world instance has been disposed');
    // Strict validation also deep-clones: no input table or nested carrier can be
    // changed by shrink/break/motor/body extraction below.
    const physics = normalizeNativeMap(
      { physics: rawPhysics, ...(rawPhysics.ftu === undefined ? {} : { ftu: rawPhysics.ftu }) } as NativeMapSource,
      { authored: false },
    );
    const options = readOptions(rawOptions, physics);
    if (composition === null || typeof composition !== 'object' || Array.isArray(composition))
      invalid('composition must be an object');
    for (const key of Reflect.ownKeys(composition)) {
      if (
        typeof key !== 'string' ||
        !['build', 'afterMap', 'buildProjectiles', 'beforeStep', 'extract', 'afterExtract'].includes(key)
      )
        invalid(`unsupported composition callback ${String(key)}`);
    }
    for (const callback of [
      composition.build,
      composition.afterMap,
      composition.buildProjectiles,
      composition.beforeStep,
      composition.extract,
      composition.afterExtract,
    ]) {
      if (callback !== undefined && typeof callback !== 'function') invalid('composition callbacks must be functions');
    }
    const applyConstantForce = physics.ftu === -1;
    const output = cloneNativeMapPhysics(physics);
    if (output.ftu !== undefined && output.ftu > -1) output.ftu -= 1;
    output.ss = [];
    if (physics.ftu !== undefined && physics.ftu <= 0) {
      for (let index = 0; index < physics.shapes.length; index++) {
        const shape = physics.shapes[index];
        if (!shape || !shape.sk || shape.type === 'po') continue;
        const current = shrunkExtent(shape, index, physics)!;
        if (shape.type === 'bx') output.ss.push([index, Math.max(1, current - 0.03)]);
        else output.ss.push([index, Math.max(0.5, current - 0.015)]);
      }
    }

    world.novakReset();
    if (world.GetGravity().y !== 20) world.SetGravity(new Vec2(0, 20));
    // Box2D unconditionally dispatches BeginContact when a listener slot is
    // present. A no-op native listener is required even for map-only contacts;
    // composed sessions may replace it in build() before the shared Step.
    world.SetContactListener(new B.Dynamics.b2ContactListener());
    const ground = world.GetGroundBody();
    ground.SetUserData({ arrayID: -1 });
    const shapes = buildShapes(physics);
    const fixtures: any[] = new Array(physics.fixtures.length);
    const bodies: any[] = new Array(physics.bodies.length);
    const joints: any[] = new Array(physics.joints.length);
    const context: NativeWorldBuildContext = {
      world,
      backend: B,
      ground,
      bodies,
      fixtures,
      shapes,
      joints,
      physics,
      options,
    };
    const carrier = composition.build?.(context);
    buildBodies(physics, shapes, applyConstantForce, fixtures, bodies);
    for (let index = 0; index < physics.joints.length; index++) {
      const joint = physics.joints[index];
      if (joint) joints[index] = createJoint(joint, bodies, ground);
    }
    composition.afterMap?.(context, carrier);
    composition.buildProjectiles?.(context, carrier);
    composition.beforeStep?.(context, carrier);

    if (options.simulate) {
      const velocityIterations = options.quality === 2 ? 15 : 2;
      const positionIterations = options.quality === 2 ? 15 : 6;
      const dt = 1 / (options.deltaMs * options.stepScale);
      for (let index = 0; index < options.stepScale; index++) world.Step(dt, velocityIterations, positionIterations);
    }
    world.ClearForces();

    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index];
      if (!body) continue;
      const state = output.bodies[index]!;
      const position = body.GetPosition();
      const velocity = body.GetLinearVelocity();
      state.p = [position.x, position.y];
      state.a = body.GetAngle();
      state.av = body.GetAngularVelocity();
      state.lv = [velocity.x, velocity.y];
    }
    for (let index = 0; index < physics.joints.length; index++) {
      const joint = output.joints[index];
      const handle = joints[index];
      if (!joint || !handle) continue;
      if (joint.type === 'p') {
        joint.cs = handle.GetUserData().changeSide;
        joint.d.ms = handle.GetMotorSpeed();
      }
      // Native post-step writeback (:6869-6872): lpj motor speed persists in
      // state via GetMotorSpeed; lsj has no writeback.
      if (joint.type === 'lpj') {
        joint.pms = handle.GetMotorSpeed();
      }
      // Native uses 1/deltaMs (not actual dt or 1/(deltaMs*stepScale)) here.
      if (joint.d.bf > 0 && handle.GetReactionForce(1 / options.deltaMs).Length() > joint.d.bf) {
        output.joints[index] = null;
      }
    }
    composition.extract?.(context, carrier);
    composition.afterExtract?.(context, carrier, output);
    // Native drops all bodies and joints only after extracting state. Resetting
    // on the next tick also resets contact solver and broadphase bookkeeping.
    while (world.GetBodyList()) world.DestroyBody(world.GetBodyList());
    while (world.GetJointList()) world.DestroyJoint(world.GetJointList());
    return output;
  }

  return {
    step,
    stepWith(physics, options = {}, composition) {
      return step(physics, options, composition);
    },
    stepAuthored(map, options = {}) {
      if (disposed) throw new Error('Native world instance has been disposed');
      return step(normalizeNativeMap(map, { authored: true }), options);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      world.novakReset();
      world = null;
    },
  };
}

// Keep DT in the module's public documentation as the normal 30 ms tick; the
// generic stepScale/deltaMs boundary intentionally computes the native dt above.
export const NATIVE_WORLD_DT = DT;
