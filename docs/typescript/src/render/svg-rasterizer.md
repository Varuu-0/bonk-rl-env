# `svg-rasterizer.ts` (M5)

One concrete `DetachedRenderTarget` that renders the M2 geometry commands and M3
sim commands to an SVG string. Because the draw lists are backend-agnostic, the
same `buildGeometry`/`buildSim` output can feed Canvas 2D or a PNG backend
without changing the geometry/sim layers.

## Key function / class

- `SvgRasterizer(begin | geometry | sim | end)` — accumulates commands into an
  SVG string; `begin()` emits the background gradient + title, `geometry()` and
  `sim()` emit sorted-by-z primitives, and `end()` closes the document.
- `renderFrameSvg(geometryCmds, simCmds, opts)` — one-shot render of a full frame
  (map + one sim snapshot) to SVG.

## Rendering details

- Discs: filled circle + white rotation notch (shows disc spin) + gold heavy ring.
- Death circle: dashed red outline of 850 map px radius.
- Grapple: `#cccccc` line.
- Geometry: fills from fixture color; cap zones outlined; sensors faded; lethal
  fixtures stroked red.