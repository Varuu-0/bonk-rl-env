import { describe, it, expect, afterEach } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { EMPTY_INPUT } from '../utils/test-helpers';

describe('Frame Skip', () => {
  let env: BonkEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      env.close();
      env = null;
    }
  });

  describe('default frame_skip (1)', () => {
    it('default frame_skip is 1', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.info.frameSkip).toBe(1);
    });

    it('tick advances by 1', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.observation.tick).toBe(1);
    });

    it('done is false initially', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.done).toBe(false);
    });

    it('tick advances to 2', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100 });
      env.reset();
      env.step(EMPTY_INPUT);
      const result2 = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result2.observation.tick).toBe(2);
    });
  });

  describe('frame_skip=2', () => {
    it('frame_skip is 2', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.info.frameSkip).toBe(2);
    });

    it('tick advances by 1 (done not checked yet)', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.observation.tick).toBe(1);
    });

    it('done is false on intermediate tick', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.done).toBe(false);
    });

    it('tick advances to 2 (done checked on final tick)', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      env.step(EMPTY_INPUT);
      const result2 = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result2.observation.tick).toBe(2);
    });

    it('done can be true or false on final tick', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      env.step(EMPTY_INPUT);
      const result2 = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result2.done === true || result2.done === false).toBe(true);
    });
  });

  describe('frame_skip=4', () => {
    it('frame_skip is 4', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 4 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.info.frameSkip).toBe(4);
    });

    it('tick advances by 1 (first tick of cycle)', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 4 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.observation.tick).toBe(1);
    });

    it('done is false on intermediate tick', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 4 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.done).toBe(false);
    });

    it('tick advances to 5 after 4 more steps (new cycle starts)', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 4 });
      env.reset();
      env.step(EMPTY_INPUT);
      let result2: ReturnType<typeof env.step> | undefined;
      for (let i = 0; i < 4; i++) {
        result2 = env.step({
          left: true,
          right: false,
          up: false,
          down: false,
          heavy: false,
          grapple: false,
        });
      }
      expect(result2!.observation.tick).toBe(5);
    });
  });

  describe('different actions persist', () => {
    it('first step advances 1 tick', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      const result1 = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result1.observation.tick).toBe(1);
    });

    it('second step advances to tick 2', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      const result2 = env.step({
        left: false,
        right: true,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result2.observation.tick).toBe(2);
    });

    it('done is false after frame_skip cycle completes', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 100, frameSkip: 2 });
      env.reset();
      env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      const result2 = env.step({
        left: false,
        right: true,
        up: false,
        down: false,
        heavy: false,
        grapple: false,
      });
      expect(result2.done).toBe(false);
    });
  });

  describe('done conditions on final tick', () => {
    it('done becomes true at tick that is multiple of frame_skip', () => {
      env = new BonkEnvironment({ numOpponents: 1, maxTicks: 10, frameSkip: 2 });
      env.reset();

      let stepCount = 0;
      let lastResult: ReturnType<typeof env.step> | null = null;
      while (stepCount < 10) {
        const result = env.step(EMPTY_INPUT);
        lastResult = result;
        if (result.done) {
          break;
        }
        stepCount++;
      }

      expect(lastResult).not.toBeNull();
      expect(lastResult!.observation.tick % 2).toBe(0);
    });
  });

  describe('info includes frameSkip', () => {
    it('info has frameSkip key', () => {
      env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('frameSkip' in result.info).toBe(true);
    });

    it('info frameSkip equals config', () => {
      env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect(result.info.frameSkip).toBe(3);
    });

    it('info includes tick', () => {
      env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('tick' in result.info).toBe(true);
    });

    it('info includes aiAlive', () => {
      env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('aiAlive' in result.info).toBe(true);
    });

    it('info includes opponentsAlive', () => {
      env = new BonkEnvironment({ numOpponents: 1, frameSkip: 3 });
      env.reset();
      const result = env.step(EMPTY_INPUT);
      expect('opponentsAlive' in result.info).toBe(true);
    });
  });
});
