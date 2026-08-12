# Physics Fidelity Plan

Make `bonk-rl-env`'s map physics simulation **faithful to bonk.io**, validated
against the deobfuscation record (`docs/DEOBFUSCATION.md`,
`docs/DEOBFUSCATION_FIX_TRACKER.md`)
and (where possible) differential comparison against recorded native-client state.

## Ground truth

All facts below are cited to DEOBFUSCATION §33 (state/encoder/decoder), §34
(render), §35 (player), §38 (fixtures). Facts are separated from assumptions.

### Scale model (P0) — PROVEN, abstraction-only
- `ppm` (default 12) is the **player-disc radius in game units** (lines 174, 637, 984), NOT a px→m conversion.
- Native world = `map px / ppm`; the disc radius = `ppm × scaleRatio` (default scaleRatio 1 → 12 units).
- Our engine uses a **shared divisor `SCALE=30`** for both map bodies (`def.x / this.scale`) and the disc (`ppm / this.scale`). Because both share one divisor, **proportions are exact on any scale** — the ppm-vs-SCALE mismatch is a *naming/abstraction* concern, not a behavioral error, as long as the divisor stays shared.
- **Conclusion:** keep `SCALE` as the shared divisor; **pin the invariant with tests** rather than risk a refactor of the tuned, 267-test-passing engine. Document the abstraction clearly.

### Fixtures (P1) — PROVEN, §33.4
- `density = max(fix.de ?? body.s.de, 0.0001)` (clamped, line 3269).
- `friction`: `fix.fr ?? body.s.fric`; **negative = velocity-independent** (line 3267).
- `restitution`: `fix.re ?? body.s.re`.
- `filter.categoryBits = 2^(f_c+1)` (line 3270).
- `filter.maskBits`: starts at 65535, subtracts a bit per disabled group (lines 3271-3273). **Must agree with the engine's disc category bits** — a calibration item for Phase 4 differential validation.

### Joints (P2) — PROVEN §33.7/33.8, IMPLEMENTED
Native `g` = `b2GearJointDef` on created `ja/jb` with `ratio = r` (7836-7843).
`lpj`/`lsj`/`p` all use `b2PrismaticJointDef` with exact anchor/force
normalization (`plen, pms ÷ ppm`, `mmf *= 17280`, `ms *= 12`,
`fh=0? 0.0001 : 1/period`, Y-flip rv limits, ground `bodyB=-1` anchors use
`+365/250` map-px). The engine's `addJoint` now implements every native joint
type: `d` (fh/dr, authored `len` applied after Initialize, ground-px anchors),
`rv` (lower/upper limits, motor speed/torque), `lpj`/`lsj`/`p` (prismatic:
world axis from `angle`, `referenceAngle = -bodyA.angle` for lpj/lsj, #281
symmetric ±length fallback, motor force), `g` (gear ratio with revolute/
prismatic referent validation), and ground joints (`bodyB = -1`, map-px
anchors). `lsj` runs on the prismatic branch per the §33.8 recipe — the
bundled Box2D port has no dedicated `b2LineJoint`. Verified by
`physics-fidelity-p2.test.ts` and the P4 joint exact-match gate.

### Map physics settings (P3) — pq PROVEN, gd RE-CLASSIFIED
- `pq` → solver iterations: native low **2/6**, high **15/15** (lines 260, 634-635);
  implemented per-map in P3 (engine resolves `physicsQuality` → velocity/
  position iteration counts; explicit `physics.solverIterations` /
  `physics.positionIterations` config wins). Port note: the bundled Box2D
  `Step(dt, iterations)` ignores the third argument, so only the velocity
  count reaches the solver; the position count is resolved and asserted as
  the engine contract, and the gap is tracked for the P4 differential gate.
- `gd` → **RE-CLASSIFIED (2026-08-11)**: serialized-only in the 2026-07-29
  build. The runtime enforces gravity `(0, 20)` at every round start
  (`if (GetGravity().y != 20) SetGravity(new b2Vec2(0, 20))`, pretty
  7238-7240) and the source audit found **no gd application site** — gd is
  read only by the map decoder/sanitizer/serializer and the editor. P3
  therefore exposes `gd` on `MapDef.settings` (sanitized ≥ 2, per the native
  sanitizer) but does NOT apply it; the engine keeps config/default gravity.
- Death circle = 850 map px from map center, ppm-independent (lines 1557-1563) — engine already correct.

