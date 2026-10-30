'use strict';

// Bounded original-native differential for the isolated Arrow/Death Arrow/VTOL
// slice. Expected trajectories always come from pinned raw Physics.step.
// Controlled seeds establish native input state only; they are never oracles.
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
];
const DISC_DISCRETE = [
  ['energy', (disc) => disc.a1a],
  ['heavy', (disc) => disc.a1 === true],
  ['lhid', (disc) => disc.lhid],
  ['lht', (disc) => disc.lht],
  ['ni', (disc) => disc.ni === true],
  ['ds', (disc) => disc.ds],
  ['da', (disc) => disc.da],
  ['vt', (disc) => disc.vt],
  ['swing.b', (disc) => (disc.swing ? disc.swing.b : undefined)],
];
const DISC_SWING_NUMERIC = [
  ['swing.p0', (disc) => (disc.swing ? disc.swing.p[0] : undefined)],
  ['swing.p1', (disc) => (disc.swing ? disc.swing.p[1] : undefined)],
  ['swing.l', (disc) => (disc.swing ? disc.swing.l : undefined)],
];
const PROJECTILE_NUMERIC = ['x', 'y', 'xv', 'yv', 'a', 'av'];
const PROJECTILE_DISCRETE = ['fte', 'did', 'type', 'team'];
const SCOPE =
  'Pinned original alpha2s createNewState/Physics.step versus only src/core/classic-physics.ts on static box fixtures and controlled native input states. Covers declared Arrow/Death Arrow/VTOL/Grapple/Simple scenarios; not public PhysicsEngine/environment integration, dynamic maps, match/round lifecycle, complete modes, online play, or cross-platform bit parity.';

function bits(value) {
  return Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
}

function matrix(kind, group, defaults = {}) {
  const modes = group === 'vtol' ? ['v'] : group === 'grapple' ? ['sp'] : group === 'simple' ? ['bs'] : ['ar', 'ard'];
  return modes.flatMap((mode) =>
    [1, 2].map((quality) => ({
      name: `${kind}-${mode}-q${quality}`,
      kind,
      group,
      mode,
      quality,
      ...defaults,
    })),
  );
}

