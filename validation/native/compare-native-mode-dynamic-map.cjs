'use strict';

// Public BonkEnvironment with room gameSettings.mo sp/bs on a DYNAMIC native map
// (moving platform) versus the pinned original raw createNewState/step. This is
// the differential for coverage D4/D2: the unified dynamic world carries the
// room mode exactly as the original step reads gameSettings.mo (readable :7221
// via the settings argument). Map metadata m.mo stays display metadata.
// Original values are converted only at the documented native-world -> public
// map-pixel boundary. No local session/map helpers supply expected values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');

const ROOT = path.resolve(__dirname, '../..');
const TOLERANCE = 1e-9;
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bits = (value) => Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
const settingsFor = (map, mode) => ({
  ga: 'b',
  mo: mode,
  tea: false,
  bal: [0, 0],
  map,
  gt: 2,
  wl: 3,
  q: false,
  maps: [],
});
const MODE_ENERGY = { sp: 1000, bs: 1000 };
const SCOPE =
  'Public BonkEnvironment reset/step/getObservationFast with room gameSettings.mo sp/bs on a dynamic native map (kinematic moving platform) against pinned original raw dynamic states; only documented native-world to public map-pixel conversion. Covers Grapple fire/hold/release on a moving body, Grapple energy drain/recharge, Simple frozen energy and heavy-density exclusion on a dynamic map. No Arrow/VTOL/worker transport/online play or whole-game claim.';

function parseArguments(argv) {
  const paths = {
    rawPath: path.join(ROOT, '.deobf/alpha2s.raw.js'),
    physicsPath: undefined,
    trigPath: undefined,
  };
  let output = null;
  let negativeControl = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--negative-control') {
      negativeControl = true;
      continue;
    }
    assert(['--box2d', '--safe-trig', '--raw', '--out'].includes(arg), `Unknown argument: ${arg}`);
    const value = argv[++index];
    assert(value && !value.startsWith('--'), `${arg} requires a value`);
    if (arg === '--box2d') paths.physicsPath = path.resolve(value);
    else if (arg === '--safe-trig') paths.trigPath = path.resolve(value);
    else if (arg === '--raw') paths.rawPath = path.resolve(value);
    else output = path.resolve(value);
  }
  const missing = [paths.physicsPath, paths.trigPath].filter((file) => !file || !fs.existsSync(file));
  assert(missing.length === 0, `Original modified Box2D and SafeTrig are required: ${missing.join(', ')}`);
  return { paths, output, negativeControl };
}

// Dynamic map: a kinematic moving platform (native 'k' body with constant
// velocity) plus a static floor, mirroring the verified dynamic-session
// differential geometry so the original moving-body path is exercised.
function configureMap(scenario) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
  map.s.pq = scenario.quality;
  map.s.re = false;
  map.s.fl = false;
  map.s.nc = false;
  const common = { priority: 5, f: true, r: true, b: true, gr: false, ye: false, xv: 0, yv: 0 };
  map.spawns = [
    { ...common, n: 'Dynamic mode spawn 0', x: -60, y: -60 },
    { ...common, n: 'Dynamic mode spawn 1', x: -12, y: -60 },
  ];
  // Body 0 becomes a kinematic moving platform; body 1 stays the static floor.
  const template = map.physics.bodies[0];
  const fixtureTemplate = map.physics.fixtures[0];
  map.physics.fixtures[1] = { ...fixtureTemplate, sh: 0 };
  map.physics.bodies[0] = {
    ...template,
    s: { ...template.s, type: 'k' },
    p: [0, 60],
    lv: [0, 3],
    av: 0,
    a: 0,
    fx: [0],
  };
  map.physics.bodies[1] = {
    ...template,
    s: { ...template.s, type: 's' },
    p: [0, 144],
    lv: [0, 0],
    av: 0,
    a: 0,
    fx: [1],
  };
  map.physics.bro = [0, 1];
  map.physics.shapes[0].w = 240;
  map.physics.shapes[0].h = 24;
  return map;
}

function inputsFor(kind, tick) {
  // Grapple: hold action2 (bit 5 = 32) from tick 61 (after the 60-tick
  // countdown) for 60 ticks, then release to observe energy recharge.
  // Simple: hold heavy (bit 4 = 16) while moving to verify the frozen energy
  // and the heavy-density exclusion.
  if (kind === 'grapple-moving-body') {
    if (tick <= 60) return { 0: 0, 1: 0 };
    if (tick <= 120) return { 0: 32, 1: 0 };
    return { 0: 0, 1: 0 };
  }
  if (kind === 'simple-moving-body') {
    if (tick <= 60) return { 0: 0, 1: 0 };
    if (tick % 20 < 10) return { 0: 18, 1: 0 };
    return { 0: 16, 1: 0 };
  }
  return { 0: 0, 1: 0 };
}

