import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsEngine, PlayerInput, MapBodyDef, SCALE, DT, TPS } from '../../src/core/physics-engine';
import { safeDestroy, makePlatform, GRAPPLE_INPUT } from '../utils/test-helpers';

function noInput(): PlayerInput {
  return { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
}

function makePlatformDef(overrides: Partial<MapBodyDef> & { x: number; y: number }): MapBodyDef {
  return {
    name: overrides.name || 'platform',
    type: 'rect',
    width: overrides.width || 200,
    height: overrides.height || 20,
    static: overrides.static !== undefined ? overrides.static : true,
    ...overrides,
  };
}

describe('GrappleMechanics', () => {
  let engine: PhysicsEngine | null = null;
  afterEach(() => { safeDestroy(engine); engine = null; });

  describe('basic grapple', () => {
    it('attaches grapple and keeps player alive', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p1', x: 0, y: 100 }));
      engine.addPlayer(0, 0, 0);
      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('grapple joint tuning (verified swingF=2 / swingD=0)', () => {
    // Verified native (DEOBFUSCATION §32.4): the grapple joint uses
    // frequencyHz = (sep < swing.l) ? 0.01 : swingF and dampingRatio = swingD,
    // with the only table-proven writers being swingF = 2 and swingD = 0.
    // Map fh/dr fields belong to "d" joints and never affect the grapple.
    it('map fh/dr fields do not affect the grapple joint (swingF=2 / swingD=0)', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'tuned-platform',
        x: 0,
        y: 50,
        frequencyHz: 7.5,
        dampingRatio: 0.3,
      }));
      engine.addPlayer(0, 0, 0);

      expect(() => engine!.applyInput(0, GRAPPLE_INPUT)).not.toThrow();
      expect(engine.hasGrappleJoint(0)).toBe(true);

      const joint = (engine as any).playerGrappleJoints.get(0);
      // Taut at attach: separation == rest length -> swingF = 2 Hz.
      expect(joint.m_frequencyHz).toBe(2.0);
      expect(joint.m_dampingRatio).toBe(0.0);
      expect(joint.m_frequencyHz).not.toBe(7.5);
      expect(joint.m_dampingRatio).not.toBe(0.3);

      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });

    it('grapple with default tuning is stable over many ticks', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'stable-platform', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 60; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      // Grapple holds the player near the platform — no explosive displacement.
      expect(Number.isFinite(state.x)).toBe(true);
      expect(Number.isFinite(state.y)).toBe(true);
      expect(Number.isFinite(state.velX)).toBe(true);
      expect(Number.isFinite(state.velY)).toBe(true);
    });

    it('switches to the 0.01 Hz slack branch when the rope goes slack', () => {
      // Platform BELOW the player: gravity pulls the disc toward the anchor,
      // separation shrinks below the rest length -> slack -> 0.01 Hz.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'slack-platform', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      const joint = (engine as any).playerGrappleJoints.get(0);
      expect(joint.m_frequencyHz).toBe(2.0); // taut at attach (sep == length)

      for (let i = 0; i < 3; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }
      expect(joint.m_frequencyHz).toBe(0.01);
    });

    it('stays on the swingF=2 Hz branch while the rope is taut', () => {
      // Platform ABOVE the player: gravity pulls the disc away from the
      // anchor, separation grows -> stays taut -> 2 Hz.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'taut-platform', x: 0, y: -50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      const joint = (engine as any).playerGrappleJoints.get(0);
      expect(joint.m_frequencyHz).toBe(2.0);

      for (let i = 0; i < 10; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }
      expect(joint.m_frequencyHz).toBe(2.0);
    });
  });

  describe('noGrapple', () => {
    it('prevents grapple when noGrapple is true', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'no-grapple-platform',
        x: 0,
        y: 50,
        noGrapple: true,
        noPhysics: true,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 20; i++) engine.tick();
      engine.applyInput(0, noInput());
      for (let i = 0; i < 30; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(100);
    });

    it('allows grapple when noGrapple is false', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'grapple-ok',
        x: 0,
        y: 50,
        noGrapple: false,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });

    it('allows grapple when noGrapple is undefined', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'default-platform',
        x: 0,
        y: 50,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('innerGrapple', () => {
    // Verified native (§32.1 final gate, lines 8297-8306): a candidate wins
    // if `innerGrapple || !TestPoint(playerPos)` — innerGrapple only permits
    // attaching while the disc center is INSIDE the shape; it does not block
    // grappling a surface from outside.
    it('allows grapple from outside an innerGrapple platform', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inner-grapple-outside',
        x: 0,
        y: 50,
        innerGrapple: true,
        noPhysics: true,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });

    it('prevents grapple from inside a non-innerGrapple platform', () => {
      // Player starts inside the platform shape (TestPoint true), no
      // innerGrapple flag -> the candidate is skipped.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inside-no-inner',
        x: 0,
        y: 0,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(false);
    });

    it('allows grapple from inside an innerGrapple platform', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inside-inner',
        x: 0,
        y: 0,
        innerGrapple: true,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);
    });

    it('allows grapple when innerGrapple is false', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'inner-grapple-false',
        x: 0,
        y: 50,
        innerGrapple: false,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('grapple release', () => {
    it('releases grapple and player falls', () => {
      // Platform ABOVE the player: the rope is taut (swingF=2 Hz holds the
      // disc against gravity); after release the disc falls freely.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: -50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }

      const attachedState = engine.getPlayerState(0);

      engine.applyInput(0, noInput());
      for (let i = 0; i < 30; i++) engine.tick();

      const releasedState = engine.getPlayerState(0);
      expect(releasedState.y).toBeGreaterThan(attachedState.y + 50);
      expect(releasedState.alive).toBe(true);
    });

    it('re-attaches after release', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 10; i++) engine.tick();

      engine.applyInput(0, noInput());
      for (let i = 0; i < 5; i++) engine.tick();

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('grapple with movement', () => {
    it('allows horizontal velocity while swinging', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'swing-target', x: 100, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 5; i++) engine.tick();

      const rightInput: PlayerInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: true };
      engine.applyInput(0, rightInput);
      for (let i = 0; i < 20; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(Math.abs(state.velX)).toBeGreaterThan(0.1);
      expect(state.alive).toBe(true);
    });
  });

  describe('multiple players', () => {
    it('allows multiple players grappling simultaneously', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p1', x: -100, y: 50 }));
      engine.addBody(makePlatformDef({ name: 'p2', x: 100, y: 50 }));
      engine.addPlayer(0, -100, 0);
      engine.addPlayer(1, 100, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      engine.applyInput(1, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state0 = engine.getPlayerState(0);
      const state1 = engine.getPlayerState(1);
      expect(state0.alive).toBe(true);
      expect(state1.alive).toBe(true);
      expect(state0.y).toBeLessThan(200);
      expect(state1.y).toBeLessThan(200);
    });
  });

  describe('grapple to dynamic body', () => {
    it('grapples to dynamic (non-static) body', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({
        name: 'dynamic-platform',
        x: 0,
        y: 50,
        static: false,
        density: 2.0,
      }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.y).toBeLessThan(300);
    });
  });

  describe('grapple target window', () => {
    // Verified native (§32.1): QueryAABB ±10 world units around the disc
    // center, scored by center-to-surface distance < 10. There is no
    // 500/SCALE reach — the 500 literal is the a1a energy threshold.
    it('attaches when the surface is within the 10-unit window (8.0 world units)', () => {
      // 200x20 platform at y=250 map units: surface at (250-10)/30 = 8.0
      // world units below the player at (0,0) — inside the window.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'in-window', x: 0, y: 250 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);
    });

    it('fails to attach when the surface is beyond the 10-unit window (10.33 world units)', () => {
      // 200x20 platform at y=320 map units: surface at (320-10)/30 = 10.33
      // world units away — outside the window.
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'out-window', x: 0, y: 320 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(false);
    });

    it('fails to grapple when platform is beyond the window (surface 16.33 world units away)', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'far-platform', x: 0, y: 0 }));
      engine.addPlayer(0, 0, 500);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(false);
      for (let i = 0; i < 20; i++) engine.tick();

      engine.applyInput(0, noInput());
      for (let i = 0; i < 10; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(400);
    });

    it('grapples the closer of two in-window surfaces', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'near', x: 0, y: 100 }));
      engine.addBody(makePlatformDef({ name: 'far-but-in-window', x: 0, y: 200 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);

      const joint = (engine as any).playerGrappleJoints.get(0);
      const anchorBody = joint.GetBody2();
      expect(anchorBody.GetUserData().name).toBe('near');
    });
  });

  describe('a1a grapple energy meter', () => {
    // Verified native (§32.3): spawn 1000; fire gate a1a > 500; drain 4/step
    // while swinging with forced release and zeroing below 500; recharge
    // 3/step otherwise, capped at 1000.
    it('spawns with full energy and can fire immediately', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      expect(engine.getGrappleEnergy(0)).toBe(1000);
      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);
    });

    it('drains 4/step while swinging and force-releases when a1a drops below 500', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 125; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }
      // 1000 - 125*4 = 500: exactly at the threshold, still swinging.
      expect(engine.hasGrappleJoint(0)).toBe(true);
      expect(engine.getGrappleEnergy(0)).toBe(500);

      // One more tick: 496 < 500 -> forced release and zeroing.
      engine.applyInput(0, GRAPPLE_INPUT);
      engine.tick();
      expect(engine.hasGrappleJoint(0)).toBe(false);
      expect(engine.getGrappleEnergy(0)).toBe(0);
    });

    it('cannot re-fire while energy is below 500 and recharges 3/step', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 126; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }
      // Forced release at 126 ticks; energy zeroed.
      expect(engine.hasGrappleJoint(0)).toBe(false);
      expect(engine.getGrappleEnergy(0)).toBe(0);

      // Holding grapple below the threshold must not attach.
      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(false);

      // Recharge 3/step: after 167 ticks energy = 501 > 500 -> re-fire.
      for (let i = 0; i < 167; i++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
      }
      expect(engine.getGrappleEnergy(0)).toBe(501);
      // The energy gate re-opens above 500: the next grapple press attaches.
      engine.applyInput(0, GRAPPLE_INPUT);
      expect(engine.hasGrappleJoint(0)).toBe(true);
    });
  });

  describe('heavy + grapple combo', () => {
    it('player survives heavy and grapple simultaneously', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      const heavyGrapple: PlayerInput = { left: false, right: false, up: false, down: false, heavy: true, grapple: true };
      engine.applyInput(0, heavyGrapple);
      for (let i = 0; i < 15; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);
      expect(state.isHeavy).toBe(true);
      expect(state.y).toBeLessThan(200);
    });
  });

  describe('rapid grapple toggle', () => {
    it('player survives rapid grapple on/off cycling', () => {
      engine = new PhysicsEngine();
      engine.addBody(makePlatformDef({ name: 'p', x: 0, y: 50 }));
      engine.addPlayer(0, 0, 0);

      for (let cycle = 0; cycle < 5; cycle++) {
        engine.applyInput(0, GRAPPLE_INPUT);
        engine.tick();
        engine.applyInput(0, noInput());
        engine.tick();
      }

      const state = engine.getPlayerState(0);
      expect(state.alive).toBe(true);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 15; i++) engine.tick();

      const finalState = engine.getPlayerState(0);
      expect(finalState.y).toBeLessThan(200);
    });
  });

  describe('no grapple without platform', () => {
    it('player falls freely when no platform is available', () => {
      engine = new PhysicsEngine();
      engine.addPlayer(0, 0, 0);

      engine.applyInput(0, GRAPPLE_INPUT);
      for (let i = 0; i < 30; i++) engine.tick();

      const state = engine.getPlayerState(0);
      expect(state.y).toBeGreaterThan(100);
    });
  });
});
