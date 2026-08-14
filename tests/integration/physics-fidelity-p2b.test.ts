/**
 * physics-fidelity-p2b.test.ts — P2b: LSJ initial-side spring bias.
 *
 * Native evidence (readable 2026-07-29 artifact):
 *  - lsj is the §33.8 springy b2PrismaticJointDef variant (readable
 *    7583-7632): vertical axis (0,1), ±slen limits with enableLimit=false,
 *    motor 300, then an initial-side spring bias computed at joint build:
 *      θ = bodyA.GetAngle() − π/2
 *      anchorWorld = (sax + safeCos(θ)·(−slen), say + safeSin(θ)·(−slen))
 *      rel = bodyA.GetPosition() − anchorWorld;  len = |rel|
 *      φ = safeATan2(rel.y, rel.x) − bodyA.GetAngle();  φ %= 2π
 *      len = −len unless φ ∈ [−π, 0) ∪ (π, 2π]
 *      k = (len/(2·slen) − 0.5)·2
 *      maxMotorForce = sf·|k|;  if (k > 0) motorSpeed = −300
 *  - the map decoder replaces sax/say with the body's position and scales
 *    slen /= ppm, sf /= ppm² (readable 6448-6453); the exporter carries
 *    (sax,say) on anchorA and slen on `length`, feeding the same inputs in
 *    engine world units (k is dimensionless, so scaling is faithful).
 */
import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../src/core/physics-engine';
import { normalizeMap } from '../../src/core/map-adapter';

/** Fresh engine with a fixed test bodyA/B pair. */
function makeEngine(): { engine: PhysicsEngine; close: () => void } {
    const engine = new PhysicsEngine({});
    try {
        engine.addBody({ name: 'base', type: 'rect', x: 0, y: 0, width: 30, height: 30, static: true, density: 0 } as any);
        engine.addBody({ name: 'other', type: 'rect', x: 0, y: 50, width: 30, height: 30, static: true, density: 0 } as any);
    } catch (e) {
        engine.destroy();
        throw e;
    }
    return {
        engine,
        close: () => engine.destroy(),
    };
}

function addLsj(engine: PhysicsEngine, def: Record<string, any>): any {
    engine.addJoint({ type: 'lsj', name: 'lsj_0', bodyA: 'base', bodyB: 'other', ...def } as any, (engine as any).platformBodyMap);
    return (engine as any).createdJoints.get('lsj_0');
}

