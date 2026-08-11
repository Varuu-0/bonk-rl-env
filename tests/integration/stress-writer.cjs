/* Concurrent writer for the snapshot-ring seqlock stress test.
 * Inlines a minimal seqlock writer matching src/render/snapshot-ring.ts layout
 * (Int32 header [seq, tick], then Float32 discs), so shared-buffer layout is
 * validated across a real thread boundary. The reader runs in the main thread. */
'use strict';
const { parentPort } = require('worker_threads');

let gen = 0;

parentPort.on('message', (msg) => {
  if (msg.cmd !== 'run') return;
  const { buffer, iterations, maxPlayers, HEADER_INTS, headerBytes, DISC_FIELDS } = msg;
  const header = new Int32Array(buffer, 0, HEADER_INTS); // slot-0 header view
  for (let i = 0; i < iterations; i++) {
    gen += 1;
    header[0] = gen * 2 + 1; // odd = in-progress
    const payload = new Float32Array(buffer, headerBytes, maxPlayers * DISC_FIELDS);
    for (let p = 0; p < maxPlayers; p++) {
      const o = p * DISC_FIELDS;
      payload[o] = i;          // x = tick (the cross-check basis)
      payload[o + 1] = i * 2;  // y
      payload[o + 2] = 0.5;    // angle
      payload[o + 3] = 0;      // isHeavy
      payload[o + 4] = i % 10 === 0 ? 1 : 0; // alive toggles every 10
    }
    header[1] = i;             // tick
    header[0] = gen * 2;       // even = committed, written last
    if (i === 0) parentPort.postMessage('started'); // signal first committed frame
  }
  parentPort.postMessage('done');
});