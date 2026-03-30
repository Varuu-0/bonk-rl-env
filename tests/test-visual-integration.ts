/**
 * test-visual-integration.ts — Integration smoke test for the full visualization pipeline.
 *
 * Verifies end-to-end: map loading → BonkEnvironment → VisualServer → socket.io broadcast → client receipt.
 *
 * Run with: npx tsx tests/test-visual-integration.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { io as ioClient } from 'socket.io-client';

import { VisualServer } from '../src/visualization/canvas-renderer';
import { BonkEnvironment } from '../src/core/environment';
import { MapDef } from '../src/core/physics-engine';

// ─── Test Helpers ─────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, passed: boolean, details?: string): void {
  if (passed) {
    console.log('+ ' + name);
    testsPassed++;
  } else {
    console.log('X ' + name + (details ? ': ' + details : ''));
    testsFailed++;
  }
}

const MAP_PATH = path.join(__dirname, '..', 'maps', 'bonk_Simple_1v1_123.json');
const TEST_PORT = 3200;
const TEST_URL = `http://localhost:${TEST_PORT}`;

function loadMap(): MapDef {
  return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Test 1: Module Imports ───────────────────────────────────────────

function testModuleImports(): void {
  console.log('\n--- Test 1: Module Imports ---');

  test('VisualServer can be imported', typeof VisualServer === 'function');
  test('BonkEnvironment can be imported', typeof BonkEnvironment === 'function');
  test('MapDef type is available (loadMap succeeds)', (() => {
    try {
      const m = loadMap();
      return m && typeof m === 'object' && 'bodies' in m;
    } catch {
      return false;
    }
  })());
}

// ─── Test 2: Full Pipeline Smoke Test ─────────────────────────────────

async function testFullPipeline(): Promise<void> {
  console.log('\n--- Test 2: Full Pipeline Smoke Test ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT);

  try {
    await visualServer.start(mapDef);
    test('VisualServer starts without error', true);

    // Run 10 steps and broadcast — should not throw
    let broadcastOk = true;
    let lastObs: any = null;
    for (let i = 0; i < 10; i++) {
      const action = Math.floor(Math.random() * 64);
      const result = env.step(action);
      lastObs = result.observation;
      try {
        visualServer.broadcast(result.observation, result.observation.tick);
      } catch (e: any) {
        broadcastOk = false;
        test('Broadcast threw on step ' + i, false, e.message);
        break;
      }
    }
    test('10 steps + broadcasts complete without error', broadcastOk);

    // Connect a socket.io client and verify it receives at least one 'state' event
    const statePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for state event')), 5000);

      const client = ioClient(TEST_URL, {
        transports: ['websocket'],
        forceNew: true,
      });

      client.on('state', (data: any) => {
        clearTimeout(timeout);
        client.disconnect();
        resolve(data);
      });

      client.on('connect_error', (err: any) => {
        clearTimeout(timeout);
        client.disconnect();
        reject(err);
      });
    });

    // Give the client a moment to connect, then broadcast
    await sleep(500);
    if (lastObs) {
      visualServer.broadcast(lastObs, lastObs.tick);
    }

    try {
      const stateData = await statePromise;
      test('Socket client receives state event', stateData !== null && stateData !== undefined);
      test('State event has players array', Array.isArray(stateData.players));
      test('State event has tick number', typeof stateData.tick === 'number');
    } catch (e: any) {
      test('Socket client receives state event', false, e.message);
    }
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 3: Episode Reset During Visualization ───────────────────────

async function testEpisodeReset(): Promise<void> {
  console.log('\n--- Test 3: Episode Reset During Visualization ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT + 1);

  try {
    await visualServer.start(mapDef);

    // Run until done
    let result = env.step(0);
    let steps = 0;
    while (!result.done && steps < 2000) {
      result = env.step(Math.floor(Math.random() * 64));
      steps++;
    }

    test('Episode completes within 2000 steps', result.done, `steps=${steps}`);

    // Reset
    const obsAfterReset = env.reset();
    test('Tick counter resets after episode', obsAfterReset.tick === 0);

    // Continue stepping after reset — broadcast should still work
    let broadcastAfterResetOk = true;
    for (let i = 0; i < 10; i++) {
      const stepResult = env.step(Math.floor(Math.random() * 64));
      try {
        visualServer.broadcast(stepResult.observation, stepResult.observation.tick);
      } catch (e: any) {
        broadcastAfterResetOk = false;
        break;
      }
    }
    test('Broadcast works after episode reset', broadcastAfterResetOk);
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 4: Multiple Opponents ───────────────────────────────────────

async function testMultipleOpponents(): Promise<void> {
  console.log('\n--- Test 4: Multiple Opponents ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 2 });
  const visualServer = new VisualServer(TEST_PORT + 2);

  try {
    await visualServer.start(mapDef);

    const result = env.step(0);
    const obs = result.observation;

    test('Observation has 2 opponents', obs.opponents.length === 2);

    // Broadcast and verify player count
    let framePlayers = 0;
    const capturePromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out')), 5000);

      const client = ioClient(`http://localhost:${TEST_PORT + 2}`, {
        transports: ['websocket'],
        forceNew: true,
      });

      client.on('state', (data: any) => {
        clearTimeout(timeout);
        client.disconnect();
        resolve(data.players.length);
      });

      client.on('connect_error', (err: any) => {
        clearTimeout(timeout);
        client.disconnect();
        reject(err);
      });
    });

    await sleep(500);
    visualServer.broadcast(obs, obs.tick);

    try {
      framePlayers = await capturePromise;
      test('Broadcast state has 3 players (1 AI + 2 opponents)', framePlayers === 3);
    } catch (e: any) {
      test('Broadcast state has 3 players (1 AI + 2 opponents)', false, e.message);
    }
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 5: Performance Smoke Test ───────────────────────────────────

async function testPerformance(): Promise<void> {
  console.log('\n--- Test 5: Performance Smoke Test ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT + 3);

  try {
    await visualServer.start(mapDef);

    const STEPS = 1000;
    const startMs = performance.now();

    for (let i = 0; i < STEPS; i++) {
      const result = env.step(Math.floor(Math.random() * 64));
      visualServer.broadcast(result.observation, result.observation.tick);
    }

    const elapsedMs = performance.now() - startMs;
    const elapsedSec = elapsedMs / 1000;
    const sps = STEPS / elapsedSec;

    test(
      `1000 steps + broadcasts complete in under 10s (${elapsedSec.toFixed(2)}s, ${sps.toFixed(0)} SPS)`,
      elapsedSec < 10,
      `${elapsedSec.toFixed(2)}s elapsed`,
    );
    test('Throughput exceeds 100 SPS', sps > 100, `${sps.toFixed(0)} SPS`);
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 6: Human Input Affects Environment ────────────────────────

async function testHumanInputAffectsEnvironment(): Promise<void> {
  console.log('\n--- Test 6: Human Input Affects Environment ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT + 4);

  try {
    await visualServer.start(mapDef);

    // Run 50 steps with no human input — getAction() should return 0
    for (let i = 0; i < 50; i++) {
      const action = visualServer.getAction();
      const result = env.step(action);
      visualServer.broadcast(result.observation, result.observation.tick);
    }

    test('getAction() returns 0 with no human connected', visualServer.getAction() === 0);

    const posBefore = { x: env.getObservation().playerX, y: env.getObservation().playerY };

    // Connect a client and send left input
    const client = ioClient(`http://localhost:${TEST_PORT + 4}`, {
      transports: ['websocket'],
      forceNew: true,
    });

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    client.emit('input', { left: true, right: false, up: false, down: false, heavy: false, grapple: false });
    await sleep(100);

    test('getAction() returns non-zero after human input', visualServer.getAction() !== 0);

    // Run 50 more steps — player should move left
    for (let i = 0; i < 50; i++) {
      const action = visualServer.getAction();
      const result = env.step(action);
      visualServer.broadcast(result.observation, result.observation.tick);
    }

    const posAfter = { x: env.getObservation().playerX, y: env.getObservation().playerY };
    test('Human input moves player left', posAfter.x < posBefore.x, `before=${posBefore.x.toFixed(2)} after=${posAfter.x.toFixed(2)}`);

    client.disconnect();
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 7: Input Disconnect Reverts to No-Input ──────────────────

async function testInputDisconnectReverts(): Promise<void> {
  console.log('\n--- Test 7: Input Disconnect Reverts to No-Input ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT + 5);

  try {
    await visualServer.start(mapDef);

    // Connect client and send right input
    const client = ioClient(`http://localhost:${TEST_PORT + 5}`, {
      transports: ['websocket'],
      forceNew: true,
    });

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    client.emit('input', { left: false, right: true, up: false, down: false, heavy: false, grapple: false });
    await sleep(100);

    test('getAction() returns right input (bit 1 set)', visualServer.getAction() === 2);

    // Run some steps — player should move right
    for (let i = 0; i < 20; i++) {
      const action = visualServer.getAction();
      const result = env.step(action);
      visualServer.broadcast(result.observation, result.observation.tick);
    }

    // Disconnect client
    client.disconnect();
    await sleep(100);

    test('getAction() returns 0 after disconnect', visualServer.getAction() === 0);

    // Run more steps — should still work with no input
    for (let i = 0; i < 10; i++) {
      const action = visualServer.getAction();
      const result = env.step(action);
      visualServer.broadcast(result.observation, result.observation.tick);
    }

    test('getAction() still returns 0 after more steps', visualServer.getAction() === 0);
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Test 8: Game Loop Works with getAction ─────────────────────────

async function testGameLoopWithGetAction(): Promise<void> {
  console.log('\n--- Test 8: Game Loop Works with getAction ---');

  const mapDef = loadMap();
  const env = new BonkEnvironment({ mapData: mapDef, seed: 42, numOpponents: 1 });
  const visualServer = new VisualServer(TEST_PORT + 6);

  try {
    await visualServer.start(mapDef);

    // Simulate game loop without human input
    let loopOk = true;
    try {
      for (let i = 0; i < 100; i++) {
        const action = visualServer.getAction();
        const result = env.step(action);
        visualServer.broadcast(result.observation, result.observation.tick);
        if (result.done) env.reset();
      }
    } catch (e: any) {
      loopOk = false;
      test('Game loop without human input completes', false, e.message);
    }
    test('Game loop without human input completes 100 steps', loopOk);

    // Connect a client, send input, continue loop
    const client = ioClient(`http://localhost:${TEST_PORT + 6}`, {
      transports: ['websocket'],
      forceNew: true,
    });

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    client.emit('input', { left: false, right: true, up: false, down: false, heavy: false, grapple: false });
    await sleep(100);

    let loopWithInputOk = true;
    try {
      for (let i = 0; i < 100; i++) {
        const action = visualServer.getAction();
        const result = env.step(action);
        visualServer.broadcast(result.observation, result.observation.tick);
        if (result.done) env.reset();
      }
    } catch (e: any) {
      loopWithInputOk = false;
      test('Game loop with human input completes', false, e.message);
    }
    test('Game loop with human input completes 100 more steps', loopWithInputOk);

    client.disconnect();
  } finally {
    env.close();
    await visualServer.stop();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testModuleImports();
  await testFullPipeline();
  await testEpisodeReset();
  await testMultipleOpponents();
  await testPerformance();
  await testHumanInputAffectsEnvironment();
  await testInputDisconnectReverts();
  await testGameLoopWithGetAction();

  console.log('\n--- Results ---');
  console.log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
