# Native Classic differential validation

This directory is research/validation code, not a production entry point. It
executes the reviewed, pinned original alpha2s `createNewState` and `Physics.step`
spans in a restricted VM and compares them with the RL-local
`createClassicPhysics` core. It does not import the legacy `PhysicsEngine`,
environment, map adapter, or any `bonk-game` module.

## Dependencies

Three independently supplied artifacts are required and SHA-256 checked before
execution:

| Artifact              | Expected SHA-256                                                   | Default / configuration                                           |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `alpha2s.raw.js`      | `e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e` | RL `.deobf/alpha2s.raw.js`, `--raw`, or `BONK_RAW_REFERENCE_FILE` |
| `Box2DModuleGJMod.js` | `0f7645c88f53b51b731819c2f8ee3d9af5040c3c741371f8b1ff82c2074f3a83` | `--box2d` or `BOX2D_REFERENCE_FILE`                               |
| `SafeTrig.js`         | `d1d09e414ba4c16bfb9ce8492f135bbc87b581c364a3b91019c4f93a18557b08` | `--safe-trig` or `SAFETRIG_REFERENCE_FILE`                        |

The original artifacts are not copied into production or committed by this
validation tooling. Public acquisition URLs are recorded in
`src/vendor/PROVENANCE.md` and the pinned reference snapshot. Supplying a path to
a file that happens to live in another checkout is an explicit operator choice;
there is no implicit cross-repository discovery.

Missing paths fail with `BLOCKED` and a nonzero exit. Missing files, changed
hashes, native errors, coverage failures, and comparison mismatches also fail.
There is no environment-based skip and no self-comparison fallback.

## Run

From the repository root:

```sh
npx tsx validation/native/compare-classic-native.cjs \
  --box2d /explicit/path/Box2DModuleGJMod.js \
  --safe-trig /explicit/path/SafeTrig.js \
  --negative-control
```

Optional settings:

- `--raw /explicit/path/alpha2s.raw.js` overrides the RL-local pinned raw path.
- `--ticks 360` selects ticks per scenario (default 360, maximum 3600).
- `--negative-control-only` runs just the fault-detection smoke test; it is not
  native-equivalence evidence and is never a substitute for the full corpus.
- `--out /new/report.json` writes the full report without overwriting a file.

