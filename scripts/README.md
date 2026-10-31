# Scripts

Shell scripts, PowerShell scripts, and CLI tools for managing Bonk.io RL Environment servers across Unix/macOS/Linux and Windows platforms. Includes quick-start convenience scripts, detailed server management utilities, and the DSP (Data Structure Protocol) CLI for codebase graph management.

## Files

| File                          | Platform             | Purpose                                                                                              |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `start.sh`                    | Unix/macOS/Linux     | Quick start — launches the server with default settings                                              |
| `start.bat`                   | Windows              | Quick start — launches the server with default settings                                              |
| `start-server.sh`             | Unix/macOS/Linux     | Detailed server start with port and configuration options                                            |
| `stop-server.sh`              | Unix/macOS/Linux     | Stop a running Bonk RL server                                                                        |
| `test-server-exit.sh`         | Unix/macOS/Linux     | Test server exit behavior and cleanup                                                                |
| `Start-BonkServer.ps1`        | Windows (PowerShell) | Start the Bonk RL server                                                                             |
| `Stop-BonkServer.ps1`         | Windows (PowerShell) | Stop a running Bonk RL server                                                                        |
| `local-ci.ts`                 | Cross-platform       | Master local CI/CD engine (8 verification domains, 4 tiers)                                          |
| `local-ci.sh`                 | Unix/macOS/Linux     | Bash entry point forwarding flags to `local-ci.ts`                                                   |
| `Invoke-LocalCI.ps1`          | Windows (PowerShell) | PowerShell entry point forwarding flags to `local-ci.ts`                                             |
| `ci-bench-check.ts`           | Cross-platform       | Benchmark regression checker — runs Layers 1–6 and enforces SLA thresholds                           |
| `format.ts`                   | Cross-platform       | Prettier check/write scoped to changed (or staged) files                                             |
| `check-webscript-ids.js`      | Cross-platform       | Validates Webscript DOM selectors against retained fixtures                                          |
| `verify-heavy-flip-probe.js`  | Cross-platform       | Offline harness for `Webscripts/heavy-flip-probe.user.js` (hook, flip cadence, teardown)             |
| `extract-bonk-map.ts`         | Cross-platform       | Extract a native Bonk.io map (envelope/payload/PSON/JSON) into engine-loadable NativeMap JSON        |
| `scrape-bonk-maps.ts`         | Cross-platform       | Scrape thousands of Bonk.io community maps into engine-loadable NativeMap JSON (resumable)           |
| `verify-mapexporter-fixes.js` | Cross-platform       | Source-level regression harness for `Webscripts/mapexporter.js` (contract keys, hooks, output shape) |
| `verify-mapexporter-e2e.js`   | Cross-platform       | Offline E2E harness for the mapexporter userscript (vm sandbox, state hook, export button, download) |
| `dsp-cli.py`                  | Cross-platform       | Data Structure Protocol CLI for managing the `.dsp/` graph                                           |

## Usage

### Local CI/CD Engine

The master engine (`local-ci.ts`) runs every verification domain before commits and pushes:

```bash
# Tier 1 (pre-commit): staged-file prettier, webscript IDs, ruff, tsc, unit tests
npm run ci:quick

# Tier 2 (pre-push): branch-scoped prettier, all Vitest suites, pytest, typecheck
npm run ci

# Tier 3: Tier 2 + live ZeroMQ E2E integration suite
npm run ci:full

# Tier 4: Layer 1-6 benchmarks with SLA regression enforcement
npm run ci:bench

# Format the branch's changed files
npm run format:fix
```

PowerShell and bash entry points forward the same flags:

```powershell
.\scripts\Invoke-LocalCI.ps1 --quick
```

```bash
./scripts/local-ci.sh --standard --verbose
```

### Unix/macOS/Linux

```bash
# Make scripts executable
chmod +x start.sh start-server.sh stop-server.sh test-server-exit.sh

# Quick start (default settings)
./start.sh

# Start with options (e.g. custom port)
./start-server.sh --port 8080

# Stop the server
./stop-server.sh

# Test exit behavior
./test-server-exit.sh
```

### Windows

```batch
:: Quick start (default settings)
start.bat
```

