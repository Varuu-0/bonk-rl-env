'use strict';

// Fresh original createNewState/Physics.step versus the additive native static
// mode session. Both sides own countdown, death, scoring and round rollover.
// No controlled solver reseed, local trajectory repair or self-comparison.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { localPlatforms } = require('./compare-classic-native.cjs');
const { createNativeModeSession } = require('../../src/core/native-mode-session.ts');

const ROOT = path.resolve(__dirname, '../..');
const TOLERANCE = 1e-9;
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
const DISC_DISCRETE = [
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
  ['ds', (disc) => disc.ds],
  ['da', (disc) => disc.da],
  ['vt', (disc) => disc.vt],
];
const PROJECTILE_NUMERIC = ['x', 'y', 'xv', 'yv', 'a', 'av'];
const PROJECTILE_DISCRETE = ['fte', 'did', 'type', 'team'];
const LOCAL_FILES = [
  'src/core/native-mode-session.ts',
  'src/core/native-session.ts',
  'src/core/classic-physics.ts',
  'src/core/native-spawns.ts',
  'src/core/safe-trig.ts',
];
const SCOPE =
  'Pinned original alpha2s createNewState/Physics.step versus src/core/native-mode-session.ts delegating static match lifecycle to createNativeSession. Covers declared fresh-session Classic, Arrow expiry, Death Arrow lethal/result/rollover and VTOL contact scenarios; not public PhysicsEngine/environment integration, dynamic maps, complete modes, online play, respawn matches or cross-platform bit parity.';
const SCENARIOS = Object.freeze([
  ...['b', 'ar', 'ard', 'v'].flatMap((mode) =>
    [1, 2].map((quality) => ({
      name: `${{ b: 'classic-lifecycle', ar: 'arrow-charge-expiry', ard: 'death-arrow-result-rollover', v: 'vtol-contact' }[mode]}-${mode}-q${quality}`,
      mode,
      quality,
      kind: {
        b: 'classic-lifecycle',
        ar: 'arrow-charge-expiry',
        ard: 'death-arrow-result-rollover',
        v: 'vtol-contact',
      }[mode],
      ticks: mode === 'b' ? 92 : mode === 'ar' ? 425 : mode === 'ard' ? 420 : 185,
    })),
  ),
]);
const REGRESSION_SCENARIOS = Object.freeze([
  {
    name: 'arrow-first-charge-ar-q1',
    mode: 'ar',
    quality: 1,
    kind: 'arrow-first-charge',
    ticks: 130,
  },
]);
const ALL_SCENARIOS = Object.freeze([...SCENARIOS, ...REGRESSION_SCENARIOS]);

