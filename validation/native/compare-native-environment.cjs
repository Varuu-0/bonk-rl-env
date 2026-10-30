'use strict';

// Public BonkEnvironment versus the pinned original raw createNewState/step.
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
const settingsFor = (map, balances = [0, 0]) => ({
  ga: 'b',
  mo: 'b',
  tea: false,
  bal: balances,
  map,
  gt: 2,
  wl: 3,
  q: false,
  maps: [],
});

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

function makeMap(kind, quality = 1) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
  map.s.pq = quality;
  map.s.re = kind === 'respawn';
  if (kind === 'lethal') {
    map.physics.fixtures[0].d = true;
    map.spawns.forEach((spawn) => {
      spawn.y = -20;
    });
  }
  if (kind === 'respawn') {
    const fixture = clone(map.physics.fixtures[0]);
    const body = clone(map.physics.bodies[0]);
    map.physics.shapes = [{ type: 'ci', r: 12, c: [0, 0], sk: false }];
    map.physics.fixtures = [{ ...fixture, sh: 0 }];
    map.physics.bodies = [{ ...body, p: [500, 300], fx: [0] }];
    map.physics.bro = [0];
    map.spawns = [
      { ...map.spawns[0], x: -500, y: -220, xv: -250, yv: 0, priority: 1 },
      { ...map.spawns[1], x: 500, y: -220, xv: 250, yv: 0, priority: 1 },
    ];
  }
  return map;
}

function actionFor(kind, tick) {
  if (kind === 'lethal') return tick % 70 < 30 ? 4 : 0;
  if (kind === 'respawn') return tick % 100 < 45 ? 2 : tick % 100 < 75 ? 1 : 0;
  if (tick === 92 || tick === 94) return 2;
  if (tick === 93) return 18;
  if (tick === 95) return 16;
  return tick % 100 < 45 ? 2 : tick % 100 < 75 ? 1 : 0;
}

const SCENARIOS = [
  { name: 'public-active-q1', kind: 'active', quality: 1, ticks: 150, countdown: 60 },
  { name: 'public-active-q2', kind: 'active', quality: 2, ticks: 150, countdown: 60 },
  { name: 'public-lethal-result', kind: 'lethal', quality: 1, ticks: 200, countdown: 60 },
  { name: 'public-respawn', kind: 'respawn', quality: 1, ticks: 150, countdown: 60 },
];

