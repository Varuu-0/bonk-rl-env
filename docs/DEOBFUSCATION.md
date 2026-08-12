# bonk.io Deobfuscation Findings

Reverse engineering findings from analyzing the obfuscated `alpha2s.js` (bonk.io's main game code, ~2.7MB).

**Date:** July 25, 2026 (current artifact and audit baseline verified August 2, 2026)
**Source URL:** `https://bonk.io/js/alpha2s.js`
**Method:** Runtime constant table inspection + static source pattern matching
**Verification:** Historical findings were verified against the July 2026 live
runtime; the current local artifact, table, AST coverage, and fold proofs were
re-verified against the retained 2026-07-29 build on August 2, 2026.

---

## Verification Summary

> **Update (2026-07-29):** §31 resolved all six formerly-unresolved systems
> (`fz`, `cf`, `fr`, `bu`, `sk`, multi-fixture mass) against the 2026-07-29
> build; see §31 and the tracker LOWER table.
>
> **Current authority (2026-08-02):** §38 records the complete retained-artifact
> inventory, exact deobfuscation scope, residual census, and correction matrix.
> When earlier chronological research notes disagree with §§31-38, the later
> source-verified correction is authoritative.
>
> **Update (2026-08-04):** §39 records the stateful setup-decoder fold
> (`t8H`/`n6e`): all 791 formerly-skipped AMD-body calls are folded to the
> decoder's steady value `73` after a structural two-phase proof and two fresh
> preamble boots. §38 counts are updated accordingly.

All findings were verified by checking each claim against the live bonk.io runtime (`M$QCc` constant table) and the `alpha2s.js` source code.

| Claim | Status | Evidence |
|-------|--------|----------|
| Constant table: all 50 indices | ✅ Verified | All 50 strings match expected values at claimed indices |
| Gravity Y = 20 | ✅ Verified | `new t$e[1](0,20)` found 4×, `GetGravity().y != 20` check, `this[...[620]]=20` default |
| Solver iterations: 2/6 (low), 15/15 (high) | ✅ Verified | `z0M[291]=2; z0M[554]=6;` and `z0M[291]=15; z0M[554]=15;` when `pq==2` |
| Warm starting = false | ✅ Verified | `[132]](false)` — `SetWarmStarting(false)` |
| Step() takes 3 args | ✅ Verified | `world.Step(w_c(...), velIter, posIter)` — 2 calls found, both with 3 args |
| ClearForces called after Step | ✅ Verified | `[328]]()` follows both `[327]](...)` calls |
| Map defaults: ppm=12, gd=25, pq=1, re=false, nc=false, fl=false | ✅ Verified | Blank map: `{s:{re:false,nc:false,pq:1,gd:25,fl:false},physics:{...ppm:12},...}` |
| Input bits: Left=1, Right=2, Up=4, Down=8, Heavy=16, Special=32 | ⚠️ Partially verified | Constant table has `up`=302, `down`=303, `left`=304, `right`=305. Source uses boolean properties (`inputState.left`, etc.), NOT packed integers at runtime. The packed integer format is only in network packets (DemystifyBonk). |
| Default body: fric:0.3, re:0.8, de:0.3 | ✅ Verified | Found in source: `fric:0.3,fricp:false,re:0.8,de:0.3` |
| Default fixture: fr:0.3, re:0.8, de:0.3, f:5209260 | ❌ Not found in source | `getNewFixture` function not in source (may be inlined by obfuscator). Default body values confirmed. |
| Default box shape: w:10, h:40 | ❌ Not found in source | Shape constructors not found (may be inlined). |
| DemystifyBonk map format fields exist at runtime | ✅ 107/109 verified | `authid` and `frc` not found in constant table (see corrections below) |

### Corrections from Verification

1. **`authid` not in constant table** — DemystifyBonk documents `authid` as a map metadata field, but it does not appear in the `M$QCc` constant table. It may be stored as a numeric property accessed directly, or it may have been renamed in a newer game version. The map metadata object still has an `authid` slot (visible in the blank map default: `authid:-1`), but it's written as a string literal, not via the constant table.

2. **`frc` not in constant table** — DemystifyBonk documents `frc` (friction category) as a fixture property, but it does not appear in the `M$QCc` constant table. The `frc` match in the raw source was a false positive (part of a URL-encoded string). This field may not exist in the current game version, or may be accessed differently.

3. **Inputs are NOT packed integers at runtime** — The game decodes the network packet's packed `i` integer into boolean properties (`left`, `right`, `up`, `down`, `heavy`, `special`) on the input state object. The source shows patterns like `if(inputState[discIndex].left)` and `if(inputState[discIndex].right)`, not `if(packedInput & 1)`. The packed integer format is only used in the network protocol (DemystifyBonk's Packets.md is correct about that).

4. **`m` index is 125, not 124** — The constant table has `"m"` at index 125, not 124 as originally claimed. Index 124 is `"mm"`. This was a transcription error.

5. **Default fixture/shape constructors not found** — The `getNewFixture`, `getNewBoxShape`, `getNewCircleShape`, `getNewPolyShape` function names from DemystifyBonk are NOT present in the current `alpha2s.js`. They may have been inlined by the obfuscator. The default *body* values (`fric:0.3, re:0.8, de:0.3`) were confirmed. The default fixture values (`fr:0.3, re:0.8, de:0.3, f:5209260`) and default shape values (`w:10, h:40, r:25`) could not be independently verified.

---

## Selected Navigation

