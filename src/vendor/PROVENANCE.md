# Vendored modified Box2D provenance

`box2d.ts` packages the modified Box2D solver used by the pinned Bonk Classic
physics target. It is **not** the unrelated npm `box2d` backend used by the
legacy RL engine.

- Source: `https://bonk.io/js/physics/box2dweb/Box2DModuleGJMod.js`
- Source SHA-256: `0f7645c88f53b51b731819c2f8ee3d9af5040c3c741371f8b1ff82c2074f3a83`
- Packaged file SHA-256 at import: `92f7ec7cc67e70cc0906b55d2f38a26d2a17fd30bbe692f1daa5d349525a102f`
- Packaging change: AMD registration was replaced with an isolated per-instance
  factory and injected SafeTrig. The solver implementation is unchanged.
- The original zlib-style license and Erin Catto copyright notice are retained
  at the top of `box2d.ts`.

SafeTrig is independently implemented in `src/core/safe-trig.ts` from the
observed numeric contract of the pinned public dependency. The original native
SafeTrig artifact is used only by opt-in differential validation; it is not
bundled into production.

The scoped project-authored Classic implementation and focused tests were ported
from the read-only `E:\Projects\bonk-game` research workspace on 2026-10-26.
That workspace is not a runtime or package dependency. Production imports only
RL-local files.