function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function usage() {
  return [
    'Usage: node validation/native/compare-native-mode-session.cjs --box2d <file> --safe-trig <file> [options]',
    '  --raw <file>             Pinned alpha2s.raw.js (or BONK_RAW_REFERENCE_FILE)',
    '  --scenario <name>        Exact scenario name; repeatable',
    '  --regression             Select the separate first-charge force regression',
    '  --ticks <1..500>         Per-scenario tick cap; unmet coverage still fails',
    '  --negative-control       Inject a local 1e-6 disc-xv error and require detection',
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
    regression: false,
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
    if (argument === '--regression') {
      options.regression = true;
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
        ALL_SCENARIOS.some((scenario) => scenario.name === name),
        `Unknown scenario: ${name}`,
      );
      options.scenarioNames.push(name);
      continue;
    }
    if (argument === '--ticks') {
      options.tickLimit = Number(argv[++index]);
      assert(
        Number.isSafeInteger(options.tickLimit) && options.tickLimit >= 1 && options.tickLimit <= 500,
        '--ticks must be an integer in [1, 500]',
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

function configureMap(scenario) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
  map.s.pq = scenario.quality;
  map.s.re = false;
  map.s.fl = false;
  map.s.nc = false;
  map.physics.bodies[0].p = [0, 144];
  map.physics.shapes[0].w = 240;
  map.physics.shapes[0].h = 24;
  if (scenario.kind === 'arrow-charge-expiry') {
    // Support both discs through charge, release and expiry without contacts.
    map.physics.bodies[0].p = [0, 0];
    map.physics.shapes[0].w = 480;
  }
  if (scenario.kind === 'classic-lifecycle') {
    // One spawn starts below the native floor; the other stays on the static
    // platform, reproducing frozen-countdown round resolution.
    map.physics.bodies[0].p = [0, 0];
  }
  const common = { priority: 5, f: true, r: true, b: true, gr: false, ye: false, xv: 0, yv: 0 };
  map.spawns = [
    { ...common, x: -60, y: -60 }, // (25.416..., 15.833...)
    { ...common, x: -12, y: -60 }, // (29.416..., 15.833...)
  ];
  if (scenario.kind === 'classic-lifecycle') map.spawns[1].y = 360;
  if (scenario.kind === 'death-arrow-result-rollover') {
    // The original spawn deal gives ID 0 spawn 1 and ID 1 spawn 0 here.
    // Keep both supported while the shooter aims only after drawing starts.
    map.physics.bodies[0].p = [0, 0];
    map.physics.shapes[0].w = 480;
    map.spawns[0].x = 95; // ID 1 target, world x=38.333...
    map.spawns[1].x = -120; // ID 0 shooter, world x=20.416...
    map.spawns[0].y = -70;
    map.spawns[1].y = -70;
  }
  if (scenario.kind === 'arrow-first-charge') {
    // Reproduce the supported Death Arrow platform and its seed-1 spawn deal:
    // ID 0 receives spawn 1 (world x=15.416...), ID 1 spawn 0 (x=25.416...).
    // This keeps the force regression in-round through charge and release.
    map.physics.bodies[0].p = [0, 0];
    map.physics.shapes[0].w = 480;
    map.spawns[0].x = -60;
    map.spawns[1].x = -180;
    map.spawns[0].y = -70;
    map.spawns[1].y = -70;
  }
  if (scenario.mode === 'v') {
    map.physics.fixtures[0].d = true;
    const bodyTemplate = { ...map.physics.bodies[0] };
    map.physics.bodies = [];
    map.physics.fixtures = [];
    map.physics.shapes = [];
    map.physics.bro = [];
    // Lethal box at world centre (13.3, 15), half extents (.5, .5).
    // The first disc's body ends at x=14, leaving a .2-unit body/world gap;
    // its left wing touches the box and the two discs' inner wings overlap.
    map.physics.shapes.push({ type: 'bx', w: 12, h: 12, c: [0, 0], a: 0, sk: false });
    const baseFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8')).physics
      .fixtures[0];
    map.physics.fixtures.push({ ...baseFixture, sh: 0, n: 'VTOL session wing probe', d: true });
    map.physics.bodies.push({ ...bodyTemplate, p: [-205.4, -70], fx: [0] });
    map.physics.bro.push(0);
    map.spawns[0].x = -185; // world x=15
    map.spawns[1].x = -159.8; // world x=17.1, wing/disc overlap only
    map.spawns[0].y = -70;
    map.spawns[1].y = -70;
  }
  return map;
}
function toArena(native, map) {
  return {
    ppm: native.physics.ppm,
    settings: { respawn: map.s.re, noCollision: map.s.nc, fly: map.s.fl, quality: map.s.pq },
    spawns: map.spawns.map((spawn) => ({
      x: (spawn.x + 365) / native.physics.ppm,
      y: (spawn.y + 250) / native.physics.ppm,
      xv: spawn.xv / native.physics.ppm,
      yv: spawn.yv / native.physics.ppm,
      priority: spawn.priority,
      ffa: spawn.f,
      red: spawn.r,
      blue: spawn.b,
      green: spawn.gr,
      yellow: spawn.ye,
    })),
    platforms: localPlatforms(native),
  };
}
function inputsFor(kind, tick) {
  if (kind === 'arrow-charge-expiry') return { 0: tick <= 260 ? 32 : 0, 1: 0 };
  if (kind === 'death-arrow-result-rollover') {
    // Recharge, begin the draw without directional force, aim to 0 degrees,
    // charge fully, then release through the stationary target.
    if (tick <= 111) return { 0: 0, 1: 0 };
    if (tick <= 123) return { 0: 32, 1: 0 };
    if (tick <= 141) return { 0: 34, 1: 0 };
    if (tick <= 230) return { 0: 32, 1: 0 };
    return { 0: 0, 1: 0 };
  }
  if (kind === 'arrow-first-charge') {
    // Exact fresh-session gate timing: recharge at 8/tick, begin rightward
    // charge when 996 becomes 1000, then release after six drawing ticks.
    if (tick <= 117) return { 0: 0, 1: 0 };
    if (tick <= 129) return { 0: 34, 1: 0 };
    return { 0: 0, 1: 0 };
  }
  if (kind === 'vtol-contact') return { 0: tick % 9 < 5 ? 2 : tick % 9 < 8 ? 1 : 4, 1: 0 };
  return { 0: 0, 1: 0 };
}
function observeNativeContacts(oracle, coverage) {
  for (const contact of oracle.consumeContactObservations()) {
    if (coverage.nativeContactSamples.length < 32) coverage.nativeContactSamples.push(contact);
    const pair = [contact.fixtureA, contact.fixtureB];
    const bodies = [contact.bodyA, contact.bodyB];
    if (pair.includes('vtolwing') && bodies.includes('phys')) coverage.nativeWingWorldContacts++;
    if (pair.includes('vtolwing') && pair.includes('discbody')) coverage.nativeWingDiscContacts++;
    if (contact.fixtureA === 'vtolwing' && contact.fixtureB === 'vtolwing') coverage.nativeWingWingContacts++;
    if (pair.includes('discbody') && bodies.includes('phys')) coverage.nativeDiscBodyWorldContacts++;
    if (contact.fixtureA === 'discbody' && contact.fixtureB === 'discbody') coverage.nativeDiscBodyDiscContacts++;
  }
}
function newCoverage() {
  return {
    simulatedTicks: 0,
    countdownTicks: 0,
    resultTicks: 0,
    rollovers: 0,
    postRolloverTicks: 0,
    roundResults: [],
    maxProjectiles: 0,
    preStepNative: null,
    projectileFteZeroTicks: 0,
    projectileExpiryTicks: 0,
    releases: [],
    firedOwners: [],
    postFireEnergies: [],
    maxDraw: 0,
    deaths: [],
    deathCauses: { 1: 0, 3: 0, 4: 0 },
    vtStates: [],
    nonzeroAngularTicks: 0,
    lastHitTicks: 0,
    arrowContacts: 0,
    matchCompleteTicks: 0,
    firstChargeSourceState: null,
    firstChargeResultState: null,
    nativeWingWorldContacts: 0,
    nativeWingDiscContacts: 0,
    nativeWingWingContacts: 0,
    nativeDiscBodyWorldContacts: 0,
    nativeDiscBodyDiscContacts: 0,
    nativeContactSamples: [],
  };
}
function observeCoverage(scenario, previous, native, state, events, coverage) {
  if (scenario.kind === 'arrow-first-charge' && state.tick === 118 && coverage.preStepNative.discs[0]) {
    // Original step mutates its input state in place; this detached pre-step
    // observation is source evidence only, never a solver seed or repair.
    const before = coverage.preStepNative;
    const source = before.discs[0];
    const result = native.discs[0];
    coverage.firstChargeSourceState = {
      tick: state.tick,
      roundTick: before.rl,
      sessionResultTick: state.tick,
      input: 34,
      disc: {
        x: source.x,
        y: source.y,
        xv: source.xv,
        yv: source.yv,
        energy: source.a1a,
        ds: source.ds,
        da: source.da,
      },
    };
    coverage.firstChargeResultState = result
      ? {
          tick: state.tick,
          roundTick: native.rl,
          sessionResultTick: state.tick,
          disc: {
            x: result.x,
            y: result.y,
            xv: result.xv,
            yv: result.yv,
            energy: result.a1a,
            ds: result.ds,
            da: result.da,
          },
        }
      : null;
  }
  if (native.ftu >= 0) coverage.countdownTicks++;
  else coverage.simulatedTicks++;
  if (native.fte >= 0) coverage.resultTicks++;
  if (native.rc > 0) coverage.postRolloverTicks++;
  if (native.rc !== previous.rc) coverage.rollovers++;
  if (native.matchComplete || state.matchComplete) coverage.matchCompleteTicks++;
  for (const death of native.discDeaths.filter((entry) => entry.f === 0)) {
    coverage.deaths.push({ tick: state.tick, id: death.i, cause: death.m });
    coverage.deathCauses[death.m]++;
  }
  if (events.roundResult) coverage.roundResults.push({ ...events.roundResult });
  coverage.maxProjectiles = Math.max(coverage.maxProjectiles, native.projectiles.length);
  for (let index = 0; index < Math.max(previous.projectiles.length, native.projectiles.length); index++) {
    if (native.projectiles[index]?.fte === 0) coverage.projectileFteZeroTicks++;
    if (previous.projectiles[index] && !native.projectiles[index] && previous.projectiles[index].fte === 0)
      coverage.projectileExpiryTicks++;
  }
  for (const disc of native.discs) {
    if (!disc) continue;
    coverage.maxDraw = Math.max(coverage.maxDraw, disc.ds);
    if (disc.av !== 0) coverage.nonzeroAngularTicks++;
    if (disc.lht > 0 && disc.lhid >= 0) coverage.lastHitTicks++;
    if (!coverage.vtStates.includes(disc.vt)) coverage.vtStates.push(disc.vt);
  }
  for (let id = 0; id < previous.discs.length; id++) {
    const disc = previous.discs[id];
    if (!disc) continue;
    const after = native.discs[id];
    if (disc.ds > 0 && after?.ds === 0) {
      coverage.releases.push(state.tick);
      coverage.postFireEnergies.push(after.a1a);
      const projectile = native.projectiles.find((entry) => entry?.did === id);
      if (projectile) coverage.firedOwners.push(projectile.did);
    }
  }
  coverage.arrowContacts += events.deaths.filter((death) => death.m === 1 && scenario.mode === 'ard').length;
}
function coverageFailures(scenario, coverage, requestedTicks, comparedTicks) {
  const failures = [];
  const requireCoverage = (condition, expected) => {
    if (!condition) failures.push({ field: 'coverage', expected });
  };
  requireCoverage(comparedTicks === requestedTicks, `${requestedTicks} uncompromised original-session comparisons`);
  requireCoverage(coverage.countdownTicks > 0 && coverage.simulatedTicks > 0, 'countdown and active native phases');
  if (scenario.kind === 'classic-lifecycle') {
    requireCoverage(coverage.deathCauses[4] === 1, 'one native out-of-world Classic death');
    requireCoverage(coverage.resultTicks === 91, '90 native result steps plus rollover result boundary');
    requireCoverage(
      coverage.rollovers === 1 && coverage.postRolloverTicks > 0,
      'native round rollover and recreated round',
    );
    requireCoverage(
      coverage.roundResults.length === 1 && coverage.roundResults[0].winner !== null,
      'native Classic winner/result',
    );
  } else if (scenario.kind === 'arrow-charge-expiry') {
    requireCoverage(coverage.maxDraw === 100, 'fresh native session Arrow reaches full draw');
    requireCoverage(
      coverage.releases.length === 1 && coverage.postFireEnergies[0] === 500,
      'native release and post-fire energy',
    );
    requireCoverage(coverage.firedOwners[0] === 0, 'native projectile lethal-owner attribution');
    requireCoverage(
      coverage.projectileFteZeroTicks > 0 && coverage.projectileExpiryTicks > 0,
      'native projectile fte=0 then expiry',
    );
    requireCoverage(
      coverage.deaths.length === 0 && coverage.rollovers === 0,
      'Arrow projectile trajectory remains in-round',
    );
  } else if (scenario.kind === 'death-arrow-result-rollover') {
    requireCoverage(
      coverage.deathCauses[1] === 1 && coverage.deaths[0]?.id === 1,
      'Death Arrow lethal attribution to target disc',
    );
    requireCoverage(
      coverage.roundResults.length === 1 &&
        coverage.roundResults[0].winner === 0 &&
        coverage.roundResults[0].score === 1,
      'Death Arrow native winner and score',
    );
    requireCoverage(coverage.rollovers === 1 && coverage.postRolloverTicks > 0, 'Death Arrow result rollover');
    requireCoverage(
      coverage.firedOwners.length > 0 && coverage.firedOwners.every((id) => id === 0),
      'Death Arrow projectile owner',
    );
    requireCoverage(coverage.resultTicks > 0, 'Death Arrow round-result phase');
  } else if (scenario.kind === 'arrow-first-charge') {
    requireCoverage(coverage.countdownTicks === 60, '60 native countdown observations');
    requireCoverage(
      coverage.releases.length === 1 && coverage.releases[0] === 130,
      'one native Arrow release after the force regression window',
    );
    requireCoverage(
      coverage.maxDraw === 12 && coverage.deaths.length === 0 && coverage.maxProjectiles === 1,
      'isolated full-energy first-charge force path',
    );
    requireCoverage(
      coverage.firstChargeSourceState?.disc.energy === 1000 &&
        coverage.firstChargeSourceState?.disc.ds === 0 &&
        coverage.firstChargeResultState?.disc.ds === 1 &&
        (coverage.firstChargeResultState?.disc.xv ?? 0) - (coverage.firstChargeSourceState?.disc.xv ?? 0) > 0.39,
      'original full-energy undrawn source applies right force on the first charge tick',
    );
  } else if (scenario.kind === 'vtol-contact') {
    requireCoverage(
      coverage.vtStates.some((state) => state !== 0),
      'native VTOL directional contact state',
    );
    requireCoverage(coverage.nonzeroAngularTicks > 0, 'native VTOL wing/world contact produces rotation');
    requireCoverage(coverage.deathCauses[1] > 0, 'native lethal VTOL wing/world contact');
    requireCoverage(coverage.lastHitTicks > 0, 'native VTOL disc contact attribution');
    requireCoverage(
      coverage.nativeWingDiscContacts > 0 && coverage.nativeDiscBodyDiscContacts === 0,
      'original contact list isolates VTOL wing/disc contact',
    );
    requireCoverage(
      coverage.nativeWingWorldContacts > 0 && coverage.nativeDiscBodyWorldContacts === 0,
      'original contact list isolates lethal VTOL wing/world contact',
    );
    requireCoverage(coverage.maxProjectiles === 0, 'VTOL emits no projectiles');
  }
  coverage.vtStates.sort((a, b) => a - b);
  return failures;
}

function createRun(paths, scenario, options = {}) {
  const tickCount = Math.min(scenario.ticks, options.tickLimit ?? scenario.ticks);
  const oracle = createOracle(paths);
  const roster = [
    { id: 0, team: 1 },
    { id: 1, team: 1 },
  ];
  const map = configureMap(scenario);
  const settings = { ga: 'b', mo: scenario.mode, tea: false, bal: [0, 0], map, gt: 2, wl: 3, q: false, maps: [] };
  let session;
  let native;
  const report = {
    name: scenario.name,
    kind: scenario.kind,
    mode: scenario.mode,
    quality: scenario.quality,
    seed: 1,
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
    coverage: newCoverage(),
    coverageFailures: [],
    localRepairOrReseeds: 0,
  };
  function mismatch(entry) {
    if (report.firstMismatch === null) report.firstMismatch = entry;
    if (report.mismatches.length < 30) report.mismatches.push(entry);
    report.pass = false;
    report.status = 'FAIL';
  }
  function discrete(tick, entity, id, field, actual, expected) {
    report.comparisons++;
    report.discreteComparisons++;
    if (!Object.is(actual, expected)) mismatch({ tick, entity, id, field, actual, native: expected });
  }
  function numeric(tick, entity, id, field, actual, expected) {
    report.comparisons++;
    report.numericComparisons++;
    if (typeof actual !== 'number' || typeof expected !== 'number') {
      mismatch({ tick, entity, id, field, actual, native: expected, error: 'non-numeric' });
      return;
    }
    const error = Math.abs(actual - expected);
    const key = `${entity}.${field}`;
    if (!Number.isFinite(error)) {
      mismatch({ tick, entity, id, field, actual, native: expected, error: 'non-finite' });
      return;
    }
    report.maxError = Math.max(report.maxError, error);
    report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] || 0, error);
    if (error > TOLERANCE) mismatch({ tick, entity, id, field, actual, native: expected, error });
  }
  function nativeResults(state, last) {
    if (state.fte < 0) return { current: null, last };
    const result = {
      winner: state.lscr < 0 ? null : state.lscr,
      draw: state.lscr < 0,
      score: state.lscr < 0 ? null : state.scores[state.lscr],
    };
    return { current: result, last: result };
  }
  let nativeLastRoundResult = null;
  function check(tick) {
    report.ticks = tick;
    report.frames = tick + 1;
    const actual = session.getState();
    for (const field of ['seed', 'ftu', 'fte', 'rl', 'rc', 'lscr'])
      discrete(tick, 'state', null, field, actual[field], native[field]);
    discrete(tick, 'state', null, 'roundTick', actual.roundTick, native.rl);
    discrete(tick, 'state', null, 'matchComplete', actual.matchComplete, false);
    const expectedResults = nativeResults(native, nativeLastRoundResult);
    if (expectedResults.current) nativeLastRoundResult = expectedResults.current;
    for (const field of ['roundResult', 'lastRoundResult']) {
      const actualResult = field === 'roundResult' ? expectedResults.current : expectedResults.last;
      const expectedResult = actualResult;
      discrete(tick, field, null, 'present', actual[field] !== null, expectedResult !== null);
      if (actual[field] && expectedResult) {
        for (const key of ['winner', 'draw', 'score'])
          discrete(tick, field, null, key, actual[field][key], expectedResult[key]);
      }
    }
    const maxPlayers = Math.max(actual.players.length, native.players.length);
    for (let id = 0; id < maxPlayers; id++) {
      discrete(tick, 'player', id, 'presence', actual.players[id] !== undefined, native.players[id] !== undefined);
      if (actual.players[id] && native.players[id]) {
        discrete(tick, 'player', id, 'id', actual.players[id].id, native.players[id].id);
        discrete(tick, 'player', id, 'team', actual.players[id].team, native.players[id].team);
      }
    }
    const maxScores = Math.max(actual.scores.length, native.scores.length);
    for (let id = 0; id < maxScores; id++)
      discrete(tick, 'score', id, 'value', actual.scores[id] ?? null, native.scores[id] ?? null);
    const discCount = Math.max(actual.discs.length, native.discs.length);
    for (let id = 0; id < discCount; id++) {
      const disc = actual.discs[id];
      const expected = native.discs[id];
      const present = disc !== undefined && disc.alive === true;
      discrete(tick, 'disc', id, 'presentAlive', present, expected !== undefined && expected !== null);
      if (!present || !expected) continue;
      for (const [field, nativeField] of DISC_NUMERIC) {
        let value = disc[field];
        if (options.perturb && tick === 1 && id === 0 && field === 'xv') value += 1e-6;
        numeric(tick, 'disc', id, field, value, expected[nativeField]);
      }
      for (const [field, read] of DISC_DISCRETE) discrete(tick, 'disc', id, field, disc[field], read(expected));
    }
    discrete(tick, 'projectiles', null, 'length', actual.projectiles.length, native.projectiles.length);
    const projectileCount = Math.max(actual.projectiles.length, native.projectiles.length);
    for (let index = 0; index < projectileCount; index++) {
      const projectile = actual.projectiles[index];
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
      for (const field of PROJECTILE_NUMERIC)
        numeric(tick, 'projectile', index, field, projectile[field], expected[field]);
      for (const field of PROJECTILE_DISCRETE)
        discrete(tick, 'projectile', index, field, projectile[field], expected[field]);
    }
    discrete(tick, 'deaths', null, 'length', actual.discDeaths.length, native.discDeaths.length);
    for (let index = 0; index < Math.max(actual.discDeaths.length, native.discDeaths.length); index++) {
      const death = actual.discDeaths[index];
      const expected = native.discDeaths[index];
      if (!death || !expected) {
        discrete(tick, 'death', index, 'presence', death !== undefined, expected !== undefined);
        continue;
      }
      for (const field of ['i', 'f', 'm']) discrete(tick, 'death', index, field, death[field], expected[field]);
      for (const field of ['x', 'y', 'xv', 'yv']) numeric(tick, 'death', index, field, death[field], expected[field]);
    }
  }
  try {
    native = oracle.createNewState(roster, map, 1, false, null, settings, true);
    native.rc = 0;
    report.initialNativeDiscs = native.discs.map((disc) =>
      disc ? { x: disc.x, y: disc.y, energy: disc.a1a } : undefined,
    );
    const arena = toArena(native, map);
    session = createNativeModeSession({
      arena,
      players: clone(roster),
      seed: 1,
      mode: scenario.mode,
      roundsToWin: 3,
      countdownTicks: scenario.countdownTicks ?? 60,
    });
    check(0);
    for (let tick = 1; tick <= tickCount && report.firstMismatch === null; tick++) {
      const previous = native;
      const inputs = inputsFor(scenario.kind, tick);
      if (scenario.kind === 'arrow-first-charge') {
        const source = native.discs[0];
        report.coverage.preStepNative = {
          rl: native.rl,
          discs: source
            ? [
                {
                  x: source.x,
                  y: source.y,
                  xv: source.xv,
                  yv: source.yv,
                  a1a: source.a1a,
                  ds: source.ds,
                  da: source.da,
                },
              ]
            : [],
        };
      }
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
      const stepped = session.stepWithEvents(inputs);
      observeCoverage(scenario, previous, native, stepped.state, stepped.events, report.coverage);
      check(tick);
    }
    if (!options.perturb) {
      report.coverageFailures = coverageFailures(scenario, report.coverage, tickCount, report.ticks);
      for (const failure of report.coverageFailures) mismatch({ tick: report.ticks, ...failure });
    }
    report.pass = report.firstMismatch === null;
    report.status = report.pass ? 'PASS' : 'FAIL';
    report.provenance = oracle.provenance;
    return report;
  } finally {
    session?.dispose();
    oracle.dispose();
  }
}

