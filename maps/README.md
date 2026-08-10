# maps

Bonk.io map exports in JSON format, produced by the **Bonk Map Exporter** userscript
(`../Webscripts/mapexporter.js`). Each file captures the full body → fixture → shape
hierarchy, collision configuration, spawns, and cap zones for a single arena.

## Capturing a map

The exporter is installed as a userscript on `https://bonk.io/gameframe-release.html`
(or `https://bonk.io/*`):

1. **Install `../Webscripts/mapexporter.js`** in your userscript manager (Tampermonkey/Violentmonkey).
2. Optional: also install `../Webscripts/codeinjector.js` (the shared "Code Injector"
   host) or `../Webscripts/bonk-live-tool.user.js`. The exporter is now self-contained,
   so it works alone too — it installs its own `alpha2s.js` fetch/patch hook, and is
   idempotent so coexisting hosts never double-patch.
3. Open a game (play or watch a match).
4. Click the green **⬇ Export** button (bottom-right). The exported JSON downloads as
   `bonk_<MapName>_<dbid>.json`.
5. Place the file here, keeping the `bonk_<MapName>_<dbid>.json` naming convention.

> **"No map loaded"?** The button shows that until the state hook captures a live game.
> It updates on the 1.5 s poller once `discs` (the stable gate) and game settings are
> captured after you join or spectate a match. If it never updates, confirm the
> userscript is enabled on the gameframe URL and that no browser extension blocks the
> `alpha2s.js` fetch.

## Files

| File | Description |
|------|-------------|
| `bonk_Simple_1v1_123.json` | Minimal 1v1 arena — a single flat platform |
| `bonk_Gang_Grounds_2_0_37368.json` | Popular community 1v1 map (Gang Grounds 2.0) with box/circle geometry |
| `bonk_WDB__No_Mapshake__716916.json` | WDB (World Domination Battle) map — capture zones, joints, polygons; the engine default |
| `bonk_WDB__no_nothing__1232248.json` | WDB variant with more bodies/joints |
| `bonk_WeiRd_DeAth_BalL__80622.json` | Open "death ball" arena with dynamic platforms and cap zones |

## Loading in the engine

The engine's `MapDef` loader (`src/core/map-adapter.ts::normalizeMap`) converts the
real exported bonk format into the internal engine shape at load time. It maps
`spawns[]` → `spawnPoints` (blue/red), `collidesGroup1..4` → `collides.{g1..g4}`,
`capZones[].fixtureIndex` → the named platform body, `physicsJoints[]` integer body
refs → body names, and computes a bounding-box `physics.deathCenter`. Any of the
files above load via `mapPath` / `defaultMapPath` / `mapData`. The default map is
`bonk_WDB__No_Mapshake__716916.json`.

## Map Format

The exporter emits a full, faithful hierarchy rather than a flattened list. Key
top-level keys: `metadata`, `settings`, `physics`, `physicsBodies`, `physicsFixtures`,
`physicsShapes`, `physicsJoints`, `spawns`, `capZones`, `bodies` (flat convenience),
`bodyRenderOrder`, `exportedAt`, and (when available) `runtimeConstantTable` and
`extractedPhysicsConstants`.

### Metadata
- `name`, `author`, `dbid`, `dbv`, `authid`, `date`, `mode`, `published`
- `rxid`, `rxn`, `rxa`, `rxdb` — remix identifiers
- `version` — map format version (top-level `v`)
- `contributors`

### Settings
Map-level physics toggles: `re` (respawn), `nc` (no-collision), `pq` (quality),
`gd` (gravity), `fl` (show flags).

### Physics (global)
`ppm` (pixels per metre). Global gravity/bounds/background fields are emitted as
`null` because they do not live in the serialized `physics` object; runtime gravity
(if the b2World was captured) appears under `extractedPhysicsConstants.runtimeGravity`.

### Bodies (per `physicsBodies[]`)
Position/angle, linear/angular velocity, surface physics (`friction`, `restitution`,
`density`, `linearDamping`, `angularDamping`), collision filters (`collidesGroup1..4`,
`collidesPlayers`), flags (`fixedRotation`, `antiTunnel`), `constantForce`, `forceZone`,
`fixtureIndices`, and resolved `fixtures[]` (each carrying its shape, physics, and
collision masks).

### Shapes (`physicsShapes[]`)
`type` is one of:
| `type` | Shape |
|--------|-------|
| `bx` | Box (rectangle, `width`/`height`) |
| `ci` | Circle (`radius`) |
| `po` | Polygon (vertex array) |

### Joints (`physicsJoints[]`)
`type`, `bodyA`, `bodyB`, `data` (opaque clone of the raw `d`), `length`, plus
type-specific fields for revolute (`rv`), distance (`d`), line/prismatic (`lpj`), and
rope (`lsj`).

### Spawns
Array of spawn points from the decoded map definition (`gs.map.spawns`), each with
`index`, `name`, `x`, `y`, `xVelocity`, `yVelocity`, `priority`, and per-team flags.

### Cap Zones (`capZones[]`)
Each zone has `index`, `name`, `type`/`typeName`, `captureTime` (seconds), `fixtureIndex`,
`owner`, `originalTeam`, `progress`. On a tick-only fallback export, `captureTime` is
converted from 30 Hz ticks to seconds.

## Usage

Point the environment at an exported map with the `mapPath` config (or `mapData`)
so it loads real geometry; otherwise it uses the default WDB map (or falls back to
a box if that file is absent). `bonk-rl-env` consumes maps whose body/surface/
fixture/shape layout matches this schema. Validate a file parses before use:

```
python -c "import json; json.load(open('maps/your_map.json'))"
```

## Rendering

The renderer is rebuilt from the base in milestones, mirroring the native
bonk.io client pipeline (`src/render/`):

- **`render-math.ts` (M1)** — pure world↔screen transforms: map px ÷ `SCALE(=30)`
  → world m; screen = map px × `ppm×scaleRatio÷SCALE`, Y-down, origin-centered,
  on the native 730×500 (1.46 aspect) logical canvas.
- **`map-geometry.ts` (M2)** — turns a map (exported `physicsBodies/…` **or** the
  engine's normalized `MapDef bodies[]`) into a backend-agnostic draw list in
  screen px, back-to-front via `bodyRenderOrder` (`bro`), box/circle/polygon
  fills with cap-zone outlines.
- **`sim-layer.ts` (M3)** — the live layer: discs (from post-tick `PlayerState`),
  heavy rings, rotation notches, and the 850-unit death circle about the map
  center. Pure read/transform — no simulation.
- **`snapshot-ring.ts` / `render-sampler.ts` (M4)** — a SharedArrayBuffer ring of
  sampled snapshots (adds opponent `angle`, which the observation drops) written
  at a sub-cadence and read by a detached `renderSlot` that never touches `tick()`.
  This keeps the renderer at ~0 cost on the sim hot path for parallel matches.
- **`svg-rasterizer.ts` / `render-wiring.ts` / `preview.ts` (M5)** — an SVG
  rasterizer for the draw lists, a wiring adapter that reads a live env into a
  frame, and a preview CLI (`tsx src/render/preview.ts --map … --ticks N`).

The old `map-renderer.ts` (static SVG authoring tool, disconnected from the sim)
was removed. Any map here renders faithfully in native coordinates. Full
architecture, usage, and the zero-overhead design are documented in
`docs/RENDERER.md` (with per-module API docs under `docs/typescript/src/render/`).