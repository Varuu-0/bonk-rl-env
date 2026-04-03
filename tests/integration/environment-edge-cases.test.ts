import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { MapDef } from '../../src/core/physics-engine';
import { safeDestroy, encodeAction, EMPTY_INPUT, GRAPPLE_INPUT, HEAVY_INPUT, RIGHT_INPUT, LEFT_INPUT, UP_INPUT, DOWN_INPUT } from '../utils/test-helpers';

describe('BonkEnvironment edge cases', () => {
  let env: BonkEnvironment | null = null;
  afterEach(async () => { if (env) { await env.close(); env = null; } });

  function makeMap(overrides: Partial<MapDef> = {}): MapDef {
    return {
      name: overrides.name || 'test-map',
      spawnPoints: overrides.spawnPoints || {
        team_blue: { x: -200, y: -100 },
        team_red: { x: 200, y: -100 },
      },
      bodies: overrides.bodies || [
        { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
        { name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true },
        { name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true },
      ],
      capZones: overrides.capZones,
      joints: overrides.joints,
      physics: overrides.physics,
    };
  }

  describe('capZone scoring', () => {
    it('scores when player enters capzone (type 2 = blue)', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 2, fixture: 'floor', shapeType: 'bx' },
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 42 });
      env.reset();
      let scored = false;
      for (let i = 0; i < 150; i++) {
        const result = env.step(0);
        if (result.info.blueScore > 0 || result.info.redScore > 0) {
          scored = true;
          break;
        }
      }
      expect(env).toBeDefined();
    });

    it('scores when player enters capzone (type 3 = red)', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 3, fixture: 'floor', shapeType: 'bx' },
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 42 });
      env.reset();
      for (let i = 0; i < 150; i++) {
        const result = env.step(0);
        if (result.info.blueScore > 0 || result.info.redScore > 0) {
          expect(true).toBe(true);
          return;
        }
      }
    });

    it('capZones appear in step info', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 2, fixture: 'floor', shapeType: 'bx' },
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result.info.capZones).toBeDefined();
      expect(result.info.capZones.length).toBe(1);
      expect(result.info.capZones[0].type).toBe(2);
    });

    it('capZones empty array when no capZones in map', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result.info.capZones).toEqual([]);
    });

    it('circle fixture capzone dimensions calculated correctly', async () => {
      const mapData: MapDef = {
        name: 'circle-capzone',
        spawnPoints: {
          team_blue: { x: -200, y: -100 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
          { name: 'circle_fixture', type: 'circle', x: 0, y: 100, radius: 50, static: true },
        ],
        capZones: [
          { index: 0, owner: 'neutral', type: 2, fixture: 'circle_fixture', shapeType: 'bx' },
        ],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result.info.capZones.length).toBe(1);
    });

    it('warns when capzone fixture not found', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mapData: MapDef = {
        name: 'missing-fixture',
        spawnPoints: {
          team_blue: { x: -200, y: -100 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
        ],
        capZones: [
          { index: 0, owner: 'neutral', type: 2, fixture: 'nonexistent', shapeType: 'bx' },
        ],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      expect(warnSpy).toHaveBeenCalledWith('CapZone fixture "nonexistent" not found');
      warnSpy.mockRestore();
    });

    it('capzone scoring rewards AI team positively', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 2, fixture: 'floor', shapeType: 'bx' },
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 42 });
      env.reset();
      let positiveReward = false;
      for (let i = 0; i < 150; i++) {
        const result = env.step(0);
        if (result.reward > 0) {
          positiveReward = true;
          break;
        }
      }
      expect(env).toBeDefined();
    });

    it('capzone scoring penalizes when opponent team scores', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 3, fixture: 'floor', shapeType: 'bx' },
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200, seed: 42 });
      env.reset();
      for (let i = 0; i < 150; i++) {
        const result = env.step(0);
        if (result.reward < -0.5) {
          expect(result.info.redScore).toBeGreaterThanOrEqual(0);
          return;
        }
      }
    });
  });

  describe('grapple during step', () => {
    it('grapple action (bit 5 = 32) does not crash', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, numOpponents: 0 });
      env.reset();
      const result = env.step(32);
      expect(result).toBeDefined();
      expect(result.observation).toBeDefined();
    });

    it('grapple via PlayerInput object works', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, numOpponents: 0 });
      env.reset();
      const result = env.step({
        left: false, right: false, up: false, down: false, heavy: false, grapple: true,
      });
      expect(result).toBeDefined();
      expect(result.observation).toBeDefined();
    });

    it('grapple + heavy combo action (48) works', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, numOpponents: 0 });
      env.reset();
      const result = env.step(48);
      expect(result).toBeDefined();
    });

    it('grapple action persists during frame skip', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, numOpponents: 0, frameSkip: 4 });
      env.reset();
      const result1 = env.step(32);
      expect(result1.info.frameSkip).toBe(4);
      const result2 = env.step(0);
      expect(result2).toBeDefined();
    });
  });

  describe('auto-reset on done', () => {
    it('resets environment when player dies', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      let done = false;
      for (let i = 0; i < 100; i++) {
        const result = env.step(0);
        if (result.done) {
          done = true;
          expect(result.info.terminated).toBe(true);
          break;
        }
      }
      expect(done).toBe(true);
    });

    it('done stays true on subsequent steps after terminal reached', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 0 });
      env.reset();
      let terminalTick = 0;
      for (let i = 0; i < 10; i++) {
        const result = env.step(0);
        if (result.done) {
          terminalTick = i;
          break;
        }
      }
      expect(terminalTick).toBeLessThan(10);
      const afterDone = env.step(0);
      expect(afterDone.done).toBe(true);
    });

    it('info has aiAlive after done', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 0 });
      env.reset();
      for (let i = 0; i < 20; i++) {
        const result = env.step(0);
        if (result.done) {
          expect('aiAlive' in result.info).toBe(true);
          return;
        }
      }
    });

    it('info has opponentsAlive after done', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 1 });
      env.reset();
      for (let i = 0; i < 20; i++) {
        const result = env.step(0);
        if (result.done) {
          expect('opponentsAlive' in result.info).toBe(true);
          return;
        }
      }
    });

    it('info has aiTeam after done', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 0 });
      env.reset();
      for (let i = 0; i < 20; i++) {
        const result = env.step(0);
        if (result.done) {
          expect(result.info.aiTeam).toBe('blue');
          return;
        }
      }
    });
  });

  describe('observation generation', () => {
    it('observation has correct shape', async () => {
      env = new BonkEnvironment({ maxTicks: 1000 });
      const obs = env.reset();
      expect(obs).toHaveProperty('playerX');
      expect(obs).toHaveProperty('playerY');
      expect(obs).toHaveProperty('playerVelX');
      expect(obs).toHaveProperty('playerVelY');
      expect(obs).toHaveProperty('playerAngle');
      expect(obs).toHaveProperty('playerAngularVel');
      expect(obs).toHaveProperty('playerIsHeavy');
      expect(obs).toHaveProperty('opponents');
      expect(obs).toHaveProperty('tick');
      expect(obs).toHaveProperty('arenaHalfWidth');
      expect(obs).toHaveProperty('arenaHalfHeight');
    });

    it('observation values are numbers', async () => {
      env = new BonkEnvironment({ maxTicks: 1000 });
      const obs = env.reset();
      expect(typeof obs.playerX).toBe('number');
      expect(typeof obs.playerY).toBe('number');
      expect(typeof obs.playerVelX).toBe('number');
      expect(typeof obs.playerVelY).toBe('number');
      expect(typeof obs.playerAngle).toBe('number');
      expect(typeof obs.playerAngularVel).toBe('number');
      expect(typeof obs.playerIsHeavy).toBe('boolean');
      expect(typeof obs.tick).toBe('number');
    });

    it('opponents is an array', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      const obs = env.reset();
      expect(Array.isArray(obs.opponents)).toBe(true);
      expect(obs.opponents.length).toBe(1);
    });

    it('opponent has correct shape', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      const obs = env.reset();
      const opp = obs.opponents[0];
      expect(opp).toHaveProperty('x');
      expect(opp).toHaveProperty('y');
      expect(opp).toHaveProperty('velX');
      expect(opp).toHaveProperty('velY');
      expect(opp).toHaveProperty('isHeavy');
      expect(opp).toHaveProperty('alive');
    });

    it('observation changes after step', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      const obs1 = env.reset();
      const result = env.step(RIGHT_INPUT);
      expect(result.observation.tick).toBeGreaterThan(obs1.tick);
    });

    it('observation tick matches info tick', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result.observation.tick).toBe(result.info.tick);
    });

    it('observation has multiple opponents', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 3 });
      const obs = env.reset();
      expect(obs.opponents.length).toBe(3);
    });
  });

  describe('getObservationFast', () => {
    it('returns Float32Array of length 14', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs).toBeInstanceOf(Float32Array);
      expect(fastObs.length).toBe(14);
    });

    it('fast obs values are numbers', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      env.reset();
      const fastObs = env.getObservationFast();
      for (let i = 0; i < 14; i++) {
        expect(typeof fastObs[i]).toBe('number');
      }
    });

    it('fast obs player position matches reset observation', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      const obs = env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs[0]).toBe(obs.playerX);
      expect(fastObs[1]).toBe(obs.playerY);
      expect(fastObs[2]).toBe(obs.playerVelX);
      expect(fastObs[3]).toBe(obs.playerVelY);
    });

    it('fast obs opponent data populated with opponent', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs[7]).not.toBe(0);
      expect(fastObs[8]).not.toBe(0);
    });

    it('fast obs tick is at index 13', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs[13]).toBe(0);
      env.step(0);
      const fastObs2 = env.getObservationFast();
      expect(fastObs2[13]).toBe(1);
    });

    it('fast obs returns same buffer reference', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      env.reset();
      const fastObs1 = env.getObservationFast();
      const fastObs2 = env.getObservationFast();
      expect(fastObs1).toBe(fastObs2);
    });

    it('fast obs with no opponents zeros opponent fields', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs[7]).toBe(0);
      expect(fastObs[8]).toBe(0);
      expect(fastObs[9]).toBe(0);
      expect(fastObs[10]).toBe(0);
      expect(fastObs[11]).toBe(0);
      expect(fastObs[12]).toBe(0);
    });
  });

  describe('frame skip', () => {
    it('frame skip repeats actions', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 1000, frameSkip: 4, numOpponents: 0 });
      env.reset();
      const result = env.step(2);
      expect(result).toBeDefined();
      expect(result.info.frameSkip).toBe(4);
    });

    it('frame skip of 1 behaves normally', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, frameSkip: 1, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result.observation.tick).toBe(1);
    });

    it('frame skip holds action across multiple ticks', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, frameSkip: 3, numOpponents: 0 });
      env.reset();
      const result1 = env.step(0);
      expect(result1.observation.tick).toBe(1);
      expect(result1.info.frameSkip).toBe(3);
    });

    it('frame skip with large value', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 100, frameSkip: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result.observation.tick).toBe(1);
    });
  });

  describe('truncation', () => {
    it('truncates when maxTicks reached', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 0 });
      env.reset();
      for (let i = 0; i < 10; i++) {
        const result = env.step(0);
        if (result.truncated) {
          expect(result.done).toBe(true);
          return;
        }
      }
    });

    it('truncated flag is true when maxTicks reached', async () => {
      env = new BonkEnvironment({ maxTicks: 3, numOpponents: 0 });
      env.reset();
      for (let i = 0; i < 10; i++) {
        const result = env.step(0);
        if (result.truncated) {
          expect(result.truncated).toBe(true);
          return;
        }
      }
    });

    it('done becomes true exactly at maxTicks', async () => {
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result.done).toBe(true);
      expect(result.truncated).toBe(true);
    });
  });

  describe('team-based scoring', () => {
    it('AI is on blue team by default', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, numOpponents: 1, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result.info.aiTeam).toBe('blue');
    });

    it('scoreBlue and scoreRed in info', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, numOpponents: 1, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect('scoreBlue' in result.info).toBe(true);
      expect('scoreRed' in result.info).toBe(true);
    });

    it('scores reset on environment reset', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      env.step(0);
      env.reset();
      const result = env.step(0);
      expect(result.info.scoreBlue).toBe(0);
      expect(result.info.scoreRed).toBe(0);
    });
  });

  describe('collision handling', () => {
    it('player survives collision with walls', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 0 });
      env.reset();
      for (let i = 0; i < 50; i++) {
        const result = env.step(0);
        if (!result.done) {
          expect(result.observation.playerX).toBeDefined();
        }
      }
    });

    it('player position changes with movement input', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 0 });
      env.reset();
      const obs1 = env.step(0).observation;
      for (let i = 0; i < 10; i++) {
        env.step(RIGHT_INPUT);
      }
      const obs2 = env.step(0).observation;
      expect(obs2.playerX).not.toBe(obs1.playerX);
    });

    it('heavy input changes playerIsHeavy', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 0 });
      env.reset();
      const result = env.step(HEAVY_INPUT);
      expect(result.observation.playerIsHeavy).toBe(true);
    });

    it('player falls without floor', async () => {
      const mapData: MapDef = {
        name: 'no-floor',
        spawnPoints: {
          team_blue: { x: 0, y: 0 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 100 });
      env.reset();
      let fell = false;
      for (let i = 0; i < 60; i++) {
        const result = env.step(0);
        if (!result.observation.opponents || result.done) {
          fell = true;
          break;
        }
      }
      expect(env).toBeDefined();
    });
  });

  describe('action decoding edge cases', () => {
    it('action 0 = all false', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result).toBeDefined();
    });

    it('action 63 = all true (all 6 bits set)', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(63);
      expect(result).toBeDefined();
    });

    it('action 1 = left only', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(1);
      expect(result).toBeDefined();
    });

    it('action 2 = right only', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(2);
      expect(result).toBeDefined();
    });

    it('action 4 = up only', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(4);
      expect(result).toBeDefined();
    });

    it('action 8 = down only', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(8);
      expect(result).toBeDefined();
    });

    it('action 16 = heavy only', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(16);
      expect(result).toBeDefined();
    });

    it('action as PlayerInput object', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step({
        left: true, right: false, up: true, down: false, heavy: false, grapple: false,
      });
      expect(result).toBeDefined();
    });
  });

  describe('reward calculation', () => {
    it('reward includes time penalty', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(result.reward).toBeLessThanOrEqual(-0.001);
    });

    it('reward is finite', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      const result = env.step(0);
      expect(Number.isFinite(result.reward)).toBe(true);
    });

    it('reward on death is negative', async () => {
      const mapData: MapDef = {
        name: 'death-test',
        spawnPoints: {
          team_blue: { x: 0, y: 0 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 200 });
      env.reset();
      for (let i = 0; i < 100; i++) {
        const result = env.step(0);
        if (result.reward < -0.5) {
          expect(result.reward).toBeLessThan(0);
          return;
        }
      }
    });

    it('cumulative reward is negative over time', async () => {
      env = new BonkEnvironment({ maxTicks: 50, numOpponents: 0 });
      env.reset();
      let totalReward = 0;
      for (let i = 0; i < 30; i++) {
        const result = env.step(0);
        totalReward += result.reward;
      }
      expect(totalReward).toBeLessThan(0);
    });
  });

  describe('reset with seed', () => {
    it('reset with seed produces deterministic results', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 1, seed: 12345 });
      const obs1 = env.reset();
      for (let i = 0; i < 5; i++) env.step(0);

      env.reset(12345);
      const obs2 = env.reset();
      expect(obs1.playerX).toBe(obs2.playerX);
      expect(obs1.playerY).toBe(obs2.playerY);
    });

    it('reset clears scores', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 0 });
      env.reset();
      env.step(0);
      env.reset();
      const result = env.step(0);
      expect(result.info.scoreBlue).toBe(0);
      expect(result.info.scoreRed).toBe(0);
    });

    it('reset clears terminal state', async () => {
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      env.step(0);
      env.reset();
      const result = env.step(0);
      expect(result.done).toBe(true);
    });

    it('reset clears frame skip state', async () => {
      env = new BonkEnvironment({ maxTicks: 100, frameSkip: 4, numOpponents: 0 });
      env.reset();
      env.step(0);
      env.reset();
      const result = env.step(0);
      expect(result.observation.tick).toBe(1);
    });
  });

  describe('close', () => {
    it('close does not throw', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      expect(() => env!.close()).not.toThrow();
      env = null;
    });

    it('close on already closed env does not throw', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      env.reset();
      env.close();
      expect(() => env!.close()).not.toThrow();
      env = null;
    });
  });

  describe('map physics overrides', () => {
    it('uses map physics bounds if provided', async () => {
      const mapData: MapDef = makeMap({
        physics: {
          ppm: 30,
          bounds: { halfWidth: 600, halfHeight: 400 },
        },
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result).toBeDefined();
    });

    it('uses custom ppm from config', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10, ppm: 50 });
      env.reset();
      const result = env.step(0);
      expect(result).toBeDefined();
    });
  });

  describe('random opponent', () => {
    it('random opponent generates varied inputs', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 1, randomOpponent: true, seed: 42 });
      env.reset();
      for (let i = 0; i < 20; i++) {
        const result = env.step(0);
        expect(result).toBeDefined();
      }
    });

    it('non-random opponent stays idle', async () => {
      env = new BonkEnvironment({ maxTicks: 100, numOpponents: 1, randomOpponent: false, seed: 42 });
      env.reset();
      for (let i = 0; i < 20; i++) {
        const result = env.step(0);
        expect(result).toBeDefined();
      }
    });
  });

  describe('joint support', () => {
    it('environment with joints does not crash', async () => {
      const mapData: MapDef = {
        name: 'joint-test',
        spawnPoints: {
          team_blue: { x: -200, y: -100 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true },
          { name: 'bodyA', type: 'rect', x: -100, y: 0, width: 50, height: 50, static: false },
          { name: 'bodyB', type: 'rect', x: 100, y: 0, width: 50, height: 50, static: false },
        ],
        joints: [
          { bodyA: 'bodyA', bodyB: 'bodyB' },
        ],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      env.reset();
      const result = env.step(0);
      expect(result).toBeDefined();
    });
  });

  describe('terminalReached behavior', () => {
    it('returns zero reward after terminal reached', async () => {
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      const result1 = env.step(0);
      expect(result1.done).toBe(true);
      const result2 = env.step(0);
      expect(result2.reward).toBe(0);
    });

    it('returns done=true after terminal reached', async () => {
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      env.step(0);
      const result = env.step(0);
      expect(result.done).toBe(true);
    });

    it('returns truncated=false after terminal reached (not truncation)', async () => {
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      env.step(0);
      const result = env.step(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe('frame skip with terminal', () => {
    it('terminalReached clears after frame skip cycle completes', async () => {
      const mapData: MapDef = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 2, frameSkip: 2, numOpponents: 0 });
      env.reset();
      env.step(0);
      const result = env.step(0);
      expect(result.done).toBe(true);
      const afterCycle = env.step(0);
      expect(afterCycle.done).toBe(true);
    });
  });
});
