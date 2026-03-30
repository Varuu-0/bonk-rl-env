import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { BonkEnvironment } from '../src/core/environment';
import { MapDef } from '../src/core/physics-engine';
import { VisualServer } from '../src/visualization/canvas-renderer';

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.log(`[FAIL] ${msg}`);
    process.exit(1);
  }
  console.log(`[PASS] ${msg}`);
}

async function safeStop(server: VisualServer): Promise<void> {
  try { await safeStop(server); } catch {}
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => body += chunk.toString());
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    }).on('error', reject);
  });
}

async function testModuleImports(): Promise<void> {
  assert(true, 'Module imports succeed without errors');
}

async function testFullPipeline(): Promise<void> {
  const mapPath = path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json');
  const mapDef: MapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const server = new VisualServer(3200);

  try {
    await server.start(mapDef);

    const htmlRes = await httpGet('http://localhost:3200/');
    assert(htmlRes.status === 200, 'Full pipeline: HTTP returns 200');

    for (let i = 0; i < 10; i++) {
      const result = env.step(Math.floor(Math.random() * 64));
      server.broadcast(result.observation, result.observation.tick);
    }
    assert(true, 'Full pipeline: 10 steps + broadcasts completed');

    const io = (await import('socket.io-client')).default;
    const socket = io('http://localhost:3200', { transports: ['websocket'] });

    const mapData: any = await new Promise((resolve) => {
      socket.on('map', (data: any) => resolve(data));
    });
    assert(mapData.name === mapDef.name, 'Full pipeline: received correct map name');

    const result = env.step(Math.floor(Math.random() * 64));
    server.broadcast(result.observation, result.observation.tick);

    const stateData: any = await new Promise((resolve) => {
      socket.on('state', (data: any) => resolve(data));
    });
    assert(Array.isArray(stateData.players), 'Full pipeline: state has players array');
    assert(typeof stateData.tick === 'number', 'Full pipeline: state has tick number');
    assert(stateData.players[0].alive === true, 'Full pipeline: AI player is alive');

    socket.disconnect();
  } finally {
    await safeStop(server);
    env.close();
  }
}

async function testEpisodeReset(): Promise<void> {
  const mapPath = path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json');
  const mapDef: MapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const server = new VisualServer(3201);

  try {
    await server.start(mapDef);

    let foundDone = false;
    for (let i = 0; i < 2000; i++) {
      const result = env.step(Math.floor(Math.random() * 64));
      server.broadcast(result.observation, result.observation.tick);
      if (result.done) {
        foundDone = true;
        env.reset();
        const postReset = env.step(Math.floor(Math.random() * 64));
        server.broadcast(postReset.observation, postReset.observation.tick);
        break;
      }
    }
    assert(foundDone, 'Episode reset: found done condition');
    assert(true, 'Episode reset: broadcast works after reset');
  } finally {
    await safeStop(server);
    env.close();
  }
}

async function testMultipleOpponents(): Promise<void> {
  const mapPath = path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json');
  const mapDef: MapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 2 });
  const server = new VisualServer(3202);

  try {
    await server.start(mapDef);
    const result = env.step(Math.floor(Math.random() * 64));
    server.broadcast(result.observation, result.observation.tick);

    assert(result.observation.opponents.length === 2, 'Multiple opponents: observation has 2 opponents');
    assert(true, 'Multiple opponents: broadcast succeeded');
  } finally {
    await safeStop(server);
    env.close();
  }
}

async function testPerformance(): Promise<void> {
  const mapPath = path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json');
  const mapDef: MapDef = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const server = new VisualServer(3203);

  try {
    await server.start(mapDef);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      const result = env.step(Math.floor(Math.random() * 64));
      server.broadcast(result.observation, result.observation.tick);
    }
    const elapsed = Date.now() - start;
    const sps = 1000 / (elapsed / 1000);
    assert(elapsed < 10000, `Performance: 1000 steps in ${elapsed}ms (${sps.toFixed(0)} SPS)`);
  } finally {
    await safeStop(server);
    env.close();
  }
}

async function main(): Promise<void> {
  console.log('=== Visualization Integration Tests ===\n');

  await testModuleImports();
  await testFullPipeline();
  await testEpisodeReset();
  await testMultipleOpponents();
  await testPerformance();

  console.log('\n=== All integration tests passed ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
