/**
 * physics-fidelity-p4.test.ts — P4 differential validation.
 *
 * Native evidence (DEOBFUSCATION §33.4 fixtures / §33.8 joints; LIVE_STATE
 * EXTRACTION §9.2/§9.4 field set):
 *  - The native disc export records x,y,xv,yv,a,av plus heavy/grapple bits and
 *    alive == presence.
 *  - Coordinate reconciliation (§9.5) makes engine getPlayerState units ==
 *    native disc units 1:1, so a replay comparator can diff them directly.
 *  - Exact-match gates verify the engine's built fixtures/joints reproduce the
 *    traced map's authored values exactly (§33.4 density/friction/restitution,
 *    §33.8 joint params).
 *
 * The comparator itself is validated end-to-end by RECORDING a trace from a
 * deterministic engine run (neutral inputs, fixed seed) and replaying it: the
 * replay must reproduce the recorded positions within tight tolerance. A
 * deliberately perturbed trace must instead FAIL the same run, proving the
 * comparator actually discriminates (the differential gate's purpose).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BonkEnvironment } from '../../src/core/environment';
import { normalizeMap } from '../../src/core/map-adapter';
import {
  NativeTraceRecorder,
  parseNativeTrace,
  serializeNativeTrace,
  TRACE_SCHEMA_VERSION,
} from '../../src/core/differential';
import { buildTraceEnvironment, compareTrace } from '../../src/core/differential/replay-comparator';
import { verifyFixtureGates, verifyJointGates } from '../../src/core/differential/exact-match-gates';
import { OUT_OF_BOUNDS_DISTANCE } from '../../src/core/physics-engine';
import type { PlayerInput } from '../../src/core/physics-engine';
import type { NativeTrace } from '../../src/core/differential/native-trace';

const SIMPLE_1V1 = path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json');
// Tracked repo fixture (5 ground lpj joints); maps/bonk_WDB__No_Mapshake__
// 716916.json is gitignored scratch and must never be a test dependency.
const WDB_GROUND_JOINTS = path.join(process.cwd(), 'maps', 'bonk_WDB__no_nothing__1232248.json');

function loadMap(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Minimal exported-map trace with one lsj joint between a static anchor body
 *  and a dynamic spring body (the P2b decoder-canonical setup from
 *  physics-fidelity-p2b.test.ts), with a configurable authored anchorA. */
function makeLsjTrace(anchorA: { x: number; y: number }): NativeTrace {
  const rawMap: any = {
    bodies: [
      { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
      { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 40, width: 20, height: 20, static: false, density: 1 },
    ],
    spawns: [{ x: 0, y: 0, blue: true, red: true }],
    physicsJoints: [
      {
        index: 0,
        type: 'lsj',
        bodyA: 0,
        bodyB: 1,
        anchorA,
        axis: { x: 0, y: 1 },
        lowerTranslation: -40,
        upperTranslation: 40,
        length: 40,
        enableLimit: false,
        enableMotor: true,
        motorSpeed: 300,
        maxMotorForce: 25,
      },
    ],
  };
  return {
    schema: 'bonk.rl.env.native-trace',
    version: TRACE_SCHEMA_VERSION,
    tps: 30,
    map: rawMap,
    players: [{ id: 0, team: 1 }],
    spawns: [{ id: 0, x: 0, y: 0 }],
    ticks: [],
  };
}

/** Deterministic sim recording: step an engine N ticks with neutral (zero)
 *  inputs and capture recorder ticks, yielding a trace the comparator replays.
 *  Player 0 is the AI slot; extra players are the opponent slots. */
function recordSimTrace(
  mapRaw: unknown,
  ticks: number,
  numOpponents: number,
  seed = 7,
): { trace: NativeTrace; env: BonkEnvironment } {
  const mapDef: any = normalizeMap(mapRaw);
  const env = new BonkEnvironment({
    numOpponents,
    seed,
    mapData: mapDef,
    randomOpponent: false,
    maxTicks: ticks + 8,
  } as any);

  const physics: any = (env as any).physics;
  const players: Array<{ id: number; team: number }> = [];
  for (let i = 0; i <= numOpponents; i++) players.push({ id: i, team: i === 0 ? 1 : 2 });
  env.reset(seed);

  // NativeTrace.spawns describes the round-start state. Capture it before the
  // first tick advances bodies under gravity or any other map forces.
  const spawns: Array<{ id: number; x: number; y: number }> = [];
  for (let i = 0; i <= numOpponents; i++) {
    const body = physics.playerBodies?.get(i);
    const pos = body?.GetPosition();
    spawns.push({ id: i, x: (pos?.x ?? 0) * physics.scale, y: (pos?.y ?? 0) * physics.scale });
  }
  const rec = new NativeTraceRecorder({ map: mapRaw, players, spawns });

  // Apply the neutral inputs first, then step, then capture — the same order
  // the comparator replays (inputs → tick → read), so recorded tick t holds
  // the post-step state of the t-th replay step and diffs are directly aligned.
  for (let t = 0; t < ticks; t++) {
    physics.applyInput(0, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
    if (numOpponents >= 1)
      physics.applyInput(1, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
    physics.tick();

    const states: any[] = [];
    for (let i = 0; i <= numOpponents; i++) {
      const body = physics.playerBodies?.get(i);
      if (!body || !physics.playerAlive.get(i)) {
        states[i] = undefined;
        continue;
      }
      const pos = body.GetPosition();
      const vel = body.GetLinearVelocity();
      states[i] = {
        x: pos.x * physics.scale,
        y: pos.y * physics.scale,
        xv: vel.x * physics.scale,
        yv: vel.y * physics.scale,
        a: body.GetAngle(),
        av: body.GetAngularVelocity(),
      };
    }
    rec.push({ t, discs: states });
  }

  return { trace: rec.toTrace(), env };
}

describe('P4: differential validation — trace schema (DEOBFUSCATION/LIVE_STATE)', () => {
  it('round-trips a serialize→parse trace with no errors', () => {
    const raw = loadMap(SIMPLE_1V1);
    const trace: NativeTrace = {
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: raw,
      settings: { re: false, nc: false, pq: 1, gd: 25, fl: false },
      players: [
        { id: 0, team: 1 },
        { id: 1, team: 2 },
      ],
      spawns: [
        { id: 0, x: -100, y: -25 },
        { id: 1, x: 100, y: -25 },
      ],
      ticks: [
        {
          t: 0,
          discs: [
            { id: 0, x: -100, y: -25, xv: 0, yv: 0, a: 0, av: 0, alive: true },
            { id: 1, x: 100, y: -25, xv: 0, yv: 0, a: 0, av: 0, alive: true },
          ],
        },
      ],
    };
    const parsed = parseNativeTrace(JSON.parse(serializeNativeTrace(trace)));
    expect(parsed.errors).toEqual([]);
    expect(parsed.trace.ticks.length).toBe(1);
    expect(parsed.trace.ticks[0].discs[0]?.x).toBe(-100);
  });

  it('rejects wrong schema/version as errors', () => {
    const parsed = parseNativeTrace({ schema: 'nope', version: 1, tps: 30, players: [], spawns: [], ticks: [] });
    expect(parsed.errors.length).toBeGreaterThan(0);
    const v2 = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: 99,
      tps: 30,
      players: [],
      spawns: [],
      ticks: [],
    });
    expect(v2.errors.some((e) => /unsupported schema version/.test(e))).toBe(true);
  });

  it('reports malformed disc entries while preserving null absent discs', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [{ id: 0 }],
      spawns: [],
      ticks: [
        {
          t: 0,
          discs: [null, 5, { id: 2, x: 0, y: 0, xv: 0, yv: 0, a: 0, av: 0 }],
        },
      ],
    });
    expect(parsed.errors).toEqual([
      'tick 0 disc 1 is malformed: not an object',
      'tick 0 disc 2 is malformed: alive must be a boolean',
    ]);
    // Malformed discs never leak into the typed output: they are replaced with
    // null, keeping the index-aligned discs array safe for downstream iteration.
    expect(parsed.trace.ticks[0].discs).toEqual([null, null, null]);
  });

  it('rejects fractional or misaligned disc ids', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [{ id: 0 }],
      spawns: [],
      ticks: [
        {
          t: 0,
          discs: [
            { id: 1.5, x: 0, y: 0, xv: 0, yv: 0, a: 0, av: 0, alive: true },
            { id: 2, x: 0, y: 0, xv: 0, yv: 0, a: 0, av: 0, alive: true },
          ],
        },
      ],
    });
    expect(parsed.errors).toEqual([
      'tick 0 disc 0 is malformed: id must be a non-negative integer',
      'tick 0 disc 1 id mismatch: disc.id=2 does not match slot 1',
    ]);
    // Neither a shape-invalid disc nor a valid-but-misaligned disc may leak
    // into the typed output: both are nulled, so every remaining disc honors
    // the index-alignment invariant (disc.id === slot).
    expect(parsed.trace.ticks[0].discs).toEqual([null, null]);
  });

  it('rejects discs claiming alive:false (presence in state.discs means alive)', () => {
    // §9.2: alive == presence in state.discs. A disc object present in the
    // array cannot also claim dead, so `alive: false` is malformed and must
    // never drive the comparator's input/aliveSeen/diff paths.
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [{ id: 0 }],
      spawns: [],
      ticks: [
        {
          t: 0,
          discs: [{ id: 0, x: 0, y: 0, xv: 0, yv: 0, a: 0, av: 0, alive: false }],
        },
      ],
    });
    expect(parsed.errors).toEqual([
      'tick 0 disc 0 is malformed: alive must be true (presence in state.discs means alive)',
    ]);
    // The alive:false disc is dropped from the typed output (nulled), so the
    // parsed trace only ever carries absent (null) or fully-valid alive discs.
    expect(parsed.trace.ticks[0].discs[0]).toBeNull();
  });

  it('returns a validation error and drops null player entries, preserving valid players', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [null, { id: 0, team: 1 }],
      spawns: [],
      ticks: [],
    });
    expect(parsed.errors).toEqual(['player entries must be objects']);
    // The returned roster stays safe for downstream iteration even when the
    // caller ignores the errors (the replay comparator maps over p.id).
    expect(parsed.trace.players).toEqual([{ id: 0, team: 1 }]);
  });

  it('returns a validation error and drops non-object player entries', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [42, 'x', [], { id: 0, team: 1 }],
      spawns: [],
      ticks: [],
    });
    expect(parsed.errors).toEqual([
      'player entries must be objects',
      'player entries must be objects',
      'player entries must be objects',
    ]);
    expect(parsed.trace.players).toEqual([{ id: 0, team: 1 }]);
  });

  it('returns a validation error and drops null tick entries, preserving valid ticks', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [],
      spawns: [],
      ticks: [null, { t: 0, discs: [] }],
    });
    expect(parsed.errors).toEqual(['tick entries must be objects']);
    // Replaying this parsed trace must not crash on the null tick (the
    // comparator dereferences recorded.inputs / recorded.discs).
    expect(parsed.trace.ticks).toEqual([{ t: 0, discs: [] }]);
  });

  it('returns a validation error and drops non-object tick entries', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [],
      spawns: [],
      ticks: [null, 7, 'x', { t: 0, discs: [] }],
    });
    expect(parsed.errors).toEqual([
      'tick entries must be objects',
      'tick entries must be objects',
      'tick entries must be objects',
    ]);
    expect(parsed.trace.ticks).toEqual([{ t: 0, discs: [] }]);
  });

  it('returns a validation error and drops field-invalid player entries', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [{ team: 1 }, { id: -1 }],
      spawns: [],
      ticks: [],
    });
    expect(parsed.errors).toEqual([
      'player id must be a non-negative number',
      'player id must be a non-negative number',
    ]);
    expect(parsed.trace.players).toEqual([]);
  });

  it('returns a validation error and drops field-invalid tick entries', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [],
      spawns: [],
      ticks: [{ t: 0 }, { t: -1, discs: [] }],
    });
    expect(parsed.errors).toEqual(['tick 0 has no discs array', 'tick index invalid: -1']);
    expect(parsed.trace.ticks).toEqual([]);
  });

  it('returns a validation error and drops null spawn entries, preserving valid spawns', () => {
    const parsed = parseNativeTrace({
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: {},
      players: [],
      spawns: [null, { id: 0, x: -100, y: -25 }],
      ticks: [],
    });
    expect(parsed.errors).toEqual(['spawn entries must be objects']);
    // buildTraceEnvironment re-seeds from spawn.id/spawn.x/spawn.y, so the
    // parsed spawns must stay safe for downstream iteration when errors are
    // ignored (the spawn-filtering path added with this PR).
    expect(parsed.trace.spawns).toEqual([{ id: 0, x: -100, y: -25 }]);
  });
});

