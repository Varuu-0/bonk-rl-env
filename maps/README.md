# maps

Bonk.io map exports in JSON format, produced by the **Bonk Map Exporter** userscript
(`../Webscripts/mapexporter.js`, v3+). Each file is a **NativeMap JSON** document
(`{ v, s, physics: { shapes, fixtures, bodies, bro, joints, ppm }, spawns, capZones, m }`)
capturing the full body → fixture → shape hierarchy, collision configuration, spawns,
and cap zones for a single arena in the native serialized field format.

## Capturing a map

The exporter is installed as a userscript on `https://bonk.io/gameframe-release.html`
(or `https://bonk.io/*`):

1. **Install `../Webscripts/mapexporter.js`** in your userscript manager (Tampermonkey/Violentmonkey).
2. Optional: also install `../Webscripts/codeinjector.js` (the shared "Code Injector"
   host) or `../Webscripts/bonk-live-tool.user.js`. The exporter is self-contained: it
   installs its own `alpha2s.js` fetch/patch hook (run-at `document-start`), so it works
   alone. It is idempotent (shared `__bonkRLAppend` / `__bonkRLInt` flags) so coexisting
   hosts never double-patch.
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

| File                                 | Description                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `bonk_Simple_1v1_123.json`           | Minimal 1v1 arena — a single flat platform                                              |
| `bonk_Gang_Grounds_2_0_37368.json`   | Popular community 1v1 map (Gang Grounds 2.0) with box/circle geometry                   |
| `bonk_WDB__No_Mapshake__716916.json` | WDB (World Domination Battle) map — capture zones, joints, polygons; the engine default |
| `bonk_WDB__no_nothing__1232248.json` | WDB variant with more bodies/joints                                                     |
| `bonk_WeiRd_DeAth_BalL__80622.json`  | Open "death ball" arena with dynamic platforms and cap zones                            |

## Loading in the engine

v3+ exports are native-format JSON: they load through the engine's native map path
(`src/core/native-map-codec.ts` → `validateNativeMapJson` → the native map session),
the same path used for the 288-map native corpus. Verify an export before use:

```
npx tsx scripts/extract-bonk-map.ts --in bonk_<MapName>_<dbid>.json --verify
```

Any of the files above load via `mapPath` / `defaultMapPath` / `mapData`. The default
map is `bonk_WDB__No_Mapshake__716916.json`.

## Map Format

v3+ exports are strict **NativeMap JSON** — the same field names and defaults the
native client serializes (see `docs/MAPFORMAT.md` and the corpus in `.local-artifacts/`).
Top-level keys: `v` (format version), `s` (settings), `physics`, `spawns`, `capZones`,
and `m` (map metadata). No debug extras are included.

### Metadata (`m`)

- `n`, `a`, `dbid`, `dbv`, `authid`, `date`, `mo` (mode), `pub`
- `rxid`, `rxn`, `rxa`, `rxdb` — remix identifiers
- `v` — map format version (also top-level `v`)
- `cr` — contributors

### Settings (`s`)

Map-level physics toggles: `re` (respawn), `nc` (no-collision), `pq` (quality),
`gd` (gravity), `fl` (show flags).

### Physics (global)

`ppm` (pixels per metre), plus the `shapes`, `fixtures`, `bodies`, `bro` (body
render order), and `joints` arrays. Gravity and bounds live in the game state, not the
serialized map, and are set by the engine at load time.

### Bodies (per `physics.bodies[]`)

`p` (position), `a` (angle), `lv`/`av` (velocities), `cf` (collision flags), `fx`
(fixture list), `fz` (force-zone data), `s` (surface: `n`, `type`, `fric`, `fricp`, `re`,
`de`, `ld`, `ad`, `fr`, `bu`, `f_c`, `f_p`, `f_1..f_4`).

### Shapes (`physics.shapes[]`)

`type` is one of:

| `type` | Shape                                           |
| ------ | ----------------------------------------------- |
| `bx`   | Box (`w`/`h`, center `c`, angle `a`, `sk` skin) |
| `ci`   | Circle (`r`, center `c`, `sk`)                  |
| `po`   | Polygon (vertex array `v`, `sk`)                |

### Joints (`physics.joints[]`)

`type` (`rv` revolute, `d` distance, `p` prismatic, `g` pin/weld-like), `ba`/`bb`
(body indices, `-1` = ground), `d` (type-specific data), `l` (length), plus anchors
(`pax`/`pay`, `sax`/`say`) and motor/limit fields (`pa`, `pf`, `pl`, `pu`, `plen`, `pms`).

### Spawns

Array of spawn points from the decoded map definition (`gs.map.spawns`), each with
`x`, `y`, `xv`/`yv` (initial velocity), `priority`, `r`/`f`/`b`/`gr`/`ye` (per-team
flags), and `n` (name).

### Cap Zones (`capZones[]`)

Each zone has `n` (name), `ty` (type), `l` (capture time, native 30 Hz ticks), `i`
(fixture index), plus runtime-only `o`/`p`/`ot`/`f` when captured mid-match. Native
`l` is kept as-is — no seconds conversion.

## Usage

Point the environment at an exported map with the `mapPath` config (or `mapData`)
so it loads real geometry; otherwise it uses the default WDB map (or falls back to
a box if that file is absent). Validate an export (schema + engine load) before use:

```
npx tsx scripts/extract-bonk-map.ts --in maps/your_map.json --verify
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
