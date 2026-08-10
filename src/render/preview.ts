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

async function main(): Promise<void> {
  const args = parseArgs();
  const map = args.map || 'maps/bonk_WDB__No_Mapshake__716916.json';
  const ticks = parseInt(args.ticks || '20', 10);
  const outDir = args.out || 'render-preview';
  const width = parseInt(args.width || '730', 10);
  const height = parseInt(args.height || '500', 10);

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