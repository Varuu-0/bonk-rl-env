# Renderer

The simulation renderer for Bonk RL is a milestone-based rebuild from the base
(no legacy static map-SVG tool). It mirrors the native bonk.io client rendering
pipeline and is designed to run **thousands of parallel matches** with **~0
overhead on the simulation hot path**.

> Quick reference: the auto-generated module docs live under
> [`typescript/src/render/`](typescript/src/render/README.md), with one page per
> module. This page is the architecture + usage overview.

## Design rule (zero-overhead on the sim)

The sim is a worker-thread farm; each worker is saturated in an `Atomics.wait`
step loop, so **no synchronous render work may run there**. The renderer reads
only state that Box2D has already materialized after each `tick()` — it never
recomputes and never drives the sim:

1. The sim writes a compact snapshot ring slot at a **sampled sub-cadence**
   (e.g. 10–30 Hz), not per step and never inside `tick()`.
2. A separate render consumer (`render-sampler.ts`) **reads** the latest slot at
   its own cadence and rasterizes — it does no simulation.

The observation (`getObservationFast` → SAB) is already exported per step at zero
recompute. The render snapshot reuses that and adds the one field the observation
drops: opponent `angle`/`angularVel`, for disc rotation.

## Coordinate model

Native client spaces (see `docs/DEOBFUSCATION.md` §33.5, §34.5):

| Space         | Meaning                                                                                           | Units  |
| :------------ | :------------------------------------------------------------------------------------------------ | :----- |
| Map px (M)    | Authored/exported map units; what `PhysicsEngine` surfaces (`getPlayerState().x/y`, arena bounds) | px     |
| World m (W)   | What Box2D uses internally — `map px ÷ SCALE(=30)`                                                | metres |
| Screen px (S) | Fitted canvas, Y-down, origin at canvas center                                                    | px     |

A length of `L` map px renders at `L × ppm × scaleRatio ÷ SCALE` screen px, on
the native 730×500 (1.46 aspect) logical canvas.

## Milestone modules (`src/render/`)

| Module                                                 | Milestone | Responsibility                                                                    |
| :----------------------------------------------------- | :-------- | :-------------------------------------------------------------------------------- |
| [`render-math.ts`](../src/render/render-math.ts)       | M1        | Pure world↔screen transforms, camera fit, rotation                                |
| [`map-geometry.ts`](../src/render/map-geometry.ts)     | M2        | Map → backend-agnostic draw list (screen px), back-to-front via `bodyRenderOrder` |
| [`sim-layer.ts`](../src/render/sim-layer.ts)           | M3        | Live disc/death-circle layer from post-tick `PlayerState` (pure read)             |
| [`snapshot-ring.ts`](../src/render/snapshot-ring.ts)   | M4        | SharedArrayBuffer ring of sampled snapshots (adds opponent `angle`)               |
| [`render-sampler.ts`](../src/render/render-sampler.ts) | M4        | Detached consumer: render the latest slot without touching `tick()`               |
| [`svg-rasterizer.ts`](../src/render/svg-rasterizer.ts) | M5        | `DrawCommand`/`SimCommand` → SVG string                                           |
| [`render-wiring.ts`](../src/render/render-wiring.ts)   | M5        | Adapter: live `BonkEnvironment` → render frame                                    |
| [`preview.ts`](../src/render/preview.ts)               | M5        | CLI preview (`tsx src/render/preview.ts --map …`)                                 |

## How to render a frame

```ts
const cam = computeCamera(width, height, ppm); // M1 (camera)
const geometryCmds = buildGeometry(mapGeometry, cam); // M2 (map → draw list)
const simCmds = buildSim(simSnapshot, cam, ppm); // M3 (discs + death circle)
const svg = renderFrameSvg(geometryCmds, simCmds, opts); // M5 (SVG output)
```

The map geometry input accepts either the exporter format
(`physicsBodies/physicsShapes/…`) or the engine's normalized `MapDef bodies[]`
(exposed by `env.config.mapData`). The sim snapshot is a pure read of the live
`PlayerState` — see [`render-wiring.ts`](../src/render/render-wiring.ts).

## Native-map static preview

A native Bonk map JSON can be rendered without constructing or stepping an
environment:

```powershell
npx tsx src/render/preview.ts --map maps/training-platform.json --out render-preview/training-platform
```

The command prints the exact path to `native-map-preview.svg`. It uses
`validateNativeMapJson` followed by `normalizeNativeMap({ authored: true })`, the
same strict native decoding path as the engine. Invalid maps exit nonzero; no
fallback or repaired map is substituted. Exporter-format maps retain the animated
frame-dump behavior described below.

The static preview shows initial boxes, circles, polygons, compound fixtures,
shape/body transforms, native body render order, joint anchors, team-labelled
spawn points and capture zones. Static bodies have solid dark outlines, dynamic
bodies dashed blue outlines, and kinematic bodies dashed purple outlines. Lethal
fixtures have red outlines, nonphysical fixtures are translucent, and capture
zones are yellow. Capture zones with fixture `-1` are represented on the map
frame. A heading reports the filename, native version, PPM and object counts;
a legend explains the styles. The camera fits all geometry and spawns with equal
axis scales and a five-percent margin.

This is an initial-state debugging view, not a native-client artwork recreation.
Shrink animation is not stepped, and active force zones are reported rather than
drawn. The output is a self-contained SVG and requires no workers, Python,
ZeroMQ, browser automation or simulation stepping.

## Preview CLI

```
npx tsx src/render/preview.ts --map maps/bonk_WDB__No_Mapshake__716916.json --ticks 20 --out render-preview
```

Writes `frame_*.svg` per tick and steps the env normally. Change the render
constraint freely here without touching the sim hot path.

## Tests

`tests/integration/render-math.test.ts`, `map-geometry.test.ts`,
`sim-layer.test.ts`, and `snapshot-ring.test.ts` cover M1–M4 against real maps
and native coordinate values.