const SCENARIOS = Object.freeze([
  ...matrix('arrow-charge-release', 'arrow', { ticks: 422, boundary: 'fresh-createNewState-countdown' }),
  ...matrix('arrow-aim-simultaneous', 'arrow', { ticks: 1, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-owner-ffa', 'arrow', { ticks: 6, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-disc-impact', 'arrow', { ticks: 8, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-team-filter', 'arrow', { ticks: 8, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-world-impact', 'arrow', { ticks: 8, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-projectile-expiry', 'arrow', { ticks: 4, boundary: 'controlled-native-state-seed' }),
  ...matrix('arrow-dual-release', 'arrow', { ticks: 1, boundary: 'controlled-native-state-seed' }),
  ...matrix('vtol-directional', 'vtol', { ticks: 145, boundary: 'fresh-createNewState-countdown' }),
  ...matrix('vtol-rotated', 'vtol', { ticks: 48, boundary: 'controlled-native-state-seed' }),
  ...matrix('vtol-wing-world', 'vtol', { ticks: 8, boundary: 'controlled-native-state-seed' }),
  ...matrix('vtol-wing-kinematics', 'vtol', { ticks: 8, boundary: 'controlled-native-state-seed' }),
  ...matrix('vtol-disc-collision', 'vtol', { ticks: 12, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-acquire-static', 'grapple', { ticks: 200, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-acquire-inner', 'grapple', { ticks: 60, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-acquire-nograpple', 'grapple', { ticks: 60, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-slack-taut', 'grapple', { ticks: 240, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-release-button', 'grapple', { ticks: 200, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-break-collision', 'grapple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-break-impulse', 'grapple', { ticks: 60, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-energy-depletion', 'grapple', { ticks: 400, boundary: 'controlled-native-state-seed' }),
  ...matrix('grapple-target-death', 'grapple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  ...matrix('simple-movement', 'simple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  ...matrix('simple-heavy-frozen', 'simple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  ...matrix('simple-energy-frozen', 'simple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  ...matrix('simple-disc-collision', 'simple', { ticks: 120, boundary: 'controlled-native-state-seed' }),
  // W6: seed/roster/balance sweeps. Nonzero balances exercise the native
  // radius scaling (localDiscs mirrors 1 + clamp(bal/100)); multi-player
  // rosters and alternate seeds exercise spawn deal order beyond seed 1.
  {
    name: 'sweep-balance-positive-b-q1',
    kind: 'sweep-balance-positive',
    group: 'sweep',
    mode: 'b',
    quality: 1,
    seed: 1,
    ticks: 120,
    boundary: 'controlled-native-state-seed',
    balances: [50, 50],
  },
  {
    name: 'sweep-balance-negative-b-q1',
    kind: 'sweep-balance-negative',
    group: 'sweep',
    mode: 'b',
    quality: 1,
    seed: 1,
    ticks: 120,
    boundary: 'controlled-native-state-seed',
    balances: [-80, -80],
  },
  {
    name: 'sweep-roster-three-b-q1',
    kind: 'sweep-roster-three',
    group: 'sweep',
    mode: 'b',
    quality: 1,
    seed: 7,
    ticks: 120,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'sweep-roster-four-teams-b-q1',
    kind: 'sweep-roster-four-teams',
    group: 'sweep',
    mode: 'b',
    quality: 1,
    seed: 13,
    ticks: 120,
    boundary: 'controlled-native-state-seed',
  },
  {
    name: 'sweep-seed-97-b-q1',
    kind: 'sweep-seed-97',
    group: 'sweep',
    mode: 'b',
    quality: 1,
    seed: 97,
    ticks: 120,
    boundary: 'controlled-native-state-seed',
  },
]);

function teamsFor(kind) {
  if (kind === 'arrow-team-filter') return [2, 2, 3];
  if (kind === 'arrow-dual-release') return [2, 3];
  if (kind.startsWith('vtol')) return kind === 'vtol-disc-collision' ? [1, 1] : [1];
  if (kind === 'grapple-break-collision') return [1, 2];
  if (kind === 'simple-disc-collision') return [1, 2];
  if (kind === 'sweep-roster-three') return [1, 1, 2];
  if (kind === 'sweep-roster-four-teams') return [2, 2, 3, 3];
  return [1, 1];
}

function usage() {
  return [
    'Usage: node validation/native/compare-native-modes.cjs --box2d <file> --safe-trig <file> [options]',
    '  --raw <file>             Pinned alpha2s.raw.js (or BONK_RAW_REFERENCE_FILE)',
    '  --group arrow|vtol|grapple|simple|all   Scenario group (default: all)',
    '  --scenario <name>        Exact scenario name; repeatable',
    '  --ticks <1..3600>        Per-scenario tick cap; unmet coverage still fails',
    '  --negative-control       Inject a local 1e-6 projectile-xv error and require detection',
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
    group: 'all',
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
    if (argument === '--group') {
      options.group = argv[++index];
      assert(
        ['arrow', 'vtol', 'grapple', 'simple', 'sweep', 'all'].includes(options.group),
        '--group must be arrow, vtol, grapple, simple, sweep, or all',
      );
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

function localDiscs(native, balances) {
  const discs = [];
  for (let id = 0; id < native.discs.length; id++) {
    const disc = native.discs[id];
    if (!disc) continue;
    discs.push({
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
      radius: 1 + Math.max(-0.95, Math.min(1, (balances[id] || 0) / 100)),
      energy: disc.a1a,
      heavy: disc.a1 === true,
      alive: true,
      lhid: disc.lhid,
      lht: disc.lht,
      ni: disc.ni === true,
      ds: disc.ds,
      da: disc.da,
      vt: disc.vt,
      ...(disc.swing ? { swing: { b: disc.swing.b, p: [...disc.swing.p], l: disc.swing.l } } : {}),
    });
  }
  return discs;
}

// Adapter for original normalized static values, not a production map loader.
function localPlatforms(native) {
  const platforms = [];
  native.physics.bodies.forEach((body, bodyId) => {
    if (!body) return;
    assert.equal(body.s.type, 's', 'Mode differential supports static bodies only');
    for (const fixtureIndex of body.fx) {
      const fixture = native.physics.fixtures[fixtureIndex];
      const shape = native.physics.shapes[fixture.sh];
      assert(shape.type === 'bx' || shape.type === 'ci', 'Mode differential supports box/circle fixtures only');
      const localAngle = shape.type === 'bx' ? shape.a || 0 : 0;
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
        ...(fixture.ng === true ? { noGrapple: true } : {}),
        ...(fixture.ig === true ? { innerGrapple: true } : {}),
      });
    }
  });
  return platforms;
}

function setDisc(disc, values) {
  Object.assign(disc, values);
  if (values.x !== undefined) disc.sx = values.x;
  if (values.y !== undefined) disc.sy = values.y;
  if (values.xv !== undefined) disc.sxv = values.xv;
  if (values.yv !== undefined) disc.syv = values.yv;
}

function activate(state) {
  state.ftu = -1;
  state.fte = -1;
}

function configureMap(map, scenario) {
  const { kind } = scenario;
  map.s.pq = scenario.quality;
  map.s.re = false;
  if (kind.startsWith('vtol')) map.spawns = [map.spawns[0], ...map.spawns];
  if (['vtol-rotated', 'vtol-disc-collision'].includes(kind)) {
    map.physics.bodies = [];
    map.physics.fixtures = [];
    map.physics.shapes = [];
    map.physics.bro = [];
  }
  if (kind === 'vtol-wing-world' || kind === 'vtol-wing-kinematics') {
    // World centre (16.7, 15), size (1, .4): only the right wing initially
    // overlaps; the player circle remains 0.2 units away from this obstacle.
    const shape = { type: 'bx', w: 12, h: 12, c: [0, 0], a: 0, sk: false };
    const fixture = { ...map.physics.fixtures[0], sh: 1, n: 'VTOL wing probe', d: kind === 'vtol-wing-world' };
    const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
    body.p = [16.7 * 12 - 365, 15 * 12 - 250];
    body.fx = [1];
    map.physics.shapes.push(shape);
    map.physics.fixtures.push(fixture);
    map.physics.bodies.push(body);
    map.physics.bro.push(1);
  }
  if (kind === 'vtol-directional') {
    // Keep the complete direction schedule in-round; the floor is outside the
    // nominal flight envelope and only prevents a later out-of-world death.
    map.physics.bodies[0].p[1] = 90;
    map.physics.shapes[0].w = 1200;
  }
  if (kind.startsWith('grapple')) {
    // Grapple probes: a wide floor keeps discs alive; the grapple target is a
    // dedicated box body. Map p = [worldX*12-365, worldY*12-250] (origin
    // 365/250, ppm 12). Per-kind placement:
    //   far [0,-100] -> world (30.42, 12.5), out of the disc's query range, so
    //     the disc attaches to the floor edge instead (slack/release/depletion
    //     probes exercise the floor pendulum).
    //   near [-185,-310] -> world (15,-5), directly above the seeded disc
    //     (acquire probes; the inner variant seeds the disc inside the box).
    //   [-185,-250] -> world (15,0), the seeded-swing anchor for the
    //     collision-break and target-death probes.
    //   [-185,-178] -> world (15,6), just above the fast disc's path for the
    //     impulse-break probe.
    map.physics.shapes[0].w = 1200;
    map.physics.bodies[0].p[0] = 0;
    // The nograpple probe tags every fixture ungrappleable so the swing can
    // never fire anywhere in the world.
    if (kind === 'grapple-acquire-nograpple') map.physics.fixtures[0].ng = true;
    // The target-death probe needs respawn to observe the swing clear.
    if (kind === 'grapple-target-death') map.s.re = true;
    const targetPosition =
      kind === 'grapple-acquire-static' || kind === 'grapple-acquire-inner'
        ? [-185, -310]
        : kind === 'grapple-break-collision' || kind === 'grapple-break-impulse' || kind === 'grapple-target-death'
          ? [-185, -250]
          : [0, -100];
    const targetShape = { type: 'bx', w: 96, h: 24, c: [0, 0], a: 0, sk: false };
    const targetFixture = {
      ...map.physics.fixtures[0],
      sh: 1,
      n: 'Grapple target',
      // The target-death probe makes the target lethal so a swinging disc
      // dies on contact and respawns without the swing.
      d: kind === 'grapple-target-death',
      np: false,
      ...(kind === 'grapple-acquire-nograpple' ? { ng: true } : {}),
      ...(kind === 'grapple-acquire-inner' ? { ig: true } : {}),
    };
    const targetBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
    targetBody.p = targetPosition;
    targetBody.fx = [1];
    map.physics.shapes.push(targetShape);
    map.physics.fixtures.push(targetFixture);
    map.physics.bodies.push(targetBody);
    map.physics.bro.push(1);
  }
  return map;
}

function seedNative(native, scenario) {
  const { kind } = scenario;
  if (kind === 'arrow-charge-release' || kind === 'vtol-directional') return;
  activate(native);
  if (kind.startsWith('sweep-')) {
    // W6: place discs at deterministic positions with nonzero velocities so
    // the sweeps exercise contact/physics under the varied parameters.
    native.discs.forEach((disc, id) => {
      if (!disc) return;
      setDisc(disc, { x: 15 + id * 10, y: 15, xv: id % 2 === 0 ? 1 : -1, yv: 0.5 });
    });
    return;
  }
  if (kind === 'arrow-aim-simultaneous') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0, a1a: 1000, ds: 1, da: 0 });
    setDisc(native.discs[1], { x: 40, y: 15, xv: 0, yv: 0 });
  } else if (kind === 'arrow-owner-ffa') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0 });
    setDisc(native.discs[1], { x: 40, y: 15, xv: 0, yv: 0 });
    native.projectiles = [
      { x: 16, y: 15, a: Math.PI, av: 0, did: 0, xv: -30, yv: 0, fte: 150, type: 'arrow', team: 1 },
    ];
  } else if (kind === 'arrow-disc-impact') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0 });
    setDisc(native.discs[1], { x: 20, y: 15, xv: 0, yv: 0 });
    native.projectiles = [{ x: 16, y: 15, a: 0, av: 0, did: 0, xv: 30, yv: 0, fte: 150, type: 'arrow', team: 1 }];
  } else if (kind === 'arrow-team-filter') {
    [15, 20, 25].forEach((x, id) => setDisc(native.discs[id], { x, y: 15, xv: 0, yv: 0 }));
    native.projectiles = [{ x: 16, y: 15, a: 0, av: 0, did: 0, xv: 45, yv: 0, fte: 150, type: 'arrow', team: 2 }];
  } else if (kind === 'arrow-world-impact') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0 });
    setDisc(native.discs[1], { x: 48, y: 10, xv: 0, yv: 0 });
    native.projectiles = [
      { x: 30, y: 15, a: Math.PI / 4, av: 0, did: 0, xv: 115, yv: 115, fte: 150, type: 'arrow', team: 1 },
    ];
  } else if (kind === 'arrow-projectile-expiry') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0 });
    setDisc(native.discs[1], { x: 40, y: 15, xv: 0, yv: 0 });
    native.projectiles = [{ x: 15, y: 5, a: 0.3, av: 0.75, did: 0, xv: 0, yv: 0, fte: 2, type: 'arrow', team: 1 }];
  } else if (kind === 'arrow-dual-release') {
    setDisc(native.discs[0], { x: 15, y: 10, xv: 0, yv: 0, a1a: 1000, ds: 40, da: 0 });
    setDisc(native.discs[1], { x: 45, y: 10, xv: 0, yv: 0, a1a: 1000, ds: 70, da: 180 });
  } else if (kind === 'vtol-rotated') {
    setDisc(native.discs[0], { x: 30, y: 18, xv: 0.2, yv: -0.1, a: 1.17, av: 0.4 });
  } else if (kind === 'vtol-wing-world') {
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0, a: 0, av: 0 });
  } else if (kind === 'vtol-wing-kinematics') {
    setDisc(native.discs[0], { x: 15, y: 14.5, xv: 0, yv: 0, a: 0, av: 0 });
  } else if (kind === 'vtol-disc-collision') {
    setDisc(native.discs[0], { x: 30, y: 15, xv: 2, yv: 0, a: 0.35, av: 0 });
    setDisc(native.discs[1], { x: 32.1, y: 15, xv: -2, yv: 0, a: -0.2, av: 0 });
  } else if (kind === 'grapple-acquire-static') {
    // Disc under the ceiling target (world (15, -5), box y in [-6, -4]).
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-acquire-inner') {
    // Disc inside the innerGrapple box: the rim is out of query range but the
    // innerGrapple selection rule attaches anyway.
    setDisc(native.discs[0], { x: 15, y: -5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-acquire-nograpple') {
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-slack-taut') {
    // Start far below the target so the rope is taut, then let gravity swing.
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-release-button') {
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-break-collision') {
    // Different-team discs: the enabled disc-disc contact breaks the swing.
    // Disc 0 hangs from the target at (15, 0) on a rope long enough to reach
    // disc 1 resting on the floor below.
    setDisc(native.discs[0], { x: 15, y: 0, xv: 0, yv: 0, a1a: 1000 });
    native.discs[0].swing = { b: 1, p: [0, 0], l: 18.5 };
    setDisc(native.discs[1], { x: 15, y: 18.8, xv: 0, yv: 0 });
  } else if (kind === 'grapple-break-impulse') {
    // Fast heavy disc with a seeded slack swing: b2_maxTranslation=2 at
    // dt=1/30 caps the disc at 60/tick, but the heavy density multiplier
    // (1 + 3.7 * a1a/1000 = 4.7 at full energy) gives mass 4.7, so the
    // target impact accumulates ~500 normal impulse and breaks the swing.
    setDisc(native.discs[0], { x: 5, y: 0, xv: 350, yv: 0, a1a: 1000 });
    native.discs[0].a1 = true;
    native.discs[0].swing = { b: 1, p: [-4, 0], l: 20 };
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-energy-depletion') {
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'grapple-target-death') {
    // Disc starts attached to the lethal target with a short rope; the joint
    // pulls the disc into the target and it dies on contact, then respawns
    // without the swing.
    setDisc(native.discs[0], { x: 15, y: 5, xv: 0, yv: 0, a1a: 1000 });
    native.discs[0].swing = { b: 1, p: [0, 0], l: 0.5 };
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'simple-movement') {
    // Disc 0 above the floor with a rightward input; exercises the bs movement
    // force branch (native 6088-6117 includes mo == "bs").
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'simple-heavy-frozen') {
    // Heavy input held: native 5228 has no bs branch, so a1a stays frozen and
    // native 5278 excludes bs from the density multiplier (mass stays 1).
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0, a1a: 1000 });
    native.discs[0].a1 = true;
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'simple-energy-frozen') {
    // Seeded partial energy: no drain/recharge in bs, so a1a must not move.
    setDisc(native.discs[0], { x: 15, y: 15, xv: 0, yv: 0, a1a: 400 });
    setDisc(native.discs[1], { x: 40, y: 5, xv: 0, yv: 0 });
  } else if (kind === 'simple-disc-collision') {
    // Different-team discs on a collision course; enabled contact plus lhid/lht
    // attribution must match Classic (bs shares the contact listener).
    setDisc(native.discs[0], { x: 15, y: 15, xv: 5, yv: 0, a1a: 1000 });
    setDisc(native.discs[1], { x: 30, y: 15, xv: -5, yv: 0, a1a: 1000 });
  } else {
    throw new Error(`Missing native seed implementation for ${kind}`);
  }
}