function compareNativeModeSession(paths, options = {}) {
  const selected = options.negativeControlOnly
    ? []
    : ALL_SCENARIOS.filter(
        (scenario) =>
          (options.regression ? REGRESSION_SCENARIOS.includes(scenario) : SCENARIOS.includes(scenario)) &&
          (!options.scenarioNames?.length || options.scenarioNames.includes(scenario.name)),
      );
  const scenarios = [];
  for (const scenario of selected) {
    try {
      scenarios.push(createRun(paths, scenario, options));
    } catch (error) {
      scenarios.push({
        name: scenario.name,
        kind: scenario.kind,
        mode: scenario.mode,
        quality: scenario.quality,
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
  let provenance = scenarios.find((scenario) => scenario.provenance)?.provenance;
  if (options.negativeControl) {
    const scenario = SCENARIOS.find((entry) => entry.name === 'arrow-charge-expiry-ar-q1');
    const control = createRun(paths, scenario, { tickLimit: 1, perturb: true });
    provenance ||= control.provenance;
    negativeControl = {
      name: 'injected-local-disc-xv-error',
      injectedError: 1e-6,
      detected:
        control.firstMismatch?.entity === 'disc' &&
        control.firstMismatch?.field === 'xv' &&
        control.firstMismatch?.error > TOLERANCE,
      firstMismatch: control.firstMismatch,
    };
    negativeControl.pass = negativeControl.detected;
  }
  const totals = {
    scenarios: scenarios.length,
    passed: scenarios.filter((scenario) => scenario.pass).length,
    failed: scenarios.filter((scenario) => !scenario.pass).length,
    ticks: scenarios.reduce((sum, scenario) => sum + scenario.ticks, 0),
    frames: scenarios.reduce((sum, scenario) => sum + scenario.frames, 0),
    comparisons: scenarios.reduce((sum, scenario) => sum + scenario.comparisons, 0),
    numericComparisons: scenarios.reduce((sum, scenario) => sum + scenario.numericComparisons, 0),
    discreteComparisons: scenarios.reduce((sum, scenario) => sum + scenario.discreteComparisons, 0),
    maximumAbsoluteError: scenarios.reduce((maximum, scenario) => Math.max(maximum, scenario.maxError), 0),
    coverageFailures: scenarios.reduce((sum, scenario) => sum + (scenario.coverageFailures?.length || 0), 0),
    localRepairOrReseeds: scenarios.reduce((sum, scenario) => sum + scenario.localRepairOrReseeds, 0),
    rollovers: scenarios.reduce((sum, scenario) => sum + (scenario.coverage?.rollovers || 0), 0),
  };
  const pass = scenarios.every((scenario) => scenario.pass) && (negativeControl === null || negativeControl.pass);
  return {
    schema: 'bonk-rl-env.native-mode-session-differential',
    version: 1,
    pass,
    status: pass ? 'PASS' : 'FAIL',
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    publicEngineParityClaimed: false,
    originalOnlyExpectedValues: true,
    freshCreateNewStateEveryScenario: true,
    scope: SCOPE,
    provenance: {
      ...provenance,
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localFiles: Object.fromEntries(LOCAL_FILES.map((file) => [file, digest(path.join(ROOT, file))])),
    },
    scenarioNames: options.scenarioNames || [],
    tickLimit: options.tickLimit ?? null,
    scenarios,
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
  const report = compareNativeModeSession(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  return report;
}
module.exports = {
  SCENARIOS,
  SCOPE,
  TOLERANCE,
  bits,
  configureMap,
  inputsFor,
  parseArguments,
  coverageFailures,
  createRun,
  compareNativeModeSession,
  main,
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
          schema: 'bonk-rl-env.native-mode-session-differential',
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
