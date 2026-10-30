'use strict';

// Isolated research probe. Executes only the hash-pinned original oracle.
// No production/reference/comparator files are imported or modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOracle } = require('./raw-physics-oracle.cjs');

const root = path.resolve(__dirname, '../..');
const paths = {
  rawPath: process.env.BONK_RAW_REFERENCE_FILE || path.join(root, '.deobf/alpha2s.raw.js'),
  physicsPath:
    process.env.BOX2D_REFERENCE_FILE || path.join(root, '.local-artifacts/native-reference/Box2DModuleGJMod.js'),
  trigPath: process.env.SAFETRIG_REFERENCE_FILE || path.join(root, '.local-artifacts/native-reference/SafeTrig.js'),
};
const oracle = createOracle(paths);
const baseMap = JSON.parse(fs.readFileSync(path.join(root, 'maps/training-platform.json'), 'utf8'));
const noInput = Array.from({ length: 4 }, () => ({
  left: false,
  right: false,
  up: false,
  down: false,
  action: false,
  action2: false,
}));

function settings(map, tea = false) {
  return { ga: 'b', mo: 'b', tea, bal: [0, 0, 0, 0], map, gt: 2, wl: 3, q: false, maps: [] };
}

function stateFor({
  tea = false,
  roster = [
    { id: 0, team: 1 },
    { id: 1, team: 1 },
  ],
  mutate,
} = {}) {
  const map = JSON.parse(JSON.stringify(baseMap));
  map.s.re = false;
  map.spawns.forEach((spawn, i) => {
    spawn.x = i === 0 ? -120 : 120;
    spawn.y = 180;
    spawn.xv = 0;
    spawn.yv = 0;
  });
  if (mutate) mutate(map);
  const gameSettings = settings(map, tea);
  const state = oracle.createNewState(roster, map, 1, false, null, gameSettings, true);
  state.ftu = -1;
  state.fte = -1;
  return { state, gameSettings };
}

function step(state, gameSettings) {
  return oracle.step(state, noInput, null, 30, gameSettings, 1, false, undefined);
}

function compact(state) {
  return {
    ftu: state.ftu,
    fte: state.fte,
    scores: state.scores,
    lscr: state.lscr,
    discs: state.discs.map((d, i) => (d ? { i, x: d.x, y: d.y, xv: d.xv, yv: d.yv, team: d.team, ni: d.ni } : null)),
    discDeaths: state.discDeaths,
    capZones: state.capZones,
    bodies: state.physics.bodies.map((b, i) => (b ? { i, type: b.s.type, p: b.p, lv: b.lv } : null)),
    sts: state.sts,
  };
}

function run(name, setup, ticks = 1, beforeStep) {
  const { state: initial, gameSettings } = stateFor(setup);
  if (beforeStep) beforeStep(initial);
  const frames = [compact(initial)];
  let state = initial;
  for (let i = 0; i < ticks; i++) {
    state = step(state, gameSettings);
    frames.push(compact(state));
  }
  return { name, frames };
}