const VTOL_DIRECTIONS = [0, 4, 5, 6, 8, 9, 10, 1, 2, 3, 12, 11, 0, 4 | 16];
function inputsFor(scenario, tick) {
  const count = teamsFor(scenario.kind).length;
  let inputs = Array(count).fill(0);
  switch (scenario.kind) {
    case 'arrow-charge-release':
      inputs[0] = tick <= 260 ? 32 : 0;
      break;
    case 'arrow-aim-simultaneous':
      inputs[0] = 1 | 2 | 32;
      break;
    case 'vtol-directional':
      if (tick > 60) inputs[0] = VTOL_DIRECTIONS[Math.floor((tick - 61) / 5)] ?? 0;
      break;
    case 'vtol-rotated':
      inputs[0] = tick <= 12 ? 4 : tick <= 24 ? 1 : tick <= 36 ? 8 : 2;
      break;
    case 'grapple-acquire-static':
    case 'grapple-acquire-inner':
    case 'grapple-acquire-nograpple':
    case 'grapple-slack-taut':
    case 'grapple-energy-depletion':
      inputs[0] = 32;
      break;
    case 'grapple-break-impulse':
      inputs[0] = 16 | 32;
      break;
    case 'grapple-release-button':
      inputs[0] = tick <= 60 ? 32 : 0;
      break;
    case 'grapple-break-collision':
      inputs[0] = 32;
      break;
    case 'grapple-target-death':
      inputs[0] = 32;
      break;
    case 'simple-movement':
      inputs[0] = 2;
      break;
    case 'simple-heavy-frozen':
      inputs[0] = 16 | 2;
      break;
    case 'simple-energy-frozen':
      inputs[0] = 0;
      break;
    case 'simple-disc-collision':
      break;
    default:
      if (scenario.kind.startsWith('sweep-')) {
        // W6: alternate inputs per disc so sweeps move discs around.
        inputs = inputs.map((_, id) => (id % 2 === 0 ? 2 : 1));
      }
      break;
  }
  return inputs;
}

