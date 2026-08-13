/**
 * M5 — render-preview shared CLI helpers.
 *
 * Resolving the preview map and parsing numeric CLI args is shared by the
 * frame-dump CLI (`preview.ts`) and the live browser server
 * (`preview-server.ts`) so the two dev tools cannot drift apart.
 */
import * as fs from 'fs';

export const PREVIEW_DEFAULT_MAPS = [
  // The WDB map exported during the P4 live-capture work (gitignored scratch
  // on some clones); the second entry is the tracked repo fixture.
  'maps/bonk_WDB__No_Mapshake__716916.json',
  'maps/bonk_WDB__no_nothing__1232248.json',
];

/** Resolve `--map` or the first existing default; errors rather than silently
 *  falling back to the Default_Box placeholder map. */
export function resolvePreviewMap(explicit: string | undefined): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`Map not found: ${explicit}. Pass --map <path> to an existing maps/*.json file.`);
    }
    return explicit;
  }
  const resolved = PREVIEW_DEFAULT_MAPS.find((m) => fs.existsSync(m));
  if (!resolved) {
    throw new Error('No default map found. Pass --map <path> to a bundled maps/*.json file.');
  }
  return resolved;
}

/** Parse a non-negative integer CLI option; throws with a clear message on NaN. */
export function parseIntArg(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --${name}: expected a non-negative number, got "${value}"`);
  }
  return Math.floor(n);
}

/** Pairwise `--key value` → record; unknown keys are passed through. */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1] ?? '';
  }
  return out;
}