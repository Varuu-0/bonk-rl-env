# `map-geometry.ts` (M2)

Turns a map into a backend-agnostic draw list already in **screen px**. Each item
is a primitive command (`rect`, `circle`, `poly`) a rasterizer can consume
directly. Bodies are drawn back-to-front via `bodyRenderOrder` (`bro`),
mirroring the native client.

## Types

- `MapGeometryInput` — `bodies[]`, `fixtures[]`, `shapes[]`, `capZones[]`,
  `bodyRenderOrder[]`.
- `DrawCommand` — `{ z, primitive, isCapZone, isSensor }` where `primitive` is a
  `rect`/`circle`/`poly` (all in screen px).

## Key functions

| Function | Purpose |
|:---------|:--------|
| `buildGeometry(input, cam)` | Produce the ordered `DrawCommand[]` draw list. |
| `geometryFromExport(map, capZones?)` | Adapt the exporter format (`physicsBodies`/`physicsFixtures`/`physicsShapes`). |
| `geometryFromMapDefBody(map, capZones?)` | Adapt the engine's normalized `MapDef bodies[]` (rect/circle/polygon with `x`/`y` already map px). |

## Geometry conventions

- Box (`bx`) → a polygon of its four world corners under body+shape transform.
- Circle (`ci`) → screen circle with radius `r · cam.scale`.
- Polygon (`po`) → vertices scaled by shape `scale`, rotated by shape angle,
  translated by shape center, then by body angle/position.
- Cap zones render as outlines (`isCapZone`), `noPhysics` fixtures as faded
  sensors (`isSensor`), lethal (`death`) fixtures with a red stroke.