# `render-math.ts` (M1)

Pure coordinate & camera transforms. No rendering, no state, no physics import
beyond scalar constants — only maps between the three coordinate spaces (map px,
world m, screen px) so every layer shares one ground-truth transform.

## Key functions

| Function | Purpose |
|:---------|:--------|
| `toWorld(x, y)` / `fromWorld(x, y)` | Map px ↔ world m at `SCALE=30`. |
| `computeScaleRatio(w, h)` | Native fit: `w/730` when aspect ≤ 1.46, else `1.46·h/730`. |
| `mapPxToScreen(len, ppm, ratio)` | `len · (ppm·ratio/SCALE)` — the native `pixelScale` model. |
| `computeCamera(w, h, ppm)` | Returns `{scale, offsetX, offsetY}` centering the map origin at canvas center. |
| `mapToScreen(x, y, cam)` / `screenToMap` | Map px → screen px (Y-down, origin-centered) and inverse. |
| `rotate(x, y, angle)` | Standard 2D rotation by radians. |

## Constants

`SCALE=30`, `DEFAULT_PPM=12`, `BASE_WIDTH=730`, `BASE_HEIGHT=500`,
`BASE_ASPECT=1.46`, `OUT_OF_BOUNDS_RADIUS=850` (map px).