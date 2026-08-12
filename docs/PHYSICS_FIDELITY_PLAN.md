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

### Joints (P2) — PROVEN, §33.7/33.8
Native `g` = `b2GearJointDef` on created `ja/jb` with `ratio = r` (7836-7843).
`lpj`/`lsj`/`p` all use `b2PrismaticJointDef` with exact anchor/force
normalization (`plen, pms ÷ ppm`, `mmf *= 17280`, `ms *= 12`,
`fh=0? 0.0001 : 1/period`, Y-flip rv limits, ground `bodyB=-1` anchors use
`+365/250` map-px). Engine today: only `distance/rv/lpj`; no `g`, no `lsj`, no `p`,
no ground joints.

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
  Runtime gd application is deferred to the P4 differential gate, which can
  confirm or refute live host-side behavior.
- `re/nc/fl` gating — exposed via `MapDef.settings` in P3; runtime gating
  (nc → no-collide, fl → flipped move-force base) is a follow-up (P3b).
- Death circle = 850 map px from map center, ppm-independent (lines 1557-1563) — engine already correct.

## Milestones

| # | Scope | Deliverable | Verification |
|---|-------|-------------|--------------|
| **P0** | Scale/ppm model | Audit doc + shared-divisor invariant tests; no risky refactor | unit test: body & disc proportions exact across scale; spacing/radius invariants |
| **P1** | Fixture fidelity | density clamp ≥0.0001, friction polarity, restitution fallback, mask-bit spec | fixture-level unit tests asserting exact numbers from §33.4 |
| **P2** | Joint model | implement `rv` limits/motor, `d` fh/len, `lpj/lsj/p` prismatic params, gear `g`, ground joints | joint invariant tests per §33.7 formulas |
| **P3** | Map physics settings | per-map `pq`→solver iters (2/6 low, 15/15 high), `gd`→exposed on MapDef.settings (runtime application deferred: native enforces gravity 20, pretty 7238-7240) | engine-level tests: pq changes solver behavior; gd does NOT override gravity (enforcement parity) |
| **P4** | Differential validation | capture harness (record native snapshots) + replay comparator | comparator diff ≤ tolerance; fixture/joint exact-match gates |
| **P5** | Docs + gating | update DEOBFUSCATION_FIX_TRACKER with ✅/❌/partial per item; every claim cited | PR review gate |

## Dependency order
P0 → P1 → P4(capture harness) → P2 → P3 → P4(comparison) → P5.
P4-capture must precede P2 so joint anchors are verified against real native
state; P1 is independent and can proceed first.