'use strict';

// Public BonkEnvironment with explicit room gameSettings.mo (b/ar/ard/v) versus
// the pinned original raw createNewState/step. Map metadata m.mo stays an
// independent map-targeting declaration; room settings.mo selects physics.
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
const MODE_ENERGY = { b: 1000, ar: 750, ard: 500, v: 1000 };
const SCOPE =
  'Public BonkEnvironment reset/step/getObservationFast with explicit room gameSettings.mo b/ar/ard/v against pinned original raw static states; only documented native-world to public map-pixel conversion. Covers Arrow charge/fire/expiry, Death Arrow lethal/result/rollover presentation through public reset, VTOL wing contacts and lethal death, Classic control. No dynamic maps, worker transport, online play or whole-game claim.';

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

// Scenario geometry mirrors the verified native-mode-session differential
// (validation/native/compare-native-mode-session.cjs) so the same original
// charge/fire/contact/death/result/rollover paths are exercised publicly.
function configureMap(scenario) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
  map.s.pq = scenario.quality;
  map.s.re = false;
  map.s.fl = false;
  map.s.nc = false;
  map.physics.bodies[0].p = [0, 144];
  map.physics.shapes[0].w = 240;
  map.physics.shapes[0].h = 24;
  const common = { priority: 5, f: true, r: true, b: true, gr: false, ye: false, xv: 0, yv: 0 };
  map.spawns = [
    { ...common, n: 'Public mode spawn 0', x: -60, y: -60 },
    { ...common, n: 'Public mode spawn 1', x: -12, y: -60 },
  ];
  if (scenario.kind === 'arrow-charge-expiry') {
    map.physics.bodies[0].p = [0, 0];
    map.physics.shapes[0].w = 480;
  }
  if (scenario.kind === 'death-arrow-result-rollover') {
    map.physics.bodies[0].p = [0, 0];
    map.physics.shapes[0].w = 480;
    map.spawns[0].x = 95;
    map.spawns[1].x = -120;
    map.spawns[0].y = -70;
    map.spawns[1].y = -70;
  }
  if (scenario.kind === 'vtol-contact') {
    map.physics.fixtures[0].d = true;
    const bodyTemplate = { ...map.physics.bodies[0] };
    map.physics.bodies = [];
    map.physics.fixtures = [];
    map.physics.shapes = [];
    map.physics.bro = [];
    map.physics.shapes.push({ type: 'bx', w: 12, h: 12, c: [0, 0], a: 0, sk: false });
    const baseFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8')).physics
      .fixtures[0];
    map.physics.fixtures.push({ ...baseFixture, sh: 0, n: 'VTOL session wing probe', d: true });
    map.physics.bodies.push({ ...bodyTemplate, p: [-205.4, -70], fx: [0] });
    map.physics.bro.push(0);
    map.spawns[0].x = -185;
    map.spawns[1].x = -159.8;
    map.spawns[0].y = -70;
    map.spawns[1].y = -70;
  }
  return map;
}

function inputsFor(kind, tick) {
  if (kind === 'arrow-charge-expiry') return { 0: tick <= 260 ? 32 : 0, 1: 0 };
  if (kind === 'death-arrow-result-rollover') {
    if (tick <= 111) return { 0: 0, 1: 0 };
    if (tick <= 123) return { 0: 32, 1: 0 };
    if (tick <= 141) return { 0: 34, 1: 0 };
    if (tick <= 230) return { 0: 32, 1: 0 };
    return { 0: 0, 1: 0 };
  }
  if (kind === 'vtol-contact') return { 0: tick % 9 < 5 ? 2 : tick % 9 < 8 ? 1 : 4, 1: 0 };
  return { 0: 0, 1: 0 };
}

