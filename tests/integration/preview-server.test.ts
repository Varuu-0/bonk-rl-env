/**
 * preview-server.test.ts — SSE settle behavior of the live preview server.
 *
 * Spawns the real dev server as a child process and asserts the two contracts
 * the Kilo review flagged:
 *   1. `done` must reach a connected client before the process exits (it is
 *      buffered behind the final frame, so shutdown must give it time to
 *      flush), and the exit must be deterministic even when the client holds
 *      the SSE socket open.
 *   2. A non-positive `--fps` value must fail fast with a clear CLI error.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';

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

interface SseEvent {
  event: string;
  data: string;
}

/** Connect to /frames, buffer until the `done` event, and keep the socket open
 *  (a stalled client) so the server must exit via its flush deadline. */
async function readSseUntilDone(port: number): Promise<SseEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/frames`);
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
    if (events.some((entry) => entry.event === 'done')) break;
  }
  return events;
}

describe('preview-server SSE shutdown', () => {
  it('delivers done to a held-open client and still exits', async () => {
    const server = startServer(['--ticks', '6', '--fps', '2', '--port', '0']);
    const port = await Promise.race([
      server.waitForPort(),
      server
        .waitForExit()
        .then((code) =>
          Promise.reject(new Error(`Server exited before listening (code ${code}): ${server.stderrText()}`)),
        ),
    ]);
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

/** Parse a chunk of SSE bytes and return the number of complete `frame` events
 *  it contains. */
function countSseFrames(chunk: Uint8Array): number {
  const text = new TextDecoder().decode(chunk);
  return (text.match(/event:\s*frame/g) ?? []).length;
}

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
  it('drops and then evicts a non-draining client while a healthy client still gets every frame', async () => {
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

    // Non-draining client: connects to /frames but never reads the body,
    // simulating a throttled/backgrounded tab.
    const stalled = await fetch(`http://127.0.0.1:${port}/frames`);
    const stalledReader = stalled.body!.getReader();

    // Let the server stream for longer than the 5s eviction grace period
    // before touching the stalled socket.
    await new Promise((r) => setTimeout(r, 6200));

    let stalledFrames = 0;
    let stalledState: 'ended' | 'error' | 'open' = 'open';
    try {
      for (;;) {
        const { done, value } = await stalledReader.read();
        if (done) {
          stalledState = 'ended';
          break;
        }
        stalledFrames += countSseFrames(value);
      }
    } catch {
      stalledState = 'error';
    }

    // The stalled connection must have been severed by the server rather than
    // retained forever.
    expect(stalledState).not.toBe('open');
    // Frames were coalesced, not buffered without bound: the stalled client
    // only ever saw the pre-backpressure burst, far fewer than the frames the
    // healthy client received over the same window.
    expect(stalledFrames).toBeLessThan(healthy.frames.length);

    // A draining client keeps receiving frames with no gaps while the
    // stalled client's frames are being dropped.
    const ticks = healthy.frames.map((f) => f.tick);
    expect(ticks.length).toBeGreaterThan(60);
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]).toBe(ticks[i - 1] + 1);
    }

    healthy.close();
  }, 60000);
});