### Map settings runtime gating (P3b) — IMPLEMENTED (2026-08-12)
The remaining per-map settings now gate runtime behavior, all read from
`MapDef.settings` (the sanitized native `s` object) and cited to the readable
2026-07-29 artifact:
- `fl` (flipped) — the move-force base is native **12**, **20 when `fl`**
  (`state.ms.fl ? 20 : 12`, §11 720-730/935/4055). The port keeps its tuned
  base (`MOVE_FORCE` = 30, #234 ascent invariant) and applies the same ratio
  (`MOVE_FORCE_FLIP_MULTIPLIER = 20/12`) as `flippedMoveForce`, preserving the
  native proportion on any scale (P0 abstraction rule). Engine option
  `flipped` / `flippedMoveForce`; env forwards `settings.fl`.
- `nc` (no collision) — all disc-disc contacts disabled (`contact.SetEnabled
  (false)` when `physics.nc`, readable 1300-1303; §Key Collision Rules 5).
  The engine's existing `setNoCollide` disc-filter path is now wired from
  `settings.nc` (previously the env read the nonexistent `physics?.nc` and
  silently ignored the map setting).
- `re` (respawning) — a disc that died respawns **immediately at its spawn
  point** with cleared grapple and fresh velocity (`x=sx; y=sy; xv=sxv;
  yv=syv; ni=true; delete swing`, readable 8595-8606); cap-zone eliminations
  (death type 3) stay permanent (§alive rule, readable 8463). Engine option
  `respawnEnabled` + `respawnPlayer`; env forwards `settings.re`. The port
  does not model spawn velocity, so respawns re-spawn at rest; `a1a` is not
  reset (the native branch does not touch it). Fail-safe: a spawn point
  outside the OOB death circle detaches instead of churning every tick.
- Config override symmetry: the `flipped` / `respawnEnabled` environment
  config keys win over the map settings, mirroring `noCollide` vs
  `settings.nc`.

### Differential validation (P4) — IMPLEMENTED (2026-08-12)
- **Capture harness** (`Webscripts/rl-trace-capture.user.js` +
  `src/core/differential/capture-recorder.ts`): records per-tick native disc
  state (x,y,xv,yv,a,av,a1,a2,a1a,team,ds; LIVE_STATE_EXTRACTION §9.4) with
  alive == presence (§9.2) into a versioned `NativeTrace` JSON for offline
  replay. The same mapping is unit-tested against deterministic fixture state.
- **Replay comparator** (`src/core/differential/replay-comparator.ts`):
  rebuilds the traced world via the normal adapter→environment path, re-seeds
  players at their recorded spawns, replays the recorded Discrete(64) inputs
  per tick, and diffs per-tick `getPlayerState` against the recorded disc
  kinematics within per-field tolerances (position px, velocity px/s, angle
  rad, angular vel rad/s). Coordinate reconciliation (§9.5) makes the units
  1:1, so diffs are compared directly.
- **Fixture/joint exact-match gates** (`src/core/differential/exact-match-gates.ts`):
  verify the engine's built fixtures reproduce the traced map's authored
  density/friction/restitution (§33.4) and that every authored joint was
  created with the authored params (§33.8).
- Validation: `physics-fidelity-p4.test.ts` (7 tests) — trace round-trip;
  fixture gate on the bundled Simple 1v1 map; joint gate on the bundled WDB
  No-Mapshake map (ground prismatic joints); a recorded neutral run replays
  within tight tolerance (worst dx/dy < 1e-6); a perturbed trace fails the
  same run (gate discriminates); native-absent ticks surface as mismatches.
- What still needs a live capture: the harness/comparator are fully validated
  offline, but confirming the *native client actually produces* trajectories
  within these tolerances requires recording a real match with
  `rl-trace-capture.user.js` and replaying it (documented in
  `docs/DIFFERENTIAL_VALIDATION.md`).

## Milestones

| # | Scope | Deliverable | Verification |
|---|-------|-------------|--------------|
| **P0** | Scale/ppm model | Audit doc + shared-divisor invariant tests; no risky refactor | unit test: body & disc proportions exact across scale; spacing/radius invariants |
| **P1** | Fixture fidelity | density clamp ≥0.0001, friction polarity, restitution fallback, mask-bit spec | fixture-level unit tests asserting exact numbers from §33.4 |
| **P2** | Joint model | implement `rv` limits/motor, `d` fh/len, `lpj/lsj/p` prismatic params, gear `g`, ground joints | joint invariant tests per §33.7 formulas |
| **P3** | Map physics settings | per-map `pq`→solver iters (2/6 low, 15/15 high), `gd`→exposed on MapDef.settings (runtime application deferred: native enforces gravity 20, pretty 7238-7240) | engine-level tests: pq changes solver behavior; gd does NOT override gravity (enforcement parity) |
| **P3b** | Settings runtime gating | `fl`→flipped move-force base (×20/12), `nc`→disc-disc no-collide, `re`→immediate respawn at spawn point (type-3 deaths permanent) | engine/env-level tests: flipped force magnitude; nc masks drop player bits + pass-through behavior; OOB death respawns vs stays dead; type-3 permanence |
| **P4** | Differential validation | capture harness (record native snapshots) + replay comparator + fixture/joint exact-match gates | comparator diff ≤ tolerance (validated: neutral-run replay ≈ 0, perturbed trace fails); gates pass on bundled maps; live capture workflow documented |
| **P5** | Docs + gating | update DEOBFUSCATION_FIX_TRACKER with ✅/❌/partial per item; every claim cited | PR review gate |

## Dependency order
P0 → P1 → P4(capture harness) → P2 → P3 → P3b → P4(comparison) → P5.
P4-capture must precede P2 so joint anchors are verified against real native
state; P1 is independent and can proceed first.

## Documentation gating (P5) — IMPLEMENTED (2026-08-12)

Final docs pass over `DEOBFUSCATION_FIX_TRACKER.md` and this plan:

- Every milestone now carries its delivery state in the plan (P0/P1 PROVEN,
  P2/P3/P3b/P4 IMPLEMENTED, P5 this pass) and the milestone table rows reflect
  what shipped.
- `DEOBFUSCATION_FIX_TRACKER.md` per-item statuses were refreshed to the
  post-P0–P4 state: H1 marked converter-implemented (exporter emits flat
  `bodies[]`; adapter prefers it with `physicsBodies` fallback —
  `physicsFixtures`/`physicsShapes` unread), H5 marked partially fixed with
  `lsj` ⚠️ blocked on the port (prismatic substitute recipe in place), C4
  `nc` row updated with the P3b map-settings wiring, H3 spawns noted for `re`
  respawn consumption, and the header date/capture-status section updated.
- Every claim carries its source citation (DEOBFUSCATION § section / pretty or
  readable artifact line ranges); the Fix Log entries (P3, P4, P3b) hold the
  chronological record with test counts and verification commands.

The PR review gate is the remaining verification for this milestone.