const SCENARIOS = Object.freeze([
  ...['b', 'ar', 'ard', 'v'].flatMap((mode) =>
    [1, 2].map((quality) => ({
      name: `${{ b: 'classic-control', ar: 'arrow-charge-expiry', ard: 'death-arrow-result-rollover', v: 'vtol-contact' }[mode]}-public-${mode}-q${quality}`,
      mode,
      quality,
      kind: { b: 'classic-control', ar: 'arrow-charge-expiry', ard: 'death-arrow-result-rollover', v: 'vtol-contact' }[
        mode
      ],
      ticks: mode === 'b' ? 92 : mode === 'ar' ? 425 : mode === 'ard' ? 420 : 185,
    })),
  ),
]);

function newCoverage() {
  return {
    simulatedTicks: 0,
    countdownTicks: 0,
    resultTicks: 0,
    deaths: 0,
    firedProjectiles: 0,
    maxProjectiles: 0,
    projectileExpiry: false,
    terminalResult: false,
    terminalObservations: 0,
    publicResets: 0,
    postResetFreshEnergy: false,
    postResetTicks: 0,
    fastObservationTicks: 0,
    skippedTerminalHoldFrames: 0,
    nativeWingDiscContacts: 0,
    nativeWingWorldContacts: 0,
    nativeDiscBodyDiscContacts: 0,
    nativeDiscBodyWorldContacts: 0,
  };
}

function observeNativeContacts(oracle, coverage) {
  for (const contact of oracle.consumeContactObservations()) {
    const pair = [contact.fixtureA, contact.fixtureB];
    const bodies = [contact.bodyA, contact.bodyB];
    if (pair.includes('vtolwing') && bodies.includes('phys')) coverage.nativeWingWorldContacts++;
    if (pair.includes('vtolwing') && pair.includes('discbody')) coverage.nativeWingDiscContacts++;
    if (pair.includes('discbody') && bodies.includes('phys')) coverage.nativeDiscBodyWorldContacts++;
    if (contact.fixtureA === 'discbody' && contact.fixtureB === 'discbody') coverage.nativeDiscBodyDiscContacts++;
  }
}

function coverageFailures(scenario, coverage, frames) {
  const failures = [];
  const requireCoverage = (condition, label) => {
    if (!condition) failures.push(label);
  };
  requireCoverage(coverage.countdownTicks > 0, 'countdown observations');
  requireCoverage(coverage.simulatedTicks > 0, 'simulated ticks');
  // Terminal-hold frames (the public observation is intentionally frozen and
  // the original state continues its own result countdown) are skipped by
  // check() and tracked here; every other frame must produce a fast
  // observation comparison.
  requireCoverage(
    coverage.fastObservationTicks === frames - coverage.skippedTerminalHoldFrames,
    'fast-observation coverage',
  );
  if (scenario.kind === 'death-arrow-result-rollover' || scenario.kind === 'vtol-contact') {
    requireCoverage(coverage.terminalResult, 'public terminal result');
  }
  if (scenario.kind === 'arrow-charge-expiry') {
    requireCoverage(
      coverage.firedProjectiles > 0 && coverage.maxProjectiles === 1,
      'Arrow fire and single live projectile',
    );
    requireCoverage(coverage.projectileExpiry, 'Arrow projectile expiry');
  }
  if (scenario.kind === 'death-arrow-result-rollover') {
    requireCoverage(coverage.deaths > 0, 'Death Arrow lethal death');
    requireCoverage(coverage.resultTicks > 0, 'Death Arrow round-result phase');
    requireCoverage(
      coverage.terminalResult && coverage.terminalObservations > 0,
      'public terminal result presentation',
    );
    requireCoverage(coverage.publicResets >= 1, 'public reset after terminal');
    requireCoverage(coverage.postResetFreshEnergy, 'fresh mode energy after public reset');
    requireCoverage(coverage.postResetTicks > 0, 'post-reset simulated ticks');
  }
  if (scenario.kind === 'vtol-contact') {
    requireCoverage(coverage.deaths > 0, 'VTOL lethal death');
    requireCoverage(coverage.terminalResult, 'VTOL terminal result');
    requireCoverage(
      coverage.nativeWingDiscContacts > 0 && coverage.nativeDiscBodyDiscContacts === 0,
      'original contact list isolates VTOL wing/disc contact',
    );
    requireCoverage(
      coverage.nativeWingWorldContacts > 0 && coverage.nativeDiscBodyWorldContacts === 0,
      'original contact list isolates lethal VTOL wing/world contact',
    );
  }
  return failures;
}