```powershell
# Start the server (PowerShell)
.\Start-BonkServer.ps1

# Stop the server (PowerShell)
.\Stop-BonkServer.ps1
```

## Map Extractor

`extract-bonk-map.ts` decodes a native Bonk.io map in any supported representation — a five-field
envelope (`dbv,name,author,id,payload`), a database payload, a legacy payload, a PSON payload, raw
Base64 database binary, or existing NativeMap JSON — into validated NativeMap JSON the engine loads
via `mapPath` / `mapData`. Use it to check map parity between the original client and this engine.

```bash
# Extract a map (auto-detects the input format) and verify it loads in the engine
npx tsx scripts/extract-bonk-map.ts --in <path-or-literal> --verify

# Write to a specific path and print a JSON summary
npx tsx scripts/extract-bonk-map.ts --in maps/bonk_Simple_1v1_123.json --out maps/simple.json --json
```

The regression suite `tests/unit/extract-bonk-map.test.ts` round-trips all 288 unique built-in map
envelopes from the committed corpus through the extractor and the engine's native map session.

## Map Scraper

`scrape-bonk-maps.ts` bulk-collects community maps from the same public endpoints the game client
calls (search, hotmaps picks, fresh), decodes each `leveldata` payload with the strict native map
codec, stamps server metadata (name/author/dbid/date/votes), and writes validated NativeMap JSON.
Output goes to `.local-artifacts/scraped-maps` (gitignored) with a resumable manifest.

```bash
# Default: picks.txt (~989 curated maps) + 10 common-char search queries, 1000-map limit
npx tsx scripts/scrape-bonk-maps.ts

# Larger runs: more queries, higher limit
npx tsx scripts/scrape-bonk-maps.ts --limit 5000 --queries a,e,i,o,u,s,t,n,r,l,1,2,3

# Just the curated picks in one request
npx tsx scripts/scrape-bonk-maps.ts --queries a --no-picks --limit 989

# Include the fresh window and print JSON summary
npx tsx scripts/scrape-bonk-maps.ts --fresh --json

# Spread requests across many egress IPs (one proxy per line; each gets its
# own per-IP rate budget and the pool fails over to a healthy lane on ban)
npx tsx scripts/scrape-bonk-maps.ts --proxies proxies.txt --limit 5000
```

The endpoints rate-limit by **source IP** with a rolling request budget; a `ratelimited` response bans
the IP for several minutes, and re-probing during a ban extends it. The scraper sends the same
browser-like headers the game client sends, paces requests with `--delay` (default 700 ms), and on
`ratelimited` waits out a `--cooldown` (default 180000 ms) instead of erroring, rotating the
User-Agent across retries (`--max-retries`, default 12). The ban expiry is persisted in the manifest,
so a resumed run waits out an active ban rather than re-tripping it. There is no header trick that
bypasses the per-IP budget, but `--proxies <file>` scales around it: each proxy (or `direct`) is a
lane with its own budget, so throughput scales with lane count and a banned lane is skipped while
others serve. Proxy file format: one `http://[user:pass@]host:port`, `socks5://host:port`, or
`direct` per line, `#` comments allowed. Maps that fail strict codec validation are counted and
reported, never written. Engine-load failures (gear joints, spawn-less maps, degenerate polygons)
are the same pre-existing coverage limits as the committed corpus, not scraper errors.

## DSP CLI

The Data Structure Protocol CLI manages the `.dsp/` graph — a dependency graph of project entities (modules, functions, exports, imports).

```bash
# Initialize the .dsp/ directory
python scripts/dsp-cli.py --root . init

# Search for entities by keyword
python scripts/dsp-cli.py --root . search "server"

# Read the table of contents
python scripts/dsp-cli.py --root . read-toc

# Get project graph statistics
python scripts/dsp-cli.py --root . get-stats
```

> **Note:** The DSP CLI was previously located at the project root (`dsp-cli.py`). It is now at `scripts/dsp-cli.py`. All examples in project documentation use the `scripts/` path.

## Environment Variables

| Variable | Default | Description                    |
| -------- | ------- | ------------------------------ |
| `PORT`   | `5555`  | The port the server listens on |
