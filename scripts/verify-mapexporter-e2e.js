// Full end-to-end verification of mapexporter's real closure. Covers both the
// tick-state fallback and the preferred decoded gs.map export path.
'use strict';

const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('Webscripts/mapexporter.js', 'utf8');
const nodesById = new Map();
const scheduledTimers = [];
const scheduledIntervals = [];
const downloadedBlobs = [];
const revokedUrls = [];

function makeElement() {
  return {
    style: {},
    textContent: '',
    setAttribute: () => {},
    addEventListener: () => {},
    appendChild: () => {},
    click() { this.clicked = true; },
    remove() { this.parentNode?.removeChild(this); },
  };
}

const body = {
  children: [],
  appendChild(node) {
    this.children.push(node);
    node.parentNode = this;
    if (node.id) nodesById.set(node.id, node);
    return node;
  },
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node.id) nodesById.delete(node.id);
    node.parentNode = null;
  },
};

const sb = {
  console,
  document: {
    readyState: 'loading',
    addEventListener: () => {},
    getElementById: id => nodesById.get(id) || null,
    createElement: makeElement,
    body,
    head: { appendChild: () => {} },
  },
  alert: () => {},
  Blob: class {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      downloadedBlobs.push(this);
    }
  },
  URL: {
    createObjectURL: () => `blob:${downloadedBlobs.length}`,
    revokeObjectURL: url => revokedUrls.push(url),
  },
  setInterval: (callback, delay) => {
    scheduledIntervals.push({ callback, delay });
    return scheduledIntervals.length;
  },
  setTimeout: (callback, delay) => {
    scheduledTimers.push({ callback, delay });
    return scheduledTimers.length;
  },
  addEventListener: () => {},
};
sb.window = sb;
sb.globalThis = sb;

// Expose closure-local functions without reimplementing any exporter logic.
const closing = src.lastIndexOf('})();');
const injected = src.slice(0, closing)
  + 'globalThis.__mapexporter={extractMap,KNOWN,getUnknownFields:()=>clone(unknownFields),injectButton,startPolling};'
  + src.slice(closing);
vm.createContext(sb);
vm.runInContext(injected, sb);

const {
  extractMap,
  KNOWN,
  getUnknownFields,
  injectButton,
  startPolling,
} = sb.__mapexporter;
const assert = (condition, message) => {
  if (!condition) throw new Error('ASSERT FAILED: ' + message);
};

// Realistic tick-state fixture: settings and metadata use their runtime names,
// and cap-zone l is a 30 Hz countdown rather than the map-definition seconds.
const tickFixture = {
  ms: { re: false, nc: true, pq: 1, gd: 25, fl: true },
  mm: {
    n: 'Test Map', a: 'Author', dbid: 42, dbv: 2, mo: 'b',
    rxid: 'tick-rxid', rxn: 'Tick RX', rxa: 'Tick Author', rxdb: 'tick-db',
  },
  physics: {
    ppm: 12,
    ss: 1,
    bodies: [
      {
        p: [10, 20], a: 0.5, av: 0.1, lv: [1, 2],
        cf: { x: 0, y: 0, ct: 0, w: true }, fz: null, fx: [0, 2, 3],
        s: {
          n: 'Ground', type: 's', fric: 0.3, re: 0.8, de: 0.5,
          f_c: 2, f_1: 1, f_2: 2, f_3: 3, f_4: 4, f_p: true, fricp: true,
        },
      },
      {
        p: [30, 40], a: 0, av: 0, lv: [0, 0], cf: null, fz: null, fx: [1],
        s: { n: 'Bounce', type: 'd', fric: 0.1, re: 1, de: 2, f_c: 4 },
      },
    ],
    fixtures: [
      { sh: 0, n: 'Top', fr: null, fp: null, re: null, de: null, f: 0xAA0000, d: false, np: true, ng: false },
      { sh: 1, n: 'Circle', fr: null, fp: null, re: null, de: null, f: 0x00FF00, d: true, np: false, ng: true },
      { sh: 0, n: 'Top2', fr: null, fp: null, re: null, de: null, f: 0x0000FF, d: false, np: false, ng: false },
      { sh: null, n: 'Shape-free', fr: null, fp: null, re: null, de: null, f: 0, d: false, np: false, ng: false },
    ],
    shapes: [
      { type: 'bx', w: 40, h: 10, c: [0, 0], a: 0, sk: false },
      { type: 'ci', r: 5, c: [0, 0], sk: false },
    ],
    joints: [
      { type: 'd', ba: 0, bb: 1, aa: [0, 0], ab: [1, 1], d: { fh: 1, dr: 0.5, cc: false, bf: 10, dl: false } },
      { type: 'chain', ba: 0, bb: 1, l: 5, d: { cc: false } },
      { type: 'g', ba: 0, bb: 1, d: { la: 0, ua: 1, ratio: 2 } },
    ],
    bro: [0, 1],
  },
  discs: [
    {
      x: 12, y: 22, sx: 400, sy: 300, xv: 0, yv: 0, a: 0, av: 0, team: 1,
      a1a: 0, a1: false, a2: false, ni: false, ds: 0, da: 0, lhid: 0, lht: 0,
      vt: 0, sxv: 0, syv: 0, swing: null, spawnTeamInfo: 1,
    },
  ],
  capZones: [{ ty: 1, p: 0, l: 300, i: 0, o: -1, ot: -1, f: -1 }],
};

const tickOut = extractMap(tickFixture, { capZoneTimeInTicks: true });
assert(tickOut.settings.re === false && tickOut.settings.nc === true && tickOut.settings.gd === 25,
  'tick settings come from ms');