Suggested package scripts for the repository owner (`package.json` is outside
this port's edit scope):

```json
"test:classic": "vitest run tests/unit/classic-physics.test.ts tests/unit/backend.test.ts tests/unit/safe-trig.test.ts",
"test:native-classic": "tsx validation/native/compare-classic-native.cjs --negative-control"
```

For CI, provide the three pinned artifacts as protected CI inputs and expose the
path environment variables before invoking `npm run test:native-classic`. Do not
mark this command `continue-on-error`: absent credentials/artifacts must remain a
visible failed native-validation job, not a green unit-test substitute. A
separate optional job can be triggered only in CI contexts where those inputs
are supplied.

## Focused static-material differential

`compare-classic-materials.cjs` exercises the original and local solvers against
actual static-floor contact with effective fixture friction `-0.3`, restitution
`1.25`, and an in-range control at both quality settings. The default run is 120
ticks per scenario and includes a required `1e-6` x-velocity negative control.
The native map's `fp`/`fricp` sign toggle is kept separate from the directly
signed effective friction supplied to `createClassicPhysics`.

```sh
npx tsx validation/native/compare-classic-materials.cjs \
  --box2d /explicit/path/Box2DModuleGJMod.js \
  --safe-trig /explicit/path/SafeTrig.js \
  --out /new/classic-materials-report.json
```

The report records normalized native material values, native contact-response
samples, per-field errors, and coverage. A run fails if no native contact response
is observed, if signed friction does not produce its tangential impulse, if the
high-restitution/control rebounds do not meet their distinct coverage gates, or
if the negative control is not detected. `--negative-control-only` is only a
fault-detection smoke test, not equivalence evidence.

## Arrow / Death Arrow / VTOL mode differential

`compare-native-modes.cjs` independently executes the same pinned original
`createNewState` / `Physics.step` and compares it only with isolated
`src/core/classic-physics.ts`. It does not use public `PhysicsEngine`, environment
integration, lifecycle reseeding, or self-generated expected trajectories.

The 42-scenario matrix contains eight Arrow families at both `ar` and `ard` and
both quality settings, plus five VTOL families at both quality settings:

- Arrow: fresh-countdown charge/release, simultaneous left/right aiming,
  FFA ownership, disc impact/lethality, team filtering, world impact, seeded
  projectile expiry, and two-player release/ownership.
- VTOL: fresh-countdown directional forces (`vt=0..6`) and five heavy ticks,
  rotated forces/angular propagation, lethal wing/world contact, non-lethal
  wing/world kinematics, and wing/disc plus wing/wing collisions.

Controlled native-state seeds establish the initial input state only; the fresh
charge/release and directional scenarios instead start from native countdown.
Every expected frame comes from the pinned original. Disc/projectile numerics
use absolute tolerance `1e-9`; discrete fields and per-tick death events are
exact. The expiry gate requires the original sequence `fte=2 -> 1 -> 0 -> removed`:
an `fte=0` projectile remains in that output frame and disappears next frame.
Unmet coverage, round rollover, native errors, changed hashes, or mismatches fail.

For contact coverage, a one-step observer decorates the original listener at
registration (including the first world-initialization step), invokes the exact
original callback with its original receiver/arguments, and restores Box2D's
registration method in `finally`. Subsequent ticks observe the active listener
instance directly. The extracted original function spans are unchanged.

Run the complete bounded corpus with a required negative control:

```sh
npx tsx validation/native/compare-native-modes.cjs \
  --box2d .local-artifacts/native-reference/Box2DModuleGJMod.js \
  --safe-trig .local-artifacts/native-reference/SafeTrig.js \
  --negative-control --out /new/native-mode-report.json
```

Use `--group arrow` or `--group vtol` for focused receipts. These tests execute
unconditionally when selected; there is no `runIf` native skip:

```sh
npx vitest run tests/unit/native-mode-harness.test.ts \
  tests/unit/native-mode-arrow.test.ts tests/unit/native-mode-vtol.test.ts
```

The full receipt `native-mode-report-simultaneous-aim-final.json` passes all 42
scenarios: 2,274 ticks, 80,294 comparisons, maximum absolute error 0, and zero
coverage failures or local reseeds. Simultaneous left/right/action2 now applies
both independent native aim adjustments, so `da=0` remains `0`. The negative
control detects the injected `1e-6` projectile x-velocity error. This bounded
evidence is not public-engine, complete-mode, lifecycle, dynamic-map, online, or
bit-parity evidence.

## Sparse option and death-presentation differentials

`compare-classic-sparse.cjs` validates dense/sparse native player IDs, indexed
`balances`, and default radii on a static floor at both quality settings. Its
12-scenario, 120-tick-per-scenario receipt requires contact coverage and a
negative control. It does not claim multi-player sparse team-collision coverage.

```sh
npx tsx validation/native/compare-classic-sparse.cjs \
  --box2d /explicit/path/Box2DModuleGJMod.js \
  --safe-trig /explicit/path/SafeTrig.js \
  --out /new/classic-sparse-report.json
```

`compare-classic-death-pose.cjs` drives one-player lethal-floor contact with
native immediate respawn at q1/q2. It compares death `x`/`y`/`xv`/`yv` against
the original post-solver body state before restoration, separately compares the
restored live disc, requires all four death fields to differ from that restored
state, and detects an injected death-y error.

```sh
npx tsx validation/native/compare-classic-death-pose.cjs \
  --box2d /explicit/path/Box2DModuleGJMod.js \
  --safe-trig /explicit/path/SafeTrig.js \
  --out /new/classic-death-pose-report.json
```

Both runners fail on missing dependencies, changed hashes, native errors,
comparison mismatches, or unmet coverage. Neither imports production consumers
or claims bit parity.

## Scope and assertions

The corpus covers neutral, movement, jump, heavy, input precedence, fly, and
collision behavior at both native quality settings (`q1`: 2/6 iterations and
`q2`: 15/15). Initial state and normalized static fixtures are adapted directly
from the original state. Every in-round tick advances native and local from their
own identical preceding states with identical six-bit inputs.

Positions, linear/angular velocities, angles, and energy use absolute tolerance
`1e-9`; energy and all discrete fields are additionally checked exactly.
Discrete checks include alive, heavy, last-hit ID/timer, and respawn marker.
Reports include per-scenario and aggregate comparison counts and maximum errors.
The optional negative control injects a `1e-6` x-velocity discrepancy and must be
detected for the overall run to pass.

The native countdown simulation gate is mirrored from the pre-step native
state. Result-countdown ticks continue simulating, including the first `fte=90`
result tick after a death. At a native round boundary only, local state is reseeded from the new
native round because round
selection is outside this foundation port. This does not repair in-round local
physics state. The comparator claims neither whole-game equivalence nor bit
parity; it validates the supported static Classic scenarios only.
