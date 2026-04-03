import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsEngine, PlayerInput, MapBodyDef, SCALE, DT, TPS } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('CollisionFiltering', () => {
  let engine: PhysicsEngine | null = null;

  afterEach(() => {
    safeDestroy(engine);
    engine = null;
  });

  const RIGHT_INPUT: PlayerInput = {
    left: false,
    right: true,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
  };

  const LEFT_INPUT: PlayerInput = {
    left: true,
    right: false,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
  };

  function makeWall(wallX: number, collides?: MapBodyDef['collides']): MapBodyDef {
    return {
      name: 'wall',
      type: 'rect',
      x: wallX,
      y: 0,
      width: 20,
      height: 2000,
      static: true,
      collides,
    };
  }

  function runCollisionScenario(
    playerId: number,
    startX: number,
    wallX: number,
    input: PlayerInput,
    collides?: MapBodyDef['collides'],
    ticks: number = 60,
  ): { finalX: number; engine: PhysicsEngine } {
    const eng = new PhysicsEngine();
    eng.addPlayer(playerId, startX, 0);
    eng.addBody(makeWall(wallX, collides));

    for (let i = 0; i < ticks; i++) {
      eng.applyInput(playerId, input);
      eng.tick();
    }

    const state = eng.getPlayerState(playerId);
    return { finalX: state.x, engine: eng };
  }

  describe('default collision behavior', () => {
    it('player 0 blocked by default wall', () => {
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('player 1 blocked by default wall', () => {
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('collides.g1=false', () => {
    it('player 0 passes through wall with g1=false', () => {
      const collides = { g1: false, g2: true, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('player 1 blocked by wall with g1=false (g2 still true)', () => {
      const collides = { g1: false, g2: true, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('collides.g2=false', () => {
    it('player 1 passes through wall with g2=false', () => {
      const collides = { g1: true, g2: false, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('player 0 blocked by wall with g2=false (g1 still true)', () => {
      const collides = { g1: true, g2: false, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('all collides false', () => {
    it('player 0 passes through wall with all collides false', () => {
      const collides = { g1: false, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('player 1 passes through wall with all collides false', () => {
      const collides = { g1: false, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });
  });

  describe('all collides true', () => {
    it('player 0 blocked by wall with all collides true', () => {
      const collides = { g1: true, g2: true, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('player 1 blocked by wall with all collides true', () => {
      const collides = { g1: true, g2: true, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('only g1 true', () => {
    it('player 0 blocked when only g1=true', () => {
      const collides = { g1: true, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('player 1 passes when only g1=true', () => {
      const collides = { g1: true, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });
  });

  describe('only g2 true', () => {
    it('player 0 passes when only g2=true', () => {
      const collides = { g1: false, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('player 1 blocked when only g2=true', () => {
      const collides = { g1: false, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('g1+g2 both true', () => {
    it('player 0 blocked when g1+g2=true', () => {
      const collides = { g1: true, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('player 1 blocked when g1+g2=true', () => {
      const collides = { g1: true, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });
  });

  describe('g3/g4 only', () => {
    it('player 0 passes when only g3/g4=true', () => {
      const collides = { g1: false, g2: false, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('player 1 passes when only g3/g4=true', () => {
      const collides = { g1: false, g2: false, g3: true, g4: true };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });
  });

  describe('player category bits', () => {
    it('player 0 (category 0x0002) collides with g1=true body', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      const collides_g1_true = { g1: true, g2: false, g3: false, g4: false };
      const { finalX } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides_g1_true);
      expect(finalX < 50).toBe(true);
    });

    it('player 1 (category 0x0004) collides with g2=true body', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(1, 0, 0);
      const collides_g2_true = { g1: false, g2: true, g3: false, g4: false };
      const { finalX } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides_g2_true);
      expect(finalX < 50).toBe(true);
    });
  });

  describe('team barriers', () => {
    it('g1 barrier blocks player 0', () => {
      const g1Barrier = { g1: true, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, g1Barrier);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('g1 barrier lets player 1 pass', () => {
      const g1Barrier = { g1: true, g2: false, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, g1Barrier);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });

    it('g2 barrier blocks player 1', () => {
      const g2Barrier = { g1: false, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, g2Barrier);
      expect(finalX < 50).toBe(true);
      eng.destroy();
    });

    it('g2 barrier lets player 0 pass', () => {
      const g2Barrier = { g1: false, g2: true, g3: false, g4: false };
      const { finalX, engine: eng } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, g2Barrier);
      expect(finalX > 50).toBe(true);
      eng.destroy();
    });
  });

  describe('dynamic body with collides', () => {
    it('player 0 passes through dynamic body with g1=false', () => {
      engine = new PhysicsEngine();
      const dynamicBody: MapBodyDef = {
        name: 'dynamic_block',
        type: 'rect',
        x: 50,
        y: 0,
        width: 20,
        height: 20,
        static: false,
        density: 1.0,
        collides: { g1: false, g2: true, g3: false, g4: false },
      };
      engine.addBody(dynamicBody);
      engine.addPlayer(0, 0, 0);
      for (let i = 0; i < 60; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > 50).toBe(true);
    });
  });

  describe('multiple bodies with different collides settings', () => {
    it('player 0 blocked by g1 wall at x=30', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'g1_wall',
        type: 'rect',
        x: 30,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: true, g2: false, g3: false, g4: false },
      });
      engine.addBody({
        name: 'g2_wall',
        type: 'rect',
        x: 70,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: false, g2: true, g3: false, g4: false },
      });
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.applyInput(1, RIGHT_INPUT);
        engine.tick();
      }
      const p0 = engine.getPlayerState(0);
      expect(p0.x < 35).toBe(true);
    });

    it('player 1 passes through g1 wall at x=30', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'g1_wall',
        type: 'rect',
        x: 30,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: true, g2: false, g3: false, g4: false },
      });
      engine.addBody({
        name: 'g2_wall',
        type: 'rect',
        x: 70,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: false, g2: true, g3: false, g4: false },
      });
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.applyInput(1, RIGHT_INPUT);
        engine.tick();
      }
      const p1 = engine.getPlayerState(1);
      expect(p1.x > 35).toBe(true);
    });

    it('player 1 blocked by g2 wall at x=70', () => {
      engine = new PhysicsEngine();
      engine.addBody({
        name: 'g1_wall',
        type: 'rect',
        x: 30,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: true, g2: false, g3: false, g4: false },
      });
      engine.addBody({
        name: 'g2_wall',
        type: 'rect',
        x: 70,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: false, g2: true, g3: false, g4: false },
      });
      engine.addPlayer(0, 0, 0);
      engine.addPlayer(1, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.applyInput(1, RIGHT_INPUT);
        engine.tick();
      }
      const p1 = engine.getPlayerState(1);
      expect(p1.x < 75).toBe(true);
    });
  });

  describe('undefined vs explicit true collides', () => {
    it('no collides property blocks player 0', () => {
      const { finalX: noFilter } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, undefined);
      expect(noFilter < 50).toBe(true);
    });

    it('all-true collides blocks player 0', () => {
      const { finalX: allTrue } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, {
        g1: true,
        g2: true,
        g3: true,
        g4: true,
      });
      expect(allTrue < 50).toBe(true);
    });
  });

  describe('player moves freely without wall', () => {
    it('player 0 moves right past x=50 without any wall', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      for (let i = 0; i < 60; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > 50).toBe(true);
    });
  });

  describe('opposite direction collision', () => {
    it('player 0 blocked moving left into g1 wall', () => {
      const collides = { g1: true, g2: false, g3: false, g4: false };
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);
      engine.addBody(makeWall(-50, collides));
      for (let i = 0; i < 60; i++) {
        engine.applyInput(0, LEFT_INPUT);
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.x > -50).toBe(true);
    });

    it('player 1 passes through g1 wall moving left', () => {
      const collides = { g1: true, g2: false, g3: false, g4: false };
      engine = new PhysicsEngine();
      engine.addPlayer(1, 0, 0);
      engine.addBody(makeWall(-50, collides));
      for (let i = 0; i < 60; i++) {
        engine.applyInput(1, LEFT_INPUT);
        engine.tick();
      }
      const state = engine.getPlayerState(1);
      expect(state.x < -50).toBe(true);
    });
  });
});
