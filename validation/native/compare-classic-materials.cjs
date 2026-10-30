'use strict';

// Research-only native differential for effective static-fixture materials.
// The original client is executed only through the pinned, hash-checked oracle;
// production imports neither this runner nor the original client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { localDiscs, localPlatforms, shouldSimulate, TOLERANCE } = require('./compare-classic-native.cjs');

const DEFAULT_TICKS = 120;
const CASES = Object.freeze([
  { name: 'negative-friction', friction: -0.3, restitution: 0 },
  { name: 'restitution-over-one', friction: 0.5, restitution: 1.25 },
  { name: 'in-range-control', friction: 0.5, restitution: 0.8 },
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
  ['energy', (disc) => disc.a1a],
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
]);

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function bits(value) {
  return ['left', 'right', 'up', 'down', 'action', 'action2'].map((_, index) => (value & (1 << index)) !== 0);
}
function inputFor(_tick) {
  // Preserve the authored horizontal velocity without driving the disc off the
  // finite floor during the full 120-tick contact sequence.
  return 0;
}
function materialMap(friction, restitution, quality) {
  const map = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../maps/training-platform.json'), 'utf8'));
  // Native effective friction is (fixture.fr ?? body.s.fric), negated when
  // (fixture.fp ?? body.s.fricp) is truthy. Set fp=false to test direct signed
  // friction without conflating it with that separate sign-toggle encoding.
  Object.assign(map.physics.fixtures[0], { fr: friction, fp: false, re: restitution });
  // 12 pixels/m: xv=12px/tick -> 1m/s, yv=-36px/tick -> -3m/s.
  // The disc starts one metre above the floor's top and reaches it in eight ticks.
  map.spawns = [{ ...map.spawns[0], x: 0, y: -24, xv: 12, yv: -36, priority: 1 }];
  map.s.pq = quality;
  return map;
}

