'use strict';

// Research-only original-vs-local differential at the pinned Physics.step boundary.
// The original client is never imported by production code. This runner deliberately
// drives createClassicPhysics directly, not the legacy PhysicsEngine or game lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');

const TOLERANCE = 1e-9;
const DEFAULT_TICKS = 360;
const SCENARIOS = Object.freeze(['neutral', 'move', 'jump', 'heavy', 'input-precedence', 'fly', 'collision']);
const INPUT_FIELDS = Object.freeze(['left', 'right', 'up', 'down', 'action', 'action2']);
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
  ['alive', (disc) => disc !== undefined && disc !== null],
  ['energy', (disc) => disc.a1a],
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
]);

function usage() {
  return [
    'Usage:',
    '  node validation/native/compare-classic-native.cjs --box2d <file> --safe-trig <file> [options]',
    '',
    'Options:',
    '  --raw <file>          Pinned alpha2s client (default: RL .deobf/alpha2s.raw.js)',
    '  --box2d <file>        Pinned original modified Box2DModuleGJMod.js (or BOX2D_REFERENCE_FILE)',
    '  --safe-trig <file>    Pinned original SafeTrig.js (or SAFETRIG_REFERENCE_FILE)',
    '  --ticks <1..3600>     Ticks per scenario (default: 360)',
    '  --negative-control    Also prove that an injected 1e-6 velocity error is rejected',
    '  --negative-control-only  Run that control without the full corpus (CI smoke test)',
    '  --out <file>          Write the JSON report to a new file',
    '',
    'BONK_RAW_REFERENCE_FILE may supply --raw. No bonk-game path is discovered or used.',
    'Missing dependencies, altered hashes, and mismatches fail; native comparison is never skipped.',
  ].join('\n');
}

function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = { ticks: DEFAULT_TICKS, negativeControl: false, negativeControlOnly: false, output: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--negative-control' || argument === '--negative-control-only') {
      options.negativeControl = true;
      if (argument === '--negative-control-only') options.negativeControlOnly = true;
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
      } else {
        options.output = path.resolve(cwd, value);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }
  const root = path.resolve(__dirname, '../..');
  const raw = path.resolve(cwd, values.raw || path.join(root, '.deobf/alpha2s.raw.js'));
  const missing = [];
  if (!values.box2d) missing.push('--box2d / BOX2D_REFERENCE_FILE');
  if (!values.trig) missing.push('--safe-trig / SAFETRIG_REFERENCE_FILE');
  if (missing.length > 0 && !options.help) {
    const error = new Error(`BLOCKED: native comparison dependencies are required: ${missing.join(', ')}\n${usage()}`);
    error.code = 'NATIVE_DEPENDENCIES_MISSING';
    throw error;
  }
  return {
    paths: {
      rawPath: raw,
      physicsPath: values.box2d ? path.resolve(cwd, values.box2d) : undefined,
      trigPath: values.trig ? path.resolve(cwd, values.trig) : undefined,
    },
    ...options,
  };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}

function inputsFor(name, tick) {
  let first = 0;
  let second = 0;
  if (name === 'move') first = tick % 120 < 60 ? 1 : 2;
  if (name === 'jump') first = tick % 90 < 30 ? 4 : 0;
  if (name === 'heavy') first = tick >= 20 && tick < 130 ? 2 | 16 : 2;
  if (name === 'input-precedence') {
    first = 1 | 2 | 4 | 8;
    second = 2 | 8;
  }
  if (name === 'fly') first = 4;
  if (name === 'collision') {
    first = 2;
    second = 1;
  }
  return [first, second];
}

function settingsFor(map, balances) {
  return { ga: 'b', mo: 'b', tea: false, bal: balances, map, gt: 2, wl: 3, q: false, maps: [] };
}

function localDiscs(native) {
  return native.discs.map((disc, id) => {
    assert(disc && disc.a1 === false, `Expected a live native Classic disc at slot ${id}`);
    return {
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
      heavy: disc.a1,
      alive: true,
      lhid: disc.lhid,
      lht: disc.lht,
      ni: disc.ni === true,
      ds: disc.ds,
      da: disc.da,
      vt: disc.vt,
    };
  });
}

