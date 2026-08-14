import * as fs from 'fs';
import * as path from 'path';
import { BonkEnvironment } from './src/core/environment';
import { normalizeMap } from './src/core/map-adapter';

const wdb = path.join(process.cwd(), 'maps', 'bonk_WDB__no_nothing__1232248.json');
const raw = JSON.parse(fs.readFileSync(wdb, 'utf8'));

const mapDef: any = normalizeMap(raw);
const env = new BonkEnvironment({
  numOpponents: 1,
  seed: 7,
  mapData: mapDef,
  randomOpponent: false,
  maxTicks: 68,
} as any);

const physics: any = (env as any).physics;
const players: Array<{ id: number; team: number }> = [];
for (let i = 0; i <= 1; i++) players.push({ id: i, team: i === 0 ? 1 : 2 });
env.reset(7);

const spawns: Array<{ id: number; x: number; y: number }> = [];
for (let i = 0; i <= 1; i++) {
  const body = physics.playerBodies?.get(i);
  const pos = body?.GetPosition();
  spawns.push({ id: i, x: (pos?.x ?? 0) * physics.scale, y: (pos?.y ?? 0) * physics.scale });
}

let firstDead = -1;
let deadTicks = 0;
for (let t = 0; t < 60; t++) {
  physics.applyInput(0, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
  physics.applyInput(1, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
  physics.tick();
  let anyDead = false;
  for (let i = 0; i <= 1; i++) {
    const body = physics.playerBodies?.get(i);
    if (!body || !physics.playerAlive.get(i)) { anyDead = true; if (firstDead < 0) firstDead = t; }
  }
  if (anyDead) deadTicks++;
}
console.log('spawns=', JSON.stringify(spawns));
console.log('firstDeadTick=', firstDead);
console.log('deadTicks=', deadTicks);
console.log('deathCenter=', JSON.stringify((env as any).mapDeathCenter));
console.log('spawnPoints=', JSON.stringify(physics.spawnPoints));
env.close();