// ==UserScript==
// @name         Bonk Map Exporter
// @namespace    https://bonk.io/
// @version      2.4.0
// @description  Extracts and exports the current Bonk.io map as faithful JSON, preserving the full body→fixture→shape hierarchy and all physics fields
// @author       you
// @match        https://bonk.io/gameframe-release.html
// @match        https://bonk.io/*
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
  'use strict';

  // ── Known field sets (from DemystifyBonk MAPFORMAT.md) ──────────────────────
  // These track which fields the exporter recognizes. Any unknown field encountered
  // at runtime is logged so the format can be kept up to date.
  const KNOWN = {
    root: new Set([
      'physics','discs','capZones','spawns','mm','m','re','rx','v',
      'discDeaths','seed','fte','ftu','players','scores',
      'lscr','ms','rl','projectiles','rc',
      'shk','sts','s',
    ]),
    physics: new Set([
      'ppm','ss','bodies','fixtures','shapes','joints','bro',
    ]),
    settings: new Set(['re','nc','pq','gd','fl','v']),
    mm: new Set([
      'n','a','dbid','v','rxid',
      'dbv','authid','date','rxn','rxa','rxdb','cr','pub','mo','vu','vd',
    ]),
    fixture: new Set([
      'sh','n','fr','re','de','d','np','ng','ig','f','fp',
    ]),
    shape: new Set(['type','c','w','h','r','v','a','s','sk']),
    body: new Set([
      'p','a','s','fx','lv','av','fric','re','de','type',
      'cf','fz',
    ]),
    surface: new Set([
      'n','type','fric','re','de','fc','f_c','fp','f_p',
      'f_1','f_2','f_3','f_4','fricp','frc','ld','ad','fr','bu',
    ]),
    disc: new Set([
      'x','y','sx','sy','xv','yv','a','av','team',
      'sxv','syv','a1a','a1','lhid','lht','ds','da','vt',
      'a2','ni','swing','spawnTeamInfo',
    ]),
    capzone: new Set(['n','ty','o','p','l','i','ot','f']),
    joint: new Set([
      'type','ba','bb','d','aa','ab','l',
      'pax','pay','pa','pf','pl','pu','plen','pms',
      'sax','say','sf','slen',
    ]),
    jointData: new Set([
      'la','ua','mmt','ms','el','em',
      'fh','dr','cc','bf','dl',
    ]),
  };

  let unknownFields = {};

  // The current client keeps property names in a loader-provided M$QCc table.
  // Export it with each map so a future investigation can reproduce the exact
  // symbol mapping for the client build that produced the capture.
  function captureRuntimeConstantTable() {
    const table = window.M$QCc;
    if (!Array.isArray(table)) return null;

    const entries = {};
    for (let i = 0; i < table.length; i++) {
      if (typeof table[i] === 'string') entries[i] = table[i];
    }
    return {
      length: table.length,
      entries,
    };
  }

  function checkUnknown(label, obj, knownSet) {
    if (!obj || typeof obj !== 'object') return;
    const extra = Object.keys(obj).filter(k => !knownSet.has(k));
    if (extra.length === 0) return;
    if (!unknownFields[label]) {
      unknownFields[label] = extra;
      console.warn(
        `%c[BonkExport] Unknown fields in ${label}: ${extra.join(', ')}`,
        'color:#ff9800;font-weight:bold'
      );
    }
  }

  // ── Deep clone a value, preserving arrays and nulls ────────────────────────
  function clone(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }

  // ── Extract the map definition from the runtime game state ────────────────
  // The game stores its internal state as a plain object with physics, discs,
  // capZones, mm, etc. We faithfully extract it into a clean JSON structure
  // that preserves the original bonk.io hierarchy: body → fixtures → shapes.
  function extractMap(state, { capZoneTimeInTicks = false } = {}) {
    unknownFields = {};

    const ph = state.physics || {};
    // Tick state stores metadata under `mm`; the decoded map definition uses
    // `m`. Supporting both here keeps direct primary-path exports lossless.
    const mm = state.mm || state.m || {};
    // Decoded map definitions use `s`; per-tick live state carries match
    // settings as `ms`. Prefer the source-native map settings if both exist.
    const settings = state.s || state.ms || {};
    const bodies = ph.bodies || [];
    const fixtures = ph.fixtures || [];
    const shapes = ph.shapes || [];
    const joints = ph.joints || [];
    const bro = ph.bro || [];
    const discs = state.discs || [];
    const capZones = state.capZones || [];

    // Collision filter (f_c/f_p/f_1..f_4) lives on the BODY's surface, not on
    // fixtures (world-build 7577-7628). Build a fixture->owningBodySurface map
    // so fixture export can source collision fields correctly.
    const fixtureOwnerSurface = {};
    for (let b = 0; b < bodies.length; b++) {
      const body = bodies[b];
      if (!body) continue;
      const surf = body.s || {};
      for (const fxIdx of (body.fx || [])) {
        if (typeof fxIdx === 'number') fixtureOwnerSurface[fxIdx] = surf;
      }
    }

    checkUnknown('root', state, KNOWN.root);
    checkUnknown('physics', ph, KNOWN.physics);
    checkUnknown('settings', settings, KNOWN.settings);
    checkUnknown('mm', mm, KNOWN.mm);

    // ── Build the faithful map definition ────────────────────────────────────
    const mapDef = {
      // Metadata
      metadata: {
        name: mm.n ?? null,
        author: mm.a ?? null,
        dbid: mm.dbid ?? null,
        dbv: mm.dbv ?? null,
        authid: mm.authid ?? null,
        date: mm.date ?? null,
        rxid: mm.rxid ?? null,
        rxn: mm.rxn ?? null,
        rxa: mm.rxa ?? null,
        rxdb: mm.rxdb ?? null,
        contributors: mm.cr ? clone(mm.cr) : [],
        published: mm.pub ?? null,
        mode: mm.mo ?? null,
        // Map format version `v` is a top-level key (blank-map template), not
        // on `mm`. On the map path `state` is `gs.map`, so state.v resolves.
        version: state.v ?? null,
      },

      // Map-level settings
      settings: {
        re: settings.re ?? false,
        nc: settings.nc ?? false,
        pq: settings.pq ?? null,
        gd: settings.gd ?? null,
        fl: settings.fl ?? false,
      },

      // Global physics
      physics: {
        ppm: ph.ppm ?? null,
        gravity: ph.grav ? { x: ph.grav[0], y: ph.grav[1] } : null,
        boundsWidth: ph.bw ?? null,
        boundsHeight: ph.bh ?? null,
        background: ph.bg ?? null,
        backgroundColor: ph.bc ?? null,
        backgroundCustom: ph.bdc ?? null,
        customResolution: ph.customres ?? null,
        ss: ph.ss ?? null,
      },

      // Spawns (from discs — these are the player spawn positions in the game state)
      spawns: [],

      // Cap zones
      capZones: [],

      // Body render order
      bodyRenderOrder: clone(bro),

      // Full 3-level hierarchy preserved
      physicsBodies: [],
      physicsFixtures: [],
      physicsShapes: [],
      physicsJoints: [],

      // Also export a flattened view for convenience
      bodies: [],

      exportedAt: new Date().toISOString(),
    };

    // ── Extract spawns from discs ────────────────────────────────────────────
    discs.forEach((d, i) => {
      if (!d) return;
      checkUnknown(`disc[${i}]`, d, KNOWN.disc);

      // Team mapping: 0=spec, 1=FFA, 2=red, 3=blue, 4=green, 5=yellow
      const teamNames = ['spectator', 'ffa', 'red', 'blue', 'green', 'yellow'];

      mapDef.spawns.push({
        index: i,
        team: d.team ?? null,
        teamName: teamNames[d.team] ?? `team_${d.team}`,
        x: d.sx ?? d.x ?? null,
        y: d.sy ?? d.y ?? null,
        velocity: {
          x: d.sxv ?? d.xv ?? null,
          y: d.syv ?? d.yv ?? null,
        },
        angle: d.a ?? null,
        angularVelocity: d.av ?? null,
        // Disc runtime fields (serializer set: x,y,sx,sy,xv,yv,a,av,team,
        // a1a,a1,a2,ni,sxv,syv,ds,da,lhid,lht,vt,swing,spawnTeamInfo)
        a1a: d.a1a ?? null,
        a1: d.a1 ?? null,
        lhid: d.lhid ?? null,
        lht: d.lht ?? null,
        ds: d.ds ?? null,
        da: d.da ?? null,
        vt: d.vt ?? null,
        a2: d.a2 ?? null,
        ni: d.ni ?? null,
        swing: d.swing ?? null,
        spawnTeamInfo: d.spawnTeamInfo ?? null,
      });
    });

    // ── Extract cap zones ────────────────────────────────────────────────────
    capZones.forEach((cz, i) => {
      if (!cz) return;
      checkUnknown(`capZone[${i}]`, cz, KNOWN.capzone);

      // ty: 1=normal, 2-5=instant win for red/blue/green/yellow
      const capTypeNames = {
        1: 'normal',
        2: 'instant_red',
        3: 'instant_blue',
        4: 'instant_green',
        5: 'instant_yellow',
      };

      const fx = cz.i >= 0 ? fixtures[cz.i] : null;

      mapDef.capZones.push({
        index: i,
        name: fx?.n ?? `capzone_${i}`,
        type: cz.ty ?? null,
        typeName: capTypeNames[cz.ty] ?? `type_${cz.ty}`,
        captureTime: cz.l != null ? (capZoneTimeInTicks ? cz.l / 30 : cz.l) : null,
        fixtureIndex: cz.i ?? -1,
        fixtureName: fx?.n ?? null,
        // Runtime state fields
        owner: cz.o ?? null,
        originalTeam: cz.ot ?? null,
        progress: cz.p ?? null,
        f: cz.f ?? null,
      });
    });

    // ── Extract shapes (level 3 of hierarchy) ────────────────────────────────
    shapes.forEach((sh, i) => {
      if (!sh) {
        mapDef.physicsShapes.push(null);
        return;
      }
      checkUnknown(`shape[${i}]`, sh, KNOWN.shape);

      const shapeDef = {
        index: i,
        type: sh.type, // "bx", "ci", "po"
        typeName: sh.type === 'bx' ? 'rect' : sh.type === 'ci' ? 'circle' : 'polygon',
        center: Array.isArray(sh.c) ? { x: sh.c[0], y: sh.c[1] } : null,
        angle: sh.a ?? 0,
        shrink: sh.sk ?? false,
      };

      if (sh.type === 'bx') {
        shapeDef.width = sh.w ?? null;
        shapeDef.height = sh.h ?? null;
      } else if (sh.type === 'ci') {
        shapeDef.radius = sh.r ?? null;
      } else if (sh.type === 'po') {
        shapeDef.scale = sh.s ?? null;
        shapeDef.vertices = sh.v
          ? sh.v.map(v => ({ x: v[0], y: v[1] }))
          : [];
      }

      mapDef.physicsShapes.push(shapeDef);
    });

    // ── Extract fixtures (level 2 of hierarchy) ─────────────────────────────
    fixtures.forEach((fx, i) => {
      if (!fx) {
        mapDef.physicsFixtures.push(null);
        return;
      }
      checkUnknown(`fixture[${i}]`, fx, KNOWN.fixture);

      mapDef.physicsFixtures.push({
        index: i,
        name: fx.n ?? null,
        shapeIndex: fx.sh ?? null,
        // Physics properties (null = inherit from body)
        friction: fx.fr ?? null,
        restitution: fx.re ?? null,
        density: fx.de ?? null,
        // Behavior flags
        death: fx.d ?? false,
        noPhysics: fx.np ?? false,
        noGrapple: fx.ng ?? false,
        innerGrapple: fx.ig ?? false,
        fricPlayers: fx.fp ?? null,
        // Collision filter is body-level (sourced from the owning body.s).
        // `frc` (frictionCategory) is absent from the runtime constant table.
        collisionGroup: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_c) ?? null,
        frictionCategory: null,
        collidesGroup1: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_1) ?? null,
        collidesGroup2: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_2) ?? null,
        collidesGroup3: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_3) ?? null,
        collidesGroup4: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_4) ?? null,
        collidesPlayers: (fixtureOwnerSurface[i] && fixtureOwnerSurface[i].f_p) ?? null,
        // Visual
        color: fx.f ?? null,
      });
    });

    // ── Extract bodies (level 1 of hierarchy) ────────────────────────────────
    bodies.forEach((body, bodyIdx) => {
      if (!body) {
        mapDef.physicsBodies.push(null);
        return;
      }
      checkUnknown(`body[${bodyIdx}]`, body, KNOWN.body);

      const surf = body.s || {};
      checkUnknown(`body[${bodyIdx}].s (surface)`, surf, KNOWN.surface);

      const bodyDef = {
        index: bodyIdx,
        name: surf.n ?? null,
        type: surf.type ?? body.type ?? null,
        // type: "s" (stationary), "d" (dynamic), "k" (kinematic)
        typeName:
          (surf.type ?? body.type) === 's' ? 'static'
          : (surf.type ?? body.type) === 'd' ? 'dynamic'
          : (surf.type ?? body.type) === 'k' ? 'kinematic'
          : 'unknown',

        // Position and angle
        position: Array.isArray(body.p) ? { x: body.p[0], y: body.p[1] } : null,
        angle: body.a ?? 0,

        // Initial velocity
        linearVelocity: body.lv ? { x: body.lv[0], y: body.lv[1] } : null,
        angularVelocity: body.av ?? 0,

        // Surface physics properties (body-level defaults)
        friction: surf.fric ?? null,
        restitution: surf.re ?? null,
        density: surf.de ?? null,
        linearDamping: surf.ld ?? null,
        angularDamping: surf.ad ?? null,

        // Collision
        collisionGroup: surf.f_c ?? null,
        frictionCategory: surf.frc ?? null,
        collidesGroup1: surf.f_1 ?? null,
        collidesGroup2: surf.f_2 ?? null,
        collidesGroup3: surf.f_3 ?? null,
        collidesGroup4: surf.f_4 ?? null,
        collidesPlayers: surf.f_p ?? null,

        // Flags
        fixedRotation: surf.fr ?? false,
        fricPlayers: surf.fricp ?? false,
        antiTunnel: surf.bu ?? false,

        // Constant force
        constantForce: body.cf ? {
          x: body.cf.x ?? 0,
          y: body.cf.y ?? 0,
          torque: body.cf.ct ?? 0,
          absolute: body.cf.w ?? true,
        } : null,

        // Force zone
        forceZone: body.fz ? clone(body.fz) : null,

        // Fixture indices (references into physicsFixtures)
        fixtureIndices: body.fx ? clone(body.fx) : [],

        // Resolved fixtures (full objects for convenience)
        fixtures: (body.fx || []).map(fxIdx => {
          const fx = fixtures[fxIdx];
          if (!fx) return null;
          const sh = fx.sh != null ? shapes[fx.sh] : null;
          const fixtureSurface = fixtureOwnerSurface[fxIdx] || surf;

          const resolved = {
            fixtureIndex: fxIdx,
            name: fx.n ?? null,
            shapeIndex: fx.sh ?? null,
            death: fx.d ?? false,
            noPhysics: fx.np ?? false,
            noGrapple: fx.ng ?? false,
            innerGrapple: fx.ig ?? false,
            friction: fx.fr ?? surf.fric ?? null,
            restitution: fx.re ?? surf.re ?? null,
            density: fx.de ?? surf.de ?? null,
            fricPlayers: fx.fp ?? fixtureSurface.fricp ?? null,
            collisionGroup: fixtureSurface.f_c ?? null,
            collidesGroup1: fixtureSurface.f_1 ?? null,
            collidesGroup2: fixtureSurface.f_2 ?? null,
            collidesGroup3: fixtureSurface.f_3 ?? null,
            collidesGroup4: fixtureSurface.f_4 ?? null,
            collidesPlayers: fixtureSurface.f_p ?? null,
            color: fx.f ?? null,
          };

          if (sh) {
            resolved.shape = {
              type: sh.type,
              typeName: sh.type === 'bx' ? 'rect' : sh.type === 'ci' ? 'circle' : 'polygon',
              center: Array.isArray(sh.c) ? { x: sh.c[0], y: sh.c[1] } : null,
              angle: sh.a ?? 0,
              shrink: sh.sk ?? false,
            };
            if (sh.type === 'bx') {
              resolved.shape.width = sh.w ?? null;
              resolved.shape.height = sh.h ?? null;
            } else if (sh.type === 'ci') {
              resolved.shape.radius = sh.r ?? null;
            } else if (sh.type === 'po') {
              resolved.shape.scale = sh.s ?? null;
              resolved.shape.vertices = sh.v
                ? sh.v.map(v => ({ x: v[0], y: v[1] }))
                : [];
            }
          }

          return resolved;
        }).filter(f => f !== null),
      };

      mapDef.physicsBodies.push(bodyDef);

      // ── Flattened body view for backward compatibility ──────────────────────
      // Each fixture→shape combo becomes one entry in bodies[], matching the
      // old export format but with correct field names and no METRES_TO_PX.
      (body.fx || []).forEach(fxIdx => {
        const fx = fixtures[fxIdx];
        if (!fx) return;
        const sh = fx.sh != null ? shapes[fx.sh] : null;

        const bx = Array.isArray(body.p) ? body.p[0] : 0;
        const by = Array.isArray(body.p) ? body.p[1] : 0;
        const cx = Array.isArray(sh?.c) ? (sh.c[0] || 0) : 0;
        const cy = Array.isArray(sh?.c) ? (sh.c[1] || 0) : 0;

        const flat = {
          bodyIndex: bodyIdx,
          fixtureIndex: fxIdx,
          shapeIndex: fx.sh ?? null,
          name: fx.n || surf.n || `body_${bodyIdx}`,
          type: !sh ? null : sh.type === 'bx' ? 'rect' : sh.type === 'ci' ? 'circle' : 'polygon',
          bodyType: bodyDef.typeName,
          x: bx + cx,
          y: by + cy,
          angle: (body.a || 0) + (sh?.a || 0),
          linearVelocity: body.lv ? { x: body.lv[0], y: body.lv[1] } : { x: 0, y: 0 },
          angularVelocity: body.av || 0,
          static: surf.type === 's',
          isLethal: fx.d === true,
          noPhysics: !!fx.np,
          noGrapple: !!fx.ng,
          innerGrapple: !!fx.ig,
          friction: fx.fr ?? surf.fric ?? null,
          restitution: fx.re ?? surf.re ?? null,
          density: fx.de ?? surf.de ?? null,
          fricPlayers: fx.fp ?? surf.fricp ?? null,
          collisionGroup: surf.f_c ?? null,
          collidesGroup1: surf.f_1 ?? null,
          collidesGroup2: surf.f_2 ?? null,
          collidesGroup3: surf.f_3 ?? null,
          collidesGroup4: surf.f_4 ?? null,
          collidesPlayers: surf.f_p ?? null,
          color: fx.f ?? null,
          ppm: ph.ppm ?? null,
        };

        if (sh?.type === 'bx') {
          flat.width = sh.w ?? null;
          flat.height = sh.h ?? null;
        } else if (sh?.type === 'ci') {
          flat.radius = sh.r ?? null;
        } else if (sh?.type === 'po') {
          flat.scale = sh.s ?? null;
          flat.vertices = (sh.v || []).map(v => ({
            x: bx + cx + v[0],
            y: by + cy + v[1],
          }));
        }

        mapDef.bodies.push(flat);
      });
    });

    // ── Extract joints ───────────────────────────────────────────────────────
    joints.forEach((jt, i) => {
      if (!jt) {
        mapDef.physicsJoints.push(null);
        return;
      }
      checkUnknown(`joint[${i}]`, jt, KNOWN.joint);

      const jointDef = {
        index: i,
        type: jt.type ?? null,
        bodyA: jt.ba ?? null,
        bodyB: jt.bb ?? null,
        data: jt.d ? clone(jt.d) : null,
        // Chain joints keep their length on the joint itself rather than in d.
        length: jt.l ?? null,
      };

      // Type-specific fields
      if (jt.type === 'rv') {
        // Revolute joint
        if (jt.d) {
          checkUnknown(`joint[${i}].d (revolute)`, jt.d, KNOWN.jointData);
          jointDef.lowerAngle = jt.d.la ?? null;
          jointDef.upperAngle = jt.d.ua ?? null;
          jointDef.maxMotorTorque = jt.d.mmt ?? null;
          jointDef.motorSpeed = jt.d.ms ?? null;
          jointDef.enableLimit = jt.d.el ?? null;
          jointDef.enableMotor = jt.d.em ?? null;
          jointDef.collideConnected = jt.d.cc ?? null;
          jointDef.breakForce = jt.d.bf ?? null;
          jointDef.deleteOnBreak = jt.d.dl ?? null;
        }
        jointDef.anchorA = jt.aa ? { x: jt.aa[0], y: jt.aa[1] } : null;
      } else if (jt.type === 'd') {
        // Distance joint
        if (jt.d) {
          checkUnknown(`joint[${i}].d (distance)`, jt.d, KNOWN.jointData);
          jointDef.frequencyHz = jt.d.fh ?? null;
          jointDef.dampingRatio = jt.d.dr ?? null;
          jointDef.collideConnected = jt.d.cc ?? null;
          jointDef.breakForce = jt.d.bf ?? null;
          jointDef.deleteOnBreak = jt.d.dl ?? null;
        }
        jointDef.anchorA = jt.aa ? { x: jt.aa[0], y: jt.aa[1] } : null;
        jointDef.anchorB = jt.ab ? { x: jt.ab[0], y: jt.ab[1] } : null;
      } else if (jt.type === 'lpj') {
        // LPJ (line/prismatic) joint
        if (jt.d) {
          checkUnknown(`joint[${i}].d (lpj)`, jt.d, KNOWN.jointData);
          jointDef.collideConnected = jt.d.cc ?? null;
          jointDef.breakForce = jt.d.bf ?? null;
          jointDef.deleteOnBreak = jt.d.dl ?? null;
        }
        jointDef.anchorA = { x: jt.pax ?? 0, y: jt.pay ?? 0 };
        jointDef.angle = jt.pa ?? null; // axis derivation tracked by issue #280
        // Issue #281: the native piston is a DRIVEN joint with a limit. The
        // travel (±plen) is the translation limit, pf is maxMotorForce and pms
        // is motorSpeed, with the limit and motor enabled (DEOBFUSCATION §33.8).
        const plen = jt.plen ?? 0;
        jointDef.lowerTranslation = -plen;
        jointDef.upperTranslation = +plen;
        jointDef.maxMotorForce = jt.pf ?? null;
        jointDef.motorSpeed = jt.pms ?? null;
        jointDef.enableLimit = true;
        jointDef.enableMotor = true;
      } else if (jt.type === 'lsj') {
        // LSJ (springy prismatic) joint — the native game builds it as a
        // prismatic joint with a vertical axis and an enabled motor, NOT a
        // distance-style spring (DEOBFUSCATION §33.8 lsj, lines 3468–3487).
        if (jt.d) {
          checkUnknown(`joint[${i}].d (lsj)`, jt.d, KNOWN.jointData);
          jointDef.collideConnected = jt.d.cc ?? null;
          jointDef.breakForce = jt.d.bf ?? null;
          jointDef.deleteOnBreak = jt.d.dl ?? null;
        }
        jointDef.anchorA = { x: jt.sax ?? 0, y: jt.say ?? 0 };
        // Issue #281: the native spring is a driven joint with the travel
        // (±slen) as the translation limit, sf as the motor-force scale and a
        // fixed vertical axis / motor speed of 300.
        const slen = jt.slen ?? 0;
        jointDef.axis = { x: 0, y: 1 };
        jointDef.lowerTranslation = -slen;
        jointDef.upperTranslation = +slen;
        jointDef.enableLimit = false;
        jointDef.enableMotor = true;
        jointDef.motorSpeed = 300;
        jointDef.maxMotorForce = jt.sf ?? null;
        jointDef.length = jt.slen ?? null;
      }

      mapDef.physicsJoints.push(jointDef);
    });

    return mapDef;
  }

  // ── Code injector: hook into the game's step function to capture state ─────
  // Uses the same proven regex patterns as bonkhost.js to find and patch the
  // state creation point in alpha2s.js. The step function receives the game state
  // as arguments[0] and game settings as arguments[4].
  function createInjector(alpha2sCode) {
    let code = alpha2sCode;
    let hooks = 0;

    // ── Hook 1: Capture game state and game settings each tick ───────────────
    // Pattern: z[z0M[2][131]]={discs:... (same regex as bonkhost.js)
    // arguments[0] = game state (physics, discs, capZones, mm, etc.)
    // arguments[4] = game settings (contains .map with full map definition)
    const stateRegexMatch = code.match(
      /[A-Za-z]\[[A-Za-z0-9$_]{3}(\[[0-9]{1,3}\]){2}\]={discs/
    );

    if (stateRegexMatch) {
      const stateRegex = stateRegexMatch[0];
      const captureCode = [
        '{',
        'try{',
        'if(arguments[0]&&arguments[0].physics&&arguments[0].physics.bodies){',
        'window.__bonkExportState=arguments[0];',
        '}',
        'if(arguments[4]){',
        'window.__bonkExportGameSettings=arguments[4];',
        '}',
        '}catch(e){}',
        '}',
      ].join('');

      code = code.replace(stateRegex, captureCode + stateRegex);
      hooks++;
      console.log('%c[BonkExport] State capture hook injected', 'color:#4caf50;font-weight:bold');
    } else {
      console.warn('[BonkExport] Could not find state creation pattern — game may have been updated');
    }

    // ── Hook 2: Extract physics constants from the source ────────────────────
    // We parse the obfuscated source to find hardcoded physics constants:
    // - Gravity: world.SetGravity(new b2Vec2(0, GRAVITY_Y))
    // - Solver iterations: z0M[291]=VEL_ITER; z0M[554]=POS_ITER;
    // - High-quality iterations: z0M[291]=15; z0M[554]=15;
    // - Default ppm: 12, default gravity: 20
    const physicsConstants = {};

    // Current builds retain this b2Vec2 construction even when the SetGravity
    // branch is optimized out or rewritten by the obfuscator.
    const gravMatch = code.match(/new\s+[A-Za-z0-9$_]{1,5}\[1\]\(0,\s*(\d+(?:\.\d+)?)\)/);
    if (gravMatch) {
      physicsConstants.gravity = parseFloat(gravMatch[1]);
    }

    // Extract solver iterations from the variable assignments
    // Pattern: VAR[291]=NUMBER;VAR[554]=NUMBER;
    // But the variable names change per obfuscation. Use the pattern near Step call.
    // We found: z0M[291]=2;z0M[554]=6; (low quality) and z0M[291]=15;z0M[554]=15; (high quality)
    // The pattern is: =NUMBER;VAR[NUMBER]=NUMBER;
    // The current secondary Step call uses literal low-quality iterations.
    const stepLiteralMatch = code.match(/\[327\]\]\([^;]*?,\s*(\d+)\s*,\s*(\d+)\)/);
    if (stepLiteralMatch) {
      physicsConstants.velocityIterations = parseInt(stepLiteralMatch[1]);
      physicsConstants.positionIterations = parseInt(stepLiteralMatch[2]);
    }

    // Extract default ppm and gravity from the constructor defaults
    // Pattern: this[...[620]]=NUMBER;this[...[46]]=NUMBER;
    const defaultsMatch = code.match(/\[620\]\]=(\d+(?:\.\d+)?);[^;]*\[46\]\]=(\d+(?:\.\d+)?)/);
    if (defaultsMatch) {
      physicsConstants.defaultGravity = parseFloat(defaultsMatch[1]);
      physicsConstants.defaultPpm = parseFloat(defaultsMatch[2]);
    }

    // Extract high-quality iterations (pq==2). The numeric table indices are
    // stable anchors in the current build but are re-exported at runtime below.
    const highQualMatch = code.match(/\[326\]\]\s*==\s*2\)\{[^}]*?=(\d+);[^}]*?=(\d+);/);
    if (highQualMatch) {
      physicsConstants.highQualityVelocityIterations = parseInt(highQualMatch[1]);
      physicsConstants.highQualityPositionIterations = parseInt(highQualMatch[2]);
    }

    if (Object.keys(physicsConstants).length > 0) {
      window.__bonkExportPhysicsConstants = physicsConstants;
      console.log('%c[BonkExport] Physics constants extracted from source:',
        'color:#4caf50;font-weight:bold');
      console.log(JSON.stringify(physicsConstants, null, 2));
      hooks++;
    }

    // ── Hook 3: Capture the b2World instance for runtime physics queries ──────
    // We inject code right after world assignment to store a reference
    // Pattern: z0M[16]=z[z0M[2][2]]; → world = state.world
    // We add: window.__bonkExportWorld = z0M[16];
    const worldAssignMatch = code.match(/[A-Za-z0-9$_]{1,5}\[16\]=[A-Za-z0-9$_]{1,5}\[[A-Za-z0-9$_]{1,5}\[2\]\[2\]\];/);
    if (worldAssignMatch) {
      const worldAssign = worldAssignMatch[0];
      const worldCapture = worldAssign + 'window.__bonkExportWorld=' + worldAssign.match(/^[A-Za-z0-9$_\[\]]+/)[0] + ';';
      code = code.replace(worldAssign, worldCapture);
      hooks++;
      console.log('%c[BonkExport] World capture hook injected', 'color:#4caf50;font-weight:bold');
    }

    console.log(`%c[BonkExport] Total hooks injected: ${hooks}`, 'color:#4caf50;font-weight:bold');
    return code;
  }

  // ── Register the code injector ─────────────────────────────────────────────
  if (!window.bonkCodeInjectors) window.bonkCodeInjectors = [];
  window.bonkCodeInjectors.push(function (bonkCode) {
    try {
      const patched = createInjector(bonkCode);
      console.log('%c[BonkExport] Code injector registered',
        'color:#4caf50;font-weight:bold');
      return patched;
    } catch (error) {
      console.error('[BonkExport] Injector failed:', error);
      return bonkCode; // Return unmodified on failure
    }
  });

  // ── Export button UI ───────────────────────────────────────────────────────
  function injectButton() {
    const existing = document.getElementById('bonk-export-btn');
    if (existing) return existing;

    const btn = document.createElement('button');
    btn.id = 'bonk-export-btn';
    btn.textContent = '⬇ No map loaded';

    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '999999',
      padding: '10px 18px',
      background: '#1a1a2e',
      color: '#4caf50',
      border: '2px solid #4caf50',
      borderRadius: '8px',
      fontFamily: 'monospace',
      fontSize: '13px',
      fontWeight: 'bold',
      cursor: 'pointer',
      boxShadow: '0 4px 15px rgba(76,175,80,0.3)',
      transition: 'all 0.15s ease',
      userSelect: 'none',
    });

    btn.onmouseenter = () => Object.assign(btn.style, {
      background: '#4caf50', color: '#1a1a2e',
      boxShadow: '0 4px 20px rgba(76,175,80,0.6)',
    });
    btn.onmouseleave = () => Object.assign(btn.style, {
      background: '#1a1a2e', color: '#4caf50',
      boxShadow: '0 4px 15px rgba(76,175,80,0.3)',
    });

    btn.onclick = () => {
      // Try game settings first (has full map def with spawns), then per-tick state
      const gs = window.__bonkExportGameSettings;
      const tickState = window.__bonkExportState;

      let mapSource = null;
      let capZoneTimeInTicks = false;
      if (gs && gs.map && gs.map.physics && gs.map.physics.bodies) {
        // Game settings contains the full decoded map definition
        mapSource = gs.map;
      } else if (tickState && tickState.physics && tickState.physics.bodies) {
        // Per-tick state has physics + discs + capZones but not spawns
        mapSource = tickState;
        capZoneTimeInTicks = true;
      }

      if (!mapSource) {
        alert('No map loaded yet — join a game first');
        return;
      }

      const mapDef = extractMap(mapSource, { capZoneTimeInTicks });

      const runtimeConstantTable = captureRuntimeConstantTable();
      if (runtimeConstantTable) {
        mapDef.runtimeConstantTable = runtimeConstantTable;
      }

      // Add extracted physics constants (from source deobfuscation)
      const physConstants = window.__bonkExportPhysicsConstants;
      if (physConstants) {
        mapDef.extractedPhysicsConstants = physConstants;

        // If we also have the live world, try to read runtime gravity
        const world = window.__bonkExportWorld;
        if (world) {
          try {
            // Box2DFlash stores gravity as m_gravity (b2Vec2)
            const grav = world.m_gravity || world.GetGravity?.();
            if (grav) {
              mapDef.extractedPhysicsConstants.runtimeGravity = { x: grav.x, y: grav.y };
            }
          } catch (e) {}
        }
      }

      // If we have game settings, merge in the full map metadata
      if (gs && gs.map) {
        const mapMeta = gs.map.m || {};
        if (mapMeta.n) mapDef.metadata.name = mapMeta.n;
        if (mapMeta.a) mapDef.metadata.author = mapMeta.a;
        if (mapMeta.dbid != null) mapDef.metadata.dbid = mapMeta.dbid;
        if (mapMeta.dbv != null) mapDef.metadata.dbv = mapMeta.dbv;
        if (mapMeta.authid != null) mapDef.metadata.authid = mapMeta.authid;
        if (mapMeta.date) mapDef.metadata.date = mapMeta.date;
        if (mapMeta.mo) mapDef.metadata.mode = mapMeta.mo;
        if (mapMeta.pub != null) mapDef.metadata.published = mapMeta.pub;
        if (mapMeta.cr) mapDef.metadata.contributors = mapMeta.cr;
        if (mapMeta.rxid != null) mapDef.metadata.rxid = mapMeta.rxid;
        if (mapMeta.rxn != null) mapDef.metadata.rxn = mapMeta.rxn;
        if (mapMeta.rxa != null) mapDef.metadata.rxa = mapMeta.rxa;
        if (mapMeta.rxdb != null) mapDef.metadata.rxdb = mapMeta.rxdb;

        // Merge map-level settings
        const mapSettings = gs.map.s || {};
        if (mapSettings.re != null) mapDef.settings.re = mapSettings.re;
        if (mapSettings.nc != null) mapDef.settings.nc = mapSettings.nc;
        if (mapSettings.pq != null) mapDef.settings.pq = mapSettings.pq;
        if (mapSettings.gd != null) mapDef.settings.gd = mapSettings.gd;
        if (mapSettings.fl != null) mapDef.settings.fl = mapSettings.fl;

        // Extract spawns from the map definition (not the per-tick state)
        if (gs.map.spawns) {
          mapDef.spawns = gs.map.spawns.map((s, i) => ({
            index: i,
            name: s.n ?? null,
            x: s.x ?? null,
            y: s.y ?? null,
            xVelocity: s.xv ?? null,
            yVelocity: s.yv ?? null,
            priority: s.priority ?? null,
            ffa: s.f ?? null,
            red: s.r ?? null,
            blue: s.b ?? null,
            green: s.gr ?? null,
            yellow: s.ye ?? null,
          }));
        }

        // Extract cap zones from the map definition
        if (gs.map.capZones) {
          mapDef.capZones = gs.map.capZones.map((cz, i) => {
            const capTypeNames = {
              1: 'normal', 2: 'instant_red', 3: 'instant_blue',
              4: 'instant_green', 5: 'instant_yellow',
            };
            return {
              index: i,
              name: cz.n ?? `capzone_${i}`,
              type: cz.ty ?? null,
              typeName: capTypeNames[cz.ty] ?? `type_${cz.ty}`,
              captureTime: cz.l ?? null,
              fixtureIndex: cz.i ?? -1,
            };
          });
        }
      }

      const json = JSON.stringify(mapDef, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bonk_${(mapDef.metadata.name || 'map').replace(/[^a-z0-9_-]/gi, '_')}_${mapDef.metadata.dbid || Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // A detached link or immediate revocation can cancel downloads in some
      // browsers. Let the browser start the transfer before releasing the URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      btn.textContent = '✅ Downloaded!';
      Object.assign(btn.style, { background: '#4caf50', color: '#1a1a2e' });
      setTimeout(() => {
        btn.textContent = `⬇ ${mapDef.metadata.name || '?'}`;
        Object.assign(btn.style, { background: '#1a1a2e', color: '#4caf50' });
      }, 2000);
    };

    document.body.appendChild(btn);
    return btn;
  }

  // ── Poll for map changes and update button ─────────────────────────────────
  function startPolling(btn) {
    let lastMapId = null;

    setInterval(() => {
      // Prefer the full map definition, but also surface tick-only fallback
      // captures so the button reflects every exportable source.
      const gs = window.__bonkExportGameSettings;
      const tickState = window.__bonkExportState;
      const mapMeta = gs?.map?.m || tickState?.mm || null;
      const hasMapSource = !!(
        (gs?.map?.physics?.bodies) || (tickState?.physics?.bodies)
      );
      const mapId = mapMeta?.dbid ?? mapMeta?.n ?? (hasMapSource ? 'live-map' : null);

      if (mapId && mapId !== lastMapId) {
        lastMapId = mapId;
        const name = mapMeta?.n || (hasMapSource ? 'Live map' : '?');
        btn.textContent = `⬇ ${name}`;
        console.log(`%c[BonkExport] Map: "${name}" (dbid=${mapMeta?.dbid ?? '?'})`,
          'color:#4caf50;font-weight:bold');
        Object.assign(btn.style, { borderColor: '#ff9800', color: '#ff9800' });
        setTimeout(() => Object.assign(btn.style, {
          borderColor: '#4caf50', color: '#4caf50',
        }), 1000);
      }
    }, 1500);
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function init() {
    const btn = injectButton();
    startPolling(btn);
    console.log('%c[BonkExport] v2.4.0 active — requires Code Injector userscript',
      'color:#4caf50;font-weight:bold');
    console.log('%c[BonkExport] Install: https://greasyfork.org/en/scripts/433861',
      'color:#888;font-size:11px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