function observeNativeFixtureContacts(oracle, coverage) {
  for (const contact of oracle.consumeContactObservations()) {
    if (coverage.nativeContactSamples.length < 32) coverage.nativeContactSamples.push(contact);
    const pair = [
      { fixture: contact.fixtureA, body: contact.bodyA },
      { fixture: contact.fixtureB, body: contact.bodyB },
    ];
    const wing = pair.find((entry) => entry.fixture === 'vtolwing');
    const disc = pair.find((entry) => entry.fixture === 'discbody');
    if (wing && pair.some((entry) => entry.body === 'phys')) coverage.nativeWingWorldContacts++;
    if (disc && pair.some((entry) => entry.body === 'phys')) coverage.nativeDiscBodyWorldContacts++;
    if (wing && disc) coverage.nativeWingDiscContacts++;
    if (contact.fixtureA === 'vtolwing' && contact.fixtureB === 'vtolwing') coverage.nativeWingWingContacts++;
    if (contact.fixtureA === 'discbody' && contact.fixtureB === 'discbody') coverage.nativeDiscBodyDiscContacts++;
  }
}

function newCoverage() {
  return {
    simulatedTicks: 0,
    maxDraw: 0,
    chargeGatedTicks: 0,
    aimWraps: 0,
    releaseTicks: [],
    postFireEnergies: [],
    firedOwners: [],
    firedTeams: [],
    projectileZeroTicks: 0,
    projectileExpiryTicks: 0,
    maxProjectiles: 0,
    targetMotionTicks: 0,
    targetDeaths: 0,
    ownerIgnored: false,
    teammatePassed: false,
    enemyAffected: false,
    nativeWorldBounceTicks: 0,
    vtStates: [],
    nonzeroAngularTicks: 0,
    lastHitTicks: 0,
    heavyTicks: 0,
    minEnergy: 1000,
    maxEnergy: 0,
    simpleMotionTicks: 0,
    nativeDeathEvents: 0,
    roundRollovers: 0,
    nativeDeathKinds: { lethalContact: 0, arrow: 0, capture: 0, outOfWorld: 0 },
    nativeWingWorldContacts: 0,
    nativeWingDiscContacts: 0,
    nativeWingWingContacts: 0,
    nativeDiscBodyWorldContacts: 0,
    nativeDiscBodyDiscContacts: 0,
    nativeContactSamples: [],
    localArrowContactEvents: 0,
    swingAttachTicks: 0,
    swingHeldTicks: 0,
    swingSlackTicks: 0,
    swingBreakTicks: 0,
    swingDroppedTicks: 0,
    forcedReleaseTicks: 0,
    postDropEnergies: [],
    postBreakEnergies: [],
    swingClearedOnRespawn: false,
  };
}

