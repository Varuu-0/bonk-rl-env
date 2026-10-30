'use strict';

// Bounded original-native differential for the isolated Football slice.
// Expected trajectories always come from the pinned raw FootballPhysics
// spans; the local implementation is src/core/football-physics.ts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFootballOracle } = require('./raw-football-oracle.cjs');

const ROOT = path.resolve(__dirname, '../..');
const TOLERANCE = 1e-9;
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];
const BALL_NUMERIC = ['x', 'y', 'xv', 'yv'];
const DISC_NUMERIC = ['x', 'y', 'xv', 'yv'];
const DISC_DISCRETE = ['team', 'kickReady'];
const STATE_DISCRETE = [
  ['scores0', (s) => s.scores[0]],
  ['scores1', (s) => s.scores[1]],
  ['scores2', (s) => s.scores[2]],
  ['scores3', (s) => s.scores[3]],
  ['fte', (s) => s.fte],
  ['ftu', (s) => s.ftu],
  ['lscr', (s) => s.lscr],
  ['ni', (s) => s.ni === true],
];
const SCOPE =
  'Pinned original alpha2s FootballPhysics createNewState/step versus only src/core/football-physics.ts on the hardcoded football pitch with controlled native state seeds. Covers declared Football scenarios; not public PhysicsEngine/environment integration, match/round lifecycle beyond the native fte reset, complete modes, online play, or cross-platform bit parity.';

function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}

const SCENARIOS = Object.freeze([
  {
    name: 'football-kickoff-countdown',
    kind: 'football-kickoff-countdown',
    ticks: 125,
    boundary: 'fresh-createNewState-countdown',
  },
  {
    name: 'football-movement-force',
    kind: 'football-movement-force',
    ticks: 60,
    boundary: 'controlled-native-state-seed',
  },
  { name: 'football-kick-impulse', kind: 'football-kick-impulse', ticks: 30, boundary: 'controlled-native-state-seed' },
  { name: 'football-kick-rearm', kind: 'football-kick-rearm', ticks: 12, boundary: 'controlled-native-state-seed' },
  {
    name: 'football-action-slowdown',
    kind: 'football-action-slowdown',
    ticks: 60,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'football-action2-zero-force',
    kind: 'football-action2-zero-force',
    ticks: 60,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'football-ball-wall-bounce',
    kind: 'football-ball-wall-bounce',
    ticks: 90,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'football-player-goalpost-collision',
    kind: 'football-player-goalpost-collision',
    ticks: 90,
    boundary: 'controlled-native-state-seed',
  },
  { name: 'football-goal-left', kind: 'football-goal-left', ticks: 120, boundary: 'controlled-native-state-seed' },
  { name: 'football-goal-right', kind: 'football-goal-right', ticks: 120, boundary: 'controlled-native-state-seed' },
  {
    name: 'football-goal-freeze-reset',
    kind: 'football-goal-freeze-reset',
    ticks: 260,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'football-clamp-to-pitch',
    kind: 'football-clamp-to-pitch',
    ticks: 60,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'football-footbounce-sound',
    kind: 'football-footbounce-sound',
    ticks: 90,
    boundary: 'controlled-native-state-seed',
  },
]);

function teamsFor(kind) {
  // Team 2 = right side, team 3 = left side (native createNewState).
  return [2, 3];
}

function usage() {
  return [
    'Usage: node validation/native/compare-native-football.cjs --box2d <file> --safe-trig <file> [options]',
    '  --raw <file>             Pinned alpha2s.raw.js (or BONK_RAW_REFERENCE_FILE)',
    '  --scenario <name>        Exact scenario name; repeatable',
    '  --ticks <1..3600>        Per-scenario tick cap; unmet coverage still fails',
    '  --negative-control       Inject a local 1e-6 ball-xv error and require detection',
    '  --negative-control-only  Run only that control (not equivalence evidence)',
    '  --out <new-file>         Write the complete JSON receipt without overwriting',
    'Missing artifacts are BLOCKED and nonzero. No self-comparison or skip fallback exists.',
  ].join('\n');
}

