/**
 * constants-manifest.test.ts — drift guard between
 * manifests/backend-constants.json and the exported backend constants
 * (src/core/environment.ts).
 *
 * The Python parity test reads the committed manifest value-only, so this
 * suite is the side that keeps the manifest honest: if a pinned constant
 * changes in src without re-running `npm run gen:constants`, this test fails
 * until the regenerated manifest is committed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { MAX_FRAME_SKIP } from '../../src/core/environment';

describe('backend constants manifest', () => {
  it('pins MAX_FRAME_SKIP to the exported backend constant', () => {
    const manifestPath = path.resolve(__dirname, '..', '..', 'manifests', 'backend-constants.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: string;
      generator: string;
      MAX_FRAME_SKIP: number;
    };
    expect(manifest.source).toBe('src/core/environment.ts');
    expect(manifest.generator).toBe('npm run gen:constants');
    expect(manifest.MAX_FRAME_SKIP).toBe(MAX_FRAME_SKIP);
  });
});
