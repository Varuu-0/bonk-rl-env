/**
 * preview-server.test.ts — live preview streaming and episode lifecycle.
 *
 * Spawns the real dev server as a child process and asserts these contracts:
 *   1. `done` must reach a connected client before the process exits (it is
 *      buffered behind the final frame, so shutdown must give it time to
 *      flush), and the exit must be deterministic even when the client holds
 *      the SSE socket open.
 *   2. A non-positive `--fps` value must fail fast with a clear CLI error.
 *   3. Terminal episodes auto-reset after their frame-skip hold instead of
 *      streaming or dumping the same frozen death frame forever.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { connect } from 'node:net';
import { BonkEnvironment } from '../../src/core/environment';
import type { MapDef } from '../../src/core/physics-engine';
import { createPreviewFrameStepper } from '../../src/render/preview-loop';
import { renderEnvFrameSvg } from '../../src/render/render-wiring';

const TSX_CLI = 'node_modules/tsx/dist/cli.mjs';
const SERVER_SCRIPT = 'src/render/preview-server.ts';

const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) child.kill();
});

interface ServerHandle {
  stderrText(): string;
  waitForPort(): Promise<number>;
  waitForExit(): Promise<number | null>;
}

function startServer(args: string[]): ServerHandle {
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SCRIPT, ...args], { cwd: process.cwd() });
  started.push(child);
  let stdout = '';
  let stderr = '';
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const match = /localhost:(\d+)/.exec(stdout);
    if (match) resolvePort(Number(match[1]));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  return {
    stderrText: () => stderr,
    waitForPort: () => portPromise,
    waitForExit: () => exitPromise,
  };
}

function waitForServerPort(server: ServerHandle): Promise<number> {
  return Promise.race([
    server.waitForPort(),
    server
      .waitForExit()
      .then((code) =>
        Promise.reject(new Error(`Server exited before listening (code ${code}): ${server.stderrText()}`)),
      ),
  ]);
}

interface SseEvent {
  event: string;
  data: string;
}

async function readSseUntil(
  port: number,
  isComplete: (events: SseEvent[]) => boolean,
  closeWhenComplete = false,
): Promise<SseEvent[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/frames`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split === -1) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event:\s*(\S+)/m.exec(block)?.[1];
        const data = /^data:\s*(.*)$/m.exec(block)?.[1] ?? '';
        if (event) events.push({ event, data });
      }
      if (isComplete(events)) {
        if (closeWhenComplete) await reader.cancel();
        return events;
      }
    }
    throw new Error('SSE stream ended before the expected event sequence');
  } catch (error) {
    if (abort.signal.aborted) throw new Error('Timed out waiting for the expected SSE event sequence');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Connect until `done` without proactively closing the socket, so shutdown
 *  must settle the held-open SSE client itself. */
function readSseUntilDone(port: number): Promise<SseEvent[]> {
  return readSseUntil(port, (events) => events.some((entry) => entry.event === 'done'));
}

interface PreviewFramePayload {
  tick: number;
  simTick: number;
  svg: string;
}

interface PreviewMetaPayload {
  map: string;
  width: number;
  height: number;
  episode: number;
}

function framePayloads(events: SseEvent[]): PreviewFramePayload[] {
  return events
    .filter((entry) => entry.event === 'frame')
    .map((entry) => JSON.parse(entry.data) as PreviewFramePayload);
}

const deathAtTickOneMap: MapDef = {
  name: 'preview_terminal_hold',
  spawnPoints: { team_blue: { x: 900, y: 0 }, team_red: { x: 200, y: -100 } },
  bodies: [{ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true }],
};