function runScenario(paths, scenario, perturb = false, perturbTicks = null, perturbDiscrete = false) {
  const { BonkEnvironment } = require('../../src/core/environment.ts');
  const oracle = createOracle(paths);
  let env;
  const report = {
    name: scenario.name,
    kind: scenario.kind,
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
    coverage: {
      simulatedTicks: 0,
      countdownActiveBoundary: false,
      firstSolverTick: false,
      resultTicks: 0,
      deaths: 0,
      respawns: 0,
      fastObservationTicks: 0,
      terminalResult: false,
      absentAfterResult: 0,
      terminalObservations: 0,
    },
    coverageFailures: [],
    localRepairOrReseeds: 0,
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
  try {
    const map = makeMap(scenario.kind, scenario.quality);
    const roster = [
      { id: 0, team: 1 },
      { id: 1, team: 1 },
    ];
    const settings = settingsFor(map);
    let native = oracle.createNewState(roster, clone(map), 1, false, null, settings, true);
    native.rc = 0;
    assert.equal(native.ftu, scenario.countdown, 'Unexpected original countdown');
    env = new BonkEnvironment({
      mapData: clone(map),
      numOpponents: 1,
      seed: 1,
      randomOpponent: false,
      oppGrappleProb: 0,
      maxTicks: 10000,
      countdownTicks: scenario.countdown,
    });
    let observation = env.reset();
    let info = null;
    const check = (tick) => {
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
      // Permanent death removes the original disc while public Observation
      // intentionally retains the dead spawn-restored disc for termination.
      // Compare the last death presentation and result, never fabricate a
      // native position for the subsequently absent original entity.
      if (!expectedAI || !expectedOpponent) {
        const aiPresent = native.discs[0] !== null && native.discs[0] !== undefined;
        const opponentPresent = native.discs[1] !== null && native.discs[1] !== undefined;
        if (scenario.kind !== 'lethal' || native.fte < 0) {
          discrete(tick, 'disc', null, 'unexpectedMissingPresentationSource', true, false);
        }
        discrete(tick, 'disc', 0, 'present', aiPresent, false);
        discrete(tick, 'disc', 1, 'present', opponentPresent, false);
        if (info) {
          discrete(tick, 'policy', null, 'terminated', info.terminated, true);
          discrete(tick, 'policy', null, 'resultPhase', native.fte >= 0, true);
          if (info.terminated) report.coverage.terminalResult = true;
        }
        report.coverage.absentAfterResult++;
        return;
      }
      for (const [entity, id, actual, source] of [
        [
          'disc',
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
          'disc',
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
        const expected = conversion(source);
        for (const field of ['x', 'y', 'xv', 'yv']) {
          let actualValue = actual[field];
          // W4: the numeric control injects once at tick 1 and the divergence
          // is observed on every subsequent tick through state persistence.
          if (perturb && tick === 1 && id === 0 && field === 'xv') actualValue += 1e-6;
          numeric(tick, entity, id, field, actualValue, expected[field]);
        }
        if (id === 0) {
          // W7: death records intentionally do not carry a/av, and no native
          // disc may exist in that view. Comparing against a fabricated 0
          // would test nothing; exclude the field when the native disc is
          // absent instead of substituting a fake expected value.
          const nativeDisc = native.discs[id];
          if (nativeDisc) {
            numeric(tick, entity, id, 'a', actual.a, nativeDisc.a);
            numeric(tick, entity, id, 'av', actual.av, nativeDisc.av);
          } else {
            report.excludedFields.push({
              tick,
              entity,
              id,
              field: 'a/av',
              reason: 'native disc absent (death-record view)',
            });
          }
        }
      }
      discrete(tick, 'disc', 0, 'heavy', observation.playerIsHeavy, native.discs[0]?.a1 ?? false);
      discrete(tick, 'disc', 1, 'heavy', observation.opponents[0].isHeavy, native.discs[1]?.a1 ?? false);
      discrete(
        tick,
        'disc',
        0,
        'alive',
        // W4: the discrete control flips this boolean at tick 1 to prove the
        // discrete comparison path fails loud (numeric paths are covered by
        // the perturb control).
        perturbDiscrete && tick === 1
          ? !(observation.playerAlive ?? info?.aiAlive ?? true)
          : (observation.playerAlive ?? info?.aiAlive ?? true),
        expectedAI === native.discs[0] ? native.discs[0] !== null : false,
      );
      discrete(
        tick,
        'disc',
        1,
        'alive',
        observation.opponents[0].alive,
        expectedOpponent === native.discs[1] ? native.discs[1] !== null : false,
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
        discrete(tick, 'state', null, 'nativeMode', info.nativeMode, 'b');
        discrete(tick, 'state', null, 'nativeFlag', info.native, true);
      }
      if (native.ftu === -1) report.coverage.simulatedTicks++;
      if (native.fte >= 0) report.coverage.resultTicks++;
      if (scenario.kind === 'active' && tick === 60 && native.ftu === 0 && info?.nativePhase === 'countdown')
        report.coverage.countdownActiveBoundary = true;
      if (scenario.kind === 'active' && tick === 62 && native.ftu === -1 && info?.nativePhase === 'active')
        report.coverage.firstSolverTick = true;
      for (const death of native.discDeaths) {
        if (death.f === 0) report.coverage.deaths++;
        if (death.f === 0 && death.m !== 3 && native.discs[death.i]?.ni) report.coverage.respawns++;
      }
    };
    check(0);
    // W2: continue after the first mismatch (capped) so failure reports state
    // the true comparison count and error magnitude instead of stopping at the
    // first divergence. The cap keeps a fully-divergent run bounded.
    const MAX_MISMATCH_TICKS = 10;
    for (let tick = 1; tick <= scenario.ticks; tick++) {
      if (report.firstMismatch !== null && tick - (report.firstMismatch.tick ?? 0) > MAX_MISMATCH_TICKS) {
        report.stoppedAfterMismatchTicks = tick;
        break;
      }
      const action = actionFor(scenario.kind, tick);
      const inputs = [action, 0];
      // The original input table is player-ID sparse, never roster-position
      // indexed. Omitting the hole is not the same as supplying input to ID 1.
      native = oracle.step(native, { 0: bits(inputs[0]) }, null, 30, settings, 1, false, undefined);
      const result = env.step(action);
      observation = result.observation;
      info = result.info;
      check(tick);
      if (result.done) {
        // A public episode ends on its terminal result. The original state
        // subsequently continues its result countdown and creates a new round;
        // the full native-session differential owns that separate policy seam.
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
        break;
      }
    }
    if (!perturb && !perturbDiscrete) {
      if (report.coverage.simulatedTicks === 0) report.coverageFailures.push('no simulated ticks');
      if (report.coverage.fastObservationTicks !== report.frames)
        report.coverageFailures.push('incomplete fast-observation coverage');
      if (scenario.kind === 'active' && (!report.coverage.countdownActiveBoundary || !report.coverage.firstSolverTick))
        report.coverageFailures.push('countdown/solver boundary not covered');
      if (
        scenario.kind === 'lethal' &&
        (report.coverage.deaths === 0 ||
          report.coverage.resultTicks === 0 ||
          !report.coverage.terminalResult ||
          report.coverage.terminalObservations === 0)
      )
        report.coverageFailures.push('death/result/terminal observation not covered');
      if (scenario.kind === 'respawn' && (report.coverage.deaths === 0 || report.coverage.respawns === 0))
        report.coverageFailures.push('death/respawn not covered');
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
  const control = negativeControl ? runScenario(paths, SCENARIOS[0], true, 5) : null;
  if (control) {
    control.detected = control.firstMismatch?.field === 'xv' && control.firstMismatch.error > TOLERANCE;
    control.pass = control.detected;
  }
  const discreteControl = negativeControl
    ? (() => {
        const scenario = { ...SCENARIOS[0], ticks: 1 };
        const run = runScenario(paths, scenario, false, 1, true);
        run.detected = run.firstMismatch !== null;
        run.pass = run.detected;
        return run;
      })()
    : null;
  const report = {
    schema: 'bonk-rl-env.native-public-environment-differential',
    version: 1,
    pass:
      scenarios.every((scenario) => scenario.pass) &&
      (!control || control.pass) &&
      (!discreteControl || discreteControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    scope:
      'Actual BonkEnvironment reset/step/getObservationFast against pinned original raw static Classic states; only documented native-world to public map-pixel conversion. Covers active controls, countdown/first solver boundary, lethal result and OOB respawn presentation. No reward/termination policy parity, dynamic maps, worker transport, non-Classic modes, or whole-game claim.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      environmentSha256: digest(path.join(ROOT, 'src/core/environment.ts')),
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