function observeCoverage(scenario, previous, native, world, tick, coverage) {
  const { kind } = scenario;
  const previousDiscs = previous.discs;
  const discs = native.discs;
  coverage.maxProjectiles = Math.max(coverage.maxProjectiles, native.projectiles.length);
  coverage.localArrowContactEvents += world.arrowContacts?.length || 0;
  coverage.nativeDeathEvents += native.discDeaths.filter((death) => death.f === 0).length;
  for (const death of native.discDeaths.filter((entry) => entry.f === 0)) {
    if (death.m === 1 && scenario.mode === 'ard') coverage.nativeDeathKinds.arrow++;
    else if (death.m === 1) coverage.nativeDeathKinds.lethalContact++;
    else if (death.m === 3) coverage.nativeDeathKinds.capture++;
    else if (death.m === 4) coverage.nativeDeathKinds.outOfWorld++;
  }
  for (const disc of discs) {
    if (!disc) continue;
    coverage.minEnergy = Math.min(coverage.minEnergy, disc.a1a);
    coverage.maxEnergy = Math.max(coverage.maxEnergy, disc.a1a);
    if (disc.a1) coverage.heavyTicks++;
    if (Math.abs(disc.av) > 1e-12) coverage.nonzeroAngularTicks++;
    if (disc.lht > 0 && disc.lhid >= 0) coverage.lastHitTicks++;
    if (scenario.group === 'vtol' && !coverage.vtStates.includes(disc.vt)) coverage.vtStates.push(disc.vt);
  }
  if (kind === 'simple-movement') {
    const before = previousDiscs[0];
    const after = discs[0];
    if (before && after && Math.abs(after.xv - before.xv) > TOLERANCE) coverage.simpleMotionTicks++;
  }
  for (let index = 0; index < Math.max(previous.projectiles.length, native.projectiles.length); index++) {
    if (native.projectiles[index]?.fte === 0) coverage.projectileZeroTicks++;
    if (previous.projectiles[index] && !native.projectiles[index] && previous.projectiles[index].fte === 0)
      coverage.projectileExpiryTicks++;
  }
  if (kind === 'arrow-charge-release') {
    const before = previousDiscs[0];
    const after = discs[0];
    if (before && after) {
      coverage.maxDraw = Math.max(coverage.maxDraw, after.ds);
      if (before.a1a < 1000 && after.ds === before.ds) coverage.chargeGatedTicks++;
      if ((before.da > 300 && after.da < 60) || (before.da < 60 && after.da > 300)) coverage.aimWraps++;
      if (before.ds > 0 && after.ds === 0) {
        coverage.releaseTicks.push(tick);
        coverage.postFireEnergies.push(after.a1a);
        const arrow = native.projectiles[native.projectiles.length - 1];
        if (arrow) {
          coverage.firedOwners.push(arrow.did);
          coverage.firedTeams.push(arrow.team);
        }
      }
    }
  }
  if (kind === 'arrow-aim-simultaneous' && discs[0]?.da === 0 && discs[0]?.ds === 2) coverage.aimWraps++;
  if (kind === 'arrow-dual-release' && previous.projectiles.length === 0 && native.projectiles.length === 2) {
    coverage.firedOwners.push(...native.projectiles.map((arrow) => arrow.did));
    coverage.firedTeams.push(...native.projectiles.map((arrow) => arrow.team));
    coverage.postFireEnergies.push(...discs.map((disc) => disc.a1a));
  }
  if (kind === 'arrow-owner-ffa') {
    coverage.ownerIgnored = Boolean(discs[0] && Math.abs(discs[0].xv) <= TOLERANCE && native.projectiles[0]?.x < 16);
  }
  if (kind === 'arrow-disc-impact' || kind === 'arrow-team-filter') {
    const targetId = kind === 'arrow-team-filter' ? 2 : 1;
    if (
      previousDiscs[targetId] &&
      discs[targetId] &&
      Math.abs(discs[targetId].xv - previousDiscs[targetId].xv) > TOLERANCE
    )
      coverage.targetMotionTicks++;
    if (native.discDeaths.some((death) => death.f === 0 && death.i === targetId && death.m === 1))
      coverage.targetDeaths++;
    if (kind === 'arrow-team-filter') {
      coverage.enemyAffected = coverage.targetMotionTicks > 0 || coverage.targetDeaths > 0;
      if (discs[1] && Math.abs(discs[1].xv) <= TOLERANCE && native.projectiles[0]?.x > 21)
        coverage.teammatePassed = true;
    }
  }
  if (kind === 'arrow-world-impact') {
    const before = previous.projectiles[0];
    const after = native.projectiles[0];
    if (before && after && before.yv > 0 && after.yv < 0) coverage.nativeWorldBounceTicks++;
  }
  if (kind.startsWith('grapple')) {
    const before = previous.discs[0];
    const after = discs[0];
    if (before && after) {
      if (!before.swing && after.swing) coverage.swingAttachTicks++;
      if (after.swing) coverage.swingHeldTicks++;
      if (after.swing && before.swing && after.swing.l > Math.hypot(after.x - 15, after.y - 5) + 1e-9)
        coverage.swingSlackTicks++;
      if (before.swing && !after.swing) {
        if (after.a1a === 0) {
          coverage.swingBreakTicks++;
          coverage.postBreakEnergies.push(after.a1a);
        } else {
          coverage.swingDroppedTicks++;
          coverage.postDropEnergies.push(after.a1a);
        }
      }
      if (before.swing && before.a1a > 0 && after.a1a === 0 && !after.swing) coverage.forcedReleaseTicks++;
      if (before.swing && after.ni === true && !after.swing) coverage.swingClearedOnRespawn = true;
    }
  }
}

