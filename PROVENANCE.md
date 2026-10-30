# Provenance Chain — Native Reference Artifacts

This repository's headless engine is verified against a pinned build of the
original Bonk.io client. No original client code ships in production: the
pinned source is executed only by research-only oracle harnesses under
`validation/native/` (dev-only, hash-pinned spans), and the local engine is a
clean-room re-implementation whose behavior is checked against those oracles.

## Reference artifact chain

| Artifact              | Local path                                                           | Role                                                                                         | SHA-256                                                            |
| :-------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| `alpha2s.raw.js`      | `.deobf/alpha2s.raw.js` (gitignored)                                 | Pinned original Bonk.io client build (single minified file) used by all differential oracles | `e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e` |
| `Box2DModuleGJMod.js` | `.local-artifacts/native-reference/Box2DModuleGJMod.js` (gitignored) | Original modified Box2D physics backend (GJ-modified build the client ships)                 | `0f7645c88f53b51b731819c2f8ee3d9af5040c3c741371f8b1ff82c2074f3a83` |
| `SafeTrig.js`         | `.local-artifacts/native-reference/SafeTrig.js` (gitignored)         | Original safe-trigonometry shim used by the client's physics                                 | `d1d09e414ba4c16bfb9ce8492f135bbc87b581c364a3b91019c4f93a18557b08` |

Because `.deobf/` and `.local-artifacts/` are gitignored (original client code
must not enter the repository), this file records their hashes so the
provenance chain remains verifiable: every differential receipt under
`validation/native/` embeds these hashes, and
`tests/unit/native-receipt-freshness.test.ts` fails when a receipt's recorded
local-source hashes no longer match the working tree.

## How the artifacts were obtained

- `alpha2s.raw.js` was saved from the pinned Bonk.io production client bundle
  (the game's compiled `alpha2s` module) as served by the original game, then
  lightly deobfuscated for research (`.deobf/alpha2s.slot-accurate.numeric.js`
  annotates slots; the raw file is the untouched extraction).
- `Box2DModuleGJMod.js` and `SafeTrig.js` are the physics backend modules
  extracted from the same pinned client build.
- The vendored production physics (`src/vendor/box2d.ts`,
  SHA-256 `92f7ec7c…`) is a TypeScript port of the same backend used by the
  local engine; it carries no original client code beyond the physics library
  semantics.

## Verification usage

Oracles execute only reviewed, hash-pinned function spans of the raw client
(see `validation/native/raw-physics-oracle.cjs` and
`validation/native/raw-football-oracle.cjs`, each recording per-function
start/end/hash in every receipt). Comparators inject controlled inputs into
both the oracle and the local engine and compare full state each tick with
tolerance 1e-9. Canonical receipts live in `validation/native/` and are
pinned by the freshness gate.

## Repository independence

- `package.json` has no dependency on `bonk-game` or any original client code.
- `src/` contains no import escaping the repository root.
- The reference project `E:\Projects\bonk-game` is read-only research material;
  nothing from it is imported at runtime.
