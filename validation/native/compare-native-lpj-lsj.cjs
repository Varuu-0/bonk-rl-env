'use strict';

// Research-only native lpj/lsj joint differential. No original client code is
// imported by production. The oracle executes only its reviewed, pinned spans.
// Scenarios cover the native lpj/lsj semantics (alpha2s.slot-accurate.numeric.js
// :5689-5800): prismatic construction, motor reversal at limits, velocity
// zeroing, pms writeback, spring force scaling, break behavior, and the
// authored-map createNewState unit conversions (:4302-4322).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { normalizeNativeMap } = require('../../src/core/native-map-state.ts');
const { createNativeWorld } = require('../../src/core/native-world.ts');

const ROOT = path.resolve(__dirname, '../..');

const TOLERANCE = 1e-9;
const SCENARIOS = [
  'lpj-ground-path',
  'lpj-body-path',
  'lpj-motor-reversal',
  'lpj-break',
  'lsj-ground-spring',
  'lsj-body-spring',
  'lsj-break',
  'lpj-lsj-combined',
];

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
      fric: 0.3,
      fricp: false,
      re: 0.8,
      de: 1,
      ld: 0.1,
      ad: 0.2,
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
function common(extra = {}) {
  return { cc: false, bf: 0, ...extra };
}
function baseMap() {
  return {
    v: 15,
    s: { re: false, nc: false, fl: false, pq: 1, gd: 25 },
    physics: { ppm: 10, shapes: [], fixtures: [], bodies: [], joints: [], bro: [] },
    spawns: [{ x: 0, y: 0, xv: 0, yv: 0, priority: 1, r: true, f: true, b: true, gr: false, ye: false, n: 'empty' }],
    capZones: [],
    m: { a: 'validation', n: 'lpj/lsj differential', dbv: 2, dbid: -1 },
  };
}
function scenario(name) {
  const map = baseMap();
  const p = map.physics;
  if (name === 'lpj-ground-path') {
    // A dynamic body following a ground-anchored path at 45°, generous force.
    // Authored convention (editor C0S :35020-35023): the body is ba, ground is bb.
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({
      type: 'lpj',
      ba: 0,
      bb: -1,
      pax: 0,
      pay: 0,
      pa: Math.PI / 4,
      pf: 900,
      pl: 0,
      pu: 0,
      plen: 60,
      pms: 30,
      d: common(),
    });
  } else if (name === 'lpj-body-path') {
    // A dynamic body on a path anchored to another dynamic body.
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false },
      { type: 'ci', c: [0, 0], a: 0, r: 8, sk: false },
    );
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('d', [0, 0], [0], { a: 0.3 }), body('d', [30, 10], [1], { a: -0.2 }));
    p.joints.push({
      type: 'lpj',
      ba: 0,
      bb: 1,
      pax: 5,
      pay: 5,
      pa: 1.1,
      pf: 500,
      pl: 0,
      pu: 0,
      plen: 40,
      pms: 20,
      d: common(),
    });
  } else if (name === 'lpj-motor-reversal') {
    // Short path with fast motor: the body reaches the limit and the native
    // motor reversal + velocity zeroing engages within the run.
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({
      type: 'lpj',
      ba: 0,
      bb: -1,
      pax: 0,
      pay: 0,
      pa: 0,
      pf: 10000,
      pl: 0,
      pu: 0,
      plen: 15,
      pms: 40,
      d: common(),
    });
  } else if (name === 'lpj-break') {
    // Tiny break force: the joint breaks under motor load.
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({
      type: 'lpj',
      ba: 0,
      bb: -1,
      pax: 0,
      pay: 0,
      pa: 0,
      pf: 5000,
      pl: 0,
      pu: 0,
      plen: 30,
      pms: 25,
      d: common({ bf: 1e-20 }),
    });
  } else if (name === 'lsj-ground-spring') {
    // A dynamic body on a ground-anchored spring at rest offset.
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({ type: 'lsj', ba: 0, bb: -1, sax: 0, say: 0, sf: 250, slen: 45, d: common() });
  } else if (name === 'lsj-body-spring') {
    // A dynamic body on a spring anchored to another dynamic body, offset to
    // engage the nonzero-k force branch.
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false },
      { type: 'ci', c: [0, 0], a: 0, r: 8, sk: false },
    );
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('d', [0, 0], [0], { a: 0.5 }), body('d', [0, 40], [1], { a: 0 }));
    p.joints.push({ type: 'lsj', ba: 0, bb: 1, sax: 5, say: 5, sf: 300, slen: 40, d: common() });
  } else if (name === 'lsj-break') {
    // Tiny break force: the spring joint breaks under load.
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({ type: 'lsj', ba: 0, bb: -1, sax: 0, say: 0, sf: 500, slen: 45, d: common({ bf: 1e-20 }) });
  } else if (name === 'lpj-lsj-combined') {
    // One body under both a path motor and a spring, plus a second body on a
    // separate path, exercising joint ordering and combined forces.
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false },
      { type: 'ci', c: [0, 0], a: 0, r: 8, sk: false },
      { type: 'bx', c: [0, 0], a: 0, w: 30, h: 10, sk: false },
    );
    p.fixtures.push(fixture(0), fixture(1), fixture(2));
    p.bodies.push(body('d', [0, 0], [0]), body('d', [10, 30], [1]), body('d', [40, 0], [2]));
    p.joints.push(
      { type: 'lpj', ba: 0, bb: -1, pax: 0, pay: 0, pa: 0.9, pf: 800, pl: 0, pu: 0, plen: 50, pms: 25, d: common() },
      { type: 'lsj', ba: 1, bb: -1, sax: 0, say: 0, sf: 200, slen: 30, d: common() },
      { type: 'lpj', ba: 2, bb: -1, pax: 0, pay: 0, pa: -1.2, pf: 600, pl: 0, pu: 0, plen: 35, pms: 18, d: common() },
    );
  } else throw new Error(`Unknown scenario ${name}`);
  p.bro = p.bodies.map((_, index) => index);
  return map;
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runScenario(paths, name, ticks, quality, injectedError) {
  const oracle = createOracle(paths);
  const world = createNativeWorld();
  const map = scenario(name);
  map.s.pq = quality;
  const settings = { ga: 'b', mo: 'b', tea: false, bal: [], map, gt: 2, wl: 3, q: false, maps: [] };
  let native;
  try {
    native = oracle.createNewState([], map, 1, false, null, settings, true);
    native.ftu = -1;
    let local = normalizeNativeMap(map);
    local.ftu = -1;
    const report = {
      name,
      quality,
      ticks: 0,
      pass: true,
      maxError: 0,
      comparisons: 0,
      numericComparisons: 0,
      discreteComparisons: 0,
      firstMismatch: null,
      maxErrorByField: {},
    };
    function mismatch(path, expected, actual, error) {
      report.pass = false;
      if (report.firstMismatch === null) report.firstMismatch = { tick: report.ticks, path, expected, actual, error };
    }
    function compare(expected, actual, field = 'physics') {
      report.comparisons++;
      if (expected === null || actual === null) {
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
      if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
        report.discreteComparisons++;
        mismatch(field, expected, actual);
        return;
      }
      for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${field}.${key}`);
    }
    compare(native.physics, local);
    for (let tick = 1; tick <= ticks && report.pass; tick++) {
      report.ticks = tick;
      native = oracle.step(native, [], null, 30, settings, 1, false, undefined);
      local = world.step(local, { quality, simulate: true });
      if (injectedError !== undefined && tick === 3) {
        // Negative control: perturb one lpj/lsj numeric field on the local side.
        const joint = local.joints.find((entry) => entry && (entry.type === 'lpj' || entry.type === 'lsj'));
        if (joint) {
          if (joint.type === 'lpj') joint.pms += injectedError;
          else joint.sf += injectedError;
        }
      }
      compare(native.physics, local);
    }
    return report;
  } catch (error) {
    return {
      name,
      quality,
      ticks: 0,
      pass: false,
      maxError: 0,
      comparisons: 0,
      numericComparisons: 0,
      discreteComparisons: 0,
      firstMismatch: { error: error.stack || String(error) },
      maxErrorByField: {},
    };
  } finally {
    world.dispose();
    oracle.dispose();
  }
}

function parseArguments(argv) {
  const values = {
    raw: process.env.BONK_RAW_REFERENCE_FILE,
    box2d: process.env.BOX2D_REFERENCE_FILE,
    trig: process.env.SAFETRIG_REFERENCE_FILE,
  };
  let ticks = 120;
  let negativeControl = false;
  let out;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[arg];
    if (key) values[key] = argv[++index];
    else if (arg === '--ticks') ticks = Number(argv[++index]);
    else if (arg === '--negative-control') negativeControl = true;
    else if (arg === '--out') out = argv[++index];
    else throw new Error(`Unknown argument ${arg}`);
  }
  assert(
    values.box2d && values.trig,
    'Required: --box2d <file> --safe-trig <file> (or reference path environment variables)',
  );
  assert(Number.isSafeInteger(ticks) && ticks > 0 && ticks <= 3600, '--ticks must be in [1,3600]');
  const root = path.resolve(__dirname, '../..');
  return {
    paths: {
      rawPath: path.resolve(values.raw || path.join(root, '.deobf/alpha2s.raw.js')),
      physicsPath: path.resolve(values.box2d),
      trigPath: path.resolve(values.trig),
    },
    ticks,
    negativeControl,
    out,
  };
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const paths = parsed.paths;
  const ticks = parsed.ticks;
  const results = [];
  for (const quality of [1, 2]) for (const name of SCENARIOS) results.push(runScenario(paths, name, ticks, quality));
  let negativeControlDetected = false;
  if (parsed.negativeControl) {
    const control = runScenario(paths, 'lpj-ground-path', 10, 1, 2e-6);
    negativeControlDetected = !control.pass;
  }
  const report = {
    schema: 'bonk-rl-env.native-lpj-lsj-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (!parsed.negativeControl || negativeControlDetected),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    negativeControlDetected,
    scope:
      'Map-only original alpha2s Physics.step lpj/lsj joint semantics versus RL-local dynamic map world. No disc/projectile/contact/capture/player lifecycle equivalence is claimed.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      nativeMapStateSha256: digest(path.join(ROOT, 'src/core/native-map-state.ts')),
      nativeWorldSha256: digest(path.join(ROOT, 'src/core/native-world.ts')),
    },
    ticksPerScenario: ticks,
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
  if (parsed.out) fs.writeFileSync(parsed.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { runScenario, scenario, TOLERANCE, SCENARIOS };
