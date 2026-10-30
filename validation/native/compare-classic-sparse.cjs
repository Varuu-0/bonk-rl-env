'use strict';

// Research-only original-vs-local sparse player-option differential. Native
// slots remain player IDs; only the local dense disc record list is compacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { localDiscs, localPlatforms, shouldSimulate, TOLERANCE } = require('./compare-classic-native.cjs');

const DEFAULT_TICKS = 120;
const CASES = Object.freeze([
  { name: 'dense-balance', id: 1, balance: 100 },
  { name: 'dense-default', id: 1, balance: undefined },
  { name: 'sparse-id-19-balance', id: 19, balance: 100 },
  { name: 'sparse-id-19-default', id: 19, balance: undefined },
  { name: 'sparse-id-3-balance', id: 3, balance: 100 },
  { name: 'sparse-id-3-default', id: 3, balance: undefined },
]);
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
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
]);
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];
function bits(value) {
  return INPUT_FIELDS.map((_, index) => (value & (1 << index)) !== 0);
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runCase(paths, definition, quality, ticks, perturb = false) {
  const oracle = createOracle(paths);
  const { createClassicPhysics } = require('../../src/core/classic-physics.ts');
  const physics = createClassicPhysics();
  try {
    const id = definition.id;
    const map = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../maps/training-platform.json'), 'utf8'));
    map.s.pq = quality;
    const balances = [];
    if (definition.balance !== undefined) balances[id] = definition.balance;
    const teams = [];
    teams[id] = 1;
    const players = [{ id, team: 1, balance: definition.balance }];
    const settings = { ga: 'b', mo: 'b', tea: false, bal: balances, map, gt: 2, wl: 3, q: false, maps: [] };
    let native = oracle.createNewState(players, map, 1, false, null, settings, true);
    // A single-player in-round scene has no round reset. Isolate Physics.step
    // from createNewState's countdown, as in the material differential.
    native.ftu = -1;
    native.rc = 0;
    assert(native.discs[id] && native.discs.filter(Boolean).length === 1);
    const denseNative = { ...native, discs: [{ ...native.discs[id], a1: native.discs[id].a1 === true }] };
    let discs = localDiscs(denseNative).map((disc) => ({ ...disc, id }));
    let platforms = localPlatforms(native);
    const report = {
      name: definition.name,
      id,
      quality,
      balance: definition.balance ?? null,
      ticks: 0,
      pass: true,
      comparisons: 0,
      numericComparisons: 0,
      discreteComparisons: 0,
      maxError: 0,
      maxErrorByField: {},
      firstMismatch: null,
      coverage: { simulatedTicks: 0, contactTicks: 0, radius: 0, nativeSlots: [], final: null },
    };
    const mismatch = (entry) => {
      if (report.firstMismatch === null) report.firstMismatch = entry;
      report.pass = false;
    };
    const check = (tick) => {
      report.ticks = tick;
      const actual = discs[0];
      const expected = native.discs[id];
      assert(
        actual && expected && actual.id === id,
        'Sparse differential requires a surviving disc at its original ID',
      );
      assert.equal(actual.alive, true);
      report.coverage.nativeSlots = native.discs.map((disc, slot) => (disc ? slot : -1)).filter((slot) => slot >= 0);
      assert.equal(report.coverage.nativeSlots.length, 1);
      assert.equal(report.coverage.nativeSlots[0], id);
      report.comparisons++;
      report.discreteComparisons++;
      for (const [localField, nativeField] of NUMERIC_FIELDS) {
        let localValue = actual[localField];
        if (perturb && tick === 1 && localField === 'yv') localValue += 1e-6;
        const nativeValue = expected[nativeField];
        const error = Math.abs(localValue - nativeValue);
        report.comparisons++;
        report.numericComparisons++;
        if (!Number.isFinite(error)) {
          mismatch({ tick, field: localField, actual: localValue, native: nativeValue, error: 'non-finite' });
          continue;
        }
        report.maxError = Math.max(report.maxError, error);
        report.maxErrorByField[localField] = Math.max(report.maxErrorByField[localField] ?? 0, error);
        if (error > TOLERANCE) mismatch({ tick, field: localField, actual: localValue, native: nativeValue, error });
      }
      for (const [field, nativeValue] of DISCRETE_FIELDS) {
        const expectedValue = nativeValue(expected);
        const actualValue = actual[field];
        report.comparisons++;
        report.discreteComparisons++;
        if (!Object.is(actualValue, expectedValue))
          mismatch({ tick, field, actual: actualValue, native: expectedValue });
      }
      report.coverage.radius = actual.radius;
      if (actual.yv < 0) report.coverage.contactTicks++;
      report.coverage.final = { tick, x: actual.x, y: actual.y, xv: actual.xv, yv: actual.yv, radius: actual.radius };
    };
    check(0);
    for (let tick = 1; tick <= ticks; tick++) {
      const simulate = shouldSimulate(native);
      native = oracle.step(native, { [id]: bits(0) }, null, 30, settings, 1, false, undefined);
      assert.equal(native.rc, 0, 'Single-player sparse differential must not cross a round boundary');
      const world = physics.stepWorld(
        discs,
        platforms,
        { [id]: 0 },
        {
          fly: false,
          noCollision: false,
          quality,
          simulate,
          balances,
          teams,
          teamCollision: false,
          mode: 'b',
          respawn: false,
          ppm: native.physics.ppm,
        },
      );
      discs = world.discs;
      platforms = world.platforms;
      if (simulate) report.coverage.simulatedTicks++;
      check(tick);
      if (report.firstMismatch !== null) break;
    }
    if (!perturb) {
      if (report.ticks !== ticks) mismatch({ field: 'coverage', expected: ticks, actual: report.ticks });
      if (report.coverage.simulatedTicks !== ticks)
        mismatch({ field: 'coverage', expected: `${ticks} simulated ticks`, actual: report.coverage.simulatedTicks });
      if (report.coverage.contactTicks === 0)
        mismatch({ field: 'coverage', expected: 'native floor rebound/contact trajectory' });
      const expectedRadius = definition.balance === undefined ? 1 : 2;
      if (report.coverage.radius !== expectedRadius)
        mismatch({
          field: 'coverage',
          expected: `native balance radius ${expectedRadius}`,
          actual: report.coverage.radius,
        });
    }
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareClassicSparse(paths, options = {}) {
  const ticks = options.ticks ?? DEFAULT_TICKS;
  const results = [];
  if (!options.negativeControlOnly) {
    for (const quality of [1, 2])
      for (const definition of CASES) results.push(runCase(paths, definition, quality, ticks));
  }
  let negativeControl = null;
  if (options.negativeControl || options.negativeControlOnly) {
    negativeControl = runCase(paths, CASES[2], 1, Math.min(ticks, 30), true);
    negativeControl.name = 'negative-control-injected-yv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch !== null &&
      negativeControl.firstMismatch.field === 'yv' &&
      negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
  }
  return {
    schema: 'bonk-rl-env.native-classic-sparse-options-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    scope:
      'Pinned original alpha2s Physics.step versus RL-local Classic core with dense and sparse native player IDs and sparse balance/team arrays. Single-player in-round static-floor balance behavior only; multi-player team-collision lifecycle and cross-platform bit parity are outside scope.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
    },
    ticksPerScenario: ticks,
    scenarios: results,
    negativeControl,
    totals: {
      scenarios: results.length,
      ticks: results.reduce((sum, result) => sum + result.ticks, 0),
      comparisons: results.reduce((sum, result) => sum + result.comparisons, 0),
      numericComparisons: results.reduce((sum, result) => sum + result.numericComparisons, 0),
      discreteComparisons: results.reduce((sum, result) => sum + result.discreteComparisons, 0),
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
  const options = { ticks: DEFAULT_TICKS, negativeControl: true, negativeControlOnly: false, output: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--negative-control-only') {
      options.negativeControlOnly = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[argument];
    if (key) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${argument} requires a file path`);
      values[key] = value;
      continue;
    }
    if (argument === '--ticks' || argument === '--out') {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${argument} requires a value`);
      if (argument === '--ticks') {
        options.ticks = Number(value);
        assert(
          Number.isSafeInteger(options.ticks) && options.ticks >= 1 && options.ticks <= 3600,
          '--ticks must be an integer in [1, 3600]',
        );
      } else options.output = path.resolve(cwd, value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  const root = path.resolve(__dirname, '../..');
  if ((!values.box2d || !values.trig) && !options.help)
    throw new Error(
      'BLOCKED: native comparison dependencies are required: --box2d and --safe-trig (or their path environment variables)',
    );
  return {
    paths: {
      rawPath: path.resolve(cwd, values.raw || path.join(root, '.deobf/alpha2s.raw.js')),
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
      'Usage: npx tsx validation/native/compare-classic-sparse.cjs --box2d <file> --safe-trig <file> [--ticks 120] [--out <new-file>]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Native dependency is not a file: ${file}`);
  const report = compareClassicSparse(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { CASES, compareClassicSparse, parseArguments, runCase, TOLERANCE };
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
