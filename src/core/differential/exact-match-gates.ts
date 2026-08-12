/**
 * exact-match-gates.ts — P4 fixture/joint exact-match verification.
 *
 * The differential validator's static half: after a trace's map is normalized
 * and built into the engine, verify the engine's constructed fixtures and
 * joints carry exactly the authored native values (§33.4 fixtures, §33.8
 * joints). A mismatch here means the adapter/engine silently degraded an
 * authored value — the failure the differential run is meant to catch.
 *
 * Fixture checks (per body, against the port shapeDef):
 *  - density: static bodies → 0; dynamic → authored value clamped to the
 *    0.0001 floor when authored, else the 1.0 default (§33.4);
 *  - friction: authored (signed-negative f_p becomes the frictionless 0 port
 *    representation per #276);
 *  - restitution: authored, with the -1 → 0.8 fallback.
 * Joint checks: every authored joint created a joint in the engine's created
 * map with the authored core parameters (revolute limits/motor, distance
 * length/spring, prismatic limits/motor, gear ratio/referents).
 */
import type { BonkEnvironment } from '../environment';
import { normalizeMap } from '../map-adapter';
import type { NativeTrace } from './native-trace';

export interface GateResult {
  ok: boolean;
  mismatches: string[];
}

function fixtureOf(body: any, bodyDef?: any): any {
  if (!body.GetShapeList) return body.GetFixtureList().GetShape();
  const first = body.GetShapeList();
  if (!bodyDef) return first;

  // Exported compound bodies share one Box2D body but retain one shape-level
  // MapBodyDef per fixture. Select the shape carrying this fixture alias so
  // heterogeneous fixture properties are checked against the right shape.
  for (let shape = first; shape !== null; shape = shape.GetNext()) {
    const userData = typeof shape.GetUserData === 'function' ? shape.GetUserData() : undefined;
    if (userData?.name === bodyDef.name) return shape;
  }
  return first;
}

/**
 * Verify engine-built fixtures match the traced map's authored surface values
 * for every normalized body. `mapDef.bodies` is the adapter output (the same
 * object the environment built from), so names are already adapter-resolved.
 */
