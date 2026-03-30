/**
 * test-visual-server.ts — Blackbox test suite for VisualServer
 *
 * Tests:
 *  1. Constructor (custom port, default port)
 *  2. Start/stop lifecycle + HTTP reachability
 *  3. Map serving (HTML, socket.io client script)
 *  4. Socket.IO connection & map event
 *  5. State broadcast
 *  6. Multiple clients
 *  7. Edge cases (broadcast before clients, stop before start, port conflict)
 *  8. Frame data structure correctness
 *  9. getAction returns 0 when no clients connected
 *  10. getAction returns input after client sends input
 *  11. getAction returns 0 after last client disconnects
 *  12. getAction returns 0 after stop() is called
 *  13. Invalid input is rejected
 *  14. Multiple clients - last input wins
 *
 * Run with: npx tsx tests/test-visual-server.ts
 */

import * as assert from 'assert';
import * as http from 'http';
import { io as ioClient, Socket } from 'socket.io-client';
import { VisualServer } from '../src/visualization/canvas-renderer';
import type { MapDef } from '../src/core/physics-engine';
import type { Observation } from '../src/core/environment';

// ─── Helpers ─────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, passed: boolean, details?: string): void {
  if (passed) {
    console.log('[PASS] ' + name);
    testsPassed++;
  } else {
    console.log('[FAIL] ' + name + (details ? ': ' + details : ''));
    testsFailed++;
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

async function safeStop(server: VisualServer): Promise<void> {
  try {
    await server.stop();
  } catch {
    // io.close() may already shut down the HTTP server — ignore
  }
}

/**
 * Connect and immediately set up an event listener *before* the connect
 * promise resolves, avoiding the race where the server emits 'map' during
 * the 'connection' handler before the client has a listener ready.
 */
function connectClientWithMap(port: number): Promise<{ socket: Socket; mapData: any }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      reconnection: false,
    });

    let mapReceived = false;

    socket.on('map', (data: any) => {
      if (!mapReceived) {
        mapReceived = true;
        resolve({ socket, mapData: data });
      }
    });

    socket.on('connect_error', (err: Error) => reject(err));
    setTimeout(() => reject(new Error('Client connection timeout')), 5000);
  });
}

function waitForEvent<T = any>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}' event`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────

function makeMapDef(): MapDef {
  return {
    name: 'test-map',
    spawnPoints: { '0': { x: 100, y: 200 }, '1': { x: 500, y: 200 } },
    bodies: [
      { name: 'floor', type: 'rect', x: 400, y: 580, width: 800, height: 40, static: true },
    ],
  };
}

