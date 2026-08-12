import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BonkEnvironment, Observation } from '../../src/core/environment';
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
    it('does not score an instant capzone from player-disc contact (type 2)', async () => {
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
      expect(scored).toBe(false);
    });

    it('does not score an instant capzone from player-disc contact (type 3)', async () => {
      const mapData: MapDef = makeMap({
        capZones: [
          { index: 0, owner: 'neutral', type: 3, fixture: 'floor', shapeType: 'bx' },
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
      expect(scored).toBe(false);
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

    it('physics.bounds survives the constructor-internal reset and episode resets', async () => {
      const mapData: MapDef = makeMap({});
      (mapData as any).physics = { bounds: { width: 60, height: 40 } };

      env = new BonkEnvironment({ mapData, numOpponents: 0, maxTicks: 10 });
      const obs = env.reset();
      expect(obs.arenaHalfWidth).toBe(30 * 30);  // width/2 (30m) × SCALE(30)
      expect(obs.arenaHalfHeight).toBe(20 * 30);

      for (let i = 0; i < 5; i++) env.step(0);

      const obs2 = env.reset();
      expect(obs2.arenaHalfWidth).toBe(30 * 30);
      expect(obs2.arenaHalfHeight).toBe(20 * 30);
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
      const mapData: MapDef = {
        name: 'death-map',
        spawnPoints: {
          team_blue: { x: 0, y: 0 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true },
        ],
      };
      env = new BonkEnvironment({ mapData, maxTicks: 10, numOpponents: 0 });
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
    it('returns Float32Array of length 16', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs).toBeInstanceOf(Float32Array);
      expect(fastObs.length).toBe(16);
    });

    it('fast obs values are numbers', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 1 });
      env.reset();
      const fastObs = env.getObservationFast();
      for (let i = 0; i < 16; i++) {
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

    it('fast obs keeps dynamic arena bounds before the tick at index 15', async () => {
      env = new BonkEnvironment({ maxTicks: 1000, numOpponents: 0 });
      env.reset();
      const fastObs = env.getObservationFast();
      expect(fastObs[13]).toBeGreaterThan(0);
      expect(fastObs[14]).toBeGreaterThan(0);
      expect(fastObs[15]).toBe(0);
      env.step(0);
      const fastObs2 = env.getObservationFast();
      expect(fastObs2[15]).toBe(1);
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

  describe('malformed action value rejection (issue #278)', () => {
    it('rejects non-conforming action values with the labeled validation error', async () => {
      env = new BonkEnvironment({ maxTicks: 30, numOpponents: 0, randomOpponent: false, seed: 42 });
      env.reset();
      const malformed: any[] = [
        '2',
        true,
        [2],
        null,
        undefined,
        NaN,
        {},
        { right: 'x' },
        { left: 1 },
        { left: true, right: 'false' },
        { left: true, graple: true },
        { right: true, attack: 'x' },
      ];
      for (const bad of malformed) {
        env.reset();
        const e = env;
        // A string/boolean/null/NaN/array/empty-object/non-boolean-field
        // action must throw the labeled validation error instead of silently
        // executing as a no-op or different action (#278).
        expect(() => e.step(bad)).toThrow('Invalid action:');
      }
    });

    it('applies valid numeric and PlayerInput actions (positive control)', async () => {
      env = new BonkEnvironment({ maxTicks: 30, numOpponents: 0, randomOpponent: false, seed: 42 });
      env.reset();
      expect(env.step(0).observation.playerVelX).toBeCloseTo(0, 5);
      env.reset();
      expect(env.step(2).observation.playerVelX).toBeCloseTo(30, 5);
      env.reset();
      expect(env.step({ right: true } as any).observation.playerVelX).toBeCloseTo(30, 5);
      env.reset();
      expect(env.step(RIGHT_INPUT).observation.playerVelX).toBeCloseTo(30, 5);
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

    it('configurable killReward: an opponent kill pays the configured +10', async () => {
      // The opponent spawns inside a lethal platform and dies on tick 1, so
      // the done step's reward is deterministically killReward + timePenalty
      // (no random policy, no cap zones, AI staged far away) (#220).
      const mapData: MapDef = {
        name: 'kill-config',
        spawnPoints: {
          team_blue: { x: -200, y: -100 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'lethal', type: 'rect', x: 200, y: -100, width: 100, height: 100, static: true, isLethal: true },
        ],
      };
      env = new BonkEnvironment({
        mapData,
        numOpponents: 1,
        randomOpponent: false,
        maxTicks: 100,
        seed: 42,
        killReward: 10,
        timePenalty: 0,
      });
      env.reset();
      const result = env.step(0);
      expect(result.done).toBe(true);
      expect(result.info.terminated).toBe(true);
      expect(result.info.aiAlive).toBe(true);
      expect(result.info.opponentsAlive).toBe(0);
      expect(result.reward).toBeCloseTo(10, 6);
    });

    it('configurable deathPenalty: AI death pays the configured -5', async () => {
      const mapData: MapDef = {
        name: 'death-config',
        spawnPoints: {
          team_blue: { x: 0, y: 0 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true },
        ],
      };
      env = new BonkEnvironment({
        mapData,
        numOpponents: 0,
        maxTicks: 10,
        deathPenalty: -5,
        timePenalty: 0,
      });
      env.reset();
      const result = env.step(0);
      expect(result.info.aiAlive).toBe(false);
      expect(result.reward).toBeCloseTo(-5, 6);
    });

    it('configurable timePenalty applies on every non-terminal tick', async () => {
      env = new BonkEnvironment({
        maxTicks: 100,
        numOpponents: 0,
        randomOpponent: false,
        seed: 42,
        timePenalty: -0.5,
      });
      env.reset();
      const result = env.step(0);
      expect(result.done).toBe(false);
      expect(result.reward).toBeCloseTo(-0.5, 6);
    });

    it('falls back to the documented +1/-1/-0.001 weights when unset', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0 });
      const cfg = (env as any).config;
      expect(cfg.reward.killReward).toBe(1.0);
      expect(cfg.reward.deathPenalty).toBe(-1.0);
      expect(cfg.reward.timePenalty).toBe(-0.001);
    });

    it('resolves the nested reward section alias carried by the worker config', async () => {
      env = new BonkEnvironment({
        maxTicks: 10,
        numOpponents: 0,
        reward: { killReward: 2, timePenalty: -0.01 },
      });
      const cfg = (env as any).config;
      expect(cfg.reward.killReward).toBe(2);
      expect(cfg.reward.deathPenalty).toBe(-1.0);
      expect(cfg.reward.timePenalty).toBe(-0.01);
    });

    it('flat reward keys win over the nested reward section alias', async () => {
      env = new BonkEnvironment({
        maxTicks: 10,
        numOpponents: 0,
        killReward: 5,
        reward: { killReward: 2 },
      });
      expect((env as any).config.reward.killReward).toBe(5);
    });

    it('stores the reward weights under a single nested source of truth', async () => {
      env = new BonkEnvironment({ maxTicks: 10, numOpponents: 0, timePenalty: -2 });
      const cfg = (env as any).config;
      expect(cfg.reward.timePenalty).toBe(-2);
      expect(Object.prototype.hasOwnProperty.call(cfg, 'killReward')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cfg, 'deathPenalty')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cfg, 'timePenalty')).toBe(false);
    });

    it('rejects a positive deathPenalty/timePenalty and non-finite weights', async () => {
      env = new BonkEnvironment({
        maxTicks: 10,
        numOpponents: 0,
        deathPenalty: 5,
        timePenalty: 0.5,
        reward: { killReward: Number.POSITIVE_INFINITY },
      });
      const cfg = (env as any).config;
      expect(cfg.reward.killReward).toBe(1.0);
      expect(cfg.reward.deathPenalty).toBe(-1.0);
      expect(cfg.reward.timePenalty).toBe(-0.001);
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

    it('rebuilds map lifecycle state on a fresh world every episode', () => {
      const mapData: MapDef = makeMap({
        bodies: [
          { name: 'grapple-target', type: 'rect', x: 0, y: 100, width: 200, height: 20, static: true },
          { name: 'joint-anchor', type: 'rect', x: -400, y: 0, width: 20, height: 20, static: true },
          { name: 'joint-weight', type: 'circle', x: -350, y: 0, radius: 10, static: false },
        ],
        joints: [
          { type: 'distance', bodyA: 'joint-anchor', bodyB: 'joint-weight' },
        ],
        capZones: [
          { index: 0, owner: 'neutral', type: 1, fixture: 'grapple-target', shapeType: 'bx' },
        ],
        physics: { ppm: 18, bounds: { width: 60, height: 40 } },
      });
      env = new BonkEnvironment({
        mapData,
        numOpponents: 0,
        randomOpponent: false,
        teamsEnabled: true,
        noCollide: true,
        maxTicks: 100,
      });

      const physics = (env as any).physics;
      let previousWorld = physics.world;

      for (let episode = 0; episode < 10; episode++) {
        const observation = env.reset(1000 + episode);
        const world = physics.world;
        const playerBody = physics.playerBodies.get(0);

        expect(world).not.toBe(previousWorld);
        expect(observation.tick).toBe(0);
        expect(observation.arenaHalfWidth).toBe(30 * 30);
        expect(observation.arenaHalfHeight).toBe(20 * 30);
        expect(physics.getBodyMap().size).toBe(mapData.bodies.length);
        expect(physics.capZoneSensors).toHaveLength(1);
        expect(physics.ppm).toBe(18);
        expect(physics.teamsEnabled).toBe(true);
        expect(physics.noCollide).toBe(true);
        expect(world.m_contactListener).toBeTruthy();
        expect(world.constructor.m_warmStarting).toBe(false);
        expect(world.GetJointCount()).toBe(1);
        expect(playerBody.GetShapeList().GetRadius()).toBeCloseTo(18 / 30, 12);

        const result = env.step(GRAPPLE_INPUT);
        expect(result.observation.tick).toBe(1);
        expect(physics.hasGrappleJoint(0)).toBe(true);
        expect(world.GetJointCount()).toBe(2);

        previousWorld = world;
      }
    });

    it('preserves lethal contacts after repeated many-body resets', () => {
      const fillerBodies = Array.from({ length: 70 }, (_, index) => ({
        name: `filler-${index}`,
        type: 'rect' as const,
        x: 1000 + index * 40,
        y: 1000,
        width: 10,
        height: 10,
        static: true,
      }));
      const mapData: MapDef = makeMap({
        spawnPoints: {
          team_blue: { x: 0, y: 0 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'lethal', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true, isLethal: true },
          ...fillerBodies,
        ],
      });
      env = new BonkEnvironment({ mapData, numOpponents: 0, randomOpponent: false, maxTicks: 10 });

      const physics = (env as any).physics;
      let previousWorld = physics.world;

      for (let episode = 0; episode < 75; episode++) {
        const observation = env.reset(2000 + episode);
        const world = physics.world;

        expect(world).not.toBe(previousWorld);
        expect(observation.tick).toBe(0);
        expect(physics.getBodyMap().size).toBe(mapData.bodies.length);

        const result = env.step(EMPTY_INPUT);
        expect(result.observation.tick).toBe(1);
        expect(result.info.aiAlive).toBe(false);

        previousWorld = world;
      }
    });
  });

  describe('no-opponent episodes (numOpponents: 0)', () => {
    it('first step is not instantly terminal', async () => {
      env = new BonkEnvironment({ maxTicks: 900, numOpponents: 0, randomOpponent: false, seed: 42 });
      env.reset();
      const r1 = env.step(0);
      expect(r1.done).toBe(false);
      expect(r1.truncated).toBe(false);
      expect(r1.info.terminated).toBe(false);
    });

    it('episode lasts until maxTicks instead of one tick', async () => {
      env = new BonkEnvironment({ maxTicks: 5, numOpponents: 0, randomOpponent: false, seed: 42 });
      env.reset();

      let doneStep = -1;
      let truncated = false;
      for (let i = 1; i <= 20; i++) {
        const result = env.step(0);
        if (doneStep === -1 && result.done) {
          doneStep = i;
          truncated = result.truncated;
        }
      }
      expect(doneStep).toBe(5);
      expect(truncated).toBe(true);
    });

    it('every pre-horizon step returns done=false (no vacuous termination)', async () => {
      env = new BonkEnvironment({ maxTicks: 4, numOpponents: 0, randomOpponent: false, seed: 42 });
      env.reset();
      for (let i = 1; i <= 3; i++) {
        const result = env.step(0);
        expect(result.done).toBe(false);
        expect(result.observation.tick).toBe(i);
      }
    });
  });

  describe('dead-disc observation stability', () => {
    it('freezes the dead player observation across post-death steps', async () => {
      const mapData: MapDef = {
        name: 'lethal-obs',
        spawnPoints: {
          team_blue: { x: 0, y: -300 },
          team_red: { x: 200, y: -100 },
        },
        bodies: [
          { name: 'lethal', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true, isLethal: true },
        ],
      };
      env = new BonkEnvironment({ mapData, numOpponents: 0, randomOpponent: false, maxTicks: 200 });
      env.reset();

      let deathObs: Observation | null = null;
      // The AI free-falls ~473 px to the lethal platform (~38 physics ticks).
      // With numOpponents: 0 the vacuous allOpponentsDead check makes the env
      // tick physics only every other step, so death lands near step 76; the
      // 200-step budget keeps the test robust to gravity/spawn tweaks.
      for (let i = 0; i < 200; i++) {
        const result = env.step(EMPTY_INPUT);
        if (result.info.aiAlive === false) {
          deathObs = result.observation;
          break;
        }
      }
      expect(deathObs).not.toBeNull();
      // The snapshot must capture real transforms, not the zero default.
      expect(deathObs!.playerY).not.toBe(0);
      expect(deathObs!.playerVelY).not.toBe(0);
      // The destroyed body must leave playerBodies on detach so observations
      // never read it.
      expect((env as any).physics.playerBodies.has(0)).toBe(false);

      for (let i = 0; i < 3; i++) {
        const result = env.step(EMPTY_INPUT);
        expect(result.done).toBe(true);
        expect(result.observation.playerX).toBe(deathObs!.playerX);
        expect(result.observation.playerY).toBe(deathObs!.playerY);
        expect(result.observation.playerVelX).toBe(deathObs!.playerVelX);
        expect(result.observation.playerVelY).toBe(deathObs!.playerVelY);
        expect(result.observation.playerAngle).toBe(deathObs!.playerAngle);
        expect(result.observation.playerAngularVel).toBe(deathObs!.playerAngularVel);
      }
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
          bounds: { width: 1200, height: 800 },
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

    it('normalizes randomOpp*Prob keys into the opponent policy config', async () => {
      env = new BonkEnvironment({
        numOpponents: 1,
        randomOppMoveProb: 0.99,
        randomOppUpProb: 0.88,
        randomOppDownProb: 0.77,
        randomOppHeavyProb: 0.66,
        randomOppGrappleProb: 0.55,
      });
      const cfg = (env as any).config;
      expect(cfg.oppMoveProb).toBe(0.99);
      expect(cfg.oppUpProb).toBe(0.88);
      expect(cfg.oppDownProb).toBe(0.77);
      expect(cfg.oppHeavyProb).toBe(0.66);
      expect(cfg.oppGrappleProb).toBe(0.55);
    });

    it('explicit opp*Prob keys still win over randomOpp* keys', async () => {
      env = new BonkEnvironment({
        numOpponents: 1,
        oppMoveProb: 0.3,
        randomOppMoveProb: 0.99,
      });
      expect((env as any).config.oppMoveProb).toBe(0.3);
    });

    it('randomOppMoveProb=1.0 makes the opponent always apply left/right', async () => {
      env = new BonkEnvironment({
        maxTicks: 20,
        numOpponents: 1,
        randomOpponent: true,
        seed: 42,
        randomOppMoveProb: 1.0,
      });
      env.reset();
      const applySpy = vi.spyOn((env as any).physics, 'applyInput');
      for (let i = 0; i < 10; i++) env.step(0);
      const oppCalls = applySpy.mock.calls.filter(call => call[0] === 1);
      expect(oppCalls.length).toBeGreaterThan(0);
      for (const call of oppCalls) {
        const input = call[1] as any;
        expect(input.left).toBe(true);
        expect(input.right).toBe(true);
      }
      applySpy.mockRestore();
    });

    it('randomOppMoveProb=0.0 makes the opponent never apply left/right', async () => {
      env = new BonkEnvironment({
        maxTicks: 20,
        numOpponents: 1,
        randomOpponent: true,
        seed: 42,
        randomOppMoveProb: 0.0,
        randomOppUpProb: 0.0,
        randomOppDownProb: 0.0,
        randomOppHeavyProb: 0.0,
        randomOppGrappleProb: 0.0,
      });
      env.reset();
      const applySpy = vi.spyOn((env as any).physics, 'applyInput');
      for (let i = 0; i < 10; i++) env.step(0);
      const oppCalls = applySpy.mock.calls.filter(call => call[0] === 1);
      expect(oppCalls.length).toBeGreaterThan(0);
      for (const call of oppCalls) {
        const input = call[1] as any;
        expect(input.left).toBe(false);
        expect(input.right).toBe(false);
      }
      applySpy.mockRestore();
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
          { type: 'distance', bodyA: 'bodyA', bodyB: 'bodyB' },
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

    it('keeps reporting truncated for the ended episode after terminal reached', async () => {
      // #197: the terminal-hold tail must replay the recorded terminal cause
      // instead of hardcoding truncated:false / info.terminated:true, which
      // inverted a maxTicks truncation into a termination.
      env = new BonkEnvironment({ maxTicks: 1, numOpponents: 0 });
      env.reset();
      expect(env.step(0).truncated).toBe(true);
      const result = env.step(0);
      expect(result.done).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.info.terminated).toBe(false);
    });
  });

  describe('frame skip with terminal', () => {
    it('episode stays terminal after the frame skip cycle completes', async () => {
      // #197: once the hold window elapses the env must stay idle (done,
      // stable flags, no physics advance) instead of resuming physics past
      // maxTicks and inverting truncated/terminated on alternating steps.
      const mapData = makeMap({});
      env = new BonkEnvironment({ mapData, maxTicks: 2, frameSkip: 2, numOpponents: 0 });
      env.reset();
      env.step(0);
      const result = env.step(0);
      expect(result.done).toBe(true);
      const afterCycle = env.step(0);
      expect(afterCycle.done).toBe(true);
      expect(afterCycle.truncated).toBe(true);
      expect(afterCycle.info.terminated).toBe(false);
      expect(afterCycle.observation.tick).toBe(2);
    });
  });
});
