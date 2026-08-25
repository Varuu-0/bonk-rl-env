/**
 * generate-constants-manifest.ts — regenerates manifests/backend-constants.json
 *
 * Copies the exported constants from src/core/environment.ts (the single
 * source of truth) into a committed JSON manifest that the Python client's
 * parity test reads value-only, so TS/Python constants cannot drift silently.
 *
 * Run via `npm run gen:constants` whenever a pinned constant changes, and
 * commit the regenerated manifest alongside the constant change. Drift is
 * caught on both sides:
 *   - tests/unit/constants-manifest.test.ts fails when the manifest lags the
 *     TS constant;
 *   - python/tests/test_bonk_vec_env_unit.py's
 *     test_max_frame_skip_matches_backend_ts_constant fails when the Python
 *     constant lags the manifest.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { MAX_FRAME_SKIP } from '../src/core/environment';

const manifest = {
  source: 'src/core/environment.ts',
  generator: 'npm run gen:constants',
  MAX_FRAME_SKIP,
};

const outPath = resolve(__dirname, '..', 'manifests', 'backend-constants.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