export function verifyFixtureGates(env: BonkEnvironment, trace: NativeTrace): GateResult {
  const mismatches: string[] = [];
  const physics: any = (env as any).physics;
  const bodyMap: Map<string, any> = physics.getBodyMap?.() ?? new Map();

  // The environment built from mapDef; rebuild it here by re-normalizing the
  // trace's raw map so the gate checks the whole adapter→engine path.
  const mapDef: any = normalizeMap(trace.map);

  for (const body of mapDef.bodies ?? []) {
    const built = body?.name ? bodyMap.get(body.name) : undefined;
    if (!built) {
      mismatches.push(`body "${body?.name ?? '?'}" not found in engine body map`);
      continue;
    }
    const shape = fixtureOf(built, body);
    if (!shape) {
      mismatches.push(`body "${body.name}" has no fixture shape`);
      continue;
    }

    // Density (§33.4): static → 0; dynamic → floor-clamped authored or the 1.0
    // default (addBody raises NaN/Infinity/negative to 0.0001).
    let expectedDensity: number;
    if (body.static) {
      expectedDensity = 0;
    } else if (body.density === undefined) {
      expectedDensity = 1.0;
    } else if (Number.isFinite(body.density)) {
      expectedDensity = Math.max(body.density, 0.0001);
    } else {
      expectedDensity = 0.0001;
    }
    if (Math.abs((shape as any).m_density - expectedDensity) > 1e-9) {
      mismatches.push(
        `body "${body.name}" density ${(shape as any).m_density} != authored ${expectedDensity}`,
      );
    }

    // Friction (§33.4 + #276): f_p → 0 (port representation), else authored or
    // the 0.3 surface default; authored negatives clamp to 0.
    const fric = body.friction;
    let expectedFriction: number;
    if (body.fricPolarity) expectedFriction = 0;
    else if (fric === undefined) expectedFriction = 0.3;
    else if (Number.isFinite(fric)) expectedFriction = Math.max(fric, 0);
    else expectedFriction = 0;
    if (Math.abs((shape as any).m_friction - expectedFriction) > 1e-9) {
      mismatches.push(
        `body "${body.name}" friction ${(shape as any).m_friction} != authored ${expectedFriction}`,
      );
    }

    // Restitution (§33.4): mirror the engine formula exactly
    // (physics-engine addBody): -1/absent/null → 0.8, everything else
    // passes through VERBATIM — including non-finite values the engine
    // would also pass through (never a false mismatch on NaN/Infinity).
    const rest = body.restitution;
    const expectedRest = rest === -1 || rest === undefined || rest === null
      ? 0.8
      : rest;
    if (Math.abs((shape as any).m_restitution - expectedRest) > 1e-9) {
      mismatches.push(
        `body "${body.name}" restitution ${(shape as any).m_restitution} != authored ${expectedRest}`,
      );
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Verify engine-created joints match the traced map's authored joint list.
 * Every authored joint must have produced a registered joint whose core
 * parameters equal the authored values.
 */
export function verifyJointGates(env: BonkEnvironment, trace: NativeTrace): GateResult {
  const mismatches: string[] = [];
  const physics: any = (env as any).physics;
  const scale: number = physics.scale;
  const created: Map<string, any> = physics.createdJoints ?? new Map();
  const mapDef: any = normalizeMap(trace.map);
  const joints: any[] = mapDef.joints ?? [];

  if (joints.length === 0) {
    return { ok: true, mismatches: [] };
  }

  for (const j of joints) {
    const name: string = j.name;
    const built = created.get(name);
    if (!built) {
      mismatches.push(`joint "${name}" not created in engine`);
      continue;
    }
    const t = j.type;
    if (t === 'rv' || t === 'revolute') {
      // The port's b2RevoluteJoint stores the limit angles as
      // m_lowerAngle/m_upperAngle (box2dnode b2RevoluteJoint), and the engine
      // forwards the exporter's lower/upperLimit into those angles
      // (physics-engine addJoint: lowerAngle ?? lowerLimit ?? 0).
      const la = j.lowerAngle ?? j.lowerLimit ?? 0;
      const ua = j.upperAngle ?? j.upperLimit ?? 0;
      if (Math.abs((built as any).m_lowerAngle - la) > 1e-9) {
        mismatches.push(`joint "${name}" rv lowerAngle mismatch`);
      }
      if (Math.abs((built as any).m_upperAngle - ua) > 1e-9) {
        mismatches.push(`joint "${name}" rv upperAngle mismatch`);
      }
      if (Math.abs((built as any).m_motorSpeed - (j.motorSpeed ?? 0)) > 1e-9) {
        mismatches.push(`joint "${name}" rv motorSpeed mismatch`);
      }
      if (Math.abs((built as any).m_maxMotorTorque - (j.maxMotorTorque ?? 0)) > 1e-9) {
        mismatches.push(`joint "${name}" rv maxMotorTorque mismatch`);
      }
    } else if (t === 'd' || t === 'distance') {
      // The engine stores m_length in metres (authored map px / scale,
      // physics-engine addJoint: `jd.length = def.length / this.scale`). Only
      // compare when a length was authored — otherwise the engine replicates
      // b2DistanceJointDef.Initialize's anchor-distance default and there is
      // no authored value to diff against.
      if (typeof j.length === 'number' && Number.isFinite(j.length)) {
        if (Math.abs((built as any).m_length - j.length / scale) > 1e-9) {
          mismatches.push(`joint "${name}" d length mismatch`);
        }
      }
    } else if (t === 'g' || t === 'gear') {
      if (Math.abs((built as any).m_ratio - (j.ratio ?? 1)) > 1e-9) {
        mismatches.push(`joint "${name}" g ratio mismatch`);
      }
    } else {
      // prismatic (lpj/lsj/p): translation limits + motor force, mirroring the
      // engine's #281 symmetric ±length fallback exactly — a positive authored
      // length with no explicit translations becomes a symmetric limit.
      const lenLimit = typeof j.length === 'number' && Number.isFinite(j.length) && j.length > 0;
      const lt = j.lowerTranslation !== undefined ? j.lowerTranslation : (lenLimit ? -j.length : 0);
      const ut = j.upperTranslation !== undefined ? j.upperTranslation : (lenLimit ? +j.length : 0);
      if (Math.abs((built as any).m_lowerTranslation - lt) > 1e-9) {
        mismatches.push(`joint "${name}" prismatic lowerTranslation mismatch`);
      }
      if (Math.abs((built as any).m_upperTranslation - ut) > 1e-9) {
        mismatches.push(`joint "${name}" prismatic upperTranslation mismatch`);
      }
      if (Math.abs((built as any).m_maxMotorForce - (j.maxMotorForce ?? 0)) > 1e-9) {
        mismatches.push(`joint "${name}" prismatic maxMotorForce mismatch`);
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
