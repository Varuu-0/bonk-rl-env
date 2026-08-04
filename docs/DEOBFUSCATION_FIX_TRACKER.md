# Deobfuscation Fix Tracker

Tracks every discrepancy between verified bonk.io deobfuscation findings
(`docs/DEOBFUSCATION.md`) and the local simulator, and the status of each fix.

**Last updated:** 2026-08-03
**Audit source:** `docs/DEOBFUSCATION.md` (38 sections; current artifact and
audit baseline verified August 3, 2026)

---

## Legend

| Status | Meaning |
|--------|---------|
| ❌ Not fixed | Discrepancy confirmed, no code change yet |
| 🔧 In progress | Partially addressed or fix in flight |
| ✅ Fixed | Code/config/test updated and verified |
| ⚠️ Blocked | Cannot fix without external dependency (map capture, Box2D port) |
| 🚫 Won't fix | Out of scope or requires architecture redesign |

---

## CRITICAL — Wrong simulation values

### C1. `config.example.json` stale physics/player/grapple values — ⚠️ NEEDS RE-AUDIT

| Key | Verified bonk.io | Status |
|-----|------------------|--------|
| `physics.gravityY` | `20` | ✅ Updated; pinned by `tests/unit/config-example-sanity.test.ts` |
| `physics.solverIterations` / `positionIterations` | `2` vel / `6` pos | ✅ Both fields present |
| `player.radius` | `ppm`-derived (default 12) | ✅ Documented as derived; value kept only for backward compat |
| `player.moveForce` | `12` | ✅ Updated |
| `player.heavyMassMultiplier` | See §35.4: density/mass and scale-derived force effects | ⚠️ Prior force-only/no-mass status superseded; re-audit port behavior |
| `player.friction` | `0.001337` live disc fixture | ⚠️ Prior `0` status superseded; re-audit port behavior |
| `player.restitution` | `0.95` live disc fixture | ⚠️ Prior `0.8` status superseded; re-audit port behavior |
| `grapple.maxDistance` | Not a scalar 500-unit reach; target QueryAABB/surface window is 10, and 500 is `a1a` energy | ⚠️ Prior `500` status superseded; rework targeting model |

---

### C2. `config-loader.ts` DEFAULTS partially stale — ⚠️ NEEDS RE-AUDIT

The gravity/iteration defaults remain source-verified. The former friction,
restitution, heavy, and grapple entries above are superseded by the 2026-08-02
artifact correction matrix in `DEOBFUSCATION.md` §38.6 and must not be treated
as native defaults. `positionIterations` remains wired in `PhysicsConfig`;
`player.radius` and `heavyMassMultiplier` remain backward-compatibility knobs.

---

### C3. `physics-engine.ts` remaining hardcoded errors

| Issue | Verified behavior | Status |
|-------|-------------------|--------|
| Invented `grappleMultiplier === 99999` slingshot | No native evidence | ✅ Removed (code + tests) |
| Grapple `frequencyHz=4.0` / `dampingRatio=0.5` hardcoded | `swingF`/`swingD`, with 0.01 taut/slack branch; `fh`/`dr` belong to map `d` joints | ⛔ Superseded prior fixture wiring; port must rework grapple joint behavior |
| Grapple range `500 / SCALE` (SCALE=30) | No native 500-unit reach; target acquisition is QueryAABB/surface-distance within 10 units and `500` is `a1a` energy | ⛔ Superseded prior model; port must implement native targeting/energy behavior |
| Grapple anchor = body center | Surface point via local `swing.p` + `rotatePoint` | ⚠️ Source math resolved in C5; verify port stores a body-local anchor |
| Body restitution default `0.4` | Native default `0.8` | ✅ Fixed |
| No `ClearForces` after Step | Called after every Step natively | ⚠️ Blocked (Box2D port lacks method) |
| `Step()` third arg ignored by port | Native uses `Step(dt, 2, 6)` | ⚠️ Blocked (port limitation) |

---

### C4. Contact listener — fixed where verification exists

| Native behavior | Status |
|-----------------|--------|
| Lethal surface → death type 1 | ✅ `playerDeathType` tracks 1/3/4 |
| Death type 3 (cap-zone elimination, permanent) | ✅ Instant + timed zones eliminate with death type 3 |
| Death type 4 (OOB) | ✅ Circular check; death circle is exactly **850 map units** (`850 / SCALE` in this port — the native `850 / ppm` formula is in px/ppm world units, so ppm cancels; verified and corrected 2026-07-29 after code review) |
| Timed cap-zone capture (`ty===1`) | ✅ Full `p`, `l*30`, `f=20` lifecycle (DEOBFUSCATION §30) |
| Instant cap zones (`ty 2-5`) | ✅ Native mapping 2→red, 3→blue, 4→green, 5→yellow; dynamic-body trigger only |
| Cap-zone progress `p`, limit `l*30`, countdown `f=20` | ✅ Implemented |
| Same-team collision disabled (`tea && same team`) | ✅ Implemented via team-slot category bits (g1–g4 = red/blue/green/yellow) with own-team bit masked out; port ignores `SetContactFilter` so mask data is the enforcement path (verified empty-call repro) |
| No-collide mode (`nc`) | ✅ All disc-disc contacts disabled via mask; `noCollide` env config wired |
| Force zones (`fz`) in contact | **RESOLVED (§31.1):** source behavior is documented; port implementation status remains separate |
| Grapple destroy on disc collision (`swingCollideDestroyEvents`) | ✅ Pending-destroy set processed after each Step; verified `swing` = active grapple joint |
| Last-hit attribution (`lhid`/`lht=120`) | ✅ Both directions recorded, `LAST_HIT_TIMER_TICKS=120` countdown, expiry clears attribution |
| Arrow owner immunity / death arrows (`ard`) | **RESOLVED (§35.1, 2026-07-29):** owner immunity: contact disabled in FFA when hit disc `arrayID == arrow.did`, in team mode when `arrow.team == disc.team` (7054–7055). `ard`: arrow-vs-disc contact → `diedThisStep = 1` (7059–7061); plain `ar` is knockback only. Arrows not grappleable (QueryAABB filters `type=="phys"`), are physical bullet bodies (half-extents 0.5×0.25, density 2.5, restitution 1), lifetime 150 steps (`fte`), charge ≤100 steps, fire needs `a1a==1000` then sets 500, recharge 8/step | ⛔ Not ported — spec complete |

---

### C5. Grapple attachment

| Aspect | Verified | Status |
|--------|----------|--------|
| Target selection | **RESOLVED (§32.1, 2026-07-29):** NOT a raycast — `QueryAABB` ±10 world units around disc center; fixtures from `type=="phys"` bodies only (capzone/noGrapple/frozen excluded); scored by center-to-surface distance (< 10), sorted ascending; first passing `innerGrapple \|\| !TestPoint(discCenter)` wins; `swing.b` = fixture body `arrayID` | ⛔ Port must be reworked — needs AABB query + surface-distance scoring; players never grappleable |
| Anchor point | **RESOLVED (§32.2):** `swing.p = body.GetLocalPoint(worldSurfacePoint)` (body-local); world anchor = `rotatePoint(0, p, body.a) + body.p`; `rotatePoint` = standard 2D rotation (client lines 38733–38751) | ⚠️ Verify port stores body-local anchor (not world) |
| `a1a` gating | **RESOLVED (§32.3):** `a1a` is an energy meter 0–1000, NOT distance. Fire requires `a1a > 500`; swinging drains 4/step; recharge 3/step; forced release + `a1a=0` below 500; max hold 125 steps, recharge 167 steps. Prior "500 map-unit reach" claim **corrected** — 500 is an energy threshold | ⛔ Port distance-check semantics wrong; implement energy meter |
| Joint frequency/damping | **RESOLVED (§32.4):** `frequencyHz = (separation < swing.l) ? 0.01 : swingF`, `dampingRatio = swingD`; defaults `swingF=2`, `swingD=0` (client lines 3463–3464), with no map override writer in this build (`audit-map-option-writers.js`). **Correction:** `fh`/`dr` belong only to map-defined `"d"` joints (client lines 7822–7823), never the grapple | ⛔ Port must implement slack/taut freq switch (0.01 / swingF) and drop fixture `fh`/`dr` grapple wiring |
| Joint type | `b2DistanceJoint` | ✅ |

