/**
 * physics-engine-broadphase-capacity.test.ts — Guard contract for the fixed
 * broadphase pair/proxy tables (#392).
 *
 * The bundled Box2D port drains its pair-table and proxy free lists without
 * bounds checks; once exhausted, fixture creation dies with the opaque
 * library TypeError "Cannot read properties of undefined (reading 'next')".
 * The PhysicsEngine converts that state into a descriptive capacity error
 * naming numOpponents and the remedy, on every fixture-creation path (map
 * bodies, cap-zone sensors, player discs).
 *
 * These tests force the exhaustion paths through STUB worlds — arbitrary
 * sentinel free-list heads and a CreateShape that throws the exhaustion
 * signature — so they pin the GUARD CONTRACT without depending on any real
 * b2Settings.b2_maxPairs value or internal m_freePair/m_freeProxy
 * bookkeeping being literally true.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsEngine, MapBodyDef } from '../../src/core/physics-engine';

const PAIR_EXHAUSTION_TYPE_ERROR = "Cannot read properties of undefined (reading 'next')";

/** Arbitrary sentinel standing in for a drained free-list head. */
const DRAINED = Number.MAX_SAFE_INTEGER;

function stubWorld(freePair: number, freeProxy: number, createBody?: (bodyDef: any) => any): any {
  return {
    m_broadPhase: {
      m_freeProxy: freeProxy,
      m_pairManager: { m_freePair: freePair },
    },
    CreateBody: createBody ?? (() => ({})),
  };
}

/** Body stub whose CreateShape throws the given error (mid-add drain). */
function bodyWhoseCreateShapeThrows(err: unknown): any {
  return {
    CreateShape: () => {
      throw err;
    },
  };
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error('expected the call to throw');
}

const WALL: MapBodyDef = {
  name: 'dense-wall',
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  static: true,
};

describe('PhysicsEngine broadphase capacity guard (#392)', () => {
  it('addPlayer fails fast when the pair free list is drained', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(DRAINED, 0);
      const message = messageOf(() => engine.addPlayer(1, 0, 0));
      expect(message).toMatch(/PhysicsEngine broadphase capacity exhausted/);
      expect(message).toMatch(/Reduce numOpponents \(at most 64\)/);
      expect(message).not.toContain(PAIR_EXHAUSTION_TYPE_ERROR);
    } finally {
      (engine as any).world = original;
    }
  });

  it('addPlayer fails fast when the proxy free list is drained', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(0, DRAINED);
      expect(messageOf(() => engine.addPlayer(1, 0, 0))).toMatch(/PhysicsEngine broadphase capacity exhausted/);
    } finally {
      (engine as any).world = original;
    }
  });

  it('addPlayer converts a pair-table drain raised mid-CreateShape into the descriptive error', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      // Healthy free lists: the pre-check passes, then the shape add
      // itself consumes the last slot inside the library.
      (engine as any).world = stubWorld(0, 0, () =>
        bodyWhoseCreateShapeThrows(new TypeError(PAIR_EXHAUSTION_TYPE_ERROR)),
      );
      const message = messageOf(() => engine.addPlayer(7, 0, 0));
      expect(message).toMatch(/PhysicsEngine broadphase pair table exhausted/);
      expect(message).toMatch(/for player 7/);
      expect(message).toMatch(/Reduce numOpponents \(at most 64\)/);
      expect(message).not.toContain("reading 'next'");
    } finally {
      (engine as any).world = original;
    }
  });

  it('passes unrelated CreateShape failures through untouched', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(0, 0, () =>
        bodyWhoseCreateShapeThrows(new TypeError('boom: unrelated failure')),
      );
      expect(messageOf(() => engine.addPlayer(1, 0, 0))).toBe('boom: unrelated failure');
    } finally {
      (engine as any).world = original;
    }
  });

  it('addBody fails fast with the map body named when the table is drained', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(DRAINED, 0);
      const message = messageOf(() => engine.addBody(WALL));
      expect(message).toMatch(/PhysicsEngine broadphase capacity exhausted/);
      expect(message).toContain("cannot add map body 'dense-wall'");
      expect(message).toMatch(/Reduce numOpponents/);
    } finally {
      (engine as any).world = original;
    }
  });

  it('addBody converts a mid-add drain into the descriptive error naming the fixture', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(0, 0, () =>
        bodyWhoseCreateShapeThrows(new TypeError(PAIR_EXHAUSTION_TYPE_ERROR)),
      );
      const message = messageOf(() => engine.addBody(WALL));
      expect(message).toMatch(/PhysicsEngine broadphase pair table exhausted/);
      expect(message).toContain("fixture for map body 'dense-wall'");
      expect(message).not.toContain("reading 'next'");
    } finally {
      (engine as any).world = original;
    }
  });

  it('addCapZone fails fast with the zone named when the table is drained', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(DRAINED, 0);
      const message = messageOf(() =>
        engine.addCapZone({ index: 3, owner: 'blue', type: 1, fixture: '', shapeType: 'r' }, 0, 0, 10, 10),
      );
      expect(message).toMatch(/PhysicsEngine broadphase capacity exhausted/);
      expect(message).toContain('cannot add cap-zone 3 sensor');
    } finally {
      (engine as any).world = original;
    }
  });

  it('healthy free-list heads pass the pre-check', () => {
    const engine = new PhysicsEngine();
    const original = (engine as any).world;
    try {
      (engine as any).world = stubWorld(0, 0);
      expect(() => (engine as any).assertBroadphaseCapacity('probe')).not.toThrow();
    } finally {
      (engine as any).world = original;
    }
  });
});
