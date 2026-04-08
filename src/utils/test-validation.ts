import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { existsSync } from 'fs';

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  retries: number;
}

export interface TestSuiteResult {
  name: string;
  passed: number;
  failed: number;
  total: number;
  duration: number;
  results: TestResult[];
}

export interface RetryConfig {
  maxRetries: number;
  retryDelay: number;
  backoffMultiplier: number;
}

export interface RegressionSnapshot {
  timestamp: number;
  duration: number;
  passed: boolean;
  metrics: Record<string, number>;
}

export interface RegressionBaseline {
  name: string;
  snapshots: RegressionSnapshot[];
  threshold: number;
}

export class TestValidationError extends Error {
  constructor(message: string, public readonly tests: TestResult[]) {
    super(message);
    this.name = 'TestValidationError';
  }
}

export class RegressionFailureError extends Error {
  constructor(
    message: string,
    public readonly current: number,
    public readonly baseline: number,
    public readonly threshold: number
  ) {
    super(message);
    this.name = 'RegressionFailureError';
  }
}

export class TestRunner extends EventEmitter {
  private currentProcess: ChildProcess | null = null;
  private isRunning: boolean = false;

  constructor(private readonly vitestPath: string = 'vitest') {
    super();
  }

  async runTests(
    testPaths: string[],
    config?: { timeout?: number; retry?: RetryConfig }
  ): Promise<TestSuiteResult> {
    if (this.isRunning) {
      throw new Error('Tests are already running');
    }

    this.isRunning = true;
    const startTime = Date.now();

    const defaultRetryConfig: RetryConfig = {
      maxRetries: 3,
      retryDelay: 1000,
      backoffMultiplier: 2,
    };

    const retryConfig = config?.retry ?? defaultRetryConfig;
    const results: TestResult[] = [];

    try {
      for (const testPath of testPaths) {
        const testResult = await this.runSingleTestWithRetry(
          testPath,
          retryConfig,
          config?.timeout
        );
        results.push(testResult);
      }
    } finally {
      this.isRunning = false;
    }

    const duration = Date.now() - startTime;
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    return {
      name: 'Test Suite',
      passed,
      failed,
      total: results.length,
      duration,
      results,
    };
  }

  private async runSingleTestWithRetry(
    testPath: string,
    retryConfig: RetryConfig,
    timeout?: number
  ): Promise<TestResult> {
    let lastError: string | undefined;
    let attempt = 0;
    let delay = retryConfig.retryDelay;

    while (attempt <= retryConfig.maxRetries) {
      attempt++;
      this.emit('attempt', { testPath, attempt, maxRetries: retryConfig.maxRetries });

      try {
        const result = await this.runSingleTest(testPath, timeout);
        if (result.passed) {
          return { ...result, retries: attempt - 1 };
        }
        lastError = result.error;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempt <= retryConfig.maxRetries) {
        await this.sleep(delay);
        delay *= retryConfig.backoffMultiplier;
      }
    }

    return {
      name: testPath,
      passed: false,
      duration: 0,
      error: lastError,
      retries: retryConfig.maxRetries,
    };
  }

  private runSingleTest(testPath: string, timeout?: number): Promise<TestResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const args = ['run', '--reporter=json', testPath];

      this.currentProcess = spawn(this.vitestPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timeoutHandle = timeout
        ? setTimeout(() => {
            this.currentProcess?.kill('SIGTERM');
            reject(new Error(`Test timeout after ${timeout}ms`));
          }, timeout)
        : null;

      this.currentProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      this.currentProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      this.currentProcess.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.currentProcess = null;

        const duration = Date.now() - startTime;

        if (code === 0) {
          resolve({
            name: testPath,
            passed: true,
            duration,
            retries: 0,
          });
        } else {
          resolve({
            name: testPath,
            passed: false,
            duration,
            error: stderr || stdout || `Exit code: ${code}`,
            retries: 0,
          });
        }
      });

      this.currentProcess.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.currentProcess = null;
        reject(err);
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  get isActive(): boolean {
    return this.isRunning;
  }
}