1. [Obfuscation Architecture](#1-obfuscation-architecture)
2. [Physics Constants](#2-physics-constants)
3. [World Creation](#3-world-creation)
4. [Physics Step](#4-physics-step)
5. [Player Movement](#5-player-movement)
6. [Grapple Mechanics](#6-grapple-mechanics)
7. [Game State Structure](#7-game-state-structure)
8. [Constant Table Index](#8-constant-table-index)
9. [Map Format](#9-map-format)
10. [Comparison to bonk-rl-env](#10-comparison-to-bonk-rl-env)
38. [Current Deobfuscation Inventory](#38-current-deobfuscation-inventory-2026-08-02)

---

## 1. Obfuscation Architecture

### Global Object: `B3jF8`

The entire game is wrapped under a global object `B3jF8` (the name may change between obfuscation runs). It contains:

- **`B3jF8.w_c()`** — Control flow flattening dispatcher. Returns one of its arguments based on internal state. Used to obscure function arguments:
  ```js
  B3jF8.w_c = function() {
    return typeof B3jF8[239984].u2JDgBs === 'function'
      ? B3jF8[239984].u2JDgBs.apply(B3jF8[239984], arguments)
      : B3jF8[239984].u2JDgBs;
  };
  ```
  When you see `k7V.w_c(A, B, C)`, the actual return value is one of A/B/C depending on runtime state, not necessarily the first argument.

- **`B3jF8.g7y()`** — Another dispatcher function (same pattern as `w_c`).

### Constant Table: `M$QCc` (runtime) / accessed as `t$e`, `z0M`, `X1w`, etc.

A flat array of ~1724 string constants stored at `window.M$QCc`. All property names, method names, and string literals are stored here and accessed by numeric index:

```js
// Example: accessing b2World constructor
// mqcc[19] = "b2World"
// In obfuscated code: new t$e[23](gravity, doSleep)
//   where t$e is a local alias for the module containing Box2D classes
```

Local variables (`z0M`, `X1w`, `l3z`, `E82`, etc.) are per-function aliases that prepend `arguments` at index 0:

```js
// Deobfuscated pattern:
var z0M = [arguments];
// z0M[0] = arguments (the function's arguments object)
// z0M[2] = constant table reference
// z0M[0][0] = arguments[0] (typically the game state)
// z0M[0][4] = arguments[4] (typically game settings)
```

### Box2D Module: `t$e`

The Box2D-derived physics library is loaded as the external AMD dependency
`physics/box2dweb/Box2DModuleGJMod`, not bundled into `alpha2s.js` itself
(2026-07-29 readable bundle line 2435). The client aliases that dependency
through `t$e`:
- `t$e[1]` = `b2Vec2` constructor
- `t$e[23]` = `b2World` constructor

---

## 2. Physics Constants

These are hardcoded values extracted from the obfuscated source. **These are the ground truth for bonk.io physics.**

### Gravity

| Property | Value | Evidence |
|----------|-------|----------|
| Gravity X | 0 | `new t$e[1](0, 20)` — b2Vec2(0, 20) |
| Gravity Y | **20** | Same. Also: `if(world.GetGravity().y != 20) { world.SetGravity(new b2Vec2(0, 20)); }` |
| Default gravity (constructor) | **20** | `this[...[620]]=20` — gravity property default |
| Default ppm (constructor) | **12** | `this[...[46]]=12` — ppm property default |

> **bonk-rl-env uses gravity Y=10. The real value is 20.**

### Solver Iterations

| Setting | Velocity Iterations | Position Iterations | Condition |
|---------|--------------------|--------------------|-----------|
| Low quality (default) | **2** | **6** | `pq != 2` (physics quality ≠ "high") |
| High quality | **15** | **15** | `pq == 2` (physics quality = "high") |

**Evidence:**
```js
// Deobfuscated:
if (arguments[0].physics.pq == 2) {
  velIter = 15;  // z0M[291]=15
  posIter = 15;  // z0M[554]=15
}
world.Step(w_c(arguments[3], arguments[5], 1), velIter, posIter);
// Also found literal call: world.Step(w_c(dt, 1), 2, 6)
```

> **bonk-rl-env uses 5 for both iterations. The real values are 2/6 (low) or 15/15 (high).**

### TPS (Ticks Per Second)

Not found as an explicit constant in `alpha2s.js`. The game's tick rate is governed by the server (30 TPS based on network protocol analysis — input packets include a frame number, and the game processes one physics step per frame). The `w_c(dt, ?, 1)` call to `world.Step()` suggests the dt argument is selected from control flow, with `1` being a candidate (meaning 1 frame per step, i.e., 1/30s if TPS=30).

### PPM (Pixels Per Meter / Player Radius)

| Property | Value | Meaning |
|----------|-------|---------|
| Default ppm | **12** | Player disc radius in game units |
| Usage | `this.scaleRatio * o69.physics.ppm` | Multiplied by a scale ratio to get the actual circle shape radius |

> **bonk-rl-env uses SCALE=30 as a pixel-to-meter conversion. The real `ppm` (default 12) is the player radius in game units, not a conversion factor.**

### Warm Starting

| Property | Value | Evidence |
|----------|-------|----------|
| Warm starting | **false** | `world.SetWarmStarting(false)` — `mqcc[132] = "SetWarmStarting"` |

> This means Box2D does NOT use warm starting (contact forces are not carried over between steps).

---

## 3. World Creation

### Constructor

```js
// Deobfuscated:
state.world = new b2World(new b2Vec2(0, 20));
state.world.SetWarmStarting(false);
state.world.SetContactListener(contactListener);
```

**Obfuscated source:**
```js
z[z0M[2][2]] = new t$e[23](new t$e[1](0, 20));
z[z0M[2][2]][z0M[2][132]](false);  // SetWarmStarting(false)
z[z0M[2][2]][z0M[2][182]](z[z0M[2][133]]);  // SetContactListener(listener)
```

### Gravity Enforcement

The game checks and enforces gravity on every step:
```js
if (world.GetGravity().y != 20) {
  world.SetGravity(new b2Vec2(0, 20));
}
```

This suggests gravity can be overridden by map settings (`gd` field in map settings), but defaults to 20.

### Contact Listener

A contact listener is set on the world (`SetContactListener`). The listener (`z[z0M[2][133]]`) is a closure that handles:
- Cap zone detection (sensor overlaps)
- Lethal surface collisions
- Collision events for scoring

---

## 4. Physics Step

### Step Call

```js
// Deobfuscated:
world.Step(w_c(dt, ?, 1), velIter, posIter);
world.ClearForces();
```

**Obfuscated source:**
```js
z0M[16][z0M[2][327]](k7V.w_c(z0M[0][3], z0M[0][5], 1), z0M[291], z0M[554]);
// z0M[16] = world
// z0M[2][327] = "Step"
// z0M[2][328] = "ClearForces" (called immediately after)
```

### Step Arguments

| Argument | Variable | Meaning |
|----------|----------|---------|
| dt | `w_c(arguments[3], arguments[5], 1)` | Time step. `w_c` picks one of three values based on control flow. `arguments[3]` and `arguments[5]` come from the step function caller. The literal `1` suggests 1 frame. |
| velocityIterations | `z0M[291]` | 2 (low quality) or 15 (high quality) |
| positionIterations | `z0M[554]` | 6 (low quality) or 15 (high quality) |

### Physics Quality Branch

```js
// Deobfuscated:
if (physicsQuality == 2) {  // "High" quality setting
  velIter = 15;
  posIter = 15;
}
```

The map setting `pq` (physics quality) controls solver iterations:
- `pq == 1` (default "Low"): velIter=2, posIter=6
- `pq == 2` ("High"): velIter=15, posIter=15

### Multiple Step Calls

Two separate `world.Step()` calls were found in the source, suggesting the game may step the world in different contexts (e.g., host simulation vs. client replay):

1. **Main step** (host): `world.Step(w_c(args[3], args[5], 1), velIter, posIter)` — uses variable iterations
2. **Secondary step**: `world.Step(w_c(args[3], 1), 2, 6)` — uses literal iterations (always 2/6)

---

## 5. Player Movement

### Input Bits

Confirmed from DemystifyBonk `Packets.md` — these are the **network packet** bit values:

| Bit | Value | Action |
|-----|-------|--------|
| 0 | 1 | Left |
| 1 | 2 | Right |
| 2 | 4 | Up |
| 3 | 8 | Down |
| 4 | 16 | Heavy |
| 5 | 32 | Special (Grapple/Arrow) |

> **Important:** These packed integers are only used in the network protocol. At runtime, the game decodes them into boolean properties on the input state object. The constant table contains `up`=302, `down`=303, `left`=304, `right`=305. The source shows patterns like `if(inputState[discIndex].left)` and `if(inputState[discIndex].right)`, NOT `if(packedInput & 1)`.

### Force Application

Player movement uses `body.ApplyForce(forceVector, body.GetWorldCenter())`:

```js
// Deobfuscated:
if (bodyType == "disc" && inputSettings.moveEnabled ||
    bodyType == "arrow" && inputSettings.specialEnabled) {
  body.ApplyForce(forceVector, body.GetWorldCenter());
}
if (bodyType == "phys" && inputSettings.moveEnabled) {
  body.ApplyForce(forceVector, body.GetWorldCenter());
}
```

**Obfuscated source:**
```js
if (X1w[97].getType() == "disc" && X1w[29].input[X1w[4][71]] ||
    X1w[97].getType() == "arrow" && X1w[29].input[X1w[4][64]]) {
  X1w[97][X1w[4][163]](X1w[52], X1w[97][X1w[4][164]]());
  // [163] = "ApplyForce", [164] = "GetWorldCenter"
}
```

### Force Vector Construction

The force vector (`X1w[52]`) is constructed from input directions:
```js
// One assignment found:
X1w[52] = new t$e[1](inputData.x, inputData.y);  // b2Vec2(forceX, forceY)
```

The exact force magnitude was not isolated due to control flow obfuscation (`w_c`), but the force is applied as a `b2Vec2` constructed from input direction data.

### Player Disc Radius

Player discs are circle shapes with radius derived from `ppm`:
```js
// Deobfuscated:
var radius = this.scaleRatio * state.physics.ppm;
// Used when creating b2CircleShape for joints/rendering
```

The `scaleRatio` is a per-body property that scales the base `ppm` value.

### Heavy State

No string "heavy" was found in the constant table. The heavy state likely uses a different internal name (possibly a numeric flag on the disc object). The `ApplyForce`/`ApplyImpulse` calls suggest heavy state modifies the force/mass relationship rather than using a separate code path.

### Arrow/Kick Mechanics (ApplyImpulse)

Arrows and kicks use `body.ApplyImpulse(impulseVector, anchorPoint)`:
```js
// Deobfuscated:
body.ApplyImpulse(impulseVec, worldCenter);
```

Multiple `ApplyImpulse` calls were found, handling "left", "right", and "both" kick directions.

---

## 6. Grapple Mechanics

### Grapple Function: `doGrapple`

A method named `doGrapple` was found:
```js
doGrapple(Q0C, H_V, C$6, T7_) {
  var o1h = [arguments];
  o1h[2] = M$QCc;  // constant table
  o1h[3] = 500;     // ??? (possibly max grapple distance or timeout)
  o1h[4] = 4;       // ??? (possibly frequency or iteration count)
  o1h[6] = 3;       // ??? (possibly damping or joint type)
  ...
}
```

### Grapple-Related Constants

| Constant Table Index | String | Notes |
|----------------------|--------|-------|
| 309 | `noGrapple` | Fixture flag — if true, grapple doesn't attach |
| 317 | `innerGrapple` | Fixture flag — allows grapple from inside |
| 1000 | `grappleMapStrings` | ??? |
| 1003 | `randomArrayGrapple` | ??? |
| 1099 | `quick_grapple` | Quick play mode identifier |
| 1615 | `doGrapple` | Method name for grapple execution |

No `grappleMultiplier` string was found in the constant table, suggesting the multiplier is a numeric fixture property accessed by index rather than name.

---

## 7. Game State Structure

### Step Function Arguments

The physics step function receives arguments in this order:

| Argument Index | Variable | Content |
|---------------|----------|---------|
| 0 | `arguments[0]` / `z0M[0][0]` | Game state object |
| 3 | `arguments[3]` / `z0M[0][3]` | dt/timestep (passed to `world.Step`) |
| 4 | `arguments[4]` / `z0M[0][4]` | Game settings (contains `.map`) |
| 5 | `arguments[5]` / `z0M[0][5]` | Unknown (also passed to `w_c` for dt) |

### Game State Object

The per-tick game state (`arguments[0]`) contains:

| Field | Constant Table Index | Type | Notes |
|-------|---------------------|------|-------|
| `physics` | 43 | Object | Bodies, fixtures, shapes, joints, ppm, grav, bw, bh |
| `discs` | 41 | Array | Player disc objects (position, velocity, team, etc.) |
| `discDeaths` | 42 | Array | Death events |
| `capZones` | 98 | Array | Capture zone states |
| `mm` | 124 | Object | Map metadata |
| `seed` | — | Number | RNG seed |
| `scores` | — | Array | Team scores |
| `players` | — | Array | Player info |
| `world` | 2 | Object | b2World instance |
| `fte` | 4 | Number | Frames to end |
| `ftu` | 3 | Number | Frames to update |
| `shk` | — | — | Shake vector |
| `projectiles` | — | Array | Arrow projectiles |
| `rc` | — | — | Round count |
| `rl` | — | Number | Round length |
| `s` | — | Object | Map settings (re, nc, pq, gd, fl) |

### Outgoing State (created each tick)

```js
// Deobfuscated:
state[outputKey] = {
  discs: discArray,
  shakeVectorThisStep: shakeVector,
  soundsThisStep: soundArray,
  capEvent: capEventFlag,
  teamGoalEvent: goalEvent,
  inputState: arguments[0].inputState,
  gameSettings: arguments[4],
  swingCollideDestroyEvents: destroyEvents
};
```

### Game Settings Object (`arguments[4]`)

Contains:
- `.map` — Full decoded map definition (with `physics`, `spawns`, `capZones`, `m`, `s`)
- `.ga` — Game engine ("b" for bonk/classic, "f" for football)
- `.mo` — Mode ("b", "ar", "sp", "v", "bs", "ard", "f")
- `.wl` — Win/lose rounds
- `.q` — Quick play flag
- `.tl` — Team lock
- `.tea` — Teams enabled
- `.bal` — Balance array

### Disc Object Fields

| Field | Description |
|-------|-------------|
| `x`, `y` | Current position |
| `sx`, `sy` | Spawn position |
| `xv`, `yv` | Velocity |
| `sxv`, `syv` | Spawn velocity |
| `a` | Angle |
| `av` | Angular velocity |
| `team` | Team (0=spec, 1=FFA, 2=red, 3=blue, 4=green, 5=yellow) |
| `fn` | Fixture name? |
| `fz` | Force zone |
| `a1a` | Arrow angle accumulator |
| `a1` | Arrow state |
| `lhid` | Last hit ID |
| `lht` | Last hit time |
| `ds` | Disc state |
| `da` | Disc angle |
| `vt` | ??? |
| `a2` | Secondary arrow state |
| `ni` | ??? |

### Disc Death

Disc death events are named `"discDeath" + Math.floor(Math.random() * N)`:
```js
c13 = "discDeath" + Math.floor(Math.random() * I6d);
// I6d = w_c(2, 3, 12, 4, 1) — one of these values
```

---

## 8. Constant Table Index

Key entries in the runtime constant table (`M$QCc`, 1724 entries):

### Box2D Classes

| Index | String |
|-------|--------|
| 11 | `b2Vec2` |
| 14 | `b2BodyDef` |
| 16 | `b2Body` |
| 17 | `b2FixtureDef` |
| 18 | `b2Fixture` |
| 19 | `b2World` |
| 23 | `b2PolygonShape` |
| 24 | `b2CircleShape` |

### Box2D Methods

| Index | String |
|-------|--------|
| 132 | `SetWarmStarting` |
| 163 | `ApplyForce` |
| 164 | `GetWorldCenter` |
| 184 | `GetGravity` |
| 185 | `SetGravity` |
| 224 | `SetLinearVelocity` |
| 306 | `ApplyImpulse` |
| 327 | `Step` |
| 328 | `ClearForces` |

### Box2D Body Types

| Index | String |
|-------|--------|
| 203 | `b2_dynamicBody` |
| 233 | `b2_staticBody` |
| 234 | `b2_kinematicBody` |

### Game State Fields

| Index | String |
|-------|--------|
| 2 | `world` |
| 3 | `ftu` |
| 4 | `fte` |
| 41 | `discs` |
| 42 | (discDeaths, inferred) |
| 43 | `physics` |
| 46 | `ppm` |
| 48 | `bodies` |
| 56 | `fixtures` |
| 58 | `shapes` |
| 67 | `joints` |
| 98 | `capZones` |
| 104 | `spawns` |
| 124 | `mm` |
| 125 | `m` |
| 326 | `pq` |
| 620 | `gravity` (property name) |
| 1195 | `bh` |
| 1205 | `bw` |
| 1243 | `gd` |

### Map Settings

| Index | String |
|-------|--------|
| 66 | `re` (respawning enabled) |
| 147 | `nc` (no collision) |
| 301 | `fl` (flipped) |
| 326 | `pq` (physics quality) |
| 1243 | `gd` (gravity direction) |

### Football/Swing Constants

| Index | String |
|-------|--------|
| 5 | `footHW` |
| 6 | `footHH` |
| 7 | `footOffsetX` |
| 8 | `footOffsetY` |
| 9 | `swingF` |
| 10 | `swingD` |

### Grapple

| Index | String |
|-------|--------|
| 309 | `noGrapple` |
| 317 | `innerGrapple` |
| 1000 | `grappleMapStrings` |
| 1003 | `randomArrayGrapple` |
| 1099 | `quick_grapple` |
| 1615 | `doGrapple` |

### Other Notable

| Index | String |
|-------|--------|
| 36 | `createNewState` |
| 37 | `safeCos` |
| 38 | `safeSin` |
| 182 | `SetContactListener` |
| 183 | `novakReset` |

> **Note:** `safeCos`/`safeSin` correspond to `b2ChazSafeTrig.safeCos`/`safeSin` from the AS3 reference — trig functions rounded to 1e7 precision for deterministic physics.

---

## 9. Map Format

See `DemystifyBonk/MAPFORMAT.md` for the full binary map format. Key defaults from `alpha2s.js`:

```js
// Blank map defaults (deobfuscated):
{
  v: 13,                    // Map format version
  s: { re: false, nc: false, pq: 1, gd: 25, fl: false },
  physics: { shapes: [], fixtures: [], bodies: [], bro: [], joints: [], ppm: 12 },
  spawns: [],
  capZones: [],
  m: {
    a: 'noauthor', n: 'noname', dbv: 2, dbid: -1, authid: -1,
    date: '', rxid: 0, rxn: '', rxa: '', rxdb: 1, cr: [], pub: false, mo: ''
  }
}
```

### Default Fixture

```js
{ n: "Def Fix", fr: 0.3, fp: null, re: 0.8, de: 0.3, f: 5209260, d: false, np: false, ng: false }
```

### Default Body

```js
{
  type: "s", n: "Unnamed", p: [0, 0], a: 0, fric: 0.3, fricp: false,
  re: 0.8, de: 0.3, lv: [0, 0], av: 0, ld: 0, ad: 0, fr: false, bu: false,
  cf: { x: 0, y: 0, w: true, ct: 0 }, fx: [], f_c: 1, f_p: true,
  f_1: true, f_2: true, f_3: true, f_4: true
}
```

---

## 10. Comparison to bonk-rl-env

### Confirmed Divergences

| Property | bonk.io (ground truth) | bonk-rl-env | Impact |
|----------|----------------------|-------------|--------|
| **Gravity Y** | **20** | 10 | Physics behaves completely differently — half the gravity |
| **Velocity iterations** | **2** (low) / **15** (high) | 5 | Wrong solver precision |
| **Position iterations** | **6** (low) / **15** (high) | 5 | Wrong solver precision |
| **Player radius (ppm)** | **12** (default) | 0.5 m | Completely different scale |
| **Scale concept** | `ppm` = player radius in game units | `SCALE=30` = px→m conversion | Fundamentally wrong abstraction |
| **Warm starting** | **false** | Not set (Box2D default: true) | Contact forces carry over incorrectly |
| **Step() signature** | 3 args (`dt, velIter, posIter`) | 2 args (`dt, iter`) | Wrong API usage |
| **ClearForces** | Called after every Step | Not called | Forces accumulate incorrectly |

### Not Yet Determined

| Property | Status | Notes |
|----------|--------|-------|
| Move force magnitude | Not isolated | Obscured by `w_c()` control flow flattening. Force vector constructed from input data. |
| Heavy state multiplier | Not found | No "heavy" string in constant table. May use numeric flag. |
| Grapple max distance | Partially found | `doGrapple` has constants 500, 4, 3 but meaning unconfirmed |
| Grapple frequencyHz | Not found | No `grappleMultiplier` string found |
| Grapple dampingRatio | Not found | — |
| TPS | Inferred 30 | Not found as explicit constant; based on network protocol |
| Box2D settings (linearSlop, etc.) | Not found | These are in the bundled Box2D source but string names aren't in the constant table (they're inlined as numeric literals) |

### Map Format Divergences

| Feature | bonk.io | bonk-rl-env | Impact |
|---------|---------|-------------|--------|
| Body→Fixture→Shape hierarchy | 3-level | Flattened (1 level) | Multi-fixture bodies impossible |
| Body types | s/d/k (3 types) | static boolean (2 types) | Kinematic bodies unsupported |
| Constant force (cf) | Per-body x/y/torque/absolute | Not implemented | Force zones unsupported |
| Force zones (fz) | Per-body | Not implemented | Missing |
| Fixed rotation (fr) | Per-body | Not implemented | Missing |
| Anti-tunnel (bu) | Per-body | Not implemented | Missing |
| Shrink (sk) | Per-shape | Not implemented | Missing |
| Joints | 4 types (rv/d/lpj/lsj) | 2 types (distance only) | Revolute and LSJ unsupported |
| Cap zones | 5 types (normal + 4 instant) | 2 types (blue/red) | Timed capture unsupported |
| Spawns | Per-team, priority, velocity | Position only | Missing team filtering & priority |

---

## How to Reproduce

### Inspecting the Runtime Constant Table

```js
// Run in browser console on bonk.io (inside the game iframe)
const iframe = document.getElementById('maingameframe');
const mqcc = iframe.contentWindow.M$QCc;

// Look up a string by index
console.log(mqcc[327]);  // "Step"

// Search for a string
for (let i = 0; i < mqcc.length; i++) {
  if (mqcc[i] === 'ApplyForce') console.log('ApplyForce at index', i);
}
```

### Searching the Obfuscated Source

```js
// Fetch alpha2s.js
const resp = await fetch('https://bonk.io/js/alpha2s.js');
const text = await resp.text();

// Find state creation pattern (same regex as bonkhost.js)
const stateRegex = text.match(/[A-Za-z]\[[A-Za-z0-9$_]{3}(\[[0-9]{1,3}\]){2}\]={discs/);

// Find Step call
const stepCall = text.match(/\[327\]\]\([A-Za-z0-9$_]{1,5}\.[A-Za-z0-9$_]{1,5}\([^)]*\)\s*,\s*(\d+)\s*,\s*(\d+)\)/);

// Find gravity
const gravity = text.match(/\[185\]\]\(new\s+[A-Za-z0-9$_]{1,5}\[1\]\(0,\s*(\d+(?:\.\d+)?)\)/);
```

### Using the Map Exporter Userscript

1. Install the Code Injector userscript (`codeinjector.js`) via Tampermonkey/Greasemonkey
2. Install the Map Exporter userscript (`mapexporter.js`)
3. Navigate to bonk.io and join a game
4. Click the "⬇" button to download the map as JSON
5. The exported JSON includes `extractedPhysicsConstants` with all deobfuscated values

---

## 11. Deep Dive: Game Mechanics (July 25, 2026)

### Move Force

The base move force is **12** (game units), increased to **20** when the map's `fl` (flipped) setting is true. This force is then multiplied by a dynamic scale factor `l3z[8]`.

**Deobfuscated source:**
```js
// Base force setup
force = new b2Vec2(0, 0);
forceMagnitude = 12;
if (mapSettings.fl) {
  forceMagnitude = 20;
}
forceMagnitude *= scaleRatio;  // l3z[8]

// Apply direction
if (inputState.up)    force.y = -forceMagnitude;
if (inputState.down)  force.y =  forceMagnitude;
if (inputState.left)  force.x = -forceMagnitude;
if (inputState.right) force.x =  forceMagnitude;

// Heavy state: multiply force by 0.7
if (inputState.action) {  // "action" = heavy button
  force.Multiply(0.7);
}

// Apply
body.ApplyForce(force, body.GetWorldCenter());
```

**Scale ratio (`l3z[8]`) formula:**
```js
scaleRatio = Math.SOMETHING * body.plen * body.OTHER_PROP / (Math.SOMETHING2 * constant1 * constant2);
```
The exact Math methods and body properties are obscured by `Q5$()` and `w_c()` control flow obfuscation, but the formula involves the body's `plen` (joint length property) and other body properties.

> **bonk-rl-env uses MOVE_FORCE=8.0. The real base is 12 (or 20 when flipped), scaled by a per-body ratio.**

### Heavy State ("action" input)

The heavy button is called `"action"` internally (constant table index 192). It is NOT called "heavy" in the game code.

When pressed, it multiplies the movement force vector by **0.7** (reduces to 70%). No mass change was found — `SetMassData`, `ResetMassData`, `SetDensity`, `GetMass`, and `SetType` are all **absent** from the constant table. The heavy state appears to ONLY reduce applied force, not change mass.

**Keyboard bindings (verified):**
| Property | Key Code | Key |
|----------|----------|-----|
| left1 | 37 | Arrow Left |
| left2 | 65 | A |
| right1 | 39 | Arrow Right |
| right2 | 68 | D |
| up1 | 38 | Arrow Up |
| heavy1 | 88 | X |
| heavy2 | 16 | Shift |

> **bonk-rl-env uses HEAVY_MASS_MULTIPLIER=3.0. The real behavior is force × 0.7, no mass change.**

### Disc (Player) Defaults

Found in the physics settings constructor (`class y0Z`):

| Property | Constant Index | Default Value | Meaning |
|----------|---------------|---------------|---------|
| `gravity` | 620 | **20** | World gravity Y |
| `ppm` | 46 | **12** | Player radius (pixels per meter) |
| `discFriction` | 951 | **0** | Player disc friction |
| `discRestitution` | 952 | **0.8** | Player disc bounciness |
| `discDensity` | 953 | **1.0** | Player disc density |
| `discLinearDamping` | 954 | **0.0** | Player disc linear damping |
| `discRadius` | 955 | **1.0** | Player disc radius multiplier |
| `discAllForce` | 956 | **12** | Base move force |
| `respawn` | 957 | **false** | Respawn enabled |
| `noCollide` | 958 | **false** | No collision mode |

> **bonk-rl-env uses PLAYER_RADIUS=0.5m. The real value is `ppm × discRadius × scaleRatio` (default 12 × 1.0 × scaleRatio).**

### Arrow/Kick Mechanics

Arrow mode (`mo == "v"`) uses `ApplyImpulse` instead of `ApplyForce`:

```js
// Deobfuscated:
impulseMag = Q5$(30, 24) * scaleRatio;  // magnitude (obscured by control flow)
damping = 0.2;
impulse = new b2Vec2(0, impulseMag);
impulse = body.GetWorldPoint(impulse, impulse);  // convert to world coords
// Then ApplyImpulse with kick direction vectors
```

Kick directions use `footOffsetX` and `footOffsetY` (indices 7, 8) scaled by `scaleRatio`:
```js
kickPoint = body.GetWorldPoint(new b2Vec2(footOffsetX * scaleRatio, footOffsetY * scaleRatio));
```

### Grapple Mechanics

The `doGrapple` function (index 1615) creates a **b2DistanceJoint** (not a custom joint):

**Constants in doGrapple:**
| Value | Meaning (inferred) |
|-------|-------------------|
| 500 | Max grapple distance |
| 4 | Unknown (possibly iteration or joint type) |
| 3 | Unknown |

**Grapple joint properties** (from source):
```js
// Joint def properties set from fixture data:
jointDef.frequencyHz = body.fixtureData.fh;     // index 97 → "fh"
jointDef.dampingRatio = body.fixtureData.dr;    // index 288 → "dr"
jointDef.collideConnected = body.fixtureData.cc; // index 280 → "cc"
```

The grapple uses `rotatePoint` (index 1541) to calculate anchor positions relative to the player body. The grapple line is drawn with:
- Width: `2 × scaleRatio` (index 1533)
- Color: `0xcccccc` (gray)
- Alpha: `0.5`

Grapple max distance check: `if (discData[119] < 500)` — index 119 is a distance property.

> **bonk-rl-env uses grappleFrequencyHz=4.0, dampingRatio=0.5, maxDistance=10m. The real values come from per-fixture `fh`/`dr` properties in the map data, with max distance 500.**

### Body Type Assignment

Body types are assigned based on the map's `type` field:
```js
// Deobfuscated:
if (bodyData.type == "s" || !enabled) {
  bodyDef.type = b2_staticBody;      // index 233
} else if (bodyData.type == "d") {
  bodyDef.type = b2_dynamicBody;     // index 203
} else if (bodyData.type == "k") {
  bodyDef.type = b2_kinematicBody;   // index 234
}
```

> All three body types (static, dynamic, kinematic) are confirmed in the source.

### Grapple Joint Property Constants

Complete joint property mapping (indices 270-295):

| Index | String | Used For |
|-------|--------|----------|
| 270 | `maxMotorForce` | LPJ joint |
| 271 | `motorSpeed` | LPJ joint |
| 272 | `CreateJoint` | World method |
| 273 | `el` | Enable limit (joint data) |
| 274 | `lowerAngle` | Revolute joint |
| 275 | `upperAngle` | Revolute joint |
| 276 | `em` | Enable motor (joint data) |
| 277 | `maxMotorTorque` | Revolute joint |
| 278 | `mmt` | Max motor torque (joint data key) |
| 279 | `collideConnected` | All joints |
| 280 | `cc` | Collide connected (joint data key) |
| 281 | `GetJointTranslation` | Prismatic joint |
| 282 | `cd` | Joint data key |
| 283 | `SetMotorSpeed` | Joint method |
| 284 | `GetMotorSpeed` | Joint method |
| 285 | `changeSide` | Grapple method |
| 286 | `frequencyHz` | Distance joint property |
| 287 | `dampingRatio` | Distance joint property |
| 288 | `dr` | Damping ratio (joint data key) |
| 289 | `ja` | Joint anchor A (data key) |
| 290 | `jb` | Joint anchor B (data key) |
| 293 | `GetBodyA` | Joint method |
| 294 | `GetBodyB` | Joint method |
| 295 | `ratio` | Gear joint |

### Death / Out of Bounds

Disc death events are created with:
```js
c13 = "discDeath" + Math.floor(Math.random() * N);
// N = Q5$(2, 3, 12, 4, 1) — one of these values (control flow obfuscation)
```

Death-related constants found:
| Index | String |
|-------|--------|
| 42 | `discDeaths` |
| 139 | `death` |
| 1623 | `playerDeathTimers` |
| 1643 | `deathArrowTexture` |
| 1644 | `createDeathArrowTexture` |

The death particles have properties: `gravity: 0.04`, `shrinkPerFrame: 0.016`, `alpha` (variable).

### Scale Ratio

The `scaleRatio` is used throughout rendering and physics:
```js
// Rendering: pixel coordinates = gameCoords * scaleRatio * ppm
var renderRadius = this.scaleRatio * state.physics.ppm;

// Movement: body.GetWorldPoint(new b2Vec2(footOffsetX * scaleRatio, footOffsetY * scaleRatio));
// Force scaling: forceMagnitude = 12 * scaleRatio;
```

The `scaleRatio` appears to be a per-player property that relates the game coordinate system to the Box2D world. It was not found as an explicit assignment — it's likely set during player/disc initialization.

### TPS / Tick Rate

No explicit TPS constant was found. The game uses `requestAnimationFrame` (not in constant table, likely inlined) for rendering and a server-driven tick rate for physics. `setInterval` calls found use 100ms, 2500ms, 120000ms, and 1000ms — none are physics tick intervals. The physics step is driven by incoming network state packets, confirming the **server-authoritative 30 TPS** model.

### Movement Code Full Reconstruction

```js
// Deobfuscated movement function (modes: "b", "bs", "sp", "ar", "ard")
function applyMovement(state, inputState, discIndex, gameSettings) {
  var scaleRatio = computeScaleRatio(body);  // obscured by w_c/Q5$

  if (gameSettings.mo == "b" || gameSettings.mo == "bs" || gameSettings.mo == "sp" ||
      (gameSettings.mo == "ar" && disc.ds == 0) ||
      (gameSettings.mo == "ard" && disc.ds == 0)) {

    var force = new b2Vec2(0, 0);
    var forceMag = 12;
    if (state.s.fl) forceMag = 20;  // flipped maps use higher force
    forceMag *= scaleRatio;

    if (inputState.up)    force.y = -forceMag;
    else if (inputState.down) force.y = forceMag;
    if (inputState.left)  force.x = -forceMag;
    else if (inputState.right) force.x = forceMag;

    if (inputState.action) {  // heavy
      force.Multiply(0.7);
    }

    body.ApplyForce(force, body.GetWorldCenter());
  }

  // Grapple mode ("sp") uses the same movement as classic mode ("b")
  // VTOL mode ("v") uses impulses instead
  if (gameSettings.mo == "v") {
    var impulseMag = 30_or_24 * scaleRatio;  // obscured
    var damping = 0.2;
    var impulse = new b2Vec2(0, impulseMag);
    impulse = body.GetWorldPoint(impulse, impulse);
    // ApplyImpulse with kick directions (left, right, both)
    // using footOffsetX/Y * scaleRatio as anchor points
  }
}
```

### Updated Comparison to bonk-rl-env

| Property | bonk.io (verified) | bonk-rl-env | Status |
|----------|-------------------|-------------|--------|
| Gravity Y | **20** | 10 | ❌ Wrong |
| Velocity iterations | **2** (low) / **15** (high) | 5 | ❌ Wrong |
| Position iterations | **6** (low) / **15** (high) | 5 | ❌ Wrong |
| Warm starting | **false** | not set (default true) | ❌ Wrong |
| Step() args | **3** (dt, velIter, posIter) | 2 (dt, iter) | ❌ Wrong |
| ClearForces | **called after every Step** | not called | ❌ Missing |
| PPM (player radius) | **12** (default) | 0.5m | ❌ Wrong |
| Move force base | **12** (or **20** when flipped) | 8.0N | ❌ Wrong |
| Heavy state | **force × 0.7** (no mass change) | mass × 3.0 | ❌ Wrong |
| Disc friction | **0** | not set | ❌ Missing |
| Disc restitution | **0.8** | not set | ❌ Missing |
| Disc density | **1.0** | not set | ❌ Missing |
| Disc linear damping | **0.0** | not set | ❌ Missing |
| Grapple max distance | **500** | 10m | ❌ Wrong |
| Grapple frequency/damping | **per-fixture `fh`/`dr`** | hardcoded 4.0/0.5 | ❌ Wrong |
| Grapple joint type | **b2DistanceJoint** | b2DistanceJoint | ✅ Correct |
| Body types | **s/d/k** (3 types) | static boolean | ❌ Wrong |
| Scale concept | `ppm × scaleRatio` | `SCALE=30` px→m | ❌ Wrong |

---

## 12. Player Identity & Team System (July 25, 2026)

### Player Identification

The game uses a **player ID** system to identify which disc belongs to which player. The local player (the one controlled by this browser) is tracked via `localPlayerID`.

#### Key Constants

| Index | String | Purpose |
|-------|--------|---------|
| 1119 | `playerID` | Property on game objects storing the owning player's ID |
| 1564 | `localPlayerID` | The local player's ID (which disc is "you") |
| 525 | `setLocalPlayerID` | Method to set the local player ID |
| 524 | `setPlayerArray` | Method to set the player array |
| 856 | `playerArray` | Array of all players in the game |
| 634 | `hostID` | The host's player ID |
| 771 | `peerID` | PeerJS connection ID |
| 1668 | `localSpawnedYet` | Whether the local player has spawned |
| 121 | `players` | The players array field on state |
| 186 | `playersLeft` | Players who left |
| 347 | `playersJoined` | Players who joined |

#### How Local Player ID Is Set

```js
// Deobfuscated setLocalPlayerID method:
setLocalPlayerID(playerID) {
  this.localPlayerID = playerID;
  if (this.someRenderer) {
    this.someRenderer.setLocalPlayerID(playerID);
  }
}
```

The local player ID is set when the game starts, received from the server. It maps directly to an index in the `discs` array:

```js
// Accessing the local player's disc:
state.discs[this.localPlayerID]
```

#### playerID Usage in Rendering

The `playerID` property (1119) is used on rendering objects to know which disc they represent:

```js
// Deobfuscated from constructor:
this.playerID = arguments[4];  // Set during construction
this.playerObject = arguments[3];
this.scaleRatio = arguments[1];

// Used to access disc data:
state.discs[this.playerID].a      // disc angle
state.discs[this.playerID].a1a    // arrow angle accumulator
state.discs[this.playerID].ds     // disc state
state.discs[this.playerID].a1     // arrow state 1
```

#### localSpawnedYet

```js
// Deobfuscated:
if (state.discs && state.discs[this.localPlayerID]) {
  this.localSpawnedYet = true;
}
if (this.gameSettings.tea && this.localSpawnedYet == false) {
  // Show "spectating" warning
  document.getElementById('ingametextwarning_spectating')...
}
```

This confirms: **if `localSpawnedYet` is false, the player is spectating** (hasn't spawned yet).

### Team System

#### Key Constants

| Index | String | Purpose |
|-------|--------|---------|
| 114 | `tea` | Teams enabled flag (boolean) on game settings |
| 115 | `team` | Team number on discs and players |
| 990 | `ffa` | Free-for-all team name |
| 991 | `blue` | Blue team name |
| 992 | `red` | Red team name |
| 1038 | `setTeam` | Method to set a player's team |
| 1041 | `teamify` | Convert team number to display name |
| 1579 | `teams` | Teams array |
| 1396 | `forceTeamCount` | Force number of teams |
| 1406 | `forceTeams` | Force teams on/off |

#### Team Numbers

Disc objects have a `team` field (constant index 115) with numeric values:

| Value | Team | Display Name |
|-------|------|-------------|
| 0 | Spectator | (not playing) |
| 1 | FFA | Free-for-all |
| 2 | Red | Red |
| 3 | Blue | Blue |
| 4 | Green | Green |
| 5 | Yellow | Yellow |

#### Team Assignment in Code

```js
// Deobfuscated:
// Setting team on a disc/player:
playerArray[playerIndex].team = teamNumber;

// When teams are disabled and team > 1, force to FFA (1):
if (gameSettings.tea == false && player.team > 1) {
  player.team = 1;
}

// When teams enabled flag is checked:
if (gameSettings.tea) {
  // Teams mode logic
}
```

#### Teams Toggle

The `tea` field (114) on game settings controls whether teams are enabled:
- `tea = false`: Free-for-all (all players are team 1)
- `tea = true`: Teams mode (players assigned to red/blue/green/yellow)

The `newbonklobby_teamsbutton` toggles this in the lobby UI.

### Input State Structure

#### Input Booleans

The input state object has boolean properties for each direction:

| Index | String | Input |
|-------|--------|-------|
| 302 | `up` | Move up |
| 303 | `down` | Move down |
| 304 | `left` | Move left |
| 305 | `right` | Move right |
| 192 | `action` | Heavy (force × 0.7) |
| 193 | `a2` | Special action 2 (arrow secondary) |
| 194 | `action2` | Second action button |

The input is accessed as: `state.discs[playerID].inputState.left`, etc.

### Local Player Position Tracking

The game tracks the local player's position separately:

| Index | String | Purpose |
|-------|--------|---------|
| 984 | `localX` | Local player X position |
| 985 | `localY` | Local player Y position |
| 986 | `localAngle` | Local player angle |

These are stored on a separate object (`t$e[39]` class) that's populated from the game state:

```js
// Deobfuscated:
class LocalPlayerState {
  constructor() {
    this.localX = 0;
    this.localY = 0;
    this.someProp1 = 0;
    this.someProp2 = 0;
    this.localAngle = 0;
  }
}
```

### How to Identify "Your" Disc at Runtime

To find which disc the local player controls:

1. **With code injector:** The `__bonkExportState` captures `arguments[0]` (the state) and `arguments[4]` (game settings). The local player ID is stored on the game's internal objects, not directly on the state. However, `arguments[4]` (game settings) may contain the local player ID.

2. **Via constant table search:** Search for objects that have a `localPlayerID` property (index 1564) set to a non-null value.

3. **Via spectating check:** The element `ingametextwarning_spectating` is visible when `localSpawnedYet` is false. Once it disappears, the local player has spawned.

4. **Via disc count:** In a 1v1 game, there are typically 2 discs. The local player is usually the first disc in the array (index 0) in a custom game where you're the host.

### Game Mode Constants

| Mode Code | Name | Constant Table |
|-----------|------|---------------|
| `b` | Classic | `mo` field |
| `bs` | Simple (Bounce) | `mo` field |
| `ar` | Arrows | `mo` field |
| `ard` | Death Arrows | `mo` field |
| `sp` | Grapple | `mo` field |
| `v` | VTOL | `mo` field |
| `f` | Football | `mo` field |

The mode is stored on game settings as `mo` (constant index 118). The movement code checks this to determine which physics apply:

```js
// Deobfuscated movement mode check:
if (mode == "b" || mode == "bs" || mode == "sp" ||
    (mode == "ar" && discState == 0) ||
    (mode == "ard" && discState == 0)) {
  // Apply movement force (Classic/Simple/Grapple/Arrows)
}
if (mode == "v") {
  // Apply arrow impulse (VTOL mode)
}
```

### Grapple-Specific Input

In grapple mode, the "special" key (bit 5 = 32 in network packet) triggers the grapple. At runtime, this is stored as a boolean property. The grapple is fired via `doGrapple()` which creates a `b2DistanceJoint` to the nearest valid surface.

### Disc State Fields (ds)

The `ds` field (constant index 196) on disc objects tracks the disc's current state:
- `ds = 0`: Normal/alive
- `ds > 0`: Special state (e.g., arrow mode charging)

The movement code checks `ds == 0` before applying movement force in arrow/death-arrow modes.

---

## 13. Contact Listener & Collision System (July 25, 2026)

### Contact Listener Structure

The game creates a Box2D contact listener (`b2ContactListener`) and sets it on the world:

```js
// Deobfuscated:
state.world.SetContactListener({
  BeginContact: function(contact) { ... },
  EndContact: function(contact) { ... },
});
```

The `BeginContact` handler is the core collision logic. It runs **before** the physics solver processes contacts, allowing the game to disable contacts (e.g., same-team collisions, arrow-owner collisions) or trigger events (deaths, cap zone scoring).

### Body Types (UserData)

Each Box2D body has a `userData` object with a `type` field (constant index 52):

| Type | Meaning |
|------|---------|
| `"disc"` | Player disc |
| `"phys"` | Map physics body (platform, wall, etc.) |
| `"arrow"` | Arrow projectile |
| `"vtolwing"` | VTOL mode wing |

The contact listener uses `contact.GetFixtureA().GetBody().GetUserData().type` to identify what collided.

### BeginContact Handler Logic

```js
// Deobfuscated BeginContact:
function(contact) {
  var fixtureA = contact.GetFixtureA();
  var fixtureB = contact.GetFixtureB();
  var bodyA = fixtureA.GetBody();
  var bodyB = fixtureB.GetBody();
  
  var userDataA = bodyA.GetUserData();
  var userDataB = bodyB.GetUserData();
  
  for (var i = 0; i < 2; i++) {
    // Swap A/B on second iteration to check both directions
    
    // Case 1: disc touches lethal phys body → DEATH
    if (userDataA.type == "disc" && 
        userDataB.type == "phys" && 
        userDataB.death == true) {
      state.globalStepVars.discs[userDataA.arrayID].diedThisStep = 1;
    }
    
    // Case 2: disc touches capzone → CAP EVENT
    if (userDataA.type == "disc" && 
        (!userDataA || userDataA.type != "vtolwing") && 
        userDataB.type == "phys" && 
        userDataB.capzone == true && 
        userDataB.capType == 1) {
      state.globalStepVars.capEvent(bodyA, bodyB);
      contact.SetEnabled(false);
    }
    
    // Case 3: arrow touches phys → disable contact
    if (userDataA.type == "arrow" && 
        userDataB.type == "phys" && 
        userDataB.capzone == true) {
      contact.SetEnabled(false);
    }
    
    // Case 4: disc touches vtolwing → disable contact
    if (userDataA.type == "disc" && userDataA && 
        userDataA.type == "vtolwing" && 
        userDataB.type == "phys" && 
        userDataB.capzone == true) {
      contact.SetEnabled(false);
    }
    
    // Case 5: phys touches phys with capzone → team goal event
    if (userDataA.type == "phys" && 
        userDataB.type == "phys" && 
        userDataB.capzone == true && 
        userDataB.capType != 1) {
      state.globalStepVars.teamGoalEvent(userDataB.capType);
      contact.SetEnabled(false);
    }
    
    // Case 6: disc touches disc → various checks
    if (userDataA.type == "disc" && userDataB.type == "disc") {
      // If no-collision mode (nc), disable
      if (state.globalStepVars.inputState.physics.nc) {
        contact.SetEnabled(false);
      }
      // If teams on and same team, disable
      else if (state.gameSettings.tea == true && 
               userDataA.team == userDataB.team) {
        contact.SetEnabled(false);
      }
      // Otherwise, record the collision
      else {
        // If either disc is in "swing" state, add to destroy events
        if (state.globalStepVars.discs[userDataA.arrayID].swing) {
          state.globalStepVars.swingCollideDestroyEvents.push(userDataA.arrayID);
        }
        // Record last-hit IDs
        state.globalStepVars.discs[userDataA.arrayID].lhid = userDataB.arrayID;
        state.globalStepVars.discs[userDataB.arrayID].lhid = userDataA.arrayID;
        state.globalStepVars.discs[userDataA.arrayID].lht = 120;
        state.globalStepVars.discs[userDataB.arrayID].lht = 120;
      }
    }
    
    // Case 7: arrow hits disc → arrow hit logic
    if (userDataA.type == "arrow") {
      var targetData = bodyB.GetUserData();
      var arrowData = bodyA.GetUserData();
      
      // Arrow doesn't hit its owner (if no teams) or same team (if teams)
      if (state.gameSettings.tea == false && 
          userDataB.type == "disc" && 
          userDataB.arrayID == userDataA.discID) {
        contact.SetEnabled(false);
      } else if (state.gameSettings.tea == true && 
                 userDataB.type == "disc" && 
                 userDataA.team == userDataB.team) {
        contact.SetEnabled(false);
      } else {
        // Arrow hits disc
        if (userDataB.type == "disc") {
          arrowData.hitDiscsThisStep.push(userDataB.arrayID);
          // Death arrows mode kills on hit
          if (state.gameSettings.mo == "ard") {
            state.globalStepVars.discs[userDataB.arrayID].diedThisStep = 1;
          }
        } else {
          arrowData.hitWorldThisStep = true;
        }
      }
    }
    
    // Case 8: phys body with force zone → apply force
    if (userDataA.type == "phys") {
      var bodyID = userDataA.arrayID;
      var bodyData = state.globalStepVars.inputState.physics.bodies.bodies[bodyID];
      if (bodyData.fz.on) {  // force zone enabled
        // Apply force from fz.x, fz.y
        var force = new b2Vec2(bodyData.fz.x, bodyData.fz.y);
        // ... apply force to bodyB
      }
    }
    
    // Swap A and B for second iteration
    var temp = bodyA; bodyA = bodyB; bodyB = temp;
    temp = userDataA; userDataA = userDataB; userDataB = temp;
    temp = fixtureA; fixtureA = fixtureB; fixtureB = temp;
  }
}
```

### Key Collision Rules

1. **Lethal bodies kill discs** — `userDataB.death == true` sets `disc.diedThisStep = 1`
2. **Cap zones (type 1 = normal)** — Triggers `capEvent(bodyA, bodyB)` when a disc enters, contact disabled
3. **Cap zones (type 2-5 = instant win)** — Triggers `teamGoalEvent(capType)` for the corresponding team
4. **Same-team disc collision disabled** — When `tea == true` and both discs have the same `team` value
5. **No-collision mode** — When `nc == true`, all disc-disc contacts are disabled
6. **Arrow owner immunity** — Arrows don't hit their own disc (or same team if teams enabled)
7. **Death arrows** — Arrow hits kill instantly (`diedThisStep = 1`) when mode is `"ard"`
8. **Last hit tracking** — Disc-disc collisions record `lhid` (last hit disc ID) and `lht = 120` (last hit timer, 120 ticks = 4 seconds at 30 TPS)
9. **Force zones** — Phys bodies with `fz.on == true` apply force to contacting bodies

### Disc Collision Data Fields

| Field | Constant Index | Meaning |
|-------|---------------|---------|
| `arrayID` | 141 | Disc index in the discs array |
| `diedThisStep` | 140 | Set to 1 when killed this tick |
| `swing` | 150 | Whether disc is in swing/grapple state |
| `lhid` | 152 | Last hit by disc ID |
| `lht` | 153 | Last hit timer (120 ticks) |
| `team` | 115 | Team number |
| `discID` | 154 | Arrow's owner disc ID |
| `hitDiscsThisStep` | 155 | Array of discs hit by arrow |
| `hitWorldThisStep` | 156 | Whether arrow hit a wall |

### Global Step Variables

The `globalStepVars` object (constant index 131) holds per-tick collision state:

| Field | Constant Index | Content |
|-------|---------------|---------|
| `discs` | 41 | Array of disc state (diedThisStep, lhid, lht, swing) |
| `inputState` | 148 | The game state (physics, settings, etc.) |
| `gameSettings` | 149 | Game settings (tea, mo, etc.) |
| `swingCollideDestroyEvents` | 151 | Discs to destroy grapple joint on collision |
| `capEvent` | 144 | Function called for cap zone capture |
| `teamGoalEvent` | 146 | Function called for instant-win cap zone |

### Cap Zone Scoring

Cap zones have two types:
- **Type 1 (`capType == 1`)**: Normal timed capture. When a disc enters, `capEvent(discBody, capZoneBody)` is called. This increments the cap zone progress (`p`) and when it reaches the limit (`l`), the zone is captured.
- **Type 2-5 (`capType != 1`)**: Instant win. When any physics body touches, `teamGoalEvent(capType)` fires immediately. The capType maps to team: 2=red, 3=blue, 4=green, 5=yellow.

The cap zone state is initialized as:
```js
// Deobfuscated:
capZones[i] = {
  ty: mapCapZone.ty,    // type
  p: 0,                  // progress (starts at 0)
  l: mapCapZone.l * 30,  // capture limit (map value × 30)
};
```

**Correction (July 26, 2026):** current-client source proves the multiplier is
`l * 30`, not `l * 3`. See the complete capture lifecycle in section 30.

---

## 14. Box2D Body Creation (July 25, 2026)

### Key Constants

| Index | String |
|-------|--------|
| 14 | `b2BodyDef` |
| 17 | `b2FixtureDef` |
| 23 | `b2PolygonShape` |
| 24 | `b2CircleShape` |
| 214 | `CreateBody` |
| 221 | `CreateFixture` |
| 205 | `position` |
| 206 | `fixedRotation` |
| 207 | `linearDamping` |
| 210 | `angle` |
| 211 | `angularDamping` |
| 213 | `bullet` |

### Body Type Assignment

```js
// Deobfuscated:
if (bodyData.type == "s" || !enabled) {
  bodyDef.type = b2_staticBody;      // index 233
} else if (bodyData.type == "d") {
  bodyDef.type = b2_dynamicBody;     // index 203
} else if (bodyData.type == "k") {
  bodyDef.type = b2_kinematicBody;   // index 234
}
```

### Scale Ratio Formula

The `scaleRatio` is set in a constructor: `this.scaleRatio = arguments[1]`.

It's used in the movement formula as a multiplier:
```
forceMagnitude = 12 * scaleRatio  (or 20 * scaleRatio when flipped)
```

The exact formula for computing `scaleRatio` is:
```js
scaleRatio = Math.METHOD1 * disc.plen * disc.PROP2 / (Math.METHOD2 * const1 * const2)
```

Where `METHOD1`, `METHOD2`, `PROP2`, `const1`, and `const2` are resolved through `Q5$()` / `w_c()` control flow obfuscation. The `Q5$()` function uses a state machine with case labels — its arguments are case labels, not return values. This makes static resolution impossible without running the state machine.

However, the available Math methods in the constant table are: `sqrt`(608), `pow`(243), `abs`(180), `floor`(117), `max`(200), `min`(201), `atan2`(602), `cos`(484), `sin`(485), `PI`(189), `atan`(1490), `ceil`(1428), `round`(989).

### Rendering Scale

The rendering pipeline uses `scaleRatio * ppm` as the pixel-to-world scale:
```js
// Deobfuscated:
var pixelScale = physics.ppm * this.scaleRatio;
var renderX = body.position[0] * pixelScale;
var renderY = body.position[1] * pixelScale;
```

And for player discs:
```js
var renderRadius = this.scaleRatio * physics.ppm;
```

This confirms `ppm` is the base scale and `scaleRatio` is a per-player multiplier (likely 1.0 for standard zoom).

---

## 15. Death System & Win Conditions (July 25, 2026)

### Death State Values

The `diedThisStep` field (constant index 140) on disc state objects uses multiple values:

| Value | Cause | Trigger |
|-------|-------|---------|
| 0 | Alive | (not set) |
| 1 | Lethal surface / Death arrow | Contact listener: `disc.diedThisStep = 1` when touching lethal body, or arrow hit in `"ard"` mode |
| 3 | Cap zone elimination / Team elimination | When cap zone captured, all non-owner teams eliminated; or when team != capzone owner |
| 4 | Timeout / Out of bounds | Position exceeds bounds OR no game start |

### Death Type 3: Cap Zone Elimination

```js
// Deobfuscated:
// When cap zone is captured (type 1 = normal):
if (capZones[capZoneIndex].ot == 1) {
  // Owner team is 1 (FFA) — eliminate all discs except the capturer
  for (i = 0; i < discs.length; i++) {
    if (discs[i] && i != capZones[capZoneIndex].o) {
      discs[i].diedThisStep = 3;
    }
  }
} else {
  // Teams mode — eliminate all discs whose team != capzone owner team
  for (i = 0; i < discs.length; i++) {
    if (discs[i] && discs[i].team != capZones[capZoneIndex].ot) {
      discs[i].diedThisStep = 3;
    }
  }
}
```

### Death Type 4: Out of Bounds / Timeout

```js
// Deobfuscated:
// Position check: disc position exceeds bounds relative to local anchor
var distanceFromCenter = disc.body.GetPosition().Length();  // sqrt(x² + y²)
var maxDistance = localAnchorB / physics.bodies[someIndex].someProperty;
var outOfBounds = distanceFromCenter > maxDistance;

// Alternative: distance from center > 850 / ppm (world units)
var farFromCenter = (gameStartName == false) && 
  Math.sqrt(someValue) > 850 / physics.ppm;

if (outOfBounds || farFromCenter) {
  disc.diedThisStep = 4;
}
```

Key constants:
- `850` — maximum distance from center before timeout death (in pixels, divided by `ppm` to convert to world units)
- The `localAnchorB` (index 263) is used as a reference distance — this is a joint property repurposed for bounds checking

> **Port conversion note (verified 2026-07-29):** Because native world units are
> `map px / ppm`, the check `dist > 850 / ppm` reduces to exactly `dist > 850`
> in map coordinates — **the ppm cancels completely**. bonk-rl-env converts all
> map coordinates with its export scale `SCALE = 30`, so the correct port
> equivalent is `850 / SCALE` world units, constant and ppm-independent (same
> resolution as the `500 / SCALE` grapple reach in line 2531). The earlier
> `850 / ppm` port implementation was 2.5× too large at default `ppm = 12` and
> wrongly varied with ppm.
- `gameStartName` (index 577) — when false, the timeout/distance check applies

### Win Condition Check

After all deaths are processed, the game counts alive players:

```js
// Deobfuscated:
aliveCount = 0;
lastAliveIndex = -1;
for (i = 0; i < discs.length; i++) {
  if (discs[i]) {
    // A disc is "alive" if:
    // - diedThisStep is falsy (0/undefined/null), OR
    // - respawning is enabled AND diedThisStep != 3 (cap zone elimination is permanent)
    if (!discs[i].diedThisStep || 
        (mapSettings.ms.re == true && discs[i].diedThisStep != 3)) {
      aliveCount++;
      lastAliveIndex = i;
      lastAliveTeam = discs[i].team;
    }
  }
}
```

**Win logic:**
- If `aliveCount <= 1` and `lastAliveIndex >= 0` — that disc wins
- If `aliveCount == 0` — draw/no winner
- If respawning is enabled (`re == true`), cap zone deaths (type 3) are permanent but other deaths allow respawn
- Teams mode: if all remaining alive discs are on the same team, that team wins

### Out-of-Bounds Death: No bw/bh Check

Contrary to what bonk-rl-env implements, the real bonk.io does **NOT** use `bw`/`bh` (map bounds width/height) for death checks. Instead:
- Death type 4 uses a **distance from center** check: `sqrt(x² + y²) > 850/ppm`
- This means the death boundary is **circular**, not rectangular
- The `850` value is a hardcoded constant (pixels at default zoom)

> **bonk-rl-env uses rectangular out-of-bounds death (abs(x) > bw, abs(y) > bh). The real game uses circular distance-from-center death.**

---

## 16. Input System (July 25, 2026)

### Keyboard Bindings

The game stores keyboard key codes for each input direction:

| Property | Index | Default Key Code | Key |
|----------|-------|-----------------|-----|
| `up1` | 377 | 38 | Arrow Up |
| `up2` | 378 | 87 | W |
| `down1` | 383 | 40 | Arrow Down |
| `down2` | 384 | 83 | S |
| `left1` | 373 | 37 | Arrow Left |
| `left2` | 375 | 65 | A |
| `right1` | 380 | 39 | Arrow Right |
| `right2` | 381 | 68 | D |
| `heavy1` | 386 | 88 | X |
| `heavy2` | 387 | 16 | Shift |
| `swing1` | 389 | — | (swing/grapple key) |
| `swing2` | 390 | — | (secondary swing key) |

### Input State Structure

At runtime, the input state object has boolean properties:

| Property | Index | Input |
|----------|-------|-------|
| `up` | 302 | Move up |
| `down` | 303 | Move down |
| `left` | 304 | Move left |
| `right` | 305 | Move right |
| `action` | 192 | Heavy (force × 0.7) |
| `a2` | 193 | Special action 2 |
| `action2` | 194 | Second action |
| `ds` | 196 | Disc state |

### Input Reading in Physics Step

The movement code reads input as direct boolean checks — **not** bitwise operations:

```js
// Deobfuscated movement code:
if (inputState.up)    force.y = -forceMag;
if (inputState.down)  force.y =  forceMag;
if (inputState.left)  force.x = -forceMag;
if (inputState.right) force.x =  forceMag;
if (inputState.action) force.Multiply(0.7);  // heavy
```

### Arrow Mode Direction Combinations

In VTOL/Arrow mode, the game combines directions into named strings:

```js
// Deobfuscated:
if (inputState.up) {
  if (inputState.left)       direction = "left";
  else if (inputState.right)  direction = "right";
  else                        direction = "up";
} else if (inputState.down) {
  if (inputState.left)       direction = "downleft";  // (actually "downright" - left/right naming may be swapped)
  else if (inputState.right) direction = "downright";
  else                        direction = "down";
} else {
  if (inputState.left && inputState.right) direction = "both";
  else if (inputState.left)               direction = "left";
  else if (inputState.right)              direction = "right";
}
```

### Network Input Decoding

The packed input integer (bits: 1=left, 2=right, 4=up, 8=down, 16=heavy, 32=special) is decoded in the **network layer**, not the physics step. The network packet's `i` field is delta-compressed via `t$e[61].decodeFromDB()` (LZString decompression) before the booleans are extracted.

The `updateLocalInputKeys` method (index 750) updates the local player's key state, and the `setPlayerArray` method (index 524) syncs the player array with the game state.

### Input Flow Summary

```
Keyboard Event → keydown/keyup handler → inputState.up/down/left/right = true/false
                                              ↓
                                    Physics step reads booleans
                                              ↓
                                    ApplyForce / ApplyImpulse
                                              ↓
                                    Network packet: pack booleans → "i" field
                                              ↓
                                    LZString compress → send to server
```

The server then broadcasts the packed input to all clients, who decode it back into booleans.

---

## 17. Grapple Joint Lifecycle (July 25, 2026)

### doGrapple Function (Full Deobfuscation)

The `doGrapple` function (constant index 1615) handles both the grapple joint creation and the rendering of the grapple line. It takes 4 arguments: `(prevState, newState, ratio, something)`.

**Constants resolved:**

| Index | String | Usage |
|-------|--------|-------|
| 1119 | `playerID` | Local player's disc index |
| 150 | `swing` | Swing state object on disc |
| 107 | `b` | Body index in swing state |
| 49 | `p` | Position array [x, y] |
| 39 | `x` | X coordinate |
| 40 | `y` | Y coordinate |
| 48 | `bodies` | Physics bodies array |
| 64 | `a` | Body angle |
| 193 | `a2` | Secondary swing (a2 mode) |
| 119 | `a1a` | Arrow angle accumulator |
| 1541 | `rotatePoint` | t$e[61].rotatePoint function |
| 1533 | `scaleRatio` | Per-player scale |
| 1594 | `specialGraphic` | PIXI Graphics for grapple line |
| 1595 | `specialRing` | PIXI Graphics for grapple ring |
| 1603 | `local` | Whether this is the local player |

### Grapple Logic (Deobfuscated)

```js
function doGrapple(prevState, newState, ratio, something) {
  var maxDistance = 500;  // Maximum grapple distance
  
  // Calculate scale: disc.physics * this.rotatePoint
  var scale = newState.physics * this.rotatePoint;
  
  // Clear the grapple graphic
  this.specialGraphic.clear();
  
  // Case 1: Swing state active (grapple attached)
  if (prevState.discs[this.playerID].swing && 
      newState.discs[this.playerID].swing) {
    
    // Get the body that the grapple is attached to
    var bodyIdx = newState.discs[this.playerID].swing.b;
    var grapplePoint = {
      x: prevState.discs[this.playerID].swing.p[0],
      y: prevState.discs[this.playerID].swing.p[1]
    };
    
    // Rotate the grapple point relative to the body's angle
    var rotated = t$e[61].rotatePoint(
      { x: 0, y: 0 },
      grapplePoint,
      prevState.physics.bodies[bodyIdx].a  // body angle
    );
    
    // Calculate world-space anchor positions
    var anchorA = {
      x: rotated.x + prevState.physics.bodies[bodyIdx].p[0],
      y: rotated.y + prevState.physics.bodies[bodyIdx].p[1]
    };
    
    var swingPointB = {
      x: newState.discs[this.playerID].swing.p[0],
      y: newState.discs[this.playerID].swing.p[1]
    };
    var rotatedB = t$e[61].rotatePoint(
      { x: 0, y: 0 },
      swingPointB,
      newState.physics.bodies[bodyIdx].a
    );
    var anchorB = {
      x: rotatedB.x + newState.physics.bodies[bodyIdx].p[0],
      y: rotatedB.y + newState.physics.bodies[bodyIdx].p[1]
    };
    
    // Draw the grapple line
    this.specialGraphic.lineStyle(2 * this.scaleRatio, 0xcccccc, 0.5);
    this.specialGraphic.moveTo(anchorA.x, anchorA.y);
    this.specialGraphic.lineTo(anchorB.x, anchorB.y);
    
    // Draw circle at anchor point
    this.specialGraphic.drawCircle(anchorA.x, anchorA.y, 0.2 * scale);
  }
  
  // Case 2: a2 (secondary grapple) active and local player
  else if (prevState.discs[this.playerID].a2 && 
           newState.discs[this.playerID].a2 && 
           this.local) {
    // Draw thin grapple line for a2 mode
    this.specialGraphic.lineStyle(2, 0xcccccc, 0.5);
    this.specialGraphic.drawCircle(0, 0, scale * 1);  // or ratio
  }
  
  // Draw the special ring (grapple range indicator)
  this.specialRing.clear();
  
  // If distance (a1a) is less than maxDistance, draw ring
  if (newState.discs[this.playerID].a1a < 500) {
    this.specialRing.lineStyle(2 * this.scaleRatio, 0xff3333, 0.5);
    this.specialRing.drawCircle(0, 0, this.radius + 1 * this.scaleRatio);
  }
}
```

### Key Findings

1. ~~Max grapple distance = 500~~ **CORRECTED (§32.3, 2026-07-29):** the `500` (`o1h[3]`) is the `a1a` energy threshold, not a distance. Actual reach is a 10-unit center-to-surface window.
2. **Grapple attaches to body index `swing.b`** — this is the body the grapple is stuck to
3. **Anchor position is `swing.p`** — a position relative to the body, rotated by the body's angle via `rotatePoint()`
4. **Grapple line is rendered** as a PIXI Graphics line from player to anchor, width `2 * scaleRatio`, color `0xcccccc` (gray), alpha `0.5`
5. **Grapple ring** (red circle) appears when `a1a < 500` — this is the "can grapple" indicator showing the player is within range
6. **a2 mode** is a secondary grapple that only renders for the local player (`this.local`)
7. **The grapple line updates every frame** — it recalculates the rotated anchor position based on the body's current angle

### Grapple Joint Destruction

When a disc with an active swing state collides with another disc, the grapple is destroyed:

```js
// Deobfuscated (from BeginContact handler):
if (globalStepVars.discs[userDataA.arrayID].swing) {
  globalStepVars.swingCollideDestroyEvents.push(userDataA.arrayID);
}
```

The `swingCollideDestroyEvents` array (index 151) is processed after the physics step to destroy grapple joints for any disc that collided while swinging.

### Swing State Object

The `swing` object on each disc contains:

| Field | Description |
|-------|-------------|
| `b` | Body index the grapple is attached to |
| `p` | Position [x, y] of the anchor point on the body (local coordinates; via `GetLocalPoint`) |
| `l` | Joint rest length (`b2Distance(discPos, worldAnchor)` at fire time) |

> **CORRECTED (2026-07-29, see §32.4):** the swing object contains **only** `b`, `p`, `l`
> (written verbatim at client lines 8757–8761). Earlier rows claiming `fh`/`dr` fields were
> wrong: `fh`/`dr` exist only on map-defined `"d"` joints, not on the grapple. Grapple joint
> stiffness comes from the map physics `swingF` (2 Hz) / `swingD` (0) values.

---

## 18. State Serialization & Network Protocol (July 25, 2026)

### LZ-String Compression

The game uses LZ-String compression for all map and state data transmitted over the network:

| Function | Index | Purpose |
|----------|-------|---------|
| `compressToEncodedURIComponent` | 736 | Encode map data for network packets |
| `decompressFromEncodedURIComponent` | 719 | Decode map data from network packets |
| `encodeToDatabase` | 737 | Encode state for the "is" field in START_GAME |
| `decodeFromDatabase` | 724 | Decode state from the "is" field |
| `encodeInputs` | 852 | Encode input booleans to packed integer |
| `decodeInputs` | 740 | Decode packed integer to input booleans |
| `encode` | 734 | Generic encode |
| `decode` | 722 | Generic decode |

### START_GAME Packet Structure

The `42[5,...]` packet (START_GAME) sends:

```js
42[5, {
  is: "LZString-encoded-state",  // Initial state for all clients
  gs: {                           // Game settings
    map: "LZString-encoded-map",
    gt: 2,                        // Game type
    wl: 3,                        // Rounds to win
    q: false,                     // Quick play
    tl: false,                    // Team lock
    tea: false,                   // Teams enabled
    ga: "b",                      // Game engine
    mo: "sp",                     // Mode (e.g., grapple)
    bal: []                       // Balance array
  }
}]
```

The `is` field contains the initial game state, LZ-String encoded via `encodeToDatabase()`. This includes:
- All disc initial positions, velocities, teams
- The physics world state
- The map body/fixture/shape definitions
- The seed for deterministic RNG

### Map Data Format

Maps are encoded as LZ-String compressed JSON:
```js
// Decompressed map structure:
{
  v: 13,                      // Map version
  s: { re, nc, pq, gd, fl },  // Settings
  physics: { shapes, fixtures, bodies, bro, joints, ppm },
  spawns: [...],
  capZones: [...],
  m: { n, a, dbid, dbv, ... } // Metadata
}
```

### Input Encoding

Inputs are packed into a single integer via `encodeInputs()`:
```
Bit 0 (1):   Left
Bit 1 (2):   Right
Bit 2 (4):   Up
Bit 3 (8):   Down
Bit 4 (16):  Heavy
Bit 5 (32):  Special (Grapple)
```

The packed integer is sent as `{ i: packedInt, f: frameNumber, c: sequenceNumber }`.

---

## 19. Deterministic Trigonometry (July 25, 2026)

### b2ChazSafeTrig

The game uses deterministic trigonometric functions from `b2ChazSafeTrig` (verified from the AS3 reference source):

```js
// From reference/bonk1-box2d/Source/Box2D/b2ChazSafeTrig.as:
class b2ChazSafeTrig {
  static TRIG_PRECISION = 1e7; // 10000000

  static roundToPrecision(x) {
    return Math.round(x * TRIG_PRECISION) / TRIG_PRECISION;
  }

  static safeSin(x)  { return roundToPrecision(Math.sin(x)); }
  static safeCos(x)  { return roundToPrecision(Math.cos(x)); }
  static safeTan(x)  { return roundToPrecision(Math.tan(x)); }
  static safeASin(x) { return roundToPrecision(Math.asin(x)); }
  static safeACos(x) { return roundToPrecision(Math.acos(x)); }
  static safeATan(x) { return roundToPrecision(Math.atan(x)); }
  static safeATan2(y, x) { return roundToPrecision(Math.atan2(y, x)); }
}
```

These functions round trig results to 7 decimal places (1e-7 precision) to ensure **deterministic physics** across different JavaScript engines and platforms. Floating-point trig functions can produce slightly different results on different CPUs/browsers, which would cause desyncs in multiplayer. By rounding to 1e7 precision, bonk.io ensures all clients compute identical physics.

**Constant table entries:**
- `safeCos` = index 37
- `safeSin` = index 38
- `createNewState` = index 36

These are used throughout the physics engine wherever trig is needed (body rotation, grapple anchor calculation, collision normals, etc.).

---

## 20. Spawn System (July 25, 2026)

### Spawn Constants

| Index | String | Purpose |
|-------|--------|---------|
| 104 | `spawns` | Map spawn points array |
| 341 | `sx` | Spawn X position |
| 342 | `sy` | Spawn Y position |
| 343 | `sxv` | Spawn X velocity |
| 344 | `syv` | Spawn Y velocity |
| 345 | `spawnTeamInfo` | Team filtering info |
| 946 | `spawnArray` | Runtime spawn array |
| 948 | `spawnNames` | Spawn names |
| 957 | `respawn` | Respawn enabled flag |

### How Spawns Work

At round start, the game iterates through the map's `spawns` array and assigns discs to spawn points:

```js
// Deobfuscated:
// Deep copy the spawns array
var spawns = JSON.parse(JSON.stringify(gameSettings.map.spawns));

for (var i = 0; i < spawns.length; i++) {
  if (spawns[i]) {
    // Assign disc to spawn point
    // Copy spawnTeamInfo from the map's spawn definition
    state.discs[discIndex].spawnTeamInfo = map.spawns[discIndex].spawnTeamInfo;
    
    // If this disc has a swing state, initialize it
    if (hasSwing[discIndex]) {
      state.discs[discIndex].swing = {
        b: bodyIndex,     // attached body
        p: [x, y],        // anchor position
        fh: frequencyHz,  // from fixture
        dr: dampingRatio  // from fixture
      };
    }
  }
}
```

### Spawn Point Structure

Each spawn point in the map's `spawns` array contains:

| Field | Description |
|-------|-------------|
| `sx` | X position (world coordinates) |
| `sy` | Y position |
| `sxv` | Initial X velocity |
| `syv` | Initial Y velocity |
| `spawnTeamInfo` | Team filtering (which teams can use this spawn) |

The spawn system assigns discs to spawn points based on team membership. In teams mode (`tea == true`), discs are assigned to spawn points matching their team. In FFA mode, all spawn points are available to all players.

### Manifold Server Correction

Cross-referencing with the Manifold server confirmed the game mode codes. The `GameSettings` interface in Manifold's `types.d.ts` documents:

- `ga`: Game engine — `"b"` for most modes, `"f"` for Football
- `mo`: Mode — `"b"`=Classic, `"bs"`=Simple, `"ar"`=Arrows, `"ard"`=Death Arrows, **`"sp"`=Grapple**, `"v"`=VTOL
- `gt`: Game type — 1=cycle through maps, 2=win X rounds
- `tea`: Teams enabled (boolean)
- `tl`: Team lock (boolean)
- `wl`: Rounds to win
- `bal`: Balance (nerf/buff) array per player
- `q`: Quick play flag

**Previous documentation incorrectly listed `sp` as "Simple" and `bs` as "Bounce".** The correct mapping is `sp`=Grapple and `bs`=Simple. This has been corrected throughout this document.

---

## 21. rotatePoint Function (July 26, 2026)

### Definition

`rotatePoint` (constant index 1541) is a method on `t$e[61]` (the utility module). It rotates a point around the origin by a given angle:

```js
// Deobfuscated:
t$e[61].rotatePoint = function(output, point, angle) {
  var cos = Math.cos(angle);   // mqcc[484] = "cos"
  var sin = Math.sin(angle);   // mqcc[485] = "sin"
  var dx = point.x - output.x;  // delta x
  var dy = point.y - output.y;  // delta y
  return {
    x: cos * dx - sin * dy,
    y: sin * dx + cos * dy
  };
};
```

**Note:** This uses `Math.cos`/`Math.sin` directly, NOT `safeCos`/`safeSin`. The safe trig functions are used elsewhere in the physics engine. The `rotatePoint` function is used primarily for rendering (grapple anchors, arrow positions) where exact determinism is less critical.

### Usage in Grapple

```js
// From doGrapple:
var rotated = t$e[61].rotatePoint(
  { x: 0, y: 0 },              // origin
  grapplePoint,                 // local position on body
  body.a                        // body angle
);
var worldAnchor = {
  x: rotated.x + body.p[0],    // add body position
  y: rotated.y + body.p[1]
};
```

This transforms a local-space point on a rotating body into world space.

---

## 22. Arrow/Projectile System (July 26, 2026)

### Arrow Body Creation

Arrows are physics bodies with `userData.type = "arrow"`. They are created when a player fires in Arrows (`ar`), Death Arrows (`ard`), or VTOL (`v`) modes.

### Arrow UserData Fields

| Field | Index | Description |
|-------|-------|-------------|
| `type` | 52 | `"arrow"` |
| `discID` | 154 | The player who fired the arrow |
| `hitDiscsThisStep` | 155 | Array of disc indices hit this tick |
| `hitWorldThisStep` | 156 | Whether arrow hit a wall this tick |

### Arrow Lifecycle

1. **Creation**: When the special key (bit 5 = 32) is pressed in arrow mode, the game creates a new body with type "arrow" and sets `discID` to the firing player's ID.

2. **Flight**: The arrow travels as a dynamic body. Its `hitDiscsThisStep` and `hitWorldThisStep` are reset each tick.

3. **Collision (from BeginContact)**:
   - Arrow hits wall → `hitWorldThisStep = true`
   - Arrow hits disc (not owner, not same team) → `hitDiscsThisStep.push(discID)`
   - Arrow hits owner (no teams) → contact disabled (pass through)
   - Arrow hits same team (teams on) → contact disabled

4. **Death**: In Death Arrows mode (`mo == "ard"`), a disc hit by an arrow sets `diedThisStep = 1`.

5. **Destruction**: Arrows are destroyed when `lht` (last hit timer, 153) on the owning disc expires, or when they've been in flight too long.

### Arrow State Fields on Disc

The disc object tracks arrow state:
- `a1` (index 193): Arrow charging state
- `a1a` (index 119): Arrow angle accumulator
- `a2` (index 193): Secondary arrow state (dual arrow mode)

---

## 23. Football & Kick System (July 26, 2026)

### Football Constants

| Index | String | Purpose |
|-------|--------|---------|
| 5 | `footHW` | Football half-width |
| 6 | `footHH` | Football half-height |
| 7 | `footOffsetX` | Kick point X offset from disc center |
| 8 | `footOffsetY` | Kick point Y offset from disc center |
| 9 | `swingF` | Swing force |
| 10 | `swingD` | Swing damping |
| 298 | `swingJoint` | The swing joint reference |
| 603 | `swingArc` | Swing arc visualization |
| 651 | `kickPlayer` | Kick player method |
| 1509 | `ball` | Football ball reference |
| 1510 | `kickReady` | Whether kick is ready |
| 1512 | `doKick` | Kick execution method |
| 1515 | `ballReference` | Ball body reference |

### Kick Mechanics

The `doKick` function (index 1512) applies an impulse to the football:

```js
// Deobfuscated:
function doKick() {
  // Calculate kick point relative to disc
  var kickPoint = body.GetWorldPoint(
    new b2Vec2(footOffsetX * scaleRatio, footOffsetY * scaleRatio)
  );
  // Apply impulse to ball at kick point
  ball.ApplyImpulse(impulseVector, kickPoint);
}
```

The kick uses `footOffsetX` and `footOffsetY` to determine where on the player's disc the kick originates. These are multiplied by `scaleRatio` to get world-space coordinates.

### Swing System

In football mode, players have a "swing" — a joint connecting them to the ball:
- `swingF` (index 9): Force applied to maintain swing
- `swingD` (index 10): Damping on the swing
- `swingJoint` (index 298): The actual b2Joint connecting player to ball
- `swingArc` (index 603): Visual arc showing swing range

---

## 24. Box2D Settings (July 26, 2026)

### b2Settings Constants (from AS3 reference)

These are the Box2DFlash v2.1 alpha physics tuning constants. They're **not in the M$QCc constant table** — they're inlined as numeric literals in the bundled Box2D source. Values verified from `reference/bonk1-box2d/Source/Box2D/Common/b2Settings.as`:

| Constant | Value | Unit | Description |
|----------|-------|------|-------------|
| `b2_pi` | `Math.PI` | radians | Pi |
| `b2_linearSlop` | **0.005** | meters | Collision tolerance (0.5 cm) |
| `b2_angularSlop` | **2/180 × π** | radians | Angular tolerance (2 degrees) |
| `b2_toiSlop` | **0.04** | meters | CCD shrink (8 × linearSlop) |
| `b2_maxManifoldPoints` | **2** | count | Max contacts per manifold |
| `b2_aabbExtension` | **0.1** | meters | AABB fat margin |
| `b2_aabbMultiplier` | **2.0** | ratio | AABB prediction multiplier |
| `b2_polygonRadius` | **0.01** | meters | Polygon skin (2 × linearSlop) |
| `b2_velocityThreshold` | **1.0** | m/s | Inelastic collision threshold |
| `b2_maxLinearCorrection` | **0.2** | meters | Max position correction (20 cm) |
| `b2_maxAngularCorrection` | **8/180 × π** | radians | Max angular correction (8 degrees) |
| `b2_maxTranslation` | **2.0** | meters | Max body velocity per step |
| `b2_maxTranslationSquared` | **4.0** | m² | Squared max translation |
| `b2_maxRotation` | **π/2** | radians | Max rotation per step (90 degrees) |
| `b2_maxRotationSquared` | **π²/4** | rad² | Squared max rotation |
| `b2_contactBaumgarte` | **0.2** | ratio | Overlap resolution speed |
| `b2_maxTOIContactsPerIsland` | **32** | count | Max TOI contacts |
| `b2_maxTOIJointsPerIsland` | **32** | count | Max TOI joints |
| `b2_timeToSleep` | **0.5** | seconds | Time before body sleeps |
| `b2_linearSleepTolerance` | **0.01** | m/s | Sleep velocity threshold (1 cm/s) |
| `b2_angularSleepTolerance` | **2/180 × π** | rad/s | Sleep angular threshold (2 deg/s) |

### Friction & Restitution Mixing Laws

```js
// b2MixFriction: geometric mean
function b2MixFriction(friction1, friction2) {
  return Math.sqrt(friction1 * friction2);
}

// b2MixRestitution: maximum
function b2MixRestitution(restitution1, restitution2) {
  return restitution1 > restitution2 ? restitution1 : restitution2;
}
```

> **Important for bonk-rl-env**: The `box2d` npm package likely uses these same default values. However, the AS3 reference is for Box2DFlash v2.1 alpha — the JS port may differ. These values should be verified against the actual `box2d` npm package source if exact match is needed.

---

## 25. Balance/Nerf System (July 26, 2026)

### How Balance Works

The `bal` array in game settings contains per-player balance values from **-100 to +100**:
- `+100` = maximum buff (200% force)
- `0` = normal (100% force)
- `-100` = maximum nerf (0% force)

The balance is stored on the physics body's surface data as `sk` (index 227):

```js
// Deobfuscated:
if (physics.bodies.bodies[discIndex].sk) {
  // Apply balance multiplier to force
  var balance = getBalance(discIndex);  // returns -100 to 100
  if (balance !== false) {
    forceMultiplier = (100 + balance) / 100;  // 0.0 to 2.0
    force.x *= forceMultiplier;
    force.y *= forceMultiplier;
  }
}
```

The balance check uses `physics.bodies[discIndex].sk` (index 227, which we now know is the "shrink" property repurposed as a balance flag on discs). When `sk` is truthy, the balance value is looked up and applied as a force multiplier.

### Balance Application Points

Balance affects:
1. **Movement force** — Applied before `ApplyForce`
2. **Arrow impulse** — Applied before `ApplyImpulse`
3. **Grapple** — May affect grapple force (unconfirmed)

---

## 26. Force Zone (fz) Mechanics (July 26, 2026)

### Force Zone Properties

The `fz` field on body surface data (index 158) enables force zones:

```js
// Deobfuscated from death check:
if (disc.body.fz) {
  // Force zone is active
  var fzData = disc.body.fz;
  // fzData has: x (force X), y (force Y)
}
```

### Force Zone Application (from BeginContact)

When a body with `fz` enabled is contacted, the contact listener applies force:

```js
// Deobfuscated:
if (userDataA.type == "phys") {
  var bodyData = state.physics.bodies.bodies[bodyID];
  if (bodyData.fz.on) {
    var force = new b2Vec2(bodyData.fz.x, bodyData.fz.y);
    bodyB.ApplyForce(force, bodyB.GetWorldCenter());
  }
}
```

### Force Zone in Movement Code

Force zones also affect the movement force calculation. The death check (type 4) checks `disc.body.fz`:

```js
// From the death=4 check:
var outOfBounds = disc.body.GetPosition().Length() > maxDistance;
if (outOfBounds) {
  disc.diedThisStep = 4;
}
```

The force zone's `fz` property contains:
- `x`: Force X component (applied every tick while contact is active)
- `y`: Force Y component
- `on`: Whether the force zone is active

---

## 27. Complete Constant Table Summary (July 26, 2026)

All 100+ verified constant table entries, organized by category:

### Box2D Classes & Methods
| Index | String |
|-------|--------|
| 11 | b2Vec2 |
| 14 | b2BodyDef |
| 16 | b2Body |
| 17 | b2FixtureDef |
| 18 | b2Fixture |
| 19 | b2World |
| 23 | b2PolygonShape |
| 24 | b2CircleShape |
| 33 | b2DistanceJointDef |

### Box2D World Methods
| Index | String |
|-------|--------|
| 132 | SetWarmStarting |
| 182 | SetContactListener |
| 183 | novakReset |
| 184 | GetGravity |
| 185 | SetGravity |
| 214 | CreateBody |
| 221 | CreateFixture |
| 272 | CreateJoint |
| 327 | Step |
| 328 | ClearForces |

### Box2D Body Methods
| Index | String |
|-------|--------|
| 135 | GetFixtureA |
| 136 | GetFixtureB |
| 137 | GetBody |
| 138 | GetUserData |
| 160 | GetPosition |
| 163 | ApplyForce |
| 164 | GetWorldCenter |
| 203 | b2_dynamicBody |
| 224 | SetLinearVelocity |
| 233 | b2_staticBody |
| 234 | b2_kinematicBody |
| 306 | ApplyImpulse |

### Game State Fields
| Index | String |
|-------|--------|
| 2 | world |
| 3 | ftu |
| 4 | fte |
| 41 | discs |
| 42 | discDeaths |
| 43 | physics |
| 46 | ppm |
| 48 | bodies |
| 52 | type |
| 56 | fixtures |
| 58 | shapes |
| 67 | joints |
| 98 | capZones |
| 104 | spawns |
| 115 | team |
| 120 | seed |
| 124 | mm |
| 125 | m |
| 131 | globalStepVars |
| 140 | diedThisStep |
| 141 | arrayID |
| 147 | nc |
| 148 | inputState |
| 149 | gameSettings |

### Disc Fields
| Index | String |
|-------|--------|
| 39 | x |
| 40 | y |
| 49 | p |
| 64 | a |
| 107 | b |
| 115 | team |
| 119 | a1a |
| 139 | death |
| 150 | swing |
| 151 | swingCollideDestroyEvents |
| 152 | lhid |
| 153 | lht |
| 154 | discID |
| 155 | hitDiscsThisStep |
| 156 | hitWorldThisStep |
| 157 | fz |
| 158 | fz (body property) |
| 192 | action |
| 193 | a2 |
| 194 | action2 |
| 196 | ds |
| 227 | sk (balance flag) |

### Contact Listener
| Index | String |
|-------|--------|
| 134 | BeginContact |
| 139 | death |
| 142 | capzone |
| 143 | capType |
| 144 | capEvent |
| 145 | SetEnabled |
| 146 | teamGoalEvent |

### Map Settings
| Index | String |
|-------|--------|
| 66 | re |
| 114 | tea |
| 118 | mo |
| 147 | nc |
| 301 | fl |
| 326 | pq |
| 620 | gravity |
| 1195 | bh |
| 1205 | bw |
| 1243 | gd |

### Player Identity
| Index | String |
|-------|--------|
| 524 | setPlayerArray |
| 525 | setLocalPlayerID |
| 634 | hostID |
| 771 | peerID |
| 856 | playerArray |
| 903 | loop counter |
| 1119 | playerID |
| 1564 | localPlayerID |
| 1668 | localSpawnedYet |

### Disc Defaults
| Index | String |
|-------|--------|
| 951 | discFriction |
| 952 | discRestitution |
| 953 | discDensity |
| 954 | discLinearDamping |
| 955 | discRadius |
| 956 | discAllForce |
| 957 | respawn |
| 958 | noCollide |

### Serialization
| Index | String |
|-------|--------|
| 719 | decompressFromEncodedURIComponent |
| 722 | decode |
| 724 | decodeFromDatabase |
| 734 | encode |
| 736 | compressToEncodedURIComponent |
| 737 | encodeToDatabase |
| 740 | decodeInputs |
| 852 | encodeInputs |

### Football/Kick/Swing
| Index | String |
|-------|--------|
| 5 | footHW |
| 6 | footHH |
| 7 | footOffsetX |
| 8 | footOffsetY |
| 9 | swingF |
| 10 | swingD |
| 298 | swingJoint |
| 603 | swingArc |
| 651 | kickPlayer |
| 1509 | ball |
| 1510 | kickReady |
| 1512 | doKick |
| 1515 | ballReference |

### Rendering & Grapple
| Index | String |
|-------|--------|
| 479 | lineStyle |
| 503 | clear |
| 506 | lineTo |
| 582 | drawCircle |
| 1533 | scaleRatio |
| 1541 | rotatePoint |
| 1594 | specialGraphic |
| 1595 | specialRing |
| 1603 | local |
| 1615 | doGrapple |

### Input
| Index | String |
|-------|--------|
| 302 | up |
| 303 | down |
| 304 | left |
| 305 | right |
| 377 | up1 |
| 378 | up2 |
| 383 | down1 |
| 384 | down2 |
| 373 | left1 |
| 375 | left2 |
| 380 | right1 |
| 381 | right2 |
| 386 | heavy1 |
| 387 | heavy2 |
| 389 | swing1 |
| 390 | swing2 |

### Spawns
| Index | String |
|-------|--------|
| 341 | sx |
| 342 | sy |
| 343 | sxv |
| 344 | syv |
| 345 | spawnTeamInfo |
| 946 | spawnArray |
| 948 | spawnNames |

### Math
| Index | String |
|-------|--------|
| 37 | safeCos |
| 38 | safeSin |
| 117 | floor |
| 180 | abs |
| 189 | PI |
| 200 | max |
| 201 | min |
| 243 | pow |
| 484 | cos |
| 485 | sin |
| 602 | atan2 |
| 608 | sqrt |
| 989 | round |
| 1428 | ceil |
| 1490 | atan |

---

## 28. Simulator-Critical Audit and Build Compatibility (July 26, 2026)

### Evidence Status

The findings in this document were traced against the July 25, 2026 `alpha2s.js`
build and/or the bundled Box2DFlash reference. A fresh July 26 download has a
different string-packing/obfuscation layout: it does not expose the earlier
constant-table strings as ordinary source literals. Therefore, **numeric
constant-table indices are build-specific evidence**, not stable APIs. Preserve
the behavioral findings below, but re-verify an index before using it against a
new client build.

### Offline Simulator Baseline

The following values are directly relevant to the local trainer and are now
represented in `src/core/physics-engine.ts`:

| Behavior | Verified Bonk behavior | Local implementation note |
|----------|------------------------|---------------------------|
| Gravity | `b2Vec2(0, 20)` | Uses `GRAVITY_Y = 20`. |
| Solver | Low quality `Step(dt, 2, 6)`; high quality `Step(dt, 15, 15)` | The installed `box2d` v2.0 JS port only accepts `Step(dt, iterations)`, so it cannot reproduce separate position iterations exactly. |
| Warm starting | Explicitly disabled | Calls `SetWarmStarting(false)` for created and reset worlds. |
| Player disc | Radius `ppm * scaleRatio`; default `ppm = 12`, `scaleRatio = 1`; density `1`, friction `0`, restitution `0.8`, linear damping `0` | The exact scale-ratio formula remains unresolved. Local simulator uses default scale ratio 1. |
| Movement | Base force `12`, or `20` when map setting `fl` is enabled; multiplied by scale ratio | The local `fl` setting and exact coordinate-unit conversion remain unresolved. |
| Heavy/action | Movement force multiplied by `0.7`; no mass change | Local simulator now stores the state and applies the force multiplier only. |
| Out of bounds | Circular check: `sqrt(x*x + y*y) > 850 / physics.ppm` | Local simulator uses this verified default threshold. |
| Grapple reach | Maximum distance `500` in native map coordinates | Local simulator converts this through its exported-map coordinate scale. Exact raycast/anchor selection remains unresolved. |

### Map Capture Status

The requested favorites, `grapple 1v1 simple` and `Weird Death Ball`, have **not
been captured** in `maps/`. The checked-in files (`bonk_Simple_1v1_123.json` and
`bonk_Ball_Pit_524616.json`) are unrelated flattened exports. The environment's
configured WDB default file is also absent. Faithful local training cannot be
claimed until each favorite is exported from a live game with the native
body → fixture → shape hierarchy, map settings, spawns, cap zones, and joints.

### Unresolved Simulator Mechanics

These fields are known to exist in map/runtime data, but their complete
behavior has not yet been traced. Do not invent their implementation:

| Field/system | Known evidence | Missing behavior |
|--------------|----------------|------------------|
| `scaleRatio` | Per-disc multiplier for radius, movement, and rendering | Exact formula and all inputs. |
| `cf` | Per-body constant force `{x, y, ct, w}` | Application timing and absolute/relative semantics. |
| `fz` | Contacted body receives `{x, y}` force while `on` | Contact persistence and interaction with other forces. |
| `fr` | Fixed-rotation map flag | Exact Box2D application point. |
| `bu` | Anti-tunnel map flag | Collision/CCD behavior. |
| `sk` | Shape shrink flag; related balance path observed on discs | Shrink behavior and precise balance gating. |
| Timed cap zones | Type 1 initializes progress and `l * 3` limit | Tick rate, reset behavior, and ownership transitions. |
| Full hierarchy | Native map data is body → fixture → shape | Fixture creation order, per-fixture filtering, and multi-fixture mass effects. |

### Capture Requirements for the Two Training Maps

For each target favorite, save an exporter result containing `metadata`, map
settings (`re`, `nc`, `pq`, `gd`, `fl`), `physics` (`ppm`, bodies, fixtures,
shapes, joints), spawns, cap zones, and the actual game mode/team setting.
Validate `mo === "sp"`; use `tea === false` for `grapple 1v1 simple` and
`tea === true` for `Weird Death Ball`. Capture needs `codeinjector.js` to run
before the game code because active state and the Box2D world are closure-local.

---

## 29. Current-Client Runtime Recovery (July 26, 2026)

### Obfuscation Change

Current `alpha2s.js` no longer contains its property-name table as static source
strings. The table is loader-provided at runtime as `window.M$QCc`. Static
searches for names such as `Step`, `discs`, or `SetGravity` are therefore not a
valid recovery method for this build. Numeric source anchors still matched the
July 26 build, but an index must be validated against the live `M$QCc` table
before it is treated as a symbol name.

### Verified Injection Anchors

These patterns matched the July 26 build and are used by `mapexporter.js`:

| Purpose | Current source anchor | Evidence |
|---------|-----------------------|----------|
| State capture | `z[z0M[2][131]]={discs:...` | Matched once; the step function's `arguments[0]` is state and `arguments[4]` contains game settings. |
| World capture | `z0M[16]=z[z0M[2][2]];` | Matched once immediately after world creation. |
| World defaults | `new t$e[23](new t$e[1](0,20))` followed by `[132](false)` | Confirms gravity `20` and disabled warm starting. |
| Physics step | `[327](..., velocityIterations, positionIterations); [328]()` | Main path still uses `2/6`, or `15/15` when `pq == 2`, then clears forces. |
| Disc defaults | constructor assignments `[46]=12`, `[951]=0`, `[952]=0.8`, `[953]=1.0`, `[956]=12` | Confirms default PPM, friction, restitution, density, and movement-force base. |

### Exporter Evidence Capture

`Webscripts/mapexporter.js` v2.2.0 now emits `runtimeConstantTable` with each
map export. It records the complete live `M$QCc` string mapping and table
length. This preserves a build-specific deobfuscation artifact alongside the
captured map instead of relying on static numeric indices in this document.

### Installed Box2D Port Divergence

The installed `box2d` npm package is an older port. Its `b2World.Step` signature
is `Step(dt, iterations)`, so a third position-iteration argument is ignored.
It has no public `ClearForces()` method, but its island solver clears each
non-static body's `m_force` and `m_torque` after integrating velocity. This
preserves force clearing but cannot reproduce Bonk's separate `2/6` or `15/15`
iteration configuration exactly.

### Additional Native Map Flags

The following native map fields are now confirmed by the map-format source and
Box2DFlash reference, even though their complete Bonk wiring has not all been
traced:

| Field | Confirmed mapping | Local-training status |
|-------|-------------------|-----------------------|
| `fr` | Body fixed rotation (`b2BodyDef.fixedRotation`) | Not implemented. |
| `bu` | Bullet / continuous collision (`b2BodyDef.bullet`) | Not implemented. |
| `cf` | Constant force `{x, y, ct, w}`; reference controller applies force at the world center | Exact Bonk timing, torque, and relative-force behavior unresolved. |
| `fz` | Force-zone `{on, x, y}` force applied from contact logic | Persistence and coordinate semantics unresolved. |
| `sk` | Box/circle shape shrink flag | Runtime shrink behavior unresolved. |
| `rv`, `d`, `lpj`, `lsj` | Native joint variants | Local engine supports only distance-like joints. |

### Contact Callback Caveat

Bonk's Box2DFlash contact listener exposes `BeginContact`, `EndContact`,
`PreSolve`, and `PostSolve`. The local `box2d` package exposes an older
`Add`/`Persist`/`Remove`/`Result` callback API. Current evidence confirms the
Bonk `BeginContact` paths documented above; `EndContact` behavior and use of
`PreSolve`/`PostSolve` remain unverified. Do not assume contact-exit behavior
for cap zones or force zones without a runtime trace.

**Correction, July 26, 2026:** the current contact-listener source was traced
in full. `EndContact` is exactly `function(){}` and `PreSolve` is exactly
`function(contact){}` with no body. `PostSolve` has no gameplay-state effects:
it records collision impulse/audio events and accumulates camera shake. Thus
gameplay contact behavior is concentrated in `BeginContact`.

### PostSolve Effects

`PostSolve` reads the first normal impulse from a contact. It has these verified
non-physics effects:

| Contact | Effect |
|---------|--------|
| Disc ↔ disc | `normalImpulse * 1.3`; emits a `discDisc` sound event above `3.5`. |
| Disc ↔ physics | `normalImpulse * 1.2`; adds the impulse to the disc's per-tick impulse list and emits a `platBounce` sound event above `4.5`. |
| Any disc contact | Adds a clamped camera-shake vector from the manifold normal and impulse; multiplier is `1` normally, `3` for disc-disc, and `6` for arrows. |

These are relevant for observation/rendering parity but do not alter Box2D
simulation state.

### Force-Zone Correction

The earlier simplified statement that `fz` always applies `{x, y}` directly to
the other body is incomplete. The traced `BeginContact` force-zone branch:

1. Runs for a `phys` body with `fz.on === true`.
2. Disables the physical contact.
3. Computes a force using `fz.x`, `fz.y`, angle, and a zone type selector.
4. Conditionally targets disc, arrow, or physics bodies through `fz.d`, `fz.a`,
   and `fz.p` flags.

The exact type-selector values, angle transform, and continuous-overlap timing
still require a dedicated trace. A local implementation must not collapse this
to unconditional `ApplyForce({x, y})` or assume it executes only once.

### Live Runtime Constant-Table Validation

On July 26, 2026, the currently loaded `gameframe-release.html` was queried
directly through its same-origin `#maingameframe` iframe. `window.M$QCc` was an
array with **1724** entries. The following mappings were verified from the live
table, rather than inferred from static source:

| Symbol | Live index |
|--------|-----------:|
| `Step` | 327 |
| `ClearForces` | 328 |
| `SetWarmStarting` | 132 |
| `discs` | 41 |
| `physics` | 43 |
| `ppm` | 46 |
| `gravity` | 620 |
| `discFriction` | 951 |
| `discRestitution` | 952 |
| `discDensity` | 953 |
| `discAllForce` | 956 |
| `capZones` | 98 |
| `BeginContact` | 134 |
| `EndContact` | 165 |
| `PreSolve` | 166 |
| `PostSolve` | 167 |

This verifies that all four contact callback names exist in the current build.
It does **not** prove that Bonk assigns non-empty behavior to `EndContact`,
`PreSolve`, or `PostSolve`; those call sites still require tracing.

---

## 30. Complete Cap-Zone Lifecycle (July 26, 2026)

The current `alpha2s.js` cap-zone functions and post-step processing were
traced from live source. This supersedes earlier partial cap-zone notes.

### Zone Initialization

Each zone is initialized as:

```js
capZones[i] = {
  ty: map.capZones[i].ty,
  p: 0,
  l: map.capZones[i].l * 30,
  i: map.capZones[i].i,
  o: -1,
  ot: -1,
  f: -1,
};
```

`p` is progress, `l` is the tick-based limit, `i` is the fixture/cap ID, `o`
is the capture owner key, `ot` is the owner's actual team, and `f` is the
completion countdown.

### Timed Capture (`ty === 1`)

`BeginContact` calls `capEvent(discBody, capZoneFixture)` and disables the
contact. `capEvent` groups touching discs by zone ID and team for the current
tick, storing `{count, players}` per team.

Processing rules verified from the post-step loop:

| Situation | Progress / owner behavior |
|-----------|---------------------------|
| One unowned capturing entity | Set `p = 1`; set `o` to disc ID in FFA or team ID otherwise; set `ot` to the actual team. |
| Same owner remains alone | Increase `p` by `1` in FFA or by touching-disc count in team mode; clamp to `l`. |
| Enemy alone | Decrease `p` by `1` in FFA or the enemy's count in team mode. On `p <= 0`, set `p = 0` and transfer `o`/`ot` to the enemy. |
| Multiple capture entities | Decrease `p` by the combined touching count, to a minimum of zero. |
| `p >= l` | Set `f = 20`, then decrement it each tick. When `f == 0`, eliminate non-owner discs with death type `3`. |

### Instant Goals (`ty === 2..5`)

An instant goal is triggered only when a **physics body** contacts the cap-zone
physics body, not directly by a player disc. `teamGoalEvent(capType)` records a
flag. After the step, every disc whose team does not equal that cap type gets
`diedThisStep = 3`.

| Cap type | Winning team |
|---------:|--------------|
| 2 | Red |
| 3 | Blue |
| 4 | Green |
| 5 | Yellow |

### Remaining Boundary

The collision code proves cap-zone body user data contains `capzone`, `capType`,
and `capID`. The exact map-loader statement that assigns those properties to a
Box2D fixture/body has not yet been isolated. A local implementation can model
the lifecycle above once it maps each exported cap zone to its referenced
fixture geometry, but should not claim byte-for-byte loader parity yet.

---

## 32. Grapple / Swing Mechanics (2026-07-29 build)

Deep analysis of the grapple fire/tick code in `.deobf/alpha2s.pretty.js`
(physics step function at line 6920: `z[t$e[5][129]][t$e[5][128]] = function(...)`).
All line numbers reference the beautified file. This section **corrects two earlier
findings** (§17): "max grapple distance = 500" and "`fh`/`dr` on the swing object"
are both wrong — see below.

### 32.1 Fire condition & target selection — RESOLVED (not a raycast)

Fire block, lines **8147–8307**. The grapple fires when (line **8147**):

```js
if (!prevState.discs[i][150/*swing*/] && inputs[i][194/*action2*/]
    && gameSettings[118/*mode*/] == "sp" && disc[i][119/*a1a*/] > 500) {
```

Target selection is **NOT a world raycast**. It is:

1. **AABB query** (`QueryAABB`, index 312) over a box of half-extent `z0M[265] = 10`
   (world units = map units) centered on the disc (lines 8162–8179):
   ```js
   z0M[265] = 10;
   l3z[28][310/*lowerBound*/] = new b2Vec2(px - 10, py - 10);   // 8172
   l3z[28][311/*upperBound*/] = new b2Vec2(px + 10, py + 10);   // 8177
   z0M[16][312](filterCallback, aabb);                            // 8179
   ```
2. **Query filter** (lines 8148–8161) — a fixture is collected only if ALL hold:
   - `fixture.GetBody().GetUserData().type == "phys"` (line 8152) — map phys bodies only,
     **players/discs/projectiles can never be grappled**;
   - `!fixture.GetUserData()[142/*capzone*/]` (line 8152);
   - `!fixture.GetUserData()[309/*noGrapple*/]` (line 8152);
   - not a "frozen" body: `physics.bodies[arrayID][158][157]` falsy (lines 8155–8157).
3. **Candidate scoring** (lines 8181–8287): for each collected fixture shape:
   - **Circle** (vertex count 0, lines 8185–8206): closest surface point =
     `playerPos + normalize(circleCenter - playerPos) * radius`;
     distance `d = |center - playerPos| - radius`.
   - **Edge/chain** (vertex count >= 1, lines 8208–8283): per segment, the
     point-to-segment projection function (lines 8209–8261) computes the closest
     point; distance `d = |projection - playerPos|`.
   - Candidate kept only if `d < 10` (lines 8195, 8273) — the surface must be
     within **10 world units of the disc center** (≈ overlapping/touching the disc).
4. Candidates are **sorted by distance ascending** (line 8288–8295) and the first
   one passing the final gate wins (lines 8297–8306):
   ```js
   if (fixture.GetUserData()[317/*innerGrapple*/] || fixture.TestPoint(playerPos) == false) { ...attach...; break; }
   ```
   i.e. if the disc center is **inside** the shape, the grapple only attaches to
   fixtures flagged `innerGrapple` (317); otherwise any eligible fixture.

Evidence lines: QueryAABB 8179; sort 8288–8295; `TestPoint` gate 8299.

### 32.2 Anchor point & `swing` object creation — RESOLVED

On attach (lines 8300–8303):

```js
l3z[91] = new b2Vec2();
l3z[91] = candidate.b[319/*GetLocalPoint*/](candidate.wp, l3z[91]);        // body-LOCAL anchor
l3z[69] = b2Distance(playerPos, candidate.wp);                              // rest length
F6(discIndex, candidate.b.GetBody().GetUserData()[141/*arrayID*/], l3z[91], l3z[69]);
```

`F6` (lines 8541–8545) records `[bodyArrayID, localPoint, length]`; the state
serializer (lines 8756–8761) writes the disc's `swing` object:

```js
disc[i][150] = { b: bodyArrayID, p: [localPoint.x, localPoint.y], l: length };  // 8757-8761
```

So **`swing.p` is a body-local point** (via `b2Body.GetLocalPoint`), not a fixture
vertex. The world-space anchor is recomputed each render frame as
`rotatePoint({0,0}, swing.p, body.a) + body.p` (§17 lines 18268–18287). The exact
`rotatePoint` implementation (lines 38733–38751) is the standard 2D rotation:

```js
rotatePoint(origin, point, angle) {
  c = Math.cos(angle); s = Math.sin(angle);
  dx = point.x - origin.x; dy = point.y - origin.y;
  return { x: c*dx - s*dy + origin.x, y: s*dx + c*dy + origin.y };
}
```

### 32.3 `a1a` — RESOLVED: it is an energy meter, NOT a distance accumulator

`a1a` (index 119) is the grapple/special **charge meter** (range 0–1000):

- Spawn value `a1a = 1000` (line 6866); `750` for one mode (line 6876), `500` for
  another (line 6879) (modes keyed by obfuscated strings).
- Mode `"sp"` logic (lines 7339–7354, constants at lines 6983–6985:
  `z0M[91] = 500; z0M[72] = 4; z0M[44] = 3`):
  ```js
  if (swinging) { a1a -= 4 per step; if (a1a < 0) a1a = 0;
                  if (a1a < 500) { a1a = 0; swinging = false; } }  // forced release + zero
  else          { a1a += 3 per step; if (a1a > 1000) a1a = 1000; }
  ```
- Fire gate: `a1a > 500` (line 8147, `z0M[91] = 500`).
- On grapple break by collision/impact, `a1a` is zeroed (line 8767).
- Arrows modes (`ar`/`ard`): `a1a += 8` per step cap 1000 (7356–7360); on shot,
  `a1a = 500` (line 8109). Classic modes (`b`/`v`): `a1a -= 10` per step while
  `action`(192, heavy) held; `+5` otherwise (7325–7337, `z0M[17] = 10`,
  `z0M[79] = 5`).
- Max hold from full charge: (1000 − 500) / 4 = **125 steps**; recharge from 0 to
  re-fire: 500 / 3 = **167 steps**.
- The red ring in `doGrapple` (line 18327: `if (a1a < 500)`) is the
  **"charge not ready" indicator around the player**, not a range ring.
  **Correction to §17 finding #1**: the literal `500` is the a1a threshold; the
  "500 map-unit max reach" claim is wrong — actual reach is the 10-unit
  center-to-surface window of §32.1.

### 32.4 Joint stiffness — RESOLVED (corrects `fh`/`dr` claim)

The grapple joint is recreated every step from the active `swing` state
(lines 7858–7879), as a `b2DistanceJointDef` (t$e[84]):

```js
def.bodyA          = disc physics body;                    // 7866  (idx 260)
def.bodyB          = physics.bodies[swing.b];              // 7867  (idx 262)
def.localAnchorA.Set(0, 0);                                // 7868  (idx 261)
def.localAnchorB.Set(swing.p[0], swing.p[1]);              // 7869  (idx 263)
def.length         = swing.l;                              // 7870  (idx 47)
var sep = b2Distance(discBody.GetPosition(), bodyB.GetWorldPoint(swing.p));  // 7861-7864
def.frequencyHz    = (sep < swing.l) ? 0.01 : z[9 /*swingF*/];               // 7871-7875 (idx 286)
def.dampingRatio   = z[10 /*swingD*/];                                       // 7876 (idx 287)
def.collideConnected = true;                               // 7877  (idx 279)
disc[i][298/*swingJoint*/] = world.CreateJoint(def);       // 7878
```

`z[9]`/`z[10]` are the global physics `swingF`/`swingD` values. The
sidecar-backed AST writer census (`audit-map-option-writers.js`) proves exactly
two table-origin uses of each key: the sole writes at lines 3463–3464,
`swingF = 2` (Hz) and `swingD = 0`, and the grapple-joint reads at 7874/7876.
There is no source-side map merge or override writer in this build.

**Rod-spring behavior**: while the player is closer to the anchor than the rest
length (slack), `frequencyHz = 0.01` (essentially no spring force); when at or
beyond full extension, `frequencyHz = swingF` (2 Hz spring). This is the classic
rope mechanic.

**Correction to §17 "Swing State Object" table**: the swing object contains only
`b`, `p`, `l` (line 8757–8761). It has **no `fh`/`dr`**. Fixture-level `fh`/`dr`
(index 97 / 288 inside joint def data `d`) exist only on **map-defined "d"**
joints (read at lines 7822–7823: `def.frequencyHz = joint.d.fh`,
`def.dampingRatio = joint.d.dr`) — they are unrelated to the grapple.

### 32.5 Raycast — RESOLVED: not used for grapple

`world.RayCast` (index 308) appears exactly once in the step function (line 8145)
and belongs to a **different mechanic**: a short downward probe
(from disc center to `discPos + (0, radius + 0.15)`, line 8137–8144) gated by
`inputs[i][302/*up*/]` being false-ish and `|vy| < 4` (line 8114) that applies a
`vy -= 10` slam (line 8134). It rejects non-"phys", capzone(142)-, and
death(139)-fixtures. Grapple targeting itself never raycasts (§32.1).

### 32.6 Swing persistence & destruction — RESOLVED

- Per step, the swing flag survives only while the grapple key is held:
  line 7322 — `disc[i][150] = true` iff `prev.swing && (inputs[194] || inputs[202])`.
- The joint is torn down if the disc is in `swingCollideDestroyEvents` (idx 98)
  **or** its accumulated one-step contact impulse (`body.userData[170]`,
  accumulated in `PostSolve` idx 167 at lines 7161/7165) reaches **300**:
  line 8764 — swing copied to new state only if
  `swingCollideDestroyEvents.indexOf(i) == -1 && discBody.GetUserData()[170] < 300`,
  else `a1a = 0` (line 8767).
- `userData[170]` is incremented in `PostSolve` by the contact's normal impulse
  (`impulse[168/*normalImpulses*/][0]`, lines 7161/7165) on disc-vs-"phys"
  contacts; since the world is rebuilt every step it starts at 0 each step.

## 31. Force, Shrink, and Mass Mechanics (2026-07-29 build)

All evidence below is from `.deobf/alpha2s.pretty.js` (downloaded 2026-07-29).
The property-name table is runtime-provided (`window.M$QCc`); index names cited
below (`[158]`, `[213]`, …) are the literal numeric indices seen in this build's
source. Field *names* (`fz`, `cf`, `fr`, `bu`, `sk`, `on`, `x`, `y`, …) appear
verbatim in the data defaults near lines 12043–12142.

**Structural context (strongly evidenced, affects everything below):** the
step function rebuilds the Box2D world from serialized state every tick. The
world is created only once (`if (!z[z0M[2][2]]) { z[z0M[2][2]] = new t$e[23](new t$e[1](0, 20)); ... }`,
lines 6996–6998), but every invocation calls `novakReset()` (line 7236),
re-attaches the contact listener (7237), re-creates every map body through
`CreateBody` (line 7576) and every fixture through `CreateFixture` (line 7628)
from the incoming state's `physics.bodies` (whose `p`, `a`, `lv`, `av` were
written back from the previous tick's bodies at lines 8571–8579), then calls
`Step(dt, velIters, posIters)` only when the round countdown is finished
(lines 8314–8323), then `ClearForces()` (8325). Consequence: anything done in
the body-creation pass happens **every gameplay tick**, and contact events that
"begin" do so against a freshly rebuilt world.

### 31.1 `fz` — force zones — RESOLVED

Body-level `fz` object: `{on, x, y, d, p, a, t, cf}` — defaults at
lines 12050–12059:

```js
fz: { on: false, x: 0, y: 0, d: true, p: true, a: true, t: 0, cf: 0 }
```

`fz` is enforced entirely inside `BeginContact` (lines 7067–7117). For a
contact involving a `"phys"` body whose map body has `fz.on`:

1. **The contact is disabled** — the zone fixture is a pure sensor while the
   zone is on (line 7071, `contact.SetEnabled(false)` equivalent).
2. **Force vector** starts as `new b2Vec2(fz.x, fz.y)` (line 7072).
3. **Type selector `fz.t`:**
   - `t == 0` (default): raw `{x, y}`.
   - `t == 1`: `{x, y}` rotated by the zone **body's angle** (`SafeTrig.cos/sin`
     of the body's angle; lines 7073–7088).
   - `t == 2`: radial — unit vector from the zone body position to the other
     body's position, scaled by **`-fz.cf`** (repel; lines 7089–7110).
   - `t == 3`: same direction scaled by **`+fz.cf`** (attract).
4. **Target filtering:** applied to the *other* body only when
   - it is a disc and `fz.d` is truthy (line 7111, index `[71]`), or
   - it is an arrow and `fz.a` (line 7111, index `[64]`), or
   - it is a `"phys"` body and `fz.p` (line 7114, index `[49]`).
5. **Application:** `otherBody.ApplyForce(force, otherBody.GetWorldCenter())`
   (lines 7112, 7115 — indices `[163]`/`[164]`).

**Persistence/timing:** the force is applied from `BeginContact`. Because the
world is rebuilt every tick (see above), any overlapping zone re-forms its
contact and re-fires `BeginContact` every gameplay tick, so the effective
behavior is continuous application while the overlap lasts. A local
implementation that keeps a persistent Box2D world must re-apply the force
each tick of overlap (e.g. from a `Persist`/overlap check), not only once.
`fz` never acts on the zone's own body; players vs. map bodies differ only via
the `d`/`p`/`a` flags. Remaining unknown: whether `EndContact`-side cleanup or
a second force application point exists — no other `fz` reads exist in the
physics path (the only other live `fz` read is renderer styling at line 16074,
`o69.physics.bodies[h5S].fz.on`).

### 31.2 `cf` — constant force — RESOLVED (one-word caveat)

Body-level `cf` object: `{x, y, w, ct}` — defaults at lines 12043–12048:

```js
cf: { x: 0, y: 0, w: true, ct: 0 }
```

Applied in the body-creation pass (lines 7631–7644), guarded by
`z0M[93][50] && incoming state[3] == -1` — i.e. only while the round countdown
has finished (the exact same `state[3] == -1` guard gates `world.Step` at line
8314). Because the body pass runs each tick, `cf` executes **every gameplay
tick**:

```js
if (cf) {
  if (cf.x != 0 || cf.y != 0) {
    var v = new b2Vec2(cf.x, cf.y);
    if (cf.w == false) { v = body.GetWorldVector(v, v); }  // body-local -> world
    body.GetLinearVelocity().x += v.x;                      // index [255] returns a
    body.GetLinearVelocity().y += v.y;                      // mutable reference
  }
  if (cf.ct != 0) body.SetAngularVelocity(body.GetAngularVelocity() + cf.ct);
}
```

Evidence: line 8575 shows `[255]()` is `GetLinearVelocity` (its result is
serialized into body field `lv`, `[54]`); lines 7641–7643 add `ct` via
`[256]()`/`[257]` (get/set angular velocity). So `cf` is a per-tick **velocity
increment** (constant acceleration), not an `ApplyForce`; `w` selects
world-frame (`true`, default) vs body-local rotated by the body angle
(`false`); `ct` is the angular counterpart. Caveat: the two-argument call
`body[254](v, v)` matches a `GetWorldVector(out, local)`-style helper; the
exact rotation direction (local→world) is inferred, not proven.

### 31.3 `fr` — fixed rotation — RESOLVED

Map body option `fr` (default `false`, line 12070) maps directly to the body
def's fixed-rotation field (body-def index `[206]`; disc bodies set the same
field to `true` at line 7379):

- Line 7560: `fixedRot = bodyOpts[237]` (`fr`).
- Lines 7561–7569: **joint exclusion** — if any entry in `physics.joints`
  references this body (`ba == id || bb == id`), `fixedRot` is forced to
  `false`. Fixed rotation is silently overridden for jointed bodies.
- Line 7570: `bodyDef[206] = fixedRot`.

Disc bodies always get `[206] = true` (line 7379) *except* in mode `"v"`
(VTOL, line 7380–7382, set to `false`). Angular velocity is also seeded from
body field `av` (line 7557, body-def index `[209]`); with fixed rotation the
port's solver simply zeroes angular dynamics — no custom code exists. Mass
field `m_I` behavior is the port's standard Box2D handling.

### 31.4 `bu` — bullet / anti-tunnel — RESOLVED (mapping); port behavior unverifiable

Map body option `bu` maps directly to the body def's bullet field: line 7571,
`bodyDef[213] = bodyOpts[238]`. Disc bodies always set `[213] = true`
(line 7394) — every player disc is a bullet body natively. This matches
Box2DFlash `b2BodyDef.bullet` (CCD against static geometry). Whether the
bundled obfuscated port implements the full sweep/TOI solver cannot be shown
from this build's identifiers (all Box2D internals are unnamed), so the *CCD
quality* is unverifiable statically — but the wiring is direct and discs rely
on it, which is exactly where tunneling matters at the verified movement
force.

### 31.5 `sk` — shape shrink — RESOLVED (formula partially opaque)

`sk` is a per-shape flag (defaults at lines 12107 (`bx`), 12117 (`ci`),
12142 (`po`-like)): when `true`, the shape's size compounding-shrinks every
tick once the round countdown has finished.

- **Per-tick authoring** (lines 8492–8524): when outgoing `state[3] <= 0`, for
  each shape with `sk == true`, the next value is `f(0.015, prev)` where
  `prev` is the shape's dimension (`w`-field `[60]` for box, `r`-field `[62]`
  for circle) or the previous tick's shrunk value from `q$` (see below),
  clamped to a floor of **0.5** for circles and **1.0** (`2 * 0.5`) for boxes.
  Result is appended to `physics.[335]` as `[shapeID, newValue]`.
- **Chain/carrier:** `q$` (lines 8459–8471) looks up `shapeID` in the
  **incoming** state's `physics.[335]` list, so the shrink compounds tick over
  tick through the state. The outgoing state's physics gets `ss: []` plus the
  `[335]` list (lines 8490, 8510, 8521).
- **World application** (world-rebuild next tick): boxes override their half
  dimension with the listed value (lines 7479–7485); circles `SetRadius`
  directly with it (lines 7513–7518).
- **Render side:** `doShrink` (lines 16941–17016) lerps the visible width /
  radius between the previous and next frames' `[335]` values for smooth
  animation; shapes get `shrink` display objects only when flagged
  (lines 16181–16183).

`audit-training-statics.js` now re-derives the dispatcher cases from the
factory AST (rather than trusting a readable rendering): circles use
`nextRadius = max(0.5, previousRadius - 0.015)` and boxes use
`nextWidth = max(1.0, previousWidth - 0.03)`. The prior values are loaded from
`physics.ss` through `q$`; therefore repeated ticks produce a linear decrement,
not a multiplicative `prev * (1 - 0.015)` factor. Both branches run only when
`state.ftu <= 0`. This is the shrink-map mode mechanic, unrelated to player
balance; note that the earlier §25 reading ("`sk` repurposed as a balance flag
on discs") needs correction: balance (`bal`) actually adjusts the disc's
`scaleRatio` field (`+bal/clamp(-0.95..1)` added to the `1`-defaulted ratio at
lines 7313–7321, which then scales the disc's circle radius at line 7396).

### 31.6 Multi-fixture mass — RESOLVED (standard Box2D accumulation)

The fixture creation pass (lines 7577–7629) creates one `b2FixtureDef` per
fixture with per-fixture overrides and body-level fallbacks: density `[217]`,
restitution `[218]`, friction `[216]` (with the `fricp` polarity flag
negating friction at 7584–7587), collision filter computed from the body
option `f_*` flags (lines 7594–7618), and user data
`{arrayID (fixture id), color, death, noPhysics, noGrapple, innerGrapple}`
(lines 7619–7626). Each is attached with `CreateFixture` (line 7628). There is
**no** explicit `ResetMassData` call and no custom mass code anywhere in the
creation path: body mass/inertia come from the port's standard per-fixture
density accumulation. Note (7583–7587): friction (`[216]`) is clamped to
`0.0001` minimum at 7590–7592.

**Player disc mass under contact forces:** unaffected. The only contact code
that touches disc dynamics beyond collision response is `PostSolve`
(lines 7141–7232), which only records impulses for sounds and camera shake —
verified no state mutation (§29). Disc density/friction/restitution are set
once per tick at disc creation (lines 7397–7406); the only disc-dynamic
modifier found is the `scaleRatio` radius scaling (balance, §31.5) and the
heavy-state branch at lines 7363–7374.

### 31.7 Status summary

| System | Status | One-line answer |
|--------|--------|-----------------|
| `fz` force zones | RESOLVED | Sensor contact in `BeginContact`; force `{x,y}` (t=0), angle-rotated (t=1), radial ±`cf` (2=repel, 3=attract); filtered by `d/a/p`; applied via `ApplyForce(.., GetWorldCenter())` each tick of overlap in the rebuilt world |
| `cf` constant force | RESOLVED | Per-tick (`state[3]==-1`) velocity increments `lv += {x,y}` (rotated by body angle when `w==false`) and `av += ct`; constant acceleration, not `ApplyForce` |
| `fr` fixed rotation | RESOLVED | Maps to `b2BodyDef.fixedRotation`; forced off when any joint references the body; discs always fixed-rotation except VTOL mode |
| `bu` bullet | RESOLVED (mapping) | Maps to `b2BodyDef.bullet`; discs always `true`; CCD solver quality inside the obfuscated port is unverifiable |
| `sk` shrink | RESOLVED | Per-tick linear shrink: circle radius `-0.015` floor 0.5; box width `-0.03` floor 1.0; prior values are carried via `physics.ss` and `q$`, gated on `ftu <= 0`; render-side `doShrink` lerps |
| Multi-fixture mass | RESOLVED | Standard per-fixture density accumulation; no special handling; disc mass never mutated by contacts (PostSolve is audio/shake only) |

Known-opaque remainder: the `w_c`/`Q5$` expression helpers hide some exact
arithmetic (shrink factor, disc `z0M[47]` baseline), and the obfuscated
Box2D port internals (CCD sweep, `ResetMassData` timing) cannot be named
statically.

---

### 32.7 Status summary

| Item | Status |
|------|--------|
| Target selection | **RESOLVED** — QueryAABB ±10 units + surface-distance scoring + `innerGrapple`/`TestPoint` gate (no raycast) |
| Anchor math | **RESOLVED** — `swing.p` = `body.GetLocalPoint(worldPoint)`; `rotatePoint` is standard 2D rotation |
| `a1a` | **RESOLVED** — energy meter (fire >500, drain 4/step, recharge 3/step, force-release+zero below 500) |
| Joint stiffness | **RESOLVED** — `frequencyHz = sep < l ? 0.01 : swingF(2)`, `dampingRatio = swingD(0)`; `fh`/`dr` belong to map `"d"` joints only |
| Raycast eligibility | **RESOLVED** — no raycast; `type=="phys"` bodies only, capzone/noGrapple/frozen excluded, discs not grappleable |
| Map merge of `swingF`/`swingD` | **RESOLVED** — source-wide table-origin writer census finds only global defaults `2`/`0`; no map override writer exists in this build |

---

## 33. Native Map Format Details (2026-07-29 build)

Complete parser layout for tracker item H1 (native→flat converter). All evidence is
from `.deobf/alpha2s.pretty.js` (this build). **Build-compat note:** the 2026-07-29
download still uses the `M$QCc` property-table (declared line 2425, assigned line
2430, 1724 entries; `k7V = B3jF8` at line 2433), so no rename affected this file.
If a future build renames it, resolve the table structurally: the string decoder
forwards through `X_14OtK` (lines 282–287), and the numeric wrappers
`w_c`/`Q5$` are the *same* function `u2JDgBs` (object at lines 1086–1857)
parameterized by an operation selector set by the immediately preceding
`H0n(n)`/`d1M(n)` call (`W0RqtoB`, line 1853: `i38 = L_K`). E.g.
`H0n(7); Q5$(2,730)` → op 7 → `730/2 = 365`. All constants below were resolved by
evaluating those wrappers in Node.

### 33.1 Binary codec entry points (map DB / editor `.bonk` format)

| Role | Table idx | Location (beautified) | Notes |
|------|-----------|----------------------|-------|
| Encoder | 737 (`encodeToDatabase`) | 11493–11718 | Writes binary via `t$e[76]` (a ByteArray-like class), then `LZString.compressToEncodedURIComponent` (11717) |
| Decoder | 724 (`decodeFromDatabase`) | 11720–11993 | `LZString.decompressFromEncodedURIComponent` → `t$e[76].fromBase64(data,false)` (11725), sequential reads |
| Blank map | 1452 (`getBlankMap`) | 11995–12033 | `v:1, s:{re:false,nc:false,pq:1,gd:25,fl:false}, physics:{shapes,fixtures,bodies,bro,joints,ppm:12}, spawns:[], capZones:[], m:{a:"noauthor",n:"noname",dbv:2,dbid:-1,authid:-1,date:"",rxid:0,rxn:"",rxa:"",rxdb:1,cr:[],pub:false,mo:""}` |
| JSON merge | 711 (`mergeIntoNewMap`) | 12267–… | Sanitizer used by generic `decode` (722): type-checks every field against the blank map (author ≤15, name ≤25 chars, `mo` ≤5, etc.) |
| pson codec | 723 (`pson`) | 12254–12260 | `pson.encode`/`pson.decode` = generic binary object codec used by 734/722 |

The runtime sets `t$e[61].mapVersion = 15` at line 32448. Decoder throws
`"Future map version, please refresh page"` if `v > 15` (11729–11731).
The sidecar-backed writer census proves this is the only table-origin write;
the other two uses are the encoder read at 11498 and decoder gate at 11729.

I/O primitives (indices on `t$e[76]`): 922 `writeShort`/`readShort`(926),
923 `writeFloat`/`readFloat`(927), 924 `writeBoolean`/`readBoolean`(928),
925 `writeInt`/`readInt`(929), 935 `writeUint`/`readUint`(936),
1446 `writeUTF`/`readUTF`(959), 1449 `writeDouble`/`readDouble`(960).

### 33.2 Top-level binary field order (encoder 11499–11715 / decoder 11728–11992)

Order is fixed; fields gated by map version `v` as noted:

1. `v` — short
2. `s.re` — bool; `s.nc` — bool
3. `s.pq` — short (**v≥3**)
4. `s.gd` — short (**4≤v≤12**) / float (**v≥13**)
5. `s.fl` — bool (**v≥9**)
6. `m.rxn` UTF, `m.rxa` UTF, `m.rxid` uint, `m.rxdb` short, `m.n` UTF, `m.a` UTF
7. `m.vu` uint, `m.vd` uint (**v≥10**)
8. `m.cr`: short count, then UTF each (**v≥4**)
9. `m.mo` UTF, `m.dbid` int (**v≥5**); `m.pub` bool (**v≥7**); `m.dbv` int (**v≥8**)
10. `physics.ppm` — short
11. `physics.bro`: short count + shorts (body render order; copied verbatim into state, line 8488)
12. `physics.shapes` (§33.3), `physics.fixtures` (§33.4), `physics.bodies` (§33.5),
    `spawns` (§33.6), `capZones` (§33.7), `physics.joints` (§33.8)

### 33.3 Shapes (encoder parent loop 11526–11557; decoder 11794–11822)

Per shape: short type tag, then:

| Tag | `type` | Fields (all doubles unless noted) | Defaults (factories 12100–12145) |
|-----|--------|-----------------------------------|----------------------------------|
| 1 | `"bx"` box | `w`, `h`, `c[0]`, `c[1]`, `a`, `sk` bool | `{type:"bx", w:10, h:40, c:[0,0], a:0, sk:false}` |
| 2 | `"ci"` circle | `r`, `c[0]`, `c[1]`, `sk` bool | `{type:"ci", r:25, c:[0,0], sk:false}` |
| 3 | `"po"` polygon | `s`, `a`, `c[0]`, `c[1]`, short `v.length`, then `v` as `[x,y]` pairs | `{type:"po", v:[], s:1, a:0, c:[0,0]}` |
| — | `"ch"` chain | factory only (12133–12145): `{type:"ch", v:[], s:1, a:0, c:[0,0], l:false, sk:false}` — **no encoder/decoder branch; the runtime world-builder branch for `ch` is empty (line 7532). UNRESOLVED: legacy/unsupported shape; treat as non-collidable or reject.** |

World build (7467–7534): `c[0]/c[1]` ÷ppm; `bx` → `b2PolygonShape.SetAsArray` of the
4 corners computed from half-extents `w/2, h/2`, rotated by `safeCos/safeSin(a)`,
offset by `c` (7470–7509); `ci` → `b2CircleShape` with `SetRadius(r)`,
`SetLocalPosition(c)` (7510–7519); `po` → `SetAsArray(v)` if ≥3 vertices else a
fallback circle of radius 2 (7520–7531). `sk` (scale-key/balance) routes the size
(`w` for bx — note: `bx` uses `w/2` and `h/2` from indices 60/61 — and `r` for ci)
through the balance lookup `q$()` (7479–7484, 7513–7517).

### 33.4 Fixtures (encoder 11558–11592; decoder 11823–11859)

Order per fixture: `sh` short (shape index), `n` UTF, `fr` double
(`null` ↔ `Number.MAX_VALUE`), `fp` short enum (0=null, 1=false, 2=true),
`re` double (nullable same), `de` double (nullable same), `f` uint (color,
default `0x4F7CAC`), `d` bool (death), `np` bool (noPhysics), `ng` bool (**v≥11**),
`ig` bool (**v≥12**).
Factory default `{sh:arg, n:"Def Fix", fr:0.3, fp:null, re:0.8, de:0.3,
f:0x4F7CAC, d:false, np:false, ng:false}` (12083–12097; `ig` persisted only v≥12).

World build per fixture (7577–7628):

```js
fd.friction    = fix.fr != null ? fix.fr : body.s.fric;
var pol        = fix.fp != null ? fix.fp : body.s.fricp;
if (pol) fd.friction = -fd.friction;                  // negative = velocity-independent friction
fd.restitution = fix.re != null ? fix.re : body.s.re;
fd.density     = max(fix.de != null ? fix.de : body.s.de, 0.0001);
fd.filter.categoryBits = Math.pow(2, body.s.f_c) * 2;        // 2^(f_c+1)
fd.filter.maskBits     = 65535;                            // 7603-7618:
  if (!body.s.f_p) maskBits -= 1;  if (!body.s.f_1) maskBits -= 4;
  if (!body.s.f_2) maskBits -= 8;  if (!body.s.f_3) maskBits -= 16;
  if (!body.s.f_4) maskBits -= 32;
fd.userData = { arrayID: fixtureIndex, color: fix.f, death: fix.d,
                noPhysics: fix.np, noGrapple: fix.ng, innerGrapple: fix.ig };
fd.shape = createdShapes[fix.sh];
```

Fixtures with `np == true` are skipped entirely (7579–7581); a body whose fixtures
are **all** `np` is forced static (7540–7547).

> **Port divergence (#276): negative/`f_p` friction is clamped to 0.**
> The engine (`src/core/physics-engine.ts`, `addBody`) clamps every authored
> friction to ≥ 0 (negative and non-finite values become 0) and makes `f_p`
> (fricPolarity) surfaces **frictionless (0)** instead of negative. This is
> forced because the native "negative = velocity-independent friction" trick
> (line 3267) only works with the native disc friction of 0:
> `b2MixFriction = sqrt(f1*f2)` yields `-0` natively but `NaN` here, since this
> port's disc friction is positive (`PLAYER_FRICTION = 0.001337`), and a NaN
> contact mix corrupts the disc's position on the first contact tick (#276).
>
> For disc-vs-surface contacts `sqrt(0 · 0.001337) = 0` reproduces the native
> frictionless effect. For **map-vs-map contacts** the clamp diverges: two
> `friction: -1` fixtures now mix to `sqrt(0 · 0) = 0` instead of the native
> `sqrt(-1 · -1) = 1`, so friction:-1 obstacles contacting each other lose all
> friction relative to the reference client. Zeroing the surface is the only
> finite option given the verified positive disc friction; the fidelity P1 test
> (`tests/integration/physics-fidelity-p1.test.ts`) codifies friction 0 as the
> `f_p` behavior.

### 33.5 Bodies (encoder 11593–11636; decoder 11860–11907)

Order per body: `s.type` UTF (`"s"|"d"|"k"`), `s.n` UTF, `p[0]` `p[1]` doubles,
`a` double, `s.fric` double, `s.fricp` bool, `s.re` double, `s.de` double,
`lv[0]` `lv[1]` doubles, `av` double, `s.ld` double, `s.ad` double, `s.fr` bool
(fixed-rotation request), `s.bu` bool (bullet), `cf.x` `cf.y` `cf.ct` doubles,
`cf.w` bool, `s.f_c` short, `s.f_1`..`s.f_4` bools, `s.f_p` bool (**v≥2**),
force-zone block (**v≥14**): `fz.on` bool, then `fz.x` `fz.y` doubles, `fz.d`
`fz.p` `fz.a` bools, and (**v≥15**) `fz.t` short, `fz.cf` double,
then short `fx.length` + shorts (fixture indices).

Defaults (`getNewBody` 12034–12081):
`{p:[0,0], a:0, lv:[0,0], av:0, cf:{x:0,y:0,w:true,ct:0}, fx:[],
 fz:{on:false,x:0,y:0,d:true,p:true,a:true,t:0,cf:0},
 s:{type:"s", n:"Unnamed", fric:0.3, fricp:false, re:0.8, de:0.3, ld:0, ad:0,
    fr:false, bu:false, f_c:1, f_p:true, f_1:true, f_2:true, f_3:true, f_4:true}}`

`createNewState` normalization (6389–6410):
`p[0] = (p[0]+365)/ppm; p[1] = (p[1]+250)/ppm` (editor canvas is 730×500, origin
at top-left, world origin = canvas center); `cf.x/cf.y/cf.ct /= 30` (fixed 30 —
not ppm); **static bodies**: `cf` zeroed, `lv=[0,0]`, `av=0` (6402–6409,
`type == "s"`).

World build (7536–7645):

```js
def.type = s.type=="s"||allFixturesNP ? b2_staticBody
         : s.type=="d" ? b2_dynamicBody
         : s.type=="k" ? b2_kinematicBody;      // 7547-7553
def.position.Set(p[0],p[1]); def.angle = a;
def.linearVelocity.Set(lv[0],lv[1]); def.angularVelocity = av;
def.linearDamping = s.ld; def.angularDamping = s.ad;
def.fixedRotation = s.fr && !anyJointReferencesThisBody;   // 7560-7570
def.bullet = s.bu;
def.userData = { type:"phys", arrayID: bodyIndex };
CreateBody → CreateFixture per fx entry → SetLinearVelocity(lv)   // 7630
// one-shot constant force/torque, only on the initial state (ftu == -1), 7631-7645:
if (cf.x != 0 || cf.y != 0) {
  var v = new b2Vec2(cf.x, cf.y);
  if (cf.w == false) v = body.GetWorldVector(v);   // w=true ⇒ already world frame
  body.GetLinearVelocity() += v;
}
if (cf.ct != 0) body.SetAngularVelocity(body.GetAngularVelocity() + cf.ct);
```

### 33.6 Spawns (encoder 11637–11651; decoder 11909–11924; factory 12238–12253)

Binary order per spawn: `x`, `y`, `xv`, `yv` doubles, `priority` short,
`r`, `f`, `b`, `gr`, `ye` bools, `n` UTF.
Default: `{x:400, y:300, xv:0, yv:0, priority:5, r:true, f:true, b:true,
gr:false, ye:false, n:"Spawn"}`.
**Note:** on-disk spawns are `{x,y,xv,yv,...}`, not `{sx,sy,...}`; the `sx`/`sy`/
`sxv`/`syv`/`spawnTeamInfo` keys exist only on the runtime disc objects
(see below), which answers the H3 field-name question.

`createNewState` processing (6732–6886):

```js
spawns = deepCopy(map.spawns);
hasGr = any(spawn.gr); hasYe = any(spawn.ye);
if (!hasGr) for each spawn: spawn.gr = spawn.r;    // 6747-6749
if (!hasYe) for each spawn: spawn.ye = spawn.b;    // 6750-6752
for each spawn:
  spawn.x  = (spawn.x  + 730/2) / ppm;  // == (x+365)/ppm   6763
  spawn.y  = (spawn.y  + 500/2) / ppm;  // == (y+250)/ppm   6770
  spawn.xv /= ppm;  spawn.yv /= ppm;                  // 6771-6772
  seed = seed*7 % 101;  spawn.priority += (seed % 10) / 10;   // 6775-6783 (deterministic tiebreak)
spawns.sort((a,b) => b.priority - a.priority);      // 6784-6796
```

Assignment (6820–6886): players are removed from the candidate list in modes that
restrict spawn teams (`Y00[0][5][114]`/`tea`); a spawn can serve team `ty` iff
`(ty==1 && spawn.f) || (ty==2 && spawn.r) || (ty==3 && spawn.b) ||
(ty==4 && spawn.gr) || (ty==5 && spawn.ye)` (6824, 6839). Players are dealt to
matching spawns randomly until exhausted (each spawn used once per pass). Each
spawned disc (6855–6874):

```js
{ x,y, xv,yv, sx,sy, sxv,syv, a:0, av:0, a1a:1000, team,
  a1:false, lhid:-1, lht:0, ds:0, da:270, vt:0 }
// a1a = 750 if mode "ar" (6875-6877), 500 if mode "ard" (6878-6880)
```

The spectator/preview path adds `spawnTeamInfo: {f, r, b, gr, ye}` verbatim
(38148–38155) and resolves display team as `r?2 : b?3 : gr?4 : ye?5 : 1`
(38124–38133; preview variant 11454–11461 skips spawns with all team flags false).

### 33.7 Cap zones (encoder 11652–11659; decoder 11925–11934; factory 12230–12237)

Binary order per zone: `n` UTF, `l` double, `i` short (fixture index),
`ty` short (**v≥6**). Default: `{n:"Cap Zone", ty:1, l:10, i:-1}`.

Runtime init in `createNewState` (6714–6731):

```js
for zone of map.capZones:
  if (usedFixtureIds.indexOf(zone.i) > -1) continue;      // one zone per fixture
  if (!map.physics.fixtures[zone.i]) continue;            // fixture must exist
  state.capZones.push({ ty: zone.ty, p: 0, l: zone.l * 30, i: zone.i, o: -1, ot: -1, f: -1 });
```

(`l*30` = seconds→ticks at 30 TPS. Confirms prior finding.) Zone *positioning is
inherited from the referenced fixture* — the fixture's own Box2D geometry (with
its own shape offset via `SetLocalPosition`) becomes the sensor; nothing is placed
at the body center (directly answers R2M9). After all fixtures are built, the
loop at 7847–7857 tags them:

```js
for zone of map.capZones:
  if (createdFixtures[zone.i]) {
    ud = createdFixtures[zone.i].GetUserData();
    ud.capzone = true; ud.capID = zoneIndex; ud.capType = zone.ty;
  }
```

### 33.8 Joints (encoder 11660–11715; decoder 11935–11991; factories 12146–12229)

Type tags: 1=`rv`, 2=`d`, 3=`lpj`, 4=`lsj`, 5=`g`. On-disk joint fields:

| Tag | Object | Binary order (doubles unless noted) | Defaults |
|-----|--------|--------------------------------------|----------|
| 1 | `{type:"rv", d:{la,ua,mmt,ms,el,em,cc,bf,dl}, ba, bb, aa:[0,0]}` | `d.la, d.ua, d.mmt, d.ms, d.el(b), d.em(b), aa[0], aa[1]` +common | revolute |
| 2 | `{type:"d", d:{fh,dr,cc,bf,dl}, ba, bb, aa:[0,0], ab:[0,0]}` | `d.fh, d.dr, aa[0..1], ab[0..1]` +common | distance |
| 3 | `{type:"lpj", d:{cc,bf,dl}, ba, bb, pax,pay,pa,pf,pl,pu,plen,pms}` | `pax, pay, pa, pf, pl, pu, plen, pms` +common | path (piston) |
| 4 | `{type:"lsj", d:{cc,bf,dl}, ba, bb, sax,say,sf,slen}` | `sax, say, sf, slen` +common | springy line |
| 5 | `{type:"g", n:"Gear Joint", ja:-1, jb:-1, r:1}` | `n` UTF, `ja` short, `jb` short, `r` double (no common block) | gear |

Common block (all but `g`), read **after** the type-specific fields:
`ba` short, `bb` short, `d.cc` bool, `d.bf` double, `d.dl` bool.

`ba`/`bb` are body indices into `physics.bodies`; `-1` = static ground body
(`-2` normalized to `-1` first, 6498–6503).

#### createNewState joint normalization (6460–6712)

- Any non-`g` joint with `d.bf > 0`: `d.bf /= ppm²` (6494–6497).
- `rv`: `aa /= ppm`; then local anchors are recomputed from world positions:
  `ab = worldAnchor(aa+bodyA.p given anchor offsets) - bodyB.p`, each rotated by
  −body angle (6519–6580); `ra = angleB − angleA`; **Y-flip:** `d.la = −d.la`,
  `d.ua = −d.ua`, `d.ms = −d.ms`, then swap if `la > ua` (6590–6597).
- `d`: `aa, ab /= ppm`; if `bb == -1`, `ab += [365/ppm, 250/ppm]` (6622–6627 —
  ground anchors use map-px coords); `len = distance(world anchor A, world
  anchor B)` with each anchor rotated by its body angle (6656–6695), `len→0.01`
  if 0; then `d.fh = d.fh == 0 ? 0.0001 : 1 / d.fh` (6696–6707).
- `p` (editor "platform"): `aa, ab /= ppm`; `d.ut /= ppm`; `d.lt /= ppm`;
  `d.mmf /= ppm³; d.mmf *= 12³ * 10 (=17280)`; `d.ms /= ppm; d.ms *= 12`
  (6466–6479); axis stored as `axa` is rotated: `θ = atan2(axa[1],axa[0]) −
  bodyA.a; axa = [1, safeTan(θ)]` (6599–6606); `ra = angleB − angleA`; `cs = 0`.
- `lpj`: `pax = bodies[ba].p[0]; pay = bodies[ba].p[1]` (anchor is forced to body
  A's origin, 6505–6507); `plen /= ppm; pms /= ppm; pf /= ppm²`.
- `lsj`: `sax = bodies[ba].p[0]; say = bodies[ba].p[1]` (6512–6514);
  `slen /= ppm; sf /= ppm²`.

#### World construction (7648–7845)

`CreateJoint` output is cached per joint index so `g` joints can reference them.

**rv** (t$e[27] = `b2RevoluteJointDef`, 7762–7780):
`bodyA, bodyB, localAnchorA.Set(aa), localAnchorB.Set(ab),
 enableLimit = d.el, lowerAngle = d.la, upperAngle = d.ua,
 enableMotor = d.em, motorSpeed = d.ms, maxMotorTorque = d.mmt,
 collideConnected = (d.cc === true)`.

**d** (t$e[84] = `b2DistanceJointDef`, 7815–7829):
`localAnchorA/aa, localAnchorB/ab, length = joint.len, frequencyHz = d.fh
 (post-normalization: 0.0001 or 1/period), dampingRatio = d.dr,
 collideConnected = (d.cc === true)`.

**lpj** (constructed with `b2PrismaticJointDef`, 7653–7697):
```js
var ang = joint.pa - bodyA.GetAngle();
axis = (safeCos(ang), safeSin(ang));
def.bodyA = A; def.localAnchorA = new b2Vec2();          // (0,0)
def.bodyB = B; def.localAnchorB = new b2Vec2(pax, pay);
def.referenceAngle   = -bodyA.GetAngle();
def.upperTranslation = +plen; def.lowerTranslation = −plen;
def.enableLimit = true;  def.localAxisA = axis;
def.enableMotor = true;  def.maxMotorForce = pf;  def.motorSpeed = pms;
// initial-side fix (7672-7696):
anchorWorld = (pax + safeCos(pa)*(−plen), pay + safeSin(pa)*(−plen));
rel = bodyA.GetPosition().Copy(); rel.Subtract(anchorWorld);
k = rel.Length() / (plen*2);  k = (k − 0.5) * 2;
if ((pms < 0 && k > 0.99) || (pms > 0 && k < −0.99)) { def.motorSpeed = −pms; bodyA.SetLinearVelocity(0,0); }
```

**lsj** (constructed with `b2PrismaticJointDef` again — springy variant, 7699–7760):
```js
def.bodyA = A; def.localAnchorA = new b2Vec2();
def.bodyB = B; def.localAnchorB = new b2Vec2(sax, say);
def.referenceAngle   = -bodyA.GetAngle();
def.upperTranslation = +slen; def.lowerTranslation = −slen;
def.enableLimit = false;
def.localAxisA = new b2Vec2(0, 1);                        // vertical-axis spring
def.enableMotor = true;  def.motorSpeed = 300;
// initial-side spring bias (7718-7756):
θ  = bodyA.GetAngle() − Math.PI/2;
anchorWorld = (sax + safeCos(θ)*(−slen), say + safeSin(θ)*(−slen));
rel = bodyA.GetPosition().Copy(); rel.Subtract(anchorWorld);
len = rel.Length();
φ  = safeATan2(rel.y, rel.x) − bodyA.GetAngle();  φ %= 2π;
if (!((φ < 0 && φ >= −π) || φ > π)) len = −len;          // side of axis
k = len / (slen*2);  k = (k − 0.5) * 2;
def.maxMotorForce = sf * |k|;
if (k > 0) def.motorSpeed = −300;
```

**p** (constructed with `b2PrismaticJointDef`, 7781–7813): anchors `aa`/`ab`, `localAxisA =
joint.axa`; `enableLimit = d.el; lowerTranslation = d.lt; upperTranslation = d.ut;
enableMotor = d.em; motorSpeed = d.ms; maxMotorForce = d.mmf;
collideConnected = (d.cc === true)`. Post-create: if `d.cd && d.el` and the joint
starts ≥99% into translation `ut` (resp. `lt`) with `cs∈{0,1}` (resp. `{0,2}`),
motor speed is inverted and `changeSide` set to 2 (resp. 1); userData
`{changeSide: cs}` (7800–7813).

**g** (t$e[26] = `b2GearJointDef`, 7836–7843): `joint1 = created[joint.ja],
joint2 = created[joint.jb], bodyA/B from those joints, ratio = joint.r`;
skipped if either referent wasn't created.

### 33.9 Notes for the Box2D v2.0 port

- The current client constructs the native path/platform/spring family
  (`lpj`, `p`, `lsj`) with `b2PrismaticJointDef` (readable bundle
  `6272`, `7544-7681`). A port should use `b2PrismaticJoint` directly for
  `lpj`/`p` (same fields: localAxisA, translations, motor) and emulate `lsj`
  with a translation-proportional force (native `maxMotorForce = sf*|k|`,
  motorSpeed ±300) or a custom joint.
- `d.fh` on disk is a **period** (seconds/oscillation); runtime converts to Hz
  via `fh = 1/period` (0 stays 0.0001).
- Joint-attached bodies silently lose `fixedRotation` (7560–7570).

### 33.10 Unresolved

- `ch` (chain) shapes: factory exists, but no encoder/decoder/runner support in
  this build (empty branch at 7532). Treat as invalid input.
- Exact body/factory `ig` default when `< v12` (factory literal lacks `ig`;
  merge/new-fixture path leaves it `undefined` → falsy).

---

## 34. Build Drift Audit + scaleRatio Resolution (2026-07-29 build)

All line numbers reference `.deobf/alpha2s.pretty.js` (2026-07-29 build,
41326 lines). Index values were **verified by execution**, not by reading:
lines 1–2430 of the beautified file were run in Node (with a
`var B3jF8 = {};` preamble, stopping before the `requirejs(...)` call at
line 2431) and the fully decoded `M$QCc` array was dumped. Result:
**1724 entries** (July build had the same table name and decoder scheme).

### 34.1 Where the property-name table lives

- `B3jF8[131198]` (line 1) — global-object resolver (`globalThis`, else
  `Object.prototype.Bp$VV` getter trick, else `window`).
- `B3jF8.P1rhls = P1rhls` (line 54; function at 2427–2429) — returns one
  giant `%XX`-escaped string; this is the decoder seed.
- `w4fh5_` (line 1865) — string/RegExp/Math helper setup.
- Decoder wrappers: `B3jF8.w65` (line 282) and `B3jF8.U3q` (line 285) both
  delegate to `B3jF8[183345].X_14OtK`.
- **The table itself is materialized at line 2430**:
  `M$QCc = [B3jF8.w65(2886), B3jF8.U3q(2541), B3jF8.U3q(4418), ...]`.
  `w65`/`U3q` take a *string-table offset* and return the decoded property
  name; the position of the call in the array literal is the runtime index.

### 34.2 Index drift table — ZERO drift

Every index re-derived for this audit is **identical** to the July 25–26
values:

| Property | July index | 2026-07-29 index | Status |
|---|---|---|---|
| `step` (prototype fn) | 128 | 128 | ✅ same |
| `Step` (b2World) | 327 | 327 | ✅ same |
| `ClearForces` | 328 | 328 | ✅ same |
| `SetWarmStarting` | 132 | 132 | ✅ same |
| `BeginContact` | 134 | 134 | ✅ same |
| `EndContact` | 165 | 165 | ✅ same |
| `PreSolve` | 166 | 166 | ✅ same |
| `PostSolve` | 167 | 167 | ✅ same |
| `discs` | 41 | 41 | ✅ same |
| `physics` | 43 | 43 | ✅ same |
| `ppm` | 46 | 46 | ✅ same |
| `capZones` | 98 | 98 | ✅ same |
| `capzone` (fixture UD) | 142 | 142 | ✅ same |
| `players` | 121 | 121 | ✅ same |
| `scaleRatio` | 1533 | 1533 | ✅ same |
| `discFriction`/`discRestitution`/`discDensity`/`discAllForce` | 951/952/953/956 | 951/952/953/956 | ✅ same |
| `world` | 2 | 2 | ✅ same |
| `globalStepVars` | 131 | 131 | ✅ same |
| `pq` (physics quality) | 326 | 326 | ✅ same |
| `gravity` | 620 | 620 | ✅ same |
| `capzone o/ot/l/p/f/i/ty` | 330/331/103/49/116/100/102 | same | ✅ same |

### 34.3 How to re-derive indices on the next build

1. Open `alpha2s.pretty.js`. The first statement is
   `<NAME>[131198] = (function(){...})();` — `<NAME>` is the decorator
   object for this build (today: `B3jF8`).
2. Find the table materialization: search for `= [<NAME>.` — today it is
   the single giant line **2430** (`M$QCc = [B3jF8.w65(2886), ...]`),
   immediately before the top-level `requirejs([...])` call.
3. Extract lines 1 through that line into a temp file, prepend
   `var B3jF8 = {};`, append
   `console.log(M$QCc.map((s,i)=>i+"\t"+s).join("\n"))`, and run with
   Node. Every index is now known. (The header is self-contained — no
   DOM, no network.)
4. If the table name or the `M$QCc` assignment shape changes, the
   fallback anchor is the `requirejs(` call: the table is always the
   large array literal immediately preceding it.

### 34.4 Webscript hook audit — all anchors still valid

| Hook | File:line | Anchor | Today's location | Status |
|---|---|---|---|---|
| State-creation patch | `mapexporter.js:592`, `bonkbot.js:744`, `bonkhost.js:1767` | regex `...]={discs` | pretty **6986** `z[z0M[2][131]] = { discs: z0M[4], ...` | ✅ matches |
| Literal solver iterations | `mapexporter.js:639` | `\[327\]\]\([^;]*?,(\d+),\s*(\d+)\)` | pretty **14170**: `[3][327]](k7V.w_c(E82[0][3],1),2,6)` — main call at **8322** still uses variable iterations, so the regex's first hit is unchanged | ✅ 2/6 |
| Defaults `gravity=20`, `ppm=12` | `mapexporter.js:647` | `[620]]=N;...[46]]=N` | pretty **10578–10579** | ✅ |
| High-quality iterations | `mapexporter.js:655` | `[326]]==2){...=N;...=N;` | pretty **8317–8319** (`pq==2 → 15,15`) | ✅ |
| World capture | `mapexporter.js:673` | `X[16]=Y[Z[2][2]];` | pretty **7235** `z0M[16] = z[z0M[2][2]];` | ✅ |
| Gravity b2Vec2 | `mapexporter.js:628` | `new X[1](0, N)` | pretty **6997** `new t$e[1](0, 20)` (also 7239) | ✅ 20 |
| `codeinjector.js` | whole file | intercepts `alpha2s.js` script tag only; no index dependence | — | ✅ unaffected |

`bonkbot.js`/`bonkhost.js` otherwise consume runtime state via literal
property names (`state.discs`, `state.physics.ppm`, ...) which are plain
identifiers in the game-state object and are unchanged. **No stale lines.**

### 34.5 `scaleRatio` — RESOLVED

Previous sections (mid-document notes around the movement/force and
rendering analyses) left the formula as
`Math.METHOD1 * body.plen * body.PROP2 / (Math.METHOD2 * c1 * c2)` and
described `scaleRatio` as a "per-player property" — **both are wrong.**

`scaleRatio` is a **renderer-global zoom factor** computed once per
`resizeRenderer()` (pretty **16431–16459**):

```js
resizeRenderer() {
  this.domLastWidth  = this.domContainer.offsetWidth;   // 16434 (1560/1555/513)
  this.domLastHeight = this.domContainer.offsetHeight;  // 16435 (1561/514)
  var LIMIT = 730/500;                       // 16437: H0n(7); w_c(500,730)  → op7  = b/a = 1.46
  var W     = 1550/1*2-13-1527;              // 16439: d1M(55); w_c(1,1527,13,1550,2) → op55 = 1560
  var H     = 9366-7805;                     // 16441: H0n(0); Q5$(9366,7805) → op0  = 1561
  var aspect = this[W] / this[H];            // 16442
  var w, h;
  if (aspect > 1.46) { h = this[H]; w = 1.46 * h; }   // 16445–16448 (op41: a*b)
  else               { w = this[W]; h = w / 1.46; }   // 16450–16452 (op7: b/a)
  this.scaleRatio = w / 730;                 // 16455: d1M(7); Q5$(730, w)   → op7
  this.renderer.resize(w, h);                // 16456
  ...
}
```

Dispatcher ops (object `B3jF8[239984]`, function `u2JDgBs`, pretty
**1086–1857** — same as July): op0 `a-b` (1127), op7 `b/a` (1670–1671),
op41 `a*b` (1535–1536), op55 `d/a*e-c-b` (1466–1467). `1.46` is the
fixed canvas aspect `730:500`; `1560`/`1561` are the table indices for
`domLastWidth`/`domLastHeight`.

So:

```
scaleRatio = fittedCanvasWidthPx / 730
fittedCanvasWidthPx = offsetWidth            if offsetWidth/offsetHeight <= 1.46
                    = 1.46 * offsetHeight    otherwise
```

Relation to `ppm` and disc radius: the world is drawn so that **730 map
pixels** span the fitted canvas width. A disc of radius `r` body-units
(circle shape radius `ppm * r` map px, default `ppm=12`, `r=1` → 12 px)
is rendered at `scaleRatio * ppm * r` device px (pretty **16154**:
`renderRadius = physics.ppm * this.scaleRatio`; **16171–16172** line
widths `2 * scaleRatio`; **16514/16545** it is passed into the disc/arrow
graphic constructors — the per-graphic `this.scaleRatio = arguments[1]`
(pretty **16052**) is just this same global value copied in, hence the
earlier "per-player" misconception). `scaleRatio == 1` exactly when the
fitted canvas is 730 px wide. It does **not** depend on `plen` (that
1566-row belongs to arrow-line drawing at **16134–16135**), disc radius,
or balance: `balance`'s radius effect is applied elsewhere on the shape
radius; `scaleRatio` is pure view zoom. Physics code never reads it —
all physics-side uses of the 1533 index are in renderer classes.

### 34.6 Timed cap-zone cross-check (2026-07-29 build) — §30 CONFIRMED, 3 refinements

Zone init (pretty **6714–6731**) matches §30 exactly
(`{ty, p:0, l:map.l*30, i:map.i, o:-1, ot:-1, f:-1}`), with additions:

- A zone is initialized **only if** `physics.fixtures[mapZone.i]` exists
  and `mapZone.i` was not already seen this load (dedup list `Y00[78]`,
  **6718**). `i` is confirmed to be the **fixture array ID** — the lookup
  at 6718 is `physics[43/*physics*/][56/*fixtures*/][zone[100/*i*/]]`.
- **No engine default for `l`**: init does `l: zone[103/*l*/] * 30`
  verbatim (6722); a map JSON omitting `l` yields `NaN`. The *map editor*
  default is `l: 10` (→ 300 ticks) in `getNewCapZone` (pretty
  **12230–12237**).

Post-step processing (pretty **8345–8443**) matches §30's rule table:

- Grouping loop 8352–8361: `z0M[945]` is the per-team contact groups for
  the zone from `capEvent`; group `[1]` is the FFA group and counts each
  player individually (`747 += group.count`), other groups count as one
  entity (`747++`); `z0M[344]` = lone capturer disc ID; `z0M[664]` = total
  touching count.
- **Contested (747 > 1), 8363–8379**: progress decreases by the combined
  touching count *only if the current owner `o` is NOT among the touchers*
  (owner-presence check 8366–8371 against `group[1].players`); if the
  owner is touching, nothing happens. Clamped at 0 (8373–8374), plays
  `"capDecrease"` only when not clamped (8376). This refines §30's
  "Multiple capture entities → decrease" row with the owner-touching
  exemption.
- Single entity (747 == 1), 8380–8413: `o` is set to the disc ID when the
  disc's `team == 1` (FFA) and to the team number otherwise (8381–8385);
  `ot` always stores the disc's actual team (8389/8401). Unowned →
  `p = 1` and claim (8386–8390). Enemy alone → `p -= teams ? count : 1`
  (8392–8396; flag is `gameSettings.tea`, index 114); on `p <= 0` →
  `p = 0` and ownership transfers to the enemy (8398–8402). Owner alone →
  `p += teams ? count : 1`, clamped to `l` (8403–8412).
- Completion (8418–8443): while `p >= l` — if `f == -1`, set `f = 20` and
  emit `"capComplete"` (8421–8423); else if `f != 0`, `f--` (8425); else
  (`f == 0`) eliminate: `ot == 1` (FFA) → every disc with
  `discID != o` gets `diedThisStep = 3` (8427–8432); teams → every disc
  with `team != ot` (8433–8439). Note the elimination is re-evaluated
  every tick that `p >= l && f == 0` holds.
- Instant goals unchanged: flags array consumed at **8444–8452** (any
  disc whose `team != capType` gets `diedThisStep = 3`).
- `ot` on reset: initialized `-1` (6725); on state snapshots it is copied
  through verbatim (8340) — its only gameplay role is the FFA/team
  elimination branch above (8427/8435). §30's description stands.

---

## 35. Arrows, Football, VTOL, Balance (2026-07-29 build)

All line numbers reference `.deobf/alpha2s.pretty.js` (2026-07-29 build).
All index/constant and arithmetic-helper values were **resolved by Node
execution** of lines 1–2430 (the `M$QCc` table and the `u2JDgBs` numeric
dispatcher, see §34.3): constants below are printed from live evaluation of
`H0n(op); Q5$(...)` / `d1M(op); w_c(...)` exactly as they appear at the call
sites. Relevant resolved `M$QCc` names:

```
118=mo 119=a1a 191=a1 192=action 193=a2 194=action2 195=radius 196=ds
197=da 198=vt 199=bal 223=body 302=up 303=down 304=left 305=right
306=ApplyImpulse 127=projectiles 4=fte 154=discID(did)
155=hitDiscsThisStep 156=hitWorldThisStep 348=destroyThisStep
214=CreateBody 300=SetAsBox 242=isSensor
1510=kickReady 1511=applyInputs 1512=doKick 1513=clampToPitch
107=b 111=sort 116=f 146=teamGoalEvent 144=capEvent 140=diedThisStep
216=density 217=friction 218=restitution 219=categoryBits
```

**Index-label correction (verified against live table):** `216` decodes to
`density`, `217` to `friction`, `218` to `restitution`. This validates §33.4's
pseudocode column assignment but reverses the labels in §31.6's prose: the
`fricp` polarity negation at lines 7584–7587 applies to **friction `[217]`**,
and the `0.0001` floor at lines 7590–7592 applies to **density `[216]`**.

### 35.1 Arrow / projectile system — modes `"ar"` / `"ard"` — RESOLVED

**Charging & firing (per-disc, lines 8084–8112 and 7930–7963):**

```js
// 8084-8111
if (mo == "ar" || mo == "ard") {
  if (input.action2) {                          // 8085
    if (disc.a1a == 1000) {                     // 8086 — exact-equality gate
      if (disc.ds == 0) disc.ds = 1;            // 8087-8088 — start charge at 1
      else { disc.ds += 1;                      // 8090 (z0M[14]=1, line 6982)
             disc.ds = Math.min(100, disc.ds); } // 8091
      if (input.left)  disc.da -= 5;            // 8093-8094 (z0M[73]=5, line 6952)
      if (input.right) disc.da += 5;            // 8096-8097
      // da wrapped into [0,360), 8099-8104
    }
  } else {
    if (disc.ds != 0) {
      fireArrow(discID, disc.ds, disc.da * (Math.PI / 180));  // 8108
      disc.a1a = 500;                             // 8109
      disc.ds  = 0;                               // 8110
    }
  }
}
```

- **Fire input** is `action2` (same key as grapple, idx 194). Charge only
  progresses while `a1a == 1000` **exactly**.
- **`ds`** (idx 196, "draw strength") grows by **1 per step**, clamped to 100.
- **`da`** (idx 197, aim angle, default 270 per §33.6) is nudged **±5° per
  step** by left/right while charging.
- **Firing cost:** `a1a` is set to **500** on release (8109).
- **Recharge:** in `ar`/`ard`, once the round countdown is finished (`ftu == -1`),
  `a1a += 8` per step up to 1000 (7356–7361). Re-arm time from a shot is
  `(1000-500)/8` = **62.5 steps ≈ 2.08 s at 30 TPS**. Spawn values:
  `a1a = 750` (ar) / `500` (ard) (§33.6, lines 6875–6880).

**Arrow spawn object (inner fire function, lines 7940–7962):**

```js
// 7942-7961  (speed = op80(ds, 1, 15) = ds*1 + 15; z0M[39]=1, z0M[28]=15)
pos = discCenter + 1.0 * (cos(da), sin(da));
speed = ds * 1 + 15;                     // 16 .. 115 world units/s
arrow = { x, y, a: da, av: 0, did: shooterDiscID,
          xv: cos(da) * speed, yv: sin(da) * speed,
          fte: 150,                      // z0M[95] = 150, line 6955
          type: "arrow", team: shooterTeam };   // 7957-7960
pendingArrows.push(arrow);               // 7961
```

`fte` is the projectile **lifetime in steps: 150 = 5 s**. New arrows are
appended to the outgoing `state.projectiles` each step (lines 9008–9010).

**Arrow body (world-rebuild pass, lines 7881–7924):** every
`state.projectiles[i]` becomes a dynamic bullet body:

```js
bodyDef.userData = { type: "arrow", arrayID, discID, fte,
                     hitDiscsThisStep: [], hitWorldThisStep: false,
                     destroyThisStep: false, team };      // 7887-7896
if (len(v0) > 4) { bodyDef.angle = atan2(yv, xv);         // 7897-7900
                   bodyDef.angularVelocity = 0; }          // 7900
// shape/fixture, 7908-7920:
shape.SetAsBox(z0M[46] / 2, z0M[10] / 2, (0,0), 0);      // 7910
//  z0M[46]=1, z0M[10]=0.5 (6956-6957) -> half-extents 0.5 x 0.25
fixture.density     = 2.5;                                // 7913 (z0M[20], 6958)
fixture.friction    = 0.5;                                // 7914 (z0M[81], 6959)
fixture.restitution = 1;                                  // 7915 (z0M[68], 6981)
fixture.isSensor    = false;                              // 7916
bodyDef.bullet      = true;                               // 7906
```

Arrows are **fully collidable** (isSensor false, restitution 1 — they bounce),
mass ≈ 2.5 × (1.0 × 0.5) = 0.625.

**Contacts (BeginContact, lines 7026–7066):**

- **Owner/team immunity (owner immunity RESOLVED):** lines 7054–7055 —
  contact is disabled when, in FFA (`gameSettings.tea == false`), the hit
  disc's `arrayID == arrow.did`, or, in team mode, `arrow.team == disc.team`
  (evaluated both contact directions via the 2-iteration fixture swap
  7018/7119–7122).
- **`ard` (death arrows):** on any arrow-vs-disc contact
  `state.discs[hit].diedThisStep = 1` (7059–7061). In plain `ar` the contact is
  purely physical knockback; the disc ID is only appended to
  `hitDiscsThisStep` (7058), a list **no physics-code consumer exists for**
  (its only appearance is 7058).
- **Cap zones:** arrow vs `capzone` fixture → contact disabled (7026–7027);
  arrows never count for/into cap zones.
- **World hits:** arrow vs anything non-disc sets
  `userData.hitWorldThisStep = true` (7063); again no physics consumer found.
- **Force zones** act on arrows via `fz.a` (7111 — cross-ref §31.1).

**Lifetime/termination (post-step serialization, lines 8989–9007):** an arrow
body is carried into the next state only while
`userData.destroyThisStep == false && userData.fte > 0`, and `fte` is
decremented by 1 per step (9000). `destroyThisStep` is initialized `false`
(7894) and **is never written `true` anywhere in this build**, so the only
end-of-life path in the local step is the 150-step timer.

**Grapple interaction:** arrows are **not grappleable**. The §32.1 QueryAABB
collector (line 8152) requires the fixture's body userData `type == "phys"`;
arrow bodies carry `type: "arrow"` (7888/7918) and are skipped by the
contact-level arrow-vs-vtolwing rule as well (7026–7030 pattern).

**Fire rate/cooldown summary:** charge ≤ 100 steps ≈ 3.33 s, speed
`16..115 units/s`, cooldown 62.5 steps ≈ 2.08 s, lifetime 150 steps = 5 s.

### 35.2 Football / kick system — game type `"f"` — RESOLVED (ball spawn/reset PARTIAL)

**Engine selection:** the match token field `ga` (idx 714) selects the
engine at lines 40601–40607 / 40642–40647: default replay engine `z`,
`ga == "b"` → class `a5H[21]`, **`ga == "f"` → class `B`** (+ view `m3`).
Football's `step()` is defined at line 14110; it runs its **own `b2World`
with gravity (0,0)** (14115), warm starting off (14116), solver iterations
2/6 (14170), and a contact listener whose only role is pushing `footBounce`
sounds for ball contacts with normal impulse > 1 (14127–14136).

**Ball (class `t$e[30]` = `N1m`, constructor 14280–14309):**

```js
b2CircleShape(0.7);                                // 14289
fixture.density   = 0.6 / (Math.PI * 0.7 * 0.7);   // 14292-14296 -> ball mass 0.6
fixture.restitution = 0.4;                         // 14297
fixture.filter.categoryBits = 4;                   // 14298
body.SetFixedRotation(true);                       // 14305 (idx 1516)
body.SetLinearDamping(0.6);                        // 14306 (idx 1517)
body.SetBullet(true);                              // 14307 (idx 1518)
body.SetLinearVelocity(spawn xv/yv);               // 14300
userData = { type: "ball", ballReference: this };  // 14302-14303 (w65(1070)="ball")
```

**Football player (class `t$e[20]` = `B2R`, constructor 14329–14367):**
radius-1 circle in world units, density `1.05/(π·r²)` (mass 1.05), **friction
0, restitution 0.4**, categoryBits 2, `fixedRotation = true` (14339),
`linearDamping = 2.4` (14340), `bullet = true` (14343), userData
`{type:"disc", discReference:this}` (14361–14362). `kickReady` is carried
from incoming state (14365).

**Movement (applyInputs, 14368–14390):** `ApplyForce((±32,±32),
GetWorldCenter())` per held direction; heavy key (`action`, idx 192) scales
the force **×0.7** (14383–14384); holding `action2` zeroes the move force
(14386–14389).

**Kick (doKick, 14392–14422):**

```js
if (input[192 /*action*/] && this.kickReady) {          // 14395
  var d = player.ToBallVec();                            // 14396-14397
  if (Math.abs(d.len()) < 0.7 + this.radius /*1*/ + 0.6) { // 14398 -> 2.3 units
    var dir = d.Copy().GetNegative();                    // 14399-14400
    var k = 15 / d.len();                                // 14402-14403 (op7)
    dir.x /= k/dist-scaled components -> impulse = dir.normal * 15; // 14406-14409
    ball.body.ApplyImpulse(dir, ball.body.GetPosition());  // 14410
    this.kickReady = false;                              // 14411
    sounds.push({ i: "footKick", v: 1, f: 10 });         // 14412-14416 (U3q(3336)="footKick")
  }
}
if (!input[192]) this.kickReady = true;                  // 14419-14420
```

Kick = impulse magnitude **15**, direction player-center→ball-center,
applied at the ball's **position**; reach **2.3 world units**
(ball r 0.7 + player r 1 + 0.6); one kick per key press (`kickReady` re-arms
on release).

**Goal detection (14181–14205):** only when countdown state `ftu == -1 &&
lscr == -1`:

```js
if (ball.x <  (borderThickness + borderThicknessXInner) / ppm) { scores[2]++; // 14183-14184
    goalTeam = 2; goal = true; sounds.push({ i:"footGoal", v:1, p:"l", f:5 }); } // 14185-14192
if (ball.x >  (730 - borderThickness - borderThicknessXInner) / ppm) { ... scores[3]++; p:"r" } // 14194-14203
```

State fields (resolved): `goalHeight` (1505), `borderThickness` (1506),
`borderThicknessXInner` (1507), `borderThicknessYInner` (1508), `ball`
(1509), `scores` (122), `lscr` (123). **Scoring is pitch-crossing
thresholds, not cap zones** — the cap-zone `teamGoalEvent` path
(BeginContact 7032–7034, phys-vs-phys capzone fixture) is the classic-mode
map feature and is *separate* from football. **Ball spawn/reset: UNRESOLVED
in this client build** — the ball is constructed purely from incoming
`state.ball` (14151); the host-side goal-reset/spawn-author code is not part
of the local step function. `clampToPitch` (14423–14439+) clamps the ball to
pitch bounds and zeroes the clamped velocity component (partially read).

### 35.3 VTOL mode — `"v"` — RESOLVED

**Body/fixtures (7379–7424):** disc body-def gets `fixedRotation = false`
only in VTOL (7380–7382). Two extra **wing fixtures** are added to the disc
body, one per side (7407–7424):

```js
wing.SetAsArray(footHW*r, footHH*r, (±footOffsetX*r, footOffsetY*r), 0);   // 7409/7421
fixture.density = 0.2; fixture.friction = 0.2; fixture.restitution = 0.7;  // 7412-7414
fixture.filter.categoryBits = 1; userData = { type: "vtolwing" };          // 7415-7417
```

(Geometry constants are `z[footHW/footHH/footOffsetX/footOffsetY]`
(globalStepVars idx 5–8) scaled by the disc radius; their literal values are
in the global-step-vars literal block referenced as `z[5..8]`.)
Cap-zone contacts pass through when the *disc's other fixture* is a
`vtolwing` (7022 vs 7029).

**Per-tick thrust (7999–8082), local player only, guarded by
`state.ftu == -1` (7930):**

```js
thrust = -0.8 * r * r;                       // 8005-8007: op83(30,24)=-0.8; 7976: r²=πr²/π
main = new b2Vec2(0, thrust);                // 8009
main = body.GetWorldVector(main, main);      // 8010 — thrust rotates with body
asym = new b2Vec2(0, 0.2 * thrust);          // 8008/8011-8013 — 1/5-strength wing
P  = body.GetWorldPoint( (+footOffsetX*r², footOffsetY*r²) );  // 8014
P2 = body.GetWorldPoint( (-footOffsetX*r², footOffsetY*r²) );  // 8015
```

Input state → impulse program (states named for the wing that receives full
thrust, 8016–8081) via `ApplyImpulse` (idx 306):

| Input | State | Impulses | `vt` |
|-------|-------|----------|------|
| up alone | `both` | main @ P, main @ P2 | 3 |
| up+right | `left` | main @ P, asym @ P2 | 1 |
| up+left | `right` | asym @ P, main @ P2 | 2 |
| down alone | `downboth` | −main @ P, −main @ P2 | 4 |
| down+right | `downleft` | −asym @ P, −main @ P2 | 5 |
| down+left | `downright` | −main @ P, −asym @ P2 | 6 |
| nothing | `none` | — | 0 |

`vt` (idx 198) is stored on the disc for the renderer. Because
`fixedRotation == false`, asymmetric thrust torques the disc; symmetric
thrust ≈ 2×0.8·r²·dt upward (= 1.6·r²/step vs gravity 20 downward in
impulse terms) plus stabilization via wing friction/restitution contacts.
**Fuel/energy: none.** VTOL flight never reads `a1a`; in modes `b` and `v`
`a1a` is the shared **heavy-key meter** only (below). (Line 8004's
`GetAngle() + π/2` value is computed but unused.)

### 35.4 Balance (`bal`) & heavy-meter — RESOLVED (cross-ref §31.5)

**Trigger:** `gameSettings.bal[discID]` (idx 199), a per-player array — it is
checked at 7313 exactly like a per-player lookup, truthiness gated. **What it
scales:** disc radius only:

```js
// 7313-7321  (op58(179,4,8,7,9) -> idx 199 = "bal"; op53(1400,1,1305,5) = 100)
var bal = gameSettings.bal[discID] / 100;
bal = Math.max(Math.min(bal, 1), -0.95);
radius = 1 + bal;      // disc radius, then used for shape radius (7396)
```

This **confirms §31.5's correction of §25**: balance modifies radius (1 +
bal/100 clamped to [0.05, 2]), and because the movement-force scale is
`radius²` (7976: `π·r·r / (π·1·1)`) and VTOL thrust and wing geometry also
multiply by `r`/`r²` (§35.3), balance indirectly scales force/thrust/wings —
it does **not** touch renderer `scaleRatio` (§34.5).

**Heavy meter (`a1a`) in modes `b` / `v` (7325–7337, 7363–7374):**

```js
if (mo == "b" || mo == "v") {
  if (disc.a1 /*action key*/ ) { a1a -= 10; if (a1a < 0) a1a = 0; }      // 7325-7330
  else if (player && input && input.action == false) { a1a += 5;         // 7332-7336
       if (a1a > 1000) a1a = 1000; }
}
// heavy effect (7363-7374; mode != "bs", no arrow charge ds):
// ratio = a1a / 1000; density = baseDensity + 3.7 * ratio * baseDensity
//  baseDensity = 1/(π·1·1) (7241-7249; mass 1), so heavy boosts disc density
//  by up to 1 + 3.7·(a1a/1000) = up to 4.7x, applied to the fixture (7399).
```

Heavy also scales the movement force by **0.7** (7994–7995) and — per the
resolved density field — **does mutate mass** through the per-tick rebuilt
fixture (density field `[216]` at line 7399). This corrects the earlier
"heavy: no mass mutation" memory note: mass *is* scaled, up to 4.7×, via
density, while movement force is separately damped ×0.7.

### 35.5 Status summary

| System | Status | One-line answer |
|--------|--------|-----------------|
| Arrow creation (input) | RESOLVED | `action2` hold charges `ds` 1→100/max, aim `da` ±5°/step with L/R; release fires; requires `a1a == 1000`, costs → 500, recharge 8/step |
| Arrow flight model | RESOLVED | Box `0.5×0.25` half-extents, density 2.5, friction 0.5, restitution 1, bullet, speed `ds+15`, spawn offset 1.0 along aim |
| Arrow speed/lifetime | RESOLVED | Speed 16–115 units/s (charge-scaled); lifetime `fte = 150` steps, −1/step; `destroyThisStep` never set in this build |
| `ard` death arrows | RESOLVED | Arrow-vs-disc contact in `ard` mode → `diedThisStep = 1` (7059–7061); plain `ar` is physical knockback only |
| Owner immunity | RESOLVED | FFA: ignores shooter (`did`); teams: ignores same `team` (7054–7055) |
| Arrows grappleable? | RESOLVED: **no** | QueryAABB requires body UD `type == "phys"` (8152); arrow UD type is `"arrow"` |
| Football mode | RESOLVED | Game type `ga == "f"` runs dedicated zero-gravity top-down engine `B` (14110+) |
| Kick impulse | RESOLVED | Magnitude 15, player→ball direction, reach 2.3 units, one kick per `action` press (`kickReady`), sound `footKick` |
| Scoring detection | RESOLVED (football) | Pitch x-thresholds scaled by `borderThickness(±XInner)/ppm` → `scores[2]/[3]++`; distinct from classic `teamGoalEvent` cap-zone path (7032–7034); cap zones 4/5 stay classic-mode instant-goal semantics (§33.7) |
| Ball spawn/reset | PARTIAL/UNRESOLVED | Ball built only from `state.ball` (14151); host reset/spawn logic not in client step |
| VTOL flight forces | RESOLVED | Two `ApplyImpulse` wing forces, main `(0,−0.8·r²)` + wing `(0,−0.16·r²)` in body frame; state machine per input combo; no fuel |
| VTOL input mapping | RESOLVED | up/left/right combos → 7 thrust states (`vt` 0–6, table above) |
| Balance trigger/scale | RESOLVED | `gameSettings.bal[discID]/100` clamped `[-0.95, +1]` added to disc radius only; force/thrust scale via `r²` by construction |
| Heavy meter | RESOLVED | `action` key drains a1a 10/step, recharges 5/step; density ×`(1+3.7·a1a/1000)`, force ×0.7 |

The literal global-step defaults are now source-proven:
`footHW=0.3`, `footHH=0.2`, `footOffsetX=-1`, and `footOffsetY=0` at
3436–3439. The movement branch at 7979–7997 is also source-proven:
`state.ms.fl ? 20 : 12`, scaled by `radius^2` and then by `0.7` for heavy
input. The source does not prove which server-supplied sessions set `ms.fl`
true, so a live map trace remains useful for coverage, not for the arithmetic.
Football host-side ball spawn/reset remains outside the client step.

---

## §36 Local Deobfuscation Bundle (`.deobf/`)

This section documents the fully local, automated deobfuscation of the
2026-07-29 client into `.deobf/alpha2s.readable.js` by
`.deobf/final-pipeline.js`. The current pipeline and independent audits use
AST source ranges, source-order decoder capture, an immutable table-lookup
proof, a strict dispatcher-formula proof, and provenance sidecars.
The earlier 2026-07-30 audit snapshot remains below as historical evidence,
not as the current metric baseline.

### 36.1 Pipeline stages

`node .deobf/final-pipeline.js` always starts from
`.deobf/alpha2s.pretty.js` and emits `.deobf/alpha2s.readable.js` from one
right-to-left absolute-offset merge. Every stage scans the pristine input;
overlap priority is preamble capture > pass4 > pass4b > pass3 > table-fold >
dispatcher-table-index-fold > pass3b-formula-fold > pass1 > banners:

1. **Preamble decoder capture:** every literal `B3jF8.U3q/w65(n)` before the
   top-level `requirejs(...)` call is replayed twice in its original source
   order and replaced with the agreed primitive. This folds 1,731 calls: 1,724
   table strings and seven stateful warm-up numbers. Re-evaluating these calls
   after bootstrap is unsafe because the warm-up values differ from later
   decoder results; `final-preamble-folds.json` records their capture values.
2. **String inline (pass4):** literal-arg decoder calls `B3jF8|k7V.U3q/w65(n)`
   are evaluated in a sandboxed VM after booting the ~2430-line requirejs
   header and inlined as string literals (5,939 replacements). `t$4`/`g7y`
   op-calls with literal arguments are folded with an ` /*op */ ` comment
   (96 replacements).
3. **Stateful setup-decoder fold (pass4b):** `t8H`/`n6e` are two wrappers of
   the same two-phase environment-probe machine `B3jF8[210213].f_fpV2a`,
   stateful only through the closure slot `R1n[4]`. The single arming call is
   the top-level preamble `B3jF8.n6e();` (line 2424), so every AMD-body call is
   second-or-later and returns the steady value 73. A structural proof of the
   machine plus two fresh preamble boots (first call 93, steady 73, runs agree)
   gate the fold; all 791 body calls (380 `t8H`, 411 `n6e`) are folded to `73`.
   See §39 and `final-stateful-decoder-folds.json`.
4. **Op-fold (pass3):** adjacent `k7V.H0n/d1M(sel); X[i] = k7V.w_c/Q5$(args)`
   sequences with all-literal arguments are folded to their numeric result
   with an ` /*opfold*/ … */` provenance comment (1,696 folds). Its 207
   non-literal-argument skips are the candidate universe for pass3b below.
5. **Immutable table fold:** AST/binding analysis proves the single `M$QCc`
   property-name table initializer has no writes or escaping alias. It replaces
   complete, read-only literal table lookups with JSON string literals: 23,852
   folds (1,186 direct aliases and 22,666 carrier slots). This includes 554
   index-47 lookups folded to the literal string `"length"`, never `.length`.
   The pipeline writes the range/value provenance to `final-folds.json`; the
   independent table audit re-derives and verifies every fold.
6. **Dispatcher table-index fold:** a separate strict pass starts only from the
   immutable-table helper's proven dynamic origins. It requires an immediate
   table alias, one unmodified `var` index definition, an immediately preceding
   literal `H0n/d1M` selector in the same statement list, and two agreeing
   fresh-VM evaluations. It folds 86 bracket reads to strings, including one
   index-47 `"length"` string. The two dispatcher-index sites whose interposing
   `t8H` calls are now folded `73;` statements remain bracketed.
   `final-dispatcher-folds.json` records every source range, selector, call,
   resolved table index, value, and rejected strict-pattern site; the
   independent AMD-body audit re-derives the entire set and verifies it.
7. **Dispatcher-formula fold (pass3b):** all 207 of the non-literal pass3
   candidates are replaced only at the `Q5$/w_c` call with a static case
   formula from the 253-case `B3jF8[239984]` dispatcher map (SHA-256
   `6bd5eabc9911df5b9339334ff9034f97fdbc979b30a834761a3bb9f6c9c53a87`).
   The selector statement and LHS remain intact. The factory setter, four
   wrappers, and sole `k7V` alias are binding-proven; the selector must be the
   immediately preceding bare statement; every argument must be used exactly
   once. 48 formulas read their arguments in the call's exact left-to-right
   order and are emitted inline; the other 159 reorder their arguments and use
   the order-preserving IIFE lowering — every call argument is bound to a
   fresh parameter in call order and the formula is applied to the parameters,
   reproducing the dispatcher's own evaluate-arguments-first behavior with
   identical exception and coercion order. `final-formula-folds.json` records
   every accepted site (with `orderPreserved` provenance);
   `audit-formula-fold.js` and the paired readable-AST audit independently
   re-derive all 207.
8. **AST annotation + analysis labels (pass1):** Babel identifies all 89,199
   literal numeric member accesses in the AMD body. Of these, 46,518 are
   covered by table folds, 31,373 emit conservative dotted analysis labels,
   11,298 emit ` /* name */ ` annotations, and 10 out-of-table slots remain
   unchanged. Dotted labels are for analysis readability, not a claim that a
   packed argument-array slot was originally a JavaScript property.
9. **Banner insertion:** 43 zero-length section banners at `anchors.json`
   line starts.

Inputs: `tables.json` (1,724-entry resolved property-name table),
`callsites.json` (per-receiver safety verdicts and index histograms),
`anchors.json` (banner anchors), `final-preamble-folds.json` (source-order
preamble capture provenance), `final-folds.json` (literal AMD-body fold
provenance), `final-dispatcher-folds.json` (dispatcher-index provenance),
`final-formula-folds.json` (dispatcher-formula provenance), and
`final-stateful-decoder-folds.json` (stateful setup-decoder provenance).
Before table folds, AST pass1 classifies 46,831 conservative
dotted labels, 41,557 ordinary annotations, 801 index-47 annotations, and 10
out-of-table skips. The old character scanner missed 341 division-as-regex
sites; AST recovers all of them. Table folds supersede 15,458 dotted-label
sites, 30,506 ordinary annotation sites, and 554 index-47 annotation sites.

### 36.2 2026-07-30 audit snapshot (superseded counts)

| # | Task | Result |
|---|------|--------|
| 1 | `node --check .deobf/alpha2s.readable.js` | PASS (exit 0) |
| 2 | Re-ran pipeline in place; SHA-256 before/after identical (`15BCF53E…283005`) | PASS (byte-identical, idempotent) |
| 3 | Independent re-scan of the previous five-receiver configuration, alignment-walked 14,836 receiver sites (14,256 dotted + 580 bracket-annotated); 20 random samples cross-checked against `tables.json` | PASS — **0 mismatches** across all sites and all samples |
| 4 | All 72,897 ` /* name */ ` annotations re-verified against `names[n]`; 20 random samples | PASS — **0 mismatches** |
| 5 | Negative space: 0 dotted accesses nested inside a receiver's bracket index; 0 variable/dynamic bracket indices remain (consistent with SAFE verdicts) | PASS |
| 6 | Residual decoders in readable code: `k7V.` 2,820, `B3jF8.` 1,756, `H0n(` 405, `d1M(` 417, `Q5$(` 405, `w_c(` 460 | PASS — all expected residue (see 36.4); 1,731 "literal" remnants = the 1,724-entry `M$QCc` table definition itself + 7 header calls, never fold targets |
| 7 | Readability metric: 28,065 obfuscated identifiers (delta-name `A$xx` shapes + bare receiver/decoder names), 40,233 lines | 69.8 per 100 lines globally; windows 12.5 / 38 / 46 / 88.4 / 236 per 100 lines |

### 36.3 Artifacts

- `alpha2s.readable.js` — 4,474,907 bytes, 39,673 lines, the analysis target.
- `final-pipeline.js`, `ast-member-scan.js`, `table-lookup-fold.js`,
  `op-dispatch-fold.js`, `audit-independent.js`, `audit-preamble.js`,
  `audit-formula-fold.js`, `audit-training-statics.js`,
  `audit-map-option-writers.js`, `audit-out-of-table.js`,
  `audit-dynamic-training-residuals.js`, `audit-index47-census.js`,
  `audit-table-lookup.js`,
  `final-stats.json`, `final-preamble-folds.json`, `final-folds.json`, and
  `final-dispatcher-folds.json`, `final-formula-folds.json` are the current
  producer, proof, and audit artifacts.
- Legacy intermediate bundles and per-pass scripts are intentionally not
  retained; the canonical pipeline performs one source-range merge from
  `alpha2s.pretty.js`.
- `audit-report.txt` is a preserved 2026-07-30 historical report; it does not
  describe the current AST or table-fold pipeline.

### 36.4 Residual limits (verified by audit)

- **Control-flow flattening is NOT reversed.** Switch-dispatch state machines
  remain; the bundle is data-flow readable, not control-flow readable.
- **1,639 dispatcher/selector occurrences remain** (`w_c` 438, `Q5$` 379,
  `H0n` 405, `d1M` 417). Beyond pass3's all-literal folds, pass3b proves and
  emits all 207 non-literal formulas: 48 inline (identity argument order) and
  159 through the order-preserving IIFE lowering (reordered argument use).
- **10 out-of-table indices** are left unchanged rather than being assigned an
  incorrect property name.
- **86 strict dispatcher-resolved table indexes** are folded to strings. Two
  direct-table sites with a folded `73;` interposing statement (formerly a
  stateful `t8H` setup call) and two `a9M`
  data-record brackets remain unchanged rather than extending the proof past
  its source-order/evaluation boundary.
- **Conservative dotted-label eligibility is mechanically checked.** A
  `[arguments]` initializer alone is insufficient: low-distinct slots can be
  scalar arguments, counters, or ordinary objects. The safe set requires the
  property-bag admission rule plus a single binding, no dynamic index, no
  out-of-table slot, and no alias escape. Index `47` can only remain bracketed
  with a `length` annotation or fold to the string literal `"length"`.
  `audit-index47-census.js` re-derives the 247 surviving index-47 sites and
  classifies all of them with Node-executed probes: none is a safe dotted
  `.length` substitution (see §38.1).
- **Readability verdict:** all 89,189 in-table literal numeric accesses are
   represented by a dotted analysis label, an annotation, or a decoded table
   string. Local names and flattened control flow remain obfuscated; the
   current audit measures 112.4 obfuscated identifier tokens per 100 lines.

### 36.5 Legality / use

`.deobf/` is gitignored and is an **analysis artifact only**, produced from
the publicly served client at `https://bonk.io/js/alpha2s.js` for reverse
engineering of game mechanics (simulator fidelity). It is **not
redistributable** — the bundle is a derivative of bonk.io's proprietary
client and must not be committed, published, or shipped. Re-run with:
`node .deobf/final-pipeline.js` (idempotent).

---

## §37 Verified Expansion and Client Boundaries (2026-07-31)

This section records only findings rechecked directly against the regenerated
`.deobf/alpha2s.readable.js`. Readable-bundle line numbers below are local to
the 2026-07-29 source build; property-table indices remain build-specific.

### 37.1 Pipeline expansion and integrity rule

The previous targeted-substitution cap was an analysis heuristic, not a
semantic limit. `analyze-callsites.js` evaluates every property-bag candidate
and emits `SAFE_TO_SUBSTITUTE` only if all of these hold:

1. The receiver passes conservative property-bag admission; a lone
   `var receiver = [arguments]` is not enough.
2. Exactly one such declaration and bare assignment exist, without a binding
   escape or later reassignment.
3. No access uses a dynamic computed index.
4. Every literal index is within the 1,724-entry property-name table.

`receiver[47]` is explicitly excluded from dotted output even for otherwise
safe aliases. In the original source, `Y00[47]` is assigned and incremented as
a loop counter while `Y00[9][47]` denotes the actual property-table name
`length` (`alpha2s.pretty.js` 6389-6397). Rewriting the former as `Y00.length`
would change Array semantics. The final pipeline has explicit guards at both
dotted-emission paths; the 247 surviving index-47 sites are bracketed and
annotated, while 554 immutable table lookups fold to `"length"` strings.

The updated pipeline also constructs the output in one reverse chunk pass
instead of repeatedly splicing a multi-megabyte string. This keeps regeneration
linear in the output size as substitutions grow.

| Stage | Verified result |
|---|---:|
| Decoded property table | 1,724 names |
| Literal string/primitive decoder inlines | 7,670 total: 1,731 source-order preamble captures + 5,939 body pass4 replacements |
| Literal operation folds | 1,696 |
| Strict dispatcher-formula folds | 207 / 207 candidates: 48 inline (identity argument order) + 159 order-preserving IIFE lowering; 0 argument-order rejections |
| AST body literal-index accesses | **89,199** |
| Immutable table-string folds | **23,852** (1,186 direct, 22,666 carrier) |
| Source sites covered by table folds | **46,518** |
| Effective dotted analysis labels | **31,373** |
| Effective bracket annotations | **11,298** |
| Historical division-as-regex scanner gap | 341 (now closed by AST) |
| Out-of-table slots left unchanged | 10 |
| Semantic section banners | 43 |
| `node --check` | PASS |
| Delimiter parity | PASS (77,977 square pairs and 10,845 paren pairs) |
| Pipeline spot/fold audits | 25 / 25 each, PASS |
| Independent pass-one closure | 89,199 sites; 0 gap or mismatch |
| Independent table-fold audit | 23,852 / 23,852 approved; 0 extra/unproven |
| Independent formula-fold audit | 207 / 207 folds re-derived (48 inline, 159 ordered); 0 structural anomalies |
| Audit receiver coverage | 187 safe-to-substitute + 1,141 do-not-substitute = 1,328 analyzed |

The readable artifact remains an analysis target, not an executable or a
replacement client. Local names and flattened dispatcher control flow are still
substantially obfuscated. The current receiver-complete audit measures 112.4
obfuscated identifier tokens per 100 lines. Whole-expression string folds
remove many inner dotted labels because the complete lookup is more readable as
a decoded string literal.

`final-folds.json` uses the stable `final-folds` v1 schema. Each record carries
the original range, table index, decoded value, replacement, and status; the
independent verifier re-derives the immutable-table proof and rejects missing,
extra, unproven, or wrong-value folds. Current validation is:

```text
node .deobf/final-pipeline.js          # reproducible readable artifact
node --check .deobf/alpha2s.readable.js
node .deobf/ast-member-scan.js --self-check
node .deobf/audit-independent.js
node .deobf/audit-preamble.js
node .deobf/audit-formula-fold.js
node .deobf/audit-stateful-decoder-fold.js
node .deobf/audit-training-statics.js --self-check
node .deobf/audit-map-option-writers.js --self-check
node .deobf/audit-out-of-table.js --self-check
node .deobf/audit-dynamic-training-residuals.js --self-check
node .deobf/audit-index47-census.js --self-check
node .deobf/audit-table-lookup.js --verify
node .deobf/test-anchors.js
```

Two consecutive final-pipeline runs produced the same readable SHA-256:
`2097916F16311692A5A457690E3BD8377AC0D07E7D58AD95490C73FF74BAADD3`.

### 37.2 Transport and deterministic state exchange

The AMD body loads three external dependencies: `socketio`, `peer.min`, and the
external Box2D module (`readable` 2435). The networking class creates:

- a socket.io connection with reconnection disabled (`14509-14511`);
- a PeerJS connection configured with port `443`, path `/myapp`, and
  `secure: true` (`14406-14411`);
- a timesync instance at 10-second intervals with 250 ms delay (`14284-14339`).

Input encoding is exact and source-proven (`37266-37308`):

| Bit | Field |
|---:|---|
| 1 | `left` |
| 2 | `right` |
| 4 | `up` |
| 8 | `down` |
| 16 | `action` |
| 32 | `action2` |

The local client only emits an input change: it compares the current controls
with the most recent recorded frame, then passes `{i, f}` to `sendInputs`
(`39645-39680`). The packed six-bit value is decoded before the simulation
buffers it. The host-to-client in-game batch expands each input tuple
`{f, p, i}` into `inputs[player][frame]`; administrative inputs use `{f, a}`
(`4607-4630`). The same packet carries a compressed PSON world-state blob and
game settings with separately encoded map data (`4664-4697`). This proves the
client runs deterministic frame-indexed input simulation; it does not reveal
the private server's authority or routing logic.

### 37.3 Replay input codec and state shape

Replay input history is sparse and indexed `inputs[player][frame]`. Before
PSON serialization, `halfSerialize()` writes:

```text
UShort entryCount
repeat entryCount:
  UShort playerIndex
  Uint frameIndex
  Byte packedControls  // the same six bits listed above
```

The inverse routine recreates the nested input array (`9756-9857`). The replay
object is then PSON encoded, base64 encoded, URI-compressed, and case-swaps its
first 101 characters; `fromDatabase()` applies the exact reverse sequence
(`9891-9929`). Its shared PSON dictionary begins at `9932`.

Classic `step()` serializes the outgoing state after `ClearForces()`:
`ms`, `mm`, `shk`, `discs`, `capZones`, `seed`, `ftu`, `rc`, `rl`, `sts`,
`physics`, `scores`, `lscr`, `fte`, `discDeaths`, `players`, and `projectiles`
are built in the post-step path (`8171-8177`, `8299-8336`, `8511-8551`,
`8552-8773`). `physics.joints` and `physics.bro` are deep-copied; shapes and
fixtures remain shared immutable map definitions. This distinction is important
for an exact clean-room simulator: body transforms are per-tick state, but map
geometry is not regenerated through a separate map codec on each network frame.

### 37.4 Corrected movement, timer, and presentation details

- The classic engine initializes independent round-start and round-end timers
  `ftu = 90` and `fte = 90` (`3417-3418`). Physics is gated while `ftu != -1`
  (`8157-8168`). The post-step path writes decremented timer values to the
  outgoing serialized state and includes `fte` during the elimination/score
  path (`8299-8302`, `8521-8540`); the client source does not mutate the live
  timers after initialization, consistent with server-supplied state.
- Player discs are recreated with `linearDamping = 0.01`,
  `angularDamping = 3.4`, and `bullet = true`; rotation is fixed except in
  VTOL mode (`7271-7304`). The old `discLinearDamping = 0` settings entry is
  not the live classic body-def value.
- `EndContact` and `PreSolve` are empty (`7027-7030`). Contact-specific game
  effects occur in `BeginContact`; `PostSolve` handles impulse accounting,
  sound payloads, and shake (`7031-7129`).
- `dontInterpolate` forces the renderer to render the current state as both
  endpoints (`16056-16059`). The local disc is inserted above other disc
  graphics (`16077-16082`). Classic `sts` is consumed then nulled by the
  renderer (`16145-16150`), so it is a single-tick event carrier.
- Camera shake is serialized as `shk` (`8173-8176`), then rendered as a
  50 ms Cubic.Out offset followed by an 800 ms Elastic.Out return
  (`16121-16144`). The shared amplitude constant is `0.012`
  (`24524-24556`). This is presentation-only, except that `shk` is part of the
  serialized state.

### 37.5 Exact-rewrite boundary

The client source now supports a high-confidence clean-room implementation of
the deterministic classic simulation, map codec, replay input codec, and much
of the input transport contract. It cannot independently reproduce the private
matchmaking/server authority: the client imports rather than contains the
physics module, and server packet routing and validation are not present in the
bundle. An exact client/server clone still requires differential traces from
live games and an independently implemented server.

---

## §38 Current Deobfuscation Inventory (2026-08-03)

This is the authoritative completeness record for the retained 2026-07-29
`alpha2s.js` build. Earlier sections are chronological research notes. Where an
earlier note conflicts with this section or §§31-37, the later source-verified
finding wins.

### 38.1 Exact scope of completion

The following is complete and independently verified for the AMD `requirejs`
factory body, plus the preamble's literal decoder materialization:

- All 1,731 preamble `B3jF8.U3q/w65(number)` calls are folded using two fresh,
  source-order capture runs: 1,724 materialize `M$QCc` and seven are stateful
  warm-up primitives. `audit-preamble.js` proves the generated preamble has no
  literal decoder call, its static `M$QCc` array has 1,724 strings, and its
  materialized table equals both the original preamble and `tables.json`.
- All 791 AMD-body `t8H`/`n6e` calls (380 + 411) are folded to the steady
  decoder value 73. `B3jF8.t8H`/`B3jF8.n6e` both forward to the two-phase
  environment-probe machine `B3jF8[210213].f_fpV2a`; its only closure state is
  `R1n[4]`, armed by the single top-level preamble call `B3jF8.n6e();`
  (line 2424), so every body call is second-or-later and returns 73. The fold
  is gated by a structural proof of the machine plus two fresh preamble boots
  (first call 93, steady 73, runs agree), recorded in
  `final-stateful-decoder-folds.json` and independently re-derived by
  `audit-stateful-decoder-fold.js` (see §39).

- The 1,724-entry `M$QCc` property-name table is decoded by executing the
  retained header, not by inferred names.
- All 89,199 literal numeric `MemberExpression` accesses are accounted for:
  46,518 source accesses are covered by a complete decoded table-string fold,
  31,373 emit dotted analysis labels, 11,298 emit exact property-name
  annotations, and 10 out-of-table slots stay unchanged. Thus all 89,189
  in-table literal accesses have a verified readable representation.
- The table fold is independently re-derived from source and validates all
  23,852 records: 1,186 direct immutable aliases and 22,666 proven carrier
  slots. Its `final-folds` v1 sidecar records the source range, table index,
  decoded value, output literal, and disposition of every candidate.
- The dispatcher-index pass independently re-derives 88 direct immutable-table
  dynamic reads. Its strict same-statement selector rule folds 86 to verified
  string literals; two interposition sites are retained (the interposing `t8H`
  is now a folded `73;` statement). The separate
  `final-dispatcher-folds` v1 sidecar records every folded source range,
   selector, call, value, and rejected strict-pattern site.
- Pass3b independently accounts for all 207 non-literal dispatcher sequences:
  48 are emitted inline as static formulas and 159 use the order-preserving
  IIFE lowering that binds every call argument to a fresh parameter in
  left-to-right call order before applying the case formula to the parameters.
  The factory setter, wrapper bindings, selector adjacency, case map, argument
  recovery, `orderPreserved` provenance, sidecar bijection, and the paired
  readable AST expression are all verified; no index-47 access is dotted inside
  a formula.
- The 341-site legacy division-versus-regex scanner blind spot is closed by
  AST discovery. Before whole-expression folding it contained 279
  dotted-label and 62 annotation decisions; 56 lie inside table folds, leaving
  260 dotted and 25 annotation decisions in the final output.
- Table index 47 (`length`) is structurally protected. It produces no emitted
  `.length` label: 247 surviving sites remain bracketed and annotated, while
  554 immutable table reads plus one dispatcher-resolved table read become the
  string literal `"length"`. `audit-index47-census.js` mechanically re-derives
  the 247 sites (AST candidates minus `final-folds.json` folded ranges) and
  classifies every one with source evidence and Node-executed probes:
  245 are packed-slot storage on `[arguments]` array bags (slot 47 written as
  a scalar, counter, or object — dotted `.length` would read the bag's element
  count, proven by the `X.length != X[47]` probe), and 2 are nested-receiver
  sites (L3081 `N7I[98][47] =` is a real-array element write into the
  `capZones` label table; L6257 `O7a[7][47]` is the table-string read
  `"length"` retained because the strict carrier fold rule requires every slot
  assignment to dominate the read and the in-loop write does not dominate).
  Zero sites are safe dotted substitutions.

This does **not** mean the original source is fully deobfuscated. Dotted output
is an analysis label for a resolved table index, not evidence that the original
packed argument-array slot was a JavaScript named property. The artifact is
data-flow readable, not a recovery of original symbols or control flow.

### 38.2 Retained artifact contract

The local `.deobf/` directory deliberately retains only the following 31
artifacts. Legacy intermediate bundles, per-pass scripts, and stale run logs
were removed on 2026-08-02.

| Group | Files | Role and retention rule |
|---|---|---|
| Canonical source chain | `alpha2s.raw.js`, `alpha2s.pretty.js`, `alpha2s.readable.js` | Raw is the byte-exact captured build; pretty is the immutable pipeline input and line-evidence target; readable is the reproducible analysis output. |
| Derived inputs | `tables.json`, `callsites.json`, `anchors.json` | The decoded table, conservative receiver verdicts, and 43 banner anchors. Regenerate only from the retained canonical source. |
| Producers | `dump-tables.js`, `analyze-callsites.js`, `final-pipeline.js`, `op-dispatch-fold.js` | Respectively create the table, receiver analysis, canonical readable output plus sidecars, and validate/extract the dispatcher formula map. |
| AST and fold proof | `ast-member-scan.js`, `table-lookup-fold.js`, `final-stats.json`, `final-preamble-folds.json`, `final-folds.json`, `final-dispatcher-folds.json`, `final-formula-folds.json`, `final-stateful-decoder-folds.json`, `audit-training-statics.js`, `audit-map-option-writers.js`, `audit-out-of-table.js`, `audit-dynamic-training-residuals.js` | AST member discovery, immutable-table proof, current run metrics, source-order preamble capture provenance, literal AMD-body fold provenance, dispatcher-index provenance, formula provenance, stateful setup-decoder fold provenance, direct static facts, complete table-origin option-writer censuses, and intentionally retained residual inventories. |
| Independent gates | `audit-independent.js`, `audit-preamble.js`, `audit-formula-fold.js`, `audit-stateful-decoder-fold.js`, `audit-table-lookup.js`, `audit-table-lookup.log`, `audit-index47-census.js`, `test-anchors.js` | Independent pass-one, preamble-capture, formula, stateful-decoder, AMD-body fold, index-47 census, and anchor checks plus the atomically refreshed successful fold-audit log. |
| Historical evidence | `audit-report.txt` | Preserved 2026-07-30 audit snapshot only; its counts and index convention are not current. |

The raw-to-readable flow is:

```text
alpha2s.raw.js -> alpha2s.pretty.js
pretty -> tables.json + callsites.json + anchors.json
pretty -> final-pipeline.js -> readable.js + final-stats.json + final-preamble-folds.json + final-folds.json + final-dispatcher-folds.json + final-formula-folds.json + final-stateful-decoder-folds.json
```

`final-stats.json` reports JavaScript string length (4,474,478 characters) for
the generated readable output; the physical UTF-8 file is 4,474,907 bytes.
This documentation consistently uses the latter file size.

### 38.3 Reproducible pipeline and audit closure

The final merge runs source-order preamble decoder capture, pass4 string
inlining, pass4b stateful setup-decoder folding, pass3 constant operation
folding, immutable table-string folding,
strict dispatcher-index string folding, strict pass3b formula substitution, AST
pass1 labeling, then banner
insertion. It has no dropped overlaps in the current build.

| Check | Current result |
|---|---:|
| Preamble literal decoder captures | 1,731: 1,724 table strings + 7 stateful warm-up primitives; two fresh captures agree |
| Body decoder/primitive inlines | 5,939 string inlines + 96 `t$4`/`g7y` op-folds |
| Stateful setup-decoder folds (`t8H`/`n6e`) | 791 / 791 zero-argument AMD-body calls folded to steady value 73; the single arming preamble `B3jF8.n6e();` (line 2424) retained; structural gate + two fresh boots agree (first call 93, steady 73) |
| Literal operation folds | 1,696; 207 non-literal argument skips handed to pass3b |
| Strict pass3b formula substitutions | 207 / 207; 0 rejections; 48 inline + 159 order-preserving IIFE lowering; 368 argument substitutions + 111 annotations across 191 sites; 0 index-47 recoveries |
| Pass3 folded-LHS recovery | 1,560 dotted labels and 135 annotations |
| AST body candidates | 89,199 |
| Table-fold-covered source sites | 46,518 |
| Strict dispatcher-index table folds | 86 / 88 direct table-origin dynamic reads; 2 stateful-interposition rejections |
| Final dotted analysis labels | 31,373 |
| Final bracket annotations | 11,298; 0 name mismatches |
| Unchanged out-of-table literals | 10 |
| Out-of-table training relevance | All 10 are read-only nested UI/utility accesses; no classic physics, map-codec, or converter path |
| Dynamic-bracket training relevance | All 4 retained dynamic brackets are renderer/display paths; no classic physics, map-codec, or converter path |
| Banners | 43, all anchor checks pass |
| Independent table-fold verification | 23,852 / 23,852 literal folds and 86 / 86 dispatcher-index folds approved; 0 extra, unproven, or wrong-value folds |
| Independent formula-fold verification | 207 / 207 folds re-derived; paired readable AST formulas match exactly (48 inline, 159 ordered) |
| Independent stateful-decoder verification | 791 / 791 fold sites re-derived from pristine source; readable pairing walk confirms every site is a `73` literal; 0 anomalies across 233,900 node pairs; the arming preamble call is retained |
| Training-static verification | Foot defaults, swing defaults, `ms.fl` force reader, linear shrink formulas, exact `mapVersion=15`, and no `swingF`/`swingD` map override re-derived from source anchors, dispatcher cases, and final-fold provenance |
| Independent pass-one closure | 0 gaps, 0 pairing mismatches, 0 unlabelled in-table brackets |

`node --check .deobf/alpha2s.readable.js` passes. Two fresh full pipeline runs
produced the identical readable SHA-256:
`2097916F16311692A5A457690E3BD8377AC0D07E7D58AD95490C73FF74BAADD3`.

Run the complete current verification set with:

```text
node .deobf/final-pipeline.js
node --check .deobf/alpha2s.readable.js
node .deobf/ast-member-scan.js --self-check
node .deobf/audit-independent.js
node .deobf/audit-preamble.js
node .deobf/audit-formula-fold.js
node .deobf/audit-stateful-decoder-fold.js
node .deobf/audit-training-statics.js --self-check
node .deobf/audit-map-option-writers.js --self-check
node .deobf/audit-out-of-table.js --self-check
node .deobf/audit-dynamic-training-residuals.js --self-check
node .deobf/audit-index47-census.js --self-check
node .deobf/audit-table-lookup.js --verify
node .deobf/test-anchors.js
```

Each audit exits nonzero for a syntax failure, coverage gap, invalid fold
provenance, incorrect annotation, unsafe dotted output, formula binding/order or
representation mismatch, pass3-LHS mismatch, or anchor failure. The preamble audit independently replays the original call
sequence, validates capture provenance, and boots both artifacts to compare
their materialized tables. The AMD-body fold audit does not treat
`final-stats.json` as an oracle: it independently decodes the table, proves its
immutable binding, re-derives all strict dispatcher-index candidates in fresh
VM contexts, aligns the pretty/readable ASTs, and admits formula transforms only
after `audit-formula-fold.js` independently re-derives their provenance.

### 38.4 Deliberately retained residuals

**Preamble.** The AMD factory begins at byte offset 1,746,512 (line 2431) of
the 3,634,211-byte pretty source. Its preceding approximately 2,430-line
header remains bootstrap code, but no longer retains literal decoder calls:
the pipeline source-order captures and folds all 1,731 `U3q`/`w65` literals
(1,724 `M$QCc` strings and seven warm-up numbers). The decoder helpers, global
resolver, numeric-operation dispatcher, dynamic decoder uses, and unrenamed
bootstrap symbols remain deliberately intact; pass1 property labeling still
applies only to the AMD body.

**Dynamic access.** The literal table-fold proof still rejects 1,069
dynamic-index candidates; the independent literal re-derivation reports 1,067
because it applies a narrower carrier universe. A separate direct-alias pass
finds 88 dispatcher-resolved table reads, folds all 86 strict adjacent-selector
sites, and retains `S8z[Z9u]` and `r5E[J6c]` because a statement (the folded
`73;` decoder call, formerly `k7V.t8H();`) still separates selector
from computation. The callsite audit reports three remaining dynamic brackets
on its tracked receivers: two `a9M` data-record reads (not table aliases) and
`S8z[Z9u]`; `r5E[J6c]` has no literal-index evidence, so it is outside that
receiver inventory. Four dynamic brackets remain globally, all deliberately
unchanged rather than being given speculative names.

**Decoders and control flow.** The stateful setup decoders `t8H`/`n6e` are
fully folded (§39): all 791 AMD-body calls became the steady literal 73, and
the only surviving call is the arming preamble `B3jF8.n6e();` at line 2424.
The current audit counts 1,639 residual
dispatcher/selector occurrences: `w_c` 438, `Q5$` 379, `H0n` 405, and `d1M`
417. Pass3 hands its 207 non-literal operation sequences to pass3b; all 207
satisfy the strict factory/binding/adjacency proof and are emitted as static
formulas (48 inline, 159 via the order-preserving IIFE lowering). The flattened `switch` dispatchers are not reversed. The current readable artifact still contains 112.4
obfuscated identifier tokens per 100 lines, so original local, parameter, and
function names have not been recovered.

**Known source-level limits.** The following remain partial or unresolved: the
exact server-supplied coverage of `ms.fl`, the legacy `<v12` `ig` default,
football host ball spawn/reset, CCD sweep details in the bundled Box2D code,
and live map capture for training. These are not silently approximated.

**Out-of-table residual disposition.** `audit-out-of-table.js` inventories all
ten retained literal accesses. They are read-only nested accesses at lines
22871/22873, 23755/23756, 28241, 32092, 36636, and 39181/39185; the contexts
are anonymous-class state, `show()`/visibility lifecycle, a helper initializer,
and a `Date` utility. None is in the classic physics step, map codec, or map
conversion path. They remain deliberately unnamed because no property-table
value exists and their actual property strings are not source-proven.

**Dynamic residual disposition.** `audit-dynamic-training-residuals.js` records
the four globally retained dynamic brackets: `a9M[Q3y]`/`a9M[D4d]` set PIXI
particle display coordinates, `S8z[Z9u]` scales a `render()` emitter update,
and `r5E[J6c]` is a scoreboard comparator. Their stateful/data-record paths
remain deliberately bracketed, but none participates in training physics, map
codec, or map conversion.

### 38.5 Boundaries outside client static analysis

The AMD body imports `socketio`, `peer.min`, and
`physics/box2dweb/Box2DModuleGJMod`. The client reveals packet formats,
frame-indexed input handling, replay/state codecs, and its local simulation
path, but it does not contain private server matchmaking, routing, validation,
or authority. It also does not expose readable internals for the imported
physics module. An exact client/server clone therefore still requires live
differential traces and an independently implemented server.

The retained indices, source ranges, and decoded names are specific to the
2026-07-29 build. Any fresh `alpha2s.js` download must be captured as a new raw
artifact and the table, callsites, folds, audits, and documentation re-derived.

### 38.6 Historical correction matrix

The following corrections supersede incompatible early notes in §§4, 9-11,
18, 20, 22, 25, and 27-30. Those notes are preserved as investigation history,
not as current simulator requirements.

| Historical ambiguity or incorrect claim | Current authoritative finding |
|---|---|
| `500` is native grapple reach | `500` is the `a1a` energy threshold. Grapple targeting uses QueryAABB and a 10-unit center-to-surface window; see §32.3. |
| Grapple frequency/damping comes from `fh`/`dr` | `fh`/`dr` are map-defined `d`-joint fields. Grapple uses `swingF`/`swingD`, with a 0.01 taut/slack branch; see §32.4. |
| `scaleRatio` is per-player or scales movement force | It is a renderer-global fitted-canvas zoom factor (`width / 730`); see §34.5. |
| Player disc friction/restitution are `0` / `0.8` | The live 2026-07-29 disc fixture uses friction `0.001337` and restitution `0.95`; density is the radius-normalized baseline, modified by heavy; see §35.4 and the fixture anchor. |
| `a1a` is arrow angle or `a1` has the later `a2` index | `a1a` is the special/energy meter; the corrected table labels are `a1` at 191 and `a2` at 193. |
| `sk` is a balance flag and balance directly scales force | `sk` is shrink state. Balance adjusts disc scale/radius, with force changing through the radius-squared relation; see §§31.5 and 35.4. |
| Literal `Step(dt, 2, 6)` is a second classic-world step | It belongs to football engine `B` and its own zero-gravity world; see §§34.4 and 35.2. |
| Force zones, cap-zone tagging, and joint families are unresolved | `fz` contact behavior, cap-zone fixture tagging, and the relevant joint families are source-verified in §§31.1, 33.7, and 33.8. |
| Blank-map version is `13` | The current blank-map factory emits `v:1`; later decode compatibility gates extend through v15; see §33.1. |

No entry in this matrix retroactively turns an old guess into proof. Each
replacement finding is tied to the retained pretty source, a regenerated
readable artifact, and the validation chain above.

---

## §39 Stateful Setup-Decoder Fold: `t8H`/`n6e` → 73 (2026-08-04)

This section documents the resolution of the last 791 intentional
decoder-inline skips (previously "380 `t8H` + 411 `n6e` stateful/setup skips").
The two call forms are now folded to the constant `73`, closing the stateful
decoder residual of the property-access pipeline (roadmap items S0.4 and S4.2).

### 39.1 Decoder identity

`B3jF8.t8H` and `B3jF8.n6e` are two identical wrapper functions (pretty lines
289-291 and 348-350) that forward every call to the same closure function
`B3jF8[210213].f_fpV2a`. The factory IIFE at pretty line 501 creates one object
(`R1n[8]`) with exactly one method, `f_fpV2a`, and assigns it to
`B3jF8[210213]` exactly once; nothing else in the bundle references the factory
key. There are no other callers of `f_fpV2a` and no direct writes to
`B3jF8[210213]`.

### 39.2 The machine is a two-phase environment probe

`f_fpV2a` is a flattened `switch` state machine (`f2U`, cases 1-151). Its only
cross-call state is the factory-closure slot `R1n[4]`:

| Case | Behavior | Evidence (pretty lines) |
|---|---|---|
| 1 (entry) | `f2U = R1n[4] ? 5 : 4` — branches on the state slot | 700-702 |
| 4 → … | Probe setup and execution (phase span): builds a list `Z6x[5]` of named probes (`a5z` names, `H3o` test functions) that run `decodeURIComponent`, `new RegExp`, `atob`, `endsWith`, `unescape`, `typeof` checks, a `for…in console` enumeration, `debugger`, etc., each verifying that an obfuscator helper's function source is unmodified | 595-1007 (probe phase; individual case ranges below) |
| 126/124/123/122/151/150 | Executes every probe, records `{name: result}` into `Z6x[91]`, then the case-149 inner check computes each distinct name's pass fraction and requires every fraction ≥ 0.5 | 652-800, 997-999 |
| 149 | `f2U = inner(Z6x[91]) ? 148 : 147` | 861-967 |
| 147 (arming result) | `R1n[4] = 26; return 93;` — arms the state slot and returns the first-phase value | 846-849 |
| 148 (divergent) | `f2U = 98 ? 148 : 147;` — a literal-true loop that never returns; a hang trap when the probe check passes | 827-829 |
| 5 (steady) | `return 73;` — runs unconditionally once `R1n[4]` is truthy | 635-637 |

The only closure writes are the initialization `R1n[4] = undefined` (line 507)
and the single arm write `R1n[4] = 26` (case 147); `R1n[8] = {}` (line 508)
creates the module object. Therefore:

- **First call:** runs the full probe sequence; either arms `R1n[4] = 26` and
  returns 93, or never returns (case 148 trap).
- **Every later call:** case 1 → case 5 → returns 73, with no side effects.

### 39.3 Why every AMD-body call is second-or-later

The first call in program order is the top-level preamble statement
`B3jF8.n6e();` at pretty line 2424 — before the `M$QCc` materialization
(line 2430) and before the `requirejs(...)` factory (line 2431). All 791 body
calls (pretty lines 2436-41875) are inside the AMD factory or its nested
definitions, so they execute only after the preamble statement ran. If the
arming phase completed, `R1n[4]` is armed; if the case-148 hang trap diverged, the bundle never
reaches the factory. In both cases a body call that executes returns 73.

Empirically, in Node the probe check fails, so the preamble call returns 93 and
arms the slot. Two fresh preamble boots agree (first call 93, all post-boot
samples 73) — this is part of the fold gate.

### 39.4 Fold rule and provenance

**Admission rule (pass4b):** a zero-argument `t8H`/`n6e` call on `k7V`/`B3jF8`
inside the AMD body is replaced by the literal `73` only when (a) the
structural proof of §39.2 holds, (b) two fresh preamble boots agree on
first-call 93 and steady 73, and (c) the per-site sandbox evaluation returns
exactly 73. The arming preamble call `B3jF8.n6e();` (line 2424) is **never**
folded: its side effect (arming `R1n[4]`) is required by every later call.

**Counts (before → after):** 791 skips (380 `t8H` + 411 `n6e`) → 791 folds;
`pass4` skip reasons `t8H_never_inline`/`n6e_never_inline` no longer exist.
All 792 source call sites are zero-argument expression statements; the single
preamble one is retained.

**Verification:** `audit-stateful-decoder-fold.js` independently re-derives the
structural facts, boots the preamble twice in fresh VMs, re-derives all 791
candidates from the pristine source (380/411), checks the
`final-stateful-decoder-folds.json` sidecar bijection, and runs a
233,900-node AST pairing walk over the readable output: every candidate site is
a `73` literal, no body `t8H`/`n6e` call survives, and the arming call is
retained — 0 anomalies. `audit-independent.js` additionally asserts
`body=0 / preamble=1` residual setup-decoder calls. Two fresh pipeline runs
produce the identical readable SHA-256
`2097916F16311692A5A457690E3BD8377AC0D07E7D58AD95490C73FF74BAADD3`.

### 39.5 What this does not claim

The fold is a constant-folding of a state machine, not a claim about what the
probes detect or what the original names were. The probe/trap semantics are
documented as observed behavior of the retained build; the case-148 hang is a
divergent path that never executes in the retained build's normal operation.
The two dispatcher-interposition sites `S8z[Z9u]` (line 22938) and `r5E[J6c]`
(line 23501) remain bracketed: after the fold a `73;` statement still sits
between the selector and the index calculation, so their strict-adjacency
rejection is unchanged.
