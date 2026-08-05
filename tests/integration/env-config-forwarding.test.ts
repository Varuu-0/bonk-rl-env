import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnv } from '../../src/env/bonk-env';
import { EnvManager } from '../../src/env/env-manager';

/**
 * Regression tests for #201: per-env config (BonkEnvConfig.config) must be
 * forwarded to the worker pool instead of being silently discarded in favour
 * of the global environment config.
 */
describe('per-env config forwarding (#201)', () => {
  const envs: BonkEnv[] = [];
  const managers: EnvManager[] = [];

  async function track(env: BonkEnv): Promise<BonkEnv> {
    envs.push(env);
    return env;
  }

  afterEach(async () => {
    for (const env of envs.splice(0)) {
      try { await env.stop(); } catch { /* ignore */ }
    }
    for (const manager of managers.splice(0)) {
      try { await manager.shutdownAll(); } catch { /* ignore */ }
    }
  });

  function firstDone(env: BonkEnv): Promise<number> {
    return (async () => {
      await env.reset([1]);
      for (let i = 1; i <= 20; i++) {
        const res = (await env.step([0])) as any[];
        if (res[0].done) return i;
      }
      return -1;
    })();
  }

  describe('BonkEnv wrapper', () => {
    it('honors per-env config.maxTicks (episode truncates at tick 5)', { timeout: 30000 }, async () => {
      const env = await track(new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        config: { maxTicks: 5, frameSkip: 1 },
      }));
      await env.start();

      await env.reset([1]);
      let firstDone = -1;
      let truncated = false;
      for (let i = 1; i <= 20; i++) {
        const res = (await env.step([0])) as any[];
        if (firstDone === -1 && res[0].done) {
          firstDone = i;
          truncated = res[0].truncated;
        }
      }
      expect(firstDone).toBe(5);
      expect(truncated).toBe(true);
    });

    it('per-env config does not clobber global defaults (opponent count stays 1)', { timeout: 30000 }, async () => {
      const env = await track(new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        config: { maxTicks: 5, frameSkip: 1 },
      }));
      await env.start();

      const obs = (await env.reset([1])) as any[];
      expect(obs[0].opponents).toHaveLength(1);
    });

    it('per-env config reaches the worker (frameSkip reflected in step info)', { timeout: 30000 }, async () => {
      const env = await track(new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        config: { maxTicks: 100, frameSkip: 3 },
      }));
      await env.start();

      await env.reset([1]);
      const res = (await env.step([0])) as any[];
      expect(res[0].info.frameSkip).toBe(3);
    });

    it('per-env reward config reaches the worker reward calc (#220)', { timeout: 30000 }, async () => {
      // The client-facing shape (`reward` sub-object in the per-env config)
      // must drive the worker's reward function: a non-terminal tick with the
      // configured -0.5 time penalty must report exactly -0.5.
      const env = await track(new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        config: {
          maxTicks: 100,
          numOpponents: 0,
          randomOpponent: false,
          seed: 42,
          reward: { timePenalty: -0.5 },
        },
      }));
      await env.start();

      await env.reset([1]);
      const res = (await env.step([0])) as any[];
      expect(res[0].done).toBe(false);
      expect(res[0].reward).toBeCloseTo(-0.5, 6);
    });
  });

  describe('EnvManager', () => {
    it('createEnv forwards per-env config to the worker', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 7800, endPort: 7900 },
      });
      managers.push(manager);

      const env = await manager.createEnv({
        numEnvs: 1,
        useSharedMemory: false,
        config: { maxTicks: 5, frameSkip: 1 },
      });
      expect(await firstDone(env)).toBe(5);
    });

    it('defaultEnvConfig config reaches created environments', { timeout: 30000 }, async () => {
      const manager = new EnvManager({
        portManager: { startPort: 7900, endPort: 8000 },
        defaultEnvConfig: {
          numEnvs: 1,
          useSharedMemory: false,
          config: { maxTicks: 5, frameSkip: 1 },
        },
      });
      managers.push(manager);

      const env = await manager.createEnv();
      expect(await firstDone(env)).toBe(5);
    });
  });
});
