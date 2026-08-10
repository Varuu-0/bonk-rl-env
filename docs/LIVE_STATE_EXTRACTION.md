# Bonk.io Live Game State Extraction — Research Log

Status: IN PROGRESS (autonomous reverse-engineering investigation)
Start: 2026-08-09
Objective: Extract the numerical game information required by the trained
bonk-rl-env AI from the real (obfuscated) Bonk.io website at runtime, in a form
that maps onto the training observation space.

This is a living research document. Findings are appended as they occur. Failed
approaches are recorded as prominently as successes so future developers do not
repeat them. Claims are labeled by confidence:

- **[CONFIRMED]** reproduced/validated with evidence
- **[LIKELY]** strong structural/static evidence
- **[HYPOTHESIS]** plausible, not yet validated
- **[FAILED]** investigated and disproven or abandoned
- **[OPEN]** unresolved

---

## 0. The source of truth: what the trained AI consumes

The training environment (`python/envs/bonk_env.py`) wraps a Node.js Box2D
simulation. It declares:

- **Observation space:** `Box(-inf, inf, shape=(14,), dtype=float32)`
  1. playerX
  2. playerY
  3. playerVelX
  4. playerVelY
  5. playerAngle
  6. playerAngularVel
  7. playerIsHeavy (0/1)
  8. opponentX
  9. opponentY
  10. opponentVelX
  11. opponentVelY
  12. opponentIsHeavy (0/1)
  13. opponentAlive (0/1)
  14. tick

- **Action space:** `Discrete(64)` — six binary inputs packed into a 6-bit int:
  bit0 Left, bit1 Right, bit2 Up, bit3 Down, bit4 Heavy, bit5 Grapple.