function coverageFailures(scenario, coverage) {
  const failures = [];
  const requireCoverage = (condition, expected) => {
    if (!condition) failures.push({ field: 'coverage', expected });
  };
  requireCoverage(coverage.simulatedTicks > 0, 'at least one native simulated tick');
  switch (scenario.kind) {
    case 'arrow-charge-release':
      requireCoverage(coverage.maxDraw === 100, 'native Arrow charge reaches ds=100');
      requireCoverage(coverage.chargeGatedTicks > 0, 'native charge remains gated below full energy');
      requireCoverage(coverage.releaseTicks.length === 1, 'one native release');
      requireCoverage(coverage.postFireEnergies[0] === 500, 'native release energy is 500');
      requireCoverage(
        coverage.firedOwners[0] === 0 && coverage.firedTeams[0] === 1,
        'native fired projectile ownership/team',
      );
      requireCoverage(
        coverage.projectileZeroTicks > 0 && coverage.projectileExpiryTicks > 0,
        'native fired projectile reaches fte=0 then expires',
      );
      break;
    case 'arrow-aim-simultaneous':
      requireCoverage(
        coverage.aimWraps === 1,
        'native simultaneous left/right aim cancels at 0 degrees while charging',
      );
      break;
    case 'arrow-owner-ffa':
      requireCoverage(coverage.ownerIgnored, 'native FFA owner contact disabled while projectile passes owner');
      break;
    case 'arrow-disc-impact':
      requireCoverage(
        coverage.targetMotionTicks > 0 || coverage.targetDeaths > 0,
        'native projectile affects opposing disc',
      );
      if (scenario.mode === 'ard')
        requireCoverage(coverage.targetDeaths > 0, 'native Death Arrow kills opposing disc with cause 1');
      break;
    case 'arrow-team-filter':
      requireCoverage(coverage.teammatePassed, 'native projectile passes same-team non-owner disc');
      requireCoverage(coverage.enemyAffected, 'native projectile affects opposing-team disc');
      if (scenario.mode === 'ard')
        requireCoverage(coverage.targetDeaths > 0, 'native Death Arrow kills opposing-team disc');
      break;
    case 'arrow-world-impact':
      requireCoverage(coverage.nativeWorldBounceTicks > 0, 'native projectile/world impact reverses vertical velocity');
      break;
    case 'arrow-projectile-expiry':
      requireCoverage(
        coverage.projectileZeroTicks > 0 && coverage.projectileExpiryTicks > 0,
        'seeded native projectile survives fte=0 output then expires',
      );
      break;
    case 'arrow-dual-release':
      requireCoverage(coverage.maxProjectiles === 2, 'two native projectiles appended');
      requireCoverage(
        coverage.firedOwners.length === 2 && coverage.firedOwners.every((owner, id) => owner === id),
        'native dual-release owners retain disc IDs in append order',
      );
      requireCoverage(
        coverage.firedTeams.length === 2 &&
          coverage.firedTeams.every((team, id) => team === teamsFor(scenario.kind)[id]),
        'native dual-release projectile teams retain shooter teams',
      );
      requireCoverage(
        coverage.postFireEnergies.length === 2 && coverage.postFireEnergies.every((energy) => energy === 500),
        'both native releases set energy to 500',
      );
      break;
    case 'vtol-directional':
      for (let vt = 0; vt <= 6; vt++) requireCoverage(coverage.vtStates.includes(vt), `native VTOL vt=${vt} exercised`);
      requireCoverage(
        coverage.heavyTicks === 5 && coverage.minEnergy === 950,
        'five native VTOL heavy ticks drain energy from 1000 to 950',
      );
      requireCoverage(
        coverage.nativeDeathEvents === 0,
        'native VTOL directional trajectory stays alive without round lifecycle interference',
      );
      break;
    case 'vtol-rotated':
      requireCoverage(coverage.nonzeroAngularTicks > 0, 'native rotated VTOL angular propagation exercised');
      break;
    case 'vtol-wing-world':
      requireCoverage(
        coverage.nativeWingWorldContacts > 0 && coverage.nativeDiscBodyWorldContacts === 0,
        'original contact list has wing/world but no body-circle/world contact',
      );
      requireCoverage(
        coverage.nativeDeathEvents === 1,
        'lethal wing/world overlap produces exactly one native contact death',
      );
      requireCoverage(
        coverage.nativeDeathKinds.lethalContact === 1,
        'native lethal wing overlap uses cause 1, not bounds or capture',
      );
      break;
    case 'vtol-wing-kinematics':
      requireCoverage(
        coverage.nativeWingWorldContacts > 0 && coverage.nativeDiscBodyWorldContacts === 0,
        'original contact list isolates non-lethal wing/world contact',
      );
      requireCoverage(
        coverage.nonzeroAngularTicks > 0,
        'native non-lethal wing/world contact creates angular velocity',
      );
      requireCoverage(coverage.nativeDeathEvents === 0, 'non-lethal wing kinematics stay alive');
      break;
    case 'vtol-disc-collision':
      requireCoverage(
        coverage.nativeWingDiscContacts > 0 && coverage.nativeDiscBodyDiscContacts === 0,
        'original contact list isolates wing/disc contact',
      );
      requireCoverage(coverage.lastHitTicks > 0, 'native VTOL fixture collision produces last-hit attribution');
      requireCoverage(coverage.nonzeroAngularTicks > 0, 'native VTOL wing/disc collision creates angular velocity');
      break;
    case 'grapple-acquire-static':
      requireCoverage(coverage.swingAttachTicks > 0, 'native grapple fires and attaches');
      requireCoverage(coverage.swingHeldTicks > 10, 'native swing persists across many ticks');
      break;
    case 'grapple-acquire-inner':
      requireCoverage(coverage.swingAttachTicks > 0, 'native innerGrapple fixture is grappleable');
      break;
    case 'grapple-acquire-nograpple':
      requireCoverage(coverage.swingAttachTicks === 0, 'native noGrapple fixture never attaches');
      break;
    case 'grapple-slack-taut':
      requireCoverage(coverage.swingHeldTicks > 50, 'native taut rope swing persists');
      requireCoverage(coverage.swingSlackTicks > 0, 'native rope goes slack at least once');
      break;
    case 'grapple-release-button':
      requireCoverage(coverage.swingAttachTicks > 0, 'native grapple attaches before release');
      requireCoverage(coverage.swingDroppedTicks > 0, 'native swing drops after button release');
      requireCoverage(
        coverage.postDropEnergies.length > 0 && coverage.postDropEnergies.every((energy) => energy > 0),
        'button release does not zero energy',
      );
      break;
    case 'grapple-break-collision':
      requireCoverage(coverage.swingBreakTicks > 0, 'native disc-disc contact breaks the swing');
      requireCoverage(
        coverage.postBreakEnergies.length > 0 && coverage.postBreakEnergies.every((energy) => energy === 0),
        'collision break zeroes energy',
      );
      break;
    case 'grapple-break-impulse':
      requireCoverage(coverage.swingBreakTicks > 0, 'native impulse threshold breaks the swing');
      break;
    case 'grapple-energy-depletion':
      requireCoverage(coverage.minEnergy === 0, 'native grapple energy drains to zero');
      requireCoverage(coverage.forcedReleaseTicks > 0, 'native forced release at threshold');
      break;
    case 'grapple-target-death':
      requireCoverage(coverage.nativeDeathEvents > 0, 'native disc dies while holding grapple');
      requireCoverage(coverage.swingClearedOnRespawn, 'respawn clears the swing');
      break;
    case 'simple-movement':
      requireCoverage(coverage.simpleMotionTicks > 0, 'native bs movement force accelerates the disc');
      break;
    case 'simple-heavy-frozen':
      requireCoverage(coverage.heavyTicks > 0, 'native bs heavy input is held');
      requireCoverage(coverage.minEnergy === 1000, 'native bs energy stays frozen at 1000 while heavy is held');
      break;
    case 'simple-energy-frozen':
      requireCoverage(
        coverage.minEnergy === 400 && coverage.maxEnergy === 1000,
        'native bs seeded energy never drains or recharges (disc 0 stays at 400, disc 1 at 1000)',
      );
      break;
    case 'simple-disc-collision':
      requireCoverage(coverage.lastHitTicks > 0, 'native bs disc-disc contact produces last-hit attribution');
      break;
    default:
      if (scenario.kind.startsWith('sweep-')) {
        // W6: sweeps only assert the shared invariant (simulated ticks and
        // full numeric/discrete parity); their value is the varied
        // seed/roster/balance parameters, not a mechanic-specific gate.
        break;
      }
      failures.push({ field: 'coverage', expected: `implemented coverage gate for ${scenario.kind}` });
  }
  return failures;
}

