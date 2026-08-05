import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvManager } from '../../src/env/env-manager';
import { WorkerPool } from '../../src/core/worker-pool';

/**
 * Regression coverage for issue #198: stepAll() must return the same flat
 * per-environment result shape as resetAll() instead of a nested
 * StepResult[][] (an element of a stepAll result is a StepResult object, so
 * `result.reward` / `result.done` / `result.observation` work as documented).
 */
describe('EnvManager batch result shape (issue #198)', () => {
  let manager: EnvManager;

  beforeEach(() => {
    manager = new EnvManager({
      portManager: { startPort: 8100, endPort: 8200 },
      defaultEnvConfig: { numEnvs: 1, useSharedMemory: false },
    });
  });

  afterEach(async () => {
    try { await manager.shutdownAll(); } catch { /* ignore */ }
  });

  it('stepAll and resetAll both return a flat array with matching element shape', { timeout: 30000 }, async () => {
    await manager.createPool(2);

    const resetResults = await manager.resetAll([1, 2]);
    const stepResults = await manager.stepAll([0, 0]);

    expect(resetResults).toHaveLength(2);
    expect(stepResults).toHaveLength(2);

    // Contract: both APIs return one flat element per environment, never a
    // per-env array wrapper.
    expect(Array.isArray(resetResults[0])).toBe(false);
    expect(Array.isArray(stepResults[0])).toBe(false);
    expect(typeof stepResults[0].reward).toBe('number');
    expect(stepResults[0].observation).toBeDefined();
    expect(typeof stepResults[0].done).toBe('boolean');

    for (let i = 0; i < stepResults.length; i++) {
      expect(Array.isArray(stepResults[i])).toBe(Array.isArray(resetResults[i]));
    }
  });

  it('stepAll results expose reward/done/observation directly on each element', { timeout: 30000 }, async () => {
    await manager.createPool(1);
    await manager.resetAll([1]);

    const results = await manager.stepAll([0]);

    // The documented Promise<any[]> contract: results[i] is a StepResult.
    expect(Array.isArray(results[0])).toBe(false);
    expect(results[0].reward).toBeDefined();
    expect(results[0].done).toBeDefined();
    expect(results[0].observation).toBeDefined();
  });

  it('shared-memory transport returns the same flat shape', { timeout: 30000 }, async () => {
    if (!WorkerPool.isSupported()) return;

    manager.shutdownAll();
    manager = new EnvManager({
      portManager: { startPort: 8200, endPort: 8300 },
      defaultEnvConfig: { numEnvs: 1, useSharedMemory: true },
    });
    await manager.createPool(2);

    const resetResults = await manager.resetAll([1, 2]);
    const stepResults = await manager.stepAll([0, 0]);

    expect(resetResults).toHaveLength(2);
    expect(stepResults).toHaveLength(2);
    expect(Array.isArray(resetResults[0])).toBe(false);
    expect(Array.isArray(stepResults[0])).toBe(false);
    expect(typeof stepResults[0].reward).toBe('number');
    expect(stepResults[0].observation).toBeDefined();
  });
});

/**
 * Regression coverage for issue #230: the EnvManager batch APIs must work for
 * BonkEnv with numEnvs > 1. stepAll must hand the multi-env pool a full
 * action list (not a single-element batch that the exact-count validation
 * rejects), and resetAll must seed every internal environment (not silently
 * seed only the first one).
 */
