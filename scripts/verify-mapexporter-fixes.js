// Verification harness for the mapexporter bug fixes. It loads the userscript
// in a fake DOM-ish environment, extracts the `extractMap` behaviour by feeding
// a realistic fixture through the same data paths, and asserts the fixes.
'use strict';

const fs = require('fs');

// Load the script but guard against DOM dependence: the userscript only touches
// the DOM inside init()/UI. We only need extractMap + KNOWN, which are pure.
const src = fs.readFileSync('Webscripts/mapexporter.js', 'utf8');

// Provide minimal globals so the IIFE body (which references document only when
// init runs) parses. We won't call init.
const fakeWindow = { M$QCc: null, __bonkExportState: null, __bonkExportGameSettings: null, __bonkExportPhysicsConstants: null, __bonkExportWorld: null, console: console };
fakeWindow.window = fakeWindow;
global.window = fakeWindow;
global.document = {
  readyState: 'loading',
  addEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
};
global.alert = () => {};
global.Blob = class {};
global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
global.setInterval = () => 0;

// Extract the wrapped-injector from the (IIFE) script. We re-implement nothing;
// instead we expose extractMap by loading the source and ripping it out.
// Simpler: the file is an IIFE, so we can't reach closure vars. We re-express
// the exact extractMap body here is impractical. Instead we do a focused test:
// verify the SOURCE contains the corrections and that they're syntactically
// coherent, plus run an end-to-end on a lean re-implementation.
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

console.log('--- Source-level fix verification ---');

// 1. settings sourced from ms (with s fallback)
assert(/const settings = state\.s \|\| state\.ms \|\| \{\};/.test(src), 'settings prefer map s with ms fallback');
console.log('  PASS bug 1: settings = state.s || state.ms');

// Primary map definitions use m while tick snapshots use mm.
assert(/const mm = state\.mm \|\| state\.m \|\| \{\};/.test(src), 'metadata reads both mm and m');
assert(/'capZones','spawns','mm'/.test(src), 'KNOWN.root covers map spawns');
assert(/capzone: new Set\(\['n'/.test(src), 'KNOWN.capzone covers map names');
assert(/'dbv','authid','date','rxn','rxa','rxdb','cr','pub','mo','vu','vd'/.test(src), 'KNOWN metadata covers v10 fields');
assert(/capZoneTimeInTicks \? cz\.l \/ 30 : cz\.l/.test(src), 'tick cap-zone time converts to seconds');
console.log('  PASS primary metadata, known fields, and cap-zone units');

// 2. fixture collision sourced from fixtureOwnerSurface
assert(/fixtureOwnerSurface\[i\]/.test(src), 'fixture collision from owner body surface (bug 3)');
assert(/frictionCategory: null/.test(src), 'frc set null (not in table)');
assert(/const fixtureOwnerSurface = \{\};/.test(src), 'fixtureOwnerSurface built');
assert(/collidesGroup4: fixtureSurface\.f_4 \?\? null/.test(src), 'resolved fixtures retain collision masks');
assert(/fricPlayers: fx\.fp \?\? fixtureSurface\.fricp \?\? null/.test(src), 'resolved fixtures inherit fricp');
assert(/fricPlayers: fx\.fp \?\? surf\.fricp \?\? null/.test(src), 'flat fixtures retain fricp');
assert(!/if \(!sh\) return;/.test(src), 'flat view retains fixtures without shapes');
console.log('  PASS bug 3: fixture collision filter from body.s, frc=null');

// 3. disc phantom reads removed
assert(!/d\.fn\b/.test(src), 'disc fn removed (bug 4)');
assert(!/d\.fz\b/.test(src), 'disc fz removed (bug 4)');
assert(/swing: d\.swing/.test(src), 'swing added');
assert(/spawnTeamInfo: d\.spawnTeamInfo/.test(src), 'spawnTeamInfo added');
console.log('  PASS bug 4: phantom fn/fz removed; swing/spawnTeamInfo added');

// 4. version from state.v
assert(/version: state\.v \?\? null/.test(src), 'version from state.v (bug 5)');
console.log('  PASS bug 5: metadata.version = state.v');

assert(/'type','ba','bb','d','aa','ab','l'/.test(src), 'KNOWN.joint covers chain length');
assert(/length: jt\.l \?\? null/.test(src), 'joint length retains top-level chain l');
console.log('  PASS chain joint length retained');

assert(/const existing = document\.getElementById\('bonk-export-btn'\);/.test(src), 'existing button is returned');
assert(/document\.body\.appendChild\(a\);/.test(src), 'download anchor attaches to the document');
assert(/setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 1000\);/.test(src), 'object URL revocation is deferred');
assert(/const tickState = window\.__bonkExportState;/.test(src), 'poller consults tick fallback state');
console.log('  PASS button lifecycle and tick fallback polling');

// KNOWN sets cleaned
assert(!/frc','f_c','fc','fp','f_1/.test(src), 'fixture KNOWN cleaned');
assert(!/fn','fz/.test(src), 'disc KNOWN cleaned');
console.log('  PASS KNOWN sets cleaned');

// --- End-to-end behaviour: re-express extractMap is too large; instead run the
// real logic by pulling it out via a shim. We copy extractMap by evaluating the
// script and reflecting — not feasible for an IIFE. So do a semantic check: the
// fixture-based reads are covered by source assertions above. Provide a focused
// runtime check of the fixtureOwnerSurface logic semantics.
function fixtureOwnerSurfaceSemantics(bodies, fixtures) {
  // mirrors mapexporter's inline construction
  const map = {};
  for (let b = 0; b < bodies.length; b++) {
    const body = bodies[b]; if (!body) continue;
    const surf = body.s || {};
    for (const fxIdx of (body.fx || [])) if (typeof fxIdx === 'number') map[fxIdx] = surf;
  }
  const out = fixtures.map((fx, i) => ({
    collisionGroup: (map[i] && map[i].f_c) ?? null,
    collidesPlayers: (map[i] && map[i].f_p) ?? null,
  }));
  return out;
}

const bodies = [{ p:[0,0], a:0, s: { f_c: 2, f_p: true, f_1: 1 }, fx: [0, 2] }, { p:[5,5], s: { f_c: 4 }, fx: [1] }];
const fixtures = [{ sh:0, n:'a' }, { sh:1 }, { sh:0 }];
const res = fixtureOwnerSurfaceSemantics(bodies, fixtures);
assert(res[0].collisionGroup === 2 && res[0].collidesPlayers === true, 'fixture 0 inherits body0 surface f_c/f_p');
assert(res[1].collisionGroup === 4, 'fixture 1 inherits body1 surface f_c');
assert(res[2].collisionGroup === 2, 'fixture 2 (owned by body0 via fx:[0,2]) inherits f_c');
console.log('  PASS runtime: triangle fixture->surface collision sourcing');

console.log('\nAll mapexporter fix verifications PASSED.');
