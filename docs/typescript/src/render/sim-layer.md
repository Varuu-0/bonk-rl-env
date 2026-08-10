# `sim-layer.ts` (M3)

The live simulation layer: turns a per-tick `SimSnapshot` into backend-agnostic
draw primitives (screen px) drawn **over** the M2 map geometry. It consumes the
exact state the `PhysicsEngine` already materializes after `tick()`
(`PlayerState` fields: x/y, angle, isHeavy, alive) plus the map's death-circle
center. No simulation runs or advances here — it is a pure read/transform.

## Types

- `RenderDisc` — `{ id, x, y, angle, isHeavy, alive, color? }` (map px).
- `SimSnapshot` — `{ tick, discs[], deathCenter? }`.
- `SimPrimitive` — `disc` | `deathCircle` | `grapple`.

## Key function

`buildSim(snapshot, cam, ppm?)` → `SimCommand[]`.

- Draws the death circle first (850-unit radius about the map center, in screen px).
- Draws each **alive** disc as a circle of radius `ppm · cam.scale`, with a
  per-id palette color, a heavy gold ring when `isHeavy`, and a rotation notch.

Dead discs are skipped (their death position may be reused as a cleanup frame
via the engine's `DetachedPlayerSnapshot`).