const SCENARIOS = Object.freeze([
  ...['sp', 'bs'].flatMap((mode) =>
    [1, 2].map((quality) => ({
      name: `${mode === 'sp' ? 'grapple-moving-body' : 'simple-moving-body'}-public-${mode}-q${quality}`,
      mode,
      quality,
      kind: mode === 'sp' ? 'grapple-moving-body' : 'simple-moving-body',
      ticks: 300,
    })),
  ),
]);

function newCoverage() {
  return {
    simulatedTicks: 0,
    countdownTicks: 0,
    resultTicks: 0,
    deaths: 0,
    grappleAttachedTicks: 0,
    grappleEnergyDrained: false,
    grappleEnergyRecharged: false,
    movingBodyDisplacement: 0,
    simpleEnergyFrozen: true,
    simpleHeavyHeld: false,
    fastObservationTicks: 0,
  };
}

function coverageFailures(scenario, coverage, frames) {
  const failures = [];
  if (frames < 60) failures.push(`only ${frames} frames`);
  if (coverage.simulatedTicks < 90) failures.push(`only ${coverage.simulatedTicks} simulated ticks`);
  if (coverage.countdownTicks < 30) failures.push(`only ${coverage.countdownTicks} countdown ticks`);
  if (coverage.movingBodyDisplacement < 5) failures.push(`moving body moved only ${coverage.movingBodyDisplacement}`);
  if (scenario.mode === 'sp') {
    if (coverage.grappleAttachedTicks < 50)
      failures.push(`grapple attached only ${coverage.grappleAttachedTicks} ticks`);
    if (!coverage.grappleEnergyDrained) failures.push('grapple energy never drained');
    if (!coverage.grappleEnergyRecharged) failures.push('grapple energy never recharged');
  }
  if (scenario.mode === 'bs') {
    if (!coverage.simpleEnergyFrozen) failures.push('simple energy not frozen');
    if (!coverage.simpleHeavyHeld) failures.push('simple heavy never held');
  }
  return failures;
}

