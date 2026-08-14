/**
 * M5 — live browser render preview (SSE).
 *
 * Runs a real BonkEnvironment at the native tick rate and streams per-tick SVG
 * frames to an open browser tab over Server-Sent Events. Dev-only: the
 * simulation path is byte-identical to a normal run (the frame builder only
 * pulls already-materialized `getPlayerState`), so nothing here touches the
 * training hot path or the multi-worker profile.
 *
 * Usage:
 *   npx tsx src/render/preview-server.ts [--map path] [--ticks N] [--port P] [--fps N] [--width W] [--height H]
 * then open http://localhost:<port> in a browser.
 *
 * `--ticks 0` (the default) streams until the process is stopped; a positive
 * value broadcasts that many frames and exits (useful for smoke tests).
 */
import * as http from 'http';
import { BonkEnvironment } from '../core/environment';
import { renderEnvFrameSvg } from './render-wiring';
import { parseArgs, parseIntArg, parsePositiveIntArg, resolvePreviewMap } from './preview-shared';

/** One streamed frame. The server keeps only the latest for late joins. */
interface SseFrame {
  tick: number;
  svg: string;
}

const sseClients = new Set<http.ServerResponse>();
let latestFrame: SseFrame | null = null;

const HTML_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bonk-rl-env live preview</title>
<style>
  body { margin: 0; background: #101318; color: #d7dae0; font: 14px/1.45 ui-monospace, Consolas, monospace; }
  header { display: flex; gap: 16px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid #2a2f38; }
  header strong { font-size: 15px; }
  #meta { color: #8aa0b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #stage { padding: 14px; }
  #stage svg { width: 100%; max-width: 1000px; height: auto; display: block; background: #1b2028;
    border: 1px solid #2a2f38; border-radius: 6px; }
  footer { display: flex; gap: 16px; align-items: center; padding: 8px 14px; color: #8aa0b8; }
  #state { color: #6fbf73; }
</style>
</head>
<body>
<header><strong>bonk-rl-env · live preview</strong><span id="meta">connecting…</span></header>
<div id="stage"><div id="state">waiting for frames…</div></div>
<footer><span>tick <b id="tick">–</b></span><button id="pause">pause</button></footer>
<script>
  let es = null;
  const stage = document.getElementById('stage');
  const tickEl = document.getElementById('tick');
  const pauseBtn = document.getElementById('pause');
  let paused = false;

  function connect() {
    if (paused) return;
    es = new EventSource('/frames');
    es.addEventListener('meta', (e) => {
      const m = JSON.parse(e.data);
      document.getElementById('meta').textContent = m.map;
    });
    es.addEventListener('frame', (e) => {
      const f = JSON.parse(e.data);
      stage.innerHTML = f.svg;
      tickEl.textContent = String(f.tick);
    });
    es.addEventListener('done', () => {
      if (es) es.close();
      es = null;
      stage.innerHTML = '<div id="state">stream finished</div>';
    });
    es.onerror = () => { if (es) es.close(); es = null; setTimeout(connect, 1500); };
  }

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'resume' : 'pause';
    if (paused) { if (es) es.close(); es = null; }
    else { stage.innerHTML = '<div id="state">reconnecting...</div>'; connect(); }
  });
  window.addEventListener('beforeunload', () => { if (es) es.close(); });
  connect();
</script>
</body>
</html>`;

function sseSend(res: http.ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event: string, payload: unknown): void {
  for (const res of sseClients) sseSend(res, event, payload);
}

function shutdown(env: BonkEnvironment | null, server: http.Server, code = 0): void {
  if (env) env.close();
  for (const res of sseClients) res.end();
  sseClients.clear();
  server.close(() => process.exit(code));
  // Give the graceful SSE flush (final frame + 'done') a brief window, then
  // exit deterministically even when a connected client never closes.
  const deadline = setTimeout(() => process.exit(code), 500);
  deadline.unref();
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: { width: number; height: number; map: string },
): void {
  const url = req.url ?? '/';
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }
  if (url === '/frames') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('GET only\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sseSend(res, 'meta', { map: deps.map, width: deps.width, height: deps.height });
    if (latestFrame) sseSend(res, 'frame', latestFrame);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = resolvePreviewMap(args.map);
  const width = parseIntArg(args.width, 730, 'width');
  const height = parseIntArg(args.height, 500, 'height');
  const port = parseIntArg(args.port, 8080, 'port');
  const fps = parsePositiveIntArg(args.fps, 30, 'fps'); // native sim tps is 30 → real time
  const tickCap = parseIntArg(args.ticks, 0, 'ticks'); // 0 = stream until stopped

  const env = new BonkEnvironment({ mapPath: map, numOpponents: 1, randomOpponent: false, seed: 42 });
  const deps = { width, height, map };

  const server = http.createServer((req, res) => handleRequest(req, res, deps));
  server.on('error', (e) => { console.error(e); shutdown(env, server, 1); });
  server.listen(port, () => {
    const bound = server.address();
    const boundPort = typeof bound === 'object' && bound ? bound.port : port;
    console.log(`bonk-rl-env live preview → http://localhost:${boundPort}  (map=${map}, fps=${fps}, tickCap=${tickCap || '∞'})`);
  });

  const intervalMs = Math.max(1, Math.round(1000 / fps));
  let tick = 0;
  const timer = setInterval(() => {
    // Step the sim normally first, then pull the (already-materialized) state
    // for the frame — exactly the one-shot render path the frame-dump CLI uses.
    env.step(0);
    const svg = renderEnvFrameSvg(env, { width, height, title: `bonk-rl-env live (${map})` });
    latestFrame = { tick, svg };
    broadcast('frame', { tick, svg });
    tick += 1;
    if (tickCap > 0 && tick >= tickCap) {
      clearInterval(timer);
      broadcast('done', { tick });
      console.log(`Streamed ${tick} frames; shutting down.`);
      shutdown(env, server, 0);
    }
  }, intervalMs);

  const onSigint = (): void => {
    clearInterval(timer);
    console.log('\nStopping preview.');
    shutdown(env, server, 0);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
}

main().catch((e) => { console.error(e); process.exit(1); });
