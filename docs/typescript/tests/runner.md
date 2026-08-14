# Test Runner

## Module Overview

The repository uses Vitest for TypeScript tests. `tests/runner.ts` is a small
compatibility CLI retained for the legacy `test:runner`, `test:list`, and
`test:legacy` npm scripts. It delegates execution to Vitest and returns
Vitest's exit code.

## Current Suite Mappings

| npm script | Vitest target |
|:-----------|:--------------|
| `test:physics` | `tests/unit/physics-engine.test.ts` |
| `test:prng` | `tests/unit/prng.test.ts` |
| `test:env` | `tests/integration/bonk-env.test.ts` |
| `test:frameskip` | `tests/integration/frame-skip.test.ts` |
| `test:shared` | `tests/integration/shared-memory.test.ts` |
| `test:manager` | `tests/integration/env-manager.test.ts` |
| `test:map-types` | `tests/integration/map-body-types.test.ts` |
| `test:collision` | `tests/integration/collision-filtering.test.ts` |
| `test:nophysics` | `tests/integration/nophysics-friction.test.ts` |
| `test:grapple` | `tests/integration/grapple-mechanics.test.ts` |
| `test:bounds` | `tests/integration/dynamic-arena-bounds.test.ts` |
| `test:integration` | `tests/integration/` |

## Usage

```bash
# Run all tests in the default Vitest configuration
npm test

# Compatibility runner: interactive in a TTY, all default tests otherwise
npm run test:runner

# Run all tests through the legacy alias
npm run test:legacy

# List the compatibility suite mappings
npm run test:list

# Numeric runner arguments remain supported for existing users
npx tsx tests/runner.ts 1
npx tsx tests/runner.ts 12
```

The numeric compatibility arguments map to the focused files listed by
`npm run test:list`. New commands should use the direct Vitest npm scripts.

## Exit Codes

| Code | Meaning |
|:-----|:--------|
| `0` | All selected tests passed or the list command completed |
| `1` | Vitest failed, the suite argument was invalid, or the runner could not start |
