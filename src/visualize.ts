/**
 * visualize.ts — Standalone entry point for visualizing the bonk-rl-env game in a browser.
 *
 * This file has ZERO relationship with src/main.ts (the training entry point).
 * When training runs via `npx tsx src/main.ts`, this file is never loaded.
 *
 * Usage:
 *   npx tsx src/visualize.ts [options]
 *
 * Options:
 *   --port <number>       HTTP server port (default 3000)
 *   --map <path>          Path to map JSON file (default maps/bonk_Simple_1v1_123.json)
 *   --seed <number>       Random seed (default 42)
 *   --opponents <number>  Number of opponents (default 1)
 *   --speed <number>      Playback speed multiplier (default 1 = real-time at 30 TPS)
 */

import * as fs from 'fs';
import * as path from 'path';

import { BonkEnvironment } from './core/environment';
import { MapDef, TPS } from './core/physics-engine';
import { VisualServer } from './visualization/canvas-renderer';

// ─── CLI Argument Parsing ─────────────────────────────────────────────

interface CliConfig {
  port: number;
  mapPath: string;
  seed: number;
  opponents: number;
  speed: number;
}

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const config: CliConfig = {
    port: 3000,
    mapPath: path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json'),
    seed: 42,
    opponents: 1,
    speed: 1,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        config.port = parseInt(args[++i], 10);
        if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
          throw new Error(`Invalid port: ${args[i]}`);
        }
        break;
      case '--map':
        config.mapPath = path.resolve(args[++i]);
        break;
      case '--seed':
        config.seed = parseInt(args[++i], 10);
        if (isNaN(config.seed)) {
          throw new Error(`Invalid seed: ${args[i]}`);
        }
        break;
      case '--opponents':
        config.opponents = parseInt(args[++i], 10);
        if (isNaN(config.opponents) || config.opponents < 0) {
          throw new Error(`Invalid opponents count: ${args[i]}`);
        }
        break;
      case '--speed':
        config.speed = parseFloat(args[++i]);
        if (isNaN(config.speed) || config.speed <= 0) {
          throw new Error(`Invalid speed: ${args[i]}`);
        }
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return config;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  // Load map definition from file
  let mapDef: MapDef;
  try {
    const raw = fs.readFileSync(config.mapPath, 'utf8');
    mapDef = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Failed to load map from ${config.mapPath}: ${err.message}`);
    process.exit(1);
  }

  // Create environment with the loaded map
  const env = new BonkEnvironment({
    mapData: mapDef,
    seed: config.seed,
    numOpponents: config.opponents,
  });

  // Create and start the visual server
  const visualServer = new VisualServer(config.port);
  await visualServer.start(mapDef);

  // Print startup banner
  const mapName = mapDef.name || path.basename(config.mapPath);
  console.log('');
  console.log('=== Bonk.io Visualizer ===');
  console.log(`  Port:      http://localhost:${config.port}`);
  console.log(`  Map:       ${mapName}`);
  console.log(`  Seed:      ${config.seed}`);
  console.log(`  Opponents: ${config.opponents}`);
  console.log(`  Speed:     ${config.speed}x`);
  console.log('  Press Ctrl+C to stop');
  console.log('');

  // ─── Game Loop ──────────────────────────────────────────────────────

  const tickInterval = (1000 / TPS) * config.speed;
  let currentTick = 0;

  const interval = setInterval(() => {
    const action = visualServer.getAction();

    const result = env.step(action);
    currentTick = result.observation.tick;

    // Broadcast state to all connected browser clients
    visualServer.broadcast(result.observation, currentTick);

    // Reset environment when episode ends
    if (result.done) {
      env.reset();
    }
  }, tickInterval);

  // ─── Graceful Shutdown ──────────────────────────────────────────────

  async function shutdown(): Promise<void> {
    console.log('\nShutting down...');
    clearInterval(interval);
    env.close();
    await visualServer.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
