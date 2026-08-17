import { describe, it, expect } from 'vitest';
import { evaluate, parseSuiteFromOutput, parseLayer7, toMillis, applyEnvOverrides } from '../../scripts/ci-bench-check';

describe('ci-bench-check: applyEnvOverrides', () => {
  const checks = [
    {
      layer: 2,
      description: 'Box2D tick() throughput',
      benchMatch: /PhysicsEngine\.tick\(\)/,
      metricLabel: 'TPS',
      unit: 'steps/sec',
      baseline: 22_600,
      failLimit: 18_000,
      direction: 'higher-better' as const,
    },
    {
      layer: 5,
      description: '50K-step heap growth',
      benchMatch: /Memory stability/,
      metricLabel: 'Heap growth',
      unit: 'MB',
      baseline: 2.5,
      failLimit: 10.0,
      direction: 'lower-better' as const,
    },
    {
      layer: 5,
      description: '200-reset-cycle heap growth',
      benchMatch: /Reset cycles/,
      metricLabel: 'Heap growth',
      unit: 'MB',
      baseline: 0.5,
      failLimit: 3.0,
      direction: 'lower-better' as const,
    },
  ];

  it('overrides only the matching fail limit and never the baseline', () => {
    process.env.CI_BENCH_L5_RESET_FAIL_MB = '6';
    try {
      const applied = applyEnvOverrides(checks.map((check) => ({ ...check })));
      expect(applied[0].failLimit).toBe(18_000);
      expect(applied[0].baseline).toBe(22_600);
      expect(applied[1].failLimit).toBe(10.0);
      expect(applied[2].failLimit).toBe(6);
      expect(applied[2].baseline).toBe(0.5);
    } finally {
      delete process.env.CI_BENCH_L5_RESET_FAIL_MB;
    }
  });

  it('ignores missing, non-numeric, and non-positive values', () => {
    const original = checks.map((check) => ({ ...check }));
    delete process.env.CI_BENCH_L2_FAIL_TPS;
    process.env.CI_BENCH_L2_FAIL_TPS = 'not-a-number';
    expect(applyEnvOverrides(original).map((check) => check.failLimit)).toEqual([18_000, 10.0, 3.0]);
    process.env.CI_BENCH_L2_FAIL_TPS = '-5';
    expect(applyEnvOverrides(original).map((check) => check.failLimit)).toEqual([18_000, 10.0, 3.0]);
    delete process.env.CI_BENCH_L2_FAIL_TPS;
  });
});

describe('ci-bench-check: evaluate() SLA verdicts', () => {
  const throughputCheck = {
    layer: 2,
    description: 'Box2D tick() throughput',
    benchMatch: /PhysicsEngine\.tick\(\)/,
    metricLabel: 'TPS',
    unit: 'steps/sec',
    baseline: 22_600,
    failLimit: 18_000,
    direction: 'higher-better' as const,
  };

  const limitCheck = {
    layer: 5,
    description: '50K-step heap growth',
    benchMatch: /Memory stability/,
    metricLabel: 'Heap growth',
    unit: 'MB',
    baseline: 2.5,
    failLimit: 10.0,
    direction: 'lower-better' as const,
  };

  it('passes throughput at or above baseline', () => {
    expect(evaluate(throughputCheck, 30_000, 'steps/sec').status).toBe('PASS');
    expect(evaluate(throughputCheck, 22_600, 'steps/sec').status).toBe('PASS');
  });

  it('warns when throughput drops below baseline but stays above the fail limit', () => {
    expect(evaluate(throughputCheck, 20_000, 'steps/sec').status).toBe('WARN');
  });

  it('fails when throughput drops below the fail limit', () => {
    expect(evaluate(throughputCheck, 17_999, 'steps/sec').status).toBe('FAIL');
  });

  it('passes a lower-better metric at or below baseline', () => {
    expect(evaluate(limitCheck, 1.0, 'MB').status).toBe('PASS');
    expect(evaluate(limitCheck, 2.5, 'MB').status).toBe('PASS');
  });

  it('warns when a lower-better metric exceeds baseline but stays within the fail limit', () => {
    expect(evaluate(limitCheck, 6.0, 'MB').status).toBe('WARN');
  });

  it('fails when a lower-better metric exceeds the fail limit', () => {
    expect(evaluate(limitCheck, 10.5, 'MB').status).toBe('FAIL');
  });

  it('reports an error when the metric is missing', () => {
    const verdict = evaluate(limitCheck, null, null);
    expect(verdict.status).toBe('ERROR');
    expect(verdict.measured).toBeNull();
  });

  it('converts microseconds to milliseconds for the L1 table', () => {
    expect(toMillis(1000, 'us')).toBe(1);
    expect(toMillis(5, 'us')).toBe(0.005);
    expect(toMillis(7.5, 'ms')).toBe(7.5);
  });
});

describe('ci-bench-check: parseSuiteFromOutput', () => {
  it('extracts a suite from the benchmark markers', () => {
    const suite = {
      layer: 2,
      name: 'Raw Physics',
      description: 'desc',
      results: [{ layer: 2, name: 'bench', passed: true, status: 'PASS', durationMs: 1, metrics: [] }],
      durationMs: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
    };
    const output = `noise\n__BENCH_JSON_START__\n${JSON.stringify(suite, null, 2)}\n__BENCH_JSON_END__\ntrailing`;
    const parsed = parseSuiteFromOutput(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.layer).toBe(2);
    expect(parsed!.results).toHaveLength(1);
  });

  it('returns null for output without markers', () => {
    expect(parseSuiteFromOutput('some plain output')).toBeNull();
  });

  it('returns null for malformed JSON between the markers', () => {
    expect(parseSuiteFromOutput('__BENCH_JSON_START__\n{not json\n__BENCH_JSON_END__')).toBeNull();
  });

  it('returns null for JSON that is not a suite', () => {
    expect(parseSuiteFromOutput('__BENCH_JSON_START__\n{"nope":true}\n__BENCH_JSON_END__')).toBeNull();
  });
});

describe('ci-bench-check: parseLayer7', () => {
  it('extracts the phase-3 median step roundtrip latency', () => {
    const output = '=== Phase 3 ===\n  Mean: 4.20 ms\n  Median: 3.87 ms\n=== Phase 4 ===\n  Median: 1.02 ms\n';
    const verdict = parseLayer7(output);
    expect(verdict.measuredMs).toBeCloseTo(3.87, 2);
    expect(verdict.status).toBe('PASS');
  });

  it('warns between baseline and fail limit', () => {
    const output = '  Median: 8.5 ms\n';
    expect(parseLayer7(output).status).toBe('WARN');
  });

  it('fails beyond the fail limit', () => {
    const output = '  Median: 25.0 ms\n';
    expect(parseLayer7(output).status).toBe('FAIL');
  });

  it('errors when no median line exists', () => {
    expect(parseLayer7('no timing output').status).toBe('ERROR');
  });
});
