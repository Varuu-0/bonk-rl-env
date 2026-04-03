/**
 * bench-report.test.ts — Tests for benchmark reporting utility
 *
 * Black-box tests for createSuite, recordResult, finalizeSuite,
 * emitSuite, and formatSuiteSummary.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSuite,
  recordResult,
  finalizeSuite,
  emitSuite,
  formatSuiteSummary,
  type BenchmarkSuite,
  type BenchmarkResult,
} from '../../src/utils/bench-report';

describe('bench-report', () => {
  describe('createSuite', () => {
    it('creates an empty suite with correct structure', () => {
      const suite = createSuite(1, 'Primitives', 'Basic operations');
      expect(suite.layer).toBe(1);
      expect(suite.name).toBe('Primitives');
      expect(suite.description).toBe('Basic operations');
      expect(suite.results).toEqual([]);
      expect(suite.durationMs).toBe(0);
      expect(suite.passed).toBe(0);
      expect(suite.failed).toBe(0);
      expect(suite.skipped).toBe(0);
      expect(suite.errored).toBe(0);
    });
  });

  describe('recordResult', () => {
    let suite: BenchmarkSuite;

    beforeEach(() => {
      suite = createSuite(1, 'Test', 'Test suite');
    });

    it('increments passed counter for PASS status', () => {
      const result: BenchmarkResult = {
        layer: 1, name: 'test', passed: true, status: 'PASS',
        durationMs: 10, metrics: [],
      };
      recordResult(suite, result);
      expect(suite.passed).toBe(1);
      expect(suite.results).toHaveLength(1);
    });

    it('increments failed counter for FAIL status', () => {
      const result: BenchmarkResult = {
        layer: 1, name: 'test', passed: false, status: 'FAIL',
        durationMs: 10, metrics: [],
      };
      recordResult(suite, result);
      expect(suite.failed).toBe(1);
    });

    it('increments skipped counter for SKIP status', () => {
      const result: BenchmarkResult = {
        layer: 1, name: 'test', passed: false, status: 'SKIP',
        durationMs: 10, metrics: [],
      };
      recordResult(suite, result);
      expect(suite.skipped).toBe(1);
    });

    it('increments errored counter for ERROR status', () => {
      const result: BenchmarkResult = {
        layer: 1, name: 'test', passed: false, status: 'ERROR',
        durationMs: 10, metrics: [], error: 'something broke',
      };
      recordResult(suite, result);
      expect(suite.errored).toBe(1);
    });

    it('appends result to results array', () => {
      const r1: BenchmarkResult = {
        layer: 1, name: 'test1', passed: true, status: 'PASS',
        durationMs: 10, metrics: [],
      };
      const r2: BenchmarkResult = {
        layer: 1, name: 'test2', passed: false, status: 'FAIL',
        durationMs: 20, metrics: [],
      };
      recordResult(suite, r1);
      recordResult(suite, r2);
      expect(suite.results).toHaveLength(2);
      expect(suite.results[0].name).toBe('test1');
      expect(suite.results[1].name).toBe('test2');
    });
  });

  describe('finalizeSuite', () => {
    it('sets durationMs and returns the suite', () => {
      const suite = createSuite(1, 'Test', 'Test');
      const result = finalizeSuite(suite, 5000);
      expect(result.durationMs).toBe(5000);
      expect(result).toBe(suite);
    });
  });

  describe('emitSuite', () => {
    it('outputs JSON markers to console', () => {
      const suite = createSuite(1, 'Test', 'Test');
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { captured.push(String(args[0])); };
      try {
        emitSuite(suite);
      } finally {
        console.log = origLog;
      }

      expect(captured).toContain('__BENCH_JSON_START__');
      expect(captured).toContain('__BENCH_JSON_END__');
      const jsonOutput = captured.find(c => c.startsWith('{'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed.layer).toBe(1);
      expect(parsed.name).toBe('Test');
    });

    it('writes to file when filePath is provided', () => {
      const suite = createSuite(1, 'Test', 'Test');
      const tmpFile = 'coverage/bench-test-output.json';
      emitSuite(suite, tmpFile);

      const fs = require('fs');
      expect(fs.existsSync(tmpFile)).toBe(true);
      const content = fs.readFileSync(tmpFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe('Test');
      fs.unlinkSync(tmpFile);
    });

    it('does not throw when file write fails', () => {
      const suite = createSuite(1, 'Test', 'Test');
      expect(() => emitSuite(suite, '/nonexistent/deep/path/file.json')).not.toThrow();
    });
  });

  describe('formatSuiteSummary', () => {
    it('formats a suite with passing results', () => {
      const suite = createSuite(1, 'Primitives', 'Basic operations');
      recordResult(suite, {
        layer: 1, name: 'atomic ops', passed: true, status: 'PASS',
        durationMs: 5, metrics: [{ label: 'ops/sec', value: 1000000, unit: 'ops/s' }],
      });
      finalizeSuite(suite, 100);

      const summary = formatSuiteSummary(suite);
      expect(summary).toContain('=== Layer 1: Primitives ===');
      expect(summary).toContain('Basic operations');
      expect(summary).toContain('✓ atomic ops');
      expect(summary).toContain('ops/sec: 1,000,000 ops/s');
      expect(summary).toContain('1 passed');
      expect(summary).toContain('0.10s');
    });

    it('formats a suite with mixed results', () => {
      const suite = createSuite(2, 'Physics', 'Physics simulation');
      recordResult(suite, {
        layer: 2, name: 'tick', passed: true, status: 'PASS',
        durationMs: 10, metrics: [],
      });
      recordResult(suite, {
        layer: 2, name: 'collision', passed: false, status: 'FAIL',
        durationMs: 20, metrics: [], error: 'collision failed',
      });
      recordResult(suite, {
        layer: 2, name: 'grapple', passed: false, status: 'SKIP',
        durationMs: 0, metrics: [],
      });
      recordResult(suite, {
        layer: 2, name: 'bounds', passed: false, status: 'ERROR',
        durationMs: 0, metrics: [], error: 'bounds error',
      });
      finalizeSuite(suite, 500);

      const summary = formatSuiteSummary(suite);
      expect(summary).toContain('✓ tick');
      expect(summary).toContain('✗ collision');
      expect(summary).toContain('○ grapple');
      expect(summary).toContain('! bounds');
      expect(summary).toContain('ERROR: collision failed');
      expect(summary).toContain('1 passed, 1 failed, 1 errors, 1 skipped');
      expect(summary).toContain('0.50s');
    });

    it('formats large values correctly', () => {
      const suite = createSuite(1, 'Perf', 'Performance');
      recordResult(suite, {
        layer: 1, name: 'large', passed: true, status: 'PASS',
        durationMs: 1, metrics: [
          { label: 'big', value: 999999999, unit: '' },
          { label: 'small', value: 0.0001, unit: '' },
          { label: 'medium', value: 42.5, unit: '' },
        ],
      });
      finalizeSuite(suite, 1);

      const summary = formatSuiteSummary(suite);
      expect(summary).toContain('999,999,999');
      expect(summary).toContain('0.0001');
      expect(summary).toContain('42.50');
    });

    it('handles empty suite', () => {
      const suite = createSuite(0, 'Empty', 'No results');
      finalizeSuite(suite, 0);

      const summary = formatSuiteSummary(suite);
      expect(summary).toContain('=== Layer 0: Empty ===');
      expect(summary).toContain('0 passed, 0 failed, 0 errors, 0 skipped');
    });
  });
});