describe('P4: differential validation — fixture/joint exact-match gates', () => {
  it('engine fixtures match the traced Simple 1v1 map authored values', () => {
    const raw = loadMap(SIMPLE_1V1);
    const trace: NativeTrace = {
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: raw,
      players: [{ id: 0, team: 1 }],
      spawns: [{ id: 0, x: -100, y: -25 }],
      ticks: [],
    };
    const env = buildTraceEnvironment(trace, { seed: 1 });
    try {
      const gate = verifyFixtureGates(env, trace);
      expect(gate.ok).toBe(true);
      expect(gate.mismatches).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('engine joints match the traced WDB map authored ground-prismatic joints', () => {
    const raw = loadMap(WDB_GROUND_JOINTS);
    const trace: NativeTrace = {
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: raw,
      players: [{ id: 0, team: 1 }],
      spawns: [{ id: 0, x: 0, y: 0 }],
      ticks: [],
    };
    const env = buildTraceEnvironment(trace, { seed: 1 });
    try {
      const joints = verifyJointGates(env, trace);
      expect(joints.ok).toBe(true);
      expect(joints.mismatches).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('joint gate enforces the prismatic translation scale conversion (#322)', () => {
    // The WDB fixture joints above are all 0/0, so a gate that lagged behind
    // the engine's map-px → world-unit conversion (e.g. comparing the raw
    // authored translation, or dividing by the wrong scale) would pass
    // silently. Pin the gate-side `lt / scale` with a non-zero prismatic limit
    // built at a NON-default engine scale: the gate must match the engine's
    // stored world-unit value (authored px / this.scale), and a tampered
    // unscaled value must be flagged.
    const raw: any = {
      metadata: { name: 'gate-scale-probe' },
      spawns: [
        { index: 0, name: 'blue', x: -100, y: 0, blue: true },
        { index: 1, name: 'red', x: 100, y: 0, red: true },
      ],
      bodies: [
        {
          bodyIndex: 0,
          name: 'anchor',
          type: 'rect',
          bodyType: 'static',
          static: true,
          x: 0,
          y: 0,
          width: 40,
          height: 10,
          density: 0,
          restitution: 0,
          friction: 0,
          collidesGroup1: true,
          collidesGroup2: true,
          collidesGroup3: true,
          collidesGroup4: true,
          collidesPlayers: true,
        },
        {
          bodyIndex: 1,
          name: 'slider',
          type: 'rect',
          bodyType: 'dynamic',
          static: false,
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          density: 1,
          restitution: 0,
          friction: 0,
          collidesGroup1: true,
          collidesGroup2: true,
          collidesGroup3: true,
          collidesGroup4: true,
          collidesPlayers: true,
        },
      ],
      physicsJoints: [
        {
          index: 0,
          type: 'lpj',
          bodyA: 0,
          bodyB: 1,
          data: { cc: false, bf: 0, dl: false },
          length: 0,
          collideConnected: false,
          breakForce: 0,
          deleteOnBreak: false,
          anchorA: { x: 0, y: 0 },
          angle: 0,
          lowerTranslation: -50,
          upperTranslation: 50,
          enableLimit: true,
          maxMotorForce: 0,
        },
      ],
    };
    const trace: NativeTrace = {
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: raw,
      players: [{ id: 0, team: 1 }],
      spawns: [{ id: 0, x: -100, y: 0 }],
      ticks: [],
    };
    const mapDef: any = normalizeMap(raw);
    const env = new BonkEnvironment({
      numOpponents: 0,
      seed: 1,
      mapData: mapDef,
      randomOpponent: false,
      maxTicks: 8,
      physics: { scale: 15 },
    } as any);
    try {
      const gates = verifyJointGates(env, trace);
      expect(gates.ok).toBe(true);
      expect(gates.mismatches).toEqual([]);

      // The gate must discriminate on the conversion: an unscaled authored
      // value left in the engine joint (as a hypothetical gate lag would
      // compare) must be flagged as a lowerTranslation mismatch.
      const joint: any = (env as any).physics.createdJoints.get('joint_0');
      expect(joint).toBeTruthy();
      joint.m_lowerTranslation = -50;
      const lagged = verifyJointGates(env, trace);
      expect(lagged.ok).toBe(false);
      expect(lagged.mismatches.some((m) => /prismatic lowerTranslation mismatch/.test(m))).toBe(true);
    } finally {
      env.close();
    }
  });

  it('lsj gate passes the decoder-canonical case: built maxMotorForce ≈ 0 (bias k ≡ 0) must not be compared against the authored sf', () => {
    // Issue #373: anchorA == the connected body's position collapses the P2b
    // formula to k ≡ 0, so the engine deliberately builds
    // m_maxMotorForce = sf·|k| = 0 while the trace authors maxMotorForce 25.
    // The gate must expect the derived 0 (never the raw authored sf) and must
    // flag a rebuilt authored force as the mismatch it would be.
    const trace = makeLsjTrace({ x: 0, y: 0 });
    const env = buildTraceEnvironment(trace, { seed: 1 });
    try {
      const built: any = (env as any).physics.createdJoints.get('joint_0');
      expect(built).toBeTruthy();
      expect(built.m_maxMotorForce).toBeCloseTo(0, 5);
      expect(built.m_motorSpeed).toBeCloseTo(300, 5);

      const gate = verifyJointGates(env, trace);
      expect(gate.ok).toBe(true);
      expect(gate.mismatches).toEqual([]);

      // A gate that lagged behind P2b (comparing the raw authored sf) would
      // pass with the authored force restored; the derived comparison must
      // reject it as the engine never builds that value for this geometry.
      built.m_maxMotorForce = 25;
      const lagged = verifyJointGates(env, trace);
      expect(lagged.ok).toBe(false);
      expect(lagged.mismatches.some((m) => /prismatic maxMotorForce mismatch/.test(m))).toBe(true);
    } finally {
      env.close();
    }
  });

  it('lsj gate validates the offset-anchor bias (k = +1): derived force sf and the −300 motorSpeed override are enforced', () => {
    // Issue #373: an authored anchor offset +slen along the axis yields
    // k = +1, so the engine builds maxMotorForce = sf·|k| = 25 and the
    // sign-aware motorSpeed −300 against the authored +300. The gate must
    // pass both, and a regression that silently reverts the motor direction
    // to +300 must fail the gate.
    const trace = makeLsjTrace({ x: 0, y: 40 });
    const env = buildTraceEnvironment(trace, { seed: 1 });
    try {
      const built: any = (env as any).physics.createdJoints.get('joint_0');
      expect(built).toBeTruthy();
      expect(built.m_maxMotorForce).toBeCloseTo(25, 5);
      expect(built.m_motorSpeed).toBe(-300);

      expect(verifyJointGates(env, trace).ok).toBe(true);

      built.m_motorSpeed = 300;
      const regressed = verifyJointGates(env, trace);
      expect(regressed.ok).toBe(false);
      expect(regressed.mismatches.some((m) => /prismatic motorSpeed mismatch/.test(m))).toBe(true);
    } finally {
      env.close();
    }
  });

  it('lsj gate expects the engine hardcoded 300/sf fallback for degenerate inputs (length 0, null anchorA, ground-anchored)', () => {
    // Issue #373 review: when the P2b bias cannot engage (zero/non-finite
    // length, invalid anchorA) the engine still OVERWRITES every lsj joint's
    // motor with its hardcoded 300 (and force sf). The gate must expect those
    // engine-built values — not the authored motorSpeed — so an authored
    // non-300 motorSpeed (e.g. 500) on a degenerate lsj must NOT false-fail.
    const scenarios: Array<{ name: string; mutate: (j: any) => void }> = [
      {
        name: 'length 0',
        mutate: (j) => {
          j.length = 0;
        },
      },
      {
        name: 'null anchorA',
        mutate: (j) => {
          j.anchorA = null;
        },
      },
      {
        name: 'ground-anchored (ba -1)',
        mutate: (j) => {
          j.bodyA = -1;
          j.length = 0;
        },
      },
    ];
    for (const s of scenarios) {
      const rawMap: any = {
        bodies: [
          { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
          { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 40, width: 20, height: 20, static: false, density: 1 },
        ],
        spawns: [{ x: 0, y: 0, blue: true, red: true }],
        physicsJoints: [
          {
            index: 0,
            type: 'lsj',
            bodyA: 0,
            bodyB: 1,
            anchorA: { x: 0, y: 40 },
            axis: { x: 0, y: 1 },
            lowerTranslation: -40,
            upperTranslation: 40,
            length: 40,
            enableLimit: false,
            enableMotor: true,
            motorSpeed: 500,
            maxMotorForce: 25,
          },
        ],
      };
      s.mutate(rawMap.physicsJoints[0]);
      const trace: NativeTrace = {
        schema: 'bonk.rl.env.native-trace',
        version: TRACE_SCHEMA_VERSION,
        tps: 30,
        map: rawMap,
        players: [{ id: 0, team: 1 }],
        spawns: [{ id: 0, x: 0, y: 0 }],
        ticks: [],
      };
      const env = buildTraceEnvironment(trace, { seed: 1 });
      try {
        const built: any = (env as any).physics.createdJoints.get('joint_0');
        expect(built, s.name).toBeTruthy();
        // Degenerate lsj: engine hardcodes force sf and motor 300.
        expect(built.m_maxMotorForce, s.name).toBeCloseTo(25, 5);
        expect(built.m_motorSpeed, s.name).toBe(300);
        expect(verifyJointGates(env, trace).ok, s.name).toBe(true);
      } finally {
        env.close();
      }
    }
  });
});

describe('P4: differential validation — replay comparator', () => {
  let trace: NativeTrace;

  beforeAll(() => {
    const raw = loadMap(SIMPLE_1V1);
    const rec = recordSimTrace(raw, 200, 1, 7);
    trace = rec.trace;
    rec.env.close();
  });

  it('daemon-style replay reproduces a recorded neutral run within tight tolerance', () => {
    const verdict = compareTrace(trace, {
      seed: 0, // seed fixed; spawns override anyway
      tolerances: { position: 0.02, velocity: 0.02, angle: 0.01, angularVelocity: 0.01 },
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.ticksCompared).toBe(200);
    expect(verdict.ticksOutsideTolerance).toBe(0);
    // The worst observed position error must be tiny (machine-level on the same
    // solver path), proving the comparator is genuinely comparing engine output.
    expect(verdict.worst.dx).toBeLessThan(1e-6);
    expect(verdict.worst.dy).toBeLessThan(1e-6);
  });

  it('captures moving-disc spawns before the first tick and replays the WDB fixture', () => {
    const raw = loadMap(WDB_GROUND_JOINTS);
    const rec = recordSimTrace(raw, 60, 1, 7);
    try {
      expect(rec.trace.spawns).toEqual([
        { id: 0, x: -315, y: 212.5 },
        { id: 1, x: 315, y: 212.5 },
      ]);
      // The disc must actually exist at tick 0 (not vacuous) and have moved off
      // the spawn before the first recorded tick.
      const tick0Disc = rec.trace.ticks[0].discs[0];
      expect(tick0Disc).not.toBeNull();
      expect(tick0Disc!.y).not.toBe(rec.trace.spawns[0]?.y);

      const verdict = compareTrace(rec.trace, {
        seed: 0,
        tolerances: { position: 0.02, velocity: 0.02, angle: 0.01, angularVelocity: 0.01 },
      });
      expect(verdict.pass).toBe(true);
      // The WDB arena has no floor under the spawns and `re` is off, so both
      // discs free-fall off the arena and die OOB partway through the trace.
      // Death-agreement ticks count as compared data (comparator #369), so a
      // faithful replay compares EVERY tick and skips none, whether or not
      // the recording contains a mid-run death (geometry-dependent).
      expect(verdict.ticksCompared).toBe(rec.trace.ticks.length);
      expect(verdict.ticksCompared).toBeGreaterThan(0);
      expect(verdict.skippedNoData).toBe(0);
      expect(verdict.ticksOutsideTolerance).toBe(0);
      expect(verdict.worst.dx).toBeLessThan(1e-6);
      expect(verdict.worst.dy).toBeLessThan(1e-6);
    } finally {
      rec.env.close();
    }
  });

  it('replays a trace with empty spawns (the userscript fallback) via map-derived spawn points', () => {
    // The capture userscript omits a spawn entry when the runtime `sx`/`sy`
    // fields are absent, so the comparator must derive the round-start
    // positions from the traced map's authored spawns (spawnTeamInfo selection)
    // and still reproduce the recording exactly.
    const raw = loadMap(WDB_GROUND_JOINTS);
    const rec = recordSimTrace(raw, 60, 1, 7);
    try {
      const emptySpawns: NativeTrace = JSON.parse(JSON.stringify(rec.trace));
      emptySpawns.spawns = [];
      const verdict = compareTrace(emptySpawns, {
        seed: 0,
        tolerances: { position: 0.02, velocity: 0.02, angle: 0.01, angularVelocity: 0.01 },
      });
      expect(verdict.pass).toBe(true);
      // Same death-agreement accounting as the sibling WDB replay test above:
      // every tick is compared (mid-run deaths count as data, comparator #369).
      expect(verdict.ticksCompared).toBe(rec.trace.ticks.length);
      expect(verdict.ticksCompared).toBeGreaterThan(0);
      expect(verdict.skippedNoData).toBe(0);
      expect(verdict.ticksOutsideTolerance).toBe(0);
      expect(verdict.worst.dx).toBeLessThan(1e-6);
      expect(verdict.worst.dy).toBeLessThan(1e-6);
    } finally {
      rec.env.close();
    }
  });

  it('engine pre-tick spawns equal the authored map spawns (native↔engine spawn equivalence)', () => {
    const raw: any = loadMap(WDB_GROUND_JOINTS);
    // The engine selects the first blue-capable spawn for the AI slot and a
    // distinct red-capable spawn for the opponent — the same spawnTeamInfo
    // assignment the native round uses. The recorded pre-tick spawns must land
    // exactly on those authored coordinates.
    const blue = raw.spawns.find((s: any) => s.blue === true);
    const red = raw.spawns.find((s: any) => s.red === true && s !== blue);
    expect(blue).toBeTruthy();
    expect(red).toBeTruthy();
    const rec = recordSimTrace(raw, 3, 1, 7);
    try {
      expect(rec.trace.spawns).toEqual([
        { id: 0, x: blue.x, y: blue.y },
        { id: 1, x: red.x, y: red.y },
      ]);
    } finally {
      rec.env.close();
    }
  });

  it('a perturbed trace fails the same replay, proving the gate discriminates', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    // Move every recorded disc 3 map px in +x: far beyond the 0.5 px tolerance.
    for (const tick of bad.ticks) {
      for (const d of tick.discs) if (d) d.x += 3;
    }
    const verdict = compareTrace(bad, {
      tolerances: { position: 0.5, velocity: 1.0, angle: 0.05, angularVelocity: 0.5 },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.ticksOutsideTolerance).toBeGreaterThan(0);
    expect(verdict.worst.dx).toBeGreaterThan(2.5);
  });

  it('native-absent ticks surface as mismatches and FAIL the verdict when the engine keeps a player alive', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    for (const tick of bad.ticks) tick.discs[1] = null; // opponent never exists natively
    const verdict = compareTrace(bad, { seed: 0 });
    expect(verdict.perTick.some((t) => t.mismatches.length > 0)).toBe(true);
    // Death agreement is part of the gate: a living engine disc where native
    // reports absence must fail the run, not just annotate it.
    expect(verdict.pass).toBe(false);
  });

  it('rejects malformed disc entries and keeps failed verdict metrics finite', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    bad.ticks[0].discs[0] = 5 as any;
    const parsed = parseNativeTrace(bad);
    expect(parsed.errors).toContain('tick 0 disc 0 is malformed: not an object');

    const verdict = compareTrace(bad, { seed: 0 });
    expect(verdict.pass).toBe(false);
    expect(verdict.ticksOutsideTolerance).toBeGreaterThan(0);
    expect(verdict.perTick[0].mismatches).toContainEqual({ id: 0, reason: 'malformed disc entry' });
    for (const value of Object.values(verdict.worst)) expect(Number.isFinite(value)).toBe(true);
  });

  it('does not apply replayed inputs to malformed (non-null) disc entries', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    // Every tick's slot 0 is a malformed disc; slot 1 stays valid, so only slot
    // 1 may receive its replayed input.
    for (const tick of bad.ticks) tick.discs[0] = 5 as any;
    const applied: number[] = [];
    const verdict = compareTrace(bad, {
      seed: 0,
      onReady: (env) => {
        const physics: any = (env as any).physics;
        const orig = physics.applyInput.bind(physics);
        physics.applyInput = (id: number, input: unknown) => {
          applied.push(id);
          return orig(id, input as any);
        };
      },
    });
    expect(verdict.pass).toBe(false);
    expect(applied).not.toContain(0);
    expect(applied.filter((id) => id === 1).length).toBeGreaterThan(0);
  });

  it('does not apply replayed inputs to slot-misaligned disc entries', () => {
    // parseNativeTrace enforces the slot-alignment invariant at parse time; the
    // comparator must enforce it too, because a caller can compare an unparsed
    // (or error-ignoring) trace. A disc whose `id` does not match its array
    // slot must not drive the input of its slot's player nor be diffed against
    // that player.
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    // Every tick's slot 1 claims id 0 (misaligned); slot 0 stays valid and
    // aligned, so only slot 0 may receive its replayed input.
    for (const tick of bad.ticks) {
      const d = tick.discs[1];
      if (d) d.id = 0;
    }
    const applied: number[] = [];
    const verdict = compareTrace(bad, {
      seed: 0,
      onReady: (env) => {
        const physics: any = (env as any).physics;
        const orig = physics.applyInput.bind(physics);
        physics.applyInput = (id: number, input: unknown) => {
          applied.push(id);
          return orig(id, input as any);
        };
      },
    });
    expect(verdict.pass).toBe(false);
    expect(applied).not.toContain(1);
    expect(applied.filter((id) => id === 0).length).toBeGreaterThan(0);
    expect(verdict.perTick[0].mismatches).toContainEqual({ id: 1, reason: 'malformed disc entry' });
  });

  it("delivers the dying disc's recorded input byte on its fatal tick (#423)", () => {
    // Capture applies a tick's input bytes PRE-step, unconditionally: a disc
    // that dies during tick K was still alive when K's step began, so its
    // fatal-tick byte shaped the recorded transition into K's absent (null)
    // state. The comparator must replay those semantics — gating applyInput
    // on POST-step disc presence silently dropped exactly that byte (#423).
    const raw = loadMap(WDB_GROUND_JOINTS);
    const mapDef: any = normalizeMap(raw);
    const env = new BonkEnvironment({
      numOpponents: 1,
      seed: 7,
      mapData: mapDef,
      randomOpponent: false,
      maxTicks: 68,
    } as any);

    try {
      const physics: any = (env as any).physics;
      const players = [
        { id: 0, team: 1 },
        { id: 1, team: 2 },
      ];
      env.reset(7);
      const spawns: Array<{ id: number; x: number; y: number }> = [];
      for (let i = 0; i <= 1; i++) {
        const body = physics.playerBodies?.get(i);
        const pos = body?.GetPosition();
        spawns.push({ id: i, x: (pos?.x ?? 0) * physics.scale, y: (pos?.y ?? 0) * physics.scale });
      }
      const rec = new NativeTraceRecorder({ map: raw, players, spawns });

      // Player 0 holds RIGHT for the whole round (`re` is off in this map, so
      // the mid-run OOB death is final): every tick carries a non-neutral
      // byte, including the fatal one. Same inputs → tick → read order as
      // recordSimTrace above.
      const HELD_RIGHT = { left: false, right: true, up: false, down: false, heavy: false, grapple: false };
      const NEUTRAL = { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
      for (let t = 0; t < 60; t++) {
        physics.applyInput(0, HELD_RIGHT);
        physics.applyInput(1, NEUTRAL);
        physics.tick();
        const states: any[] = [];
        for (let i = 0; i <= 1; i++) {
          const body = physics.playerBodies?.get(i);
          if (!body || !physics.playerAlive.get(i)) {
            states[i] = undefined;
            continue;
          }
          const pos = body.GetPosition();
          const vel = body.GetLinearVelocity();
          states[i] = {
            x: pos.x * physics.scale,
            y: pos.y * physics.scale,
            xv: vel.x * physics.scale,
            yv: vel.y * physics.scale,
            a: body.GetAngle(),
            av: body.GetAngularVelocity(),
          };
        }
        rec.push({ t, discs: states, inputs: { 0: 2, 1: 0 } });
      }
      const traceWithInputs: NativeTrace = rec.toTrace();

      // Sanity: player 0 really dies mid-run while still recorded holding RIGHT.
      let deathTick = -1;
      for (let t = 1; t < traceWithInputs.ticks.length; t++) {
        if (traceWithInputs.ticks[t].discs[0] === null && traceWithInputs.ticks[t - 1].discs[0] !== null) {
          deathTick = t;
          break;
        }
      }
      expect(deathTick).toBeGreaterThan(0);
      expect(traceWithInputs.ticks[deathTick].inputs?.[0]).toBe(2);

      // Replay through the comparator with an input spy keyed by tick index.
      const appliedPerTick: Array<Map<number, number>> = [];
      let idx = -1;
      const verdict = compareTrace(traceWithInputs, {
        seed: 0,
        tolerances: { position: 0.02, velocity: 0.02, angle: 0.01, angularVelocity: 0.01 },
        onReady: (replayEnv) => {
          const p: any = (replayEnv as any).physics;
          const origApply = p.applyInput.bind(p);
          const origTick = p.tick.bind(p);
          p.applyInput = (id: number, input: PlayerInput) => {
            if (!appliedPerTick[idx]) appliedPerTick[idx] = new Map();
            const enc =
              (input.left ? 1 : 0) |
              (input.right ? 2 : 0) |
              (input.up ? 4 : 0) |
              (input.down ? 8 : 0) |
              (input.heavy ? 16 : 0) |
              (input.grapple ? 32 : 0);
            appliedPerTick[idx].set(id, enc);
            return origApply(id, input);
          };
          p.tick = () => {
            idx++;
            return origTick();
          };
        },
      });

      // THE REGRESSION ASSERTION: the fatal-tick byte reaches the engine
      // instead of being gated away by the post-step null disc entry.
      expect(appliedPerTick[deathTick]?.get(0)).toBe(2);

      // Verdict stability: a faithful engine reproduces the capture exactly,
      // including the fatal force — delivering the byte causes no false fail.
      expect(verdict.pass).toBe(true);
      expect(verdict.ticksOutsideTolerance).toBe(0);
      expect(verdict.worst.dx).toBeLessThan(1e-6);
      expect(verdict.worst.dy).toBeLessThan(1e-6);
    } finally {
      env.close();
    }
  });

  it('an all-skipped trace with no comparable data must not pass the differential gate', () => {
    const noData: NativeTrace = {
      schema: 'bonk.rl.env.native-trace',
      version: TRACE_SCHEMA_VERSION,
      tps: 30,
      map: loadMap(SIMPLE_1V1),
      // Pin respawning off: with `re` on, an OOB death would respawn the disc
      // back at its spawn point, and a disc that never leaves the death circle
      // would come back alive — breaking the all-skipped premise.
      settings: { re: false },
      players: [
        { id: 0, team: 1 },
        { id: 1, team: 2 },
      ],
      // Both discs are placed one unit beyond the engine's OOB death circle
      // (OUT_OF_BOUNDS_DISTANCE map units from the origin death center) before
      // the first replay tick, so every native-absent entry agrees with a dead
      // engine disc.
      spawns: [
        { id: 0, x: OUT_OF_BOUNDS_DISTANCE + 1, y: 0 },
        { id: 1, x: OUT_OF_BOUNDS_DISTANCE + 1, y: 50 },
      ],
      ticks: Array.from({ length: 4 }, (_, t) => ({ t, discs: [null, null] })),
    };

    const verdict = compareTrace(noData, { seed: 7 });
    expect(verdict.skippedNoData).toBe(noData.ticks.length);
    expect(verdict.ticksCompared).toBe(0);
    expect(verdict.ticksOutsideTolerance).toBe(0);
    expect(verdict.worst).toEqual({ dx: 0, dy: 0, dvx: 0, dvy: 0, da: 0, dav: 0 });
    expect(verdict.pass).toBe(false);
  });

  it('trace settings drive the engine through the map-settings path (pq high → 15 solver iterations)', () => {
    // Settings must reach PhysicsEngine via mapData.settings (the only path
    // BonkEnvironment reads pq from); both the trace and explicit overrides
    // are merged into the raw map before normalization.
    const viaTrace: NativeTrace = JSON.parse(JSON.stringify(trace));
    viaTrace.settings = { pq: 2 };
    const viaOverride: NativeTrace = JSON.parse(JSON.stringify(trace));
    const envA = buildTraceEnvironment(viaTrace, { seed: 0 });
    try {
      expect((envA as any).physics.velocityIterations).toBe(15);
      expect((envA as any).physics.positionIterations).toBe(15);
    } finally {
      envA.close();
    }
    const envB = buildTraceEnvironment(viaOverride, { seed: 0, settingsOverrides: { pq: 2 } });
    try {
      expect((envB as any).physics.velocityIterations).toBe(15);
    } finally {
      envB.close();
    }
    // The default (trace/map pq = 1) stays low.
    const envC = buildTraceEnvironment(viaOverride, { seed: 0 });
    try {
      expect((envC as any).physics.velocityIterations).toBe(2);
      expect((envC as any).physics.positionIterations).toBe(6);
    } finally {
      envC.close();
    }
  });
});
