'use strict';

// Original raw createNewState -> raw-map adapter -> native session differential.
// Every expected value is read from the pinned original, never from local helpers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');

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
  ['alive', () => true],
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
  ['ds', (disc) => disc.ds],
  ['da', (disc) => disc.da],
  ['vt', (disc) => disc.vt],
];
const LOCAL_FILES = [
  'src/core/native-map-session.ts',
  'src/core/native-map-codec.ts',
  'src/core/native-map-state.ts',
  'src/core/native-session.ts',
  'src/core/native-spawns.ts',
  'src/core/classic-physics.ts',
  'src/core/safe-trig.ts',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}
function settingsFor(map, teams, balances) {
  return { ga: 'b', mo: 'b', tea: teams, bal: balances, map, gt: 2, wl: 3, q: false, maps: [] };
}
function spawn(x, y, values = {}) {
  return { x, y, xv: 0, yv: 0, priority: 1, r: true, f: true, b: true, gr: false, ye: false, n: 'spawn', ...values };
}
function bodyAt(map, x, y, angle, fixtureIds) {
  return {
    ...clone(map.physics.bodies[0]),
    p: [x, y],
    a: angle,
    fx: fixtureIds,
    cf: { x: 0, y: 0, ct: 0, w: true },
    fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 },
  };
}
function makeGeometryMap(training, kind, quality) {
  const map = clone(training);
  map.m.mo = 'b';
  map.s.pq = quality;
  map.s.re = kind === 'respawn';
  // This scenario is named for its original disc-disc contact coverage. Team
  // geometry must use the normal native collision path, not inherit nc=true.
  map.s.nc = false;
  map.s.fl = kind === 'fly';
  if (
    kind === 'training' ||
    kind === 'collision' ||
    kind === 'lethal' ||
    kind === 'rollover' ||
    kind === 'respawn' ||
    kind === 'fly' ||
    kind === 'signed-friction' ||
    kind === 'restitution-over-one'
  ) {
    map.spawns[0].xv = 18;
    map.spawns[0].yv = -12;
    if (kind === 'signed-friction' || kind === 'restitution-over-one') {
      // Same contact-bearing map and spawn as the Classic material differential,
      // now exercised through the strict raw-map/session integration seam.
      map.spawns = [{ ...map.spawns[0], x: 0, y: -24, xv: 12, yv: -36, priority: 1 }];
      Object.assign(
        map.physics.fixtures[0],
        kind === 'signed-friction' ? { fr: -0.3, fp: false, re: 0 } : { fr: 0.5, fp: false, re: 1.25 },
      );
    }
    if (kind === 'collision') {
      map.spawns[0] = { ...map.spawns[0], x: -35, y: -100, xv: 12, yv: 0 };
      map.spawns[1] = { ...map.spawns[1], x: 35, y: -100, xv: -12, yv: 0 };
    }
    if (kind === 'lethal') {
      map.physics.fixtures[0].d = true;
      for (const s of map.spawns) s.y = -20;
    }
    if (kind === 'respawn') {
      map.physics.shapes = [];
      map.physics.fixtures = [];
      map.physics.bodies = [];
      map.physics.bro = [];
      // Add a non-empty static body away from the fall trajectories; no empty
      // map is synthesized and out-of-world respawn is exercised natively.
      map.physics.shapes = [{ type: 'ci', r: 12, c: [0, 0], sk: false }];
      map.physics.fixtures = [{ ...clone(training.physics.fixtures[0]), sh: 0, np: false, ng: false, ig: false }];
      map.physics.bodies = [bodyAt(training, 500, 300, 0, [0])];
      map.physics.bro = [0];
      map.spawns = [spawn(-500, -220, { xv: -250 }), spawn(500, -220, { xv: 250 })];
    }
    return map;
  }

  const base = clone(training.physics.fixtures[0]);
  const baseBody = clone(training.physics.bodies[0]);
  map.physics.ppm = 10;
  map.physics.shapes = [
    { type: 'bx', c: [18, -6], a: 0.23, w: 360, h: 28, sk: false },
    { type: 'ci', c: [-70, -22], r: 45, sk: false },
    {
      type: 'po',
      c: [8, 12],
      a: -0.31,
      s: 0.75,
      sk: false,
      v: [
        [-120, -30],
        [110, -30],
        [110, 40],
        [0, 5],
        [-120, 40],
      ],
    },
  ];
  map.physics.fixtures = [
    {
      ...base,
      sh: 0,
      n: 'rotated box',
      fr: null,
      fp: null,
      re: null,
      de: null,
      f: 111,
      d: false,
      np: false,
      ng: false,
      ig: false,
    },
    {
      ...base,
      sh: 1,
      n: 'circle',
      fr: 0.25,
      fp: false,
      re: 0.4,
      de: 0.7,
      f: 222,
      d: false,
      np: false,
      ng: false,
      ig: false,
    },
    {
      ...base,
      sh: 2,
      n: 'concave polygon',
      fr: null,
      fp: false,
      re: 0.8,
      de: null,
      f: 333,
      d: false,
      np: false,
      ng: false,
      ig: false,
    },
  ];
  map.physics.bodies = [
    bodyAt({ physics: { bodies: [baseBody] } }, -20, 70, 0.17, [0, 1]),
    bodyAt({ physics: { bodies: [baseBody] } }, 120, 20, -0.12, [2]),
  ];
  // Native Physics.step reads every normalized shape slot's `sk` after the
  // countdown. Keep these original-trajectory tables dense; sparse IDs/order
  // are covered independently by native-map-session.test.ts. Physics uses
  // bodies[] order; bro's noncanonical renderer order is preserved here.
  map.physics.bro = [1, 0];
  map.physics.joints = [];
  map.spawns = [spawn(-80, -10, { xv: 25, yv: -15, priority: 6 }), spawn(65, -35, { xv: -18, yv: 10, priority: 5 })];
  if (kind === 'teams') {
    map.spawns[0].r = true;
    map.spawns[0].f = false;
    map.spawns[0].b = false;
    map.spawns[1].r = false;
    map.spawns[1].f = false;
    map.spawns[1].b = true;
  }
  return map;
}