// This is a validation adapter for the native normalized static training state,
// not a production map loader. Reading the original's normalized values avoids
// validating the local solver against a separately guessed coordinate conversion.
function localPlatforms(native) {
  const platforms = [];
  native.physics.bodies.forEach((body, bodyId) => {
    if (!body) return;
    assert.equal(body.s.type, 's', 'Differential runner supports static bodies only');
    for (const fixtureIndex of body.fx) {
      const fixture = native.physics.fixtures[fixtureIndex];
      const shape = native.physics.shapes[fixture.sh];
      assert(shape.type === 'bx' || shape.type === 'ci', 'Differential runner supports box/circle static fixtures');
      const localAngle = shape.type === 'bx' ? (shape.a ?? 0) : 0;
      const localX = shape.c[0];
      const localY = shape.c[1];
      const cos = Math.cos(body.a);
      const sin = Math.sin(body.a);
      platforms.push({
        id: fixtureIndex,
        bodyId,
        shape: shape.type === 'bx' ? 'box' : 'circle',
        ...(shape.type === 'bx' ? { width: shape.w, height: shape.h } : { radius: shape.r }),
        x: body.p[0] + cos * localX - sin * localY,
        y: body.p[1] + sin * localX + cos * localY,
        angle: body.a + localAngle,
        color: fixture.f,
        friction: fixture.fr ?? body.s.fric,
        restitution: fixture.re ?? body.s.re,
        lethal: fixture.d === true,
        bodyX: body.p[0],
        bodyY: body.p[1],
        bodyAngle: body.a,
        localX,
        localY,
        localAngle,
      });
    }
  });
  return platforms;
}

function shouldSimulate(native) {
  // Pinned step gate (raw numeric 6538-6553): only the entry countdown gates
  // Box2D. Result countdown ticks, including fte=90 after a death, still step.
  return native.ftu === -1;
}

