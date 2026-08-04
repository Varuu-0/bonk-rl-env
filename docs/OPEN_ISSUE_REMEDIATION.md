# Open Issue Remediation Tracker

Tracks the August 2026 audit and remediation of every issue that was open when
this effort began. Issue claims are treated as reports, not facts: dispositions
below are based on current `main`, tests, the installed Box2D port, and the
source-proven findings in `docs/DEOBFUSCATION.md`.

**Audit date:** 2026-08-03  
**Initial scope:** 134 open issues (`#27`-`#161`, excluding already-closed `#153`)  
**Baseline:** `68bc46d`  
**Primary prior remediation:** PR [#166](https://github.com/Varuu-0/bonk-rl-env/pull/166)

## Status Legend

| Status | Meaning |
|---|---|
| Fix | Reproduced or structurally proven; code/test PR required |
| Hardening | The reported impact is overstated, but a low-risk correctness improvement is justified |
| Duplicate | Same root cause as the listed canonical issue |
| Fixed | Current `main` already contains the fix and regression coverage |
| Not a bug | Current code, API semantics, or empirical evidence refutes the report |
| Feature | Requested behavior is outside the current documented contract |

## Workstreams

| Workstream | Canonical issues | Status | Pull request |
|---|---|---|---|
| Worker failure and timeout recovery | #61, #64, #89, #101, #102, #114, #118, #132, #136, #141 | Agent implementation in progress | Pending |
| Worker protocol hardening | #125, #148, #149 | Agent implementation in progress | Pending |
| Observation ownership | #67, #92, #109, #121 | Agent implementation in progress | Pending |
| Python client contracts | #58, #91, #96, #111, #116, #135 | Agent implementation in progress | Pending |
| PRNG integer correctness | #57, #93 and tracker R3M6 | Agent implementation in progress | Pending |
| Physics reset safety and force point | #49, #77, #146 | Agent implementation in progress | Pending |
| Shared-memory false-sharing performance | #137, #139 | Awaiting benchmark/design review | Pending |
| TPS and determinism documentation | #44, #99, #157 | Planned | Pending |
| Issue closure comments | Duplicates, fixed reports, and refuted reports | Planned after PR review | N/A |

## Audit Matrix

The `PR` column names the workstream that owns the issue. A workstream PR may
close several duplicate reports with one root-cause fix. `#153` is intentionally
absent because GitHub already records it as closed.

| Issue | Disposition | PR / evidence |
|---:|---|---|
| #27 | Not a bug | Atomics wait loop reloads and is time-bounded |
| #28 | Not a bug | Per-environment PRNG state is schedule-independent |
| #29 | Fixed | PR #166; Python and TS observation shapes agree |
| #30 | Not a bug | Worker listeners are released with worker references |
| #31 | Not a bug | Main process exit terminates worker threads |
| #32 | Not a bug | Intentional autoreset preserves terminal observation in `info` |
| #33 | Hardening | Worker protocol; canonical #149 |
| #34 | Not a bug | Frame skip does not alter PRNG draw count per tick |
| #35 | Fixed | Reset and frame-cycle logic clear terminal state |
| #36 | Fixed | Native 2/6 solver request implemented; port limitation documented |
| #37 | Not a bug | Correct wait/reload loop; performance claim unproven |
| #38 | Fixed | Native cap-zone event lifecycle implemented in PR #166 |
| #39 | Not a bug | `next()` and `nextInt()` use the same canonical state transition |
| #40 | Not a bug | Temporary force vector is instance-local and synchronous |
| #41 | Fixed | Player angular velocity index is present in Python mapping |
| #42 | Duplicate | Physics reset safety; canonical #49/#77 |
| #43 | Fixed | Current reward path has no TS/Python division mismatch |
| #44 | Fix | Documentation workstream; stale 15/30/60 and 60 TPS prose remains |
| #45 | Not a bug | Installed Box2D destroys attached joints before bodies |
| #46 | Not a bug | Sequential `for await` request handling preserves response order |
| #47 | Not a bug | Warmup/mixing is not required by canonical Mulberry32 |
| #48 | Duplicate | Worker protocol; canonical #149 |
| #49 | Fix | Physics reset safety |
| #50 | Fixed | Step counter atomically increments by one |
| #51 | Not a bug | Seedless autoreset intentionally continues deterministic stream |
| #52 | Not a bug | Result-ready atomic gates observation reads |
| #53 | Not a bug | Seed-zero/warmup claim empirically refuted |
| #54 | Duplicate | Timeout recovery; canonical #141 |
| #55 | Fixed | Backend emits explicit terminated and truncated arrays |
| #56 | Not a bug | Typed-array offsets are correctly aligned |
| #57 | Fix | PRNG integer correctness; canonical integer-range bias report |
| #58 | Fix | Python client contracts |
| #59 | Not a bug | Atomics gate payload visibility on supported JS engines |
| #60 | Not a bug | Add/notify plus reload loop cannot lose a completion |
| #61 | Fix | Worker failure and timeout recovery |
| #62 | Not a bug | Warmup claim refuted by canonical sequence |
| #63 | Not a bug | Both sides pass angular velocity in radians per second |
| #64 | Fix | Worker failure and timeout recovery |
| #65 | Not a bug | `Atomics.wait` returns `not-equal` on the alleged race |
| #66 | Not a bug | 32-bit integer division by 2^32 is exactly representable |
| #67 | Fix | Observation ownership |
| #68 | Not a bug | Every observation slot is overwritten before publication |
| #69 | Not a bug | Command notification follows payload writes |
| #70 | Fixed | Contract boundary separates terminated and truncated |
| #71 | Not a bug | Terminal tick PRNG consumption is deterministic |
| #72 | Fixed | `close()` awaits worker termination before disposal |
| #73 | Fixed | Explicit `reset(seed)` reseeds the environment |
| #74 | Fixed | Terminal observation is transported through `info` |
| #75 | Not a bug | Increment-then-mix matches canonical Mulberry32 |
| #76 | Not a bug | Result publication occurs after payload writes |
| #77 | Fix | Physics reset safety |
| #78 | Fixed | Profiler wrappers preserve `this` binding |
| #79 | Not a bug | Raw seed is canonical and preserves reproducibility |
| #80 | Not a bug | Callback map is owned by one Node event loop |
| #81 | Not a bug | Current API and native physics both use radians |
| #82 | Not a bug | Claimed Box2D accumulator does not exist |
| #83 | Fixed | Worker waits block instead of busy-spin |
| #84 | Not a bug | Reward documentation and implementation signatures agree |
| #85 | Fixed | Wait loop rechecks after every wake |
| #86 | Not a bug | Claimed Uint16 sequence counter does not exist |
| #87 | Fixed | Terminal reward is counted once under frame skip |
| #88 | Fixed | Explicit reset seeds are forwarded and applied |
| #89 | Fix | Worker failure and timeout recovery |
| #90 | Not a bug | Infinite bounds honestly represent unbounded velocity channels |
| #91 | Fix | Python client contracts |
| #92 | Fix | Observation ownership |
| #93 | Fix | PRNG integer correctness |
| #94 | Not a bug | Completion counter resets every batch |
| #95 | Not a bug | Physics engines and temporary vectors are worker-local |
| #96 | Fix | Python client contracts |
| #97 | Duplicate | Physics reset safety; canonical #49/#77 |
| #98 | Not a bug | Shared-memory offsets are aligned by construction |
| #99 | Fix | Documentation workstream; native rate is deobfuscated as 30 TPS |
| #100 | Not a bug | Counter value, not notification count, controls completion |
| #101 | Fix | Worker failure and timeout recovery |
| #102 | Fix | Worker failure and timeout recovery |
| #103 | Not a bug | In-repository callers serialize step and reset operations |
| #104 | Not a bug | Reward is calculated and returned on every physics tick |
| #105 | Duplicate | Refuted temporary-vector claim; canonical #95 |
| #106 | Hardening | PRNG uint32 normalization; report's cross-engine claim is refuted |
| #107 | Not a bug | ECMAScript Atomics provide the synchronization point |
| #108 | Not a bug | No Python conversion changes angular-velocity units |
| #109 | Fix | Observation ownership |
| #110 | Not a bug | Timeout and success paths both delete callback entries |
| #111 | Fix | Python client contracts |
| #112 | Duplicate | Physics reset safety; canonical #49/#77 |
| #113 | Not a bug | View lengths and padding cannot overflow adjacent regions |
| #114 | Fix | Worker failure and timeout recovery |
| #115 | Not a bug | Seed zero produces a varied canonical sequence |
| #116 | Fix | Python client contracts |
| #117 | Not a bug | Worker-local buffers are copied before yielding |
| #118 | Fix | Worker failure and timeout recovery |
| #119 | Duplicate | Physics reset safety; canonical #49/#77 |
| #120 | Duplicate | Refuted callback-map claim; canonical #80 |
| #121 | Fix | Observation ownership |
| #122 | Duplicate | PRNG integer correctness; canonical #93 |
| #123 | Hardening | PRNG uint32 normalization; reported nondeterminism is refuted |
| #124 | Not a bug | All 64 independent six-bit action combinations are valid |
| #125 | Fix | Worker protocol hardening |
| #126 | Not a bug | Potential shaping uses canonical gamma*Phi(next)-Phi(current) |
| #127 | Fixed | Session-scoped Python/backend close implemented in PR #166 |
| #128 | Not a bug | Terminated and truncated flags are not swapped |
| #129 | Fixed | Physics reset clears tick count |
| #130 | Not a bug | Proposed JS acquire/release API does not exist |
| #131 | Not a bug | Death transition is rewarded once |
| #132 | Fix | Worker failure and timeout recovery |
| #133 | Fixed | Step failures propagate instead of returning null results |
| #134 | Feature | Current 14-value contract intentionally exposes one opponent |
| #135 | Fix | Python client contracts |
| #136 | Fix | Worker failure and timeout recovery |
| #137 | Fix | Shared-memory false-sharing performance review |
| #138 | Feature | Opponent angular velocity is outside current observation contract |
| #139 | Fix | Shared-memory false-sharing performance review |
| #140 | Not a bug | Canonical Mulberry32 does not require warmup |
| #141 | Fix | Worker failure and timeout recovery |
| #142 | Fixed | Dedicated terminal-observation SAB region is implemented |
| #143 | Duplicate | Worker timeout recovery; canonical #141 |
| #144 | Fixed | Truncated flag is transported end-to-end |
| #145 | Duplicate | Refuted warmup claim; canonical #140 |
| #146 | Hardening | Physics reset/native force-point alignment |
| #147 | Duplicate | PRNG integer correctness; canonical #93 |
| #148 | Fix | Worker protocol hardening |
| #149 | Fix | Worker protocol hardening |
| #150 | Duplicate | Worker timeout recovery; canonical #141 |
| #151 | Not a bug | Raw-state initialization is canonical Mulberry32 |
| #152 | Feature | Opponent rotation is outside the consistent current schema |
| #154 | Duplicate | Worker protocol; canonical #149 |
| #155 | Not a bug | Explicit reset seeds rewind PRNG state |
| #156 | Fixed | Arena bounds occupy slots 13 and 14 in both modes |
| #157 | Fix | Documentation workstream; bound determinism claim to explicit seeds |
| #158 | Duplicate | Worker timeout recovery; canonical #141 |
| #159 | Not a bug | Discrete action index is the six-bit action mask |
| #160 | Not a bug | Seed zero does not produce a constant sequence |
| #161 | Duplicate | Worker protocol; canonical #148 |

## Closure Policy

1. A fix issue closes only after its focused PR has tests and is merged.
2. Duplicates close with a comment linking the canonical issue and PR.
3. Fixed reports close with exact current-code/test evidence and PR #166 where applicable.
4. Refuted reports close with a concise mechanism-level explanation; no speculative code is added merely to satisfy an incorrect report.
5. Feature requests remain separate from bug fixes unless the public observation/action contract is deliberately versioned.

## Validation Gate

Each implementation PR must pass its focused tests and `npm run typecheck` when
it touches TypeScript. Before the tracker is marked complete, run the full
TypeScript suite, Python suite, and `git diff --check` on every PR branch.