describe('preview episode auto-reset', () => {
  it('renders one terminal frame, drains the hold, then restarts at tick 1', () => {
    const env = new BonkEnvironment({
      mapData: deathAtTickOneMap,
      numOpponents: 1,
      randomOpponent: false,
      seed: 42,
      frameSkip: 4,
    });
    try {
      const stepPreview = createPreviewFrameStepper(env, () => renderEnvFrameSvg(env));
      const steps = Array.from({ length: 5 }, () => stepPreview());

      expect(steps[0].episodeEnded).toBe(true);
      expect(steps[0].result.observation.tick).toBe(1);
      expect(steps[0].frame).not.toBeNull();
      expect(steps.slice(1, 4).every((step) => step.frame === null)).toBe(true);
      expect(steps[3].reset).toBe(true);
      expect(steps[4].result.observation.tick).toBe(1);
      expect(steps[4].frame).not.toBeNull();
    } finally {
      env.close();
    }
  });

  it('restarts an unbounded live stream with distinct frames', async () => {
    const server = startServer([
      '--map',
      'maps/bonk_WDB__No_Mapshake__716916.json',
      '--ticks',
      '0',
      '--fps',
      '100',
      '--port',
      '0',
    ]);
    const port = await waitForServerPort(server);
    const events = await readSseUntil(
      port,
      (entries) => {
        const episodeEnd = entries.findIndex((entry) => entry.event === 'episode-end');
        return episodeEnd >= 0 && framePayloads(entries.slice(episodeEnd + 1)).length >= 5;
      },
      true,
    );

    const episodeEnd = events.findIndex((entry) => entry.event === 'episode-end');
    const terminalFrame = framePayloads(events.slice(0, episodeEnd)).at(-1)!;
    const postTerminalFrames = framePayloads(events.slice(episodeEnd + 1));

    expect(terminalFrame.simTick).toBeGreaterThan(1);
    expect(postTerminalFrames[0].simTick).toBe(1);
    expect(postTerminalFrames[0].svg).not.toBe(terminalFrame.svg);
    for (let i = 1; i < postTerminalFrames.length; i++) {
      expect(postTerminalFrames[i].svg).not.toBe(postTerminalFrames[i - 1].svg);
    }

    const reconnectEvents = await readSseUntil(
      port,
      (entries) => entries.some((entry) => entry.event === 'meta') && entries.some((entry) => entry.event === 'frame'),
      true,
    );
    const meta = JSON.parse(reconnectEvents.find((entry) => entry.event === 'meta')!.data) as PreviewMetaPayload;
    expect(meta.episode).toBe(2);
  }, 20000);

  it('keeps a finite stream advancing beyond its first reset', async () => {
    const server = startServer([
      '--map',
      'maps/bonk_WDB__No_Mapshake__716916.json',
      '--ticks',
      '55',
      '--fps',
      '100',
      '--port',
      '0',
    ]);
    const port = await waitForServerPort(server);
    const events = await readSseUntilDone(port);
    const episodeEnd = events.findIndex((entry) => entry.event === 'episode-end');
    expect(episodeEnd).toBeGreaterThanOrEqual(0);

    const postTerminalFrames = framePayloads(events.slice(episodeEnd + 1));
    expect(postTerminalFrames[0].simTick).toBe(1);
    expect(postTerminalFrames.at(-1)!.svg).not.toBe(postTerminalFrames[0].svg);
    expect(await server.waitForExit()).toBe(0);
  }, 20000);
});

describe('preview-server SSE shutdown', () => {
  it('delivers done to a held-open client and still exits', async () => {
    const server = startServer(['--ticks', '6', '--fps', '2', '--port', '0']);
    const port = await waitForServerPort(server);
    const events = await readSseUntilDone(port);

    expect(events.some((entry) => entry.event === 'meta')).toBe(true);
    expect(events.filter((entry) => entry.event === 'frame').length).toBeGreaterThanOrEqual(1);
    const doneIndex = events.findIndex((entry) => entry.event === 'done');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBe(events.length - 1);

    // The client socket is still open here; the server must exit on its own.
    expect(await server.waitForExit()).toBe(0);
  }, 20000);

  it('rejects a non-positive fps with a clear CLI error', async () => {
    const server = startServer(['--ticks', '1', '--fps', '0', '--port', '0']);
    expect(await server.waitForExit()).toBe(1);
    expect(server.stderrText()).toMatch(/expected a positive number/);
  }, 20000);
});
interface HealthySseClient {
  frames: Array<{ tick: number; svg: string }>;
  close(): void;
}

/** Open /frames and continuously drain it, recording every complete frame. */
async function openSseReader(port: number): Promise<HealthySseClient> {
  const res = await fetch(`http://127.0.0.1:${port}/frames`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ tick: number; svg: string }> = [];
  let buffer = '';
  let closed = false;
  const pump = async (): Promise<void> => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split === -1) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event:\s*(\S+)/m.exec(block)?.[1];
        const data = /^data:\s*(.*)$/m.exec(block)?.[1] ?? '';
        if (event === 'frame') {
          try {
            frames.push(JSON.parse(data) as { tick: number; svg: string });
          } catch {
            // Ignore malformed payloads.
          }
        }
      }
    }
  };
  pump().catch(() => {});
  return {
    frames,
    close: () => {
      closed = true;
      void reader.cancel().catch(() => {});
    },
  };
}