describe('EnvManager batch APIs with numEnvs > 1 (issue #230)', () => {
  let manager: EnvManager;

  beforeEach(() => {
    manager = new EnvManager({
      portManager: { startPort: 8300, endPort: 8400 },
      defaultEnvConfig: { numEnvs: 3, useSharedMemory: false },
    });
  });

  afterEach(async () => {
    try { await manager.shutdownAll(); } catch { /* ignore */ }
  });

  it('stepAll and resetAll cover every internal environment of a numEnvs=3 pool', { timeout: 30000 }, async () => {
    const envs = await manager.createPool(1);
    expect(envs).toHaveLength(1);
    expect(envs[0].getNumEnvs()).toBe(3);

    const resetResults = await manager.resetAll([11, 22, 33]);
    expect(resetResults).toHaveLength(3);

    const stepResults = await manager.stepAll([0, 0, 0]);
    expect(stepResults).toHaveLength(3);
    expect(Array.isArray(stepResults[0])).toBe(false);
    expect(typeof stepResults[0].reward).toBe('number');
    expect(stepResults[0].observation).toBeDefined();

    // The pool stays healthy across repeated batches.
    const secondStep = await manager.stepAll([1, 2, 3]);
    expect(secondStep).toHaveLength(3);
    expect(secondStep.every((r: any) => !Array.isArray(r) && typeof r.reward === 'number')).toBe(true);
  });

  it('seeds a full multi-env pool deterministically and rejects a short seed list', { timeout: 30000 }, async () => {
    await manager.createPool(1);

    // A short list is rejected loudly instead of silently under-seeding.
    await expect(manager.resetAll([11])).rejects.toThrow('Invalid seed batch');

    // A full-length reset works after the rejected batch, and identical seeds
    // reproduce identical trajectories for every internal environment.
    await manager.resetAll([11, 22, 33]);
    const first = await manager.stepAll([0, 0, 0]);
    await manager.resetAll([11, 22, 33]);
    const second = await manager.stepAll([0, 0, 0]);

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(second[i].observation).toEqual(first[i].observation);
    }
  });

  it('rejects a short action batch without failing the pool', { timeout: 30000 }, async () => {
    await manager.createPool(1);
    await manager.resetAll([11, 22, 33]);

    await expect(manager.stepAll([0])).rejects.toThrow('Invalid action batch');

    const results = await manager.stepAll([0, 0, 0]);
    expect(results).toHaveLength(3);
    expect(Array.isArray(results[0])).toBe(false);
  });

  it('mixes pools with different internal counts in one flat batch', { timeout: 30000 }, async () => {
    // 2 internal + 1 internal = 3 total, addressed as one flat batch.
    await manager.createEnv({ numEnvs: 2 });
    await manager.createEnv({ numEnvs: 1 });

    const resetResults = await manager.resetAll([1, 2, 3]);
    expect(resetResults).toHaveLength(3);

    const stepResults = await manager.stepAll([0, 0, 0]);
    expect(stepResults).toHaveLength(3);
    expect(stepResults.every((r: any) => !Array.isArray(r) && typeof r.reward === 'number')).toBe(true);
  });

  it('BonkEnv.reset rejects short and non-array seed batches at the wrapper layer', { timeout: 30000 }, async () => {
    const envs = await manager.createPool(1);
    const env = envs[0];

    await expect(env.reset([11])).rejects.toThrow('Invalid seed batch');
    await expect(env.reset('11' as any)).rejects.toThrow('expected an array of seeds');

    // A full-length batch still works after the rejected ones.
    const obs = await env.reset([11, 22, 33]);
    expect(Array.isArray(obs)).toBe(true);
    expect(obs).toHaveLength(3);
  });

  it('shared-memory transport batches a numEnvs=3 pool', { timeout: 30000 }, async () => {
    if (!WorkerPool.isSupported()) return;

    manager.shutdownAll();
    manager = new EnvManager({
      portManager: { startPort: 8400, endPort: 8500 },
      defaultEnvConfig: { numEnvs: 3, useSharedMemory: true },
    });
    await manager.createPool(1);

    const resetResults = await manager.resetAll([11, 22, 33]);
    expect(resetResults).toHaveLength(3);

    const stepResults = await manager.stepAll([0, 0, 0]);
    expect(stepResults).toHaveLength(3);
    expect(Array.isArray(stepResults[0])).toBe(false);
    expect(typeof stepResults[0].reward).toBe('number');
  });
});