const results = [];
const host = (value) => JSON.parse(JSON.stringify(value));
try {
  results.push(
    run('countdown-entry-ftu0', {}, 2, (s) => {
      s.ftu = 0;
    }),
  );
  results.push(run('countdown-entry-ftu-1', {}, 1));
  results.push(
    run('result-gate-entry-ftu0-fte90', {}, 2, (s) => {
      s.ftu = 0;
      s.fte = 90;
    }),
  );
  results.push(
    run('result-gate-entry-ftu-1-fte90', {}, 1, (s) => {
      s.fte = 90;
    }),
  );
  results.push(
    run(
      'lethal-then-timed-capture',
      {
        mutate(map) {
          const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
          const fixture = {
            ...map.physics.fixtures[0],
            sh: 1,
            n: 'lethal cap',
            d: true,
            np: false,
            ng: true,
            ig: false,
          };
          const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
          body.p = [-120, 180];
          body.fx = [1];
          map.physics.shapes.push(shape);
          map.physics.fixtures.push(fixture);
          map.physics.bodies.push(body);
          map.capZones = [{ i: 1, ty: 1, l: 0.01 }];
        },
      },
      24,
    ),
  );
  results.push(
    run(
      'same-tick-lethal-contact-then-capture',
      {
        mutate(map) {
          const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
          const fixture = {
            ...map.physics.fixtures[0],
            sh: 1,
            n: 'lethal cap',
            d: true,
            np: false,
            ng: true,
            ig: false,
          };
          const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
          body.p = [-120, 180];
          body.fx = [1];
          map.physics.shapes.push(shape);
          map.physics.fixtures.push(fixture);
          map.physics.bodies.push(body);
          map.capZones = [{ i: 1, ty: 1, l: 0.01 }];
        },
      },
      2,
      (s) => {
        // Seeded boundary state: cap completes this tick while disc 1 touches death fixture.
        Object.assign(s.capZones[0], { p: 1, l: 1, o: 0, ot: 1, f: 0 });
      },
    ),
  );
  results.push(
    run(
      'same-tick-capture-then-out-of-world',
      {
        mutate(map) {
          const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
          const fixture = { ...map.physics.fixtures[0], sh: 1, n: 'cap', d: false, np: false, ng: true, ig: false };
          const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
          body.p = [-120, 245];
          body.fx = [1];
          map.physics.shapes.push(shape);
          map.physics.fixtures.push(fixture);
          map.physics.bodies.push(body);
          map.capZones = [{ i: 1, ty: 1, l: 0.01 }];
        },
      },
      2,
      (s) => {
        // Disc 1 is outside the floor and touching cap. Capture fires, then bounds overwrite it.
        s.discs[1].y = 500 / 12 + 0.1;
        Object.assign(s.capZones[0], { p: 1, l: 1, o: 0, ot: 1, f: 0 });
      },
    ),
  );
  results.push(
    run(
      'same-tick-lethal-contact-control',
      {
        mutate(map) {
          const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
          const fixture = {
            ...map.physics.fixtures[0],
            sh: 1,
            n: 'lethal cap',
            d: true,
            np: false,
            ng: true,
            ig: false,
          };
          const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
          body.p = [-120, 180];
          body.fx = [1];
          map.physics.shapes.push(shape);
          map.physics.fixtures.push(fixture);
          map.physics.bodies.push(body);
          map.capZones = [{ i: 1, ty: 1, l: 1 / 30 }];
        },
      },
      1,
      (s) => {
        Object.assign(s.capZones[0], { p: 0, l: 1, o: -1, ot: -1, f: -1 });
      },
    ),
  );
  results.push(
    run(
      'same-tick-out-of-world-control',
      {
        mutate(map) {
          const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
          const fixture = { ...map.physics.fixtures[0], sh: 1, n: 'cap', d: false, np: false, ng: true, ig: false };
          const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
          body.p = [-120, 245];
          body.fx = [1];
          map.physics.shapes.push(shape);
          map.physics.fixtures.push(fixture);
          map.physics.bodies.push(body);
          map.capZones = [{ i: 1, ty: 1, l: 1 / 30 }];
        },
      },
      1,
      (s) => {
        s.discs[1].y = 500 / 12 + 0.1;
        Object.assign(s.capZones[0], { p: 0, l: 1, o: -1, ot: -1, f: -1 });
      },
    ),
  );
  for (const captureCause of [
    { name: 'lethal-contact', m: 3, lethal: true, out: false },
    { name: 'out-of-world', m: 4, lethal: false, out: true },
  ]) {
    results.push(
      run(
        `capture-respawn-${captureCause.name}`,
        {
          mutate(map) {
            map.s.re = true;
            const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
            const fixture = {
              ...map.physics.fixtures[0],
              sh: 1,
              n: 'cap/death',
              d: captureCause.lethal,
              np: false,
              ng: true,
              ig: false,
            };
            const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
            body.p = [-120, 180];
            body.fx = [1];
            map.physics.shapes.push(shape);
            map.physics.fixtures.push(fixture);
            map.physics.bodies.push(body);
            map.capZones = [{ i: 1, ty: 1, l: 0.01 }];
          },
        },
        1,
        (s) => {
          if (captureCause.out) s.discs[1].y = 500 / 12 + 0.1;
          Object.assign(s.capZones[0], { p: 1, l: 1, o: 0, ot: 1, f: 0 });
        },
      ),
    );
  }
  for (const team of [2, 3]) {
    results.push(
      run(
        `instant-goal-respawn-ty${team}`,
        {
          tea: true,
          roster: [
            { id: 0, team: 2 },
            { id: 1, team: 3 },
          ],
          mutate(map) {
            map.s.re = true;
            const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
            const goalFixture = {
              ...map.physics.fixtures[0],
              sh: 1,
              n: 'goal',
              d: false,
              np: false,
              ng: true,
              ig: false,
            };
            const goalBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
            goalBody.p = [0, 0];
            goalBody.fx = [1];
            const ballFixture = {
              ...map.physics.fixtures[0],
              sh: 1,
              n: 'ball',
              d: false,
              np: false,
              ng: false,
              ig: false,
            };
            const ballBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
            ballBody.s.type = 'd';
            ballBody.p = [0, 0];
            ballBody.fx = [2];
            map.physics.shapes.push(shape);
            map.physics.fixtures.push(goalFixture, ballFixture);
            map.physics.bodies.push(goalBody, ballBody);
            map.capZones = [{ i: 1, ty: team, l: 1 }];
          },
        },
        1,
      ),
    );
  }
  for (const tea of [false, true]) {
    for (const ty of [2, 3, 4, 5]) {
      results.push(
        run(
          `instant-goal-ty${ty}-${tea ? 'teams' : 'ffa'}`,
          {
            tea,
            roster: tea
              ? [
                  { id: 0, team: 2 },
                  { id: 1, team: 3 },
                  { id: 2, team: 4 },
                  { id: 3, team: 5 },
                ]
              : [
                  { id: 0, team: 1 },
                  { id: 1, team: 1 },
                ],
            mutate(map) {
              if (tea) {
                map.spawns = [0, 1, 2, 3].map((i) => ({ ...map.spawns[0], x: -120 + i * 80, y: 180, n: `spawn${i}` }));
              }
              const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
              const goalFixture = {
                ...map.physics.fixtures[0],
                sh: 1,
                n: 'goal',
                d: false,
                np: false,
                ng: true,
                ig: false,
              };
              const goalBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
              goalBody.p = [0, 0];
              goalBody.fx = [1];
              const ballFixture = {
                ...map.physics.fixtures[0],
                sh: 1,
                n: 'ball',
                d: false,
                np: false,
                ng: false,
                ig: false,
              };
              const ballBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
              ballBody.s.type = 'd';
              ballBody.p = [0, 0];
              ballBody.fx = [2];
              map.physics.shapes.push(shape);
              map.physics.fixtures.push(goalFixture, ballFixture);
              map.physics.bodies.push(goalBody, ballBody);
              map.capZones = [{ i: 1, ty, l: 1 }];
            },
          },
          2,
        ),
      );
    }
  }
  for (const ty of [4, 5]) {
    results.push(
      run(
        `instant-goal-ty${ty}-teams-absent`,
        {
          tea: true,
          roster: [
            { id: 0, team: 2 },
            { id: 1, team: 3 },
          ],
          mutate(map) {
            const shape = { type: 'bx', w: 24, h: 24, c: [0, 0], a: 0, sk: false };
            const goalFixture = {
              ...map.physics.fixtures[0],
              sh: 1,
              n: 'goal',
              d: false,
              np: false,
              ng: true,
              ig: false,
            };
            const goalBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
            goalBody.p = [0, 0];
            goalBody.fx = [1];
            const ballFixture = {
              ...map.physics.fixtures[0],
              sh: 1,
              n: 'ball',
              d: false,
              np: false,
              ng: false,
              ig: false,
            };
            const ballBody = JSON.parse(JSON.stringify(map.physics.bodies[0]));
            ballBody.s.type = 'd';
            ballBody.p = [0, 0];
            ballBody.fx = [2];
            map.physics.shapes.push(shape);
            map.physics.fixtures.push(goalFixture, ballFixture);
            map.physics.bodies.push(goalBody, ballBody);
            map.capZones = [{ i: 1, ty, l: 1 }];
          },
        },
        2,
      ),
    );
  }
  const byName = new Map(results.map((result) => [result.name, result]));
  const frame = (name, index = 1) => host(byName.get(name).frames[index]);
  const deaths = (name) => frame(name).discDeaths.map(({ i, m, f }) => ({ i, m, f }));
  assert.equal(frame('countdown-entry-ftu0').discs[0].y, frame('countdown-entry-ftu0', 0).discs[0].y);
  assert.equal(frame('countdown-entry-ftu0', 2).discs[0].yv, 0.6664444444444444);
  assert.equal(frame('result-gate-entry-ftu0-fte90').discs[0].y, frame('result-gate-entry-ftu0-fte90', 0).discs[0].y);
  assert.equal(frame('result-gate-entry-ftu0-fte90').fte, 89);
  assert.equal(frame('result-gate-entry-ftu-1-fte90').discs[0].yv, 0.6664444444444444);
  assert.equal(frame('result-gate-entry-ftu-1-fte90').fte, 89);
  assert.deepEqual(deaths('lethal-then-timed-capture'), [{ i: 1, m: 1, f: 0 }]);
  assert.deepEqual(
    frame('lethal-then-timed-capture', 22).discDeaths.map(({ i, m, f }) => ({ i, m, f })),
    [
      { i: 1, m: 1, f: 21 },
      { i: 0, m: 3, f: 0 },
    ],
  );
  assert.deepEqual(deaths('same-tick-lethal-contact-control'), [{ i: 1, m: 1, f: 0 }]);
  assert.deepEqual(deaths('same-tick-lethal-contact-then-capture'), [{ i: 1, m: 3, f: 0 }]);
  assert.deepEqual(deaths('same-tick-out-of-world-control'), [{ i: 1, m: 4, f: 0 }]);
  assert.deepEqual(deaths('same-tick-capture-then-out-of-world'), [{ i: 1, m: 4, f: 0 }]);
  assert.deepEqual(frame('same-tick-capture-then-out-of-world').discDeaths[0], {
    i: 1,
    x: 20.416666666666668,
    y: 41.583333333333336,
    xv: 0,
    yv: -20,
    f: 0,
    m: 4,
  });
  for (const name of [
    'same-tick-lethal-contact-control',
    'same-tick-lethal-contact-then-capture',
    'same-tick-out-of-world-control',
    'same-tick-capture-then-out-of-world',
  ]) {
    assert(frame(name).capZones[0].p >= frame(name).capZones[0].l, `${name}: cap contact not reached`);
  }
  assert.deepEqual(deaths('capture-respawn-lethal-contact'), [{ i: 1, m: 3, f: 0 }]);
  assert.equal(frame('capture-respawn-lethal-contact').discs[1], undefined);
  assert.deepEqual(deaths('capture-respawn-out-of-world'), [{ i: 1, m: 4, f: 0 }]);
  assert.equal(frame('capture-respawn-out-of-world').discs[1].ni, true);
  assert.equal(frame('capture-respawn-out-of-world').fte, -1);
  for (const team of [2, 3]) {
    const result = frame(`instant-goal-respawn-ty${team}`);
    assert.equal(result.scores[team], 1);
    assert.equal(result.lscr, team);
    assert.equal(result.discDeaths[0].m, 3);
    assert.equal(result.discs.filter(Boolean).length, 1);
  }
  for (const ty of [2, 3, 4, 5]) {
    const ffa = frame(`instant-goal-ty${ty}-ffa`);
    assert.deepEqual(ffa.scores, [0, 0]);
    assert.equal(ffa.lscr, -1);
    assert.deepEqual(
      ffa.discDeaths.map(({ i, m, f }) => ({ i, m, f })),
      [
        { i: 0, m: 3, f: 0 },
        { i: 1, m: 3, f: 0 },
      ],
    );
    assert.equal(ffa.discs.filter(Boolean).length, 0);
    const teams = frame(`instant-goal-ty${ty}-teams`);
    const scores = [null, null, 0, 0, 0, 0];
    scores[ty] = 1;
    assert.deepEqual(teams.scores, scores);
    assert.equal(teams.lscr, ty);
    assert.deepEqual(
      teams.discDeaths.map(({ i, m, f }) => ({ i, m, f })),
      [0, 1, 2, 3].filter((i) => i !== ty - 2).map((i) => ({ i, m: 3, f: 0 })),
    );
    assert.equal(teams.discs.filter(Boolean)[0].i, ty - 2);
  }
  for (const ty of [4, 5]) {
    const result = frame(`instant-goal-ty${ty}-teams-absent`);
    assert.deepEqual(result.scores, [null, null, 0, 0]);
    assert.equal(result.lscr, -1);
    assert.equal(result.fte, 90);
    assert.deepEqual(
      result.discDeaths.map(({ i, m, f }) => ({ i, m, f })),
      [
        { i: 0, m: 3, f: 0 },
        { i: 1, m: 3, f: 0 },
      ],
    );
    assert.equal(result.discs.filter(Boolean).length, 0);
    assert.equal(frame(`instant-goal-ty${ty}-teams-absent`, 2).fte, 89);
  }
  console.log(
    JSON.stringify(
      { schema: 'bonk-rl-env.native-lifecycle-probe', version: 1, pass: true, provenance: oracle.provenance, results },
      null,
      2,
    ),
  );
} finally {
  oracle.dispose();
}