---

## HIGH — Wrong data model abstractions

### H1. Map format flattened (1 level) vs native 3-level (body → fixture → shape)

- **Status:** ❌ Not fixed — **spec complete (DEOBFUSCATION §33, 2026-07-29)**:
  full body/fixture/shape field layouts, binary field orders, factories/defaults,
  `createNewState` normalization math, and world-build semantics are all resolved.
- **Impact:** Cannot load native exported maps without a converter. Root blocker
  for using real captured maps.
- **Fix:** Implement a native-to-flat converter per §33: replicate
  `(p+365,250)/ppm` body offsets, per-shape ppm scaling + rotation, fixture
  inheritance/negated-friction/filter-bit math, and the per-joint normalization
  (§33.8). Unblocks R2M9.

### H2. Body types: static boolean vs s/d/k

- **Status:** ❌ Not fixed — **spec complete (§33.5)**: native `s.type` is UTF
  `"s"|"d"|"k"` mapped at build to `b2_staticBody`/`b2_dynamicBody`/
  `b2_kinematicBody` (lines 7547–7553); statics additionally get `cf`,`lv`,`av`
  zeroed and all-`np` bodies are forced static.
- **Impact:** Kinematic bodies unsupported.
- **Fix:** Replace `static: boolean` with `type: 's' | 'd' | 'k'`.

### H3. Spawns: team-keyed object vs per-team spawn array

- **Status:** ❌ Not fixed — **spec complete (§33.6)**: on-disk spawns are
  `{x, y, xv, yv, priority, r, f, b, gr, ye, n}`; runtime converts `(x+365)/
  (y+250)/ppm`, velocity `/ppm`, priority + deterministic jitter, sorts desc, and
  matches teams via `ty1↔f, 2↔r, 3↔b, 4↔gr, 5↔ye`. `sx/sy/sxv/syv/
  spawnTeamInfo` are runtime disc fields, not map fields.
- **Impact:** Discards spawn velocities, team filtering, priority. Assumes 2 spawns.
- **Fix:** Replace `MapSpawnPoints` with array of
  `{x, y, xv, yv, priority, teams: {f,r,b,gr,ye}}` (equivalent to requested
  `{sx, sy, sxv, syv, spawnTeamInfo}` shape after normalization).

### H4. Cap zones: 2 types vs 5 — ✅ FIXED

- **Status:** ✅ Fixed (2026-07-28)
- Full native `ty` 1-5 lifecycle implemented per DEOBFUSCATION §30: timed
  capture (`p`, `l * 30`, `f = 20`, death type 3), instant goals
  (2→red, 3→blue, 4→green, 5→yellow), dynamic-body-only triggers, and
  elimination of non-owners. Verified by `capzone-scoring.test.ts`.

### H5. Joints: distance only vs 4 types — 🔧 Partially fixed

- **Status:** 🔧 `distance`, `rv` (revolute), `lpj` (prismatic) implemented;
  `lsj` (line/spring joint) not exported by this Box2D port. **Full native
  construction spec now resolved (§33.8)**: `lpj`/`p`/`lsj` are all native
  `b2LineJointDef` (t$e[57]); `lsj` = vertical-axis line joint, limits off,
  maxMotorForce `sf*|k|`, motorSpeed ±300 from initial-side computation;
  `d.fh` on disk is a period → runtime `1/fh`.
- **Fix:** `addJoint` now builds revolute and prismatic joints with anchors and
  axes. `lsj` remains ⚠️ Blocked on the port — implementation recipe in §33.8/§33.9
  (substitute prismatic + translation-proportional force, or port
  `b2LineJoint.as` from `reference/bonk1-box2d`).

---

## MEDIUM — Config/test/documentation drift

### M1. `src/core/README.md` stale constants — ✅ FIXED

Constants now document gravity 20, 2/6 solver iterations (with port-limitation
note), ppm-derived radius, force 12, heavy ×0.7 force, circular OOB `850/ppm`,
and the verified contact rules (`tea`/`nc`, swing destroy, `lhid`/`lht`).

### M2. Root `README.md` stale constants — ✅ FIXED

Core physics table now lists gravity 20, 2/6 solver request, PPM 12, force 12,
heavy ×0.7 force, and circular OOB `850/ppm`.

### M3. No tests pin verified physics values — ✅ FIXED

`tests/unit/config-example-sanity.test.ts` pins the example config;
`tests/unit/physics-engine.test.ts` pins gravity 20, force 12, DEFAULT_PPM 12,
2/6 iterations, OOB `850/ppm`; `team-collision.test.ts` pins `lht = 120`.

### M4. Tests encode invented slingshot mechanic — ✅ FIXED

Slingshot tests removed and replaced with verified grapple stability and
`frequencyHz`/`dampingRatio` tuning tests.

### M5. `getObservation()` arena bounds stale — ✅ FIXED

Observations report per-map computed bounds; the 16-float SAB layout carries
`arenaHalfWidth`/`arenaHalfHeight` in both worker modes.

### M6. Opponent policy probabilities hardcoded — ✅ FIXED

`oppMoveProb`/`oppUpProb`/`oppDownProb`/`oppHeavyProb`/`oppGrappleProb` read
from `EnvironmentConfig` with the same default values as before.

---

## LOWER — Correctly not implemented (documented as unresolved)

These are correctly absent per DEOBFUSCATION §28 "do not invent their
implementation." Listed for completeness.

