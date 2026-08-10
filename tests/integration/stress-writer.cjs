/* Concurrent writer for the snapshot-ring seqlock stress test.
 * Inlines a minimal seqlock writer matching src/render/snapshot-ring.ts layout
 * (Int32 header [seq, tick], then Float32 discs), so shared-buffer layout is
 * validated across a real thread boundary. The reader runs in the main thread. */
'use strict';
const { parentPort } = require('worker_threads');

const DISC_FIELDS = 5;
let gen = 0;

function writeFrame(buffer, maxPlayers, slotIndex, tick, alive) {
  const perSlot = 2 * 4 + maxPlayers * DISC_FIELDS * 4;
  const header = new Int32Array(buffer, slotIndex * perSlot, 2);
  const payload = new Float32Array(buffer, slotIndex * perSlot + 8, maxPlayers * DISC_FIELDS);
  gen += 1;
  header[0] = gen * 2 + 1; // odd = in-progress
  for (let p = 0; p < maxPlayers; p++) {
    const o = p * DISC_FIELDS;
    payload[o] = tick;
    payload[o + 1] = tick * 2;
    payload[o + 2] = 0.5;
    payload[o + 3] = 0;
    payload[o + 4] = alive ? 1 : 0;
  }
  header[1] = tick;
  header[0] = gen * 2; // even = committed, written last
}

parentPort.on('message', (msg) => {
  if (msg.cmd !== 'run') return;
  const { buffer, iterations, maxPlayers } = msg;
  for (let i = 0; i < iterations; i++) {
    // alive toggles every 10 ticks so the reader can cross-check disc payload
    // (alive) against the returned tick — a torn frame would mismatch.
    writeFrame(buffer, maxPlayers, 0, i, i % 10 === 0);
  }
  parentPort.postMessage('done');
});