/**
 * worker-pool-use-shared-memory-validation.test.ts — Regression coverage for
 * issue #433.
 *
 * WorkerPool.init() used to consume its useSharedMemory argument verbatim:
 * the JSON string "false" (a plausible encoding mistake for any non-Python
 * IPC client) is truthy and silently served the SharedArrayBuffer transport
 * the caller asked to disable, while falsy non-boolean values (null) bypassed
 * the SharedArrayBuffer capability check that guards the config-default path.
 *
 * The option is now strictly boolean — matching how every other boolean
 * option in the repo is validated (action fields, physics sleeping flags,
 * map settings; no string alias is documented for this field) — and an
 * explicit request is reconciled with the runtime capability check: explicit
 * true falls back loudly to message-passing on a runtime without
 * SharedArrayBuffer, explicit false always selects message-passing, and
 * isUsingSharedMemory() is guaranteed to return a real boolean after init.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkerPool, normalizeUseSharedMemory, describeInvalidUseSharedMemory } from '../../src/core/worker-pool';
import { SharedMemoryManager } from '../../src/ipc/shared-memory';

describe('normalizeUseSharedMemory (#433)', () => {
  it('keeps the "no preference" semantics for undefined and passes booleans through', () => {
    expect(normalizeUseSharedMemory(undefined)).toBeUndefined();
    expect(normalizeUseSharedMemory(true)).toBe(true);
    expect(normalizeUseSharedMemory(false)).toBe(false);
  });

  it.each([
    ['string "false"', 'false'],
    ['string "true"', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['null', null],
    ['empty object', {}],
    ['array', []],
  ])('rejects %s with the labeled error', (_label, value) => {
    expect(() => normalizeUseSharedMemory(value)).toThrow(
      /^Invalid useSharedMemory: expected a boolean \(true or false\), got /,
    );
  });

  it('describes the offending value so the caller can identify the mistake', () => {
    expect(describeInvalidUseSharedMemory('false')).toBe('string "false"');
    expect(describeInvalidUseSharedMemory(null)).toBe('null');
    expect(describeInvalidUseSharedMemory(1)).toBe('number (1)');
    expect(describeInvalidUseSharedMemory({})).toBe('object');
    expect(describeInvalidUseSharedMemory([])).toBe('array');
  });
});

describe('WorkerPool useSharedMemory validation (#433)', () => {
  const cfg = { maxTicks: 5, seed: 1 };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects the JSON string "false" instead of silently serving SharedArrayBuffer mode', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await expect(pool.init(1, cfg, 'false' as any)).rejects.toThrow(
        'Invalid useSharedMemory: expected a boolean (true or false), got string "false"',
      );
      // The labeled rejection fires before any transport is selected, so
      // the pool can never be observed in shared mode and the resolved
      // flag is a real boolean, not the raw string.
      expect(typeof pool.isUsingSharedMemory()).toBe('boolean');
      expect(pool.isUsingSharedMemory()).toBe(false);
      expect(pool.isFailed()).toBe(false);
      // The rejection is a pre-teardown validation (#440 doctrine): the
      // same pool still accepts a valid re-init afterwards.
      await pool.init(1, cfg, false);
      const obs = await pool.reset([1]);
      expect(obs).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['null', null],
    ['empty object', {}],
    ['array', []],
  ])('rejects %s at the pool boundary without failing the pool', async (_label, value) => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await expect(pool.init(1, cfg, value as any)).rejects.toThrow(
        /^Invalid useSharedMemory: expected a boolean \(true or false\), got /,
      );
      expect(pool.isFailed()).toBe(false);
    } finally {
      await pool.close();
    }
  });

  it('explicit boolean true selects the SharedArrayBuffer transport when supported', async () => {
    if (!WorkerPool.isSupported()) return;
    if (!SharedMemoryManager.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, cfg, true);
      expect(pool.isUsingSharedMemory()).toBe(true);
      const obs = await pool.reset([1]);
      expect(obs).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it('explicit boolean false always selects message-passing mode', async () => {
    if (!WorkerPool.isSupported()) return;

    const pool = new WorkerPool(1);
    try {
      await pool.init(1, cfg, false);
      expect(pool.isUsingSharedMemory()).toBe(false);
      const obs = await pool.reset([1]);
      expect(obs).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it('explicit true on a runtime without SharedArrayBuffer falls back to message mode loudly', async () => {
    if (!WorkerPool.isSupported()) return;

    const supportSpy = vi.spyOn(SharedMemoryManager, 'isSupported').mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = new WorkerPool(1);
    try {
      // The explicit request is honored only as far as the runtime allows:
      // no crash inside the SharedArrayBuffer constructor, no silent
      // divergence — message mode with a labeled warning.
      await pool.init(1, cfg, true);
      expect(pool.isUsingSharedMemory()).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('SharedArrayBuffer is not available in this runtime'),
      );
      const obs = await pool.reset([1]);
      expect(obs).toHaveLength(1);
      expect(supportSpy).toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

  it('the config default path stays boolean and capability-gated for a missing request', async () => {
    if (!WorkerPool.isSupported()) return;

    // With no explicit request and the default config (useSharedMemory:
    // true), a supported runtime selects shared mode and reports a real
    // boolean; an unsupported runtime falls back to message mode.
    const supported = SharedMemoryManager.isSupported();
    const pool = new WorkerPool(1);
    try {
      await pool.init(1, cfg);
      expect(typeof pool.isUsingSharedMemory()).toBe('boolean');
      expect(pool.isUsingSharedMemory()).toBe(supported);
    } finally {
      await pool.close();
    }
  });
});
