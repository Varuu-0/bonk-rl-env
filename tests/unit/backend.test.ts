import { describe, expect, it } from 'vitest';
import { createBackend } from '../../src/core/backend';

describe('isolated modified Box2D backend', () => {
  it('does not share constructors, solver flags or scratch state between modules', () => {
    const first = createBackend();
    const second = createBackend();
    expect(first.Dynamics.b2World).not.toBe(second.Dynamics.b2World);
    const world = new first.Dynamics.b2World(new first.Common.Math.b2Vec2(0, 20), true);
    world.SetWarmStarting(false);
    new second.Dynamics.b2World(new second.Common.Math.b2Vec2(0, 20), true);
    expect(first.Dynamics.b2World.m_warmStarting).toBe(false);
    expect(second.Dynamics.b2World.m_warmStarting).toBe(true);
  });

  it('uses observed friction special case and rounded matrix rotations', () => {
    const B = createBackend();
    expect(B.Common.b2Settings.b2MixFriction(0.3, 0.001337)).toBe(0);
    expect(B.Common.b2Settings.b2MixFriction(-0.3, 0.001337)).toBe(0.15);
    const matrix = new B.Common.Math.b2Mat22();
    matrix.Set(0.23);
    expect(matrix.col1.x).toBe(0.9736664);
    expect(matrix.col1.y).toBe(0.2279775);
  });

  it('uses native reset to clear contact/island state without resetting warm starting', () => {
    const B = createBackend();
    const world = new B.Dynamics.b2World(new B.Common.Math.b2Vec2(0, 20), true);
    world.SetWarmStarting(false);
    const island = world.m_island;
    const listener = new B.Dynamics.b2ContactListener();
    world.SetContactListener(listener);
    world.CreateBody(new B.Dynamics.b2BodyDef());
    world.m_contactCount = 99;
    world.novakReset();
    expect(world.GetBodyCount()).toBe(1);
    expect(world.GetContactCount()).toBe(0);
    expect(world.m_island).not.toBe(island);
    expect(world.m_contactManager.m_contactListener).not.toBe(listener);
    expect(B.Dynamics.b2World.m_warmStarting).toBe(false);
    expect(world.GetGravity().y).toBe(20);
  });

  it('keeps interleaved worlds identical to isolated trajectories after construction and resets', () => {
    function scene() {
      const B = createBackend();
      const world = new B.Dynamics.b2World(new B.Common.Math.b2Vec2(0, 20), true);
      function step() {
        world.novakReset();
        world.SetWarmStarting(false);
        const definition = new B.Dynamics.b2BodyDef();
        definition.type = B.Dynamics.b2Body.b2_dynamicBody;
        definition.position.Set(state.x, state.y);
        definition.linearVelocity.Set(state.xv, state.yv);
        const body = world.CreateBody(definition);
        const fixture = new B.Dynamics.b2FixtureDef();
        fixture.shape = new B.Collision.Shapes.b2CircleShape(1);
        fixture.density = 1 / Math.PI;
        body.CreateFixture(fixture);
        body.ApplyForce(new B.Common.Math.b2Vec2(12, 0), body.GetWorldCenter());
        world.Step(1 / 30, 2, 6);
        world.ClearForces();
        state = {
          x: body.GetPosition().x,
          y: body.GetPosition().y,
          xv: body.GetLinearVelocity().x,
          yv: body.GetLinearVelocity().y,
        };
        return { ...state };
      }
      let state = { x: 0, y: 0, xv: 0, yv: 0 };
      return { step };
    }
    const isolated = scene();
    const expected = Array.from({ length: 30 }, () => isolated.step());
    const a = scene();
    const b = scene();
    for (let i = 0; i < expected.length; i++) {
      expect(a.step()).toEqual(expected[i]);
      const noise = createBackend();
      const noiseWorld = new noise.Dynamics.b2World(new noise.Common.Math.b2Vec2(0, 7), false);
      noiseWorld.SetContinuousPhysics(false);
      expect(b.step()).toEqual(expected[i]);
    }
  });
});
