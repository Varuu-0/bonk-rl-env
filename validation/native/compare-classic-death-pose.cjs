'use strict';

// Research-only differential for native death presentation before live-disc
// respawn. Expected values come only from the pinned original Physics.step.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { localDiscs, localPlatforms, TOLERANCE } = require('./compare-classic-native.cjs');

const ROOT = path.resolve(__dirname, '../..');
const QUALITIES = Object.freeze([1, 2]);
const NUMERIC_FIELDS = Object.freeze([
  ['x', 'x'],
  ['y', 'y'],
  ['xv', 'xv'],
  ['yv', 'yv'],
  ['angle', 'a'],
  ['angularVelocity', 'av'],
  ['energy', 'a1a'],
]);
const DISCRETE_FIELDS = Object.freeze([
  ['energy', (disc) => disc.a1a],
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
]);
const INPUT = Object.freeze({ left: false, right: false, up: false, down: false, action: false, action2: false });
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function deathPoseMap(quality) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
  map.s.pq = quality;
  map.s.re = true;
  map.physics.fixtures[0].d = true;
  // The disc touches the lethal floor on the first step and has a distinct
  // authored spawn position and velocity to restore immediately afterwards.
  map.spawns = [{ ...map.spawns[0], x: 0, y: -24, xv: 12, yv: -36, priority: 1 }];
  return map;
}