export class RegressionTracker {
  private baselines: Map<string, RegressionBaseline> = new Map();
  private snapshotsPath: string;

  constructor(snapshotsPath: string = './test-snapshots') {
    this.snapshotsPath = snapshotsPath;
  }

  async createBaseline(
    name: string,
    testPath: string,
    runner: TestRunner
  ): Promise<RegressionBaseline> {
    const result = await runner.runTests([testPath], { timeout: 60000 });

    const baseline: RegressionBaseline = {
      name,
      threshold: 0.1,
      snapshots: result.results.map((r) => ({
        timestamp: Date.now(),
        duration: r.duration,
        passed: r.passed,
        metrics: { duration: r.duration },
      })),
    };

    this.baselines.set(name, baseline);
    return baseline;
  }

  async checkRegression(
    name: string,
    testPath: string,
    runner: TestRunner
  ): Promise<{ passed: boolean; regression?: RegressionFailureError }> {
    const baseline = this.baselines.get(name);
    if (!baseline) {
      throw new Error(`No baseline found for: ${name}`);
    }

    const result = await runner.runTests([testPath], { timeout: 60000 });
    const currentSnapshot = result.results[0];

    if (!currentSnapshot) {
      return { passed: false, regression: new RegressionFailureError('No test result', 0, 0, 0) };
    }

    const avgBaselineDuration =
      baseline.snapshots.reduce((sum, s) => sum + s.duration, 0) / baseline.snapshots.length;

    const regressionRatio = Math.abs(currentSnapshot.duration - avgBaselineDuration) / avgBaselineDuration;

    if (regressionRatio > baseline.threshold) {
      return {
        passed: false,
        regression: new RegressionFailureError(
          `Regression detected: ${regressionRatio * 100}% slower than baseline`,
          currentSnapshot.duration,
          avgBaselineDuration,
          baseline.threshold
        ),
      };
    }

    baseline.snapshots.push({
      timestamp: Date.now(),
      duration: currentSnapshot.duration,
      passed: currentSnapshot.passed,
      metrics: { duration: currentSnapshot.duration },
    });

    return { passed: true };
  }

  getBaseline(name: string): RegressionBaseline | undefined {
    return this.baselines.get(name);
  }

  setThreshold(name: string, threshold: number): void {
    const baseline = this.baselines.get(name);
    if (baseline) {
      baseline.threshold = threshold;
    }
  }
}

export class RetryLoop {
  private attempts: Map<string, number> = new Map();
  private results: Map<string, TestResult[]> = new Map();

  constructor(private readonly maxLoops: number = 5) {}

  async execute<T>(
    id: string,
    fn: () => Promise<T>,
    onFailure?: (attempt: number, error: Error) => void
  ): Promise<{ success: boolean; result?: T; attempts: number; errors: Error[] }> {
    const errors: Error[] = [];
    let attempt = this.attempts.get(id) ?? 0;

    while (attempt < this.maxLoops) {
      attempt++;
      this.attempts.set(id, attempt);

      try {
        const result = await fn();
        return { success: true, result, attempts: attempt, errors };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);

        if (onFailure) {
          onFailure(attempt, error);
        }

        if (attempt < this.maxLoops) {
          await this.sleep(Math.pow(2, attempt) * 100);
        }
      }
    }

    return { success: false, attempts: attempt, errors };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  reset(id: string): void {
    this.attempts.delete(id);
    this.results.delete(id);
  }

  getAttempts(id: string): number {
    return this.attempts.get(id) ?? 0;
  }
}

export function createTestRunner(vitestPath?: string): TestRunner {
  return new TestRunner(vitestPath);
}

export function createRegressionTracker(snapshotsPath?: string): RegressionTracker {
  return new RegressionTracker(snapshotsPath);
}

export function createRetryLoop(maxLoops?: number): RetryLoop {
  return new RetryLoop(maxLoops);
}