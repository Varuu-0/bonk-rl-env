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