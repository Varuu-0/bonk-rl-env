import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy, EMPTY_INPUT, LEFT_INPUT } from '../utils/test-helpers';

describe('BonkEnvironment', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = null;
    }
  });

  describe('initialization', () => {
    it('creates environment', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      expect(env).toBeDefined();
    });
  });

  describe('reset', () => {
    it('returns observation', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect(obs).toBeDefined();
    });

    it('observation has playerX', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect('playerX' in obs).toBe(true);
    });

    it('observation has playerY', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect('playerY' in obs).toBe(true);
    });

    it('observation has opponents', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect('opponents' in obs).toBe(true);
    });

    it('observation has arenaHalfWidth', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect('arenaHalfWidth' in obs).toBe(true);
    });

    it('observation has tick', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect('tick' in obs).toBe(true);
    });

    it('tick starts at 0', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      const obs = env.reset();
      expect(obs.tick).toBe(0);
    });
  });

  describe('step', () => {
    it('returns result', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result).toBeDefined();
    });

    it('result has observation', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('observation' in result).toBe(true);
    });

    it('result has reward', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('reward' in result).toBe(true);
    });

    it('result has done', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('done' in result).toBe(true);
    });

    it('result has truncated', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('truncated' in result).toBe(true);
    });

    it('result has info', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('info' in result).toBe(true);
    });

    it('tick increases', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.observation.tick).toBe(1);
    });
  });

  describe('done conditions', () => {
    it('episode completes within maxTicks', () => {
      env = new BonkEnvironment({
        numOpponents: 1,
        maxTicks: 5,
      });
      env.reset();

      let done = false;
      let steps = 0;

      while (!done && steps < 20) {
        const result = env.step(EMPTY_INPUT);
        done = result.done;
        steps++;
      }

      expect(done).toBe(true);
    });
  });

  describe('truncation', () => {
    it('eventually truncates due to maxTicks', () => {
      env = new BonkEnvironment({
        numOpponents: 1,
        maxTicks: 10,
      });
      env.reset();

      let done = false;
      let truncated = false;
      let steps = 0;

      while (!done && steps < 20) {
        const result = env.step(EMPTY_INPUT);
        done = result.done;
        truncated = result.truncated;
        steps++;
      }

      expect(truncated).toBe(true);
    });
  });

  describe('action decoding', () => {
    it('accepts PlayerInput object', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result).toBeDefined();
    });

    it('accepts number action', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(1);
      expect(result).toBeDefined();
    });
  });

  describe('reward', () => {
    it('reward is a number', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(typeof result.reward).toBe('number');
    });

    it('reward is finite', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(Number.isFinite(result.reward)).toBe(true);
    });
  });

  describe('info', () => {
    it('info has tick', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('tick' in result.info).toBe(true);
    });

    it('info tick is number', () => {
      env = new BonkEnvironment({ numOpponents: 1 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(typeof result.info.tick).toBe('number');
    });
  });

  describe('cumulative rewards', () => {
    it('cumulative reward is negative due to time penalty', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();

      let totalReward = 0;
      for (let i = 0; i < 10; i++) {
        const result = env.step(EMPTY_INPUT);
        totalReward += result.reward;
      }

      expect(totalReward).toBeLessThan(0);
    });
  });
});
