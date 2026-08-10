import { describe, it, expect } from 'vitest';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { allocRing, readSnapshotCoherent } from '../../src/render/snapshot-ring';

/**
 * Concurrent torn-read stress test for the snapshot-ring seqlock.
 *
 * A single-threaded unit test cannot deterministically trigger the torn-commit
 * branch (`seqAfter !== seqBefore`) because it cannot interleave a write inside
 * a synchronous read call. Here a worker thread hammers the shared slot while
 * the main thread reads it concurrently: over many loops the reader must never
 * observe an incoherent frame (a torn payload committed with an even seq), so
 * every returned disc payload must be consistent with its returned tick.
 */
describe('snapshot-ring seqlock concurrency', () => {
  it('never yields a torn frame under concurrent read/write', async () => {
    const ring = allocRing(2, 1);
    const iterations = 50_000;
    const maxPlayers = 1;
    const worker = new Worker(path.join(__dirname, 'stress-writer.cjs'));
    await new Promise<void>((resolve, reject) => {
      worker.once('online', resolve);
      worker.once('error', reject);
    });

    const done = new Promise<void>((resolve, reject) => {
      worker.on('message', (m) => { if (m === 'done') resolve(); });
      worker.on('error', reject);
      worker.postMessage({ cmd: 'run', buffer: ring, iterations, maxPlayers }, []);
    });

    // Read concurrently while the worker writes.
    let coherentReads = 0;
    let mismatches = 0;
    let reads = 0;
    while (reads < iterations) {
      const raw = readSnapshotCoherent(ring, maxPlayers, 0);
      if (raw) {
        coherentReads++;
        // alive is true for ticks % 10 === 0, false otherwise.
        const expectedAlive = raw.tick % 10 === 0;
        if (raw.discs[0].alive !== expectedAlive) mismatches++;
      }
      reads++;
    }
    await done;
    await worker.terminate();

    expect(coherentReads).toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  }, 30_000);
});