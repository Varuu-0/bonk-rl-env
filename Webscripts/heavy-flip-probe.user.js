// ==UserScript==
// @name         Bonk Heavy-Flip Probe
// @namespace    bonk-rl-env
// @version      1.0.0
// @description  Measures the true upper bound of shift-toggle amplification by flipping the heavy bit (16) on outgoing input packets. Research probe, not a lag tool. See docs/NETWORK_INPUT_AMPLIFICATION.md.
// @match        https://bonk.io/gameframe-release.html
// @match        https://bonk2.io/gameframe-release.html
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * BONK HEAVY-FLIP PROBE
 * ---------------------
 * Answers one question with measurement instead of folklore: how much can you
 * actually amplify a lobby by spamming shift?
 *
 * The short version, from docs/DEOBFUSCATION.md and docs/LIVE_STATE_EXTRACTION.md:
 * the client samples its input state once per server tick (30 TPS) and ships one
 * packet per tick as 42[4,{i,f,c}], where `i` is the packed bitfield
 * (1=left 2=right 4=up 8=down 16=heavy 32=special). Holding or mashing shift at
 * any human rate collapses to at most one heavy transition per outgoing packet,
 * so the wire ceiling is ~15 transitions/second, and each packet is ~40 bytes.
 * There is no amplification path to exploit. This probe demonstrates the ceiling.
 *
 * WHAT IT DOES
 *   - Hooks WebSocket.prototype.send on the bonk game socket only
 *     (url contains "socket.io/?EIO=3&transport=websocket&sid=", same selector
 *     BonkLIB-1.2.3.js and greninja-bonking-bonk-mod.user.js use).
 *   - In PROBE mode it reads the next N input packets and logs `i`, its binary,
 *     `f`, and the heavy bit. It mutates nothing.
 *   - In ARMED mode it rewrites `i` on each outgoing packet so the heavy bit
 *     alternates. That is the theoretical maximum the protocol allows.
 *   - It never touches game state. Your own client is unaffected; other players
 *     see the enter-heavy branch fire at packet rate.
 *
 * UI
 *   - START / STOP arms and disarms the flip.
 *   - The x button tears everything down: prototype restored (if still ours),
 *     timers and listeners cleared, panel and style removed, API deleted.
 *   - Drag the header to move it; position persists in localStorage.
 *
 * KEYS
 *   Ctrl+Shift+H  arm / stop
 *   Ctrl+Shift+P  probe next 12 outgoing input packets (mutates nothing)
 *   Ctrl+Shift+R  reset counters
 *
 * CONSOLE PASTE
 *   Also works pasted into the DevTools console, either in the gameframe or in
 *   the top window (it hunts for #maingameframe). Re-pasting while live flashes
 *   the existing panel instead of double-hooking.
 *
 * ETHICS / SCOPE
 *   Read-only observation plus a wire-level rewrite of your own outgoing input
 *   bit. Nothing here writes to other clients, spoofs identity, or attacks the
 *   relay. Run it in a private room you host.
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------ contract
  const HEAVY_BIT = 16; // packed input bitfield, DEOBFUSCATION.md
  const OP_INPUTS = 4; // 42[4,{i,f,c}] outgoing inputs
  const SOCKET_MATCH = 'socket.io/?EIO=3&transport=websocket&sid=';
  const POLL_MS = 250; // gameframe hunt interval
  const POLL_MAX = 20000;
  const REASSERT_MS = 1000; // other mods replace prototype.send at boot
  const POS_KEY = 'heavyflip.pos';
  const PANEL_ID = '__hf_panel';
  const STYLE_ID = '__hf_style';

  if (window.__heavyFlip) {
    window.__heavyFlip.flash();
    return;
  }

  // --------------------------------------------------------------------- state
  const S = {
    frame: null, // window whose WebSocket we patched
    upstream: null, // the send we chained onto
    patched: null, // our wrapper, for identity checks
    armed: false,
    probeLeft: 0,
    dead: false, // set on teardown; any wrapper left in the chain no-ops
    conflict: false, // another live instance already owns this game socket
    token: {}, // identity used for cross-window ownership
    packets: 0, // outgoing input frames seen since arm/reset
    flips: 0, // heavy-bit transitions forced
    t0: 0,
  };

  let panel = null;
  let styleEl = null;
  let huntTimer = null;
  let paintTimer = null;
  let reassertTimer = null;
  let drag = null;
  let mounted = false;
  let depth = 0; // re-entrancy guard: only the outermost wrapper mutates

  // ------------------------------------------------------------------- helpers
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  const elapsed = () => (S.t0 ? (now() - S.t0) / 1000 : 0);
  const flipRate = () => {
    const t = elapsed();
    return t > 0 ? S.flips / t : 0;
  };
  const pktRate = () => {
    const t = elapsed();
    return t > 0 ? S.packets / t : 0;
  };

  const isTextField = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  };

  const whenBody = (fn) => {
    if (document.body) {
      fn();
      return;
    }
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  };

  const inGameframe = () => window !== window.top && /gameframe-release\.html/.test(location.href);

  // ----------------------------------------------------------------- gameframe
  const locateFrame = () => {
    if (inGameframe()) return window;
    const direct = document.getElementById('maingameframe');
    if (direct && direct.contentWindow) {
      try {
        if (/gameframe-release\.html/.test(direct.contentWindow.location.href)) return direct.contentWindow;
      } catch (_) {
        /* cross-origin */
      }
    }
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      try {
        if (/gameframe-release\.html/.test(frames[i].contentWindow.location.href)) return frames[i].contentWindow;
      } catch (_) {
        /* ignore */
      }
    }
    return null;
  };

  // --------------------------------------------------------------------- hook
  // Rewrites one outgoing frame if (and only if) it is a game input packet.
  // Returns the replacement string, or null to send the frame untouched.
  const mutate = (data) => {
    if (data.charCodeAt(0) !== 52 || data.charCodeAt(1) !== 50 || data.charCodeAt(2) !== 91) return null; // "42["

    let msg;
    try {
      msg = JSON.parse(data.slice(2));
    } catch (_) {
      return null;
    }
    if (!Array.isArray(msg) || msg[0] !== OP_INPUTS) return null;

    const p = msg[1];
    if (!p || typeof p.i !== 'number' || typeof p.f !== 'number') return null;

    S.packets++;

    if (S.probeLeft > 0) {
      S.probeLeft--;
      const bits = (p.i >>> 0).toString(2).padStart(6, '0');
      console.log(
        '[heavyflip] i=' + p.i + ' (0b' + bits + ') f=' + p.f + ' heavy=' + !!(p.i & HEAVY_BIT) + ' c=' + p.c,
      );
      if (S.probeLeft === 0) console.log('[heavyflip] probe complete.');
      return null;
    }

    if (!S.armed) return null;

    const on = S.flips % 2 === 0;
    p.i = on ? p.i | HEAVY_BIT : p.i & ~HEAVY_BIT;
    S.flips++;
    return '42' + JSON.stringify(msg);
  };

  const installHook = (fw) => {
    const WS = fw.WebSocket;
    if (!WS || !WS.prototype || typeof WS.prototype.send !== 'function') return false;

    // A second copy (userscript + console paste) would stack a second flip on
    // every packet and double the transition rate, invalidating the measurement.
    const owner = fw.__heavyFlipOwner;
    if (owner && owner.alive && owner.token !== S.token) {
      S.conflict = true;
      return false;
    }

    // Already live and still the installed wrapper.
    if (S.frame === fw && S.patched && WS.prototype.send === S.patched) return true;

    // Someone else (BonkLIB, a mod, a re-paste) replaced send after us: chain
    // onto whatever is current rather than resurrecting a stale upstream.
    const upstream = WS.prototype.send;

    const patched = function (data) {
      // If another script wrapped on top of us and we re-asserted, our older
      // wrapper is still further down the chain. Only the outermost one should
      // rewrite the frame, or the bit would be flipped twice per packet.
      if (depth > 0 || S.dead) return upstream.call(this, data);

      let out = data;
      depth++;
      try {
        if (
          typeof data === 'string' &&
          data.length > 3 &&
          this &&
          typeof this.url === 'string' &&
          this.url.indexOf(SOCKET_MATCH) !== -1
        ) {
          const next = mutate(data);
          if (next !== null) out = next;
        }
      } catch (_) {
        out = data; // mutation failed: send the frame exactly as the game built it
      }

      try {
        return upstream.call(this, out);
      } finally {
        depth--;
      }
    };

    // Tag it so re-pastes and teardown can recognise their own wrapper.
    patched.__heavyFlipPatched = true;

    try {
      WS.prototype.send = patched;
    } catch (_) {
      return false;
    }

    S.frame = fw;
    S.upstream = upstream;
    S.patched = patched;
    S.conflict = false;
    fw.__heavyFlipOwner = { alive: true, token: S.token };
    return true;
  };

  const removeHook = () => {
    if (!S.frame || !S.patched) return 'no hook';
    const WS = S.frame.WebSocket;
    if (!WS || !WS.prototype) return 'no socket api';

    if (WS.prototype.send !== S.patched) {
      // Another script wrapped us. Restoring S.upstream here would delete their
      // hook, so leave the chain intact; we simply stop mutating.
      return 'left chained (another script wrapped send after us)';
    }

    try {
      WS.prototype.send = S.upstream;
      return 'restored prototype.send';
    } catch (_) {
      return 'restore failed';
    }
  };

  // ----------------------------------------------------------------------- ui
  const CSS = [
    '#' + PANEL_ID + '{position:fixed;z-index:2147483647;width:174px;font:10.5px/1.45 ui-monospace,Consolas,monospace;',
    'color:#cfd6e4;background:rgba(12,14,20,.9);border:1px solid rgba(120,140,180,.32);border-radius:7px;',
    'box-shadow:0 4px 18px rgba(0,0,0,.55);user-select:none;overflow:hidden}',
    '#' + PANEL_ID + '.drag{opacity:.92}',
    '#__hf_hd{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 8px;cursor:grab;',
    'background:rgba(255,255,255,.035);border-bottom:1px solid rgba(120,140,180,.18)}',
    '#__hf_hd.drag{cursor:grabbing}',
    '#__hf_dot{width:6px;height:6px;border-radius:50%;background:#6b7280;flex:0 0 auto;transition:background .15s}',
    '#__hf_dot.on{background:#7ee787;box-shadow:0 0 6px #7ee78788}',
    '#__hf_dot.wait{background:#d29922}',
    '#__hf_title{flex:1 1 auto;letter-spacing:.06em;font-size:10px;color:#9aa4bb;text-transform:uppercase}',
    '#__hf_x{flex:0 0 auto;width:16px;height:16px;line-height:1;display:grid;place-items:center;cursor:pointer;',
    'color:#7b8499;background:transparent;border:0;border-radius:4px;font-size:12px;padding:0}',
    '#__hf_x:hover{color:#ff8a8a;background:rgba(255,90,90,.14)}',
    '#__hf_bd{padding:7px 8px 8px;display:flex;flex-direction:column;gap:6px}',
    '#__hf_tog{width:100%;padding:5px 0;font:inherit;font-size:10.5px;letter-spacing:.09em;cursor:pointer;',
    'color:#cfd6e4;background:rgba(255,255,255,.05);border:1px solid rgba(120,140,180,.3);border-radius:5px;',
    'transition:background .12s,border-color .12s,color .12s}',
    '#__hf_tog:hover:not(:disabled){background:rgba(255,255,255,.1)}',
    '#__hf_tog.on{color:#0d1117;background:#7ee787;border-color:#7ee787;font-weight:600}',
    '#__hf_tog.on:hover{background:#9bef9f}',
    '#__hf_tog:disabled{opacity:.42;cursor:default}',
    '#__hf_stat{display:flex;justify-content:space-between;gap:4px;color:#78829a;font-size:10px;letter-spacing:.02em}',
    '#__hf_stat b{color:#aab4c9;font-weight:500}',
    '#__hf_note{color:#5f6879;font-size:9.5px;letter-spacing:.02em;text-align:center}',
  ].join('');

  const persistPos = () => {
    if (!panel) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
    } catch (_) {
      /* private mode */
    }
  };

  const restorePos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && p.left && p.top) {
        panel.style.left = p.left;
        panel.style.top = p.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  };

  const clampIntoView = () => {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const maxL = Math.max(4, window.innerWidth - r.width - 4);
    const maxT = Math.max(4, window.innerHeight - r.height - 4);
    const curL = parseFloat(panel.style.left);
    const curT = parseFloat(panel.style.top);
    const l = Math.min(Math.max(4, isNaN(curL) ? r.left : curL), maxL);
    const t = Math.min(Math.max(4, isNaN(curT) ? r.top : curT), maxT);
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };

  const paint = () => {
    if (!panel) return;
    const dot = panel.querySelector('#__hf_dot');
    const tog = panel.querySelector('#__hf_tog');
    const stat = panel.querySelector('#__hf_stat');
    const note = panel.querySelector('#__hf_note');

    const hooked = !!(S.patched && S.frame && S.frame.WebSocket && S.frame.WebSocket.prototype.send === S.patched);

    dot.className = S.armed ? 'on' : hooked ? '' : 'wait';
    tog.disabled = !hooked;
    tog.className = S.armed ? 'on' : '';
    tog.textContent = S.armed ? 'STOP' : 'START';
    tog.title = hooked
      ? S.armed
        ? 'Disarm the heavy flip'
        : 'Arm the heavy flip'
      : 'Waiting for the game socket hook';

    stat.innerHTML =
      '<span>pkts <b>' +
      S.packets +
      '</b></span>' +
      '<span>trans <b>' +
      S.flips +
      '</b></span>' +
      '<span><b>' +
      flipRate().toFixed(1) +
      '</b>/s</span>';

    note.textContent = S.conflict
      ? 'another instance active'
      : hooked
        ? S.armed
          ? 'armed / ' + pktRate().toFixed(0) + ' pkt/s'
          : 'idle / ctrl+shift+p to probe'
        : 'hunting game socket';
  };

  const flash = () => {
    if (!panel) return;
    if (typeof panel.animate === 'function') {
      panel.animate([{ boxShadow: '0 0 0 0 rgba(126,231,135,.7)' }, { boxShadow: '0 0 0 8px rgba(126,231,135,0)' }], {
        duration: 420,
        easing: 'ease-out',
      });
    }
  };

  const buildPanel = () => {
    if (mounted) return;
    mounted = true;

    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div id="__hf_hd">' +
      '<span id="__hf_dot"></span>' +
      '<span id="__hf_title">heavy-flip</span>' +
      '<button id="__hf_x" type="button" title="Disable and close completely">x</button>' +
      '</div>' +
      '<div id="__hf_bd">' +
      '<button id="__hf_tog" type="button" disabled>START</button>' +
      '<div id="__hf_stat"></div>' +
      '<div id="__hf_note">hunting game socket</div>' +
      '</div>';
    document.body.appendChild(panel);

    if (!restorePos()) {
      panel.style.right = '10px';
      panel.style.bottom = '10px';
    }

    panel.querySelector('#__hf_tog').addEventListener('click', (e) => {
      e.stopPropagation();
      setArmed(!S.armed);
    });

    panel.querySelector('#__hf_x').addEventListener('click', (e) => {
      e.stopPropagation();
      teardown();
    });

    const hd = panel.querySelector('#__hf_hd');
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#__hf_x')) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      hd.classList.add('drag');
      if (hd.setPointerCapture) hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const maxL = window.innerWidth - panel.offsetWidth - 4;
      const maxT = window.innerHeight - panel.offsetHeight - 4;
      panel.style.left = Math.min(Math.max(4, e.clientX - drag.dx), Math.max(4, maxL)) + 'px';
      panel.style.top = Math.min(Math.max(4, e.clientY - drag.dy), Math.max(4, maxT)) + 'px';
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      hd.classList.remove('drag');
      clampIntoView();
      persistPos();
    };
    hd.addEventListener('pointerup', endDrag);
    hd.addEventListener('pointercancel', endDrag);

    paint();
  };

  // ------------------------------------------------------------- arm / disarm
  const setArmed = (next) => {
    if (next && !S.patched) {
      console.warn('[heavyflip] game socket not hooked yet');
      return;
    }
    S.armed = !!next;
    if (S.armed) {
      S.t0 = now();
      S.flips = 0;
      S.packets = 0;
    }
    console.log('[heavyflip] ' + (S.armed ? 'ARMED - flipping heavy bit at packet rate' : 'stopped'));
    paint();
  };

  // ---------------------------------------------------------------- teardown
  const teardown = () => {
    S.armed = false;
    S.probeLeft = 0;
    S.dead = true;

    const hookResult = removeHook();

    // Release cross-window ownership so a fresh paste can hook immediately.
    if (S.frame) {
      try {
        const owner = S.frame.__heavyFlipOwner;
        if (owner && owner.token === S.token) {
          owner.alive = false;
          delete S.frame.__heavyFlipOwner;
        }
      } catch (_) {
        /* frame went away */
      }
    }

    S.frame = null;
    S.upstream = null;
    S.patched = null;

    if (huntTimer) {
      clearInterval(huntTimer);
      huntTimer = null;
    }
    if (paintTimer) {
      clearInterval(paintTimer);
      paintTimer = null;
    }
    if (reassertTimer) {
      clearInterval(reassertTimer);
      reassertTimer = null;
    }

    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', clampIntoView);

    if (panel) {
      panel.remove();
      panel = null;
    }
    if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
    mounted = false;

    delete window.__heavyFlip;
    console.log('[heavyflip] closed - ' + hookResult + '; timers and listeners cleared');
  };

  // --------------------------------------------------------------------- keys
  const onKey = (e) => {
    if (isTextField()) return;
    if (!e.ctrlKey || !e.shiftKey) return;

    const k = (e.key || '').toUpperCase();
    if (k === 'H') {
      e.preventDefault();
      setArmed(!S.armed);
      return;
    }
    if (k === 'P') {
      e.preventDefault();
      S.probeLeft = 12;
      console.log('[heavyflip] probing next 12 outgoing input packets (nothing is mutated)');
      paint();
      return;
    }
    if (k === 'R') {
      e.preventDefault();
      S.packets = 0;
      S.flips = 0;
      S.t0 = now();
      paint();
      console.log('[heavyflip] counters reset');
    }
  };

  // --------------------------------------------------------------------- boot
  S.t0 = now();
  whenBody(buildPanel);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', clampIntoView);

  let waited = 0;
  huntTimer = setInterval(() => {
    const fw = locateFrame();
    if (fw && installHook(fw)) {
      clearInterval(huntTimer);
      huntTimer = null;
      paint();
      console.log('[heavyflip] hooked game socket. Ctrl+Shift+P to probe, then START.');
      return;
    }
    if (S.conflict) {
      clearInterval(huntTimer);
      huntTimer = null;
      paint();
      console.warn('[heavyflip] another heavy-flip instance already owns this game socket - close that one first');
      return;
    }
    waited += POLL_MS;
    if (waited >= POLL_MAX) {
      clearInterval(huntTimer);
      huntTimer = null;
      paint();
      console.warn('[heavyflip] no gameframe found - load a lobby, or paste inside the gameframe console');
    }
  }, POLL_MS);

  // Other bonk scripts replace WebSocket.prototype.send at document-start and
  // re-install on a schedule ([0,50,250,1000,3000] in Bonk Enhanced). If ours
  // gets buried, chain back on top so the hook survives script load order.
  reassertTimer = setInterval(() => {
    if (!S.frame || !S.patched) return;
    const WS = S.frame.WebSocket;
    if (!WS || !WS.prototype) return;
    if (WS.prototype.send === S.patched) return;
    installHook(S.frame);
  }, REASSERT_MS);

  paintTimer = setInterval(paint, 400);

  // ---------------------------------------------------------------------- api
  window.__heavyFlip = {
    get state() {
      return {
        armed: S.armed,
        hooked: !!S.patched,
        packets: S.packets,
        transitions: S.flips,
        flipsPerSecond: flipRate(),
        packetsPerSecond: pktRate(),
      };
    },
    arm() {
      setArmed(true);
      return 'armed';
    },
    stop() {
      setArmed(false);
      return 'stopped';
    },
    probe(n) {
      S.probeLeft = n || 12;
      return 'probing ' + (n || 12);
    },
    reset() {
      S.packets = 0;
      S.flips = 0;
      S.t0 = now();
      paint();
      return 'reset';
    },
    flash: flash,
    close: teardown,
    help() {
      console.log(
        [
          'panel: START/STOP arms and disarms; x closes and restores everything',
          'Ctrl+Shift+H  arm / stop',
          'Ctrl+Shift+P  probe next 12 outgoing input packets (mutates nothing)',
          'Ctrl+Shift+R  reset counters',
          '__heavyFlip.close()  same as the x button',
        ].join('\n'),
      );
    },
  };

  console.log('[heavyflip] loaded - panel mounts bottom-right. Ctrl+Shift+P first, then START.');
})();
