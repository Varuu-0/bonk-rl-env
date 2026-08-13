// ==UserScript==
// @name         Bonk RL Native Trace Capture
// @namespace    bonk-rl-env
// @version      0.1.0
// @description  P4 differential-validation capture harness: records per-tick
//               native disc state (x,y,xv,yv,a,av,a1,a2,a1a,team,ds) and the
//               per-round ticket from a live/recorded match into a NativeTrace
//               JSON download, for offline replay against the local engine
//               (src/core/differential/replay-comparator.ts).
// @match        https://bonk.io/gameframe-release.html
// @match        https://bonk.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS (see docs/DIFFERENTIAL_VALIDATION.md and
 * docs/LIVE_STATE_EXTRACTION.md):
 *   1. Injects the same bonkCodeInjector used by capture-init/rl-live-bridge
 *      to snapshot `__bonkExportState` (the per-tick serialized state with
 *      discs[]) each physics tick.
 *   2. Each captured state is converted into a NativeTrace tick via the
 *      identical field set as src/core/differential/capture-recorder.ts
 *      (kept in sync manually): x,y,xv,yv,a,av,a1,a2,a1a,team,ds, alive =
 *      presence (LIVE_STATE_EXTRACTION §9.2/§9.4).
 *   3. window.__bonkRlTrace* exposes the recorder; a download button injects
 *      the full trace JSON as a file for the replay comparator.
 */

