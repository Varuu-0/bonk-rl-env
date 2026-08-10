/**
 * M5 — render-preview CLI.
 *
 * Runs a real BonkEnvironment for a few ticks and writes the milestone-stack
 * SVG frames to a directory, demonstrating the M1–M4 pipeline end-to-end with
 * NO change to the simulation step path. Draw lists come from the detached
 * geometry + live-state layers; the sim only steps normally.
 *
 * Usage:
 *   npx tsx src/render/preview.ts [--map path] [--ticks N] [--out dir] [--width W] [--height H]
 */
import * as fs from 'fs';
import * as path from 'path';
import { BonkEnvironment } from '../core/environment';
import { renderEnvFrameSvg } from './render-wiring';

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '');
    out[k] = a[i + 1] ?? '';
  }
  return out;
}

/** Parse a non-negative integer CLI option; throws with a clear message on NaN. */
function parseIntArg(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --${name}: expected a non-negative number, got "${value}"`);
  }
  return Math.floor(n);
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Prefer a map that exists; error out rather than silently falling back to
  // the Default_Box placeholder map. An explicit --map that doesn't exist is a
  // hard error (surfaces typos) rather than a silent fallback (#review).
  const defaults = [
    'maps/bonk_WDB__No_Mapshake__716916.json',
    'maps/bonk_WDB__no_nothing__1232248.json',
  ];
  let map: string;
  if (args.map) {
    if (!fs.existsSync(args.map)) {
      throw new Error(`Map not found: ${args.map}. Pass --map <path> to an existing maps/*.json file.`);
    }
    map = args.map;
  } else {
    const resolved = defaults.find((m) => fs.existsSync(m));
    if (!resolved) {
      throw new Error('No default map found. Pass --map <path> to a bundled maps/*.json file.');
    }
    map = resolved;
  }
  const ticks = parseIntArg(args.ticks, 20, 'ticks');
  const outDir = args.out || 'render-preview';
  const width = parseIntArg(args.width, 730, 'width');
  const height = parseIntArg(args.height, 500, 'height');

  fs.mkdirSync(outDir, { recursive: true });

  const env = new BonkEnvironment({ mapPath: map, numOpponents: 1, randomOpponent: false, seed: 42 });
  try {
    for (let t = 0; t < ticks; t++) {
      const frames = [
        renderEnvFrameSvg(env, { width, height, title: 'bonk-rl-env frame' }),
      ];
      const fname = path.join(outDir, `frame_${String(t).padStart(4, '0')}.svg`);
      fs.writeFileSync(fname, frames[0]);
      // Step the sim normally (the only place the hot path runs).
      env.step(0);
    }
    console.log(`Wrote ${ticks} SVG frames to ${outDir}/frame_*.svg (map=${map})`);
  } finally {
    env.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });