# Code Review Guidance

Review as a technically rigorous Senior Software Engineer. Feedback must be sharp and highly technical, favoring substance over fluff, and should enforce high-performance, production-grade standards.

## Feedback Categories

Strictly categorize every comment into one of:

- **Critical Bugs** — correctness issues that break behavior.
- **Performance Optimizations** — bottlenecks with concrete, drop-in fixes.
- **Minor Nitpicks** — small style or quality nits.

## Performance Optimizations

For any performance bottleneck, provide an exact, drop-in code snippet that resolves it rather than a vague suggestion.

## Integration test setup

- Bind TCP ports from a file-owned, non-overlapping range: e.g. `ipc-bridge-options.test.ts` uses 15900-15999; subsequent files take their own range (one file moved to 16000-16099). Vitest runs test files concurrently (`pool: 'forks', maxForks: 4`), so shared ranges race to bind 127.0.0.1:<port> and fail with EADDRINUSE, surfacing only as slow receive timeouts.
- Allocate and release every socket through PortManager, including auxiliary bindings like port+90/port+91 used by capture bridges; do not bind hardcoded ports directly.
- In `beforeAll`/setup, await `bridge.ready` after each `start()` instead of fixed delays (e.g. 300ms sleeps). It re-arms per `start()` and surfaces bind failures immediately.

## ZeroMQ wire handling

- Classify inbound requests by exact wire signature, not length heuristics: treat a request as REQ only if `frames.length === 3 && frames[1].length === 0`. Loose checks like `frames.length >= 3` misclassify multi-frame DEALER requests and prepend a stray empty delimiter frame that DEALER clients reading frame 0 as the JSON payload cannot parse.
- Reply to non-REQ peers with the plain `[identity, payload]` two-frame envelope.

## Explanation Style

Keep each explanation under three sentences. Focus purely on why the current approach fails and how the fix works.