(function () {
  'use strict';

  const API = '__bonkRlTrace';
  if (window[API]) return;

  if (!Array.isArray(window.bonkCodeInjectors)) window.bonkCodeInjectors = [];

  function stateAnchorRegex() {
    return /[A-Za-z]\[[A-Za-z0-9$_]{3}(\[[0-9]{1,3}\]){2}\]={discs/;
  }

  // Bonk-Host's proven fig anchor: "[a5H[6] - 30]" -> figVar "a5H[6]"; the
  // first `figVar++;` is patched to also publish window.__bonkFig so tick
  // rebasing can use the true native frame counter (LIVE_STATE_EXTRACTION
  // §9.1) instead of a synthesized fallback.
  function figAnchorRegex() {
    return /\[[A-Za-z0-9\$_]{3}\[[0-9]{1,3}\] \- 30\]/;
  }

  window.bonkCodeInjectors.push(function traceInjector(code) {
    if (typeof code !== 'string') return code;

    // (b) monotonic frame counter capture (fig++) — do this FIRST so the
    // needle is guaranteed to be in the original code.
    try {
      const fm = code.match(figAnchorRegex());
      if (fm) {
        const figVar = fm[0].split(' ')[0].slice(1);
        const first = code.indexOf(figVar + '++;');
        if (first !== -1) {
          const patched = figVar + '++;window.__bonkFig=' + figVar + ';';
          code = code.slice(0, first) + patched + code.slice(first + (figVar + '++;').length);
        }
      }
    } catch (e) { /* fig is optional */ }

    // (a) state capture.
    const sm = code.match(stateAnchorRegex());
    if (sm) {
      const cap = '{try{if(arguments[0]&&arguments[0].discs){window.__bonkExportState=arguments[0];}if(arguments[4]){window.__bonkExportGameSettings=arguments[4];}}catch(e){}}';
      code = code.replace(sm[0], cap + sm[0]);
    }
    return code;
  });

  // ── Recorder (mirrors src/core/differential/capture-recorder.ts) ──────────
  const S = {
    recording: false,
    ticks: [],
    tps: 30,
    players: [],
    spawns: [],
    map: null,
    settings: null,
    roundStartFig: 0,
    rc: null,
  };

  function rebaseTick(state) {
    // Mirror the bridge's per-round rebase: track rc changes against the
    // injected monotonic fig (window.__bonkFig); when the fig injector did
    // not apply (older build), fall back to a local counter that ALSO
    // rebases to 0 on every rc change so rounds never leak ticks into each
    // other (§9.1 per-round rebase).
    let fig = null;
    if (typeof window.__bonkFig === 'number') fig = window.__bonkFig;
    const stateTicks = () => {
      if (fig === null) { S._fallback = (S._fallback || 0) + 1; return S._fallback; }
      return Math.max(0, fig - S.roundStartFig);
    };
    if (state) {
      const rc = state.rc;
      if (S.rc !== null && rc !== null && rc !== S.rc) {
        S.roundStartFig = fig ?? 0;
        if (fig === null) S._fallback = 0;
      }
      S.rc = rc !== undefined ? rc : S.rc;
    }
    return stateTicks();
  }

  function captureTick() {
    const state = window.__bonkExportState;
    if (!S.recording || !state || !state.discs) return;
    const t = rebaseTick(state);
    const discs = [];
    for (let i = 0; i < state.discs.length; i++) {
      const d = state.discs[i];
      discs.push(d ? {
        id: i,
        x: d.x ?? 0, y: d.y ?? 0,
        xv: d.xv ?? 0, yv: d.yv ?? 0,
        a: d.a ?? 0, av: d.av ?? 0,
        a1: d.a1 === true, a2: d.a2 === true,
        a1a: (typeof d.a1a === 'number') ? d.a1a : undefined,
        team: d.team, ds: d.ds,
        alive: true,
      } : null);
    }
    // Prefer the full game-settings map because it carries authored spawns.
    // If it is unavailable, keep the tick-state map and leave spawns empty so
    // the comparator can use its map-spawn fallback instead of fake (0, 0)s.
    const gameMap = window.__bonkExportGameSettings?.map;
    if (gameMap?.physics?.bodies) {
      S.map = gameMap;
      S.settings = gameMap.s || state.ms || state.s || null;
    } else if (S.map === null && state.physics) {
      S.map = state.physics;
      S.settings = state.ms || state.s || null;
    }
    if (S.players.length === 0) {
      S.tps = 30;
      const players = [];
      if (state.players) {
        for (let i = 0; i < state.players.length; i++) {
          const p = state.players[i];
          if (p) {
            players.push({ id: i, team: p.team });
          }
        }
      }
      if (players.length === 0 && state.discs.length > 0) {
        for (let i = 0; i < state.discs.length; i++) {
          if (state.discs[i]) {
            players.push({ id: i, team: state.discs[i].team });
          }
        }
      }
      S.players = players;
    }
    S.ticks.push({ t, discs });
  }

  const poller = setInterval(() => {
    // Only sample when the state object identity changed (a tick boundary).
    if (window.__bonkExportState && window.__bonkExportState !== S.lastState) {
      S.lastState = window.__bonkExportState;
      captureTick();
    }
  }, 33);

  function buildTrace() {
    return {
      schema: 'bonk.rl.env.native-trace',
      version: 1,
      tps: S.tps,
      map: S.map,
      settings: S.settings,
      players: S.players,
      spawns: S.spawns,
      ticks: S.ticks,
    };
  }

  function download() {
    const blob = new Blob([JSON.stringify(buildTrace(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bonk-native-trace.json';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  window[API] = {
    // Capture the CURRENT monotonic fig at recording start so a mid-session
    // recording still emits 0-based ticks (t = fig - roundStartFig) instead of
    // absolute-fig values until the next rc change rebases it.
    startRecording() { S.recording = true; S.ticks = []; S.map = null; S.players = []; S.spawns = []; S.settings = null; S.roundStartFig = (typeof window.__bonkFig === 'number') ? window.__bonkFig : 0; S.rc = null; S.lastState = null; S._fallback = 0; },
    stopRecording() { S.recording = false; },
    isRecording() { return S.recording; },
    getTrace() { return buildTrace(); },
    downloadTrace() { download(); },
  };

  console.log('[BonkTrace] native trace capture harness installed. Use __bonkRlTrace.startRecording()/.stopRecording()/.downloadTrace().');
})();