function createRun(paths, scenario, options = {}) {
  const tickCount = Math.min(scenario.ticks, options.tickLimit ?? scenario.ticks);
  const oracle = createOracle(paths);
  const { createClassicPhysics } = require('../../src/core/classic-physics.ts');
  const physics = createClassicPhysics();
  try {
    const teams = teamsFor(scenario.kind);
    const roster = teams.map((team, id) => ({ id, team }));
    // W6: scenario-declared balances (default 0) exercise native radius
    // scaling; scenario-declared seeds (default 1) exercise spawn deal order.
    const balances = scenario.balances ? scenario.balances.slice() : teams.map(() => 0);
    const seed = scenario.seed ?? 1;
    const map = configureMap(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8')),
      scenario,
    );
    const settings = {
      ga: 'b',
      mo: scenario.mode,
      tea: scenario.kind === 'arrow-team-filter' || scenario.kind === 'arrow-dual-release',
      bal: balances,
      map,
      gt: 2,
      wl: 3,
      q: false,
      maps: [],
    };
    let native = oracle.createNewState(roster, map, seed, false, null, settings, true);
    native.rc = 0;
    seedNative(native, scenario);
    let discs = localDiscs(native, balances);
    let platforms = localPlatforms(native);
    let projectiles = native.projectiles.map((arrow) => (arrow ? { ...arrow } : undefined));
    const coverage = newCoverage();
    const report = {
      name: scenario.name,
      kind: scenario.kind,
      group: scenario.group,
      mode: scenario.mode,
      quality: scenario.quality,
      seed: scenario.seed ?? 1,
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
      const discCount = Math.max(native.discs.length, ...discs.map((disc) => disc.id + 1), 0);
      for (let id = 0; id < discCount; id++) {
        const actual = discs.find((disc) => disc.id === id);
        const expected = native.discs[id];
        const alive = expected !== undefined && expected !== null;
        discrete(tick, 'disc', id, 'alive', actual?.alive === true, alive);
        if (!alive || actual?.alive !== true) continue;
        for (const [localField, nativeField] of DISC_NUMERIC)
          numeric(tick, 'disc', id, localField, actual[localField], expected[nativeField]);
        for (const [field, read] of DISC_DISCRETE) {
          // swing.b is a nested path on both engines; the read function
          // handles it. All other discrete fields are flat on the local disc.
          const actualValue = field === 'swing.b' ? read(actual) : actual[field];
          discrete(tick, 'disc', id, field, actualValue, read(expected));
        }
        for (const [field, read] of DISC_SWING_NUMERIC) {
          const actualValue = read(actual);
          const expectedValue = read(expected);
          if (actualValue === undefined || expectedValue === undefined) {
            discrete(tick, 'disc', id, field, actualValue, expectedValue);
          } else {
            numeric(tick, 'disc', id, field, actualValue, expectedValue);
          }
        }
      }
      discrete(tick, 'projectiles', null, 'length', projectiles.length, native.projectiles.length);
      const projectileCount = Math.max(projectiles.length, native.projectiles.length);
      for (let index = 0; index < projectileCount; index++) {
        const actual = projectiles[index];
        const expected = native.projectiles[index];
        discrete(
          tick,
          'projectile',
          index,
          'presence',
          actual !== undefined && actual !== null,
          expected !== undefined && expected !== null,
        );
        if (actual === undefined || actual === null || expected === undefined || expected === null) continue;
        for (const field of PROJECTILE_NUMERIC) {
          let actualValue = actual[field];
          if (options.perturb && tick === 1 && index === 0 && field === 'xv') actualValue += 1e-6;
          numeric(tick, 'projectile', index, field, actualValue, expected[field]);
        }
        for (const field of PROJECTILE_DISCRETE)
          discrete(tick, 'projectile', index, field, actual[field], expected[field]);
      }
    };
    const checkDeaths = (tick, world) => {
      const expected = native.discDeaths
        .filter((death) => death.f === 0)
        .map((death) => ({
          id: death.i,
          cause:
            death.m === 4
              ? 'out-of-world'
              : death.m === 3
                ? 'capture'
                : scenario.mode === 'ard'
                  ? 'arrow'
                  : 'lethal-contact',
        }));
      const actual = (world.deaths || []).map((death) => ({ id: death.id, cause: death.cause }));
      discrete(tick, 'deaths', null, 'length', actual.length, expected.length);
      for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
        discrete(tick, 'deaths', index, 'id', actual[index]?.id, expected[index]?.id);
        discrete(tick, 'deaths', index, 'cause', actual[index]?.cause, expected[index]?.cause);
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
      const input = inputsFor(scenario, tick);
      const previous = native;
      const simulate = native.ftu === -1;
      const previousRound = native.rc;
      native =
        scenario.group === 'vtol'
          ? oracle.stepWithContactObserver(native, input.map(bits), null, 30, settings, 1, false, undefined)
          : oracle.step(native, input.map(bits), null, 30, settings, 1, false, undefined);
      if (scenario.group === 'vtol') oracle.instrumentContacts();
      if (scenario.group === 'vtol') observeNativeFixtureContacts(oracle, coverage);
      if (native.rc !== previousRound) {
        coverage.roundRollovers++;
        mismatch({
          tick,
          entity: 'round',
          field: 'rc',
          actual: previousRound,
          native: native.rc,
          message: 'Round rollover is outside this bounded in-round comparison; no local reseed performed',
        });
        break;
      }
      const inputRecord = Object.fromEntries(discs.map((disc, index) => [disc.id, input[index] ?? 0]));
      const world = physics.stepWorld(
        discs,
        platforms,
        inputRecord,
        {
          fly: map.s.fl,
          noCollision: map.s.nc,
          quality: scenario.quality,
          simulate,
          balances,
          mode: scenario.mode,
          teams,
          teamCollision: settings.tea,
          respawn: map.s.re,
          ppm: native.physics.ppm,
        },
        { projectiles },
      );
      discs = world.discs;
      platforms = world.platforms;
      projectiles = world.projectiles.map((arrow) => (arrow ? { ...arrow } : undefined));
      if (options.perturbDiscrete && tick === 1) {
        // W4: flip a discrete boolean the comparator verifies (disc 0 alive)
        // to prove the discrete comparison path fails loud.
        discs = discs.map((disc) => (disc.id === 0 ? { ...disc, alive: !disc.alive } : disc));
      }
      if (simulate) coverage.simulatedTicks++;
      observeCoverage(scenario, previous, native, world, tick, coverage);
      check(tick);
      checkDeaths(tick, world);
    }
    if (!options.perturb && !options.perturbDiscrete) {
      report.coverageFailures = coverageFailures(scenario, coverage);
      for (const failure of report.coverageFailures) mismatch({ tick: report.ticks, ...failure });
    }
    coverage.vtStates.sort((a, b) => a - b);
    report.pass = report.firstMismatch === null;
    report.status = report.pass ? 'PASS' : 'FAIL';
    report.provenance = oracle.provenance;
    return report;
  } finally {
    physics.dispose();
    oracle.dispose();
  }
}

