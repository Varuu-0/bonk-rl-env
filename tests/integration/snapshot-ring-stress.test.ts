import { describe, it, expect } from 'vitest';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { allocRing, readSnapshotCoherent, HEADER_INTS, DISC_FIELDS } from '../../src/render/snapshot-ring';

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
    // The writer is paced to ~1ms per committed frame (stress-writer.cjs), so
    // this is the number of write cycles the test runs. Atomics.wait wake times
    // vary by platform (as high as the OS timer resolution, e.g. ~15ms on
    // Windows), so the total stays a few seconds to ~15s — comfortably inside
    // the 30s timeout. An unpaced 50k-loop finished in a few ms, which let
    // whichever thread got scheduled first run to completion before the other
    // started — the reader looped against a static frame or the writer never
    // overlapped the reader at all.
    const iterations = 1000;
    // Tight reads per pace tick: the writer commits once per ~1ms cycle, so a
    // burst that long deterministically straddles a commit (exercising the
    // torn-commit branch) and samples in-progress odd-seq windows.
    const burstReads = 32;
    const maxPlayers = 1;
    const worker = new Worker(path.join(__dirname, 'stress-writer.cjs'));
    // Pace buffer for the reader: a never-touched SharedArrayBuffer slot, so
    // Atomics.wait always runs the full ~1ms timeout between bursts.
    const readerPace = new Int32Array(new SharedArrayBuffer(4));
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('online', resolve);
        worker.once('error', reject);
      });

      const headerBytes = HEADER_INTS * 4;
      // Handshake: the worker signals once it has committed its first frame,
      // so the reader is guaranteed to poll an actively writing slot. Raced
      // against a 5s timeout so a broken handshake fails loudly instead of
      // hanging the test until the vitest timeout.
      const started = new Promise<void>((resolve, reject) => {
        worker.on('message', (m) => { if (m === 'started') resolve(); });
        worker.on('error', reject);
      });
      const startedHandshake = Promise.race([
        started,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('stress-writer "started" handshake timed out after 5s')),
            5000,
          );
          timer.unref();
        }),
      ]);
      const done = new Promise<void>((resolve, reject) => {
        worker.on('message', (m) => { if (m === 'done') resolve(); });
        worker.on('error', reject);
      });
      worker.postMessage({
        cmd: 'run', buffer: ring, iterations, maxPlayers,
        HEADER_INTS, headerBytes, DISC_FIELDS,
      }, []);
      await startedHandshake;

      // Read concurrently while the worker writes. Pacing each burst at ~1ms
      // makes the reader's loop deterministically span the writer's entire
      // write window: it observes every distinct committed frame (never one
      // static frame), and the tight bursts per tick deterministically straddle
      // a commit (exercising the torn-commit branch) instead of the writer
      // finishing before the reader starts or vice versa.
      let coherentReads = 0;
      let mismatches = 0;
      for (let tick = 0; tick < iterations; tick++) {
        for (let b = 0; b < burstReads; b++) {
          const raw = readSnapshotCoherent(ring, maxPlayers, 0);
          if (raw) {
            coherentReads++;
            // Strong coherence check: the disc x payload must equal the tick.
            // alive toggles every 10 ticks, so x===tick is a much stronger torn
            // detection than comparing the periodic alive flag alone.
            if (raw.discs[0].x !== raw.tick) mismatches++;
          }
        }
        Atomics.wait(readerPace, 0, 0, 1);
      }
      await done;
      expect(coherentReads).toBeGreaterThan(0);
      expect(mismatches).toBe(0);
    } finally {
      await worker.terminate();
    }
  }, 30_000);
});