| System | Status | Notes |
|--------|--------|-------|
| `scaleRatio` formula | ✅ Resolved (§34.5, 2026-07-29 build) | `scaleRatio = fittedCanvasWidthPx / 730` in `resizeRenderer()` (pretty 16431–16459); fitted width = `offsetWidth` when aspect ≤ 730:500 (1.46), else `1.46*offsetHeight`. Renderer-global view zoom, copied into disc/arrow graphics — NOT per-player, NOT derived from `body.plen`. Physics never reads it; only fixes rendering-scale assumptions. |
| `cf` constant force | ✅ Resolved (§31.2) — not ported | Per-tick velocity increments `lv += {x,y}` (rotated when `w==false`), `av += ct`, gated on countdown end (client lines 7631–7644, 8314–8323). Constant acceleration; not `ApplyForce`. Not implemented locally. |
| `fz` force zones | ✅ Resolved (§31.1) — not ported | `BeginContact` sensor branch (client lines 7067–7117): `SetEnabled(false)`; force `{x,y}` raw (t=0), angle-rotated (t=1), radial ±`fz.cf` (t=2 repel / t=3 attract); applied to disc/arrow/phys targets per `fz.d`/`fz.a`/`fz.p`; `ApplyForce(force, GetWorldCenter())`. Continuous because world is rebuilt per tick. Not implemented locally. |
| `fr` fixed rotation | ✅ Resolved (§31.3) — not ported | Maps to `b2BodyDef.fixedRotation` (body-def idx 206); forced off if any joint references the body (client lines 7560–7570); discs always fixed-rotation except VTOL (7379–7382). Not implemented locally. |
| `bu` bullet/anti-tunnel | ✅ Resolved mapping (§31.4) — not ported | Maps to `b2BodyDef.bullet` (body-def idx 213; client line 7571); discs always `true` (7394). CCD sweep quality inside the obfuscated port unverifiable. Not implemented locally. |
| `sk` shrink/balance | ✅ Resolved (§31.5) — not ported | Per-tick linear shrink: circle radius `-0.015` floor 0.5; box width `-0.03` floor 1.0; prior values carried through `physics.ss` + `q$`, gated by `ftu <= 0` (client 8459–8524). `audit-training-statics.js` independently reconstructs the dispatcher cases. Corrects §25: balance (`bal`) scales disc radius via `scaleRatio` (7313–7321, 7396), not forces. Not implemented locally. |
| Timed cap-zone tick details | ✅ Resolved (§30 confirmed against 2026-07-29 build, §34.6) | Full lifecycle re-verified line-by-line (init 6714–6731, post-step 8345–8443). Refinements: contested zones only lose progress when the owner is NOT touching (8363–8379); team mode scales both increase and decrease by `group.count` (`gameSettings.tea`, idx 114); no engine default for `l` (editor default 10, `getNewCapZone` 12230–12237); elimination re-fires every tick `p>=l && f==0`. |
| Multi-fixture mass effects | ✅ Resolved (§31.6) — N/A | Standard per-fixture density accumulation, no explicit ResetMassData/custom mass code; disc mass never mutated by contacts (PostSolve = audio/shake only, client lines 7141–7232). Nothing additional to port beyond multi-fixture support (H1). |
| Arrow/projectile system | ✅ Resolved (§35.1) — not ported | modes `ar`/`ard`; `action2` charges `ds` 1/step (max 100), aim `da` ±5°/step; speed `ds+15` (16–115 u/s), spawn offset 1.0 along aim; box 0.5×0.25, density 2.5, friction 0.5, restitution 1, bullet body, `fte` 150 steps −1/step; owner/team immunity (7054–7055); `ard` contact → `diedThisStep=1` (7059–7061); cooldown: fire requires `a1a==1000`, sets 500, recharge 8/step (≈2.08s). Not implemented locally. |
| Football/kick system | ✅ Resolved (§35.2) — not ported | game type `"f"` (`ga`, idx 714) → gravity-(0,0) engine `B` (14110+, iter 2/6); ball: r 0.7, mass 0.6, restitution 0.4, damping 0.6, fixed-rot, bullet; kick: 15-impulse player→ball at ball position, reach 2.3 u, one per `action` press, `kickReady` re-arm on release (14392–14422); goals via pitch x-thresholds `(±(borderThickness+XInner))/ppm` → `scores[2]/[3]++` (14181–14205); host ball spawn/reset UNRESOLVED (client builds only from `state.ball`, 14151). Not implemented locally. |
| VTOL mode | ✅ Resolved (§35.3) — not ported | mode `"v"`: disc `fixedRotation=false`; two wing fixtures (density/friction 0.2, restitution 0.7) scaled by disc radius (7407–7424); per-tick impulses `main=(0,−0.8·r²)`, `asym=(0,−0.16·r²)` in body frame at ±footOffset wing points; 7-state input machine (`vt` 0–6) for both/left/right/down variants (7999–8081); no fuel (`a1a` untouched by flight). Not implemented locally. |
| Balance/nerf system | ✅ Resolved (§35.4) — not ported | `gameSettings.bal[discID]/100` clamped `[-0.95, +1]` → added to disc radius (7313–7321), force/VTOL scale emerge via radius² (7976, 7409) — cross-ref §31.5 confirmed. Heavy: `action` key drains `a1a` 10/step (modes b/v), recharge 5/step; density ×`(1+3.7·a1a/1000)` (7363–7374, 7399 — mass IS scaled up to 4.7×) plus force ×0.7 (7994–7995). **Index-label correction:** 216=density, 217=friction, 218=restitution (reverses §31.6 prose labels; code positions unchanged). Not implemented locally. |

---

## Map Capture Status

| Map | Required mode | Required teams | Status |
|-----|--------------|----------------|--------|
| `grapple 1v1 simple` | Grapple (`sp`) | Off (`tea=false`) | ❌ Not captured |
| `Weird Death Ball` | Grapple (`sp`) | On (`tea=true`) | ❌ Not captured |

**Blocker:** `codeinjector.js` must run before `alpha2s.js` to capture
closure-local state. Browser injection after iframe load does not persist across
reloads. BonkBot navigation corrected (Room List → Create → form → Lobby) but
game-side Create submission still stalls.

**Local capture preparation (2026-08-03):** `Webscripts/capture-init.js` is a
Playwright `browserContext.addInitScript` bootstrap that installs the narrow
state/settings hook before `alpha2s.js` is appended. `BonkBot.navigate()` now
uses the actual unlisted checkbox, returns visible room-list failure text, and
performs one clean creation retry. `scripts/check-webscript-ids.js` validates
the required room-list, lobby, and map-picker IDs against the retained fixtures.
These changes remove the local injection-sequencing blind spot; an authenticated
live session and the server-side lobby connection are still required to capture
the maps.

---

## Fix Log

Chronological record of fixes applied. Append new entries here.

### 2026-07-26 — Initial deobfuscation pass (prior session)

- `GRAVITY_Y` changed from `10` → `20` in `physics-engine.ts`
- `VELOCITY_ITERATIONS` changed from `5` → `2`
- `POSITION_ITERATIONS` added as `6`
- `SetWarmStarting(false)` added to constructor and `reset()`
- `DEFAULT_PPM` set to `12`
- Player disc friction set to `0`, restitution to `0.8`
- `MOVE_FORCE` changed from `8` → `12`
- `HEAVY_FORCE_MULTIPLIER` set to `0.7` (replaced `HEAVY_MASS_MULTIPLIER=3.0`)
- Grapple range set to `500 / SCALE`
- OOB changed to circular `850 / ppm`
- `config-loader.ts` DEFAULTS updated (gravityY 20, moveForce 12, friction 0,
  restitution 0.8, heavyMassMultiplier 0.7, solverIterations 2)
- `tests/unit/physics-engine.test.ts` updated (HEAVY_FORCE_MULTIPLIER 0.7)
- `tests/unit/config-loader-env.test.ts` updated (gravity 20)
- `tests/integration/grapple-mechanics.test.ts` updated (OOB/heavy assertions)
- 186/186 tests passing on updated suites

### 2026-07-27 — BonkBot navigation corrected

- `Webscripts/bonkbot.js` `navigate()` rewritten to use verified DOM:
  - `#classic_mid_customgame` → `#roomListContainer` (not `#sm_gameChoiceWindow`)
  - Room List → Create → `#roomlistcreatewindow` form → Lobby
  - `#maploadtypedropdownoption10` for MY FAVS (not a Favorites tab)
  - `.maploadwindowmapdiv > .maploadwindowtextname` for map row matching
- `docs/BONK_AUTOMATION.md` updated with verified navigation flow
- `node --check Webscripts/bonkbot.js` passes

### 2026-07-27 — Full codebase audit completed