function runScenario(paths, scenario, perturb = false) {
  const { BonkEnvironment } = require('../../src/core/environment.ts');
  const oracle = createOracle(paths);
  let env;
  const report = {
    name: scenario.name,
    kind: scenario.kind,
    mode: scenario.mode,
    quality: scenario.quality,
    ticks: scenario.ticks,
    frames: 0,
    comparisons: 0,
    numericComparisons: 0,
    discreteComparisons: 0,
    maxError: 0,
    firstMismatch: null,
    mismatches: [],
    coverage: newCoverage(),
    coverageFailures: [],
    pass: true,
  };
  const mismatch = (entry) => {
    if (report.firstMismatch === null) report.firstMismatch = entry;
    if (report.mismatches.length < 20) report.mismatches.push(entry);
    report.pass = false;
  };
  const discrete = (tick, entity, id, field, actual, expected) => {
    report.comparisons++;
    report.discreteComparisons++;
    if (!Object.is(actual, expected)) mismatch({ tick, entity, id, field, actual, native: expected });
  };
  const numeric = (tick, entity, id, field, actual, expected) => {
    report.comparisons++;
    report.numericComparisons++;
    const error = Math.abs(actual - expected);
    report.maxError = Math.max(report.maxError, Number.isFinite(error) ? error : 0);
    if (!Number.isFinite(error) || error > TOLERANCE)
      mismatch({ tick, entity, id, field, actual, native: expected, error });
  };
  let lastLiveHeavy = [false, false];
  const check = (tick, observation, info, native, sessionState) => {
    report.frames++;
    const ppm = native.physics.ppm;
    const conversion = (value) => ({
      x: value.x * ppm - 365,
      y: value.y * ppm - 250,
      xv: value.xv * ppm,
      yv: value.yv * ppm,
    });
    const expectedAI = native.discDeaths.find((death) => death.i === 0 && death.f === 0) ?? native.discs[0];
    const expectedOpponent = native.discDeaths.find((death) => death.i === 1 && death.f === 0) ?? native.discs[1];
    for (const [id, actual, source] of [
      [
        0,
        { x: observation.playerX, y: observation.playerY, xv: observation.playerVelX, yv: observation.playerVelY },
        expectedAI,
      ],
      [
        1,
        {
          x: observation.opponents[0].x,
          y: observation.opponents[0].y,
          xv: observation.opponents[0].velX,
          yv: observation.opponents[0].velY,
        },
        expectedOpponent,
      ],
    ]) {
      if (!source) continue;
      const expected = conversion(source);
      for (const field of ['x', 'y', 'xv', 'yv']) {
        let actualValue = actual[field];
        if (perturb && tick === 1 && id === 0 && field === 'xv') actualValue += 1e-6;
        numeric(tick, 'disc', id, field, actualValue, expected[field]);
      }
      // The public death view freezes the outgoing disc's heavy state; the
      // original death record carries no a1. Track the last-live heavy flag
      // and compare the frozen public view against it after elimination,
      // exactly like the verified static mode-environment comparator's
      // death-record presentation seam.
      for (let id = 0; id < 2; id++) if (native.discs[id]) lastLiveHeavy[id] = native.discs[id].a1;
      const expectedHeavy = lastLiveHeavy[id];
      discrete(
        tick,
        'disc',
        id,
        'heavy',
        id === 0 ? observation.playerIsHeavy : observation.opponents[0].isHeavy,
        expectedHeavy,
      );
    }
    // Moving-body displacement: the kinematic platform's world position must
    // track the original physics body exactly (public platforms are exposed
    // through the session arena state only in the original; compare via the
    // disc resting on it indirectly through the observation above, and track
    // the original body for coverage).
    if (native.fte >= 0) report.coverage.resultTicks++;
    for (const death of native.discDeaths) if (death.f === 0) report.coverage.deaths++;
    if (native.discs[0]) numeric(tick, 'disc', 0, 'energy', sessionState.discs[0]?.energy, native.discs[0].a1a);
    if (native.discs[1]) numeric(tick, 'disc', 1, 'energy', sessionState.discs[1]?.energy, native.discs[1].a1a);
    discrete(
      tick,
      'projectiles',
      null,
      'length',
      sessionState.projectiles?.length ?? 0,
      native.projectiles?.length ?? 0,
    );
    discrete(tick, 'state', null, 'tick', observation.tick, tick);
    discrete(tick, 'arena', null, 'halfWidth', observation.arenaHalfWidth, 365);
    discrete(tick, 'arena', null, 'halfHeight', observation.arenaHalfHeight, 250);
    const fast = Array.from(env.getObservationFast());
    const flat = [
      observation.playerX,
      observation.playerY,
      observation.playerVelX,
      observation.playerVelY,
      observation.playerAngle,
      observation.playerAngularVel,
      observation.playerIsHeavy ? 1 : 0,
      observation.opponents[0].x,
      observation.opponents[0].y,
      observation.opponents[0].velX,
      observation.opponents[0].velY,
      observation.opponents[0].isHeavy ? 1 : 0,
      observation.opponents[0].alive ? 1 : 0,
      observation.arenaHalfWidth,
      observation.arenaHalfHeight,
      observation.tick,
    ];
    for (let index = 0; index < flat.length; index++) {
      report.comparisons++;
      if (fast[index] !== Math.fround(flat[index]))
        mismatch({
          tick,
          entity: 'fastObservation',
          id: index,
          field: 'value',
          actual: fast[index],
          expected: Math.fround(flat[index]),
        });
    }
    report.coverage.fastObservationTicks++;
    if (info) {
      discrete(tick, 'state', null, 'infoTick', info.tick, tick);
      discrete(tick, 'state', null, 'nativeRoundTick', info.nativeRoundTick, native.rl);
      discrete(
        tick,
        'state',
        null,
        'nativePhase',
        info.nativePhase,
        native.fte >= 0 ? 'round-result' : native.ftu === -1 ? 'active' : 'countdown',
      );
      discrete(tick, 'state', null, 'nativeMode', info.nativeMode, scenario.mode);
      discrete(tick, 'state', null, 'nativeFlag', info.native, true);
    }
    if (native.ftu >= 0 && native.ftu !== -1) report.coverage.countdownTicks++;
    if (native.ftu === -1 && native.fte < 0) report.coverage.simulatedTicks++;
    // Grapple coverage: swing attached while energy drains and recharges.
    if (scenario.mode === 'sp') {
      const disc = native.discs[0];
      if (disc && disc.swing) report.coverage.grappleAttachedTicks++;
      if (disc && disc.a1a < 1000) report.coverage.grappleEnergyDrained = true;
      if (report.coverage.grappleEnergyDrained && disc && disc.a1a === 1000)
        report.coverage.grappleEnergyRecharged = true;
    }
    if (scenario.mode === 'bs') {
      const disc = native.discs[0];
      if (disc && disc.a1a !== 1000) report.coverage.simpleEnergyFrozen = false;
      if (disc && disc.a1) report.coverage.simpleHeavyHeld = true;
    }
  };
  try {
    const map = configureMap(scenario);
    const roster = [
      { id: 0, team: 1 },
      { id: 1, team: 1 },
    ];
    const settings = settingsFor(map, scenario.mode);
    let native = oracle.createNewState(roster, clone(map), 1, false, null, settings, true);
    native.rc = 0;
    const initialBodyY = native.physics.bodies[0] ? native.physics.bodies[0].p[1] : 0;
    env = new BonkEnvironment({
      mapData: clone(map),
      nativeMode: scenario.mode,
      numOpponents: 1,
      seed: 1,
      randomOpponent: false,
      oppGrappleProb: 0,
      maxTicks: 100000,
      countdownTicks: 60,
    });
    let observation = env.reset();
    let info = null;
    check(0, observation, null, native, env.nativeSession.getState());
    for (let tick = 1; tick <= scenario.ticks && report.firstMismatch === null; tick++) {
      const inputs = inputsFor(scenario.kind, tick);
      native = oracle.step(native, { 0: bits(inputs[0]), 1: bits(inputs[1]) }, null, 30, settings, 1, false, undefined);
      if (native.physics.bodies[0]) {
        report.coverage.movingBodyDisplacement = Math.max(
          report.coverage.movingBodyDisplacement,
          Math.abs(native.physics.bodies[0].p[1] - initialBodyY),
        );
      }
      const result = env.step(inputs[0]);
      observation = result.observation;
      info = result.info;
      check(tick, observation, info, native, env.nativeSession.getState());
      if (result.done) break;
    }
    if (!perturb) {
      report.coverageFailures = coverageFailures(scenario, report.coverage, report.frames);
      for (const failure of report.coverageFailures)
        mismatch({ tick: report.frames - 1, field: 'coverage', actual: failure });
    }
    report.pass = report.firstMismatch === null;
    return report;
  } catch (error) {
    report.pass = false;
    report.error = { message: error.message, stack: error.stack };
    return report;
  } finally {
    env?.close();
    oracle.dispose();
  }
}

