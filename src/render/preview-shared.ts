/**
 * M5 — render-preview shared CLI helpers.
 *
 * Resolving the preview map and parsing numeric CLI args is shared by the
 * frame-dump CLI (`preview.ts`) and the live browser server
 * (`preview-server.ts`) so the two dev tools cannot drift apart.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export const PREVIEW_MAPS_DIR = 'maps';

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

/** Parse a positive integer CLI option such as the live preview frame rate. */
export function parsePositiveIntArg(value: string | undefined, fallback: number, name: string): number {
  const n = parseIntArg(value, fallback, name);
  if (n < 1) {
    throw new Error(`Invalid --${name}: expected a positive number, got "${value}"`);
  }
  return n;
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

/** Sorted *.json basenames inside the maps directory ([] when absent). */
export function listPreviewMaps(dir: string = PREVIEW_MAPS_DIR): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
}

/** Validate a menu answer against the entry count; returns the 0-based index
 *  or -1 for out-of-range/non-numeric input. Empty input selects the first. */
export function parseMapSelection(answer: string, count: number): number {
  const trimmed = answer.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > count) return -1;
  return n - 1;
}

/** Interactive numbered menu over the given map filenames. */
export function promptMapSelection(maps: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Map selection prompt requires an interactive terminal. Pass --map <path> instead.'));
      return;
    }
    console.log('Available maps:');
    maps.forEach((name, i) => console.log(`  [${i + 1}] ${name}`));
    let settled = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const finish = (done: () => void): void => {
      if (!settled) { settled = true; done(); }
    };
    rl.on('SIGINT', () => { rl.close(); process.exit(130); });
    rl.on('close', () => finish(() => reject(new Error('Map selection cancelled.'))));
    rl.question(`Select a map [1-${maps.length}] (default 1): `, (answer) => {
      finish(() => {
        const index = parseMapSelection(answer, maps.length);
        if (index < 0) {
          reject(new Error(`Invalid selection "${answer}". Pick a number between 1 and ${maps.length}.`));
          return;
        }
        resolve(maps[index]);
      });
      rl.close();
    });
  });
}

/** Resolve the preview map for the live server: an explicit --map wins; with
 *  no argument, list maps/*.json and prompt on an interactive terminal,
 *  otherwise fall back to the first existing default (CI / piped stdin). */
export async function selectPreviewMap(
  explicit: string | undefined,
  dir: string = PREVIEW_MAPS_DIR,
  interactive: boolean = process.stdin.isTTY === true,
): Promise<string> {
  if (explicit) return resolvePreviewMap(explicit);
  const maps = listPreviewMaps(dir);
  if (maps.length > 0 && interactive) {
    console.log('No --map passed. Choose a map file to preview.');
    const chosen = await promptMapSelection(maps);
    return path.join(dir, chosen);
  }
  return resolvePreviewMap(undefined);
}