- Three parallel subagents read all of `src/`, `python/`, `tests/`, `docs/`
- Discrepancy report compiled (this file's source audit)
- `subagent_batching_efficiency` saved to project memory

---

## NEW SECTION — Deep audit round 2 (2026-07-27, 2 parallel subagents)

Second-pass audit covering worker pool / IPC / Python↔TS contract / behavior tests.
These are logic bugs beyond physics constants.

### R2-CRITICAL — Result corruption in shared-memory multi-worker path

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R2C1 | Missing `actionIdx += wEnvs` — every worker overwrites `_resultPool[0..N-1]`; only last worker's data survives | `worker-pool.ts` L427-456 | ✅ |
| R2C2 | `_obsPool` template aliased across workers (worker-local index used as global pool index) | `worker-pool.ts` L449, L295, L530-532 | ✅ |
| R2C3 | Cap-zone team mapping inverted: env `2→blue, 3→red`; native `2→red, 3→blue` (§30) | `physics-engine.ts` L263-267 | ✅ |
| R2C4 | Instant cap-zone does not eliminate non-owner discs (native: death type 3, permanent) | `physics-engine.ts` L262-268, `environment.ts` L517-530 | ✅ |

**Test coverage for R2C1/R2C2:** NONE — all shared-memory tests use `WorkerPool(1)` (single worker), so the bug never manifests. Multi-worker tests use `useSharedMemory=false`.
**Test coverage for R2C3:** Tests assert the *wrong* mapping, locking in the bug.
**Test coverage for R2C4:** No test verifies player elimination after cap-zone contact.

### R2-HIGH

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R2H1 | Timed cap-zones (`ty===1`) completely non-functional (no progress/limit/countdown) | `physics-engine.ts` L262-267 | ✅ |
| R2H2 | Shared-memory mode drops top-level `terminated` from result — Python reads `terminated=False` for natural deaths | `worker-pool.ts` L186-192, `bonk_env.py` L153-164 | ✅ |
| R2H3 | `terminal_observation` lost in shared-memory mode (not written to SAB) | `worker.ts` L260-266, `worker-pool.ts` L446-454 | ✅ |
| R2H4 | WDB map absent from `maps/` — cap-zone code dead in default config; WDB tests error | `map-integration.test.ts` L111-192, `environment.ts` L147 | ⚠️ Blocked (map capture); WDB tests now skip explicitly when absent |
| R2H5 | All Python tests skip (`conftest.py` references missing `server.mjs`) — entire Python↔TS contract untested | `python/tests/conftest.py` L13-17 | ✅ |
| R2H6 | Cap-zone tests validate the wrong model (instant scoring, no elimination, only 2 teams, inverted colors) | `capzone-scoring.test.ts`, `joints-capzones.test.ts` | ✅ |

### R2-MEDIUM

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R2M1 | Seed `0` treated as "no seed" in shared-memory reset (`0 || undefined`) | `worker.ts` L230 | ✅ |
| R2M2 | Port leak on `BonkEnv.start()` failure (allocated in ctor, released only in stop) | `bonk-env.ts` L49-64, `env-manager.ts` L42-61 | ✅ |
| R2M3 | Observation shape differs between modes: shared-memory omits `arenaHalfWidth/Height` | `worker-pool.ts` L530-573, `environment.ts` L542-570 | ✅ (16-float layout) |
| R2M4 | Python legacy `max_ticks` default `1000` vs TS `900` — wrong truncation classification | `bonk_env.py` L170, `environment.ts` L34 | ✅ |
| R2M5 | `info["_episode"]` not recognized by SB3 (expects `info["episode"]`) | `bonk_env.py` L187-190 | ✅ |
| R2M6 | Python `close()` does not notify TS server — orphaned workers | `bonk_env.py` L202-205, `ipc-bridge.ts` L106 | ✅ |
| R2M7 | Conflicting `MapDef` interfaces: test util `capZones`/`physics.bounds` shapes vs source | `map-loader.ts` L9-22, `physics-engine.ts` L196-202 | ❌ |
| R2M8 | `environment.ts` ignores `config.environment.defaultMapPath` — hardcodes `__dirname`-relative WDB path | `environment.ts` L147 | ✅ |
| R2M9 | Cap-zone sensor placed at body center, not fixture offset | `environment.ts` L195-209, `physics-engine.ts` L373-387 | ⚠️ Blocked (needs native fixture offsets → H1) — **mechanism resolved (§33.7)**: native marks the cap-zone's *referenced fixture* (`capZones[].i` = fixture index) with `userData.capzone/capID/capType`; sensor geometry = that fixture's own shape with `SetLocalPosition` offset; runtime zone `{ty,p:0,l:l*30,i,o:-1,ot:-1,f:-1}` |
| R2M10 | `stepAll` returns nested `StepResult[][]`; `resetAll` returns flat — inconsistent | `env-manager.ts` L186-224 | ✅ |

### R2-TEST BUGS

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R2T1 | Blackbox test expects `observation` as `Array(14)`, code returns object — test should fail | `worker-pool-blackbox.test.ts` L116-122 | ✅ |

### R2-SUSPICIONS (high confidence, needs execution to confirm)

| ID | Suspicion | Location | Status |
|----|-----------|----------|--------|
| R2S1 | `frameSkip > 1` + auto-reset: worker reset clears `terminalReached`, breaking frame-skip terminal hold | `environment.ts` L405-419, `worker.ts` L246-253 | ❓ (unverified) |
| R2S2 | IPC bridge shallow config merge loses nested defaults when Python sends partial config | `ipc-bridge.ts` L63 | ✅ Confirmed and fixed (deep merge) |

---

## NEW SECTION — Deep audit round 3 (2026-07-27, 2 parallel subagents)

Third-pass audit covering telemetry, PRNG, server lifecycle, types, Python reward
math, benchmarks, map data, examples, and test infrastructure.

### R3-CRITICAL

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R3C1 | `create_reward_from_config` — `weight` leaks into sub-reward constructors → TypeError; composite rewards unusable; `test_create_composite` would throw | `reward_functions.py` L656-662 | ✅ |

### R3-HIGH

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R3H1 | `gatherWorkerTelemetry()` called without `await` — worker snapshots never reach report | `telemetry-controller.ts` L220 | ✅ |
| R3H2 | `mergeConfigWithFlags` cannot distinguish "CLI set value = default" from "CLI left default" — config silently overrides explicit CLI/env | `flags.ts` L309-333 | ✅ |
| R3H3 | `environment.ts` uses `Math.random()` for default seed — breaks determinism guarantee | `environment.ts` L165 | ⚠️ Documented behavior: explicit seeds are fully deterministic; absent/0 seed intentionally randomizes and stores the effective seed |
| R3H4 | `deepMerge` no `__proto__`/`constructor`/`prototype` filter — prototype pollution; security test tests wrong function | `config-loader.ts` L271-283 | ✅ |
| R3H5 | NavigationReward `goal_reached` bonus fires when `done=True, goal_reached=False` (false positive at death/timeout) | `reward_functions.py` L150-156 | ✅ |
| R3H6 | NavigationReward double-counts `time_bonus` on success (potential shaping + terminal block) | `reward_functions.py` L138-156, L186-190 | ✅ |
| R3H7 | `NavigationReward`/`CuriosityReward`/`CountBasedExplorationReward` don't forward `enabled` to super — disabling via config silently ignored | `reward_functions.py` L109, L643-646 | ✅ |
| R3H8 | CuriosityReward includes current state in its own distance computation → novelty always ~1.0, reward effectively constant | `reward_functions.py` L373-374 | ✅ (novelty `d/(1+d)`, excludes self) |
| R3H9 | IPC stress benchmark SPS is per-batch not per-env — results misinterpreted by factor of `num_envs` | `layer7-ipc-stress.py` L39-41 | ✅ |
| R3H10 | Spawn logic uses positional `spawnVals[0]/[1]` not team keys — AI spawns at red spawn, opponent at hardcoded fallback, when only `team_red` defined | `environment.ts` L278-280 | ✅ |

### R3-MEDIUM

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R3M1 | `ipc-bridge.ts` wraps `JSON.parse`/`sock.send` unconditionally at load — telemetry overhead even when disabled | `ipc-bridge.ts` L7, L22 | ❌ |
| R3M2 | `Profiler.reset()` clears `TelemetryBuffer`/counters but not `gauges` — stale gauges persist across windows; test encodes this as correct | `profiler.ts` L246-255, `profiler.test.ts` L352-356 | ✅ |
| R3M3 | `TelemetryController.shutdown()` final report skipped by window guard; tick counters desynced | `telemetry-controller.ts` L309-320 | ❌ |
| R3M4 | `startCollection()` interval never stopped on shutdown (dead code but latent leak) | `profiler.ts` L399-413 | ❌ |
| R3M5 | `BonkEnv.stop()` calls `pool.close()` without await; port released before workers terminate — race on port reuse | `bonk-env.ts` L107, `worker-pool.ts` L588-604 | ✅ (close is awaited everywhere; pending callbacks rejected on close) |
| R3M6 | `PRNG` seed/state not normalized to 32-bit unsigned — out-of-domain seeds and long runs can leave the uint32 ring and lose precision | `prng.ts` L19-24, L30-32 | ✅ (seed and state normalized; canonical sequence preserved) |
| R3M7 | Physics hooks permanently wrapped; trampoline adds 2 fn calls/tick even when telemetry disabled; no disable path | `physics-engine.ts` L759-781 | ❌ |
| R3M8 | `bonk-env.ts` StepResult.observation typed `any`; contradicts `environment.ts` Observation; types README shows third shape | `bonk-env.ts` L28-34, `types/README.md` L44-57 | ❌ |
| R3M9 | `ipc-bridge.test.ts` asserts step/reset without init returns `ok` — encodes missing-validation bug | `ipc-bridge.test.ts` L179-193 | ✅ (init validation added; tests updated including `ipc-bridge-constructor` telemetry-step tests) |
| R3M10 | CompositeReward `_normalize_reward` computes EMA stats but never uses them; windowed z-score includes current reward (look-ahead bias) | `reward_functions.py` L275-290 | ✅ |
| R3M11 | `RewardValidator.check_gradient_friendly`/`validate` pollute reward_fn state without reset | `reward_functions.py` L576-618, L514 | ✅ |
| R3M12 | `TrainingLogger` no flush/context manager; CSV data lost on crash; `'w'` mode truncates prior runs | `training_logger.py` L11-29 | ✅ |
| R3M13 | IPC latency benchmark "parse_ms" measures dict lookup, not JSON parse — misleading decomposition | `layer7-ipc-latency.py` L57-60 | ✅ |
| R3M14 | Ball Pit map: 4+ bodies at y=-2825..-33155, x=-42385 — outside world AABB ±1000 phys units; physics instability/silent exclusion | `bonk_Ball_Pit_524616.json` L967-L1371 | ✅ (world AABB widened to ±5000) |
| R3M15 | `bonkhost.js` `avgPingDiff` operator precedence: `(sum-max-min)/length - 2` instead of `/(length-2)` — off by 2.0 | `bonkhost.js` L630-635 | ✅ |

### R3-LOW

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R3L1 | `main.ts` auto-timeout `setTimeout` never cleared | `main.ts` L81-85 | ✅ |
| R3L2 | `isAnyTelemetryEnabled()` `startsWith('--profile')` matches `--profiler`/`--debugging` false-positives | `flags.ts` L233-236 | ✅ |
| R3L3 | `TelemetryController` "double-checked locking" comment misleading; no actual race but comment wrong | `telemetry-controller.ts` L53-62 | ❌ |
| R3L4 | `AvatarLayer.flipY` typed `number` but documented boolean semantics | `types/index.d.ts` L402-404 | ❌ |
| R3L5 | `telemetry.test.ts` duplicate `afterEach` blocks (copy-paste) | `telemetry.test.ts` L122-127 | ❌ |
| R3L6 | `main.ts` SIGINT dual registration (process + readline) — safe but redundant | `main.ts` L52-65 | ❌ |
| R3L7 | `server.ts` `stopServer()` nulls bridge in `finally` even if close() threw — inconsistent state | `server.ts` L44-51 | ❌ |
| R3L8 | `visualize_map.py` annotate offset `+10,-10` invisible at map scale (hundreds-thousands range) | `visualize_map.py` L49-52 | ❌ |
| R3L9 | `visualize_map.py` default map path → missing WDB file; tool broken by default | `visualize_map.py` L56 | ✅ |
| R3L10 | IPC latency benchmark hardcodes port 5555, can collide with live BonkVecEnv | `layer7-ipc-latency.py` L11, L17 | ❌ |
| R3L11 | Simple_1v1 map `restitution: -1` undocumented sentinel → mapped to 0.4 (handled but magic) | `bonk_Simple_1v1_123.json` L28 | ❌ |
| R3L12 | `parallel-envs.ts` example passes `[1,2,3,4]` as seeds to resetAll (valid but misleading naming) | `examples/parallel-envs.ts` L48 | ❌ |
| R3L13 | `training_logger.py` hardcoded obs indices [0],[1],[7],[8], no validation for partial obs | `training_logger.py` L21-24 | ❌ |
| R3L14 | Ball Pit body `static:true` + `noPhysics:true` redundant/confusing combination | `bonk_Ball_Pit_524616.json` L294-296 | ❌ |

### R3-TEST BUGS

| ID | Bug | Location | Status |
|----|-----|----------|--------|
| R3T1 | `config-injection.test.ts` tests local `deepMergeTest` (with protection), not production `deepMerge` (without) — false confidence | `tests/security/config-injection.test.ts` L39-71 | ✅ |
| R3T2 | `ipc-bridge.test.ts` encodes step/reset-without-init = 'ok' as correct | `tests/unit/ipc-bridge.test.ts` L179-193 | ✅ |
| R3T3 | `profiler.test.ts` encodes gauge-non-reset as correct behavior | `tests/unit/profiler.test.ts` L352-356 | ✅ |
| R3T4 | `test_create_composite` would throw TypeError (R3C1) — test broken | `python/tests` reward config test | ✅ |
| R3T5 | Reward tests assert clip-range not expected values — mask C2/C4 math bugs | `python/tests` reward tests | ✅ (49/49 with meaningful assertions) |
| R3T6 | `telemetry-controller.test.ts` spies on `getTelemetrySnapshots` being called, not results in report — masks R3H1 | `tests/unit/telemetry-controller.test.ts` L393-407 | ❌ |
| R3T7 | `vitest.config.ts` excludes `tests/e2e/**` — e2e tests never run in CI | `vitest.config.ts` L6-15 | 🚫 Intentional (per project decision); **`pool: 'forks'`** now also fixes the native-module teardown crash that prevented full-suite completion |

### R3-SUSPECTED (unconfirmed, needs runtime verification)

| ID | Suspicion | Location | Status |
|----|-----------|----------|--------|
| R3S1 | `TelemetryController.tick()` never called in production — report path dead code; IPC path ignores `reportInterval` config | `telemetry-controller.ts` L195-204, `ipc-bridge.ts` L88-98 | ❓ |
| R3S2 | `worker-loader.js` `require('tsx/cjs')` fragile; no error handling if tsx missing/changed | `worker-loader.js` L1 | ❓ |
| R3S3 | NavigationReward `_prev_distance` set but never read — dead state | `reward_functions.py` L164, L201 | ❓ |
| R3S4 | `CountBasedExplorationReward._discretize_state` bin encoding edge cases (tanh range, digitize bins) | `reward_functions.py` L443-448 | ❓ |
| R3S5 | Both maps `collidesWithPlayers:false` + group filter → players may pass through all platforms (needs runtime check vs native) | map JSONs, `physics-engine.ts` L346-349 | ❓ |

---

## Next Steps (Priority Order)

### Immediate (correctness — wrong results)
1. **R2C1**: Add `actionIdx += wEnvs;` after `worker-pool.ts` L455 — one-line fix for result corruption
2. **R2C2**: Separate worker-local SAB offset from global `_obsPool` index in `extractObservation`
3. **R2C3**: Fix cap-zone mapping `2→red, 3→blue` in `physics-engine.ts` L263-267 + update `capzone-scoring.test.ts`
4. **R2C4**: Implement death-type-3 elimination on instant cap-zone contact
5. **R2H2**: Add `terminated` to shared-memory result pool `info`
6. **R2H3**: Serialize `terminal_observation` in SAB or propagate via message

### High (cap-zone / physics fidelity)
7. Fix `config.example.json` (C1) — user-facing, quick win
8. Fix `config-loader.ts` DEFAULTS (C2) — add `positionIterations`, remove invalid keys
9. Fix `physics-engine.ts` body restitution default 0.4 → 0.8 (C3)
10. Remove invented slingshot mechanic + tests (C3, M4)
11. Fix grapple anchor to surface point, read `fh`/`dr` from fixture (C5) — **superseded by §32 (2026-07-29)**: native grapple uses no `fh`/`dr` (those are map `"d"` joint fields); correct native behavior is slack/taut frequency switching (0.01 Hz vs `swingF`=2 Hz, `swingD`=0) with body-local anchor and `a1a` energy gating
12. **R2H1**: Implement timed cap-zone lifecycle (`p`, `l*30`, `f=20`, death type 3)

### Medium (robustness / config / tests)
13. Add tests pinning verified physics values (M3) + multi-worker shared-memory tests (R2C1/R2C2 coverage)
14. Update `src/core/README.md` and root `README.md` (M1, M2)
15. Fix `getObservation()` arena bounds (M5) + mode-consistency (R2M3)
16. Read opponent probabilities from config (M6)
17. Fix R2M1 (seed 0), R2M2 (port leak), R2M4 (max_ticks), R2M5 (`info["episode"]`), R2M8 (`defaultMapPath`), R2M10 (`stepAll` flatten)
18. Fix R2T1 (blackbox test array expectation)

### Blocked / requires capture
19. Implement native map format converter (H1) — unblocks real map loading
20. **R2H4**: Capture WDB map into `maps/` — unblocks cap-zone tests and default env
21. Capture the two training maps (Map Capture Status) — unblocks faithful training
22. **R2H5**: Create `server.mjs` or fix `conftest.py` to spawn `npx tsx src/main.ts` — unblocks all Python tests

---

## 2026-07-28 — Remediation Implementation Log

The following tracker items are implemented and verified by targeted regression
tests unless a port limitation is noted.

| IDs | Status | Implemented fix |
|-----|--------|-----------------|
| C1/C2, R3H4 | ✅ | Corrected verified config example values, added position iterations, and protected production `deepMerge` from prototype-pollution keys. |
| C3/C4/C5, R2C3/R2C4/R2H1 | ✅ | Corrected restitution and grapple configuration; removed invented slingshot; implemented verified instant/timed cap-zone lifecycle, team mapping, countdown, and death types. |
| R2C1/R2C2/R2H2/R2H3/R2M1 | ✅ | Fixed multi-worker SAB result indexing, observation aliasing, terminal observations, termination propagation, seed-zero transport, response-timeout cleanup, and dynamic arena bounds in the 16-float SAB observation layout. |
| R2M2/R2M6/R2M8/R2M10 | ✅ | Fixed failed-start port cleanup, async worker shutdown, IPC close command/deep config merge, configured map path, and EnvManager result flattening. |
| R3H1/R3H2/R3M2/R3L1/R3L2 | ✅ | Fixed telemetry gather ordering, explicit flag precedence, gauge reset, timeout cleanup, and flag-prefix false positives. |
| R3C1, R3H5-R3H8, R3M10-R3M11 | ✅ | Fixed composite reward construction, enabled propagation, navigation bonus logic, curiosity repeat reward, normalization, and validator state cleanup. |
| R2M4/R2M5, R3M12-R3M15, R3L9 | ✅ | Fixed Python episode metadata/close behavior, logger durability, visualization default map, benchmark metrics/timing, and BonkHost trimmed-mean arithmetic. |
| R2H4, H1-H5, `fz`/`cf`/`fr`/`bu`/`sk`, full native grapple anchor, `lsj`, Step 2/6 parity, ClearForces | ⚠️ Blocked | Requires captured native maps, unresolved runtime traces, or Box2D-port capabilities unavailable in the installed dependency. |

Verification on 2026-07-28:

- Targeted TypeScript remediation suite: **233/233 passing**.
- Python reward suite: **49/49 passing**.
- Worker loader dependency repaired with `bun install`; `resolve-pkg-maps` and worker startup now resolve.
- Full suite still has legacy-test failures for the absent WDB map, rectangular-bound assumptions superseded by verified circular OOB behavior, and collision tunneling in this older Box2D port at verified movement settings. These remain tracked as compatibility/blocker work rather than being hidden by source regressions.

### 2026-07-29 — Remaining CRITICAL contact rules (C4) and reconciliations

Implemented the verified disc-disc contact rules from DEOBFUSCATION
BeginContact case 6:

- **Same-team disable (`tea`)**: discs on the same team no longer collide when
  teams are enabled. The bundled Box2D v2.0 port never invokes
  `SetContactFilter` callbacks (verified by an empty-call repro), so the rule is
  enforced through per-disc category/mask data: teams map onto the native
  g1-g4 collision-group slots (`red=0x0002`, `blue=0x0004`, `green=0x0008`,
  `yellow=0x0010`) and each disc's mask excludes its own team bit. Unknown or
  unassigned teams keep the legacy id-based categories and always collide.
- **No-collision mode (`nc`)**: `setNoCollide(true)` removes all four player
  bits from every disc mask. `EnvironmentConfig.noCollide` and
  `EnvironmentConfig.teamsEnabled` wire both flags; map `physics.teams` /
  `physics.nc` are honoured as map-level defaults.
- **Swing destroy (`swingCollideDestroyEvents`)**: a disc-disc contact while a
  grapple joint is active queues the disc for grapple destruction after the
  step (`pendingSwingDestroy` processed post-Step, matching native ordering).
- **Last-hit attribution (`lhid` / `lht`)**: both discs record each other with
  `LAST_HIT_TIMER_TICKS = 120` (verified 4-second window); the countdown runs
  before each Step so fresh contacts keep their full window, and expiry clears
  attribution. Exposure: `getLastHit(playerId)`, `hasGrappleJoint(playerId)`.

Reconciliations (no code change; tables corrected above):

- C3 grapple range: **SUPERSEDED (2026-08-02):** the earlier 500-unit-reach
  interpretation was wrong. `500` is the `a1a` energy threshold; native target
  acquisition uses QueryAABB/surface-distance within 10 units. See
  `DEOBFUSCATION.md` §§32.3 and 38.6.
- C1/C2: **SUPERSEDED (2026-08-02):** the prior friction, restitution, heavy,
  and grapple rows were based on earlier research. The current rows and
  `DEOBFUSCATION.md` §38.6 are authoritative; regression references do not
  establish native fidelity for the superseded values.

Performance notes (logged in `docs/PERFORMANCE.md`):

- OOB death check now uses a cached squared radius (`oobRadiusSquared`) instead
  of a per-player `Math.sqrt` every tick; threshold is identical.
- Team/mode filter recomputation is event-driven (team set, mode toggle, disc
  creation) — zero per-tick cost.
- Swing-destroy uses a `Set`, deduplicating repeated contacts without extra
  allocation.
- Identified, not yet done: contact-listener `extractContact` allocates a
  `{ud1, ud2}` object per contact callback; pooling it would cut allocation on
  body-heavy maps (Ball Pit).

Verification on 2026-07-29:

- New `tests/integration/team-collision.test.ts`: **11/11 passing**
  (same-team, nc, unassigned-team, swing-destroy, lht lifecycle, reset cleanup).
- Physics regression batch (10 files): **259 passed, 19 skipped, 0 failed**.
- Worker integration: **16/16 passing** (multi-worker distribution, SAB bounds).

### 2026-07-29 — Full-suite completion unblocked (test infrastructure)

- Root-caused the recurring `npx vitest run` crash (exit `-1073741819`,
  `0xC0000005` access violation after test completion): the native `zeromq`
  module crashes during vitest **worker-thread** teardown. Repro: single-file
  IPC suite passes 76/76 but the process AVs at exit; plain standalone ZMQ
  bind/close/exit is clean; `--pool=forks` is clean.
- `vitest.config.ts` now uses `pool: 'forks'` (`maxForks: 4`, `isolate` kept).
  This is the first change that lets the entire TypeScript suite finish.
- Fixed `tests/unit/ipc-bridge-constructor.test.ts` telemetry-step tests that
  relied on step-before-init (now correctly rejected since R3M9): they init the
  bridge before simulating steps.
- **Full suite: 44 files, 1094 passed, 19 skipped (WDB-map gated), 0 failed,
  exit 0.** The 19 skips are the intentionally gated `bonk_WDB…` tests pending
  live map capture.

### 2026-07-29 — Code-review remediation (14 findings)

Security:
- Removed the hardcoded bonk.io account password from `Webscripts/bonkbot.js`;
  credentials now come from `BONK_USERNAME` / `BONK_PASSWORD` environment
  variables with a fail-fast error.

Protocol / deploy:
- The IPC `"close"` command is now **session-scoped** by default: it frees
  worker-pool state but keeps the Router listening, so multiple
  `BonkVecEnv` lifecycles (conftest fixtures, benchmark iterations) share one
  server without hanging. Full server shutdown requires
  `{"command": "close", "shutdown": true}`.

Verified-physics corrections:
- **OOB death circle is exactly 850 map units** (`850 / SCALE` in this port).
  The previous `850 / ppm` misread the native px/ppm world-unit formula — ppm
  cancels because native map geometry converts with the same ppm. Radius is
  now constant and ppm-independent; `dynamic-arena-bounds` expectations that
  relied on the 2.5×-too-large circle were corrected (a player at 900 px from
  center dies, as native).
- **Instant cap-zones score once on contact begin** — the `Persist` handler
  no longer re-fires `triggerInstantGoal` every tick a body dwells in a type
  2–5 zone (`isBegin` gating); regression test proves a resting ball re-reads
  `null` after the consumed goal.
- **Cap-zone capture no longer double-counts reward** — death-type-3
  eliminations skip the kill/death reward transition; one capture = exactly
  ±1 (+0.999 with time penalty), pinned by a regression test.
- **`physics.bounds` map override actually applies** — cached in the
  environment constructor and re-applied at the end of every `reset()` (the
  constructor's own internal reset had always clobbered it).
- **SAB seed transport validated** — out-of-range seeds (including
  `0xFFFFFFFF`, which wrapped to the no-seed sentinel) now throw instead of
  silently reusing stale RNG state.
- **`info.terminated` normalized in both transport modes** (`done && !trunc`
  unconditionally) and computed in place without per-result object spreads.

Performance (logged in `docs/PERFORMANCE.md`):
- `Persist` early-exits when the map has no cap-zone sensors.
- Contact extraction reuses one scratch object (sequential listener calls).
- `getArenaBounds()` returns a cached read-only object (zero-GC obs path).
- `capZoneTouches` cleared via `.length = 0` instead of reallocation.
- Message-mode step results normalize termination flags in place.

Config/docs:
- `config.example.json` marks `positionIterations` as inert (port ignores the
  3rd Step argument) instead of appearing tunable.
- `DEOBFUSCATION.md` Death Type 4 section documents the verified
  850-map-unit / `850 / SCALE` conversion note.
- Removed stale slingshot JSDoc, annotated write-only `grappleMultiplier` as
  map passthrough, dropped an unused test import.

Test infrastructure (found while verifying):
- `python/tests/conftest.py`: replaced `Popen(["npx", ...])` (WinError 2 —
  `npx` is a `.cmd` wrapper on Windows) with a shell-launched resolved path,
  and redirected server stdout/stderr to `DEVNULL`; undrained PIPE buffers
  had deadlocked the verbose server after ~6 env lifecycles.
- Two `nophysics-friction` escape-flight tests retuned to the verified
  850-unit OOB circle (old durations only worked under the 2.5× circle).

Final verification (2026-07-29):
- TypeScript full suite: **44 files, 1101 passed, 19 skipped (WDB gated),
  0 failed, exit 0.**
- Python full suite: **72/72** (23 env tests incl. repeated session close
  against one shared server + 49 reward tests).

### 2026-07-29 — §31 trace: force, shrink, and mass mechanics (read-only)

Static trace of the 2026-07-29 client (`.deobf/alpha2s.pretty.js`); no code
changes. All six previously-unresolved systems were resolved at the
source level — see `DEOBFUSCATION.md` §31 for line-numbered evidence:

- **Structural discovery:** the step function rebuilds the Box2D world from
  serialized state every tick (`novakReset` + full `CreateBody`/`CreateFixture`
  pass, bodies re-seeded from serialized `p`/`a`/`lv`/`av`); `Step` runs only
  when the round countdown reaches `-1` (client lines 6996–7237, 7536–7647,
  8313–8325, 8571–8579). This is what makes `fz` continuous and `cf` a
  per-tick acceleration.
- `fz`, `cf`, `fr`, `bu`, `sk`, multi-fixture mass: all RESOLVED (details in
  LOWER table above). None ported into the local simulator — they remain
  feature-port work, no longer deobfuscation blockers.
- Correction to §25: balance (`bal`) scales the disc radius via `scaleRatio`,
  not the movement force.
- Remaining opaque: exact `w_c`/`Q5$` arithmetic for the shrink factor (0.015
  constants and floors are verified), CCD sweep presence inside the bundled
  obfuscated Box2D port, exact `scaleRatio` composition formula.

### 2026-07-30 — Local deobfuscation bundle milestone: `.deobf/alpha2s.readable.js` (audited, PASS 7/7)

- The full client (2026-07-29 build) is now locally deobfuscated by
  `.deobf/final-pipeline.js` (string inline → op-fold →
  annotation+targeted substitution → banners) into
  `.deobf/alpha2s.readable.js`: 14,256 member-name substitutions, 72,897
  bracket annotations, 5,939 string inlines, 1,696 op-folds, 43 banners.
  Pipeline is idempotent (byte-identical on re-run, SHA-256 verified).
- An independent adversarial audit (`.deobf/audit-independent.js`, report
  `.deobf/audit-report.txt`) by an agent that did not build the pipeline
  verified, without trusting `final-stats.json`:
  1. syntax `node --check` exit 0 — PASS;
  2. idempotence via before/after SHA-256 — PASS (identical);
  3. semantic drift: own-lexer rescan of `pretty.js`, alignment-walked all
     14,836 receiver sites + 20 random samples vs `tables.json` — 0 mismatches — PASS;
  4. annotation correctness: all 72,897 + 20 samples — 0 mismatches — PASS;
  5. negative space: no numeric index inside loops/table-literals substituted;
     0 dotted accesses inside bracket indices — PASS;
  6. residual decoders (`k7V.` 2,820, `B3jF8.` 1,756, `H0n(` 405, `d1M(` 417,
     `Q5$(` 405, `w_c(` 460) all expected residue — PASS;
  7. readability: 69.8 obfuscated identifiers/100 lines global (12.5–236
     across 5 windows) — readable structure, obfuscated locals, flattening
     not reversed.
- Residual limits and the analysis-artifact/no-redistribution note are
  documented in `DEOBFUSCATION.md` §36.

### 2026-07-31 — Interim expanded substitutions and verified protocol/state trace (superseded)

- Replaced the five-receiver pass1 cap with whole-bundle mechanical eligibility:
  exactly one `var receiver = [arguments]` declaration, no reassignment, no
  dynamic index, and no out-of-table literal slot. Slot `47` (`length`) is
  always annotation-only after a direct raw-source proof that it is also used
  as a packed loop counter.
- Updated `final-pipeline.js` to use a reverse chunk builder instead of repeated
  string splicing, allowing the larger artifact to regenerate efficiently.
- Regenerated the local analysis artifact: **44,992 substitutions**, **42,161
  annotations**, 5,939 decoder inlines, 1,696 constant folds, and 43 banners.
  Pipeline validation passed: syntax, bracket parity, 25/25 spot audit, and
  zero reported unsafe substitutions.
- Updated the independent audit to derive receiver coverage from
  `callsites.json`: it alignment-walked 187 safe-to-substitute receivers
  (44,992 dotted plus 2,084 bracket-annotated sites) with zero mismatches or
  desyncs; 12 do-not-substitute receivers were checked negatively. All 42,161
  annotations matched the property table, and 79 dynamic indices remained
  bracketed.
- Added `DEOBFUSCATION.md` §37 with direct-bundle evidence for AMD/external
  physics boundaries, PeerJS/socket/timesync transport, input and replay codecs,
  outgoing state construction, timers, live disc damping, contact callbacks,
  interpolation, and camera-shake serialization.

### 2026-08-02 — AST coverage closure and immutable table-string folding

- Replaced the pass1 character scanner with AST source-range discovery. It
  finds all **89,199** literal numeric member accesses in the AMD body and
  closes the historical division-as-regex gap (341 sites: 279 dotted-label and
  62 annotation decisions before table folding).
- Added a whole-expression immutable `M$QCc` table-fold pass between pass3 and
  AST pass1. Binding/escape proof and independent re-derivation approve
  **23,852** decoded-string folds: 1,186 direct aliases and 22,666 carrier
  slots. The 554 index-47 cases become the literal string `"length"`; none can
  become `.length`.
- Final body accounting is **46,518 fold-covered + 31,373 dotted analysis
  labels + 11,298 annotations + 10 unchanged out-of-table = 89,199**. The
  effective dotted-label count is lower because a complete decoded string
  supersedes its inner bracket/dotted access; dots are analysis labels, not
  evidence of an original JavaScript property.
- Added the versioned `final-folds.json` provenance sidecar, table-fold audit,
  fold-aware AST and pass-one audits, explicit index-47 emission guards, and
  nonzero audit exits for coverage/provenance failures.
- Verified syntax, AST closure, annotations, negative space, pass3-LHS
  recovery, 23,852/23,852 table folds, anchors, delimiter parity, and two
  byte-identical pipeline regenerations
  (`A7458BCE644F6134A00905CB092EFBCF0FBEFAFF371ED06040D5CFA57D32C973`).
- Added `DEOBFUSCATION.md` §38 as the authoritative full-build inventory:
  scope boundary, retained artifact contract, reproducible validation set,
  preamble/dynamic/control-flow residual census, client/server limits, and
  a correction matrix for superseded historical research. Corrected C1-C4
  tracker rows that still claimed the old 500-unit grapple model or stale disc
  fixture values.

### 2026-08-02 — Preamble literal-decoder capture closure

- Added a source-order preamble decoder stage before the existing AMD-body
  passes. It captures each literal `B3jF8.U3q/w65(number)` value twice in a
  fresh VM before emitting it, which preserves the seven stateful warm-up
  numbers that differ from post-bootstrap decoder results.
- The regenerated readable artifact folds all **1,731** preamble literals:
  **1,724** static `M$QCc` strings plus **7** warm-up primitives. The readable
  preamble now has zero literal `U3q`/`w65` calls; its materialized table still
  equals `tables.json` and the original preamble's 1,724 values.
- Added independent `audit-preamble.js` and isolated
  `final-preamble-folds.json` v1 provenance. The audit re-derives candidate
  ranges, replays the original call order twice, checks every captured value and
  replacement, and boots original/readable preambles for table equivalence.
- Updated `DEOBFUSCATION.md` §§36 and 38 with the stage, 20-artifact contract,
  current residual census, validation command, readable size, and current
  generated-artifact SHA-256.

### 2026-08-03 — Strict dispatcher-index table-fold closure

- Added a narrow dynamic table-index pass after immutable literal table folding.
  It starts only from a helper-proven direct `M$QCc` alias, requires a single
  unmodified index variable, an immediately preceding literal `H0n/d1M`
  selector in the same statement list, and two agreeing fresh-VM evaluations.
- Folded **86 / 88** direct table-origin dynamic reads to verified string
  literals, including one index-47 `"length"` string. Two direct-table sites
  with an intervening stateful `t8H` and two non-table `a9M` data-record reads
  deliberately remain bracketed.
- Added `final-dispatcher-folds.json` v1 provenance and extended the independent
  table audit to re-derive every table origin, selector/call pattern, and fresh
  VM value; it verifies sidecar bijection, readable values, and both retained
  strict-pattern rejections.
- Validation passes: syntax, AST closure, preamble capture, 23,852 literal table
  folds, 86 dispatcher-index folds, anchors, and table-audit self-check. The
  pre-formula readable artifact was 4,473,471 bytes with SHA-256
  `2047EACBAC21FA9D8BD635F4A7E1C344F415CD5B5E0335DE4FBE538D77969103`.

### 2026-08-03 — Strict dispatcher-formula fold closure

- Added `op-dispatch-fold.js` and pass3b to replace only a dispatcher call with
  its static case formula, retaining the selector statement and assignment LHS.
  The helper validates the 253-case `B3jF8[239984]` map
  (`6bd5eabc9911df5b9339334ff9034f97fdbc979b30a834761a3bb9f6c9c53a87`),
  the selector setter, exact four forwarders, and the sole stable `k7V` alias.
- Conservatively accepted **48 / 207** non-literal candidates. All **159**
  retained calls are `formula_reorders_arguments`: emitting their cases would
  change JavaScript left-to-right argument evaluation. The accepted formulas
  recover 79 dotted labels and 19 annotations across 47 sites; none involves a
  dotted index-47 (`length`) access.
- Added `final-formula-folds.json` v1 and `audit-formula-fold.js`. The formula
  audit independently re-derives every candidate, case, binding, selector,
  recovery, and sidecar record. `audit-table-lookup.js` additionally compares
  each paired readable AST expression against the independently rebuilt formula.
- Two fresh pipeline generations, syntax, AST closure, preamble provenance,
  formula/table sidecars, pass-one labels, anchors, and all audit self-checks
   pass. Current readable artifact: 4,473,431 bytes; SHA-256
   `6AB86E2960E3DB3083089238AEF6CF749636093B64E92FD14F25DAC6455DA65E`.

### 2026-08-03 — Training option and residual closure

- Added `audit-map-option-writers.js`, which joins AST parent roles to the
  independently approved `final-folds.json` table-origin ranges. It proves the
  sole `swingF`/`swingD` writes are defaults `2`/`0`, with one grapple read each;
  no map override writer exists in the retained build.
- The same census proves `t$e[61].mapVersion = 15` is the only writer. The map
  encoder reads it and the decoder rejects `v > 15`, so the native converter can
  use 15 as the current compatibility ceiling.
- Added `audit-out-of-table.js`, which records all ten deliberately unnamed
  literal accesses. They are read-only nested UI/utility accesses, outside the
  classic physics step, map codec, and native-map conversion path; no property
  name was invented and no generated substitution changed.
- Added `audit-dynamic-training-residuals.js`, which classifies all four global
  dynamic brackets as PIXI particle display, renderer timing, or scoreboard
  display code. Their stateful/data-record rewrites remain rejected, but they do
  not block the training simulator or map converter.
- The remaining deobfuscation blockers for training are external evidence or
  implementation work: authenticated target-map capture, server-provided
  `ms.fl` coverage, football host state, imported Box2D CCD parity, and the
  local native-map converter/physics-port backlog.

### 2026-08-04 — Fresh-world episode lifecycle and force-point alignment

- Replaced the episode-boundary `destroyAllBodies()` path with the existing
  fresh-world `PhysicsEngine.reset()`. The unsafe body-by-body teardown API and
  broadphase exception-swallowing monkey patches were removed, so corrupted
  broadphase operations can no longer be silently treated as valid physics.
- The lifecycle choice follows the 2026-07-29 client trace: `novakReset`,
  contact-listener reattachment, and the full `CreateBody`/`CreateFixture` pass
  rebuild world state from serialized bodies (client lines 6996-7237,
  7536-7647, 8313-8325, 8571-8579; `DEOBFUSCATION.md` §31).
- Player movement now calls `ApplyForce(force, body.GetWorldCenter())`, matching
  decoded property indexes 163/164 and the native movement paths documented in
  `DEOBFUSCATION.md` §5 and §35.2.
- Newly dead discs are removed from the live Box2D world after the step while
  their final transforms remain available to observations. This mirrors the
  native next-state rebuild and prevents dead proxies from eventually leaving
  the fixed broadphase AABB during direct post-death engine ticks.
- Regression coverage proves a distinct world per episode, disabled warm
  starting, listener/config/PPM/bounds restoration, map-body/capzone/joint and
  grapple recreation, tick reset, lethal contact behavior across 75 repeated
  71-body resets, and zero angular velocity from movement through an offset
  center of mass. This closes the common reset/broadphase cause tracked by
  #42, #49, #77, #97, #112, and #119, and the force-point mismatch in #146.
