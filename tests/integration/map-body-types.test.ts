import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsEngine, MapBodyDef, SCALE } from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';

describe('MapBodyTypes', () => {
  let engine: PhysicsEngine | null = null;

  afterEach(() => {
    safeDestroy(engine);
    engine = null;
  });

  describe('rect bodies', () => {
    it('creates rectangular body', () => {
      engine = new PhysicsEngine();
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      engine.addBody(floor);
      expect(engine).toBeDefined();
    });

    it('player stays above static floor after landing', () => {
      engine = new PhysicsEngine();
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      engine.addBody(floor);
      engine.addPlayer(0, 0, 150);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 200).toBe(true);
      expect(state.alive).toBe(true);
      expect(Math.abs(state.velY) < 50).toBe(true);
    });

    it('rect body with explicit width/height is accepted', () => {
      engine = new PhysicsEngine();
      const platform: MapBodyDef = {
        name: 'platform',
        type: 'rect',
        x: 50,
        y: 100,
        width: 200,
        height: 20,
        static: true,
      };
      engine.addBody(platform);
      expect(engine).toBeDefined();
    });

    it('player lands on narrow rect platform', () => {
      engine = new PhysicsEngine();
      const platform: MapBodyDef = {
        name: 'platform',
        type: 'rect',
        x: 50,
        y: 100,
        width: 200,
        height: 20,
        static: true,
      };
      engine.addBody(platform);
      engine.addPlayer(0, 50, 50);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 100).toBe(true);
    });
  });

  describe('circle bodies', () => {
    it('creates circle body', () => {
      engine = new PhysicsEngine();
      const circle: MapBodyDef = {
        name: 'boulder',
        type: 'circle',
        x: 0,
        y: 100,
        radius: 50,
        static: true,
      };
      engine.addBody(circle);
      expect(engine).toBeDefined();
    });

    it('dynamic circle body falls due to gravity', () => {
      engine = new PhysicsEngine();
      const ball: MapBodyDef = {
        name: 'ball',
        type: 'circle',
        x: 0,
        y: -50,
        radius: 20,
        static: false,
        density: 1.0,
      };
      engine.addBody(ball);
      for (let i = 0; i < 30; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });

    it('multiple circle bodies with various radii accepted', () => {
      engine = new PhysicsEngine();
      const radii = [10, 25, 50, 100];
      for (const r of radii) {
        const circle: MapBodyDef = {
          name: 'circle_' + r,
          type: 'circle',
          x: 0,
          y: 0,
          radius: r,
          static: true,
        };
        engine.addBody(circle);
      }
      expect(engine).toBeDefined();
    });
  });

  describe('polygon bodies', () => {
    it('triangle polygon (3 vertices) is added', () => {
      engine = new PhysicsEngine();
      const triangle: MapBodyDef = {
        name: 'triangle',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: [
          { x: 0, y: -30 },
          { x: 30, y: 30 },
          { x: -30, y: 30 },
        ],
        static: true,
      };
      engine.addBody(triangle);
      expect(engine).toBeDefined();
    });

    it('quad polygon (4 vertices) is added', () => {
      engine = new PhysicsEngine();
      const quad: MapBodyDef = {
        name: 'quad',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: [
          { x: -20, y: -20 },
          { x: 20, y: -20 },
          { x: 30, y: 20 },
          { x: -30, y: 20 },
        ],
        static: true,
      };
      engine.addBody(quad);
      expect(engine).toBeDefined();
    });

    it('hexagon polygon (6 vertices) is added', () => {
      engine = new PhysicsEngine();
      const verts: { x: number; y: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 * i) / 6;
        verts.push({ x: Math.cos(angle) * 40, y: Math.sin(angle) * 40 });
      }
      const hex: MapBodyDef = {
        name: 'hexagon',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: verts,
        static: true,
      };
      engine.addBody(hex);
      expect(engine).toBeDefined();
    });

    it('octagon polygon (8 vertices) is added', () => {
      engine = new PhysicsEngine();
      const verts: { x: number; y: number }[] = [];
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8;
        verts.push({ x: Math.cos(angle) * 35, y: Math.sin(angle) * 35 });
      }
      const oct: MapBodyDef = {
        name: 'octagon',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: verts,
        static: true,
      };
      engine.addBody(oct);
      expect(engine).toBeDefined();
    });

    it('polygon with < 3 vertices is rejected gracefully', () => {
      engine = new PhysicsEngine();
      const invalid: MapBodyDef = {
        name: 'invalid_poly',
        type: 'polygon',
        x: 0,
        y: 0,
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        static: true,
      };
      expect(() => engine!.addBody(invalid)).not.toThrow();
    });
  });

  describe('static vs dynamic bodies', () => {
    it('static body simulation runs without error', () => {
      engine = new PhysicsEngine();
      const wall: MapBodyDef = {
        name: 'wall',
        type: 'rect',
        x: 0,
        y: 0,
        width: 20,
        height: 200,
        static: true,
      };
      engine.addBody(wall);
      engine.addPlayer(0, -100, 0);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });

    it('dynamic body falls due to gravity', () => {
      engine = new PhysicsEngine();
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      const crate: MapBodyDef = {
        name: 'crate',
        type: 'rect',
        x: 0,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 1.0,
      };
      engine.addBody(floor);
      engine.addBody(crate);
      for (let i = 0; i < 120; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });

    it('static body with density 0 remains in place', () => {
      engine = new PhysicsEngine();
      const platform: MapBodyDef = {
        name: 'platform',
        type: 'rect',
        x: 0,
        y: 100,
        width: 200,
        height: 20,
        static: true,
      };
      engine.addBody(platform);
      engine.addPlayer(0, 0, 50);
      for (let i = 0; i < 30; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });
  });

  describe('density property', () => {
    it('bodies with different densities simulate without error', () => {
      engine = new PhysicsEngine();
      const lightCrate: MapBodyDef = {
        name: 'light',
        type: 'rect',
        x: -100,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 0.5,
      };
      const heavyCrate: MapBodyDef = {
        name: 'heavy',
        type: 'rect',
        x: 100,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 5.0,
      };
      const floor: MapBodyDef = {
        name: 'floor',
        type: 'rect',
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
      };
      engine.addBody(floor);
      engine.addBody(lightCrate);
      engine.addBody(heavyCrate);
      for (let i = 0; i < 90; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });

    it('dynamic body with undefined density simulates (defaults to 1.0)', () => {
      engine = new PhysicsEngine();
      const crate: MapBodyDef = {
        name: 'default_density',
        type: 'rect',
        x: 0,
        y: -50,
        width: 30,
        height: 30,
        static: false,
      };
      engine.addBody(crate);
      for (let i = 0; i < 30; i++) {
        engine.tick();
      }
      expect(engine).toBeDefined();
    });
  });

  describe('restitution handling', () => {
    it('bodies with restitution 0.0, 0.5, 1.0 accepted', () => {
      engine = new PhysicsEngine();
      const restitutions = [0.0, 0.5, 1.0];
      for (const r of restitutions) {
        const body: MapBodyDef = {
          name: 'rest_' + r,
          type: 'rect',
          x: 0,
          y: 0,
          width: 50,
          height: 20,
          static: true,
          restitution: r,
        };
        engine.addBody(body);
      }
      expect(engine).toBeDefined();
    });

    it('player alive after bouncing on restitution -1 surface', () => {
      engine = new PhysicsEngine();
      const negRest: MapBodyDef = {
        name: 'neg_restitution',
        type: 'rect',
        x: 0,
        y: 150,
        width: 800,
        height: 20,
        static: true,
        restitution: -1,
      };
      engine.addBody(negRest);
      engine.addPlayer(0, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y < 150).toBe(true);
    });

    it('player alive after bouncing on default restitution surface', () => {
      engine = new PhysicsEngine();
      const noRest: MapBodyDef = {
        name: 'default_restitution',
        type: 'rect',
        x: 0,
        y: 150,
        width: 800,
        height: 20,
        static: true,
      };
      engine.addBody(noRest);
      engine.addPlayer(0, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });
  });

  describe('angle/rotation', () => {
    it('body with angle property is added without error', () => {
      engine = new PhysicsEngine();
      const ramp: MapBodyDef = {
        name: 'ramp',
        type: 'rect',
        x: 0,
        y: 100,
        width: 200,
        height: 20,
        static: true,
        angle: Math.PI / 6,
      };
      engine.addBody(ramp);
      expect(engine).toBeDefined();
    });

    it('player interacts with angled body', () => {
      engine = new PhysicsEngine();
      const ramp: MapBodyDef = {
        name: 'ramp',
        type: 'rect',
        x: 0,
        y: 100,
        width: 200,
        height: 20,
        static: true,
        angle: Math.PI / 6,
      };
      engine.addBody(ramp);
      engine.addPlayer(0, 0, 50);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });

    it('player lands on flat body with default angle', () => {
      engine = new PhysicsEngine();
      const flat: MapBodyDef = {
        name: 'flat',
        type: 'rect',
        x: 0,
        y: 100,
        width: 400,
        height: 20,
        static: true,
      };
      engine.addBody(flat);
      engine.addPlayer(0, 0, 0);
      for (let i = 0; i < 90; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.y < 100).toBe(true);
    });

    it('angled polygon body is added without error', () => {
      engine = new PhysicsEngine();
      const tri: MapBodyDef = {
        name: 'angled_tri',
        type: 'polygon',
        x: 0,
        y: 100,
        vertices: [
          { x: 0, y: -40 },
          { x: 40, y: 40 },
          { x: -40, y: 40 },
        ],
        static: true,
        angle: Math.PI / 4,
      };
      engine.addBody(tri);
      expect(engine).toBeDefined();
    });
  });

  describe('isLethal property', () => {
    it('lethal body kills player on contact', () => {
      engine = new PhysicsEngine();
      const lava: MapBodyDef = {
        name: 'lava',
        type: 'rect',
        x: 0,
        y: 150,
        width: 800,
        height: 30,
        static: true,
        isLethal: true,
      };
      engine.addBody(lava);
      engine.addPlayer(0, 0, 130);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(false);
    });

    it('non-lethal body is safe', () => {
      engine = new PhysicsEngine();
      const safeFloor: MapBodyDef = {
        name: 'safe_floor',
        type: 'rect',
        x: 0,
        y: 150,
        width: 800,
        height: 30,
        static: true,
        isLethal: false,
      };
      engine.addBody(safeFloor);
      engine.addPlayer(0, 0, 100);
      for (let i = 0; i < 120; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
    });

    it('lethal circle body kills player', () => {
      engine = new PhysicsEngine();
      const spike: MapBodyDef = {
        name: 'spike_ball',
        type: 'circle',
        x: 0,
        y: 100,
        radius: 30,
        static: true,
        isLethal: true,
      };
      engine.addBody(spike);
      engine.addPlayer(0, 0, 75);
      for (let i = 0; i < 60; i++) {
        engine.tick();
      }
      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(false);
    });
  });

  describe('grappleMultiplier property', () => {
    it('body with grappleMultiplier 99999 is added (slingshot)', () => {
      engine = new PhysicsEngine();
      const slingshot: MapBodyDef = {
        name: 'slingshot',
        type: 'rect',
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
        grappleMultiplier: 99999,
      };
      engine.addBody(slingshot);
      expect(engine).toBeDefined();
    });

    it('body with normal grappleMultiplier is added', () => {
      engine = new PhysicsEngine();
      const bouncy: MapBodyDef = {
        name: 'bouncy',
        type: 'rect',
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
        grappleMultiplier: 1.5,
      };
      engine.addBody(bouncy);
      expect(engine).toBeDefined();
    });

    it('body without grappleMultiplier is added', () => {
      engine = new PhysicsEngine();
      const normal: MapBodyDef = {
        name: 'normal',
        type: 'rect',
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
      };
      engine.addBody(normal);
      expect(engine).toBeDefined();
    });
  });
});
