import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';

/**
 * P1 — Fixture-physics fidelity from DEOBFUSCATION §33.4.
 *
 * Assert exact native behaviors that are PROVEN in the deobfuscation record:
 *   - density is clamped to a floor of 0.0001 for dynamic bodies (line 3269)
 *   - `f_p` (fricPolarity) surfaces are frictionless (0), not sign-negative
 *     (line 3267) — the negative form would NaN the b2MixFriction sqrt with
 *     this port's positive disc friction (#276)
 *   - static bodies keep density 0 (no mass contribution)
 */

function makeEngine(): PhysicsEngine {
  return new PhysicsEngine();
}

function fixtureOf(body: any): any {
  return body.GetShapeList ? body.GetShapeList() : body.GetFixtureList().GetShape();
}

describe('physics fidelity P1: fixture physics (DEOBFUSCATION §33.4)', () => {
  it('keeps an unknown dynamic density at the native 1.0 default (not floored)', () => {
    const e = makeEngine();
    e.addBody({ name: 'undefined-density', type: 'rect', x: 400, y: 0, width: 40, height: 20, static: false } as any);
    const shape = fixtureOf(e.getBodyMap().get('undefined-density')) as any;
    // A body without an authored density must NOT fall to the 0.0001 floor
    // (that would be a 10,000x mass reduction); it keeps the 1.0 default.
    expect(shape.m_density).toBeCloseTo(1.0, 3);
  });

  it('clamps dynamic density to the 0.0001 floor', () => {
    const e = makeEngine();
    e.addBody({ name: 'zero-density', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: false, density: 0 } as any);
    e.addBody({ name: 'neg-density', type: 'rect', x: 200, y: 0, width: 40, height: 20, static: false, density: -5 } as any);
    const bm = e.getBodyMap();
    expect((fixtureOf(bm.get('zero-density')) as any).m_density).toBe(0.0001);
    expect((fixtureOf(bm.get('neg-density')) as any).m_density).toBe(0.0001);
  });

  it('keeps a normal positive density unclamped', () => {
    const e = makeEngine();
    e.addBody({ name: 'dyn', type: 'circle', x: 0, y: 0, radius: 5, static: false, density: 3 } as any);
    const shape = fixtureOf(e.getBodyMap().get('dyn')) as any;
    expect(shape.m_density).toBe(3);
  });

  it('keeps static bodies at density 0', () => {
    const e = makeEngine();
    e.addBody({ name: 'stat', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, density: 2 } as any);
    const shape = fixtureOf(e.getBodyMap().get('stat')) as any;
    expect(shape.m_density).toBe(0);
  });

  it('makes f_p (fricPolarity) surfaces frictionless instead of negative (#276)', () => {
    const e = makeEngine();
    e.addBody({ name: 'polar', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, friction: 0.3, fricPolarity: true } as any);
    e.addBody({ name: 'normal', type: 'rect', x: 200, y: 0, width: 40, height: 20, static: true, friction: 0.3, fricPolarity: false } as any);
    const polarShape = fixtureOf(e.getBodyMap().get('polar')) as any;
    const normalShape = fixtureOf(e.getBodyMap().get('normal')) as any;
    // Native line 3267 negates the friction for `f_p` ("velocity-independent
    // friction"), but that relies on the native disc friction being 0
    // (sqrt(-f * 0) = -0). This port's disc friction is positive, so a
    // negative surface friction would make the b2MixFriction sqrt NaN and
    // corrupt the disc on first contact (#276). The frictionless native
    // effect is reproduced as friction 0 instead.
    expect(polarShape.m_friction).toBeCloseTo(0);
    expect(normalShape.m_friction).toBeCloseTo(0.3);
  });

  it('clamps authored negative friction up to 0 (#276)', () => {
    const e = makeEngine();
    e.addBody({ name: 'neg', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, friction: -1, fricPolarity: false } as any);
    const shape = fixtureOf(e.getBodyMap().get('neg')) as any;
    expect(shape.m_friction).toBe(0);
  });

  it('defaults friction to the native surface default when unset', () => {
    const e = makeEngine();
    e.addBody({ name: 'def', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true } as any);
    const shape = fixtureOf(e.getBodyMap().get('def')) as any;
    expect(shape.m_friction).toBeCloseTo(0.3);
  });
});

/**
 * P1b — collision-filter semantics (§33.4). The engine's mask is built from the
 * exported collidesGroupN booleans (map category 0x0001 + player group bits).
 * This is the engine's internal representation of the native "start full,
 * subtract per disabled group" rule — it is NOT claimed to be native-exact
 * (the native encoding is `categoryBits = 2^(f_c+1)` and a 65535-minus mask;
 * exact bit parity is deferred to P4 differential validation). These tests pin
 * the ENGINE's invariant so a refactor cannot silently change map/player
 * collision.
 */
describe('physics fidelity P1b: collision filters (DEOBFUSCATION §33.4)', () => {
  it('all groups true -> map category 0x0001 + all group bits in mask', () => {
    const e = makeEngine();
    e.addBody({ name: 'solid', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, collides: { g1: true, g2: true, g3: true, g4: true } } as any);
    const filter = (fixtureOf(e.getBodyMap().get('solid')) as any).GetFilterData();
    expect(filter.categoryBits).toBe(0x0001);
    expect(filter.maskBits).toBe(0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010);
  });

  it('all groups false (ghost) -> mask 0 (legacy visual geometry)', () => {
    const e = makeEngine();
    e.addBody({ name: 'ghost', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, collides: { g1: false, g2: false, g3: false, g4: false } } as any);
    const filter = (fixtureOf(e.getBodyMap().get('ghost')) as any).GetFilterData();
    expect(filter.categoryBits).toBe(0x0001);
    expect(filter.maskBits).toBe(0x0000);
  });

  it('partial groups -> only the enabled group bits are added', () => {
    const e = makeEngine();
    e.addBody({ name: 'g1', type: 'rect', x: 0, y: 0, width: 40, height: 20, static: true, collides: { g1: true, g2: false, g3: false, g4: false } } as any);
    const filter = (fixtureOf(e.getBodyMap().get('g1')) as any).GetFilterData();
    expect(filter.maskBits).toBe(0x0001 | 0x0002);
  });
});