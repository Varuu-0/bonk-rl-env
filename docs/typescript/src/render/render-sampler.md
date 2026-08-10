# `render-sampler.ts` (M4)

A renderer-side consumer that samples the latest snapshot slot from a ring at its
own cadence and passes it to a `render` callback. It **never** runs inside the
simulation `tick()`/step loop and never blocks a worker — it only *reads*
already-written snapshot slots. This is how thousands of parallel matches can
each render without slowing the sim.

## Types

- `DetachedRenderTarget` — `{ begin(), geometry(cmds), sim(cmds), end() }`.
- `RenderFrameInput` — `{ geometry, ring, maxPlayers, cam, deathCenter? }`.

## Key function / class

- `DetachedRenderSampler.renderSlot(slotIndex, slotCount)` — reads the slot, and
  if its tick advanced past the last rendered tick, builds the M2 geometry +
  M3 sim draw lists and pushes them through the target. Returns the `SimSnapshot`
  rendered, or `null` when the tick is unchanged (nothing new this cadence).
- `cadenceSlot(tick, everyTicks)` — pick the slot for a fixed sub-cadence
  (render 1 in every `everyTicks` ticks).