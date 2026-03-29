import * as zmq from 'zeromq';
import { WorkerPool } from '../src/core/worker-pool';
import { IpcBridge } from '../src/ipc/ipc-bridge';
import { BonkEnvironment } from '../src/core/environment';

const STEPS = 500;
const ZMQ_STEPS = 200;
const PORT = 5599;

async function main() {
  // Test 1: Direct BonkEnvironment (no workers, no IPC)
  console.log('=== Layer 0: Direct BonkEnvironment (no workers) ===');
  const env = new BonkEnvironment({ numOpponents: 1, randomOpponent: false });
  env.reset();
  let start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    env.step(Math.floor(Math.random() * 64));
  }
  let elapsed = performance.now() - start;
  console.log(`  ${STEPS} steps in ${elapsed.toFixed(1)}ms = ${(STEPS / (elapsed / 1000)).toFixed(0)} SPS`);
  env.close();

  // Test 2: WorkerPool with 1 env, shared memory (no ZMQ)
  console.log('\n=== Layer 1: WorkerPool 1 env (shared memory, no ZMQ) ===');
  const pool1 = new WorkerPool(1);
  await pool1.init(1, { randomOpponent: false }, true);
  await pool1.reset();
  start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    await pool1.step([Math.floor(Math.random() * 64)]);
  }
  elapsed = performance.now() - start;
  console.log(`  ${STEPS} steps in ${elapsed.toFixed(1)}ms = ${(STEPS / (elapsed / 1000)).toFixed(0)} SPS`);
  pool1.close();

  // Test 3: WorkerPool with 2 envs, shared memory (no ZMQ)
  console.log('\n=== Layer 2: WorkerPool 2 envs (shared memory, no ZMQ) ===');
  const pool2 = new WorkerPool(1);
  await pool2.init(2, { randomOpponent: false }, true);
  await pool2.reset();
  start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    await pool2.step([Math.floor(Math.random() * 64), Math.floor(Math.random() * 64)]);
  }
  elapsed = performance.now() - start;
  console.log(`  ${STEPS} steps in ${elapsed.toFixed(1)}ms = ${(STEPS / (elapsed / 1000)).toFixed(0)} SPS`);
  pool2.close();

  // Test 4: IpcBridge.stepEnv (no ZMQ, direct call)
  console.log('\n=== Layer 3: IpcBridge.stepEnv (direct, no ZMQ) ===');
  const bridge = new IpcBridge(PORT);
  await bridge.initEnv(2, { randomOpponent: false }, true);
  await bridge.resetEnv();
  start = performance.now();
  for (let i = 0; i < STEPS; i++) {
    await bridge.stepEnv([Math.floor(Math.random() * 64), Math.floor(Math.random() * 64)]);
  }
  elapsed = performance.now() - start;
  console.log(`  ${STEPS} steps in ${elapsed.toFixed(1)}ms = ${(STEPS / (elapsed / 1000)).toFixed(0)} SPS`);

  // Test 5: Full ZMQ round-trip (IpcBridge server + Dealer client)
  console.log(`\n=== Layer 4: Full ZMQ round-trip (${ZMQ_STEPS} steps, 2 envs) ===`);

  // Start the bridge server in background
  bridge.start().catch(() => {}); // Will run until we close
  // Give it a moment to bind
  await new Promise(r => setTimeout(r, 200));

  // Create a ZMQ Dealer client
  const client = new zmq.Dealer();
  await client.connect(`tcp://127.0.0.1:${PORT}`);
  await new Promise(r => setTimeout(r, 100));

  // Helper: receive response from ZMQ (handles frame format)
  async function recvResp(): Promise<any> {
    const frames = await client.receive();
    // Dealer may return frames as array or single Uint8Array
    const data = Array.isArray(frames) ? frames[frames.length - 1] : frames;
    return JSON.parse(Buffer.from(data).toString());
  }

  // Dealer→Router needs empty delimiter frame; IpcBridge reads frames[frames.length-1]
  async function sendReq(obj: any) {
    await client.send(['', JSON.stringify(obj)]);
  }

  // Send init command
  await sendReq({
    command: 'init',
    numEnvs: 2,
    config: { randomOpponent: false },
    useSharedMemory: true
  });
  const initData = await recvResp();
  console.log(`  Init response: ${initData.status}`);

  // Send reset command
  await sendReq({ command: 'reset', seeds: [0, 0] });
  const resetData = await recvResp();
  console.log(`  Reset response: ${resetData.status}`);

  // Measure ZMQ step round-trip
  start = performance.now();
  for (let i = 0; i < ZMQ_STEPS; i++) {
    const action = Math.floor(Math.random() * 64);
    await sendReq({
      command: 'step',
      actions: [action, action]
    });
    await recvResp();
  }
  elapsed = performance.now() - start;
  console.log(`  ${ZMQ_STEPS} steps in ${elapsed.toFixed(1)}ms = ${(ZMQ_STEPS / (elapsed / 1000)).toFixed(0)} SPS`);
  console.log(`  Avg round-trip: ${(elapsed / ZMQ_STEPS).toFixed(2)}ms`);

  // Test 6: ZMQ echo (no processing, just socket overhead)
  console.log(`\n=== Layer 5: ZMQ echo (${ZMQ_STEPS} round-trips, no processing) ===`);
  start = performance.now();
  for (let i = 0; i < ZMQ_STEPS; i++) {
    await sendReq({ command: 'ping' });
    await recvResp();
  }
  elapsed = performance.now() - start;
  console.log(`  ${ZMQ_STEPS} round-trips in ${elapsed.toFixed(1)}ms = ${(ZMQ_STEPS / (elapsed / 1000)).toFixed(0)} RPS`);
  console.log(`  Avg round-trip: ${(elapsed / ZMQ_STEPS).toFixed(2)}ms`);

  client.close();
  await bridge.close();

  console.log('\n=== Summary ===');
  console.log('Layer 0: Direct BonkEnvironment (pure physics + env wrapper)');
  console.log('Layer 1: WorkerPool 1 env (shared memory, worker thread)');
  console.log('Layer 2: WorkerPool 2 envs (shared memory, worker thread)');
  console.log('Layer 3: IpcBridge.stepEnv (bridge overhead, no ZMQ)');
  console.log('Layer 4: Full ZMQ step round-trip (serialize + ZMQ + bridge + pool)');
  console.log('Layer 5: ZMQ echo round-trip (serialize + ZMQ + parse only)');

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