describe('P2b: lsj initial-side spring bias (readable 7600-7630)', () => {
    it('k = +1 (anchor offset +slen along the axis): maxMotorForce = sf, motorSpeed = −300', () => {
        // bodyA at (0,0) px, angle 0; anchorA (0,+100)px, slen 100 (world
        // 3.333): anchorWorld = (0, 2·slen); rel = (0, −2·slen); φ = −π/2 ∈
        // [−π,0) keeps len; k = (2·slen/(2·slen) − 0.5)·2 = 1 → force sf, −300.
        const { engine, close } = makeEngine();
        try {
            const j = addLsj(engine, {
                anchorA: { x: 0, y: 100 }, length: 100,
                lowerTranslation: -100, upperTranslation: 100,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_maxMotorForce).toBeCloseTo(500, 6);
            expect(j.m_motorSpeed).toBe(-300);
        } finally {
            close();
        }
    });

    it('k = −2 (anchor at −slen xy, φ = 0 flips len): maxMotorForce = sf·2, motorSpeed stays +300', () => {
        // anchorA (−100,−100)px: anchorWorld = (−slen, 0); rel = (slen, 0);
        // φ = 0 → NOT in [−π,0)∪(π,2π] → len = −slen; k = (−0.5−0.5)·2 = −2.
        const { engine, close } = makeEngine();
        try {
            const j = addLsj(engine, {
                anchorA: { x: -100, y: -100 }, length: 100,
                lowerTranslation: -100, upperTranslation: 100,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_maxMotorForce).toBeCloseTo(1000, 6);
            expect(j.m_motorSpeed).toBe(300);
        } finally {
            close();
        }
    });

    it('rotated body (angle π/4) applies the side-aware k: force ≈ sf·0.8477, motor −300', () => {
        // θ = −π/4; anchorWorld = (−√2/2·slen, slen + √2/2·slen);
        // rel = (√2/2·slen, −(1+√2/2)·slen); len ≈ 1.8478·slen; φ ≈ −1.9635
        // (kept); k ≈ 0.8477 → force ≈ 423.87, −300.
        const { engine, close } = makeEngine();
        try {
            const base = (engine as any).platformBodyMap.get('base');
            base.SetXForm(base.GetPosition(), Math.PI / 4);
            const j = addLsj(engine, {
                anchorA: { x: 0, y: 100 }, length: 100,
                lowerTranslation: -100, upperTranslation: 100,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_maxMotorForce).toBeCloseTo(423.87, 1);
            expect(j.m_motorSpeed).toBe(-300);
        } finally {
            close();
        }
    });

    it('k = 0 (anchor at the body center): maxMotorForce = 0, motorSpeed stays +300', () => {
        // anchor == body position → len = slen, φ = −π/2 (kept) → k = 0.
        const { engine, close } = makeEngine();
        try {
            const j = addLsj(engine, {
                anchorA: { x: 0, y: 0 }, length: 100,
                lowerTranslation: -100, upperTranslation: 100,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_maxMotorForce).toBeCloseTo(0, 6);
            expect(j.m_motorSpeed).toBe(300);
        } finally {
            close();
        }
    });

    it('signed slen −40, anchor −40 px below the body (k = +1): maxMotorForce = 25, motorSpeed = −300 (#372)', () => {
        // slen = −40/30 = −1.3333; θ = −π/2 → ay = anchor.y + sin(θ)·(−slen)
        // = −1.3333 + (−1)·(1.3333) = −2.6667; anchorWorld = (0, −2.6667);
        // rel = (0, 2.6667); φ = π/2 (not kept) → len = −2.6667;
        // k = (−2.6667/(2·(−1.3333)) − 0.5)·2 = +1 → force sf, −300.
        const { engine, close } = makeEngine();
        try {
            const j = addLsj(engine, {
                anchorA: { x: 0, y: -40 }, length: -40,
                lowerTranslation: -40, upperTranslation: 40,
                maxMotorForce: 25, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_motorSpeed).toBe(-300);
            expect(j.m_maxMotorForce).toBeCloseTo(25, 6);
        } finally {
            close();
        }
    });

    it('signed slen −40, anchor at the body center (k = 0): maxMotorForce = 0, motorSpeed stays +300 (#372)', () => {
        // anchorWorld = (0, −1.3333); rel = (0, 1.3333); φ = π/2 (not kept) →
        // len = −1.3333; k = (−1.3333/(−2.6667) − 0.5)·2 = 0 → force 0, +300.
        const { engine, close } = makeEngine();
        try {
            const j = addLsj(engine, {
                anchorA: { x: 0, y: 0 }, length: -40,
                lowerTranslation: -40, upperTranslation: 40,
                maxMotorForce: 25, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(j.m_maxMotorForce).toBeCloseTo(0, 6);
            expect(j.m_motorSpeed).toBe(300);
        } finally {
            close();
        }
    });

    it('static 300/sf fallbacks when slen is absent/zero or the anchor is invalid', () => {
        const { engine, close } = makeEngine();
        try {
            const noLen = addLsj(engine, {
                anchorA: { x: 0, y: 100 }, length: 0,
                lowerTranslation: -1, upperTranslation: 1,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(noLen.m_maxMotorForce).toBe(500);
            expect(noLen.m_motorSpeed).toBe(300);

            const noAnchor = addLsj(engine, {
                length: 100, maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(noAnchor.m_maxMotorForce).toBe(500);
            expect(noAnchor.m_motorSpeed).toBe(300);

            const signedNoAnchor = addLsj(engine, {
                length: -40, maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            });
            expect(signedNoAnchor.m_maxMotorForce).toBe(500);
            expect(signedNoAnchor.m_motorSpeed).toBe(300);
        } finally {
            close();
        }
    });

    it('lpj/p prismatic joints are NOT given the lsj bias', () => {
        const { engine, close } = makeEngine();
        try {
            engine.addJoint({ type: 'lpj', name: 'lpj_0', bodyA: 'base', bodyB: 'other', ...{
                anchorA: { x: 0, y: 100 }, length: 100,
                lowerTranslation: -100, upperTranslation: 100,
                maxMotorForce: 500, motorSpeed: 300,
                enableMotor: true, enableLimit: false, axis: { x: 0, y: 1 },
            } } as any, (engine as any).platformBodyMap);
            const j = (engine as any).createdJoints.get('lpj_0');
            expect(j.m_maxMotorForce).toBe(500);
            expect(j.m_motorSpeed).toBe(300);
        } finally {
            close();
        }
    });

    it('decoder-canonical exporter map (anchorA == body position) yields k ≡ 0: force 0, motor +300', () => {
        // The map decoder overwrites sax/say with the body's decoded position
        // (readable 6448-6449) and the build creates the body at exactly that
        // position (7449), so the exporter's anchorA lands on the body — the
        // formula collapses to len == slen, φ ≡ −π/2, k ≡ 0. The native
        // computes sf·|k| = 0 and keeps motorSpeed 300; the engine must too.
        const engine = new PhysicsEngine({});
        try {
            const md = normalizeMap({
                bodies: [
                    { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
                    { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 40, width: 20, height: 20, static: false, density: 1 },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
                physicsJoints: [{
                    index: 0, type: 'lsj', bodyA: 0, bodyB: 1,
                    anchorA: { x: 0, y: 0 }, // == body 'anchor' position
                    axis: { x: 0, y: 1 },
                    lowerTranslation: -40, upperTranslation: 40,
                    length: 40, enableLimit: false, enableMotor: true,
                    motorSpeed: 300, maxMotorForce: 25,
                }],
            } as any) as any;
            const bm = new Map<string, any>();
            for (const b of md.bodies) { engine.addBody(b); bm.set(b.name, engine.getBodyMap().get(b.name)); }
            engine.addJoint(md.joints[0], bm);
            const j = (engine as any).createdJoints.get('joint_0');
            expect(j.m_maxMotorForce).toBeCloseTo(0, 5);
            expect(j.m_motorSpeed).toBeCloseTo(300, 5);
        } finally {
            engine.destroy();
        }
    });

    it('authored offset anchor engages the bias through the adapter path (k = +1: force sf, motor −300)', () => {
        // Same exporter shape but the anchor deliberately offsets the body by
        // +slen along the axis — the branch the native formula reaches when
        // sax/say differ from the build position.
        const engine = new PhysicsEngine({});
        try {
            const md = normalizeMap({
                bodies: [
                    { bodyIndex: 0, name: 'anchor', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
                    { bodyIndex: 1, name: 'spring', type: 'rect', x: 0, y: 40, width: 20, height: 20, static: false, density: 1 },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
                physicsJoints: [{
                    index: 0, type: 'lsj', bodyA: 0, bodyB: 1,
                    anchorA: { x: 0, y: 40 }, // +slen above the body
                    axis: { x: 0, y: 1 },
                    lowerTranslation: -40, upperTranslation: 40,
                    length: 40, enableLimit: false, enableMotor: true,
                    motorSpeed: 300, maxMotorForce: 25,
                }],
            } as any) as any;
            const bm = new Map<string, any>();
            for (const b of md.bodies) { engine.addBody(b); bm.set(b.name, engine.getBodyMap().get(b.name)); }
            engine.addJoint(md.joints[0], bm);
            const j = (engine as any).createdJoints.get('joint_0');
            expect(j.m_maxMotorForce).toBeCloseTo(25, 5);
            expect(j.m_motorSpeed).toBeCloseTo(-300, 5);
        } finally {
            engine.destroy();
        }
    });
});