function runCase(paths, quality, perturb = false) {
  const oracle = createOracle(paths);
  const { createClassicPhysics } = require('../../src/core/classic-physics.ts');
  const physics = createClassicPhysics();
  try {
    const map = deathPoseMap(quality);
    const settings = { ga: 'b', mo: 'b', tea: false, bal: [0], map, gt: 2, wl: 3, q: false, maps: [] };
    let native = oracle.createNewState([{ id: 0, team: 1 }], map, 1, false, null, settings, true);
    native.ftu = -1;
    native.fte = -1;
    native.rc = 0;
    let discs = localDiscs(native);
    const platforms = localPlatforms(native);
    assert.equal(platforms.length, 1);
    assert.equal(platforms[0].lethal, true, 'Original fixture must be lethal');
    const report = {
      name: `lethal-respawn-q${quality}`,
      quality,
      seed: 1,
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
        lethalDeaths: 0,
        respawns: 0,
        roundRollovers: 0,
        deathDiffersFromRestoredLiveDisc: false,
        originalSample: null,
      },
    };
    const mismatch = (entry) => {
      if (report.firstMismatch === null) report.firstMismatch = entry;
      report.pass = false;
    };
    const discrete = (tick, entity, id, field, actual, expected) => {
      report.comparisons++;
      report.discreteComparisons++;
      if (!Object.is(actual, expected)) mismatch({ tick, entity, id, field, actual, native: expected });
    };
    const numeric = (tick, entity, id, field, actual, expected) => {
      if (perturb && tick === 1 && entity === 'death' && field === 'y') actual += 1e-6;
      const error = Math.abs(actual - expected);
      const key = `${entity}.${field}`;
      report.comparisons++;
      report.numericComparisons++;
      if (!Number.isFinite(error)) {
        mismatch({ tick, entity, id, field, actual, native: expected, error: 'non-finite' });
        return;
      }
      report.maxError = Math.max(report.maxError, error);
      report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] ?? 0, error);
      if (error > TOLERANCE) mismatch({ tick, entity, id, field, actual, native: expected, error });
    };
    const check = (tick, deaths) => {
      report.ticks = tick;
      const actual = discs[0];
      const expected = native.discs[0];
      discrete(tick, 'disc', 0, 'alive', actual?.alive === true, expected !== undefined && expected !== null);
      if (actual?.alive === true && expected) {
        for (const [localField, nativeField] of NUMERIC_FIELDS)
          numeric(tick, 'disc', 0, localField, actual[localField], expected[nativeField]);
        for (const [field, read] of DISCRETE_FIELDS) discrete(tick, 'disc', 0, field, actual[field], read(expected));
      }
      const nativeDeaths = native.discDeaths.filter((death) => death.f === 0);
      discrete(tick, 'deaths', null, 'length', deaths.length, nativeDeaths.length);
      for (let index = 0; index < Math.max(deaths.length, nativeDeaths.length); index++) {
        const local = deaths[index];
        const original = nativeDeaths[index];
        discrete(tick, 'death', index, 'id', local?.id, original?.i);
        discrete(tick, 'death', index, 'cause', local?.cause, original ? 'lethal-contact' : undefined);
        discrete(tick, 'death', index, 'nativeCause', local?.cause === 'lethal-contact' ? 1 : null, original?.m);
        for (const field of ['x', 'y', 'xv', 'yv'])
          numeric(tick, 'death', index, field, local?.[field], original?.[field]);
        if (local && original) {
          report.coverage.lethalDeaths++;
          if (original.m !== 1)
            mismatch({ tick, entity: 'coverage', field: 'lethal contact', actual: original.m, native: 1 });
          report.coverage.originalSample = {
            tick,
            death: { x: original.x, y: original.y, xv: original.xv, yv: original.yv, f: original.f, m: original.m },
            restoredDisc: {
              x: expected.x,
              y: expected.y,
              xv: expected.xv,
              yv: expected.yv,
              sx: expected.sx,
              sy: expected.sy,
              sxv: expected.sxv,
              syv: expected.syv,
              ni: expected.ni === true,
            },
          };
          report.coverage.deathDiffersFromRestoredLiveDisc = ['x', 'y', 'xv', 'yv'].every(
            (field) => Math.abs(original[field] - expected[field]) > TOLERANCE,
          );
        }
      }
      if (tick > 0 && expected?.ni === true && actual?.alive === true) report.coverage.respawns++;
    };
    check(0, []);
    const previousRound = native.rc;
    native = oracle.step(native, [INPUT], null, 30, settings, 1, false, undefined);
    if (native.rc !== previousRound) report.coverage.roundRollovers++;
    const world = physics.stepWorld(
      discs,
      platforms,
      { 0: 0 },
      {
        fly: map.s.fl,
        noCollision: map.s.nc,
        quality,
        simulate: true,
        balances: settings.bal,
        teams: [1],
        mode: 'b',
        respawn: map.s.re,
        ppm: native.physics.ppm,
      },
    );
    discs = world.discs;
    report.coverage.simulatedTicks++;
    check(1, world.deaths || []);
    if (!perturb) {
      if (report.coverage.simulatedTicks !== 1)
        mismatch({ field: 'coverage', expected: 'one simulated lethal-contact tick' });
      if (report.coverage.lethalDeaths !== 1)
        mismatch({ field: 'coverage', expected: 'one native lethal death with presentation state' });
      if (report.coverage.respawns !== 1)
        mismatch({ field: 'coverage', expected: 'one native immediate live-disc respawn' });
      if (!report.coverage.deathDiffersFromRestoredLiveDisc)
        mismatch({ field: 'coverage', expected: 'all four death fields differ from restored live-disc state' });
      if (report.coverage.roundRollovers !== 0) mismatch({ field: 'coverage', expected: 'no round rollover' });
    }
    report.provenance = oracle.provenance;
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareClassicDeathPose(paths, options = {}) {
  const results = options.negativeControlOnly ? [] : QUALITIES.map((quality) => runCase(paths, quality));
  let negativeControl = null;
  if (options.negativeControl !== false) {
    negativeControl = runCase(paths, 1, true);
    negativeControl.name = 'negative-control-injected-death-y-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch?.entity === 'death' &&
      negativeControl.firstMismatch?.field === 'y' &&
      negativeControl.firstMismatch?.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
  }
  return {
    schema: 'bonk-rl-env.native-classic-death-pose-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    scope:
      'Pinned original alpha2s Physics.step versus only ClassicPhysicsWorld on a one-player static lethal floor. Compares post-solver death x/y/xv/yv and immediate restored live-disc state at q1/q2 without a round rollover. Full-session lifecycle, other death causes, all maps/modes, online play, and bit parity are outside scope.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localClassicPhysicsSha256: digest(path.join(ROOT, 'src/core/classic-physics.ts')),
    },
    scenarios: results,
    negativeControl,
    totals: {
      scenarios: results.length,
      ticks: results.reduce((sum, result) => sum + result.ticks, 0),
      comparisons: results.reduce((sum, result) => sum + result.comparisons, 0),
      numericComparisons: results.reduce((sum, result) => sum + result.numericComparisons, 0),
      discreteComparisons: results.reduce((sum, result) => sum + result.discreteComparisons, 0),
      lethalDeaths: results.reduce((sum, result) => sum + result.coverage.lethalDeaths, 0),
      respawns: results.reduce((sum, result) => sum + result.coverage.respawns, 0),
      maximumAbsoluteError: results.reduce((maximum, result) => Math.max(maximum, result.maxError), 0),
    },
  };
}

function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = { negativeControl: true, negativeControlOnly: false, output: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--negative-control-only') {
      options.negativeControlOnly = true;
      continue;
    }
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[argument];
    if (key) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${argument} requires a file path`);
      values[key] = value;
      continue;
    }
    if (argument === '--out') {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), '--out requires a new file path');
      options.output = path.resolve(cwd, value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if ((!values.box2d || !values.trig) && !options.help)
    throw new Error(
      'BLOCKED: native comparison dependencies are required: --box2d and --safe-trig (or their path environment variables)',
    );
  return {
    paths: {
      rawPath: path.resolve(cwd, values.raw || path.join(ROOT, '.deobf/alpha2s.raw.js')),
      physicsPath: values.box2d ? path.resolve(cwd, values.box2d) : undefined,
      trigPath: values.trig ? path.resolve(cwd, values.trig) : undefined,
    },
    ...options,
  };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(
      'Usage: npx tsx validation/native/compare-classic-death-pose.cjs --box2d <file> --safe-trig <file> [--out <new-file>]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Native dependency is not a file: ${file}`);
  const report = compareClassicDeathPose(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { compareClassicDeathPose, deathPoseMap, parseArguments, runCase, TOLERANCE };
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
