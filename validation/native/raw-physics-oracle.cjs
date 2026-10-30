'use strict';

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

// Research only. Exact original raw functions and decoder preamble execute in
// memory; no extracted proprietary implementation is stored in the package.
// No network/DOM/filesystem/process capability is supplied to the VM. VM is not
// an adversarial-code security sandbox; the inputs must match reviewed hashes.
function createOracle({ rawPath, physicsPath, trigPath }) {
  const raw = pinned(rawPath, RAW_SHA);
  const box = pinned(physicsPath, BOX_SHA);
  const trig = pinned(trigPath, TRIG_SHA);
  const start = raw.indexOf('requirejs(');
  assert.equal(start, 1681105, 'Unexpected decoder boundary');
  const functions = [
    {
      name: 'createNewState',
      start: 1771638,
      end: 1790433,
      hash: 'a25d16f355bed2bd15bf0738df26c7ed7ca0d65c921e092500b48bf4c5992f84',
    },
    {
      name: 'step',
      start: 1790462,
      end: 1862467,
      hash: '60cf39290eb8ada29646c29137a9ce6164d69822335c966d8430302f7e33090e',
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
    // The raw engine symbol is z. Round rollover calls z.createNewState
    // directly, so its constructor/static world must be shared with instances.
    // I is the bundle's graphics namespace; only its shake coefficient is used
    // by the Classic step's optional presentation-event output.
    function z() {}
    var I = { shakeAmount: 0.012 };
    Object.assign(z, {world:null,ftu:90,fte:90,footHW:0.3,footHH:0.2,footOffsetX:-1,footOffsetY:0,swingF:2,swingD:0});
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
    z.createNewState = (${functions[0].code});
    z.prototype.step = (${functions[1].code});
    var physics = new z();
  `,
    'original-raw-physics-bindings.js',
  );
  run(
    `
    var nativeContactObservations = [];
    var nativeContactObservedListener = null;
    var nativeContactObservedBeginContact = null;
    function nativeContactObserveListener(listener) {
      if (!listener) throw new Error("Native contact observer requires the original contact listener");
      if (listener === nativeContactObservedListener && listener.BeginContact === nativeContactObservedBeginContact) return;
      var originalBeginContact = listener.BeginContact;
      var observedBeginContact = function (contact) {
        var a = contact.GetFixtureA();
        var b = contact.GetFixtureB();
        nativeContactObservations.push({
          fixtureA: a.GetUserData() ? a.GetUserData().type : null,
          fixtureB: b.GetUserData() ? b.GetUserData().type : null,
          bodyA: a.GetBody().GetUserData() ? a.GetBody().GetUserData().type : null,
          bodyB: b.GetBody().GetUserData() ? b.GetBody().GetUserData().type : null,
          touching: contact.IsTouching()
        });
        return originalBeginContact.apply(this, arguments);
      };
      listener.BeginContact = observedBeginContact;
      nativeContactObservedListener = listener;
      nativeContactObservedBeginContact = observedBeginContact;
    }
  `,
    'original-contact-observer-bindings.js',
  );
  let disposed = false;
  function call(expression, args) {
    assert(!disposed, 'Oracle disposed');
    context.__args = args;
    try {
      return run(expression, 'original-physics-call.js', 10000);
    } finally {
      delete context.__args;
    }
  }
  return {
    createNewState(...args) {
      const result = call('z.createNewState(...__args)', args);
      if (result === undefined) throw new Error('Unmodified raw client guard rejected the supplied environment');
      return result;
    },
    step(...args) {
      return call('physics.step(...__args)', args);
    },
    stepWithContactObserver(...args) {
      assert(!disposed, 'Oracle disposed');
      context.__args = args;
      try {
        return run(
          `(function () {
          var worldPrototype = Box2D.Dynamics.b2World.prototype;
          var originalSetContactListener = worldPrototype.SetContactListener;
          try {
            worldPrototype.SetContactListener = function (listener) {
              var result = originalSetContactListener.apply(this, arguments);
              nativeContactObserveListener(listener);
              return result;
            };
            return physics.step(...__args);
          } finally {
            worldPrototype.SetContactListener = originalSetContactListener;
          }
        })()`,
          'original-physics-call-with-contact-registration-observer.js',
          10000,
        );
      } finally {
        delete context.__args;
      }
    },
    provenance: {
      rawSha256: RAW_SHA,
      boxSha256: BOX_SHA,
      trigSha256: TRIG_SHA,
      functions: functions.map(({ name, start, end, hash }) => ({ name, start, end, hash })),
    },
    get Backend() {
      return run('Box2D', 'inspect-backend.js');
    },
    // Read-only validation access to the original per-step contact graph.
    // Physics.step remains the exact pinned function span above.
    inspectWorld() {
      return run('z.world', 'inspect-original-world.js');
    },
    instrumentContacts() {
      run(
        `
        if (!z.world) throw new Error("Native contact observer requires an initialized original world");
        var listener = z.world.m_contactManager.m_contactListener;
        if (!listener) throw new Error("Native contact observer requires the original contact listener");
        // Decorate only the active listener instance. Original round/world
        // recreation stays untouched; a transient registration observer is
        // scoped to one step below and restored in its finally block.
        nativeContactObserveListener(listener);
      `,
        'instrument-original-contact-listener.js',
      );
    },
    consumeContactObservations() {
      return run(
        'typeof nativeContactObservations === "undefined" ? [] : nativeContactObservations.splice(0, nativeContactObservations.length)',
        'consume-original-contact-observations.js',
      );
    },
    dispose() {
      disposed = true;
    },
  };
}

module.exports = { createOracle };
