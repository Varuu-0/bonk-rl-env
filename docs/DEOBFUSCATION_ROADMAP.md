# Remaining Alpha2s Deobfuscation Roadmap

**Last updated:** 2026-08-03  
**Authority:** `docs/DEOBFUSCATION.md` section 38 is the authoritative record for the retained 2026-07-29 `alpha2s.js` build; current sidecars and `final-stats.json` supply its detailed producer counts.  
**Scope:** This document is the forward-looking, proof-first work list for source readability. The simulator implementation backlog remains in `docs/DEOBFUSCATION_FIX_TRACKER.md`.

This is not a claim that the original source can be fully recovered. A readable
property-table access is an analysis representation, not proof of the original
symbol name or source structure. Do not replace retained code unless its
correctness can be independently re-derived from `alpha2s.pretty.js`.

## Navigation

1. [Verified Baseline](#1-verified-baseline)
2. [Rules For Every Step](#2-rules-for-every-step)
3. [Stage 0: Freeze And Classify](#3-stage-0-freeze-and-classify)
4. [Stage 1: Strict Dispatcher Extensions](#4-stage-1-strict-dispatcher-extensions)
5. [Stage 2: Dynamic Table Accesses](#5-stage-2-dynamic-table-accesses)
6. [Stage 3: Receiver And Identifier Readability](#6-stage-3-receiver-and-identifier-readability)
7. [Stage 4: Preamble And Stateful Decoders](#7-stage-4-preamble-and-stateful-decoders)
8. [Stage 5: Runtime Evidence](#8-stage-5-runtime-evidence)
9. [Hard Boundaries](#9-hard-boundaries)
10. [Definition Of Done](#10-definition-of-done)
11. [Parallel Research Protocol](#11-parallel-research-protocol)

## 1. Verified Baseline

The following work is complete for the retained build and must remain the
baseline while extending the pipeline.

| Area | Verified result | Evidence |
|---|---:|---|
| Preamble literal capture | 1,731 captures: 1,724 table strings and 7 stateful warm-up primitives | `final-preamble-folds.json`, `audit-preamble.js` |
| Property-name table | 1,724 decoded names | `tables.json` |
| Literal numeric body accesses | 89,199 accounted for | `ast-member-scan.js`, `audit-independent.js` |
| Table-fold-covered accesses | 46,518 | `final-stats.json`, `audit-table-lookup.js` |
| Dotted analysis labels | 31,373 | `final-stats.json` |
| Bracket annotations | 11,298 | `final-stats.json` |
| Out-of-table literals retained | 10 | `final-stats.json` |
| Immutable table folds | 23,852 | `final-folds.json`, `audit-table-lookup.js` |
| Dispatcher-index table folds | 86 of 88 candidates | `final-dispatcher-folds.json` |
| Dispatcher-formula folds | 48 of 207 candidates | `final-formula-folds.json`, `audit-formula-fold.js` |
| Literal operation folds | 1,696 | `final-stats.json` |
| Body decoder/primitive inlines | 5,939; 791 deliberate stateful/setup skips | `final-stats.json` |
| Current readable output SHA-256 | `6AB86E2960E3DB3083089238AEF6CF749636093B64E92FD14F25DAC6455DA65E` | two matching pipeline runs |

All 89,189 in-table literal body accesses have a verified readable
representation. The 10 remaining accesses have an index outside the decoded
table and therefore do not have an invented name.

## 2. Rules For Every Step

| Rule | Requirement |
|---|---|
| Source is immutable | Treat `.deobf/alpha2s.pretty.js` as the evidence target. Do not patch it. |
| Build specificity | A new `alpha2s.js` capture requires a new raw capture, table, callsite analysis, sidecars, audits, and documentation. Never reuse these indices for another build. |
| Independent proof | The producer and an audit must each derive every new transform from the pretty source. `final-stats.json` is not an audit oracle. |
| Provenance closure | Every candidate must have an accepted or retained disposition in a versioned sidecar. Extra, missing, or mismatched records fail the audit. |
| Evaluation order | A dispatcher case cannot replace a call unless argument evaluation, thrown exceptions, and relevant state effects are proven equivalent. |
| Index 47 | Keep every surviving index-47 access bracketed. It must never become `.length`, because packed Array slots can use index 47 as a counter. |
| Alias eligibility | `var x = [arguments]` alone is not property-bag proof. Reject aliases with escaping, dynamic access, enumeration, ambiguous writes, or scalar/counter behavior. |
| Dynamic names | Do not invent names for dynamic or out-of-table accesses. Prefer an exact annotation only when the static value is independently proven. |
| Generated artifact | Regenerate `alpha2s.readable.js`; do not hand-edit it. |

## 3. Stage 0: Freeze And Classify

**Purpose:** Produce small, independently checked censuses before changing any
rewrite rule. This stage has no generated-code substitutions.

| ID | Work item | Current scope | Required output | Exit gate |
|---|---|---:|---|---|
| S0.1 | Formula census | 159 retained `formula_reorders_arguments` cases | Argument-shape, evaluation-risk, wrapper, and selector inventory | Every retained formula sidecar record is classified exactly once |
| S0.2 | Dynamic table census | 1,069 producer candidates; 1,067 narrower independent count documented in `DEOBFUSCATION.md` section 38.4; 88 direct-alias candidates have 86 accepted and 2 retained | Index-expression and carrier-write provenance inventory, including the reason for the two-count universe difference and the direct-alias overlap | Producer and independent census each close under their documented universe, and every direct candidate has a same-universe mapping or an explicit exclusion |
| S0.3 | Receiver census | 11,053 unknown-receiver annotations | Per-function binding, slot, write, escape, enumeration, and dynamic-access dispositions | Every annotation remains attributable to a source property-table index |
| S0.4 | Stateful decoder census | 380 `t8H` and 411 `n6e` intentional skips | Initialization phase, literal/dynamic argument, and state-dependence classification | No skip is silently reclassified as constant |
| S0.5 | Dispatcher census | 1,639 residual occurrences | Call form, selector provenance, literal/nonliteral arguments, and known case status | Counts remain consistent with current baseline |

The output of Stage 0 should be analysis sidecars or reports, not optimistic
rewrites. Its purpose is to establish real yield before adding a producer pass.

## 4. Stage 1: Strict Dispatcher Extensions

**Purpose:** Improve the readable representation of known dispatcher cases
without violating JavaScript evaluation semantics.

### S1.1: Retained formula cases

| Item | Current state | Safe direction | Proof required | Do not do |
|---|---|---|---|---|
| 159 reordered formulas | Every nonliteral rejected case would reorder call arguments if emitted directly | First add exact, generated comments that identify the proven case formula. Consider substitution only with an order-preserving representation. | Factory map, wrapper bindings, selector source, argument evaluation order, side effects, exceptions, exact paired readable AST, and sidecar closure | Directly replace `Q5$` or `w_c` calls with formulas whose operand order differs from the call |
| 1,639 residual dispatcher/selector calls | 438 `w_c`, 379 `Q5$`, 405 `H0n`, 417 `d1M` | Classify and annotate only where selector and case provenance are proven | Per-call wrapper and selector proof; comments must not change code AST nodes | Assume every dispatcher call has a static selector or case |

An order-preserving lowering must be designed and audited before it is enabled.
The existing 48 substitutions remain the standard: they only emit formulas whose
argument-use order matches the original call.

### S1.2: Two interposed dispatcher-index reads

| Site | Current reason retained | Candidate work | Required proof |
|---|---|---|---|
| `S8z[Z9u]` | `t8H` occurs between selector and calculation | Prove the exact interposed sequence cannot affect the numeric dispatcher state, then re-evaluate it in fresh VMs | Non-interference between the stateful decoder and operation dispatcher, including the decoder warm-up effect; exact statement sequence, two matching evaluations, sidecar and independent-audit support |
| `r5E[J6c]` | Same strict-adjacency failure | Same as above | Same as above |

Even if resolved, these sites may only gain a constant index or annotation. They
are not automatically eligible for dotted property emission.

`audit-dynamic-training-residuals.js` localizes `S8z[Z9u]` to renderer emitter
timing and `r5E[J6c]` to scoreboard sorting. Their strict-deobfuscation work is
retained for readability only; neither is a training-environment blocker.

## 5. Stage 2: Dynamic Table Accesses

**Purpose:** Resolve only dynamic indexes that reduce to a constant under a
local, independently verified dataflow proof.

| ID | Residual | Current count | Next proof target | Required safety gate |
|---|---|---:|---|---|
| S2.1 | Complex decoded-table indexes | Exact residual count is deferred until S0.2 proves the overlap between the dynamic and direct-alias candidate universes | Propagate only literal post-fold constants through index expressions and carrier slots | Dispatcher-derived operands additionally require the existing same-statement selector adjacency and two fresh-context evaluations; every carrier write must satisfy the current global-invalid rule; audit rebuilds the value from pristine source |
| S2.2 | Carrier write ambiguity | 78 non-dominating assignments in the table helper census | Classify call-free paths and required interprocedural summaries before considering a more precise proof | Retain the current global-invalid rule unless both producer and audit prove no reachable callee can mutate the slot between write and read |
| S2.3 | `a9M` dynamic data-record reads | 2 global brackets in PIXI particle display coordinates | No training implementation work; retain exact source inventory | `a9M` remains a data record, not a property bag; no dotted rewrite |
| S2.4 | Runtime/loop-dependent indexes | Remainder after S2.1 | Instrument in a later runtime-evidence stage | No static substitution until one constant is proven for every reachable execution |

Stage 1 owns the direct dispatcher rule. Stage 0 must establish whether those
two retained direct reads overlap the Stage 2 carrier universe before any count
is reported. Do not lower the Stage 2 requirements merely because a decoded
table name is known.

### Permanently retained dynamic-access cases

| Case | Count | Reason |
|---|---:|---|
| Index-47 property access | 247 surviving bracketed sites | A dotted `.length` rewrite changes Array semantics |
| Out-of-table literal index | 10 | The property-name table has no value for the index |
| Global dynamic brackets | 4 today | Two PIXI particle reads, renderer emitter timing, and scoreboard sorting; all remain bracketed because their stateful/data-record proof is intentionally incomplete |

## 6. Stage 3: Receiver And Identifier Readability

**Purpose:** Make dataflow easier to follow without pretending to recover lost
original symbols.

| ID | Residual | Current evidence | Allowed result | Required proof |
|---|---|---|---|---|
| S3.1 | Unknown receiver annotations | 11,053 annotations have no globally safe property-bag receiver | More dotted analysis labels or stronger exact annotations | Preserve the existing property-bag admission rule: exactly one `var x = [arguments]` binding, no later assignment/update/loop target, no escape, enumeration, or dynamic access, and no scalar/counter role; a per-function proof may add detail but cannot weaken any condition |
| S3.2 | Other safe-receiver annotations | 245 final annotation decisions | Preserve bracket form where the safety rule requires it | Index-47 and out-of-table protections remain in both producer paths |
| S3.3 | Obfuscated locals, parameters, and functions | 112.4 obfuscated identifier tokens per 100 readable lines | Comment-level role names or explicitly non-original aliases | Role evidence from use/definition dataflow; generated aliases must state that they are analysis names |
| S3.4 | Original source identifiers | No symbol map survives in the bundle | No completion claim | Treat as unrecoverable unless an external, lawful symbol source is acquired |

Per-function proofs are a possible expansion area, not a license to relax the
global property-bag rule. Low-distinct packed slots can hold scalar arguments,
counters, ordinary objects, or property data in different paths.

## 7. Stage 4: Preamble And Stateful Decoders

**Purpose:** Separate cosmetic readability improvements from unsafe attempts to
partially execute stateful bootstrap code.

| ID | Residual | Current state | Safe next step | Boundary |
|---|---|---|---|---|
| S4.1 | Dynamic `U3q`/`w65` calls | Literal preamble calls are complete; dynamic arguments remain | Consider capture only when full source-order bootstrap replay reaches the site and repeated fresh runs prove the decoded result stable for the candidate state | Never pointwise-inline a stateful decoder call or infer stability from a constant argument alone |
| S4.2 | `t8H`/`n6e` skips | 791 total: 380 `t8H`, 411 `n6e` | Extend capture only by replaying from the full preamble bootstrap through the candidate call, or by proving that the call is state-independent | A bounded subsequence replay is invalid; game-dependent calls need runtime evidence |
| S4.3 | Escaped string literal readability | Some preamble literals remain mechanically escaped | Add an AST value-equality pass before changing literal spelling | Preserve exact string values and directive semantics |
| S4.4 | Preamble flattened machines | Data-dependent bootstrap state machines remain | Linearize only paths with static transitions; otherwise add comments | Do not claim recovery of the original statement/loop structure |
| S4.5 | Bootstrap helper names | Resolver, decoder, and dispatcher symbols remain obfuscated | Add role comments only after behavior-specific evidence | Original names are not recoverable from the bundle |

## 8. Stage 5: Runtime Evidence

**Purpose:** Create the evidence that static analysis cannot supply. A runtime
trace is an input to a later proof, not a license to apply a broad rewrite.

| ID | Unknown or blocked area | Why static source is insufficient | Required evidence | Acceptance condition |
|---|---|---|---|---|
| S5.1 | Ten out-of-table property slots | Training triage RESOLVED: all are read-only nested UI/utility accesses, outside classic physics, map codec, and conversion paths | No training-runtime evidence required; retain `audit-out-of-table.js` inventory | Generated access stays unchanged without a source-proven table entry |
| S5.2 | Loop- or game-dependent table indexes | Index value is not source-constant | Instrumented index and receiver traces | Runtime traces may motivate a source proof, but cannot by themselves emit a generated annotation or substitution |
| S5.3 | Game-dependent decoder calls | Decoder state/value depends on execution | Pre-load instrumentation and source-order logs | Replay reproduces the observed decoder sequence and values |
| S5.4 | Shrink arithmetic behind dynamic dispatch | RESOLVED by `audit-training-statics.js`: circle `-0.015` floor 0.5; box `-0.03` floor 1.0 | Optional frame traces confirm the static formula on live shrink maps | Runtime traces cannot independently authorize a generated rewrite |
| S5.5 | `fl` movement-force gate | Reader and arithmetic resolved: `state.ms.fl ? 20 : 12`, scaled by `radius^2` and heavy `0.7` | Capture sessions where server state sets `ms.fl` true | Trace coverage confirms the server/map binding; it does not alter the static result |
| S5.6 | Foot dimensions and offsets | RESOLVED: `0.3`, `0.2`, `-1`, `0` for half-width, half-height, X, Y; source-wide table-origin writer census finds no override | No runtime evidence required for the retained build | A later build requires a fresh writer census |
| S5.7 | Football host ball spawn/reset | Client only consumes `state.ball` | Host-side game traces | Spawn/reset contract is observed over multiple rounds |
| S5.8 | Imported Box2D CCD behavior | Physics module is outside the bundle | Captured module or differential physics traces | Behavior is treated as a separate dependency study, not inferred from local aliases |
| S5.9 | Runtime `mapVersion` and `swingF`/`swingD` overrides | RESOLVED: `mapVersion=15`; only `swingF=2`/`swingD=0` writes exist | No runtime evidence required for these values in the retained build | The legacy `<v12` `ig` default remains a separate source limitation |

Live map capture must use `Webscripts/mapexporter.js` and retain the full
body-to-fixture-to-shape hierarchy plus its runtime constant table. The target
training maps are not currently present in `maps/`, so capture is a prerequisite
for map-dependent claims.

## 9. Hard Boundaries

The following are not remaining static-deobfuscation tasks for this bundle.
They require an external asset, live evidence, or a separate implementation
project.

| Boundary | Why it cannot be completed from `alpha2s.js` alone | Correct track |
|---|---|---|
| Private server authority | Matchmaking, routing, validation, and authority are not shipped in the client | Independent server and live differential testing |
| Imported physics implementation | `Box2DModuleGJMod` is an AMD dependency, not readable bundle source | Dependency capture/review and physics differential testing |
| Exact solver iteration parity | Installed local Box2D port exposes a two-argument `Step` API instead of native velocity/position counts | Port change or documented approximation |
| `ClearForces` and line-joint support | Missing/incompatible installed port APIs | Port capability project or verified emulation |
| Original symbol names | No source map or original identifier metadata survives | External lawful symbol source only |
| Original flattened control flow | Data-dependent state-machine structure is not uniquely invertible | Analysis comments or external source evidence |
| Fresh source builds | Indices and decoded strings are build-specific | Re-run the complete capture and audit chain |

Simulator parity items such as the native-to-flat map converter, kinematic body
types, spawn arrays, grapple behavior, arrows, and joint emulation should be
tracked as implementation work in `DEOBFUSCATION_FIX_TRACKER.md`. They use
deobfuscation findings but do not themselves increase `alpha2s.js` readability.

## 10. Definition Of Done

No stage is complete until all applicable conditions below hold.

1. The new producer pass has a narrow, documented admission rule.
2. A versioned sidecar records every accepted and retained candidate.
3. An independent audit derives the same candidates and rejects missing, extra,
   unproven, or wrong-value transformations.
4. The generated readable AST matches the independently reconstructed result at
   each transformed source range.
5. Index 47 remains bracketed unless a complete access through a proven
   immutable-table root or carrier is folded to the string literal `"length"`.
6. Two fresh `final-pipeline.js` runs generate the same readable SHA-256.
7. The full verification set passes:

```text
node .deobf/final-pipeline.js
node --check .deobf/alpha2s.readable.js
node .deobf/ast-member-scan.js --self-check
node .deobf/audit-independent.js
node .deobf/audit-preamble.js
node .deobf/audit-formula-fold.js
node .deobf/audit-training-statics.js --self-check
node .deobf/audit-map-option-writers.js --self-check
node .deobf/audit-out-of-table.js --self-check
node .deobf/audit-dynamic-training-residuals.js --self-check
node .deobf/audit-table-lookup.js --verify
node .deobf/test-anchors.js
```

8. `docs/DEOBFUSCATION.md`, this roadmap, and the relevant tracker row are
   updated with the accepted count, residual count, evidence, and output hash.

## 11. Parallel Research Protocol

Independent evidence collection should be delegated in parallel only when the
work packages do not change the same proof rule or generated artifact.

| Parallel package | Inputs | Deliverable | Must stay separate from |
|---|---|---|---|
| Formula classifier | formula sidecar, dispatcher map, AST call sites | Candidate/evaluation-order census | Formula producer changes |
| Dynamic-index classifier | table sidecars, carrier writes, AST reads | Index/dataflow census | Receiver eligibility changes |
| Receiver classifier | callsites, scope/write analysis, annotations | Per-function alias-risk inventory | Dynamic-table value evaluation |
| Preamble classifier | bootstrap source and capture records | Source-order/state-dependence inventory | Body pass rewrites |
| Runtime-evidence planner | documented unknowns, map exporter, capture scripts | Trace schema and acceptance criteria | Static proof claims |
| Independent reviewer | proposed producer/audit diff | Safety findings and missing tests | The implementation itself |

Delegated research should batch independent file discovery and reads before
forming conclusions. Use `Glob`, `Read`, `semantic_search`, and
`codebase_search` for repository exploration; avoid line-oriented text-search
commands in delegated work. Every research report must distinguish verified
facts, candidate work, runtime-only evidence, and hard boundaries.
