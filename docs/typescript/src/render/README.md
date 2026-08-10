# Rendering (`src/render/`)

The renderer is a milestone-based rebuild from the base, mirroring the native
bonk.io client rendering pipeline. Its defining constraint is **~0 overhead on
the simulation hot path**: the sim's per-tick `tick()` work is never touched;
rendering only reads state that is *already materialized* after each step.

## Coordinate model

The renderer uses the exact native coordinate spaces (see `docs/DEOBFUSCATION.md`
§33.5, §34.5):

| Space | Meaning | Units |
|:------|:--------|:------|
| Map px (M) | Authored/exported map units; what `PhysicsEngine` surfaces (`getPlayerState().x/y`, arena bounds) | px |
| World m (W) | What Box2D uses internally — `map px ÷ SCALE(=30)` | metres |
| Screen px (S) | Fitted canvas, Y-down, origin at canvas center | px |

Native render scale is `ppm × scaleRatio` where `scaleRatio` is a renderer-global
fit computed against the 730×500 (1.46 aspect) logical canvas. So a length of
`L` map px renders at `L × ppm × scaleRatio ÷ SCALE` screen px.

## Files

| Module | Milestone | Responsibility |
|:-------|:----------|:---------------|
| [`render-math.ts`](render-math.md) | M1 | Pure `world↔screen` transforms, camera fit, rotation |
| [`map-geometry.ts`](map-geometry.md) | M2 | Map → backend-agnostic draw list (screen px), back-to-front via `bodyRenderOrder` |
| [`sim-layer.ts`](sim-layer.md) | M3 | Live disc/death-circle layer from post-tick `PlayerState` (pure read) |
| [`snapshot-ring.ts`](snapshot-ring.md) | M4 | SharedArrayBuffer ring of sampled snapshots (adds opponent `angle`) |
| [`render-sampler.ts`](render-sampler.md) | M4 | Detached consumer that renders the latest slot without touching `tick()` |
| [`svg-rasterizer.ts`](svg-rasterizer.md) | M5 | `DrawCommand`/`SimCommand` → SVG string |
| [`render-wiring.ts`](render-wiring.md) | M5 | Adapter: live `BonkEnvironment` → render frame |
| [`preview.ts`](preview.ts) | M5 | CLI preview (`tsx src/render/preview.ts --map …`) |

## How to render a frame

```
const cam = computeCamera(width, height, ppm);        // M1
const geometryCmds = buildGeometry(mapGeometry, cam); // M2 (map → draw list)
const simCmds = buildSim(simSnapshot, cam, ppm);      // M3 (discs + death circle)
const svg = renderFrameSvg(geometryCmds, simCmds, opts); // M5
```

## Zero-overhead rule (for thousands of parallel matches)

The sim runs as a worker-thread farm where each worker is saturated in an
`Atomics.wait` step loop. Synchronous render work there would stall the pool.
Instead:

1. The sim writes a compact snapshot ring slot at a **sampled sub-cadence**
   (e.g. 10–30 Hz), not per Box2D step and never inside `tick()`.
2. A separate render consumer (`render-sampler.ts`) **reads** the latest slot at
   its own cadence and rasterizes — it does no simulation.

The only per-tick transport that exists is the observation (`getObservationFast`
→ SAB), which is already produced at zero recompute. The render ring adds just
one genuinely-new field the observation drops: opponent `angle`/`angularVel` for
disc rotation.