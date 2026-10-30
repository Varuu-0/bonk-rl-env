'use strict';

// Research-only native dynamic-map differential. No original client code is
// imported by production. The oracle executes only its reviewed, pinned spans.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { normalizeNativeMap } = require('../../src/core/native-map-state.ts');
const { createNativeWorld } = require('../../src/core/native-world.ts');

const TOLERANCE = 1e-9;
const SCENARIOS = [
  'dynamic-compound',
  'kinematic-and-all-np',
  'constant-force-shrink',
  'distance',
  'revolute',
  'prismatic-motor',
  'material-collision',
  'joint-break',
  'prismatic-change-side',
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
    m: { a: 'validation', n: 'dynamic differential', dbv: 2, dbid: -1 },
  };
}
function scenario(name) {
  const map = baseMap();
  const p = map.physics;
  if (name === 'dynamic-compound') {
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0.3, w: 20, h: 10, sk: false },
      { type: 'ci', c: [20, 10], a: 0, r: 5, sk: false },
      {
        type: 'po',
        c: [0, 0],
        a: -0.1,
        s: 1.2,
        v: [
          [-10, -10],
          [10, -10],
          [0, 10],
        ],
        sk: false,
      },
    );
    p.fixtures.push(fixture(0, { fr: 0.2, fp: true, de: 2 }), fixture(1, { fr: 0.4, fp: false }), fixture(2));
    p.bodies.push(
      body('d', [20, -30], [0, 1, 2], {
        a: 0.4,
        lv: [0.3, -0.5],
        av: 0.7,
        s: { ...body('d', [], []).s, f_c: 2, f_p: false, fricp: true },
      }),
    );
  } else if (name === 'kinematic-and-all-np') {
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false },
      { type: 'ci', c: [0, 0], a: 0, r: 8, sk: false },
    );
    p.fixtures.push(fixture(0), fixture(1, { np: true }));
    p.bodies.push(
      body('k', [0, 0], [0], { lv: [1.2, -0.4], av: 0.5 }),
      body('d', [30, 10], [1], { lv: [3, 4], av: 5 }),
    );
  } else if (name === 'constant-force-shrink') {
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0.2, w: 100, h: 20, sk: true },
      { type: 'ci', c: [30, 0], a: 0, r: 6, sk: true },
    );
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('d', [0, 0], [0, 1], { a: Math.PI / 2, cf: { x: 30, y: 0, ct: 6, w: false } }));
  } else if (name === 'distance') {
    p.shapes.push(
      { type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false },
      { type: 'ci', c: [0, 0], a: 0, r: 8, sk: false },
    );
    p.fixtures.push(fixture(0), fixture(1));
    p.bodies.push(body('d', [0, 0], [0], { a: 0.2 }), body('d', [30, 10], [1], { a: -0.3 }));
    p.joints.push({ type: 'd', ba: 0, bb: 1, aa: [0, 0], ab: [0, 0], d: common({ fh: 2, dr: 0.5 }) });
  } else if (name === 'revolute') {
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0], { a: 0.2, s: { ...body('d', [], []).s, fr: true } }));
    p.joints.push({
      type: 'rv',
      ba: -1,
      bb: 0,
      aa: [0, 0],
      ab: [0, 0],
      d: common({ el: true, la: -0.6, ua: 0.6, em: true, ms: 1, mmt: 100 }),
    });
  } else if (name === 'prismatic-motor') {
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({
      type: 'p',
      ba: -1,
      bb: 0,
      aa: [0, 0],
      ab: [0, 0],
      axa: [1, 0],
      d: common({ el: true, lt: -50, ut: 50, em: true, ms: 1, mmf: 1000, cd: true }),
    });
  } else if (name === 'material-collision') {
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0, { fr: 0.25, fp: true, de: 0 }), fixture(0, { fr: 0.5, fp: false, de: 1 }));
    p.bodies.push(
      body('d', [0, 0], [0], { p: [0, 0], s: { ...body('d', [], []).s, f_c: 1, f_p: false, f_1: false, f_2: true } }),
      body('d', [0, 0], [1], { p: [0, 0], s: { ...body('d', [], []).s, f_c: 2, f_p: true, f_1: true, f_2: true } }),
    );
  } else if (name === 'joint-break') {
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push(null, { type: 'd', ba: -1, bb: 0, aa: [0, 0], ab: [0, 0], d: common({ bf: 1e-20, fh: 0, dr: 0 }) });
  } else if (name === 'prismatic-change-side') {
    p.shapes.push({ type: 'bx', c: [0, 0], a: 0, w: 20, h: 20, sk: false });
    p.fixtures.push(fixture(0));
    p.bodies.push(body('d', [0, 0], [0]));
    p.joints.push({
      type: 'p',
      ba: -1,
      bb: 0,
      aa: [0, 0],
      ab: [0, 0],
      axa: [1, 0],
      d: common({ el: true, lt: -20, ut: 20, em: true, ms: 2, mmf: 10000, cd: true }),
    });
  } else throw new Error(`Unknown scenario ${name}`);
  p.bro = p.bodies.map((_, index) => index);
  return map;
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function runScenario(paths, name, ticks, quality) {
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
      const simulate = native.ftu === -1;
      native = oracle.step(native, [], null, 30, settings, 1, false, undefined);
      local = world.step(local, { quality, simulate });
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
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[arg];
    if (key) values[key] = argv[++index];
    else if (arg === '--ticks') ticks = Number(argv[++index]);
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
  };
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const paths = parsed.paths;
  const ticks = parsed.ticks;
  const results = [];
  for (const quality of [1, 2]) for (const name of SCENARIOS) results.push(runScenario(paths, name, ticks, quality));
  const report = {
    schema: 'bonk-rl-env.native-dynamic-map-differential',
    version: 1,
    pass: results.every((result) => result.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    scope:
      'Map-only original alpha2s Physics.step versus RL-local dynamic map world. No disc/projectile/contact/capture/player lifecycle equivalence is claimed.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
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
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { runScenario, scenario, TOLERANCE, SCENARIOS };