The simulation derives these from its `PhysicsEngine`:
- position `p * scale`, velocity `v * scale`, `angle`, `angularVel`, `isHeavy`
  (a per-player flag set to the last action's heavy bit), `alive`,
  `deathType`, and a monotonic `tickCount`.

**Bridge requirement (restated):** reproduce dims 0–13 from the live client's
runtime state, and feed the client the Discrete(64) action each tick.

---

## 1. Prior work already in this repo (recon starting point)

The project already contains substantial live-client investigation. Key assets:

- `docs/DEOBFUSCATION.md` — 4700+ lines of client deobfuscation: control-flow
  flattening, the `M$QCc` runtime constant table, Box2DFlash world, disc field
  semantics, death system, cap zones, grapple, etc.
- `Webscripts/codeinjector.js` — the "Code Injector" userscript that fetches
  `alpha2s.js`, patches it with user-supplied injector functions, and installs
  it in place of the original.
- `Webscripts/capture-init.js` — a Playwright `document-start` init script that
  installs the same state hook. Sets `window.__bonkExportState` / `__bonkExportGameSettings`.
- `Webscripts/mapexporter.js` — uses the captured state to export faithful maps
  and also captures `__bonkExportWorld` (the live b2World) and
  `__bonkExportPhysicsConstants`, plus the runtime `M$QCc` table.
- `Webscripts/bonkhost.js` — a host tools mod. Shows EXACTLY how to intercept
  `toolFunctions.recvInputs(playerId, packet, "node")` and reads per-player
  network input packets (incl. `packet.f` frame counter) — crucial for opponent
  input/heavy extraction.
- `Webscripts/bonkbot.js` — Playwright-driven automation API. Provides
  `probePlayerDiscs()` and `identifyLocalPlayer()` already reading the captured
  state's disc fields.
- `docs/BONK_AUTOMATION.md` — full Playwright automation reference (login, custom
  game, map picker, start match) with element IDs, plus the live-identification
  approach via `localPlayerID`.

**Conclusion at start:** the info required by the model is present in the live
client, and a large fraction of the plumbing (capture, identification) already
exists. What is missing is (a) an authoritative live-state adapter that produces
the exact 14-dim obs each tick, (b) an action/frame pacing mechanism, and
(c) validation of remaining fields (tick, alive, heavy).

---

## 2. Attack surfaces considered

1. **[PRIORITY] Per-tick captured state** `__bonkExportState` — the authoritative
   per-tick state object written by the game's own step function. Contains
   `discs[]` with x/y/xv/yv/a/av and death info. Best fit for obs dims 0–5,8–10,13.
2. **Live Box2D world** `__bonkExportWorld` — the rebuilt b2World each tick; body
   queries give exact `GetPosition/GetLinearVelocity/GetAngle/GetAngularVelocity`.
   Useful for validation/cross-checking the captured disc arrays.
3. **[PRIORITY for dim 11/12] Network input packets** via `recvInputs` — each
   player's packed input (incl. heavy bit 16 and grapple bit 32) is delivered
   per tick. This is the ONLY source of the opponent's heavy/grapple state.
4. **Canvas/pixel readback** — rendering only; not authoritative, high cost. Not
   preferred. [HYPOTHESIS]
5. **Server-side / Manifold** — out of scope; the objective is the real website.

The convergence plan is surfaces (1)+(3): read positions/velocities from the
per-tick state, and opponent inputs from the network packet, composing the
14-dim obs + a Discrete(64)→key-state feedback path.

See §3+ for the detailed mapping and the implementation.

---

## 3. Field-by-field mapping (training obs → live source)

| Obs dim | Training source | Live source (proposed) | Confidence |
|---------|-----------------|------------------------|------------|
| 0 playerX | `body.GetPosition().x * scale` | `state.discs[localID].x` | CONFIRMED (field exists; scale to reconcile) |
| 1 playerY | `...y * scale` | `state.discs[localID].y` | CONFIRMED |
| 2 playerVelX | `vel.x * scale` | `state.discs[localID].xv` | CONFIRMED |
| 3 playerVelY | `vel.y * scale` | `state.discs[localID].yv` | CONFIRMED |
| 4 playerAngle | `body.GetAngle()` | `state.discs[localID].a` | CONFIRMED |
| 5 playerAngularVel | `body.GetAngularVelocity()` | `state.discs[localID].av` | CONFIRMED |
| 6 playerIsHeavy | action heavy bit | **local input we issue** (we hold the key) | CONFIRMED for local; our own action |
| 7 oppX | `opp.GetPosition().x*scale` | `state.discs[oppID].x` | CONFIRMED |
| 8 oppY | `...y*scale` | `state.discs[oppID].y` | CONFIRMED |
| 9 oppVelX | `vel.x*scale` | `state.discs[oppID].xv` | CONFIRMED |
| 10 oppVelY | `vel.y*scale` | `state.discs[oppID].yv` | CONFIRMED |
| 11 oppIsHeavy | action heavy bit of opponent | **`recvInputs(packet)` heavy bit** | LIKELY (network input bit 16) |
| 12 oppAlive | `state.alive` / deathType | `discDeaths` / `diedThisStep` / disc removal | OPEN (see §5) |
| 13 tick | `tickCount` (monotonic) | monotonic frame counter (see §4) | OPEN (see §4) |

Coordinate scale reconciliation is a key concern (§6).

---

## 4. Tick source investigation [IN PROGRESS]

The training `tick` is a monotonic per-episode counter. Open questions:
- Does the per-tick state expose a monotonic counter? The state has `ftu`
  ("frames to update"), `fte` ("frames to end"), `rl` (round length),
  `rc` (round count). `ftu` appears to count down during the round.
- The network input packets carry `packet.f` (frame number) — bonkhost.js uses
  `packet.f - window.bonkHost.fig` for lagginess, establishing a global
  monotonic frame counter `fig`.
- The physics tick rate is server-authoritative (30 TPS from network protocol).

Investigation tasks: determine the exact monotonic frame counter accessible in
the captured state or via injection; decide whether to synthesize our own
incrementing counter on each `__bonkExportState` write (simplest and robust).

---

## 5. Opponent "alive" determination [IN PROGRESS]

Training alive = the player's disc still exists and deathType is not set, per the
env's `playerAlive` map. In the live client the disc remains in `discs[]` after
death (respawn) or is reset each round; `diedThisStep` (on per-tick globalStepVars)
and `state.discDeaths[]` track deaths. Need to pin the exact field that indicates
"this disc is currently alive" across a round, and how it resets on a new round.

---

## 6. Coordinate / scale reconciliation [IN PROGRESS]

Simulation obs uses `pos * scale` (SCALE default). The live disc `x/y` are native
"map units". The two coordinate systems differ. Since the model is trained on
the *simulation's* numeric scale, the live values must be mapped to a compatible
range (which can be a learned constant iff the game's coordinate system is
consistent). This affects dims 0,1,2,3,7,8,9,10. Investigate whether native
disc x/y are a consistent "map unit" that can be scaled to match training.

---

## 7. Action injection / feedback (Discrete(64) → game) [NOT STARTED]

The model picks an int in [0,64). We must set the local key state each tick:
left/right/up/down/heavy + grapple. Options:
- Dispatch synthetic key events to the game frame for bound keys
  (arrow keys/WASD, X/Shift heavy, grapple key). [LIKELY]
- Or set `inputState[localID].*` booleans directly if the physics step reads
  them (it does, per DEOBFUSCATION §16). [LIKELY]
Grapple is edge-triggered (`doGrapple` when `a2`/action2 input set while not
swinging); must match the training env's grapple toggle semantics.

---

## 8. Notes / decisions so far

- Adopt surfaces (1) per-tick state + (3) network input packets + (2) world for
  validation. Avoid canvas pixel readback.
- The existing `capture-init.js` + `codeinjector.js` pipeline is the correct
  injection base; it must run before `alpha2s.js` (document-start / userscript).

---

## 9. CONFIRMED findings — deep source trace (2026-08-09)

Four parallel subagents traced `.deobf/alpha2s.pretty.js` (the 2026-07-29 build;
`M$QCc` table resolved via `.deobf/tables.json`, 1724 entries, `names` array).
Line numbers reference the beautified file unless noted.

### 9.1 The tick / frame counter — CONFIRMED

- The serialized state has NO monotonic per-tick counter. `ftu` (idx 3) and
  `fte` (idx 4) **count DOWN** (`ftu--` each step; init 90, `pretty:3434/8453`).
  `rl` = round length, `rc` = round count (increments between rounds only).
- The monotonic counter is the client interpolation engine index `a5H[6]`
  (decoded `a5H.footHH`). Init `a5H[6] = 0` (`pretty:40465`); incremented once
  per physics tick at `pretty:40502` inside the fixed-step loop `v6V`.
- Main loop (`pretty:40946-40957`): fixed-timestep accumulator; `a5H[72] +=
  elapsedMs`; `while (a5H[72] > 1000/30) { v6V(30, ...) }` → **30 ticks/second**.
  `world.Step(dt, velIters, posIters)` runs only while `ftu == -1`
  (`pretty:8313-8325`), then `ClearForces()`.
- This is exactly the `fig` that Bonk-Host exposes: bonkhost.js:1810 matches
  `[a5H[6] - 30]` and patches `a5H[6]++; window.bonkHost.fig=a5H[6];`.
- **Per-match, NOT per-round:** `a5H[6]++` is the only increment; it is re-based
  on server announce only (`pretty:40623`, `40663`). So to reproduce the
  training per-episode `tick` (0-based, reset each round), REBASE `fig` against
  the value at round start (detect round start via `rc` change or `ftu` reset
  from `-1` back to positive).

### 9.2 Alive / death state — CONFIRMED

- `state.discDeaths[]` is a **rolling event log**, NOT a per-disc-index flag
  array. Schema `{i, x, y, xv, yv, f (age), m (deathType)}` (`pretty:8783-8792`);
  entries older than 90 frames are aged and dropped (`8711-8721`).
  > Correction to existing tooling: `bonkbot.js:700` (`isDead: discDeaths[i]`)
  > is WRONG — discDeaths is keyed by event, not disc index.
- Dead, non-respawning discs are **dropped** from the exported `state.discs[i]`
  (assigned `undefined` when `diedThisStep && (!re || diedThisStep==3)`,
  `pretty:8725`). With respawn enabled they are kept but teleported back to
  spawn (`8770-8781`).
- **Liveness = presence:** `alive = state.discs[i] !== undefined`. Matches the
  win-check (`pretty:8617-8639`: count when `!diedThisStep || (re && diedThisStep!=3)`).

### 9.3 Opponent heavy / grapple IS on the exported disc — CONFIRMED (major simplification)

- The physics step copies per-disc inputs onto the disc object:
  `pretty:7299-7300` → `disc.a1 = inputs[disc].action` (heavy),
  `disc.a2 = inputs[disc].action2` (grapple).
- The **exported** disc copies those: `pretty:8743-8744` writes `out.discs[i].a1`
  and `.a2` (indices 191 / 193).
- Resolved names (`tables.json`): 191=`a1`,193=`a2`,192=`action`,194=`action2`.
- **Therefore `opponentIsHeavy` = `state.discs[opp].a1` and opponent grapple =
  `.a2`, read directly from `__bonkExportState`.** No `recvInputs` network hook
  needed for the observation. The network hook remains useful as a cross-check.

### 9.4 Exported disc field set — CONFIRMED (source-verified)

Serialized disc (lines 8727-8755), exactly the fields the adapter must read:

| Field | Index | Source | Notes |
|-------|------:|--------|-------|
| x | 39 | `body[160]().x` | position, native map units |
| y | 40 | `body[160]().y` | position, native map units |
| xv | 108 | `body[255]().x` | linear velocity, map units/s |
| yv | 109 | `body[255]().y` | |
| a | 64 | `body[259]()` | angle (radians) |
| av | 55 | `body[256]()` | angular velocity |
| a1a | 119 | copied | grapple energy |
| team | 115 | copied | team number |
| a1 | 191 | = inputs[disc].action | HEAVY bit |
| a2 | 193 | = inputs[disc].action2 | GRAPPLE bit |
| ds | 196 | copied | disc state (0 normal) |
| swing | 150 | conditional | grapple joint state `{b,p,l}` |
| sx/sy/sxv/syv | 341/342/343/344 | from prev state | spawn |
| ni | 340 | copied | respawned flag |

### 9.5 Coordinate reconciliation — CONFIRMED favorable

- Training sim: world bodies placed at `map / SCALE` (`physics-engine.ts:657`),
  observation returns `pos * this.scale` (`:1501`) = **native map units**.
- Live disc `x/y/xv/yv` are **native map units** (game b2World runs directly on
  map coords). So **training obs position/velocity === live disc
  position/velocity, 1:1**, provided the SAME map is used. No per-dim scaling.
- `angle`/`angularVel` likewise match. `isHeavy` maps from the live input bits.

### 9.6 Action encoding is identical to the network byte — CONFIRMED

- Training `Discrete(64)` (bonk_env.py:52): bit0 left,1 right,2 up,3 down,4
  heavy,5 grapple.
- Game `decodeInputs`/`encodeInputs` (`pretty:38756-38792`): left=1,right=2,
  up=4,down=8,action(heavy)=16,action2(grapple)=32. **Exact match.**
- Network packets `42[4,{i,f,c}]` (outgoing inputs) and `42[7,...]` (incoming)
  carry this byte; `f` = frame, `c` = monotonic session sequence (DemystifyBonk
  Packets.md, BonkTools BONK_PROTOCOL.md — both fetched, agree). Transport is
  Socket.IO v2 / Engine.IO v3 (EIO=3), TLS Sectigo chain.

### 9.7 External ecosystem — CONFIRMED (web research)

- BonkBot (UnmatchedBracket/BonkBot, PyPI `bonk-bot`), Carter Beaudoin's
  "Bonk.io Custom Bot": headless websocket bots that speak the protocol and send
  raw `42[4,{i,f,c}]` inputs. A clean alternative integration path.
- In-frame bots (GreninjaOP "Bonk.io AI Control", Bonker Client, Bonk Cheat
  Client) drive the live client by key-code maps + WebSocket hooking.
- bonk-deobfuscator (kookywarrior) tooling for the `M$QCc` table decode.
- This validates our approach: both the in-frame key dispatch (surfaces 1+2)
  and the raw-socket input path (alternative) are established, public methods.

---

## 10. Implementation built

`Webscripts/rl-live-bridge.js` provides `window.__bonkRL`:
- `readObservation()` → `Array(14)` in training space (see §3 mapping table,
  with the §9.1 tick rebase, §9.2 alive, §9.3 heavy, §9.4 fields, §9.5 coords).
- `readRaw()` → structured debug view.
- `act(action)` → Discrete(64) → local key events (bit layout identical to
  network byte, §9.6).
- Registers its own `bonkCodeInjectors` entry (state anchor + `fig++` capture)
  so it can run alongside or instead of capture-init.js.

### Open items still to validate live
- [ ] §9.1 tick rebase correctness against a real multi-round match.
- [ ] §9.2 alive=presence across death+respawn+round transitions.
- [ ] §9.3 `a1`/`a2` on exported disc observed live (validated statically; a
      live probe will confirm runtime presence).
- [ ] §9.4 exact field set in the CURRENT live build (2026-08-09) vs the
      2026-07-29 artifact.
- [ ] Action dispatch (key events) actually moves the local disc.

See the "Validation" section below for the live probe harness.

---

## 11. Validation (2026-08-09)

### 11.1 Offline deterministic harness — PASS (all checks)

`scripts/validate-live-extraction.js` (no network) exercises:
- obs layout matches training `_convert_obs` + heavy from `a1`
- Discrete(64) bits == network input byte
- fig per-round tick rebase
- alive == presence in `state.discs`
- coordinate reconciliation (sim obs == live map units)
- dead opponent yields zeroed block

Result: `All offline validation checks PASSED` (6/6).

### 11.2 Live client probe — CONFIRMED (real match, 2026-08-09)

Playwright loaded `https://bonk.io/`, installed the capture-init state hook via
`addInitScript` (document-start), reloaded, and joined a live match.

**Constant table (current live build):** length **1724**; sampled indices all
match the 2026-07-29 artifact:
`41=discs,115=team,119=a1a,191=a1,192=action,193=a2,194=action2,
627=networkEngine,740=decodeInputs,741=inputs,1564=localPlayerID`.

**Live per-tick state** (`__bonkExportState`) top-level fields observed:
`ms, mm, shk, discs, capZones, seed, ftu, rc, rl, sts, physics, scores, lscr,
fte, discDeaths, players, projectiles` — exactly the serialized set.

**Live disc objects** carry exactly the source-verified fields
(`x,y,xv,yv,a,av,a1a,team,a1,a2,ni,sx,sy,sxv,syv,ds,da,lhid,lht,vt,
spawnTeamInfo`). Two live 1v1-style discs were observed with **positions and
velocities changing in real time** (e.g. disc15 x 26.78→7.57, y 16.43→11.37;
disc16 yv 5.58→12.7 over ~900 ms) — confirming the values are the live sim,
not stale. One opponent was observed with `a2:true` (grapple held), proving
`a1`/`a2` carry opponent input bits live (§9.3).

**`discDeaths`** observed with the exact `{i,x,y,xv,yv,f,m}` schema (m=1 event).

**Map settings / round state** observed: `ms.re/false, nc/true, pq/1, gd/25,
fl/true`, `ftu:-1` (gameplay), `rc` incrementing (round count).

**`__bonkFig` not observable in this probe** because only the capture-init hook
(inline) was installed, not the bridge's separate `fig++` injector. The fig
capture path is source-verified and offline-validated; a follow-up probe with
`rl-live-bridge.js` installed would confirm the runtime `fig`.

### 11.3 Confidence summary

| Item | Status | Evidence |
|------|--------|----------|
| Disc field set (`x,y,xv,yv,a,av,a1,a2,team,ds`) | CONFIRMED | Source trace + live probe |
| Opponent heavy/grapple via `a1`/`a2` | CONFIRMED | Source (`pretty:7299-7300,8743-8744`) + live (`a2:true`) |
| Alive == presence in `state.discs` | CONFIRMED | Source (`pretty:8725`) + offline |
| Monotonic tick = `a5H[6]`/`fig` per match | CONFIRMED (source) | Source trace; runtime `fig` pending |
| Coordinate units (obs == live disc units) | CONFIRMED | Source + offline |
| Discrete(64) bits == network byte | CONFIRMED | Source + offline + protocol docs |
| State capture hook pipeline works live | CONFIRMED | Live probe populated `__bonkExportState` |
| Action dispatch moves local disc | NOT LIVE-TESTED | Key-event path is public-ecosystem standard |

### 11.4 Unresolved questions

- **Network transport for input injection is viable** (raw `42[4,{i,f,c}]` via a
  websocket client, using the documented Snap-on/Socket.IO-v2 stack) as an
  alternative to in-frame key events; both need a real 2-player session to
  compare latency/reliability vs. the in-frame key dispatch.
- `localPlayerID` runtime discovery: the heuristic (host=index 0 in a custom
  match) is LIKELY but not validated in a self-hosted 2-player room; the bridge
  already prefers an injected `__bonkLocalPlayerID` (extend capture to also
  snapshot it).
- Exact latency of the per-tick state hook (whether it fires before or after the
  physics step the AI observes) matters for live control; the hook fires at the
  state-creation point (line ~8326), i.e. the tick's own state is what the step
  consumed — good for observation, and actions for the *next* tick are applied
  by the key-dispatch path.

---

## 12. How to reproduce (implementation)

### 12.1 Artifacts produced

| File | Purpose |
|------|---------|
| `Webscripts/rl-live-bridge.js` | Live adapter: installs injector + `window.__bonkRL` (readObservation/readRaw/act). |
| `scripts/validate-live-extraction.js` | Offline validation harness (deterministic, 6 checks). |
| `docs/LIVE_STATE_EXTRACTION.md` | This research log. |

### 12.2 Installing the bridge (Playwright or userscript)

Option A — Playwright (preferred for scripting; network reachable, proven above):
```js
await context.addInitScript({ path: 'Webscripts/rl-live-bridge.js' });
await page.goto('https://bonk.io/');
// ... log in, create/join a game, start the match ...
const frame = page.frameLocator('#maingameframe');
const obs = await page.evaluate(() => document.getElementById('maingameframe')
    .contentWindow.__bonkRL.readObservation());
const raw = await page.evaluate(() => document.getElementById('maingameframe')
    .contentWindow.__bonkRL.readRaw());
```

Option B — Userscript (Tampermonkey/Greasemonkey): load `codeinjector.js`,
`capture-init.js`, then `rl-live-bridge.js`; each registers a
`bonkCodeInjectors` entry applied on alpha2s load.

### 12.3 Feeding the trained model

Per 30 Hz tick (server-authoritative; the bridge reads the latest state each
call):
1. `obs = __bonkRL.readObservation()` → `Float32Array`/list of 14, ordered
   exactly like `bonk_env._convert_obs` (`[playerX,playerY,playerVelX,
   playerVelY,playerAngle,playerAngularVel,playerIsHeavy,opponentX,opponentY,
   opponentVelX,opponentVelY,opponentIsHeavy,opponentAlive,tick]`).
2. `action = model.predict(obs)` (Discrete in [0,64)).
3. `__bonkRL.act(action)` dispatches the bit-matched keys; heavy/grapple are
   edge-tracked locally.

If instead driving a headless socket client (alternative, §13), send
`42[4,{i:action,f, c:++c}]` on the websocket each tick and read positions from
the incoming broadcast state — the same 14-dim mapping applies.

---

## 13. Recommended integration path

1. **Short term (robust, minimal obfuscation exposure):** in-frame bridge
   (`rl-live-bridge.js`) driving a self-hosted custom 1v1 match on a favorited
   map matching a training map. Observation read via `readObservation()` per 30
   Hz; actions via key dispatch or by directly setting the frame's local input.
2. **Validation unit for transfer:** train/eval the same PPO policy with the
   observation scaled to match real disc coordinates (already 1:1 per §9.5) and
   confirm the policy's decision distribution on recorded live trajectories.
3. **Long term / scale-out:** a headless protocol client (BonkBot-style websocket)
   is more maintainable (no obfuscation dependency, no canvas) and can host many
   matches per machine. It shares the exact bit-mapping and the same
   observation dimensions, so the same policy can consume both sources.

### Failure modes & mitigations

- **Obscuration of numeric indices** between client builds → the bridge reads
  fields by NAME via the runtime `M$QCc` table (and the `fig` injector uses a
  documented, version-tolerant anchor), and mapexporter snapshots the full
  table per capture.
- **`recvInputs`/network parse** → not required for the observation (opponent
  heavy/grapple come from exported `a1`/`a2`), which removes a fragile
  dependency.
- **Round/team semantics** (1v1 vs teams vs respawn) → alive is presence-based,
  which holds in live play; teams only change WHO the opponent is (bridge picks
  the first other disc).
- **Anti-cheat / ToS** → this is research on client-side state reading; whether
  to operate this against live public rooms is a policy decision, not a
  technical one. Prefer self-hosted custom rooms for validation.

---

## 14. Failed / abandoned approaches (recorded)

- **Reading opponent inputs from `arguments[1]`/inputs array directly** — NOT
  needed: the exported disc already carries `a1`/`a2` (heavier/simpler). The
  `recvInputs` hook remains optional.
- **Canvas pixel readback** — abandoned: not authoritative, high overhead; the
  per-tick state is directly available.
- **The `discDeaths[i]` liveness check in bonkbot.js** — WRONG (discDeaths is an
  event log, not per-index); corrected here; liveness = presence.
- **Numeric-index hardcoding** as a stable API — documented as build-specific;
  the bridge resolves field names through the live `M$QCc` table instead.

---

## 15. Recorded-match playback support (2026-08-09)

**[CONFIRMED, source-traced]** Main-menu recorded matches run the same classic
post-step serializer targeted by the state-capture anchor
`...={discs`. Replay playback uses deterministic, frame-indexed input
simulation but emits the same serialized `discs`, `physics`, `players`, `rc`,
and related fields as live gameplay. Therefore the live-state observation
mapping applies unchanged to recorded matches.

`Webscripts/bonk-live-tool.user.js` now gates capture on
`arguments[0].discs`, rather than `arguments[0].physics.bodies`. `discs` is the
minimal field guaranteed by both live and replay serialized frames; this also
admits any replay frame whose physics bodies are lazily materialized. The hook
stamps `__bonkStateVersion` in that same capture block, so UI update detection
does not depend on the separate, build-sensitive `fig` patch.

Replay input storage may be sparse and frame-indexed. Disc kinematics and the
exported heavy/grapple flags (`a1`/`a2`) remain authoritative; a replay viewer
may not expose direct L/R/U/D booleans in the same dense shape as a live game.

---

## 16. mapexporter.js field audit (2026-08-09)

Deep audit of `Webscripts/mapexporter.js` (the map exporter) against
`alpha2s.pretty.js` (2026-07-29 build), `tables.json`, `DEOBFUSCATION.md`, and
the canonical DemystifyBonk `MAPFORMAT.md` / `PixelMelt/bonk-map`. Verdict: the
exporter is broadly correct on the *preferred* `gs.map` path, but has several
real bugs that produce null fields or wrong units on the tick-state fallback
path and in a few areas even on the map path.

### Outcome: it exports a fundamentally complete map — with 7 concrete defects

**CONFIRMED correct (both paths):**
- Serialized `state.physics` = `{shapes, fixtures, bodies, joints, bro, ppm, ss}`
  (pretty.js:8483-8491); `bodies[i]` = `{p,a,av,lv,cf,fx,fz,s}` (8567-8580).
- Body `s` surface fields re/de/de/fric/fricp/ld/ad/fr/bu/f_c/f_p/f_1..f_4 all exist.
- Shape keys `type,w,h,c,a,sk` / `r,c,sk` / `v,s,a,c` (box/circle/polygon);
  polygon `v` is `[x,y]` pairs. `ch` shapes mislabeled as polygon (benign).
- Fixture `sh,n,fr,fp,re,de,f,d,np,ng,ig` exist.
- Spawns schema `{n,x,y,xv,yv,priority,f,r,b,gr,ye}` — authoritative source is
  `gs.map.spawns` (editor px), which the exporter prefers correctly.
- Cap zones `{ty,p,l,i,o,ot,f}`; `cz.i` is a fixture index.
- Joints rv/d/lpj/lsj + the `d` data schema all correct.
- No METRES_TO_PX scaling is needed: tick-state `p` is world units (== training
  obs units 1:1, §9.5); `gs.map` is editor-px. **The exporter does NOT mix them
  on the map path** (map path is internally consistent editor-px).

**DEFECTS (would wrong/null on export):**
1. **Settings key wrong on tick path** — `const settings = state.s || {}`
   (line 117), but the live per-tick state exposes settings as **`state.ms`**
   (live probe: `ms.re/nc/pq/gd/fl`); `state.s` is not a tick-state field. Only
   the `gs.map.s` merge (794-799) saves the map path. Tick fallback settings
   come out all-default.
2. **Physics reads nonexistent fields** — `ph.grav/bw/bh/bg/bc/bdc/customres`
   (161-169) are NOT on either the tick `physics` or the map `physics` object
   → always null. Must come from the b2World/renderer, not the state.
3. **Fixture-level collision fields spuriously null** — `fx.f_c/fc/f_p/f_1..f_4/frc`
   (315-321) don't exist on fixtures (collision filter lives on `body.s`);
   these read null on the fixture objects. Only the flat/resolved views (476-480)
   re-read them correctly from `surf.*`. `frc` is absent from the constant table
   entirely (confirmed correction).
4. **Disc reads `fn`, `fz`** (214-215) — neither is on the serialized disc
   (real set includes `swing`, `spawnTeamInfo` which KNOWN.disc omits → spurious
   "unknown field" warnings and nulls).
5. **`metadata.version = mm.v`** (147) — `v` is a top-level map key, not on
   `mm`; `mm.v` is null. `vu`/`vd` only exist for map format `v>=10`.
6. **Cap-zone `l` unit inconsistency** — map path exports raw seconds while the
   tick path exports `l*30` ticks (line 3384: `l*30` = seconds→ticks at 30TPS).
7. **Physics-constant regexes are build-fragile** (628-659): `[620]=gravity`,
   `[46]=ppm`, `[326]=pq`, and `[327]=Step` are table-backed anchors and the
   current raw source matches all extraction patterns. `z0M[291]`/`z0M[554]`
   in the matching Step block are local temporary slots, NOT constant-table
   property accesses; a prior audit incorrectly mapped them to `joint1` and
   `textContent`. The extraction is valid for this build but remains
   token-coupled and must be revalidated after client changes.

**Net:** on the normal path (`gs.map` present) the exporter emits faithful
editor-px physics topology (bodies, surfaces, fixtures, shapes, joints, spawns,
capZones) plus a runtime constant table, but it is NOT yet a complete
all-information map export: the subsequent exhaustive review found primary-path
metadata loss and false unknown-field warnings (§16.1).

### Resolution (2026-08-09)

Fixed high-value defects in `Webscripts/mapexporter.js` (v2.3.0) and verified:

1. **Settings key** — `extractMap` now reads `state.s || state.ms`, so decoded
   map settings take precedence while the tick-state fallback exports real
   settings instead of all-defaults.
2. **Fixture collision filter** — a `fixtureOwnerSurface` map (body `fx` →
   owning `body.s`) is built once; fixture objects now source `f_c/f_p/f_1..f_4`
   from the owning body surface (correct per world-build 7577-7628), and `frc`
   is emitted `null` (absent from the constant table). The spurious fixture read
   (`fx.f_c/fc/f_p/f_1..f_4/frc`) was removed.
3. **Disc fields** — phantom `fn`/`fz` reads dropped; real `swing`/`spawnTeamInfo`
   added.
4. **Map version** — `metadata.version` now from `state.v` (top-level key), not
   `mm.v`.
5. **KNOWN sets** cleaned for fixture, disc, physics, mm, and top-level `v`;
   the later exhaustive review found that root `spawns` and map cap-zone `n`
   still require additions (§16.1).

Verified via a source-level verifier plus an end-to-end run of the real
`extractMap` against a realistic per-tick fixture (settings from `ms`,
body-surface collision propagation, disc `swing`/`spawnTeamInfo`, version from
`state.v`): **all assertions pass**; `node --check` clean.

### 16.1 Exhaustive follow-up review (2026-08-09)

Every line of `mapexporter.js` was re-reviewed after the fixes above, against
the current raw/pretty client source, constant table, and primary `gs.map`
export path. The previously fixed settings/collision/disc/version issues remain
fixed and the current injector regexes all match the raw client source. The
remaining confirmed defects are:

1. **Primary-map metadata loss** — `extractMap` reads `state.mm`, but map
   definitions use `state.m`; the caller merge restores common metadata but
   drops `m.rxid`, `m.rxn`, `m.rxa`, and `m.rxdb`. A direct primary-path
   reproduction confirmed all four export as null.
2. **False primary-path warnings** — `KNOWN.root` omits `spawns` and
   `KNOWN.capzone` omits map-definition `n`, so normal map exports log false
   unknown-field warnings.
3. **Convenience-view loss** — `physicsBodies[i].fixtures[]` omits body-surface
   collision masks (`f_1..f_4`, `f_p`); flattened `bodies[]` omits `fricp` and
   skips fixtures with missing shapes. Canonical arrays remain intact.
4. **Fallback schema/unit divergence** — tick fallback emits runtime-disc
   "spawns" rather than map spawns, and its cap-zone capture `l` is ticks while
   map-path `l` is seconds.
5. **Export lifecycle risks** — a detached download link has its blob URL
   revoked synchronously after click (browser compatibility risk); a preexisting
   export button causes `injectButton()` to return undefined and can crash the
   poller; the poller ignores tick-fallback map availability.
6. **Unsupported/opaque items** — chain `l` is omitted, gear (`g`) joints are
   not represented, and gravity/background/bounds fields are emitted null
   because they do not live in serialized `physics`.

The primary map path was reproduced with the real `extractMap` closure and
confirmed to lose the rx metadata / warn on `spawns` before any subsequent
repair. The map exporter therefore requires another correction pass before it
can claim a full all-information export.

### 16.2 Correction pass (2026-08-09, v2.4.0)

The confirmed actionable defects from §16.1 are fixed and covered by the real
`extractMap` closure plus the export-button path:

1. **Primary metadata** — `extractMap` now reads `state.mm || state.m`; the
   `gs.map` merge also explicitly preserves `rxid`, `rxn`, `rxa`, and `rxdb`.
2. **Primary-map fields** — `spawns`, cap-zone `n`, and v10 metadata markers
   `v`/`vu`/`vd` are included in `KNOWN`, eliminating those false warnings.
3. **Derived views** — resolved fixtures now retain body-surface collision masks
   and `fricp`; the flattened view retains `fricp` and fixtures with no shape.
4. **Cap-zone units** — the click path explicitly labels tick-state countdowns
   for division by 30 into seconds; decoded map definitions retain their
   already-second `l` values. `extractMap` defaults to map-definition units,
   making the source choice explicit rather than inferring it from metadata.
5. **Joints** — top-level joint `l` is retained as `physicsJoints[].length`.
   Gear-joint `d` data was already faithfully cloned as opaque `data`; it is not
   independently decoded because this build has no source-backed named schema.
6. **Download/UI lifecycle** — the exporter reuses an existing button, attaches
   and removes its temporary download anchor, defers object-URL revocation for
   one second, and exposes tick-only captures through the poller.

Validated with `node --check Webscripts/mapexporter.js`,
`node scripts/verify-mapexporter-fixes.js`, and
`node scripts/verify-mapexporter-e2e.js`. The end-to-end verifier covers both
the tick path and `gs.map`, primary rx metadata, cap-zone units, all derived
fixture fields, shape-free fixtures, chain length, both real button download
paths, deferred revocation, and tick-only polling.

**Remaining evidence boundary:** tick fallback can only emit live serialized
discs as best-effort spawns; it cannot reconstruct static editor spawns without
`gs.map`. Gravity, bounds, and renderer background remain unavailable in the
serialized `physics` object and must not be fabricated. Injector regexes remain
build-coupled and require raw-client revalidation after Bonk updates.