function compareNativeModes(paths, options = {}) {
  const selected = options.negativeControlOnly
    ? []
    : SCENARIOS.filter((scenario) => {
        if (options.group && options.group !== 'all' && scenario.group !== options.group) return false;
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
        group: scenario.group,
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
  let provenance = results.find((result) => result.provenance)?.provenance;
  if (options.negativeControl) {
    // W4: run the numeric control past tick 1 so the injected divergence is
    // observed at a later tick too, and add a discrete-field flip control.
    const scenario = SCENARIOS.find((entry) => entry.name === 'arrow-projectile-expiry-ar-q1');
    const control = createRun(paths, scenario, { tickLimit: 5, perturb: true });
    provenance ||= control.provenance;
    const discreteRun = createRun(paths, scenario, { tickLimit: 1, perturbDiscrete: true });
    negativeControl = {
      name: 'injected-local-projectile-xv-error',
      injectedError: 1e-6,
      ticks: control.ticks,
      detected:
        control.firstMismatch?.entity === 'projectile' &&
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
    localRepairOrReseeds: results.reduce((sum, result) => sum + result.localRepairOrReseeds, 0),
  };
  return {
    schema: 'bonk-rl-env.native-mode-differential',
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
      localClassicPhysicsSha256: digest(path.join(ROOT, 'src/core/classic-physics.ts')),
    },
    group: options.group || 'all',
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
  const report = compareNativeModes(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  return report;
}

module.exports = {
  compareNativeModes,
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
          schema: 'bonk-rl-env.native-mode-differential',
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