const SCENARIOS = Object.freeze([
  ...[1, 2].map((quality) => ({
    name: `training-q${quality}`,
    kind: 'training',
    quality,
    ticks: 330,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  ...[1, 2].map((quality) => ({
    name: `geometry-q${quality}`,
    kind: 'geometry',
    quality,
    ticks: 210,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  ...[1, 2].map((quality) => ({
    name: `collision-q${quality}`,
    kind: 'collision',
    quality,
    ticks: 180,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  ...[1, 2].map((quality) => ({
    name: `lethal-q${quality}`,
    kind: 'lethal',
    quality,
    ticks: 200,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  ...[1, 2].map((quality) => ({
    name: `rollover-q${quality}`,
    kind: 'rollover',
    quality,
    ticks: 500,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  ...['signed-friction', 'restitution-over-one'].flatMap((kind) =>
    [1, 2].map((quality) => ({
      name: `${kind}-q${quality}`,
      kind,
      quality,
      ticks: 180,
      ids: [0, 1],
      teams: [1, 1],
      teamsEnabled: false,
    })),
  ),
  ...[1, 2].map((quality) => ({
    name: `respawn-q${quality}`,
    kind: 'respawn',
    quality,
    ticks: 150,
    ids: [0, 1],
    teams: [1, 1],
    teamsEnabled: false,
  })),
  { name: 'sparse-teams', kind: 'teams', quality: 2, ticks: 150, ids: [2, 7], teams: [2, 3], teamsEnabled: true },
  { name: 'fly', kind: 'fly', quality: 1, ticks: 120, ids: [0, 1], teams: [1, 1], teamsEnabled: false },
]);

function inputsFor(scenario, tick) {
  const result = scenario.ids.map(() => 0);
  if (scenario.kind === 'training' || scenario.kind === 'rollover' || scenario.kind === 'respawn')
    result[0] = tick % 100 < 45 ? 2 : tick % 100 < 75 ? 1 : 0;
  if (scenario.kind === 'geometry' || scenario.kind === 'teams') {
    result[0] = tick < 55 ? 2 : tick < 105 ? 4 : tick < 150 ? 1 : 0;
    result[1] = tick < 70 ? 1 : tick < 120 ? 8 : 2;
  }
  if (scenario.kind === 'collision') {
    result[0] = 0;
    result[1] = 0;
  }
  if (scenario.kind === 'fly') result[0] = 4;
  if (scenario.kind === 'lethal') result[0] = tick % 70 < 30 ? 4 : 0;
  return result;
}

function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = {
    ticks: null,
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
        assert(
          SCENARIOS.some((scenario) => scenario.name === value),
          `Unknown scenario ${value}`,
        );
        options.scenarioNames.push(value);
      }
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  const missing = [];
  if (!values.box2d) missing.push('--box2d / BOX2D_REFERENCE_FILE');
  if (!values.trig) missing.push('--safe-trig / SAFETRIG_REFERENCE_FILE');
  if (missing.length && !options.help) {
    const error = new Error(`BLOCKED: original native dependencies required: ${missing.join(', ')}`);
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

function compareArena(report, localArena, native) {
  const { discrete, numeric } = report;
  discrete(0, 'arena', null, 'ppm', localArena.ppm, native.physics.ppm);
  discrete(0, 'arena', null, 'respawn', localArena.settings.respawn, native.ms.re);
  discrete(0, 'arena', null, 'noCollision', localArena.settings.noCollision, native.ms.nc);
  discrete(0, 'arena', null, 'fly', localArena.settings.fly, native.ms.fl);
  discrete(0, 'arena', null, 'quality', localArena.settings.quality, native.ms.pq);
  const platforms = [];
  for (let bodyId = 0; bodyId < native.physics.bodies.length; bodyId++) {
    const body = native.physics.bodies[bodyId];
    if (!body) continue;
    discrete(0, 'body', bodyId, 'type', 's', body.s.type);
    for (const fixtureId of body.fx) {
      const fixture = native.physics.fixtures[fixtureId];
      const shape = native.physics.shapes[fixture.sh];
      const local = localArena.platforms.find((platform) => platform.id === fixtureId && platform.bodyId === bodyId);
      discrete(0, 'fixture', fixtureId, 'present', local !== undefined, true);
      if (!local) continue;
      platforms.push(local);
      discrete(
        0,
        'fixture',
        fixtureId,
        'shape',
        local.shape,
        shape.type === 'bx' ? 'box' : shape.type === 'ci' ? 'circle' : 'polygon',
      );
      numeric(0, 'body', bodyId, 'bodyX', local.bodyX, body.p[0]);
      numeric(0, 'body', bodyId, 'bodyY', local.bodyY, body.p[1]);
      numeric(0, 'body', bodyId, 'bodyAngle', local.bodyAngle, body.a);
      const localAngle = shape.type === 'po' ? 0 : shape.a || 0;
      const localX = shape.type === 'po' ? 0 : shape.c[0];
      const localY = shape.type === 'po' ? 0 : shape.c[1];
      numeric(0, 'fixture', fixtureId, 'localX', local.localX, localX);
      numeric(0, 'fixture', fixtureId, 'localY', local.localY, localY);
      numeric(0, 'fixture', fixtureId, 'localAngle', local.localAngle, localAngle);
      numeric(
        0,
        'fixture',
        fixtureId,
        'friction',
        local.friction,
        (fixture.fr !== null && fixture.fr !== undefined ? fixture.fr : body.s.fric) *
          ((fixture.fp !== null && fixture.fp !== undefined ? fixture.fp : body.s.fricp) ? -1 : 1),
      );
      numeric(
        0,
        'fixture',
        fixtureId,
        'restitution',
        local.restitution,
        fixture.re !== null && fixture.re !== undefined ? fixture.re : body.s.re,
      );
      discrete(0, 'fixture', fixtureId, 'lethal', local.lethal, fixture.d === true);
      discrete(0, 'fixture', fixtureId, 'color', local.color, fixture.f);
      if (shape.type === 'bx') {
        numeric(0, 'shape', fixture.sh, 'width', local.width, shape.w);
        numeric(0, 'shape', fixture.sh, 'height', local.height, shape.h);
      } else if (shape.type === 'ci') numeric(0, 'shape', fixture.sh, 'radius', local.radius, shape.r);
      else {
        discrete(0, 'shape', fixture.sh, 'vertexCount', local.vertices.length, shape.v.length);
        for (let index = 0; index < shape.v.length; index++) {
          numeric(0, 'shape', fixture.sh, `v[${index}].x`, local.vertices[index][0], shape.v[index][0]);
          numeric(0, 'shape', fixture.sh, `v[${index}].y`, local.vertices[index][1], shape.v[index][1]);
        }
      }
    }
  }
  discrete(0, 'arena', null, 'platformCount', localArena.platforms.length, platforms.length);
}

function observeCoverage(scenario, native, previous, coverage, tick) {
  if (previous.ftu === -1) coverage.simulatedTicks++;
  if (native.fte >= 0) coverage.resultTicks++;
  if (native.rc > coverage.maxRound) {
    coverage.rollovers++;
    coverage.rolloverTicks.push(tick);
    coverage.postRolloverCountdowns.push(native.ftu);
  }
  coverage.maxRound = Math.max(coverage.maxRound, native.rc);
  for (const death of native.discDeaths) {
    if (death.f !== 0) continue;
    coverage.deaths++;
    if (death.m === 1) coverage.lethalDeaths++;
    if (death.m === 4) coverage.oobDeaths++;
  }
  for (const disc of native.discs) {
    if (!disc) continue;
    coverage.minEnergy = Math.min(coverage.minEnergy, disc.a1a);
    if (disc.a1) coverage.heavyTicks++;
    if (disc.ni) coverage.respawns++;
    if (disc.lhid >= 0 && disc.lht > 0) coverage.contactTicks++;
    if (disc.yv < -4) coverage.jumpTicks++;
    if (Math.abs(disc.xv) + Math.abs(disc.yv) > 0) coverage.movingTicks++;
    if (disc.yv < coverage.minReboundYv) coverage.minReboundYv = disc.yv;
  }
}

function createRun(paths, scenario, options = {}) {
  const oracle = createOracle(paths);
  const { createNativeMapSession, nativeMapToStaticArena } = require('../../src/core/native-map-session.ts');
  const ticks = Math.min(options.ticks ?? scenario.ticks, scenario.ticks);
  const map = makeGeometryMap(
    clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'))),
    scenario.kind,
    scenario.quality,
  );
  const roster = scenario.ids.map((id, index) => ({ id, team: scenario.teams[index] }));
  const balances = [];
  for (const id of scenario.ids) balances[id] = 0;
  const settings = settingsFor(map, scenario.teamsEnabled, balances);
  let native;
  let session;
  const report = {
    name: scenario.name,
    kind: scenario.kind,
    quality: scenario.quality,
    seed: 1,
    ids: scenario.ids,
    requestedTicks: scenario.ticks,
    comparedTicks: 0,
    effectiveTickLimit: ticks,
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
      maxRound: 0,
      initialCountdown: null,
      rolloverTicks: [],
      postRolloverCountdowns: [],
      postRolloverSimulationTicks: 0,
      discContactEvents: 0,
      deaths: 0,
      lethalDeaths: 0,
      oobDeaths: 0,
      respawns: 0,
      contactTicks: 0,
      jumpTicks: 0,
      heavyTicks: 0,
      movingTicks: 0,
      minEnergy: 1000,
      minReboundYv: 0,
    },
    coverageFailures: [],
  };
  const mismatch = (entry) => {
    if (report.firstMismatch === null) report.firstMismatch = entry;
    if (report.mismatches.length < 20) report.mismatches.push(entry);
    report.pass = false;
    report.status = 'FAIL';
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
    if (!Number.isFinite(error)) {
      mismatch({ tick, entity, id, field, actual, native: expected, error: 'non-finite' });
      return;
    }
    report.maxError = Math.max(report.maxError, error);
    const key = `${entity}.${field}`;
    report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] || 0, error);
    if (error > TOLERANCE) mismatch({ tick, entity, id, field, actual, native: expected, error });
  };
  try {
    native = oracle.createNewState(roster, map, 1, false, null, settings, true);
    native.rc = 0;
    report.coverage.initialCountdown = native.ftu;
    const arena = nativeMapToStaticArena(clone(map));
    compareArena({ discrete, numeric }, arena, native);
    session = createNativeMapSession({
      map: clone(map),
      players: clone(roster),
      seed: 1,
      teamsEnabled: scenario.teamsEnabled,
      roundsToWin: 3,
      countdownTicks: 60,
    });
    const check = (tick) => {
      report.comparedTicks = tick;
      report.frames = tick + 1;
      const actual = session.getState();
      for (const field of ['seed', 'ftu', 'fte', 'rl', 'rc', 'lscr'])
        discrete(tick, 'state', null, field, actual[field], native[field]);
      const maxLength = Math.max(actual.discs.length, native.discs.length);
      for (let id = 0; id < maxLength; id++) {
        const local = actual.discs[id];
        const expected = native.discs[id];
        const nativeAlive = expected !== undefined && expected !== null;
        const localAlive = local !== undefined && local.alive === true;
        discrete(tick, 'disc', id, 'presentAlive', localAlive, nativeAlive);
        if (!nativeAlive || !localAlive) continue;
        for (const [field, nativeField] of DISC_NUMERIC) {
          let value = local[field];
          if (options.perturb && tick === 1 && id === scenario.ids[0] && field === 'xv') value += 1e-6;
          numeric(tick, 'disc', id, field, value, expected[nativeField]);
        }
        for (const [field, read] of DISC_DISCRETE) discrete(tick, 'disc', id, field, local[field], read(expected));
      }
      const scoreCount = Math.max(actual.scores.length, native.scores.length);
      for (let id = 0; id < scoreCount; id++)
        discrete(tick, 'score', id, 'value', actual.scores[id] ?? null, native.scores[id] ?? null);
      discrete(tick, 'deaths', null, 'length', actual.discDeaths.length, native.discDeaths.length);
      for (let index = 0; index < Math.max(actual.discDeaths.length, native.discDeaths.length); index++) {
        const local = actual.discDeaths[index];
        const expected = native.discDeaths[index];
        if (!local || !expected) {
          discrete(tick, 'death', index, 'present', local !== undefined, expected !== undefined);
          continue;
        }
        discrete(tick, 'death', index, 'i', local.i, expected.i);
        discrete(tick, 'death', index, 'f', local.f, expected.f);
        discrete(tick, 'death', index, 'm', local.m, expected.m);
        for (const field of ['x', 'y', 'xv', 'yv']) numeric(tick, 'death', index, field, local[field], expected[field]);
      }
      for (let bodyId = 0; bodyId < native.physics.bodies.length; bodyId++) {
        const body = native.physics.bodies[bodyId];
        if (!body) continue;
        const local = actual.platforms.find((platform) => platform.bodyId === bodyId);
        discrete(tick, 'body', bodyId, 'present', local !== undefined, true);
        if (!local) continue;
        numeric(tick, 'body', bodyId, 'x', local.bodyX, body.p[0]);
        numeric(tick, 'body', bodyId, 'y', local.bodyY, body.p[1]);
        numeric(tick, 'body', bodyId, 'angle', local.bodyAngle, body.a);
        numeric(tick, 'body', bodyId, 'vx', 0, body.lv[0]);
        numeric(tick, 'body', bodyId, 'vy', 0, body.lv[1]);
        numeric(tick, 'body', bodyId, 'av', 0, body.av);
      }
    };
    check(0);
    for (let tick = 1; tick <= ticks && report.firstMismatch === null; tick++) {
      const inputs = inputsFor(scenario, tick);
      const previous = native;
      // Native prevState is indexed by player ID, not by dense roster position.
      // Preserve sparse IDs so each disc receives the same controls as the session.
      const nativeInputs = {};
      scenario.ids.forEach((id, index) => {
        nativeInputs[id] = bits(inputs[index]);
      });
      native = oracle.stepWithContactObserver(native, nativeInputs, null, 30, settings, 1, false, undefined);
      const contacts = oracle.consumeContactObservations();
      if (
        contacts.some(
          (contact) => contact.fixtureA === 'discbody' && contact.fixtureB === 'discbody' && contact.touching,
        )
      )
        report.coverage.discContactEvents++;
      const inputRecord = {};
      scenario.ids.forEach((id, index) => {
        inputRecord[id] = inputs[index];
      });
      session.step(inputRecord);
      observeCoverage(scenario, native, previous, report.coverage, tick);
      if (previous.rc > 0 && previous.ftu === -1) report.coverage.postRolloverSimulationTicks++;
      check(tick);
    }
    if (!options.perturb) {
      const fullLengthRun = ticks === scenario.ticks;
      if (report.comparedTicks !== ticks)
        report.coverageFailures.push({
          field: 'coverage',
          expected: `${ticks} uncompromised ticks`,
          actual: report.comparedTicks,
        });
      if (fullLengthRun && report.coverage.simulatedTicks === 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'simulated ticks' });
      if (report.coverage.movingTicks === 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'nonzero native movement' });
      if (scenario.kind === 'collision' && report.coverage.discContactEvents === 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'observed original disc-disc fixture contact' });
      if (scenario.kind === 'lethal' && report.coverage.lethalDeaths === 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'native lethal death' });
      if (scenario.kind === 'lethal' && report.coverage.resultTicks === 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'native result phase' });
      if (scenario.kind === 'respawn' && (report.coverage.oobDeaths === 0 || report.coverage.respawns === 0))
        report.coverageFailures.push({ field: 'coverage', expected: 'native OOB immediate respawn' });
      if (scenario.kind === 'restitution-over-one' && report.coverage.minReboundYv >= 0)
        report.coverageFailures.push({ field: 'coverage', expected: 'native rebound from restitution > 1' });
      if (scenario.kind === 'rollover') {
        if (report.coverage.rollovers === 0)
          report.coverageFailures.push({ field: 'coverage', expected: 'native round rollover' });
        if (report.coverage.postRolloverCountdowns.some((ftu) => ftu !== 90))
          report.coverageFailures.push({
            field: 'coverage',
            expected: 'native post-rollover countdown 90',
            actual: report.coverage.postRolloverCountdowns,
          });
        if (report.coverage.initialCountdown !== 60)
          report.coverageFailures.push({
            field: 'coverage',
            expected: 'native initial testing countdown 60',
            actual: report.coverage.initialCountdown,
          });
        if (fullLengthRun && report.coverage.postRolloverSimulationTicks === 0)
          report.coverageFailures.push({
            field: 'coverage',
            expected: 'native simulation after 90-tick post-rollover countdown',
          });
      }
      if (scenario.kind === 'teams' && report.coverage.rollovers > 0)
        report.coverageFailures.push({
          field: 'coverage',
          expected: 'no uncontrolled round in team geometry scenario',
        });
      for (const failure of report.coverageFailures) mismatch({ tick: report.comparedTicks, ...failure });
    }
    report.pass = report.firstMismatch === null;
    report.status = report.pass ? 'PASS' : 'FAIL';
    report.originalProvenance = oracle.provenance;
    return report;
  } catch (error) {
    report.pass = false;
    report.status = 'ERROR';
    report.error = { message: error.message, stack: error.stack };
    return report;
  } finally {
    session?.dispose();
    oracle.dispose();
  }
}

function compareNativeMapSession(paths, options = {}) {
  const scenarios = SCENARIOS.filter(
    (scenario) => options.scenarioNames.length === 0 || options.scenarioNames.includes(scenario.name),
  );
  const results = options.negativeControlOnly ? [] : scenarios.map((scenario) => createRun(paths, scenario, options));
  let negativeControl = null;
  if (options.negativeControl) {
    negativeControl = createRun(paths, SCENARIOS[0], { ...options, ticks: 1, perturb: true });
    negativeControl.name = 'negative-control-injected-xv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch?.field === 'xv' && negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
    negativeControl.status = negativeControl.pass ? 'PASS' : 'FAIL';
    delete negativeControl.error;
  }
  return {
    schema: 'bonk-rl-env.native-map-session-original-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (negativeControl === null || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    localRepairOrReseeds: 0,
    scope:
      'Strict raw static Classic native maps through pinned original createNewState, independent local raw-map conversion and full native session. Original normalized arena and every original/local session tick compared, including required rollover countdown/reset and signed-material contact scenarios. Dynamic/kinematic maps, joints, forces, shrink, np/ng/ig, nondefault masks, capZones, non-Classic modes, friction above 1, negative restitution, malformed polygons and presentation-only fixture fields are explicitly outside scope and rejected by the adapter. Short --ticks runs check trajectories for the requested prefix; full scenario coverage gates apply only when the complete scenario length is requested.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localFiles: Object.fromEntries(LOCAL_FILES.map((file) => [file, digest(path.join(ROOT, file))])),
    },
    scenarios: results,
    negativeControl,
    totals: {
      scenarios: results.length,
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
      'Usage: npx tsx validation/native/compare-native-map-session.cjs --box2d <file> --safe-trig <file> [--scenario name] [--ticks n] [--negative-control] [--out new-report.json]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Missing native dependency ${file}`);
  const report = compareNativeMapSession(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { SCENARIOS, TOLERANCE, parseArguments, makeGeometryMap, createRun, compareNativeMapSession, main };
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
