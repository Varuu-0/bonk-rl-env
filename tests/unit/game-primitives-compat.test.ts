import { describe, expect, it } from 'vitest';
import * as legacyCodec from '../../src/core/action-validation';
import * as sharedCodec from '../../src/core/action-codec';
import { PRNG } from '../../src/core/prng';
import { DT as legacyDT, TPS as legacyTPS } from '../../src/core/physics-engine';
import { DT, TPS } from '../../src/shared/units';

describe('game primitive compatibility exports', () => {
  it('keeps canonical deterministic PRNG behavior in the local implementation', () => {
    const rng = new PRNG(0x12345678);
    expect(rng.next()).toBe(0.10615200875326991);
    expect(rng.next()).toBe(0.941276284167543);
    const reset = new PRNG(1);
    reset.setState(123);
    expect(reset.getState()).toBe(123);
  });

  it('re-exports every existing codec value without wrappers or duplicate tables', () => {
    expect(Object.keys(legacyCodec).sort()).toEqual(Object.keys(sharedCodec).sort());
    for (const name of Object.keys(sharedCodec) as (keyof typeof sharedCodec)[]) {
      expect(legacyCodec[name]).toBe(sharedCodec[name]);
    }
  });

  it('preserves the existing physics timestep exports', () => {
    expect(legacyDT).toBe(DT);
    expect(legacyTPS).toBe(TPS);
  });
});
