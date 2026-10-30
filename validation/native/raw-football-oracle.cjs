'use strict';

// Pinned original Football oracle. Exact original raw FootballPhysics spans
// (createNewState, step, Ball, FootballPlayer, FootballWall) execute in memory
// against the pinned modified Box2D and SafeTrig. Research only; no extracted
// proprietary implementation is stored in the package. No network/DOM/
// filesystem/process capability is supplied to the VM. VM is not an
// adversarial-code security sandbox; the inputs must match reviewed hashes.
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const RAW_SHA = 'e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e';
const BOX_SHA = '0f7645c88f53b51b731819c2f8ee3d9af5040c3c741371f8b1ff82c2074f3a83';
const TRIG_SHA = 'd1d09e414ba4c16bfb9ce8492f135bbc87b581c364a3b91019c4f93a18557b08';

function pinned(file, hash) {
  const bytes = fs.readFileSync(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, 'Unrecognized reference bytes');
  return bytes.toString('utf8');
}

function createFootballOracle({ rawPath, physicsPath, trigPath }) {
  const raw = pinned(rawPath, RAW_SHA);
  const box = pinned(physicsPath, BOX_SHA);
  const trig = pinned(trigPath, TRIG_SHA);
  const start = raw.indexOf('requirejs(');
  assert.equal(start, 1681105, 'Unexpected decoder boundary');
  const functions = [
    {
      name: 'createNewState',
      start: 1995916,
      end: 1997724,
      hash: '7931fc0d212419a6e1e179ff9f069bdc784c0f56da763214fa5613e00e2aa6b5',
    },
    {
      name: 'step',
      start: 2007380,
      end: 2011893,
      hash: '9c047e7c54bb697081a325bd04d9566e042175afcb92135ebebe5309b54f31c4',
    },
    {
      name: 'Ball',
      start: 2011894,
      end: 2013207,
      hash: '90ed8fc2e90a9c14392fb472480053e241ad36ff67062f015e3da36e91bbbac9',
    },
    {
      name: 'FootballPlayer',
      start: 2013207,
      end: 2017290,
      hash: '682924b3c9905df70072d96d2e6e9b058f51162a0642c3a836fbd13ea91d551d',
    },
    {
      name: 'FootballWall',
      start: 2017290,
      end: 2021975,
      hash: 'cf1b021b2245b294334944d3dbee0df7475975fb00301fc216f8638fd2ad8cda',
    },
  ];
  for (const entry of functions) {
    entry.code = raw.slice(entry.start, entry.end);
    assert.equal(createHash('sha256').update(entry.code).digest('hex'), entry.hash, 'Function span drift');
  }
  // The untouched client domain guard hashes location.hostname. Supply the
  // observed public page origin as environment data, not patched guard results.
  const context = vm.createContext({
    location: { hostname: 'bonk.io', href: 'https://bonk.io/gameframe-release.html' },
  });
  const run = (code, name, timeout = 10000) =>
    new vm.Script(code, { filename: name }).runInContext(context, { timeout });
  run('var B3jF8 = {};\n' + raw.slice(0, start), 'original-raw-decoder.js', 30000);
  run(
    raw
      .slice(start, raw.indexOf('function(E3G,p5h,Q2K)', start))
      .replace('requirejs(', 'var originalModuleNames = ')
      .replace(/,$/, ';'),
    'original-require-arguments.js',
  );
  run(
    'originalModuleNames = originalModuleNames.map(function (name) { return B3jF8[name]; });',
    'original-require-arguments-resolve.js',
  );
  run(trig, 'pinned-SafeTrig.js');
  run('var Box2D; function define(factory) { Box2D = factory(); }\n' + box, 'pinned-Box2D.js');
  run(
    `
    var k7V = B3jF8;
    var t$e = [];
    t$e[0] = [undefined, undefined, Box2D];
    t$e[5] = M$QCc;
    // B is the raw FootballPhysics module object: the step span reads its
    // statics (world, soundsThisStep, contactListener) directly.
    var B = { world: null, soundsThisStep: [], contactListener: null };
    var aliases = {
      1:Box2D.Common.Math.b2Vec2,82:Box2D.Dynamics.b2BodyDef,23:Box2D.Dynamics.b2World,
      40:Box2D.Dynamics.b2Body,56:Box2D.Dynamics.b2FixtureDef,52:Box2D.Dynamics.b2Fixture,
      78:Box2D.Collision.Shapes.b2MassData,34:Box2D.Collision.Shapes.b2PolygonShape,
      75:Box2D.Collision.Shapes.b2CircleShape,17:Box2D.Dynamics.b2DebugDraw,54:Box2D.Common.Math.b2Math,
      27:Box2D.Dynamics.Joints.b2RevoluteJointDef,33:Box2D.Dynamics.Joints.b2RevoluteJoint,
      57:Box2D.Dynamics.Joints.b2PrismaticJointDef,28:Box2D.Dynamics.Joints.b2PrismaticJoint,
      79:Box2D.Dynamics.Joints.b2DistanceJoint,84:Box2D.Dynamics.Joints.b2DistanceJointDef,
      26:Box2D.Dynamics.Joints.b2GearJointDef,12:Box2D.Collision.b2AABB
    };
    for (var key of Object.keys(aliases)) t$e[key] = aliases[key];
    ${functions[2].code}
    ${functions[3].code}
    ${functions[4].code}
    B.createNewState = (${functions[0].code});
    B.step = (${functions[1].code});
  `,
    'original-raw-football-bindings.js',
  );
  let disposed = false;
  function call(expression, args) {
    assert(!disposed, 'Oracle disposed');
    context.__args = args;
    try {
      return run(expression, 'original-football-call.js', 10000);
    } finally {
      delete context.__args;
    }
  }
  return {
    createNewState(...args) {
      const result = call('B.createNewState(...__args)', args);
      if (result === undefined) throw new Error('Unmodified raw client guard rejected the supplied environment');
      return result;
    },
    step(...args) {
      return call('B.step(...__args)', args);
    },
    provenance: {
      rawSha256: RAW_SHA,
      boxSha256: BOX_SHA,
      trigSha256: TRIG_SHA,
      functions: functions.map(({ name, start, end, hash }) => ({ name, start, end, hash })),
    },
    dispose() {
      disposed = true;
    },
  };
}

module.exports = { createFootballOracle };
