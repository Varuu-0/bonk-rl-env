/**
 * Validate free proxies against the real bonk2.io endpoint and write the
 * working ones to a proxy file for scripts/scrape-bonk-maps.ts --proxies.
 *
 * Fetches the iplocate/free-proxy-list all-proxies.txt, then tests each proxy
 * with a real map_getsearch POST (small page) through undici's ProxyAgent,
 * with a short timeout and bounded concurrency. Writes
 * .local-artifacts/working-proxies.txt (one URL per line) plus a stats line.
 *
 * Usage:
 *   npx tsx scripts/validate-proxies.ts [--input <file|url>] [--out <file>]
 *                                       [--concurrency <n>] [--timeout <ms>]
 *                                       [--max <n>] [--target <n>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProxyAgent, type Dispatcher } from 'undici';

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt';
const TEST_URL = 'https://bonk2.io/scripts/map_getsearch.php';
const FORM = new URLSearchParams({
  searchsort: 'newest',
  searchstring: 'e',
  searchmapname: 'true',
  searchauthor: 'false',
  startingfrom: '0',
}).toString();

interface Opts {
  input: string;
  out: string;
  concurrency: number;
  timeoutMs: number;
  max: number;
  target: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    input: DEFAULT_SOURCE,
    out: '.local-artifacts/working-proxies.txt',
    concurrency: 100,
    timeoutMs: 8000,
    max: 0,
    target: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[++i];
    if (a === '--input') o.input = v!;
    else if (a === '--out') o.out = v!;
    else if (a === '--concurrency') o.concurrency = Number(v);
    else if (a === '--timeout') o.timeoutMs = Number(v);
    else if (a === '--max') o.max = Number(v);
    else if (a === '--target') o.target = Number(v);
    else i--; // unknown flag: rewind the value consume
  }
  return o;
}

async function loadList(input: string): Promise<string[]> {
  let text: string;
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`fetch ${input}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = fs.readFileSync(input, 'utf8');
  }
  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(l) ? l : `http://${l}`));
  return [...new Set(urls)];
}

/** Build the right dispatcher for a proxy URL scheme. SOCKS agents are loaded
 * via a file:// URL to the ESM entry (socks-proxy-agent is ESM-only; tsx's CJS
 * transform turns a bare dynamic import into an empty-namespace require). */
async function dispatcherFor(url: string): Promise<Dispatcher> {
  if (/^socks/i.test(url)) {
    const entry = pathToFileURL(path.join('node_modules', 'socks-proxy-agent', 'dist', 'index.js')).href;
    const { SocksProxyAgent } = (await import(entry)) as { SocksProxyAgent: new (u: string) => Dispatcher };
    return new SocksProxyAgent(url);
  }
  return new ProxyAgent(url);
}

/** Test one proxy: resolve true only if it returns a real success payload. */
async function testProxy(url: string, timeoutMs: number): Promise<boolean> {
  const agent = await dispatcherFor(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Origin: 'https://bonk.io',
        Referer: 'https://bonk.io/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: FORM,
      dispatcher: agent,
      signal: controller.signal,
    } as RequestInit);
    if (!res.ok) return false;
    const json = (await res.json()) as { r?: string; maps?: unknown[] };
    return json.r === 'success' && Array.isArray(json.maps);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    (agent as { close?: () => void }).close?.();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let list = await loadList(opts.input);
  if (opts.max > 0) list = list.slice(0, opts.max);
  console.log(`testing ${list.length} proxies (concurrency=${opts.concurrency}, timeout=${opts.timeoutMs}ms)`);

  const working: string[] = [];
  let done = 0;
  let index = 0;
  const started = Date.now();

  async function worker(): Promise<void> {
    while (index < list.length) {
      if (opts.target > 0 && working.length >= opts.target) return;
      const url = list[index++]!;
      const ok = await testProxy(url, opts.timeoutMs);
      done++;
      if (ok) {
        working.push(url);
        console.log(`  [${working.length}] WORKING ${url}`);
      }
      if (done % 100 === 0) {
        const rate = (done / ((Date.now() - started) / 1000)).toFixed(1);
        console.log(`  ... ${done}/${list.length} tested, ${working.length} working (${rate}/s)`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, list.length) }, () => worker());
  await Promise.all(workers);

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${working.join('\n')}\n`, 'utf8');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${working.length}/${list.length} working in ${secs}s -> ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(`validate-proxies: ${e}`);
  process.exit(1);
});