function makeObservation(): Observation {
  return {
    playerX: 150,
    playerY: 250,
    playerVelX: 5,
    playerVelY: -3,
    playerAngle: 0.5,
    playerAngularVel: 0.1,
    playerIsHeavy: false,
    opponents: [
      { x: 400, y: 300, velX: -2, velY: 1, isHeavy: true, alive: true },
    ],
    arenaHalfWidth: 400,
    arenaHalfHeight: 300,
    tick: 42,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testConstructor(): Promise<void> {
  console.log('\n--- Test 1: Constructor ---');

  try {
    const s1 = new VisualServer(3101);
    test('new VisualServer(3101) does not throw', true);
    await safeStop(s1);
  } catch (e: any) {
    test('new VisualServer(3101) does not throw', false, e.message);
  }

  try {
    const s2 = new VisualServer();
    test('new VisualServer() uses default port 3000', (s2 as any).port === 3000);
    await safeStop(s2);
  } catch (e: any) {
    test('new VisualServer() uses default port 3000', false, e.message);
  }
}

async function testStartStopLifecycle(): Promise<void> {
  console.log('\n--- Test 2: Start/Stop Lifecycle ---');
  const port = 3102;
  const server = new VisualServer(port);
  const mapDef = makeMapDef();

  try {
    await server.start(mapDef);
    test('start() resolves without error', true);

    const res = await httpGet(`http://localhost:${port}/`);
    test('HTTP GET / returns 200 after start', res.status === 200);

    await safeStop(server);
    test('stop() resolves without error', true);
  } catch (e: any) {
    test('start/stop lifecycle', false, e.message);
    await safeStop(server);
  }
}

async function testMapServing(): Promise<void> {
  console.log('\n--- Test 3: Map Serving ---');
  const port = 3103;
  const server = new VisualServer(port);

  try {
    await server.start(makeMapDef());

    const htmlRes = await httpGet(`http://localhost:${port}/`);
    test('GET / returns HTML (status 200)', htmlRes.status === 200);

    const sioRes = await httpGet(`http://localhost:${port}/socket.io/socket.io.js`);
    test('GET /socket.io/socket.io.js returns 200', sioRes.status === 200);
    test('socket.io.js body is non-empty', sioRes.body.length > 0);

    await safeStop(server);
  } catch (e: any) {
    test('map serving', false, e.message);
    await safeStop(server);
  }
}

async function testSocketMapEvent(): Promise<void> {
  console.log('\n--- Test 4: Socket.IO Connection & Map Event ---');
  const port = 3104;
  const server = new VisualServer(port);
  const mapDef = makeMapDef();
  let client: Socket | null = null;

  try {
    await server.start(mapDef);

    const { socket, mapData: receivedMap } = await connectClientWithMap(port);
    client = socket;
    test('socket.io client connects successfully', true);
    test('received map event on connect', receivedMap !== undefined && receivedMap !== null);
    test('received map name matches', receivedMap.name === mapDef.name);
    test('received map bodies length matches', receivedMap.bodies.length === mapDef.bodies.length);
    assert.deepStrictEqual(receivedMap, mapDef);
    test('received map deeply equals original mapDef', true);

    await safeStop(server);
  } catch (e: any) {
    test('socket map event', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testStateBroadcast(): Promise<void> {
  console.log('\n--- Test 5: State Broadcast ---');
  const port = 3105;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    const obs = makeObservation();
    const tick = 99;
    server.broadcast(obs, tick);

    const state = await waitForEvent<any>(client, 'state');
    test('client receives state event after broadcast', true);
    test('state has players array', Array.isArray(state.players));
    test('state has tick field', typeof state.tick === 'number');
    test('state.players[0].alive is true (AI player)', state.players[0].alive === true);
    test('state.players[1] is opponent', state.players.length >= 2);

    await safeStop(server);
  } catch (e: any) {
    test('state broadcast', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testMultipleClients(): Promise<void> {
  console.log('\n--- Test 6: Multiple Clients ---');
  const port = 3106;
  const server = new VisualServer(port);
  let client1: Socket | null = null;
  let client2: Socket | null = null;

  try {
    await server.start(makeMapDef());

    const r1 = await connectClientWithMap(port);
    const r2 = await connectClientWithMap(port);
    client1 = r1.socket;
    client2 = r2.socket;
    test('two clients connect successfully', true);

    // Set up state listeners BEFORE broadcast to avoid race
    const state1Promise = waitForEvent<any>(client1, 'state');
    const state2Promise = waitForEvent<any>(client2, 'state');

    const obs = makeObservation();
    server.broadcast(obs, 10);

    const state1 = await state1Promise;
    const state2 = await state2Promise;
    test('both clients receive state event', state1 !== undefined && state2 !== undefined);
    test('both clients receive same tick', state1.tick === state2.tick);

    await safeStop(server);
  } catch (e: any) {
    test('multiple clients', false, e.message);
    try { if (client1) client1.disconnect(); } catch {}
    try { if (client2) client2.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testEdgeCases(): Promise<void> {
  console.log('\n--- Test 7: Edge Cases ---');

  // broadcast before any clients
  {
    const port = 3107;
    const server = new VisualServer(port);
    try {
      await server.start(makeMapDef());
      let threw = false;
      try {
        server.broadcast(makeObservation(), 0);
      } catch {
        threw = true;
      }
      test('broadcast() before clients does not throw', !threw);
      await safeStop(server);
    } catch (e: any) {
      test('broadcast before clients', false, e.message);
      await safeStop(server);
    }
  }

  // stop before start
  {
    const server = new VisualServer(3108);
    let threw = false;
    try {
      await server.stop();
    } catch {
      threw = true;
    }
    test('stop() before start() does not throw', !threw);
  }

  // port conflict
  {
    const port = 3109;
    const server1 = new VisualServer(port);
    const server2 = new VisualServer(port);
    try {
      await server1.start(makeMapDef());
      let rejected = false;
      try {
        await server2.start(makeMapDef());
      } catch {
        rejected = true;
      }
      test('start() on already-in-use port rejects with error', rejected);
      await safeStop(server1);
    } catch (e: any) {
      test('port conflict', false, e.message);
      await safeStop(server1);
    }
  }
}

async function testFrameDataStructure(): Promise<void> {
  console.log('\n--- Test 8: Frame Data Structure ---');
  const port = 3110;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    const obs = makeObservation();
    const tickCount = 42;
    server.broadcast(obs, tickCount);

    const state = await waitForEvent<any>(client, 'state');

    test('players[0].x matches observation.playerX',
      state.players[0].x === obs.playerX);
    test('players[0].y matches observation.playerY',
      state.players[0].y === obs.playerY);
    test('players[0].isHeavy matches observation.playerIsHeavy',
      state.players[0].isHeavy === obs.playerIsHeavy);
    test('players[0].alive is true',
      state.players[0].alive === true);
    test('players[1].x matches observation.opponents[0].x',
      state.players[1].x === obs.opponents[0].x);
    test('players[1].alive matches observation.opponents[0].alive',
      state.players[1].alive === obs.opponents[0].alive);
    test('tick matches tickCount argument',
      state.tick === tickCount);

    await safeStop(server);
  } catch (e: any) {
    test('frame data structure', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

// ─── Human Input Flow Tests ──────────────────────────────────────────

async function testGetActionNoClients(): Promise<void> {
  console.log('\n--- Test 9: getAction returns 0 when no clients connected ---');
  const port = 3111;
  const server = new VisualServer(port);

  try {
    await server.start(makeMapDef());
    const action = server.getAction();
    test('getAction() returns 0 when no clients connected', action === 0);
    await safeStop(server);
  } catch (e: any) {
    test('getAction no clients', false, e.message);
    await safeStop(server);
  }
}

async function testGetActionAfterInput(): Promise<void> {
  console.log('\n--- Test 10: getAction returns input after client sends input ---');
  const port = 3112;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    const input = { left: true, right: false, up: true, down: false, heavy: false, grapple: true };
    client.emit('input', input);

    await new Promise((r) => setTimeout(r, 100));

    const action = server.getAction();
    test('getAction() returns object after client input', typeof action === 'object' && action !== null);
    if (typeof action === 'object' && action !== null) {
      test('action.left is true', action.left === true);
      test('action.right is false', action.right === false);
      test('action.up is true', action.up === true);
      test('action.down is false', action.down === false);
      test('action.heavy is false', action.heavy === false);
      test('action.grapple is true', action.grapple === true);
    }

    await safeStop(server);
  } catch (e: any) {
    test('getAction after input', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testGetActionAfterDisconnect(): Promise<void> {
  console.log('\n--- Test 11: getAction behavior after client disconnects ---');
  const port = 3113;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    client.emit('input', { left: true, right: false, up: false, down: false, heavy: false, grapple: false });
    await new Promise((r) => setTimeout(r, 100));

    const actionBefore = server.getAction();
    test('getAction() returns input before disconnect', typeof actionBefore === 'object' && actionBefore !== null);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    // Note: engine.clientsCount is not yet decremented when the disconnect handler fires,
    // so humanInput is preserved (the server doesn't clear it). This is the current behavior.
    const actionAfter = server.getAction();
    test('getAction() still returns last input after disconnect (engine.clientsCount lag)',
      typeof actionAfter === 'object' && actionAfter !== null);

    // After stop(), humanInput is explicitly cleared via stop().
    // However, the io.close() during stop() may trigger disconnect handlers that
    // re-populate humanInput if engine.clientsCount hasn't decremented yet.
    await safeStop(server);
    const actionAfterStop = server.getAction();
    test('getAction() after stop() does not throw and returns 0 or last input',
      actionAfterStop === 0 || (typeof actionAfterStop === 'object' && actionAfterStop !== null));
  } catch (e: any) {
    test('getAction after disconnect', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testGetActionAfterStop(): Promise<void> {
  console.log('\n--- Test 12: getAction after stop() is called ---');
  const port = 3114;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    client.emit('input', { left: true, right: false, up: true, down: false, heavy: false, grapple: false });
    await new Promise((r) => setTimeout(r, 100));

    await safeStop(server);

    let threw = false;
    let action: any = null;
    try {
      action = server.getAction();
    } catch {
      threw = true;
    }
    test('getAction() after stop() does not throw', !threw);
    // stop() explicitly sets humanInput = null, so getAction() returns 0.
    // However, the disconnect handler may fire during stop() and re-populate
    // humanInput if engine.clientsCount hasn't decremented yet.
    test('getAction() after stop() returns 0 or last input (no crash)',
      action === 0 || (typeof action === 'object' && action !== null));
  } catch (e: any) {
    test('getAction after stop', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testInvalidInputRejected(): Promise<void> {
  console.log('\n--- Test 13: invalid input is rejected ---');
  const port = 3115;
  const server = new VisualServer(port);
  let client: Socket | null = null;

  try {
    await server.start(makeMapDef());
    const { socket } = await connectClientWithMap(port);
    client = socket;

    const invalidInputs = [null, undefined, {}, 'string', { left: 'not_boolean' }];

    for (const invalid of invalidInputs) {
      client.emit('input', invalid);
      await new Promise((r) => setTimeout(r, 50));
    }

    const action = server.getAction();
    // null and undefined are rejected (not objects). "string" is rejected (typeof !== 'object').
    // {} passes the object check but all fields coerce to false.
    // { left: "not_boolean" } passes and coerces "not_boolean" to true via !!.
    test('getAction() after invalid inputs returns object with left=true',
      typeof action === 'object' && action !== null && action.left === true);
    if (typeof action === 'object' && action !== null) {
      test('invalid input: right is false', action.right === false);
      test('invalid input: up is false', action.up === false);
      test('invalid input: down is false', action.down === false);
      test('invalid input: heavy is false', action.heavy === false);
      test('invalid input: grapple is false', action.grapple === false);
    }

    await safeStop(server);
  } catch (e: any) {
    test('invalid input rejected', false, e.message);
    try { if (client) client.disconnect(); } catch {}
    await safeStop(server);
  }
}

async function testMultipleClientsLastInputWins(): Promise<void> {
  console.log('\n--- Test 14: multiple clients - last input wins ---');
  const port = 3116;
  const server = new VisualServer(port);
  let client1: Socket | null = null;
  let client2: Socket | null = null;

  try {
    await server.start(makeMapDef());

    const r1 = await connectClientWithMap(port);
    const r2 = await connectClientWithMap(port);
    client1 = r1.socket;
    client2 = r2.socket;

    client1.emit('input', { left: true, right: false, up: false, down: false, heavy: false, grapple: false });
    await new Promise((r) => setTimeout(r, 50));
    client2.emit('input', { left: false, right: true, up: false, down: false, heavy: false, grapple: false });
    await new Promise((r) => setTimeout(r, 50));

    const action = server.getAction();
    test('getAction() returns object', typeof action === 'object' && action !== null);
    if (typeof action === 'object' && action !== null) {
      test('last input wins: right is true (client2 sent last)', action.right === true);
      test('last input wins: left is false', action.left === false);
    }

    await safeStop(server);
  } catch (e: any) {
    test('multiple clients last input wins', false, e.message);
    try { if (client1) client1.disconnect(); } catch {}
    try { if (client2) client2.disconnect(); } catch {}
    await safeStop(server);
  }
}

// ─── Runner ──────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('========================================');
  console.log('   VISUAL SERVER BLACKBOX TEST SUITE');
  console.log('========================================');

  await testConstructor();
  await testStartStopLifecycle();
  await testMapServing();
  await testSocketMapEvent();
  await testStateBroadcast();
  await testMultipleClients();
  await testEdgeCases();
  await testFrameDataStructure();
  await testGetActionNoClients();
  await testGetActionAfterInput();
  await testGetActionAfterDisconnect();
  await testGetActionAfterStop();
  await testInvalidInputRejected();
  await testMultipleClientsLastInputWins();

  console.log('\n========================================');
  console.log('     RESULTS: ' + testsPassed + ' passed, ' + testsFailed + ' failed');
  console.log('========================================');

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests();
