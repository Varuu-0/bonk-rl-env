'use strict';

// Original alpha2s Physics.step versus the unified RL-local Classic/map world.
// The local path never constructs ClassicPhysics or steps a second world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');

const TOLERANCE = 1e-9;
const SCENARIOS = [
  'moving-platform',
  'lethal-moving-fixture',
  'disc-contact',
  'timed-capture',
  'instant-goal',
  'out-of-bounds',
  'force-zone-directional',
  'force-zone-radial',
  'force-zone-rotating',
  'force-zone-jump-exclusion',
];
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];

function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}
function fixture(sh, extra = {}) {
  return {
    sh,
    n: `f${sh}`,
    fr: null,
    fp: null,
    re: null,
    de: null,
    f: 0xabcdef,
    d: false,
    np: false,
    ng: false,
    ig: false,
    ...extra,
  };
}
function body(type, p, fx, extra = {}) {
  return {
    s: {
      type,
      n: `b${fx[0]}`,
      fric: 0.5,
      fricp: false,
      re: 0.2,
      de: 1,
      ld: 0,
      ad: 0,
      fr: false,
      bu: false,
      f_c: 1,
      f_p: true,
      f_1: true,
      f_2: true,
      f_3: true,
      f_4: true,
    },
    p,
    a: 0,
    lv: [0, 0],
    av: 0,
    cf: { x: 0, y: 0, ct: 0, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
    fx,
    ...extra,
  };
}
function box(c, w, h) {
  return { type: 'bx', c, a: 0, w, h, sk: false };
}
function spawn(x, y, n) {
  return { x, y, xv: 0, yv: 0, priority: 1, r: true, f: true, b: true, gr: false, ye: false, n };
}
function baseMap() {
  return {
    v: 15,
    s: { re: false, nc: false, fl: false, pq: 1, gd: 25 },
    physics: { ppm: 10, shapes: [], fixtures: [], bodies: [], joints: [], bro: [] },
    spawns: [],
    capZones: [],
    m: { a: 'validation', n: 'dynamic Classic differential', dbv: 2, dbid: -1 },
  };
}
function finishMap(map) {
  map.physics.bro = map.physics.bodies.map((_, index) => index);
  return map;
}
function scenario(name) {
  const map = baseMap();
  const p = map.physics;
  if (name === 'moving-platform') {
    p.shapes.push(box([0, 0], 400, 20));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('k', [0, 0], [0], { lv: [10, 0] }));
    map.spawns.push(spawn(-50, -30, 'left'), spawn(50, -30, 'right'));
  } else if (name === 'lethal-moving-fixture') {
    p.shapes.push(box([0, 0], 200, 20), box([-250, 0], 100, 20));
    p.fixtures.push(fixture(0, { d: true }), fixture(1));
    p.bodies.push(body('k', [0, 0], [0, 1], { lv: [10, 0] }));
    map.spawns.push(spawn(0, -20, 'lethal'), spawn(-250, -30, 'safe'));
    map.s.re = true;
  } else if (name === 'disc-contact') {
    p.shapes.push(box([0, 0], 400, 20));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('s', [0, 0], [0]));
    map.spawns.push(spawn(-5, -30, 'left'), spawn(5, -30, 'right'));
  } else if (name === 'timed-capture') {
    p.shapes.push(box([0, 0], 400, 400), box([-300, 0], 100, 20));
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('s', [0, 0], [0, 1]));
    map.spawns.push(spawn(0, -100, 'owner'), spawn(-300, -100, 'other'));
    map.capZones.push({ n: 'timed', ty: 1, l: 1, i: 0 });
    map.s.fl = true;
    map.s.re = true;
  } else if (name === 'instant-goal') {
    p.shapes.push(box([0, 0], 100, 10), box([0, 0], 10, 10), box([-250, 0], 100, 20));
    p.fixtures.push(fixture(0), fixture(1), fixture(2));
    p.bodies.push(body('s', [0, 0], [0, 2]), body('d', [0, -10], [1]));
    map.spawns.push(spawn(-100, -100, 'loser'), spawn(-250, -30, 'winner'));
    map.capZones.push({ n: 'goal', ty: 2, l: 10, i: 0 });
    map.s.re = true;
  } else if (name === 'out-of-bounds') {
    p.shapes.push(box([-250, 0], 100, 20));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('s', [0, 0], [0]));
    map.spawns.push(spawn(0, 400, 'outside'), spawn(-250, -30, 'safe'));
    map.s.re = true;
  } else if (name === 'force-zone-directional') {
    // t=0: constant (fz.x, fz.y) force applied to overlapping discs.
    p.shapes.push(box([0, 0], 200, 200));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('s', [0, 0], [0], { fz: { on: true, x: 0, y: 25, d: true, p: true, a: true, t: 0, cf: 0 } }));
    map.spawns.push(spawn(0, 0, 'inside'), spawn(-250, -30, 'outside'));
  } else if (name === 'force-zone-radial') {
    // t=2: attraction toward the zone body's input position, coefficient cf.
    p.shapes.push(box([0, 0], 200, 200));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('s', [0, 0], [0], { fz: { on: true, x: 0, y: 0, d: true, p: true, a: true, t: 2, cf: 30 } }));
    map.spawns.push(spawn(40, 0, 'right'), spawn(-250, -30, 'outside'));
  } else if (name === 'force-zone-rotating') {
    // t=1: force vector rotated by the body's input angle (SafeTrig).
    p.shapes.push(box([0, 0], 200, 200));
    p.fixtures.push(fixture(0));
    p.bodies.push(
      body('s', [0, 0], [0], { a: Math.PI / 3, fz: { on: true, x: 0, y: 25, d: true, p: true, a: true, t: 1, cf: 0 } }),
    );
    map.spawns.push(spawn(0, 0, 'inside'), spawn(-250, -30, 'outside'));
  } else if (name === 'force-zone-jump-exclusion') {
    // A disc inside an fz zone cannot jump off it (original :6311-6315).
    p.shapes.push(box([0, 0], 200, 20));
    p.fixtures.push(fixture(0));
    p.bodies.push(body('s', [0, 0], [0], { fz: { on: true, x: 0, y: 0, d: false, p: true, a: true, t: 0, cf: 0 } }));
    map.spawns.push(spawn(0, -15, 'onzone'), spawn(-250, -30, 'outside'));
  } else throw new Error(`Unknown scenario ${name}`);
  return finishMap(map);
}
function inputsFor(name, tick) {
  if (name === 'disc-contact') return [2, 1];
  if (name === 'timed-capture') return [4, 0];
  if (name === 'moving-platform') return [tick % 120 < 60 ? 2 : 1, 0];
  if (name === 'force-zone-jump-exclusion') return [4, 0];
  return [0, 0];
}
function localDiscs(native) {
  const output = [];
  for (let id = 0; id < native.discs.length; id++) {
    const disc = native.discs[id];
    if (!disc) continue;
    output[id] = {
      id,
      x: disc.x,
      y: disc.y,
      xv: disc.xv,
      yv: disc.yv,
      sx: disc.sx,
      sy: disc.sy,
      sxv: disc.sxv,
      syv: disc.syv,
      angle: disc.a,
      angularVelocity: disc.av,
      radius: 1,
      energy: disc.a1a,
      heavy: disc.a1 === true,
      alive: true,
      lhid: disc.lhid,
      lht: disc.lht,
      ni: disc.ni === true,
      ds: disc.ds,
      da: disc.da,
      vt: disc.vt,
    };
  }
  return output;
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runScenario(paths, name, ticks, quality, stepScale = 1) {
  // Load simulation dependencies only when executing the differential. Importing
  // scenario()/inputsFor() for public-environment tests must not construct or
  // require a second physics backend through the test runner's module graph.
  const { normalizeNativeMap } = require('../../src/core/native-map-state.ts');
  const { createNativeClassicWorld } = require('../../src/core/native-classic-world.ts');
  const oracle = createOracle(paths);
  const world = createNativeClassicWorld();
  const map = scenario(name);
  map.s.pq = quality;
  const roster = [
    { id: 0, team: name === 'instant-goal' ? 1 : 1 },
    { id: 1, team: 2 },
  ];
  const teams = roster.reduce((array, player) => {
    array[player.id] = player.team;
    return array;
  }, []);
  const settings = { ga: 'b', mo: 'b', tea: false, bal: [0, 0], map, gt: 2, wl: 999, q: false, maps: [] };
  const report = {
    name,
    quality,
    stepScale,
    ticks: 0,
    pass: true,
    comparisons: 0,
    numericComparisons: 0,
    discreteComparisons: 0,
    maxError: 0,
    maxErrorByField: {},
    firstMismatch: null,
    coverage: {
      simulatedTicks: 0,
      discMapContacts: 0,
      discDiscContacts: 0,
      movingMapTicks: 0,
      captureProgressTicks: 0,
      instantGoalTicks: 0,
      respawnTicks: 0,
      forceZoneForceTicks: 0,
      jumpRaycastZoneTicks: 0,
      deathCauses: { 1: 0, 3: 0, 4: 0 },
    },
  };
  function mismatch(path, expected, actual, error) {
    report.pass = false;
    if (report.firstMismatch === null) report.firstMismatch = { tick: report.ticks, path, expected, actual, error };
  }
  function compare(expected, actual, field = 'state') {
    report.comparisons++;
    if (expected === null || actual === null || expected === undefined || actual === undefined) {
      report.discreteComparisons++;
      if (expected !== actual) mismatch(field, expected, actual);
      return;
    }
    if (typeof expected === 'number') {
      if (typeof actual !== 'number') {
        report.discreteComparisons++;
        mismatch(field, expected, actual);
        return;
      }
      const error = Math.abs(expected - actual);
      if (!Number.isFinite(error)) {
        report.discreteComparisons++;
        mismatch(field, expected, actual, 'non-finite');
        return;
      }
      report.numericComparisons++;
      report.maxError = Math.max(report.maxError, error);
      const top = field.split('.').slice(0, 3).join('.');
      report.maxErrorByField[top] = Math.max(report.maxErrorByField[top] || 0, error);
      if (error > TOLERANCE) mismatch(field, expected, actual, error);
      return;
    }
    if (typeof expected !== 'object') {
      report.discreteComparisons++;
      if (!Object.is(expected, actual)) mismatch(field, expected, actual);
      return;
    }
    if (Array.isArray(expected)) {
      report.discreteComparisons++;
      if (!Array.isArray(actual) || expected.length !== actual.length) {
        mismatch(`${field}.length`, expected.length, actual?.length);
        return;
      }
      for (let index = 0; index < expected.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(expected, String(index))) {
          report.discreteComparisons++;
          if (Object.prototype.hasOwnProperty.call(actual, String(index)))
            mismatch(`${field}[${index}]`, 'hole', actual[index]);
          continue;
        }
        compare(expected[index], actual[index], `${field}[${index}]`);
      }
      return;
    }
    if (typeof actual !== 'object' || Array.isArray(actual)) {
      report.discreteComparisons++;
      mismatch(field, expected, actual);
      return;
    }
    for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${field}.${key}`);
  }
  let roundReseeds = 0;
  try {
    let native = oracle.createNewState(roster, map, 1, false, null, settings, true);
    native.ftu = -1;
    let physics = normalizeNativeMap(map);
    physics.ftu = -1;
    let discs = localDiscs(native);
    let capZones;
    let first = true;
    function checkDiscs() {
      for (let id = 0; id < 2; id++) {
        const expected = native.discs[id];
        const actual = discs[id];
        compare(expected !== undefined && expected !== null, actual !== undefined, `discs[${id}].present`);
        if (!expected || !actual) continue;
        for (const [nativeField, localField] of [
          ['x', 'x'],
          ['y', 'y'],
          ['xv', 'xv'],
          ['yv', 'yv'],
          ['a', 'angle'],
          ['av', 'angularVelocity'],
          ['a1a', 'energy'],
        ]) {
          compare(expected[nativeField], actual[localField], `discs[${id}].${localField}`);
        }
        compare(expected.a1 === true, actual.heavy, `discs[${id}].heavy`);
        compare(expected.lhid, actual.lhid, `discs[${id}].lhid`);
        compare(expected.lht, actual.lht, `discs[${id}].lht`);
        compare(expected.ni === true, actual.ni === true, `discs[${id}].ni`);
        if (expected.lht > 0 && expected.lhid !== -1) report.coverage.discDiscContacts++;
        if (expected.ni) report.coverage.respawnTicks++;
      }
    }
    compare(native.physics, physics, 'physics');
    compare(native.capZones, worldCapZones(map, physics), 'capZones');
    checkDiscs();
    let previousMapX = physics.bodies[0]?.p[0];
    for (let tick = 1; tick <= ticks && report.pass; tick++) {
      report.ticks = tick;
      const input = inputsFor(name, tick);
      const simulate = native.ftu === -1;
      if (simulate) report.coverage.simulatedTicks++;
      const priorCarriedDeaths = native.discDeaths.filter((death) => death.f <= 90).length;
      const previousRound = native.rc;
      if (tick === 2) oracle.instrumentContacts();
      native = oracle.step(native, input.map(bits), null, 30, settings, stepScale, false, undefined);
      if (native.rc !== previousRound) {
        roundReseeds++;
        // Round selection is outside this physics module. Re-enter at the
        // original's new-round boundary only; never repair in-round state.
        native.ftu = -1;
        native.fte = -1;
        physics = normalizeNativeMap(map);
        physics.ftu = -1;
        for (let index = 0; index < native.physics.bodies.length; index++) {
          const source = native.physics.bodies[index];
          if (!source) continue;
          const target = physics.bodies[index];
          target.p = [...source.p];
          target.a = source.a;
          target.lv = [...source.lv];
          target.av = source.av;
        }
        for (let index = 0; index < native.physics.joints.length; index++)
          physics.joints[index] = native.physics.joints[index]
            ? JSON.parse(JSON.stringify(native.physics.joints[index]))
            : null;
        discs = localDiscs(native);
        capZones = native.capZones.map((zone) => ({ ...zone }));
        first = false;
        previousMapX = physics.bodies[0]?.p[0];
        compare(native.physics, physics, 'physics');
        checkDiscs();
        continue;
      }
      const liveInputs = Object.fromEntries(discs.flatMap((disc) => (disc ? [[disc.id, input[disc.id]]] : [])));
      const result = world.step(
        physics,
        discs,
        liveInputs,
        {
          fly: map.s.fl,
          noCollision: map.s.nc,
          quality,
          simulate,
          stepScale,
          balances: settings.bal,
          teams,
          teamCollision: settings.tea,
          respawn: map.s.re,
          radialBounds: true,
        },
        first ? { authoredCapZones: map.capZones } : { capZones },
      );
      first = false;
      physics = result.physics;
      discs = result.discs;
      capZones = result.capZones;
      compare(native.physics, physics, 'physics');
      compare(native.capZones, capZones, 'capZones');
      checkDiscs();
      const observations = oracle.consumeContactObservations();
      for (const contact of observations) {
        const types = [contact.bodyA, contact.bodyB];
        if (types.includes('disc') && types.includes('phys')) report.coverage.discMapContacts++;
        if (types[0] === 'disc' && types[1] === 'disc') report.coverage.discDiscContacts++;
      }
      if (physics.bodies[0] && physics.bodies[0].p[0] !== previousMapX) report.coverage.movingMapTicks++;
      previousMapX = physics.bodies[0]?.p[0];
      if (capZones.some((zone) => zone.p > 0 || zone.f !== -1)) report.coverage.captureProgressTicks++;
      if (result.capZoneTeamGoals.length > 0) report.coverage.instantGoalTicks++;
      if (name.startsWith('force-zone')) {
        // The zone disc is index 0 by construction in every fz scenario; count
        // ticks where the original disc velocity is nonzero (force applied).
        const zoneDisc = native.discs[0];
        if (zoneDisc && (zoneDisc.xv !== 0 || zoneDisc.yv !== 0)) report.coverage.forceZoneForceTicks++;
        if (name === 'force-zone-jump-exclusion' && (input[0] & 4) !== 0) report.coverage.jumpRaycastZoneTicks++;
      }
      const newNativeDeaths = native.discDeaths.slice(priorCarriedDeaths).filter((death) => death.f === 0);
      compare(newNativeDeaths.length, result.deaths.length, 'deaths.length');
      for (let index = 0; index < Math.min(newNativeDeaths.length, result.deaths.length); index++) {
        const expected = newNativeDeaths[index];
        const actual = result.deaths[index];
        compare(expected.i, actual.id, `deaths[${index}].id`);
        const cause = actual.cause === 'lethal-contact' ? 1 : actual.cause === 'capture' ? 3 : 4;
        compare(expected.m, cause, `deaths[${index}].cause`);
        report.coverage.deathCauses[cause]++;
        if (expected.m !== 4) {
          compare(expected.x, actual.x, `deaths[${index}].x`);
          compare(expected.y, actual.y, `deaths[${index}].y`);
          compare(expected.xv, actual.xv, `deaths[${index}].xv`);
          compare(expected.yv, actual.yv, `deaths[${index}].yv`);
        }
      }
    }
    if (report.pass) {
      if (report.ticks !== ticks) mismatch('coverage.ticks', ticks, report.ticks);
      if (name === 'moving-platform' && (report.coverage.discMapContacts === 0 || report.coverage.movingMapTicks === 0))
        mismatch('coverage', 'moving map/disc contact');
      if (
        name === 'lethal-moving-fixture' &&
        (report.coverage.deathCauses[1] === 0 || report.coverage.respawnTicks === 0)
      )
        mismatch('coverage', 'lethal contact and respawn');
      if (name === 'disc-contact' && report.coverage.discDiscContacts === 0) mismatch('coverage', 'disc-disc contact');
      if (
        name === 'timed-capture' &&
        (report.coverage.captureProgressTicks === 0 || report.coverage.deathCauses[3] === 0)
      )
        mismatch('coverage', 'timed capture progress and death');
      if (name === 'instant-goal' && (report.coverage.instantGoalTicks === 0 || report.coverage.deathCauses[3] === 0))
        mismatch('coverage', 'instant goal and capture death');
      if (name === 'out-of-bounds' && (report.coverage.deathCauses[4] === 0 || report.coverage.respawnTicks === 0))
        mismatch('coverage', 'OOB death and respawn');
      if (name.startsWith('force-zone') && report.coverage.forceZoneForceTicks === 0)
        mismatch('coverage', 'force-zone force application');
      if (name === 'force-zone-jump-exclusion' && report.coverage.jumpRaycastZoneTicks === 0)
        mismatch('coverage', 'jump raycast against fz body');
    }
    report.roundReseeds = roundReseeds;
    return report;
  } catch (error) {
    report.pass = false;
    report.firstMismatch = { tick: report.ticks, error: error.stack || String(error) };
    report.roundReseeds = roundReseeds;
    return report;
  } finally {
    world.dispose();
    oracle.dispose();
  }
}
function worldCapZones(map) {
  const seen = new Set();
  const output = [];
  for (const zone of map.capZones) {
    if (seen.has(zone.i) || !map.physics.fixtures[zone.i]) continue;
    seen.add(zone.i);
    output.push({ ty: zone.ty, p: 0, l: zone.l * 30, i: zone.i, o: -1, ot: -1, f: -1 });
  }
  return output;
}
function parseArguments(argv) {
  const values = {
    raw: process.env.BONK_RAW_REFERENCE_FILE,
    box2d: process.env.BOX2D_REFERENCE_FILE,
    trig: process.env.SAFETRIG_REFERENCE_FILE,
  };
  let ticks = 120;
  let stepScale = 1;
  let only = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[arg];
    if (key) values[key] = argv[++index];
    else if (arg === '--ticks') ticks = Number(argv[++index]);
    else if (arg === '--step-scale') stepScale = Number(argv[++index]);
    else if (arg === '--scenario') only = argv[++index];
    else throw new Error(`Unknown argument ${arg}`);
  }
  assert(
    values.box2d && values.trig,
    'Required: --box2d <file> --safe-trig <file> (or reference path environment variables)',
  );
  assert(Number.isSafeInteger(ticks) && ticks > 0 && ticks <= 3600, '--ticks must be in [1,3600]');
  assert(Number.isSafeInteger(stepScale) && stepScale >= 1 && stepScale <= 120, '--step-scale must be in [1,120]');
  assert(only === null || SCENARIOS.includes(only), `--scenario must be one of ${SCENARIOS.join(', ')}`);
  const root = path.resolve(__dirname, '../..');
  return {
    paths: {
      rawPath: path.resolve(values.raw || path.join(root, '.deobf/alpha2s.raw.js')),
      physicsPath: path.resolve(values.box2d),
      trigPath: path.resolve(values.trig),
    },
    ticks,
    stepScale,
    only,
  };
}
function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const results = [];
  for (const quality of [1, 2])
    for (const name of SCENARIOS) {
      if (parsed.only === null || parsed.only === name)
        results.push(runScenario(parsed.paths, name, parsed.ticks, quality, parsed.stepScale));
    }
  const report = {
    schema: 'bonk-rl-env.native-dynamic-classic-differential',
    version: 1,
    pass: results.every((result) => result.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    scope:
      'Pinned original Physics.step versus one RL-local Box2D world containing live Classic discs and dynamic map bodies. Physics-only death/capture state is compared; spawn dealing, scoring, round lifecycle and death presentation are excluded.',
    provenance: {
      rawClientSha256: digest(parsed.paths.rawPath),
      modifiedBox2DSha256: digest(parsed.paths.physicsPath),
      safeTrigSha256: digest(parsed.paths.trigPath),
    },
    ticksPerScenario: parsed.ticks,
    stepScale: parsed.stepScale,
    scenarios: results,
    totals: {
      scenarios: results.length,
      ticks: results.reduce((sum, result) => sum + result.ticks, 0),
      comparisons: results.reduce((sum, result) => sum + result.comparisons, 0),
      numericComparisons: results.reduce((sum, result) => sum + result.numericComparisons, 0),
      discreteComparisons: results.reduce((sum, result) => sum + result.discreteComparisons, 0),
      maximumAbsoluteError: results.reduce((max, result) => Math.max(max, result.maxError), 0),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { runScenario, scenario, inputsFor, TOLERANCE, SCENARIOS };