describe('preview-server SSE backpressure', () => {
  it('drops then evicts a non-draining client while a healthy client still gets every frame', async () => {
    const server = startServer(['--ticks', '0', '--fps', '100', '--port', '0']);
    const port = await Promise.race([
      server.waitForPort(),
      server
        .waitForExit()
        .then((code) =>
          Promise.reject(new Error(`Server exited before listening (code ${code}): ${server.stderrText()}`)),
        ),
    ]);

    const healthy = await openSseReader(port);
    await new Promise((r) => setTimeout(r, 400));
    expect(healthy.frames.length).toBeGreaterThan(5);

    // Non-draining client: a raw TCP connection to /frames that never reads,
    // simulating a throttled/backgrounded tab. With no 'data' listener the
    // socket stays paused, so the kernel receive buffer fills, the TCP window
    // closes, and the server's write() must return false — backpressure is
    // guaranteed by construction on any host, regardless of CI load.
    const stalled = connect({ port, host: '127.0.0.1' });
    stalled.setNoDelay(true);
    stalled.write(
      `GET /frames HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`,
    );
    const stalledStart = Date.now();

    // Arm sever-detection BEFORE any waiting so eviction is observed whenever
    // it fires — during the plateau wait or the grace sleep alike. Only
    // terminal-event listeners go on now: adding a 'data' listener would set
    // the socket flowing and defeat the backpressure under test.
    const severed = new Promise<boolean>((resolve) => {
      const settled = (): void => resolve(true);
      stalled.once('end', settled);
      stalled.once('close', settled);
      stalled.once('error', settled);
    });

    // Wait (adaptively, not with a blind sleep) until the server's deliveries
    // actually stall: `bytesRead` stops growing once its write() backs up, so
    // a plateau with no new bytes proves the backpressure condition was
    // genuinely reached on this host.
    let plateauAt: number | null = null;
    let lastBytes = -1;
    let stablePolls = 0;
    while (Date.now() - stalledStart < 25000) {
      const received = stalled.bytesRead;
      if (received === lastBytes && received > 0) {
        stablePolls += 1;
        if (stablePolls >= 4) {
          plateauAt = Date.now();
          break;
        }
      } else {
        stablePolls = 0;
      }
      lastBytes = received;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(plateauAt).not.toBeNull();

    // Give the 5s eviction grace window time to elapse after the stall.
    await new Promise((r) => setTimeout(r, 6000));

    // Now start consuming the socket: the buffered burst flushes and the
    // eviction FIN/RST surfaces as 'end'/'close'/'error' on the promise armed
    // before the waits — whether the sever fired during them or fires now.
    stalled.on('data', () => {});
    let fallback!: ReturnType<typeof setTimeout>;
    const severedObserved = await Promise.race([
      severed,
      new Promise<boolean>((resolve) => {
        fallback = setTimeout(() => resolve(false), 20000);
      }),
    ]);
    clearTimeout(fallback);
    expect(severedObserved).toBe(true);

    // Severance must come from the eviction path, not from the preview
    // server dying: only a still-running server can satisfy this test. The
    // sentinel is a string because Node's exit code is null on signal death,
    // which must also count as "the server died".
    const exited = await Promise.race([
      server.waitForExit(),
      new Promise<'alive'>((r) => setTimeout(() => r('alive'), 250)),
    ]);
    expect(exited).toBe('alive');

    const stalledBytes = stalled.bytesRead;
    expect(stalledBytes).toBeGreaterThan(0);
    // Only the finite socket-buffer burst ever reached the stalled client,
    // never the full stream the healthy client received over the same window.
    const healthyBytes = healthy.frames.reduce((sum, f) => sum + f.svg.length, 0);
    expect(stalledBytes).toBeLessThan(healthyBytes);

    // A draining client keeps receiving frames in order while the stalled
    // client's frames are being dropped and its socket severed.
    const ticks = healthy.frames.map((f) => f.tick);
    expect(ticks.length).toBeGreaterThan(60);
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }

    stalled.destroy();
    healthy.close();
  }, 60000);
});
