# Differential Validation — P4

How `bonk-rl-env`'s physics is validated against the real bonk.io client.

## Goal

Record what the real client does at runtime (per-tick disc kinematics, plus the
map and settings) and compare it, tick by tick, against what the local
`PhysicsEngine` produces for the same map, same spawns, and same inputs. The
comparison gates on per-field tolerances and on exact fixture/joint
reproduction.

Grounding: `docs/DEOBFUSCATION.md` (fixtures §33.4, joints §33.8) and
`docs/LIVE_STATE_EXTRACTION.md` (exported disc field set §9.4, alive == presence
§9.2, coordinate reconciliation §9.5).

## Trace format

A `NativeTrace` is a versioned JSON recording of one round:

```
{
  "schema": "bonk.rl.env.native-trace",
  "version": 1,
  "tps": 30,
  "map":   <raw exported map (mapexporter output)>,
  "settings": { "re": false, "nc": false, "pq": 1, "gd": 25, "fl": false },
  "players": [ { "id": 0, "team": 1 }, { "id": 1, "team": 2 } ],
  "spawns":  [ { "id": 0, "x": -100, "y": -25 }, { "id": 1, "x": 100, "y": -25 } ],
  "ticks": [
    {
      "t": 0,
      "inputs": [0, 0],                 // optional Discrete(64) per player
      "discs": [
        { "id": 0, "x": -100, "y": -25, "xv": 0, "yv": 0, "a": 0, "av": 0,
          "a1": false, "a2": false, "a1a": 1000, "team": 1, "ds": 0, "alive": true },
        null                            // absent disc == dead/respawned-out
      ]
    }
  ]
}
```

The `discs[]` array is index-aligned by player id: `discs[i]` is the state of
player `i`, `null` means the native client dropped the disc that tick (the
alive rule from LIVE_STATE_EXTRACTION §9.2). The disc fields are exactly the
serialized set from §9.4.

## Capture

Install `Webscripts/rl-trace-capture.user.js` (userscript, or add it alongside
`capture-init.js` / `rl-live-bridge.js` via Playwright `addInitScript`):

```js
window.__bonkRlTrace.startRecording();   // begin at round start
// ... play the round ...
window.__bonkRlTrace.stopRecording();
window.__bonkRlTrace.downloadTrace();    // saves bonk-native-trace.json
```

The harness snapshots `__bonkExportState` on every tick boundary, converts the
disc array through the same field mapping as
`src/core/differential/capture-recorder.ts`, and rebases the per-round tick via
`rc`/`fig` (the same rebase the RL bridge uses, §9.1). For an exact replay, also
record the per-player Discrete(64) inputs (the harness's `inputs` field; not
available from the serialized disc alone — the network `recvInputs` hook is the
authoritative source when needed).

## Replay + compare

```ts
import { compareTrace, verifyFixtureGates, verifyJointGates } from '../src/core/differential';
const verdict = compareTrace(trace, {
  tolerances: { position: 0.5, velocity: 1.0, angle: 0.05, angularVelocity: 0.5 },
});
// verdict.pass, verdict.worst, verdict.perTick[...]
```

The comparator (`replay-comparator.ts`):

1. normalized the traced map through the same adapter path the environment uses,
2. builds a fresh `BonkEnvironment` and re-seeds each traced player at its
   recorded spawn (`SetXForm`, zeroed velocity),
3. replays the recorded inputs per tick (or a neutral input when a trace has
   none) and steps the world,
4. reads each player's `getPlayerState()` and diffs it against the recorded
   disc kinematics in map units (1:1 per §9.5).

Verdict: **PASS** only when every compared tick is inside all per-field
tolerances. A disc the native trace reports missing but the engine keeps alive
(counted per tick) is a mismatch — the engine must agree about deaths too.

## Exact-match gates

Independent of trajectories, `exact-match-gates.ts` verifies the static world:

- **Fixtures**: every normalized body's built shapeDef density/friction/
  restitution equals the traced map's authored values (§33.4 clamps apply:
  static → 0 density, dynamic → 0.0001 floor or 1.0 default, `f_p` → 0
  friction, `-1`/unset restitution → 0.8).
- **Joints**: every authored joint must have been created with the authored
  core params (revolute limits/motor, distance length/spring, prismatic
  translation limits/motor force, gear ratio/referents) (§33.8).

## Offline validation (this repo)

`tests/integration/physics-fidelity-p4.test.ts` validates the whole pipeline
deterministically without a live match:

- trace schema round-trip + rejection of wrong schema/version,
- fixture gate passes on the bundled `bonk_Simple_1v1_123.json`,
- joint gate passes on the bundled `bonk_WDB__No_Mapshake__716916.json`
  (ground-anchored prismatic joints),
- a **recorded** neutral-input run replays with tight tolerance (worst
  position error < 1e-6 map px) — proving the comparator compares real engine
  output,
- a **perturbed** trace (every disc shifted +3 px) fails the same run — proving
  the gate discriminates instead of passing vacuously,
- native-absent ticks surface as engine-alive mismatches.

## Steps for a live validation run

1. Record a trace from a real (or recorded-match replay) bonk.io round.
2. Drop the JSON where the comparator can read it (or paste inline).
3. Run `compareTrace` and read `verdict.worst` / `verdict.perTick`.
4. Investigate any tick outside tolerance — either an engine fidelity gap
   (fix + re-audit) or a trace artifact (missing inputs, wrong map).