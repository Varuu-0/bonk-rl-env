/**
 * M5 — render-preview CLI (frame dump).
 *
 * Runs a real BonkEnvironment for a few ticks and writes the milestone-stack
 * SVG frames to a directory, demonstrating the M1–M4 pipeline end-to-end with
 * NO change to the simulation step path. Draw lists come from the detached
 * geometry + live-state layers; the sim only steps normally.
 *
 * Usage:
 *   npx tsx src/render/preview.ts [--map path] [--ticks N] [--out dir] [--width W] [--height H]
 *
 * For a LIVE browser preview of the same pipeline, use preview-server.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BonkEnvironment } from '../core/environment';
import { createPreviewFrameStepper } from './preview-loop';
import { renderEnvFrameSvg } from './render-wiring';
import { parseArgs, parseIntArg, resolvePreviewMap } from './preview-shared';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = resolvePreviewMap(args.map);
  const ticks = parseIntArg(args.ticks, 20, 'ticks');
  const outDir = args.out || 'render-preview';
  const width = parseIntArg(args.width, 730, 'width');
  const height = parseIntArg(args.height, 500, 'height');

  fs.mkdirSync(outDir, { recursive: true });

  const env = new BonkEnvironment({ mapPath: map, numOpponents: 1, randomOpponent: false, seed: 42 });
  try {
    const stepPreview = createPreviewFrameStepper(env, () =>
      renderEnvFrameSvg(env, { width, height, title: 'bonk-rl-env frame' }),
    );
    for (let t = 0; t < ticks;) {
      const step = stepPreview();
      if (step.frame === null) continue;
      const fname = path.join(outDir, `frame_${String(t).padStart(4, '0')}.svg`);
      fs.writeFileSync(fname, step.frame);
      t += 1;
    }
    console.log(`Wrote ${ticks} SVG frames to ${outDir}/frame_*.svg (map=${map})`);
  } finally {
    env.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