assert(tickOut.metadata.version === null, 'tick state does not fabricate a map version');
assert(tickOut.metadata.dbid === 42, 'tick metadata comes from mm');
assert(tickOut.capZones[0].captureTime === 10, 'tick cap-zone l=300 converts to 10 seconds');

const canonicalFixture = tickOut.physicsFixtures[0];
assert(canonicalFixture.collisionGroup === 2 && canonicalFixture.collidesPlayers === true,
  'canonical fixture collision comes from its body surface');
assert(canonicalFixture.collidesGroup1 === 1 && canonicalFixture.collidesGroup4 === 4,
  'canonical fixture keeps all collision masks');

const resolvedFixture = tickOut.physicsBodies[0].fixtures[0];
assert(resolvedFixture.collidesGroup1 === 1 && resolvedFixture.collidesGroup4 === 4,
  'resolved fixture keeps all collision masks');
assert(resolvedFixture.collidesPlayers === true && resolvedFixture.fricPlayers === true,
  'resolved fixture inherits body surface player flags');

const flatFixture = tickOut.bodies.find(body => body.fixtureIndex === 0);
assert(flatFixture.fricPlayers === true, 'flat fixture preserves surface fricp');
const shapeFreeFixture = tickOut.bodies.find(body => body.fixtureIndex === 3);
assert(shapeFreeFixture && shapeFreeFixture.shapeIndex === null && shapeFreeFixture.type === null,
  'flat view retains fixtures without a shape');

assert(tickOut.physicsJoints[1].length === 5, 'chain joint length is retained');
assert(tickOut.physicsJoints[2].data.ratio === 2, 'gear joint data remains opaque but retained');

// Primary map definitions use m/s and cap-zone seconds. This validates the
// direct extraction path and removes false warnings for map-only fields.
const primaryMap = {
  v: 14,
  m: {
    n: 'Primary Map', a: 'Builder', dbid: 99, dbv: 3, authid: 'author-id',
    date: '2026-08-09', mo: 'b', pub: true, cr: ['Builder'],
    rxid: 'primary-rxid', rxn: 'Primary RX', rxa: 'RX Author', rxdb: 'primary-db',
    vu: 10, vd: 11,
  },
  s: { re: true, nc: false, pq: 2, gd: 20, fl: false },
  ms: { re: false, nc: true, pq: 1, gd: 25, fl: true },
  physics: tickFixture.physics,
  spawns: [{ n: 'spawn', x: 100, y: 200, xv: 0, yv: 0, priority: 1, f: true }],
  capZones: [{ n: 'Home', ty: 1, p: 0, l: 3, i: 0, o: -1, ot: -1, f: -1 }],
};

const primaryOut = extractMap(primaryMap);
assert(primaryOut.metadata.rxid === 'primary-rxid' && primaryOut.metadata.rxn === 'Primary RX',
  'primary metadata retains rxid and rxn');
assert(primaryOut.metadata.rxa === 'RX Author' && primaryOut.metadata.rxdb === 'primary-db',
  'primary metadata retains rxa and rxdb');
assert(primaryOut.metadata.version === 14, 'primary metadata retains top-level map version');
assert(primaryOut.settings.re === true && primaryOut.settings.pq === 2,
  'primary map settings take precedence over incidental ms settings');
assert(primaryOut.capZones[0].captureTime === 3, 'primary cap-zone time remains seconds');
const primaryUnknown = getUnknownFields();
assert(!primaryUnknown.root?.includes('spawns'), 'spawns is recognized on primary maps');
assert(!primaryUnknown['capZone[0]']?.includes('n'), 'cap-zone name is recognized on primary maps');
assert(KNOWN.root.has('spawns') && KNOWN.capzone.has('n'), 'KNOWN sets cover primary-map fields');

// Exercise the real button path: existing buttons remain usable, the primary
// source wins, anchors are attached then removed, and URL revocation is deferred.
const button = injectButton();
assert(button && injectButton() === button, 'injectButton returns the existing button');
sb.__bonkExportGameSettings = { map: primaryMap };
sb.__bonkExportState = tickFixture;
button.onclick();
assert(downloadedBlobs.length === 1, 'button download creates one blob');
const downloadedMap = JSON.parse(downloadedBlobs[0].parts.join(''));
assert(downloadedMap.metadata.rxdb === 'primary-db', 'button path preserves primary rx metadata');
assert(downloadedMap.spawns[0].name === 'spawn', 'button path prefers map-definition spawns');
assert(body.children.length === 1 && body.children[0] === button, 'temporary download anchor is removed');
assert(revokedUrls.length === 0, 'object URL is not revoked synchronously');
const releaseTimer = scheduledTimers.find(timer => timer.delay === 1000);
assert(releaseTimer, 'object URL revocation is scheduled');
releaseTimer.callback();
assert(revokedUrls.length === 1, 'object URL is revoked after the deferred callback');

// Tick-only button exports must use the explicit 30 Hz cap-zone conversion.
sb.__bonkExportGameSettings = null;
sb.__bonkExportState = tickFixture;
button.onclick();
assert(downloadedBlobs.length === 2, 'tick-only button path creates a second blob');
const tickDownloadedMap = JSON.parse(downloadedBlobs[1].parts.join(''));
assert(tickDownloadedMap.capZones[0].captureTime === 10,
  'tick-only button path converts cap-zone ticks to seconds');

// A tick-only capture must also make the button available through the poller.
startPolling(button);
const poll = scheduledIntervals[scheduledIntervals.length - 1];
poll.callback();
assert(button.textContent === '⬇ Test Map', 'poller recognizes tick-only map metadata');

console.log('FULL mapexporter end-to-end: ALL ASSERTIONS PASSED.');