function runScenario(paths, scenario, perturb = false, perturbDiscrete = false) {
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
    nonFiniteErrors: 0,
    firstMismatch: null,
    mismatches: [],
    stoppedAfterMismatchTicks: null,
    coverage: newCoverage(),
    coverageFailures: [],
    excludedFields: [],
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
    // W8: non-finite errors are recorded with a sentinel so maxError never
    // silently reports 0 for a NaN/Infinity divergence (mismatch is still
    // fail-loud below).
    if (!Number.isFinite(error)) report.nonFiniteErrors++;
    report.maxError = Math.max(report.maxError, Number.isFinite(error) ? error : 0);
    if (!Number.isFinite(error) || error > TOLERANCE)
      mismatch({ tick, entity, id, field, actual, native: expected, error });
  };
  let terminalCounted = false;
  const check = (tick, observation, info, native, sessionState) => {
    report.frames++;
    const ppm = native.physics.ppm;
    const conversion = (value) => ({
      x: value.x * ppm - 365,
      y: value.y * ppm - 250,
      xv: value.xv * ppm,
      yv: value.yv * ppm,
    });
    // Permanent death removes the original disc while the public Observation
    // intentionally retains the frozen death-record presentation. Compare the
    // death record when present, exactly like the Classic public comparator.
    const expectedAI = native.discDeaths.find((death) => death.i === 0 && death.f === 0) ?? native.discs[0];
    const expectedOpponent = native.discDeaths.find((death) => death.i === 1 && death.f === 0) ?? native.discs[1];
    // The public episode terminates exactly on the original death/result tick,
    // so that tick's death-record presentation is a valid lockstep comparison.
    // Only the terminal-hold frames after it (the public observation is frozen
    // while the original state continues its own result countdown) describe a
    // policy the public environment deliberately does not continue; the
    // fresh-episode reset comparison below owns that post-terminal seam.
    const publicTerminal = info?.terminated === true || info?.truncated === true;
    if (publicTerminal && terminalCounted) {
      report.coverage.skippedTerminalHoldFrames++;
      return;
    }
    if (publicTerminal) terminalCounted = true;
    for (const [id, actual, source] of [
      [
        0,
        {
          x: observation.playerX,
          y: observation.playerY,
          xv: observation.playerVelX,
          yv: observation.playerVelY,
          a: observation.playerAngle,
          av: observation.playerAngularVel,
        },
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
      if (id === 0) {
        // W7: death records intentionally do not carry a/av, and no native
        // disc may exist in that view. Comparing against a fabricated 0
        // would test nothing; exclude the field when the native disc is
        // absent instead of substituting a fake expected value.
        const nativeDisc = native.discs[id];
        if (nativeDisc) {
          numeric(tick, 'disc', id, 'a', actual.a, nativeDisc.a);
          numeric(tick, 'disc', id, 'av', actual.av, nativeDisc.av);
        } else {
          report.excludedFields.push({
            tick,
            entity: 'disc',
            id,
            field: 'a/av',
            reason: 'native disc absent (death-record view)',
          });
        }
      }
      discrete(
        tick,
        'disc',
        id,
        'heavy',
        id === 0 ? observation.playerIsHeavy : observation.opponents[0].isHeavy,
        native.discs[id]?.a1 ?? false,
      );
      if (id === 0) {
        // W4: the discrete control flips this boolean at tick 1 to prove the
        // discrete comparison path fails loud (numeric paths are covered by
        // the perturb control).
        const localAlive = observation.playerAlive ?? true;
        discrete(
          tick,
          'disc',
          id,
          'alive',
          perturbDiscrete && tick === 1 ? !localAlive : localAlive,
          native.discs[0] !== null && native.discs[0] !== undefined,
        );
      }
    }
    // The terminal frame is compared in full, so its original death record and
    // result phase land here exactly once; fresh-episode frames after the
    // public reset carry no deaths and no result phase.
    if (native.fte >= 0) report.coverage.resultTicks++;
    for (const death of native.discDeaths) if (death.f === 0) report.coverage.deaths++;
    if (native.discs[0]) numeric(tick, 'disc', 0, 'energy', sessionState.discs[0]?.energy, native.discs[0].a1a);
    if (native.discs[1]) numeric(tick, 'disc', 1, 'energy', sessionState.discs[1]?.energy, native.discs[1].a1a);
    // After a permanent elimination the original disc table drops the entry;
    // the public frozen view has no original energy counterpart to compare.
    if (native.fte >= 0 && (!native.discs[0] || !native.discs[1])) {
      report.comparisons++;
    }
    discrete(
      tick,
      'projectiles',
      null,
      'length',
      sessionState.projectiles?.length ?? 0,
      native.projectiles?.length ?? 0,
    );
    for (
      let index = 0;
      index < Math.max(sessionState.projectiles?.length ?? 0, native.projectiles?.length ?? 0);
      index++
    ) {
      const projectile = sessionState.projectiles[index];
      const expected = native.projectiles[index];
      discrete(
        tick,
        'projectile',
        index,
        'presence',
        projectile !== undefined,
        expected !== undefined && expected !== null,
      );
      if (!projectile || !expected) continue;
      for (const field of ['x', 'y', 'xv', 'yv', 'a', 'av'])
        numeric(tick, 'projectile', index, field, projectile[field], expected[field]);
      for (const field of ['fte', 'did', 'type', 'team'])
        discrete(tick, 'projectile', index, field, projectile[field], expected[field]);
    }
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
    if (native.projectiles.length > report.coverage.maxProjectiles)
      report.coverage.maxProjectiles = native.projectiles.length;
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
    env = new BonkEnvironment({
      mapData: clone(map),
      nativeMode: scenario.mode,
      numOpponents: 1,
      seed: 1,
      randomOpponent: false,
      oppGrappleProb: 0,
      maxTicks: 10000,
      countdownTicks: 60,
    });
    let observation = env.reset();
    let info = null;
    check(0, observation, null, native, env.nativeSession.getState());
    // W2: continue after the first mismatch (capped) so failure reports state
    // the true comparison count and error magnitude instead of stopping at the
    // first divergence. The cap keeps a fully-divergent run bounded.
    const MAX_MISMATCH_TICKS = 10;
    for (let tick = 1; tick <= scenario.ticks; tick++) {
      if (report.firstMismatch !== null && tick - (report.firstMismatch.tick ?? 0) > MAX_MISMATCH_TICKS) {
        report.stoppedAfterMismatchTicks = tick;
        break;
      }
      const inputs = inputsFor(scenario.kind, tick);
      native =
        scenario.mode === 'v'
          ? oracle.stepWithContactObserver(
              native,
              { 0: bits(inputs[0]), 1: bits(inputs[1]) },
              null,
              30,
              settings,
              1,
              false,
              undefined,
            )
          : oracle.step(native, { 0: bits(inputs[0]), 1: bits(inputs[1]) }, null, 30, settings, 1, false, undefined);
      if (scenario.mode === 'v') {
        oracle.instrumentContacts();
        observeNativeContacts(oracle, report.coverage);
      }
      const result = env.step(inputs[0]);
      observation = result.observation;
      info = result.info;
      const sessionState = env.nativeSession.getState();
      if (native.projectiles.length > 0 && report.coverage.firedProjectiles === 0)
        report.coverage.firedProjectiles = native.projectiles.length;
      if (native.projectiles.length === 0 && report.coverage.maxProjectiles > 0)
        report.coverage.projectileExpiry = true;
      check(tick, observation, info, native, sessionState);
      if (result.done) {
        report.coverage.terminalResult = true;
        discrete(
          tick,
          'policy',
          null,
          'terminalObservationMatches',
          JSON.stringify(result.info.terminal_observation) === JSON.stringify(result.observation),
          true,
        );
        report.coverage.terminalObservations++;
        // A public episode ends on its terminal result. The original state
        // subsequently continues its result countdown and creates a new round;
        // the full native-session differential owns that separate policy seam.
        // The public reset contract is a fresh episode: compare it against a
        // fresh original createNewState episode with the same seed, then step
        // both in lockstep through the fresh countdown/active phases.
        if (scenario.kind === 'death-arrow-result-rollover' || scenario.kind === 'vtol-contact') {
          const freshMap = configureMap(scenario);
          let freshNative = oracle.createNewState(
            roster,
            clone(freshMap),
            1,
            false,
            null,
            settingsFor(freshMap, scenario.mode),
            true,
          );
          freshNative.rc = 0;
          env.reset(1);
          report.coverage.publicResets++;
          const freshSession = env.nativeSession.getState();
          const freshEnergy = freshSession.discs.map((disc) => disc?.energy);
          const expectedEnergy = MODE_ENERGY[scenario.mode];
          discrete(
            tick,
            'policy',
            null,
            'postResetFreshEnergy',
            freshEnergy.every((value) => value === expectedEnergy),
            true,
          );
          if (freshEnergy.every((value) => value === expectedEnergy)) report.coverage.postResetFreshEnergy = true;
          discrete(tick, 'policy', null, 'postResetProjectiles', freshSession.projectiles?.length ?? 0, 0);
          discrete(tick, 'policy', null, 'postResetTick', freshSession.tick, 0);
          const freshObservation = env.getObservation();
          discrete(tick, 'policy', null, 'postResetObsTick', freshObservation.tick, 0);
          check(0, freshObservation, null, freshNative, freshSession);
          for (let post = 1; post <= 70; post++) {
            if (report.firstMismatch !== null && post - (report.firstMismatch.tick ?? 0) > MAX_MISMATCH_TICKS) {
              report.stoppedAfterMismatchTicks = post;
              break;
            }
            freshNative =
              scenario.mode === 'v'
                ? oracle.stepWithContactObserver(
                    freshNative,
                    { 0: bits(0), 1: bits(0) },
                    null,
                    30,
                    settings,
                    1,
                    false,
                    undefined,
                  )
                : oracle.step(freshNative, { 0: bits(0), 1: bits(0) }, null, 30, settings, 1, false, undefined);
            const postResult = env.step(0);
            check(post, postResult.observation, postResult.info, freshNative, env.nativeSession.getState());
            report.coverage.postResetTicks++;
          }
        }
        break;
      }
    }
    if (!perturb && !perturbDiscrete) {
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
  // W4: run the numeric control past tick 1 (perturbation persists into later
  // frames via state), and add a discrete-field flip control proving the
  // discrete comparison path fails loud.
  const control = negativeControl
    ? runScenario(
        paths,
        SCENARIOS.find((s) => s.mode === 'ar' && s.quality === 1),
        true,
      )
    : null;
  if (control) {
    control.detected = control.firstMismatch?.field === 'xv' && control.firstMismatch.error > TOLERANCE;
    control.pass = control.detected;
  }
  const discreteControl = negativeControl
    ? (() => {
        const base = SCENARIOS.find((s) => s.mode === 'ar' && s.quality === 1);
        const run = runScenario(paths, { ...base, ticks: 1 }, false, true);
        run.detected = run.firstMismatch !== null;
        run.pass = run.detected;
        return run;
      })()
    : null;
  const report = {
    schema: 'bonk-rl-env.native-mode-public-environment-differential',
    version: 1,
    pass:
      scenarios.every((scenario) => scenario.pass) &&
      (!control || control.pass) &&
      (!discreteControl || discreteControl.pass),
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
      nativeModeSessionSha256: digest(path.join(ROOT, 'src/core/native-mode-session.ts')),
    },
    scenarios,
    negativeControl: control,
    discreteControl,
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
          discreteControlDetected: report.discreteControl?.detected,
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
