import { describe, expect, it } from 'vitest';
import { safeSin, safeCos, safeTan, safeASin, safeACos, safeATan, safeATan2 } from '../../src/core/safe-trig';

describe('reference-specified rounded trigonometry', () => {
  it('rounds results rather than input angles', () => {
    expect(safeSin(0.23)).toBe(0.2279775);
    expect(safeCos(0.23)).toBe(0.9736664);
    expect(safeATan2(1, 1)).toBe(0.7853982);
    expect(safeATan(1)).toBe(0.7853982);
    expect(safeASin(0.5)).toBe(0.5235988);
    expect(safeACos(0.5)).toBe(1.0471976);
    expect(safeTan(0)).toBe(0);
  });

  it('preserves signed zero and native domain errors rather than inventing clamps', () => {
    expect(Object.is(safeSin(-0), -0)).toBe(true);
    expect(Object.is(safeSin(-1e-9), -0)).toBe(true);
    expect(Object.is(safeATan2(-0, 1), -0)).toBe(true);
    expect(safeSin(Infinity)).toBeNaN();
    expect(safeASin(2)).toBeNaN();
    expect(safeACos(-2)).toBeNaN();
  });
});
