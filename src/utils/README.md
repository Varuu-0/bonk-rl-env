# Utilities (`src/utils/`)

Shared utility modules used across the Bonk.io RL environment.

## Files

| File | Purpose |
|------|---------|
| `port-manager.ts` | Dynamic port allocation — sequential allocation with wraparound, collision avoidance |
| `test-validation.ts` | Test runner, regression tracking, and failure retry loop |

## TestValidation API

```typescript
class TestRunner {
  runTests(testPaths: string[], config?: { timeout?: number; retry?: RetryConfig }): Promise<TestSuiteResult>
  cancel(): void
}

class RegressionTracker {
  createBaseline(name: string, testPath: string, runner: TestRunner): Promise<RegressionBaseline>
  checkRegression(name: string, testPath: string, runner: TestRunner): Promise<{ passed: boolean; regression?: RegressionFailureError }>
  setThreshold(name: string, threshold: number): void
}

class RetryLoop {
  execute<T>(id: string, fn: () => Promise<T>, onFailure?: (attempt: number, error: Error) => void): Promise<{ success: boolean; result?: T; attempts: number; errors: Error[] }>
  reset(id: string): void
}
```

## Usage

Run tests with retry logic:
```typescript
const runner = createTestRunner();
const result = await runner.runTests(['tests/unit/foo.test.ts'], {
  timeout: 30000,
  retry: { maxRetries: 3, retryDelay: 1000, backoffMultiplier: 2 }
});
```

Track performance regressions:
```typescript
const tracker = createRegressionTracker();
await tracker.createBaseline('perf-baseline', 'tests/perf/foo.test.ts', runner);
const { passed, regression } = await tracker.checkRegression('perf-baseline', 'tests/perf/foo.test.ts', runner);
```

Retry loop for flaky operations:
```typescript
const loop = createRetryLoop(5);
const { success, result, attempts } = await loop.execute('operation-id', async () => {
  // flaky operation
});
```

## PortManager API

```typescript
class PortManager {
  constructor(options?: { startPort?: number; endPort?: number })  // Default: 6000-7000
  allocate(): number           // Get next available port
  reserve(port: number): void  // Reserve a specific port
  release(port: number): void  // Release a port
  isAllocated(port: number): boolean  // Check if port is allocated
  getAllocatedCount(): number  // Count of allocated ports
  releaseAll(): void           // Release all ports
}

// Static helpers
PortManager.isPortAvailable(port: number): Promise<boolean>   // Check system availability
PortManager.findAvailablePort(preferredStart: number): Promise<number>  // Find free port
```

## Usage

Each `BonkEnv` instance gets a unique port from the `PortManager` to avoid collisions when running multiple IPC servers simultaneously. The default range (6000-7000) supports up to 1000 concurrent environments.

## Global Instance

```typescript
getGlobalPortManager(options?: PortManagerOptions): PortManager
resetGlobalPortManager(): void  // For testing
```
