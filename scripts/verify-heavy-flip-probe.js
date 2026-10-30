'use strict';

// Offline verification for Webscripts/heavy-flip-probe.user.js.
//
// Boots the userscript in a stub DOM with a fake bonk game socket and asserts
// the behaviours docs/NETWORK_INPUT_AMPLIFICATION.md relies on:
//   1. unarmed frames pass through byte-identical
//   2. armed frames alternate the heavy bit exactly once per packet
//   3. other input bits and the frame counter survive the rewrite
//   4. chat frames and non-game sockets are never touched
//   5. teardown restores WebSocket.prototype.send and stops mutating
//   6. re-asserting over a foreign wrapper still flips once (depth guard)
//   7. teardown never clobbers another script's wrapper
//
// Run: node scripts/verify-heavy-flip-probe.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'Webscripts', 'heavy-flip-probe.user.js');

const HEAVY_BIT = 16;
const GAME_URL = 'wss://bonk.io/socket.io/?EIO=3&transport=websocket&sid=test';

const results = [];
function check(cond, msg) {
  results.push({ ok: !!cond, msg });
}

function makeEl(tag) {
  const el = {
    tagName: tag,
    id: '',
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    offsetWidth: 174,
    offsetHeight: 64,
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    animate() {},
    appendChild(child) {
      return child;
    },
    setPointerCapture() {},
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 174, height: 64 };
    },
    querySelector(sel) {
      return makeEl(sel);
    },
  };
  return el;
}

function makeEnvironment() {
  const sent = [];
  const timers = [];
  const storage = new Map();

  const document = {
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    activeElement: null,
    createElement: makeEl,
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  function WebSocketStub() {}
  WebSocketStub.prototype.send = function (data) {
    sent.push({ url: this.url, data });
    return true;
  };

  const win = {
    performance: { now: () => Date.now() },
    location: { href: 'https://bonk.io/gameframe-release.html' },
    innerWidth: 1280,
    innerHeight: 720,
    WebSocket: WebSocketStub,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    addEventListener() {},
    removeEventListener() {},
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval() {},
  };
  win.top = {}; // distinct from win: script treats win as the gameframe
  win.window = win;

  return { win, document, WebSocketStub, sent, timers };
}

// The userscript reads these as bare globals.
function boot(env) {
  global.window = env.win;
  global.document = env.document;
  global.location = env.win.location;
  global.performance = env.win.performance;
  global.localStorage = env.win.localStorage;
  global.WebSocket = env.WebSocketStub;
  global.setInterval = env.win.setInterval;
  global.clearInterval = env.win.clearInterval;

  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(SRC, 'utf8'))();
  return env.win.__heavyFlip;
}

const frame = (i, f, c) => '42' + JSON.stringify([4, { i, f, c }]);
const payload = (raw) => JSON.parse(raw.slice(2))[1];

// ------------------------------------------------------------------ scenario 1
function scenarioBasics() {
  const env = makeEnvironment();
  const api = boot(env);

  check(api, 'api exposed');
  env.timers[0].fn(); // hunt interval installs the hook
  check(api.state.hooked, 'hook installed on the game socket');

  const sock = new env.WebSocketStub();
  sock.url = GAME_URL;

  sock.send(frame(0, 100, 1));
  check(env.sent[0].data === frame(0, 100, 1), 'unarmed frame passes through byte-identical');

  api.arm();
  sock.send(frame(0, 101, 2));
  sock.send(frame(0, 102, 3));
  sock.send(frame(0, 103, 4));

  const a = payload(env.sent[1].data);
  const b = payload(env.sent[2].data);
  const c = payload(env.sent[3].data);

  check((a.i & HEAVY_BIT) === HEAVY_BIT, 'packet 1 heavy bit set');
  check((b.i & HEAVY_BIT) === 0, 'packet 2 heavy bit cleared');
  check((c.i & HEAVY_BIT) === HEAVY_BIT, 'packet 3 heavy bit set');
  check(a.f === 101 && b.f === 102 && c.f === 103, 'frame counter preserved');
  check(api.state.transitions === 3, 'one transition per packet, no double count');

  api.stop();
  api.arm();
  sock.send(frame(1 | 4 | 8, 104, 5));
  const d = payload(env.sent[4].data);
  check((d.i & ~HEAVY_BIT) === (1 | 4 | 8), 'left/up/down bits preserved');

  api.stop();
  sock.send('42[20,{"message":"gg"}]');
  check(env.sent[5].data === '42[20,{"message":"gg"}]', 'chat frame untouched');

  const other = new env.WebSocketStub();
  other.url = 'wss://peerjs.example/peer';
  api.arm();
  other.send(frame(0, 105, 6));
  check(env.sent[6].data === frame(0, 105, 6), 'non-game socket untouched');
  api.stop();

  api.close();
  check(!env.win.__heavyFlip, 'api deleted on close');
  sock.send(frame(0, 106, 7));
  check(env.sent[7].data === frame(0, 106, 7), 'no mutation after close');
}

// ------------------------------------------------------------------ scenario 2
function scenarioReassert() {
  const env = makeEnvironment();
  const api = boot(env);

  env.timers[0].fn(); // hunt
  api.arm();

  // Another mod wraps send on top of ours, then we re-assert.
  const ours = env.WebSocketStub.prototype.send;
  env.WebSocketStub.prototype.send = function (d) {
    return ours.call(this, d);
  };
  env.timers[1].fn(); // re-assert interval

  check(env.WebSocketStub.prototype.send !== ours, 're-asserted on top of the foreign wrapper');

  const sock = new env.WebSocketStub();
  sock.url = GAME_URL;
  sock.send(frame(0, 500, 1));

  const p = payload(env.sent[env.sent.length - 1].data);
  check((p.i & HEAVY_BIT) === HEAVY_BIT, 'single flip through stacked wrappers');
  check(api.state.transitions === 1, 'exactly one transition through stacked wrappers');
}

// ------------------------------------------------------------------ scenario 3
function scenarioChainedTeardown() {
  const env = makeEnvironment();
  const api = boot(env);

  env.timers[0].fn();
  api.arm();

  const ours = env.WebSocketStub.prototype.send;
  let theirsCalls = 0;
  const theirs = function (d) {
    theirsCalls++;
    return ours.call(this, d);
  };
  env.WebSocketStub.prototype.send = theirs;

  api.close();

  check(env.WebSocketStub.prototype.send === theirs, 'foreign wrapper preserved on close');

  const sock = new env.WebSocketStub();
  sock.url = GAME_URL;
  sock.send(frame(0, 900, 1));

  check(theirsCalls === 1, 'foreign wrapper still invoked after close');
  check((payload(env.sent[env.sent.length - 1].data).i & HEAVY_BIT) === 0, 'no mutation after close');
}

// ------------------------------------------------------------------ scenario 4
function scenarioConflict() {
  const env = makeEnvironment();

  // Pretend another live instance (userscript + console paste) owns the frame.
  env.win.__heavyFlipOwner = { alive: true, token: {} };

  const api = boot(env);
  const before = env.WebSocketStub.prototype.send;

  // The script warns loudly on conflict; keep the harness output readable.
  const realWarn = console.warn;
  console.warn = () => {};
  env.timers[0].fn(); // hunt -> install attempt
  console.warn = realWarn;

  check(env.WebSocketStub.prototype.send === before, 'conflicting instance never patches send');
  check(api.state.hooked === false, 'conflicting instance reports not hooked');
  check(api.state.armed === false, 'conflicting instance cannot arm');

  // Owner dies; a fresh instance may take over.
  env.win.__heavyFlipOwner.alive = false;
  env.timers[0].fn();
  check(api.state.hooked === true, 'hook succeeds once the other instance is dead');
}

scenarioBasics();
scenarioReassert();
scenarioChainedTeardown();
scenarioConflict();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.msg);

if (failed.length > 0) {
  console.error('\nheavy-flip-probe verification failed: ' + failed.length + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('\nheavy-flip-probe verification passed (' + results.length + ' assertions)');
}