function runCase(paths, definition, quality, ticks, perturb = false) {
  const oracle = createOracle(paths);
  const { createClassicPhysics } = require('../../src/core/classic-physics.ts');
  const physics = createClassicPhysics();
  try {
    const map = materialMap(definition.friction, definition.restitution, quality);
    const settings = { ga: 'b', mo: 'b', tea: false, bal: [0], map, gt: 2, wl: 3, q: false, maps: [] };
    let native = oracle.createNewState([{ id: 0, team: 1 }], map, 1, false, null, settings, true);
    native.ftu = -1;
    native.rc = 0;
    let discs = localDiscs(native);
    let platforms = localPlatforms(native);
    assert.equal(platforms.length, 1);
    assert.equal(platforms[0].friction, definition.friction, 'Native did not preserve the effective signed friction');
    assert.equal(platforms[0].restitution, definition.restitution, 'Native did not preserve restitution');
    const normalizedMaterial = {
      fixture: {
        fr: native.physics.fixtures[0].fr,
        fp: native.physics.fixtures[0].fp,
        re: native.physics.fixtures[0].re,
      },
      body: {
        fric: native.physics.bodies[0].s.fric,
        fricp: native.physics.bodies[0].s.fricp,
        re: native.physics.bodies[0].s.re,
      },
      effective: { friction: platforms[0].friction, restitution: platforms[0].restitution },
    };
    const report = {
      name: definition.name,
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
      normalizedMaterial,
      coverage: {
        simulatedTicks: 0,
        materialResponseTicks: 0,
        firstResponseTick: null,
        maxTangentialSpeedLoss: 0,
        minReboundYv: 0,
        nativeSamples: [],
      },
    };
    const mismatch = (entry) => {
      if (report.firstMismatch === null) report.firstMismatch = entry;
      report.pass = false;
    };
    const check = (tick) => {
      report.ticks = tick;
      const actual = discs[0];
      const expected = native.discs[0];
      assert(
        actual && expected && actual.alive && expected.a1 !== true,
        `Material probe requires a surviving native/local disc (tick ${tick}; actual=${JSON.stringify(actual)}; native=${JSON.stringify(expected)})`,
      );
      report.comparisons++;
      report.discreteComparisons++;
      if (!Object.is(actual.alive, true)) mismatch({ tick, field: 'alive', actual: actual.alive, native: true });
      for (const [localField, nativeField] of NUMERIC_FIELDS) {
        let localValue = actual[localField];
        if (perturb && tick === 1 && localField === 'xv') localValue += 1e-6;
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
    };
    let previous = { xv: native.discs[0].xv, yv: native.discs[0].yv, x: native.discs[0].x, y: native.discs[0].y };
    const recordResponse = (tick) => {
      const current = native.discs[0];
      const damping = 1 - 0.01 / 30;
      const freeXv = previous.xv * damping;
      const freeYv = (previous.yv + 20 / 30) * damping;
      const tangentialLoss = freeXv - current.xv;
      const upwardContactImpulse = freeYv - current.yv;
      const nearFloor = current.y >= platforms[0].y - platforms[0].height / 2 - 1.1;
      // Require an observed normal response plus the expected signed-friction
      // tangential response. This rules out acceptance-only or no-contact runs.
      const frictionResponse = definition.friction < 0 && tangentialLoss > 0.1;
      const contactResponse = upwardContactImpulse > 1 && nearFloor && (definition.friction >= 0 || frictionResponse);
      if (contactResponse) {
        report.coverage.materialResponseTicks++;
        if (report.coverage.firstResponseTick === null) report.coverage.firstResponseTick = tick;
        report.coverage.maxTangentialSpeedLoss = Math.max(report.coverage.maxTangentialSpeedLoss, tangentialLoss);
        report.coverage.minReboundYv = Math.min(report.coverage.minReboundYv, current.yv);
        report.coverage.nativeSamples.push({
          tick,
          x: current.x,
          y: current.y,
          xv: current.xv,
          yv: current.yv,
          tangentialLoss,
          upwardContactImpulse,
        });
      }
      previous = { xv: current.xv, yv: current.yv, x: current.x, y: current.y };
    };
    check(0);
    for (let tick = 1; tick <= ticks; tick++) {
      const input = inputFor(tick);
      const simulate = shouldSimulate(native);
      native = oracle.step(native, [bits(input)], null, 30, settings, 1, false, undefined);
      assert.equal(native.rc, 0, 'Material probe must not cross a round boundary');
      const world = physics.stepWorld(
        discs,
        platforms,
        { 0: input },
        {
          fly: map.s.fl,
          noCollision: map.s.nc,
          quality,
          simulate,
          balances: settings.bal,
          mode: 'b',
          respawn: map.s.re,
          ppm: native.physics.ppm,
        },
      );
      discs = world.discs;
      platforms = world.platforms;
      if (simulate) report.coverage.simulatedTicks++;
      if (simulate) recordResponse(tick);
      check(tick);
      if (report.firstMismatch !== null) break;
    }
    if (!perturb) {
      if (report.ticks !== ticks)
        mismatch({ field: 'coverage', expected: `${ticks} compared ticks`, actual: report.ticks });
      if (report.coverage.simulatedTicks !== ticks)
        mismatch({ field: 'coverage', expected: `${ticks} simulated ticks`, actual: report.coverage.simulatedTicks });
      if (report.coverage.materialResponseTicks === 0)
        mismatch({ field: 'coverage', expected: 'observed native floor-contact material response' });
      if (definition.name === 'negative-friction' && report.coverage.maxTangentialSpeedLoss <= 0.1)
        mismatch({ field: 'coverage', expected: 'negative-friction tangential impulse' });
      if (definition.name === 'restitution-over-one' && report.coverage.minReboundYv >= -2.8)
        mismatch({
          field: 'coverage',
          expected: 'restitution > 1 rebound below -2.8',
          actual: report.coverage.minReboundYv,
        });
      if (
        definition.name === 'in-range-control' &&
        !(report.coverage.minReboundYv > -2.8 && report.coverage.minReboundYv < -2)
      )
        mismatch({
          field: 'coverage',
          expected: 'control rebound in (-2.8, -2)',
          actual: report.coverage.minReboundYv,
        });
    }
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareClassicMaterials(paths, options = {}) {
  const ticks = options.ticks ?? DEFAULT_TICKS;
  const results = [];
  if (!options.negativeControlOnly) {
    for (const quality of [1, 2])
      for (const definition of CASES) results.push(runCase(paths, definition, quality, ticks));
  }
  let negativeControl = null;
  if (options.negativeControl || options.negativeControlOnly) {
    negativeControl = runCase(paths, CASES[0], 1, Math.min(ticks, 30), true);
    negativeControl.name = 'negative-control-injected-xv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch !== null &&
      negativeControl.firstMismatch.field === 'xv' &&
      negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
  }
  return {
    schema: 'bonk-rl-env.native-classic-material-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    scope:
      'Pinned original alpha2s Physics.step versus RL-local Classic core on one static floor with effective signed friction and restitution > 1. Parser acceptance alone, all maps/modes, and cross-platform bit parity are outside scope.',
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
      'Usage: npx tsx validation/native/compare-classic-materials.cjs --box2d <file> --safe-trig <file> [--ticks 120] [--out <new-file>]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Native dependency is not a file: ${file}`);
  const report = compareClassicMaterials(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { CASES, compareClassicMaterials, materialMap, parseArguments, runCase, TOLERANCE };
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
