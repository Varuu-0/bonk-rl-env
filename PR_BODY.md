Fixes #205
Fixes #210
Fixes #211
Fixes #213

## Summary

Four shared-memory (SAB) observation/info parity defects between the default shared-memory transport and message-passing mode, plus a batch-validation gap. Four commits, one per issue.

## Commits

### `3d8fd55` fix(worker-pool,ipc): reject over-long reset seed batches (#213)

The **step** side of #213 was already fixed by #209 (exact action-count validation in `WorkerPool.step()` at `src/core/worker-pool.ts:435` and the `IpcBridge` step handler at `src/ipc/ipc-bridge.ts:100`, covered by `worker-pool-action-count.test.ts`). The **seed** side had no validation: `reset([1,2,3])` on a 2-env pool silently dropped seed 3 in both transports.

- `WorkerPool.reset()` now rejects non-array and over-long seed batches before any worker state is touched (`src/core/worker-pool.ts:339`).
- `IpcBridge` reset handler rejects the same inputs with a clean `{ status: "error" }` reply (`src/ipc/ipc-bridge.ts:76`).
- Short seed lists stay legal: the #183 semantics (tail envs reset unseeded) are pinned by `worker-pool-stale-seeds.test.ts`.
- Tests: `tests/integration/worker-pool-seed-batch-validation.test.ts` (both transports) + over-long step/reset coverage over a real ZMQ socket in `tests/integration/ipc-bridge-dealer-socket.test.ts`.

### `8ec1aba` fix(worker-pool): drop stale terminal_observation key from pooled SAB info (#211)

`stepSharedMemory()` reused one pooled `info` object per environment; the non-terminal branch assigned `info.terminal_observation = undefined`, which keeps the key on the object (`'terminal_observation' in info` stayed true on every non-terminal step) — only `delete` removes a property. Replaced the assignment with `delete` (`src/core/worker-pool.ts:652`). Regression test `tests/integration/worker-pool-terminal-observation-regression.test.ts` asserts across multiple `maxTicks=2` episodes in both transports that the key exists exactly when `done` is true.

### `e55d77a` fix(ipc,worker,environment): carry every opponent through the shared-memory observation layout (#210)

The SAB observation record was a fixed 16-float layout with one opponent slot, so `numOpponents > 1` silently returned `opponents.length === 1` in the default transport. The per-env record is now sized from the config: `16 + 6 * max(0, numOpponents - 1)` floats — first opponent keeps offsets 7-12, arena/tick stay at 13-15 (byte-identical default layout), extra opponents append 6-float blocks at 16+.

- `SharedMemoryManager` computes floats per env from a new `numOpponents` ctor arg (`src/ipc/shared-memory.ts`); `floatsPerEnv()`/`calculateBufferSize()` share the formula.
- `BonkEnvironment.getObservationFast()` sizes its buffer per config and writes every opponent block (`src/core/environment.ts`).
- `worker.ts` `observationToArray()` writes every opponent into the config-sized buffer.
- `WorkerPool.initObsPool()`/`extractObservation()` allocate and read one template slot per opponent (`src/core/worker-pool.ts`).
- Tests: `tests/integration/worker-pool-opponents-parity.test.ts` — `numOpponents=3` parity across both transports (reset + step lengths, same-seed opponent values within Float32 tolerance), 28-float extraction layout unit test, `getObservationFast` sizing.

### `d3dfb0c` fix(worker,worker-pool): restore full info parity in shared-memory step results (#205)

The SAB path only transported scalars, so shared-memory `info` was `{ tick, terminated }` while message mode returned `aiAlive, opponentsAlive, frameSkip, capZones, scoreBlue, scoreRed, aiTeam, tick`. The worker now ships the full env-produced info dictionaries over the message channel (`step-infos`, one message per worker per batch, posted before the completion signal) and `stepSharedMemory()` merges them onto the pooled info objects (`src/core/worker-pool.ts:660`). SAB values stay authoritative for tick/terminated; the terminal observation is still re-extracted from the SAB. Delivery is race-free (resolver registered before signalling; cleanup resolves pending resolvers so a mid-batch failure cannot hang). The `worker-pool-failures` test double now emits `step-infos` like a real worker.

- Tests: `tests/integration/worker-pool-info-parity.test.ts` — both transports, same seed: identical info key sets (the nine documented fields + `terminal_observation` exactly on terminal steps) and equal values.

## Validation

- `npm run typecheck`: 0 errors
- `npm test`: 55 files, 1209 passed / 19 skipped (two consecutive green full runs)
- `git diff --check`: clean
- Untouched: `.deobf/`, `docs/DEOBFUSCATION*`
