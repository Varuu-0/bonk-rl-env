# `snapshot-ring.ts` (M4)

A per-env, `SharedArrayBuffer`-backed ring of render snapshots. The simulation
host calls `write()` at a **sampled sub-cadence** (e.g. 10–30 Hz), NOT inside
`tick()` and not per Box2D step — so the sim hot path is never slowed. A
separate render thread/consumer reads the latest slot (`readSnapshot`) at its own
cadence and rasterizes.

## Layout

Each snapshot is a fixed-layout `Float32Array`:

```
[0]           tick
[1..]         disc fields for players 0..N-1: x, y, angle, isHeavy, alive
```

`DISC_FIELDS = 5`, `HEADER_FIELDS = 1`. This adds the one field the observation
drops for opponents — `angle` — so the renderer draws spinning discs.

## Key functions

| Function | Purpose |
|:---------|:--------|
| `allocRing(slots, maxPlayers)` | Build a `SharedArrayBuffer` of the exact size. |
| `writeSnapshot(buf, maxPlayers, slot, reader)` | Write current state via a `RenderStateReader` into a slot. |
| `readSnapshot(buf, maxPlayers, slot)` | Read a slot back as a structured snapshot. |
| `toSimSnapshot(raw, deathCenter?)` | Convert into a `SimSnapshot` for the M3 layer. |

## Interface

`RenderStateReader` — `{ getTick(), getDisc(id) }`, letting callers feed it from
`PhysicsEngine`, the SAB observation, or a live env.