function main(argv) {
  const { paths, output, negativeControl } = parseArguments(argv);
  if (output) assert(!fs.existsSync(output), `Output already exists: ${output}`);
  const scenarios = SCENARIOS.map((scenario) => runScenario(paths, scenario));
  const control = negativeControl
    ? runScenario(
        paths,
        SCENARIOS.find((s) => s.mode === 'sp' && s.quality === 1),
        true,
      )
    : null;
  if (control) {
    control.detected = control.firstMismatch?.field === 'xv' && control.firstMismatch.error > TOLERANCE;
    control.pass = control.detected;
  }
  const report = {
    schema: 'bonk-rl-env.native-mode-dynamic-map-environment-differential',
    version: 1,
    pass: scenarios.every((scenario) => scenario.pass) && (!control || control.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    scope: SCOPE,
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      environmentSha256: digest(path.join(ROOT, 'src/core/environment.ts')),
      nativeMapSessionSha256: digest(path.join(ROOT, 'src/core/native-map-session.ts')),
      nativeSessionSha256: digest(path.join(ROOT, 'src/core/native-session.ts')),
      nativeModeSessionSha256: digest(path.join(ROOT, 'src/core/native-mode-session.ts')),
      nativeClassicWorldSha256: digest(path.join(ROOT, 'src/core/native-classic-world.ts')),
    },
    scenarios,
    negativeControl: control,
    totals: {
      scenarios: scenarios.length,
      frames: scenarios.reduce((sum, scenario) => sum + scenario.frames, 0),
      comparisons: scenarios.reduce((sum, scenario) => sum + scenario.comparisons, 0),
      numericComparisons: scenarios.reduce((sum, scenario) => sum + scenario.numericComparisons, 0),
      discreteComparisons: scenarios.reduce((sum, scenario) => sum + scenario.discreteComparisons, 0),
      maximumAbsoluteError: scenarios.reduce((maximum, scenario) => Math.max(maximum, scenario.maxError), 0),
      coverageFailures: scenarios.reduce((sum, scenario) => sum + (scenario.coverageFailures?.length || 0), 0),
    },
  };
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    console.log(
      JSON.stringify(
        {
          pass: report.pass,
          totals: report.totals,
          failures: report.scenarios
            .filter((scenario) => !scenario.pass)
            .map((scenario) => ({
              name: scenario.name,
              error: scenario.error,
              firstMismatch: scenario.firstMismatch,
              coverageFailures: scenario.coverageFailures,
            })),
          negativeControlDetected: report.negativeControl?.detected,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.pass ? 0 : 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { SCENARIOS, SCOPE, TOLERANCE, configureMap, inputsFor, coverageFailures, runScenario, main };
