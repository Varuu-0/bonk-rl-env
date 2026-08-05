/**
 * worker-pool-terminal-observation-regression.test.ts — Regression coverage for issue #211
 *
 * The shared-memory result path reuses one pooled `info` object per
 * environment. Assigning `info.terminal_observation = undefined` on
 * non-terminal steps left the key on the pooled object forever, so
 * `'terminal_observation' in info` was true on every non-terminal step in
 * shared-memory mode while message-passing mode omitted the key entirely.
 *
 * The key must be present only when the step actually ended, and must
 * disappear again on the following non-terminal step.
 */
import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('SAB terminal_observation key lifecycle (issue #211)', () => {
  const runLifecycle = async (useSharedMemory: boolean) => {
    const pool = new WorkerPool(1);
    try {
      // maxTicks=2: steps alternate non-terminal (tick 1) and terminal
      // (tick 2, truncated), and the worker auto-resets after each end.
      await pool.init(1, { maxTicks: 2 }, useSharedMemory);
      await pool.reset([1]);

      // Across several episodes the key must exist exactly on the terminal
      // steps: absent on non-terminal steps, present with a value on
      // terminal steps, and gone again on the step after an episode end.
      let sawTerminal = false;
      for (let i = 0; i < 8; i++) {
        const r = (await pool.step([0]))[0];
        expect('terminal_observation' in r.info).toBe(r.done);
        if (r.done) {
          sawTerminal = true;
          expect(r.info.terminal_observation).toBeDefined();
          expect(r.info.terminal_observation).toHaveProperty('playerX');
        } else {
          expect(r.info.terminal_observation).toBeUndefined();
        }
      }
      expect(sawTerminal).toBe(true);
    } finally {
      await pool.close();
    }
  };

  it('shared-memory mode: terminal_observation key only exists on terminal steps', async () => {
    if (!WorkerPool.isSupported()) return;
    await runLifecycle(true);
  });

  it('message-passing mode: terminal_observation key only exists on terminal steps', async () => {
    await runLifecycle(false);
  });
});