function createRun(paths, name, quality, ticks, perturb = false) {
  assert(SCENARIOS.includes(name), `Unknown scenario ${name}`);
  const oracle = createOracle(paths);
  const { createClassicPhysics } = require('../../src/core/classic-physics.ts');
  const physics = createClassicPhysics();
  try {
    const map = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../maps/training-platform.json'), 'utf8'));
    map.s.pq = quality;
    if (name === 'fly') map.s.fl = true;
    if (name === 'collision') {
      for (const spawn of map.spawns) {
        spawn.x = spawn.n === 'Left Spawn' ? -10 : 10;
        spawn.y = -30;
      }
    }
    const roster = [
      { id: 0, team: 1 },
      { id: 1, team: 1 },
    ];
    const settings = settingsFor(map, [0, 0]);
    let native = oracle.createNewState(roster, map, 1, false, null, settings, true);
    native.rc = 0;
    let discs = localDiscs(native);
    let platforms = localPlatforms(native);
    const report = {
      name,
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
      coverage: { simulatedTicks: 0, heavyTicks: 0, minEnergy: 1000, jumpTicks: 0, contactTicks: 0, roundReseeds: 0 },
    };
    const mismatch = (entry) => {
      if (report.firstMismatch === null) report.firstMismatch = entry;
      report.pass = false;
    };
    const check = (tick) => {
      report.ticks = tick;
      for (let id = 0; id < 2; id++) {
        const actual = discs.find((disc) => disc.id === id);
        const expected = native.discs[id];
        const alive = expected !== undefined && expected !== null;
        report.comparisons++;
        report.discreteComparisons++;
        if (actual === undefined || actual.alive !== alive) {
          mismatch({ tick, disc: id, field: 'alive', actual: actual?.alive, native: alive });
          continue;
        }
        if (!alive) continue;
        for (const [localField, nativeField] of NUMERIC_FIELDS) {
          let localValue = actual[localField];
          if (perturb && tick === 1 && id === 0 && localField === 'xv') localValue += 1e-6;
          const nativeValue = expected[nativeField];
          const error = Math.abs(localValue - nativeValue);
          report.comparisons++;
          report.numericComparisons++;
          if (!Number.isFinite(error)) {
            mismatch({
              tick,
              disc: id,
              field: localField,
              actual: localValue,
              native: nativeValue,
              error: 'non-finite',
            });
            continue;
          }
          report.maxError = Math.max(report.maxError, error);
          report.maxErrorByField[localField] = Math.max(report.maxErrorByField[localField] ?? 0, error);
          if (error > TOLERANCE)
            mismatch({ tick, disc: id, field: localField, actual: localValue, native: nativeValue, error });
        }
        for (const [field, nativeValue] of DISCRETE_FIELDS) {
          const expectedValue = nativeValue(expected);
          const actualValue = actual[field];
          report.comparisons++;
          report.discreteComparisons++;
          if (!Object.is(actualValue, expectedValue)) {
            mismatch({ tick, disc: id, field, actual: actualValue, native: expectedValue });
          }
        }
        report.coverage.minEnergy = Math.min(report.coverage.minEnergy, actual.energy);
        if (actual.heavy) report.coverage.heavyTicks++;
        if (actual.lhid !== -1 || actual.lht !== 0) report.coverage.contactTicks++;
        if (actual.yv < -4) report.coverage.jumpTicks++;
      }
    };
    check(0);
    for (let tick = 1; tick <= ticks; tick++) {
      const input = inputsFor(name, tick);
      const previousRound = native.rc;
      // Native uses the entry-state countdown. The first return with ftu === -1
      // is still non-simulating; result countdown does not disable physics.
      const simulate = shouldSimulate(native);
      native = oracle.step(native, input.map(bits), null, 30, settings, 1, false, undefined);
      if (native.rc !== previousRound) {
        // Round spawn selection is outside this foundation port. Re-enter only at
        // the original's new-round boundary; never replace in-round local state.
        discs = localDiscs(native);
        platforms = localPlatforms(native);
        report.coverage.roundReseeds++;
      } else {
        const world = physics.stepWorld(
          discs,
          platforms,
          { 0: input[0], 1: input[1] },
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
      }
      if (simulate) report.coverage.simulatedTicks++;
      check(tick);
      if (report.firstMismatch !== null) break;
    }
    if (!perturb) {
      if (report.ticks !== ticks)
        mismatch({ field: 'coverage', expected: `${ticks} compared ticks`, actual: report.ticks });
      if (name === 'heavy' && report.coverage.minEnergy >= 1000)
        mismatch({ field: 'coverage', expected: 'heavy energy drain' });
      if (name === 'jump' && report.coverage.jumpTicks === 0)
        mismatch({ field: 'coverage', expected: 'native jump velocity below -4' });
      if (name === 'collision' && report.coverage.contactTicks === 0)
        mismatch({ field: 'coverage', expected: 'disc-disc last-hit attribution' });
    }
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareClassicNative(paths, options = {}) {
  const ticks = options.ticks ?? DEFAULT_TICKS;
  const results = [];
  if (!options.negativeControlOnly) {
    for (const quality of [1, 2]) {
      for (const name of SCENARIOS) results.push(createRun(paths, name, quality, ticks));
    }
  }
  let negativeControl = null;
  if (options.negativeControl) {
    negativeControl = createRun(paths, 'move', 1, Math.min(ticks, 90), true);
    negativeControl.name = 'negative-control-injected-xv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.pass =
      negativeControl.firstMismatch !== null &&
      negativeControl.firstMismatch.field === 'xv' &&
      negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.detected = negativeControl.pass;
    delete negativeControl.maxErrorByField;
  }
  return {
    schema: 'bonk-rl-env.native-classic-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    scope:
      'Pinned original alpha2s Physics.step versus RL-local Classic core on the static Classic training arena. Lifecycle respawn/round selection, all maps/modes, online server state, and cross-platform bit parity are outside scope.',
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

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  for (const file of Object.values(options.paths)) {
    assert(fs.statSync(file).isFile(), `Native dependency is not a file: ${file}`);
  }
  const report = compareClassicNative(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = {
  compareClassicNative,
  createRun,
  parseArguments,
  localDiscs,
  localPlatforms,
  inputsFor,
  shouldSimulate,
  TOLERANCE,
  SCENARIOS,
};
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
