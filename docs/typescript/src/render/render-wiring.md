# `render-wiring.ts` (M5)

Integration wiring: adapts a live `BonkEnvironment`'s already-materialized
`PlayerState` into render snapshots and produces SVG frames. It is deliberately
**read-only** against the env (pulls `getPlayerState`, never drives `tick()`), so
it can be driven by a separate render thread at a sampled sub-cadence without
slowing the sim.

## Key functions

| Function | Purpose |
|:---------|:--------|
| `createEnvReader(env)` | Build a `RenderStateReader` over the env (AI + opponents, including `angle`). |
| `envMapRender(env)` | Build geometry input + death center from the env's loaded map. |
| `envSimSnapshot(env)` | Build a `SimSnapshot` from the env's live state. |
| `renderEnvFrameSvg(env, opts)` | Produce a single SVG frame for the current env state (auto-fit camera). |

## Usage

See `preview.ts` — the CLI that runs a real env for N ticks and writes SVG frames.
This demonstrates the full M1–M4 stack end-to-end with **no change** to the
simulation step path; the sim only steps normally while the renderer samples.