'use strict';
// Native-only fixture search; no local outputs are used to define expected data.
const fs = require('node:fs');
const { createOracle } = require('./raw-physics-oracle.cjs');
const oracle = createOracle({
  rawPath: '.deobf/alpha2s.raw.js',
  physicsPath: '.local-artifacts/native-reference/Box2DModuleGJMod.js',
  trigPath: '.local-artifacts/native-reference/SafeTrig.js',
});
const base = JSON.parse(fs.readFileSync('maps/training-platform.json', 'utf8'));
const zero = () => ({ left: false, right: false, up: false, down: false, action: false, action2: false });
try {
  for (const x of [15, 14.8, 14.5])
    for (const y of [15, 14.8, 14.5, 14])
      for (const xv of [0, 2, 6]) {
        const map = JSON.parse(JSON.stringify(base));
        map.spawns = [map.spawns[0], ...map.spawns];
        map.physics.shapes.push({ type: 'bx', w: 12, h: 12, c: [0, 0], a: 0, sk: false });
        map.physics.fixtures.push({ ...map.physics.fixtures[0], sh: 1, d: false });
        const body = JSON.parse(JSON.stringify(map.physics.bodies[0]));
        body.p = [16.7 * 12 - 365, 15 * 12 - 250];
        body.fx = [1];
        map.physics.bodies.push(body);
        map.physics.bro.push(1);
        const settings = { ga: 'b', mo: 'v', tea: false, bal: [0], map, gt: 2, wl: 3, q: false, maps: [] };
        let state = oracle.createNewState([{ id: 0, team: 1 }], map, 1, false, null, settings, true);
        state.ftu = -1;
        Object.assign(state.discs[0], { x, y, xv, yv: 0, a: 0, av: 0 });
        const trace = [];
        for (let tick = 1; tick <= 8; tick++) {
          state = oracle.step(state, [zero()], null, 30, settings, 1, false, undefined);
          trace.push({
            tick,
            disc: state.discs[0] && {
              x: state.discs[0].x,
              y: state.discs[0].y,
              xv: state.discs[0].xv,
              yv: state.discs[0].yv,
              a: state.discs[0].a,
              av: state.discs[0].av,
            },
          });
          if (Math.abs(state.discs[0]?.av || 0) > 1e-12) break;
        }
        console.log(JSON.stringify({ x, y, xv, trace }));
      }
} finally {
  oracle.dispose();
}
