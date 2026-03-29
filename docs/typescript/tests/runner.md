# Test Runner

## Module Overview

The test runner (`tests/runner.ts`) is a CLI-based test execution framework that runs all 14 test suites and generates a consolidated summary report.

## Registered Test Suites

| # | File | Description |
|:--|:-----|:------------|
| 1 | `physics-engine.test.ts` | Box2D physics simulation |
| 2 | `prng.test.ts` | Deterministic RNG |
| 3 | `bonk-env.test.ts` | Gymnasium API |
| 4 | `frame-skip.test.ts` | Frame skip action repetition |
| 5 | `shared-memory.ts` | SharedArrayBuffer IPC |
| 6 | `shutdown.ts` | Signal handlers and scripts |
| 7 | `telemetry.ts` | Profiling system |
| 8 | `env-manager.test.ts` | Environment pool management |
| 9 | `map-body-types.test.ts` | Map body types (rect/circle/polygon) |
| 10 | `collision-filtering.test.ts` | Collision group filtering |
| 11 | `nophysics-friction.test.ts` | Sensor bodies and friction |
| 12 | `grapple-mechanics.test.ts` | Grapple and slingshot mechanics |
| 13 | `dynamic-arena-bounds.test.ts` | Dynamic arena bounds expansion |
| 14 | `map-integration.test.ts` | Real map loading and integration |

## Usage

```bash
# Run all tests
npm test
# or
npx tsx tests/runner.ts all

# Run a specific test suite by number
npx tsx tests/runner.ts 3

# List all available tests
npx tsx tests/runner.ts list

# Interactive menu mode
npx tsx tests/runner.ts
```

## Output Parsing

The runner captures and parses stdout from each test file. Test files must use this output format:

- `+ <test name>` — passed assertion
- `X <test name>` or `X <test name>: <details>` — failed assertion
- `✓ <test name>` — passed assertion (alternate format)
- `✗ <test name>` — failed assertion (alternate format)
- `RESULTS: <passed> passed, <failed> failed` — summary line at end

## Consolidated Summary Report

After all tests complete, the runner generates a detailed report containing:

- **Overall summary** — total suites, total tests, passed/failed/skipped counts, pass rate, duration
- **Suite-by-suite breakdown** — tests, pass, fail, duration, pass rate, status
- **Timing analysis** — slowest/fastest/average/median suite, top 5 slowest
- **Failure details** — test name, suite, error details

## Data Structures

```typescript
interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

interface SuiteResult {
  file: string;
  description: string;
  tests: TestResult[];
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  passRate: number;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';
  exitCode: number | null;
  rawOutput: string;
  error?: string;
}
```

## Exit Codes

| Code | Meaning |
|:-----|:--------|
| `0` | All tests passed |
| `1` | One or more tests failed or errored |

## Test File Contract

All test files must:

1. Maintain `testsPassed` and `testsFailed` counters
2. Use the `test(name, passed, details?)` helper for each assertion
3. Print `+ <name>` for pass, `X <name>` for fail
4. Print `RESULTS: X passed, Y failed` at the end
5. Call `process.exit(1)` if any tests failed

## See Also

- [test-env](../../python/tests/test_env.md) — Python integration tests
- [benchmark](../../python/benchmarks/benchmark.md) — Performance benchmarks
