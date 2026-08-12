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
import {
  buildTraceEnvironment,
  compareTrace,
} from '../../src/core/differential/replay-comparator';
import {
  verifyFixtureGates,
  verifyJointGates,
} from '../../src/core/differential/exact-match-gates';
import type { NativeTrace } from '../../src/core/differential/native-trace';

const SIMPLE_1V1 = path.join(process.cwd(), 'maps', 'bonk_Simple_1v1_123.json');
const WDB_MAPSHAKE = path.join(process.cwd(), 'maps', 'bonk_WDB__No_Mapshake__716916.json');

function loadMap(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Deterministic sim recording: step an engine N ticks with neutral (zero)
 *  inputs and capture recorder ticks, yielding a trace the comparator replays.
 *  Player 0 is the AI slot; extra players are the opponent slots. */
function recordSimTrace(mapRaw: unknown, ticks: number, numOpponents: number, seed = 7): { trace: NativeTrace; env: BonkEnvironment } {
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
  const spawns: Array<{ id: number; x: number; y: number }> = [];
  const rec = new NativeTraceRecorder({ map: mapRaw, players, spawns });
  env.reset(seed);

  // Apply the neutral inputs first, then step, then capture — the same order
  // the comparator replays (inputs → tick → read), so recorded tick t holds
  // the post-step state of the t-th replay step and diffs are directly aligned.
  for (let t = 0; t < ticks; t++) {
    physics.applyInput(0, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
    if (numOpponents >= 1) physics.applyInput(1, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
    physics.tick();

    const states: any[] = [];
    for (let i = 0; i <= numOpponents; i++) {
      const body = physics.playerBodies?.get(i);
      if (!body || !physics.playerAlive.get(i)) { states[i] = undefined; continue; }
      const pos = body.GetPosition();
      const vel = body.GetLinearVelocity();
      states[i] = { x: pos.x * physics.scale, y: pos.y * physics.scale, xv: vel.x * physics.scale, yv: vel.y * physics.scale, a: body.GetAngle(), av: body.GetAngularVelocity() };
    }
    rec.push({ t, discs: states });
  }

  const trace = rec.toTrace();
  // Fill in spawns from the actual engine body positions the env spawned.
  const filledSpawns: Array<{ id: number; x: number; y: number }> = [];
  for (let i = 0; i <= numOpponents; i++) {
    const bp = physics.playerBodies?.get(i);
    const p = bp?.GetPosition();
    filledSpawns.push({ id: i, x: (p?.x ?? 0) * physics.scale, y: (p?.y ?? 0) * physics.scale });
  }
  trace.spawns = filledSpawns;
  return { trace, env };
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
      players: [{ id: 0, team: 1 }, { id: 1, team: 2 }],
      spawns: [{ id: 0, x: -100, y: -25 }, { id: 1, x: 100, y: -25 }],
      ticks: [
        { t: 0, discs: [{ id: 0, x: -100, y: -25, xv: 0, yv: 0, a: 0, av: 0, alive: true }, { id: 1, x: 100, y: -25, xv: 0, yv: 0, a: 0, av: 0, alive: true }] },
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
    const v2 = parseNativeTrace({ schema: 'bonk.rl.env.native-trace', version: 99, tps: 30, players: [], spawns: [], ticks: [] });
    expect(v2.errors.some(e => /unsupported schema version/.test(e))).toBe(true);
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
    const raw = loadMap(WDB_MAPSHAKE);
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

  it('a perturbed trace fails the same replay, proving the gate discriminates', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    // Move every recorded disc 3 map px in +x: far beyond the 0.5 px tolerance.
    for (const tick of bad.ticks) {
      for (const d of tick.discs) if (d) d.x += 3;
    }
    const verdict = compareTrace(bad, { tolerances: { position: 0.5, velocity: 1.0, angle: 0.05, angularVelocity: 0.5 } });
    expect(verdict.pass).toBe(false);
    expect(verdict.ticksOutsideTolerance).toBeGreaterThan(0);
    expect(verdict.worst.dx).toBeGreaterThan(2.5);
  });

  it('native-absent ticks surface as mismatches when the engine keeps a player alive', () => {
    const bad: NativeTrace = JSON.parse(JSON.stringify(trace));
    for (const tick of bad.ticks) tick.discs[1] = null; // opponent never exists natively
    const verdict = compareTrace(bad, { seed: 0 });
    expect(verdict.perTick.some(t => t.mismatches.length > 0)).toBe(true);
  });
});