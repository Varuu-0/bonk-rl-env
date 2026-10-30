'use strict';

// Original alpha2s createNewState/step versus the raw-map dynamic Classic
// session. Both sides own their complete countdown, scoring and round lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { scenario, inputsFor } = require('./compare-dynamic-classic-native.cjs');
const { createNativeMapSession, nativeMapToArena } = require('../../src/core/native-map-session.ts');

const ROOT = path.resolve(__dirname, '../..');
const TOLERANCE = 1e-9;
const SCENARIOS = ['moving-platform', 'lethal-moving-fixture', 'timed-capture', 'instant-goal'];
const DEFAULT_TICKS = 340;
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];
const DISC_NUMERIC = [
  ['x', 'x'],
  ['y', 'y'],
  ['xv', 'xv'],
  ['yv', 'yv'],
  ['angle', 'a'],
  ['angularVelocity', 'av'],
  ['energy', 'a1a'],
  ['sx', 'sx'],
  ['sy', 'sy'],
  ['sxv', 'sxv'],
  ['syv', 'syv'],
];
const LOCAL_FILES = [
  'src/core/native-map-session.ts',
  'src/core/native-map-codec.ts',
  'src/core/native-map-state.ts',
  'src/core/native-session.ts',
  'src/core/native-spawns.ts',
  'src/core/native-classic-world.ts',
  'src/core/native-world.ts',
  'src/core/safe-trig.ts',
];
function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function sessionMap(name, quality) {
  const map = scenario(name);
  // The core oracle accepts the minimal authored metadata directly; the strict
  // JSON session codec additionally requires these inert database/presentation
  // fields. They do not participate in physics or round state.
  Object.assign(map.m, {
    authid: -1,
    date: '',
    rxid: 0,
    rxn: '',
    rxa: '',
    rxdb: 1,
    cr: [],
    pub: false,
    mo: 'b',
  });
  map.s.pq = quality;
  return map;
}
function runScenario(paths, name, ticks = DEFAULT_TICKS, quality = 1, options = {}) {
  const oracle = createOracle(paths);
  const map = sessionMap(name, quality);
  const roster = [
    { id: 2, team: 1 },
    { id: 7, team: 2 },
  ];
  const balances = [];
  for (const player of roster) balances[player.id] = 0;
  const settings = { ga: 'b', mo: 'b', tea: false, bal: balances, map, gt: 2, wl: 999, q: false, maps: [] };
  let session;
  const report = {
    name: `${name}-q${quality}`,
    scenario: name,
    quality,
    ids: [2, 7],
    seed: 1,
    ticks: 0,
    frames: 0,
    pass: true,
    status: 'PASS',
    comparisons: 0,
    numericComparisons: 0,
    discreteComparisons: 0,
    maxError: 0,
    maxErrorByField: {},
    firstMismatch: null,
    mismatches: [],
    localRepairOrReseeds: 0,
    coverage: {
      simulatedTicks: 0,
      resultTicks: 0,
      rollovers: 0,
      postRolloverSimulationTicks: 0,
      postRolloverCountdowns: [],
      movingMapTicks: 0,
      discMapContacts: 0,
      discDiscContacts: 0,
      captureProgressTicks: 0,
      capZoneContacts: 0,
      instantGoalTicks: 0,
      respawnTicks: 0,
      deathCauses: { 1: 0, 3: 0, 4: 0 },
    },
    coverageFailures: [],
  };
  function mismatch(entry) {
    report.pass = false;
    report.status = 'FAIL';
    if (report.firstMismatch === null) report.firstMismatch = entry;
    if (report.mismatches.length < 20) report.mismatches.push(entry);
  }
  function compare(expected, actual, field) {
    report.comparisons++;
    if (options.perturb && report.ticks === 1 && field === 'discs[2].xv') actual += 1e-6;
    if (expected === null || actual === null || expected === undefined || actual === undefined) {
      report.discreteComparisons++;
      if (expected !== actual) mismatch({ tick: report.ticks, field, native: expected, actual });
      return;
    }
    if (typeof expected === 'number') {
      report.comparisons--;
      report.numericComparisons++;
      report.comparisons++;
      if (typeof actual !== 'number') {
        report.discreteComparisons++;
        mismatch({ tick: report.ticks, field, native: expected, actual });
        return;
      }
      const error = Math.abs(expected - actual);
      if (!Number.isFinite(error)) {
        mismatch({ tick: report.ticks, field, native: expected, actual, error: 'non-finite' });
        return;
      }
      report.maxError = Math.max(report.maxError, error);
      const key = field.split('.').slice(0, 2).join('.');
      report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] || 0, error);
      if (error > TOLERANCE) mismatch({ tick: report.ticks, field, native: expected, actual, error });
      return;
    }
    if (typeof expected !== 'object') {
      report.discreteComparisons++;
      if (!Object.is(expected, actual)) mismatch({ tick: report.ticks, field, native: expected, actual });
      return;
    }
    if (Array.isArray(expected)) {
      report.discreteComparisons++;
      if (!Array.isArray(actual) || expected.length !== actual.length) {
        mismatch({ tick: report.ticks, field: `${field}.length`, native: expected.length, actual: actual?.length });
        return;
      }
      for (let index = 0; index < expected.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(expected, String(index))) {
          report.discreteComparisons++;
          if (Object.prototype.hasOwnProperty.call(actual, String(index)))
            mismatch({ tick: report.ticks, field: `${field}[${index}]`, native: 'hole', actual: actual[index] });
          continue;
        }
        compare(expected[index], actual[index], `${field}[${index}]`);
      }
      return;
    }
    if (typeof actual !== 'object' || Array.isArray(actual)) {
      report.discreteComparisons++;
      mismatch({ tick: report.ticks, field, native: expected, actual });
      return;
    }
    for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${field}.${key}`);
  }
  function check(native) {
    report.frames++;
    const actual = session.getState();
    for (const field of ['seed', 'ftu', 'fte', 'rl', 'rc', 'lscr']) compare(native[field], actual[field], field);
    // createNewState initializes scores densely by roster position, then native
    // scoring extends the same table at sparse player IDs. Preserve both forms.
    for (let index = 0; index < roster.length; index++) {
      const id = roster[index].id;
      compare(native.scores[id] ?? native.scores[index] ?? null, actual.scores[id] ?? null, `scores[${id}]`);
    }
    compare(native.discDeaths, actual.discDeaths, 'discDeaths');
    compare(native.physics, actual.physics, 'physics');
    compare(native.capZones, actual.capZones, 'capZones');
    const length = Math.max(native.discs.length, actual.discs.length);
    for (let id = 0; id < length; id++) {
      const expected = native.discs[id];
      const disc = actual.discs[id];
      compare(
        expected !== undefined && expected !== null,
        disc !== undefined && disc.alive === true,
        `discs[${id}].presentAlive`,
      );
      if (!expected || !disc) continue;
      for (const [localField, nativeField] of DISC_NUMERIC)
        compare(expected[nativeField], disc[localField], `discs[${id}].${localField}`);
      compare(expected.a1 === true, disc.heavy, `discs[${id}].heavy`);
      for (const field of ['lhid', 'lht', 'ds', 'da', 'vt'])
        compare(expected[field], disc[field], `discs[${id}].${field}`);
      compare(expected.ni === true, disc.ni, `discs[${id}].ni`);
      if (expected.ni) report.coverage.respawnTicks++;
      if (expected.lht > 0 && expected.lhid !== -1) report.coverage.discDiscContacts++;
    }
    if (actual.capZones.some((zone) => zone.p > 0 || zone.f !== -1)) report.coverage.captureProgressTicks++;
  }
  try {
    let native = oracle.createNewState(roster, map, 1, false, null, settings, true);
    native.rc = 0; // Match the static full-session oracle's initial rc presentation.
    session = createNativeMapSession({ map, players: roster, seed: 1, roundsToWin: 999, countdownTicks: 60 });
    const arena = nativeMapToArena(map);
    assert(arena.physics, 'Dynamic differential must use normalized unified-world physics');
    assert.equal(arena.platforms, undefined, 'Dynamic session must not own a second platform world');
    check(native);
    let previousMapX = native.physics.bodies[0]?.p[0];
    for (let tick = 1; tick <= ticks && report.firstMismatch === null; tick++) {
      report.ticks = tick;
      const previous = native;
      if (previous.ftu === -1) report.coverage.simulatedTicks++;
      const priorRound = native.rc;
      const input = inputsFor(name, tick);
      // Original prevState is sparse by native ID, exactly like the local input
      // record. Never compact IDs 2 and 7 into dense array positions.
      const nativeInputs = {};
      const localInputs = {};
      roster.forEach((player, index) => {
        nativeInputs[player.id] = bits(input[index]);
        localInputs[player.id] = input[index];
      });
      native = oracle.stepWithContactObserver(native, nativeInputs, null, 30, settings, 1, false, undefined);
      const contacts = oracle.consumeContactObservations();
      for (const contact of contacts) {
        const types = [contact.bodyA, contact.bodyB];
        if (types.includes('disc') && types.includes('phys')) report.coverage.discMapContacts++;
        if (types[0] === 'disc' && types[1] === 'disc') report.coverage.discDiscContacts++;
      }
      const result = session.stepWithEvents(localInputs);
      report.coverage.capZoneContacts += result.events.capZoneContacts.length;
      report.coverage.instantGoalTicks += result.events.capZoneTeamGoals.length;
      for (const death of result.events.deaths) report.coverage.deathCauses[death.m]++;
      if (native.fte >= 0) report.coverage.resultTicks++;
      if (native.rc !== priorRound) {
        report.coverage.rollovers++;
        report.coverage.postRolloverCountdowns.push(native.ftu);
      } else if (native.rc > 0 && previous.ftu === -1) report.coverage.postRolloverSimulationTicks++;
      if (native.physics.bodies[0] && native.physics.bodies[0].p[0] !== previousMapX) report.coverage.movingMapTicks++;
      previousMapX = native.physics.bodies[0]?.p[0];
      check(native);
    }
    if (!options.perturb) {
      if (report.ticks !== ticks)
        report.coverageFailures.push({ field: 'coverage.ticks', native: ticks, actual: report.ticks });
      if (ticks >= 70 && report.coverage.simulatedTicks === 0)
        report.coverageFailures.push({ field: 'coverage.simulatedTicks' });
      if (
        ticks >= 70 &&
        name === 'moving-platform' &&
        (report.coverage.discMapContacts === 0 || report.coverage.movingMapTicks === 0)
      )
        report.coverageFailures.push({ field: 'coverage.movingMap' });
      if (
        ticks >= 70 &&
        name === 'lethal-moving-fixture' &&
        (report.coverage.deathCauses[1] === 0 || report.coverage.respawnTicks === 0)
      )
        report.coverageFailures.push({ field: 'coverage.lethalRespawn' });
      if (ticks >= 70 && name === 'disc-contact' && report.coverage.discDiscContacts === 0)
        report.coverageFailures.push({ field: 'coverage.discContact' });
      if (
        ticks >= 130 &&
        name === 'timed-capture' &&
        (report.coverage.captureProgressTicks === 0 ||
          report.coverage.capZoneContacts === 0 ||
          report.coverage.deathCauses[3] === 0)
      )
        report.coverageFailures.push({ field: 'coverage.timedCapture' });
      if (
        ticks >= 70 &&
        name === 'instant-goal' &&
        (report.coverage.instantGoalTicks === 0 || report.coverage.deathCauses[3] === 0)
      )
        report.coverageFailures.push({ field: 'coverage.instantGoal' });
      if (
        ticks >= 70 &&
        name === 'out-of-bounds' &&
        (report.coverage.deathCauses[4] === 0 || report.coverage.respawnTicks === 0)
      )
        report.coverageFailures.push({ field: 'coverage.outOfBounds' });
      if (ticks >= 240 && ['timed-capture', 'instant-goal'].includes(name)) {
        if (report.coverage.rollovers === 0 || report.coverage.postRolloverSimulationTicks === 0)
          report.coverageFailures.push({ field: 'coverage.roundRollover' });
      }
      if (report.coverage.postRolloverCountdowns.some((ftu) => ftu !== 90))
        report.coverageFailures.push({
          field: 'coverage.rolloverCountdown',
          actual: report.coverage.postRolloverCountdowns,
        });
      for (const failure of report.coverageFailures) mismatch({ tick: report.ticks, ...failure });
    }
    report.originalProvenance = oracle.provenance;
    return report;
  } catch (error) {
    report.pass = false;
    report.status = 'ERROR';
    report.error = { message: error.message, stack: error.stack };
    if (report.firstMismatch === null)
      report.firstMismatch = { tick: report.ticks, error: error.stack || String(error) };
    return report;
  } finally {
    session?.dispose();
    oracle.dispose();
  }
}
function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = {
    ticks: DEFAULT_TICKS,
    output: null,
    negativeControl: false,
    negativeControlOnly: false,
    scenarioNames: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--negative-control' || arg === '--negative-control-only') {
      options.negativeControl = true;
      if (arg === '--negative-control-only') options.negativeControlOnly = true;
      continue;
    }
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[arg];
    if (key) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${arg} requires a file path`);
      values[key] = value;
      continue;
    }
    if (arg === '--ticks' || arg === '--out' || arg === '--scenario') {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${arg} requires a value`);
      if (arg === '--ticks') {
        options.ticks = Number(value);
        assert(
          Number.isSafeInteger(options.ticks) && options.ticks >= 1 && options.ticks <= 3600,
          '--ticks must be in [1, 3600]',
        );
      } else if (arg === '--out') options.output = path.resolve(cwd, value);
      else {
        const selected = value.replace(/-q[12]$/, '');
        assert(SCENARIOS.includes(selected), `Unknown scenario ${value}`);
        options.scenarioNames.push(value);
      }
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  assert(
    values.box2d && values.trig,
    'Required: --box2d <file> --safe-trig <file> (or reference path environment variables)',
  );
  return {
    paths: {
      rawPath: path.resolve(cwd, values.raw || path.join(ROOT, '.deobf/alpha2s.raw.js')),
      physicsPath: path.resolve(cwd, values.box2d),
      trigPath: path.resolve(cwd, values.trig),
    },
    ...options,
  };
}
function compareNativeDynamicSession(paths, options = {}) {
  const results = [];
  for (const quality of [1, 2])
    for (const name of SCENARIOS) {
      const reportName = `${name}-q${quality}`;
      const selected =
        !options.scenarioNames ||
        options.scenarioNames.length === 0 ||
        options.scenarioNames.includes(name) ||
        options.scenarioNames.includes(reportName);
      if (selected && !options.negativeControlOnly)
        results.push(runScenario(paths, name, options.ticks ?? DEFAULT_TICKS, quality));
    }
  let negativeControl = null;
  if (options.negativeControl) {
    negativeControl = runScenario(paths, 'moving-platform', 1, 1, { perturb: true });
    negativeControl.name = 'negative-control-injected-xv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch?.field === 'discs[2].xv' && negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
    negativeControl.status = negativeControl.pass ? 'PASS' : 'FAIL';
    delete negativeControl.error;
  }
  return {
    schema: 'bonk-rl-env.native-dynamic-session-original-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    localRepairOrReseeds: 0,
    scope:
      'Pinned original createNewState and step versus strict authored raw-map conversion and the complete native dynamic Classic session. Sparse IDs, countdown, scoring, death presentation, immediate respawn, capture, result delay, round rollover/reset, map physics, capZones, discs and lifecycle counters are compared at every tick. Neither side is manually reseeded or repaired; no separate map/disc solver is used. Active force zones and non-Classic modes remain outside scope.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localFiles: Object.fromEntries(LOCAL_FILES.map((file) => [file, digest(path.join(ROOT, file))])),
    },
    ticksPerScenario: options.ticks ?? DEFAULT_TICKS,
    scenarios: results,
    negativeControl,
    totals: {
      scenarios: results.length,
      ticks: results.reduce((sum, result) => sum + result.ticks, 0),
      frames: results.reduce((sum, result) => sum + result.frames, 0),
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
    console.log(
      'Usage: npx tsx validation/native/compare-native-dynamic-session.cjs --box2d <file> --safe-trig <file> [--scenario name[-q1|-q2]] [--ticks n] [--negative-control|--negative-control-only] [--out new-report.json]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Missing native dependency ${file}`);
  const report = compareNativeDynamicSession(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}
module.exports = {
  SCENARIOS,
  DEFAULT_TICKS,
  TOLERANCE,
  sessionMap,
  runScenario,
  parseArguments,
  compareNativeDynamicSession,
  main,
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