function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = {
    scenarioNames: [],
    tickLimit: null,
    negativeControl: false,
    negativeControlOnly: false,
    output: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--negative-control' || argument === '--negative-control-only') {
      options.negativeControl = true;
      if (argument === '--negative-control-only') options.negativeControlOnly = true;
      continue;
    }
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[argument];
    if (key) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${argument} requires a file path`);
      values[key] = value;
      continue;
    }
    if (argument === '--scenario') {
      const name = argv[++index];
      assert(
        SCENARIOS.some((scenario) => scenario.name === name),
        `Unknown scenario: ${name}`,
      );
      options.scenarioNames.push(name);
      continue;
    }
    if (argument === '--ticks') {
      options.tickLimit = Number(argv[++index]);
      assert(
        Number.isSafeInteger(options.tickLimit) && options.tickLimit >= 1 && options.tickLimit <= 3600,
        '--ticks must be an integer in [1, 3600]',
      );
      continue;
    }
    if (argument === '--out') {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), '--out requires a new file path');
      options.output = path.resolve(cwd, value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }
  const missing = [];
  if (!values.box2d) missing.push('--box2d / BOX2D_REFERENCE_FILE');
  if (!values.trig) missing.push('--safe-trig / SAFETRIG_REFERENCE_FILE');
  if (missing.length && !options.help) {
    const error = new Error(`BLOCKED: native comparison dependencies are required: ${missing.join(', ')}\n${usage()}`);
    error.code = 'NATIVE_DEPENDENCIES_MISSING';
    throw error;
  }
  return {
    paths: {
      rawPath: path.resolve(cwd, values.raw || path.join(ROOT, '.deobf/alpha2s.raw.js')),
      physicsPath: values.box2d ? path.resolve(cwd, values.box2d) : undefined,
      trigPath: values.trig ? path.resolve(cwd, values.trig) : undefined,
    },
    ...options,
  };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function activate(state) {
  state.ftu = -1;
  state.fte = -1;
}

const PITCH_CENTER_X = 730 / 2 / 11;
const PITCH_CENTER_Y = 500 / 2 / 11;

function seedNative(native, kind) {
  activate(native);
  const ball = native.ball;
  const disc0 = native.discs[0];
  const disc1 = native.discs[1];
  switch (kind) {
    case 'football-kickoff-countdown':
      // Leave ftu at 120 (fresh createNewState); re-activate below.
      native.ftu = 120;
      native.fte = -1;
      break;
    case 'football-movement-force':
      disc0.x = PITCH_CENTER_X - 5;
      disc0.y = PITCH_CENTER_Y;
      disc0.xv = 0;
      disc0.yv = 0;
      disc1.x = PITCH_CENTER_X - 20;
      disc1.y = PITCH_CENTER_Y;
      break;
    case 'football-kick-impulse':
    case 'football-kick-rearm':
      disc0.x = ball.x - 2.2;
      disc0.y = ball.y;
      disc0.xv = 0;
      disc0.yv = 0;
      break;
    case 'football-action-slowdown':
      disc0.x = PITCH_CENTER_X - 5;
      disc0.y = PITCH_CENTER_Y;
      disc0.xv = 0;
      disc0.yv = 0;
      break;
    case 'football-action2-zero-force':
      disc0.x = PITCH_CENTER_X - 5;
      disc0.y = PITCH_CENTER_Y;
      disc0.xv = 0;
      disc0.yv = 0;
      break;
    case 'football-ball-wall-bounce':
      // Above the goal mouth (rel y = -12 < -9.41): the ball hits the upper
      // side-wall rect, not the goal opening.
      ball.x = PITCH_CENTER_X;
      ball.y = PITCH_CENTER_Y - 12;
      ball.xv = -25;
      ball.yv = 0;
      disc0.x = PITCH_CENTER_X - 20;
      disc0.y = PITCH_CENTER_Y;
      break;
    case 'football-player-goalpost-collision':
      // Left post x = -wallWidth/2; drive the player into it.
      disc0.x = 2.5;
      disc0.y = PITCH_CENTER_Y - 6;
      disc0.xv = -12;
      disc0.yv = 0;
      break;
    case 'football-goal-left':
    case 'football-goal-freeze-reset':
      ball.x = 3.0;
      ball.y = PITCH_CENTER_Y;
      ball.xv = -20;
      ball.yv = 0;
      disc0.x = PITCH_CENTER_X - 10;
      disc0.y = PITCH_CENTER_Y;
      break;
    case 'football-goal-right':
      ball.x = 730 / 11 - 3.0;
      ball.y = PITCH_CENTER_Y;
      ball.xv = 20;
      ball.yv = 0;
      disc0.x = PITCH_CENTER_X - 10;
      disc0.y = PITCH_CENTER_Y;
      break;
    case 'football-clamp-to-pitch':
      disc0.x = 0.5;
      disc0.y = 0.5;
      disc0.xv = -10;
      disc0.yv = -10;
      disc1.x = 730 / 11 - 0.5;
      disc1.y = 500 / 11 - 0.5;
      disc1.xv = 10;
      disc1.yv = 10;
      break;
    case 'football-footbounce-sound':
      // Above the goal mouth: a hard wall hit produces a footBounce sound.
      ball.x = PITCH_CENTER_X;
      ball.y = PITCH_CENTER_Y - 12;
      ball.xv = -25;
      ball.yv = 0;
      disc0.x = PITCH_CENTER_X - 20;
      disc0.y = PITCH_CENTER_Y;
      break;
    default:
      throw new Error(`Missing native seed implementation for ${kind}`);
  }
}

function inputsFor(kind, tick) {
  const inputs = [0, 0];
  switch (kind) {
    case 'football-kickoff-countdown':
      break;
    case 'football-movement-force':
      inputs[0] = 2;
      break;
    case 'football-kick-impulse':
      inputs[0] = 16;
      break;
    case 'football-kick-rearm':
      inputs[0] = tick <= 4 ? 16 : 0;
      break;
    case 'football-action-slowdown':
      inputs[0] = 16 | 2;
      break;
    case 'football-action2-zero-force':
      inputs[0] = 32 | 2;
      break;
    case 'football-player-goalpost-collision':
      inputs[0] = 8;
      break;
    default:
      break;
  }
  return inputs;
}

function newCoverage() {
  return {
    simulatedTicks: 0,
    countdownTicks: 0,
    motionTicks: 0,
    kickTicks: 0,
    kickRearmTicks: 0,
    actionSlowdownTicks: 0,
    action2ZeroTicks: 0,
    ballBounceTicks: 0,
    footBounceSounds: 0,
    footKickSounds: 0,
    footGoalSounds: 0,
    goalLeftTicks: 0,
    goalRightTicks: 0,
    goalFreezeTicks: 0,
    resetTicks: 0,
    clampTicks: 0,
    postCollisionTicks: 0,
    postBounceTicks: 0,
  };
}

function observeCoverage(kind, previous, native, tick, coverage) {
  const prevBall = previous.ball;
  const ball = native.ball;
  const prevDisc0 = previous.discs[0];
  const disc0 = native.discs[0];
  if (native.ftu === -1) coverage.simulatedTicks++;
  else coverage.countdownTicks++;
  for (const sound of native.sts) {
    if (sound.i === 'footBounce' && sound.f === 5) coverage.footBounceSounds++;
    if (sound.i === 'footKick' && sound.f === 10) coverage.footKickSounds++;
    if (sound.i === 'footGoal' && sound.f === 5) coverage.footGoalSounds++;
  }
  switch (kind) {
    case 'football-kickoff-countdown':
      break;
    case 'football-movement-force':
      if (prevDisc0 && disc0 && Math.abs(disc0.xv - prevDisc0.xv) > TOLERANCE) coverage.motionTicks++;
      break;
    case 'football-kick-impulse':
      if (prevDisc0 && disc0 && prevDisc0.kickReady === true && disc0.kickReady === false) coverage.kickTicks++;
      break;
    case 'football-kick-rearm':
      if (prevDisc0 && disc0 && prevDisc0.kickReady === false && disc0.kickReady === true) coverage.kickRearmTicks++;
      break;
    case 'football-action-slowdown':
      if (prevDisc0 && disc0 && Math.abs(disc0.xv - prevDisc0.xv) > TOLERANCE) coverage.actionSlowdownTicks++;
      break;
    case 'football-action2-zero-force':
      if (prevDisc0 && disc0 && Math.abs(disc0.xv) <= TOLERANCE) coverage.action2ZeroTicks++;
      break;
    case 'football-ball-wall-bounce':
    case 'football-footbounce-sound':
      if (prevBall && ball && prevBall.xv < 0 && ball.xv > 0) coverage.ballBounceTicks++;
      break;
    case 'football-player-goalpost-collision':
      if (prevDisc0 && disc0 && Math.abs(disc0.xv) <= TOLERANCE && Math.abs(prevDisc0.xv) > TOLERANCE)
        coverage.postCollisionTicks++;
      if (prevDisc0 && disc0 && prevDisc0.xv < 0 && disc0.xv > 0) coverage.postBounceTicks++;
      break;
    case 'football-goal-left':
    case 'football-goal-freeze-reset':
      if (native.lscr === 2 && previous.lscr !== 2) coverage.goalLeftTicks++;
      if (native.fte === 90) coverage.goalFreezeTicks++;
      if (native.ni === true) coverage.resetTicks++;
      break;
    case 'football-goal-right':
      if (native.lscr === 3 && previous.lscr !== 3) coverage.goalRightTicks++;
      if (native.fte === 90) coverage.goalFreezeTicks++;
      break;
    case 'football-clamp-to-pitch':
      if (disc0 && disc0.x === 1 && disc0.y === 1) coverage.clampTicks++;
      break;
    default:
      break;
  }
}

function coverageFailures(kind, coverage) {
  const failures = [];
  const requireCoverage = (condition, expected) => {
    if (!condition) failures.push({ field: 'coverage', expected });
  };
  requireCoverage(coverage.simulatedTicks > 0, 'at least one native simulated tick');
  switch (kind) {
    case 'football-kickoff-countdown':
      requireCoverage(coverage.countdownTicks >= 120, 'native kickoff countdown runs the full 120 ticks');
      break;
    case 'football-movement-force':
      requireCoverage(coverage.motionTicks > 0, 'native football movement force accelerates the player');
      break;
    case 'football-kick-impulse':
      requireCoverage(coverage.kickTicks > 0, 'native football kick fires');
      requireCoverage(coverage.footKickSounds > 0, 'native kick emits footKick sound');
      break;
    case 'football-kick-rearm':
      requireCoverage(coverage.kickRearmTicks > 0, 'native kickReady re-arms after action release');
      break;
    case 'football-action-slowdown':
      requireCoverage(coverage.actionSlowdownTicks > 0, 'native action slowdown still applies reduced force');
      break;
    case 'football-action2-zero-force':
      requireCoverage(coverage.action2ZeroTicks > 0, 'native action2 zeroes the movement force');
      break;
    case 'football-ball-wall-bounce':
      requireCoverage(coverage.ballBounceTicks > 0, 'native ball bounces off the side wall');
      break;
    case 'football-player-goalpost-collision':
      requireCoverage(
        coverage.postCollisionTicks > 0 || coverage.postBounceTicks > 0,
        'native player collides with the goal post',
      );
      break;
    case 'football-goal-left':
    case 'football-goal-freeze-reset':
      requireCoverage(coverage.goalLeftTicks > 0, 'native left goal is scored');
      requireCoverage(coverage.footGoalSounds > 0, 'native goal emits footGoal sound');
      requireCoverage(coverage.goalFreezeTicks > 0, 'native goal freeze fte=90 engages');
      break;
    case 'football-goal-right':
      requireCoverage(coverage.goalRightTicks > 0, 'native right goal is scored');
      requireCoverage(coverage.footGoalSounds > 0, 'native goal emits footGoal sound');
      break;
    case 'football-goal-freeze-reset':
      requireCoverage(coverage.resetTicks > 0, 'native fte==0 reset restores kickoff positions (ni=true)');
      break;
    case 'football-clamp-to-pitch':
      requireCoverage(coverage.clampTicks > 0, 'native clampToPitch pins the player to the pitch corner');
      break;
    case 'football-footbounce-sound':
      requireCoverage(coverage.footBounceSounds > 0, 'native hard ball contact emits footBounce sound');
      break;
    default:
      failures.push({ field: 'coverage', expected: `implemented coverage gate for ${kind}` });
  }
  return failures;
}

function localInputs(inputs) {
  return Object.fromEntries(inputs.map((value, index) => [index, bits(value)]));
}

function createRun(paths, scenario, options = {}) {
  const tickCount = Math.min(scenario.ticks, options.tickLimit ?? scenario.ticks);
  const oracle = createFootballOracle(paths);
  const { createFootballPhysics, createFootballState } = require('../../src/core/football-physics.ts');
  const physics = createFootballPhysics();
  try {
    const teams = teamsFor(scenario.kind);
    const roster = teams.map((team, id) => ({ id, team }));
    let native = oracle.createNewState(roster, null, 1, false, null, false);
    seedNative(native, scenario.kind);
    let local = createFootballState(native.players, native.seed);
    // Mirror the seeded native state into the local state.
    local = Object.freeze({
      ...local,
      ftu: native.ftu,
      fte: native.fte,
      lscr: native.lscr,
      ni: native.ni,
      scores: native.scores.slice(),
      ball: Object.freeze({ ...native.ball }),
      discs: Object.freeze(native.discs.map((disc) => (disc === undefined ? undefined : Object.freeze({ ...disc })))),
      sts: native.sts.map((sound) => Object.freeze({ ...sound })),
    });
    const coverage = newCoverage();
    const report = {
      name: scenario.name,
      kind: scenario.kind,
      seed: 1,
      boundary: scenario.boundary,
      requestedTicks: scenario.ticks,
      tickCap: tickCount,
      ticks: 0,
      frames: 1,
      pass: true,
      status: 'PASS',
      comparisons: 0,
      numericComparisons: 0,
      discreteComparisons: 0,
      maxError: 0,
      maxErrorByField: {},
      firstMismatch: null,
      mismatches: [],
      stoppedAfterMismatchTicks: null,
      coverage,
      coverageFailures: [],
      localRepairOrReseeds: 0,
    };
    const mismatch = (entry) => {
      if (report.firstMismatch === null) report.firstMismatch = entry;
      if (report.mismatches.length < 40) report.mismatches.push(entry);
      report.pass = false;
      report.status = 'FAIL';
    };
    const discrete = (tick, entity, id, field, actual, expected) => {
      report.comparisons++;
      report.discreteComparisons++;
      if (!Object.is(actual, expected)) mismatch({ tick, entity, id, field, actual, native: expected });
    };
    const numeric = (tick, entity, id, field, actual, expected) => {
      const error = Math.abs(actual - expected);
      const key = `${entity}.${field}`;
      report.comparisons++;
      report.numericComparisons++;
      if (!Number.isFinite(error)) {
        mismatch({ tick, entity, id, field, actual, native: expected, error: 'non-finite' });
        return;
      }
      report.maxError = Math.max(report.maxError, error);
      report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] || 0, error);
      if (error > TOLERANCE) mismatch({ tick, entity, id, field, actual, native: expected, error });
    };
    const check = (tick) => {
      report.ticks = tick;
      report.frames = tick + 1;
      for (const [field, read] of STATE_DISCRETE) discrete(tick, 'state', null, field, read(local), read(native));
      for (const field of BALL_NUMERIC) {
        // W3: perturbation is injected once, on the local state (below), so
        // the recorded injectedError magnitude is the true divergence.
        numeric(tick, 'ball', null, field, local.ball[field], native.ball[field]);
      }
      const discCount = Math.max(local.discs.length, native.discs.length);
      for (let index = 0; index < discCount; index++) {
        const actual = local.discs[index];
        const expected = native.discs[index];
        discrete(tick, 'disc', index, 'presence', actual !== undefined, expected !== undefined);
        if (actual === undefined || expected === undefined) continue;
        for (const field of DISC_NUMERIC) numeric(tick, 'disc', index, field, actual[field], expected[field]);
        for (const field of DISC_DISCRETE) discrete(tick, 'disc', index, field, actual[field], expected[field]);
      }
      // Sound table: compare length then per-entry fields.
      discrete(tick, 'sts', null, 'length', local.sts.length, native.sts.length);
      for (let index = 0; index < Math.max(local.sts.length, native.sts.length); index++) {
        const actual = local.sts[index];
        const expected = native.sts[index];
        discrete(tick, 'sts', index, 'i', actual?.i, expected?.i);
        discrete(tick, 'sts', index, 'f', actual?.f, expected?.f);
        if (actual?.v !== undefined || expected?.v !== undefined) {
          if (actual?.v === undefined || expected?.v === undefined)
            discrete(tick, 'sts', index, 'v', actual?.v, expected?.v);
          else numeric(tick, 'sts', index, 'v', actual.v, expected.v);
        }
        if (actual?.p !== undefined || expected?.p !== undefined) {
          discrete(tick, 'sts', index, 'p', actual?.p, expected?.p);
        }
        if (actual?.pl !== undefined || expected?.pl !== undefined) {
          if (actual?.pl === undefined || expected?.pl === undefined)
            discrete(tick, 'sts', index, 'pl', actual?.pl, expected?.pl);
          else numeric(tick, 'sts', index, 'pl', actual.pl, expected.pl);
        }
      }
    };
    check(0);
    // W2: continue after the first mismatch (capped) so failure reports state
    // the true comparison count and error magnitude instead of stopping at the
    // first divergence. The cap keeps a fully-divergent run bounded.
    const MAX_MISMATCH_TICKS = 10;
    for (let tick = 1; tick <= tickCount; tick++) {
      if (report.firstMismatch !== null && tick - (report.firstMismatch.tick ?? 0) > MAX_MISMATCH_TICKS) {
        report.stoppedAfterMismatchTicks = tick;
        break;
      }
      const input = inputsFor(scenario.kind, tick);
      const previous = native;
      native = oracle.step(native, input.map(bits), null, 30, null, 1);
      const localInput = localInputs(input);
      local = physics.step(local, localInput);
      if (options.perturb && tick === 1) {
        // Inject error into the local ball velocity before comparison.
        local = Object.freeze({ ...local, ball: Object.freeze({ ...local.ball, xv: local.ball.xv + 1e-6 }) });
      }
      if (options.perturbDiscrete && tick === 1) {
        // W4: flip a discrete boolean the comparator verifies (disc 0
        // kickReady) to prove the discrete path fails loud.
        local = Object.freeze({
          ...local,
          discs: Object.freeze(
            local.discs.map((disc, index) =>
              index === 0 && disc !== undefined ? Object.freeze({ ...disc, kickReady: !disc.kickReady }) : disc,
            ),
          ),
        });
      }
      observeCoverage(scenario.kind, previous, native, tick, coverage);
      check(tick);
    }
    if (!options.perturb && !options.perturbDiscrete) {
      report.coverageFailures = coverageFailures(scenario.kind, coverage);
      for (const failure of report.coverageFailures) mismatch({ tick: report.ticks, ...failure });
    }
    report.pass = report.firstMismatch === null;
    report.status = report.pass ? 'PASS' : 'FAIL';
    report.provenance = oracle.provenance;
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareNativeFootball(paths, options = {}) {
  const selected = options.negativeControlOnly
    ? []
    : SCENARIOS.filter((scenario) => {
        if (options.scenarioNames?.length && !options.scenarioNames.includes(scenario.name)) return false;
        return true;
      });
  const results = [];
  for (const scenario of selected) {
    try {
      results.push(createRun(paths, scenario, options));
    } catch (error) {
      results.push({
        name: scenario.name,
        kind: scenario.kind,
        pass: false,
        status: 'ERROR',
        ticks: 0,
        frames: 0,
        comparisons: 0,
        numericComparisons: 0,
        discreteComparisons: 0,
        maxError: 0,
        maxErrorByField: {},
        firstMismatch: null,
        error: { message: error.message, stack: error.stack },
        coverageFailures: [],
        localRepairOrReseeds: 0,
      });
    }
  }
  let negativeControl = null;
  let provenance = results.find((result) => result.provenance)?.provenance;
  if (options.negativeControl) {
    // W4: run the numeric control past tick 1 so the injected divergence is
    // observed at a later tick too (ball xv error persists and compounds).
    const scenario = SCENARIOS.find((entry) => entry.name === 'football-movement-force');
    const control = createRun(paths, scenario, { tickLimit: 5, perturb: true });
    provenance ||= control.provenance;
    // W4: a discrete-field control flips a boolean the comparator verifies,
    // proving the discrete path also fails loud (not only numeric()).
    const discreteRun = createRun(paths, scenario, { tickLimit: 1, perturbDiscrete: true });
    negativeControl = {
      name: 'injected-local-ball-xv-error',
      injectedError: 1e-6,
      ticks: control.ticks,
      detected:
        control.firstMismatch?.entity === 'ball' &&
        control.firstMismatch?.field === 'xv' &&
        control.firstMismatch?.error > TOLERANCE,
      firstMismatch: control.firstMismatch,
      discreteControl: {
        name: 'injected-local-discrete-flip',
        detected: discreteRun.firstMismatch !== null,
        firstMismatch: discreteRun.firstMismatch,
      },
    };
    negativeControl.pass = negativeControl.detected && negativeControl.discreteControl.detected;
  }
  const totals = {
    scenarios: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    ticks: results.reduce((sum, result) => sum + result.ticks, 0),
    comparisons: results.reduce((sum, result) => sum + result.comparisons, 0),
    numericComparisons: results.reduce((sum, result) => sum + result.numericComparisons, 0),
    discreteComparisons: results.reduce((sum, result) => sum + result.discreteComparisons, 0),
    maximumAbsoluteError: results.reduce((maximum, result) => Math.max(maximum, result.maxError), 0),
    coverageFailures: results.reduce((sum, result) => sum + (result.coverageFailures?.length || 0), 0),
    localRepairOrReseeds: results.reduce((sum, result) => sum + (result.localRepairOrReseeds || 0), 0),
  };
  return {
    schema: 'bonk-rl-env.native-football-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    status:
      results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass) ? 'PASS' : 'FAIL',
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    publicEngineParityClaimed: false,
    originalOnlyExpectedValues: true,
    scope: SCOPE,
    provenance: {
      ...provenance,
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localFootballPhysicsSha256: digest(path.join(ROOT, 'src/core/football-physics.ts')),
    },
    scenarioNames: options.scenarioNames || [],
    tickLimit: options.tickLimit ?? null,
    scenarios: results,
    negativeControl,
    totals,
  };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return { help: true, text: usage() };
  for (const file of Object.values(options.paths)) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const error = new Error(`BLOCKED: native comparison dependency is not a file: ${file}`);
      error.code = 'NATIVE_DEPENDENCIES_MISSING';
      throw error;
    }
  }
  const report = compareNativeFootball(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  return report;
}

module.exports = {
  compareNativeFootball,
  createRun,
  parseArguments,
  bits,
  inputsFor,
  coverageFailures,
  SCENARIOS,
  TOLERANCE,
  SCOPE,
};
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (report.help) console.log(report.text);
    else {
      console.log(JSON.stringify(report, null, 2));
      if (!report.pass) process.exitCode = 1;
    }
  } catch (error) {
    const blocked = error.code === 'NATIVE_DEPENDENCIES_MISSING';
    console.error(
      JSON.stringify(
        {
          schema: 'bonk-rl-env.native-football-differential',
          version: 1,
          pass: false,
          status: blocked ? 'BLOCKED' : 'ERROR',
          error: { code: error.code || null, message: error.message, stack: error.stack },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
