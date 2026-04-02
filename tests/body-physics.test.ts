/**
 * body-physics.test.ts — Blackbox tests for newly added body physics fields
 *
 * Tests:
 * 1. linearDamping reduces linear velocity over time
 * 2. linearDamping defaults to 0 when not specified
 * 3. angularDamping reduces angular velocity over time
 * 4. angularDamping defaults to 0 when not specified
 * 5. linearVelocity gives body initial momentum
 * 6. body without linearVelocity starts stationary
 * 7. linearVelocity with y component
 * 8. angularVelocity gives body initial spin
 * 9. body without angularVelocity has zero initial spin
 * 10. collidesWithPlayers=false prevents player-body collision
 * 11. collidesWithPlayers=true (default) allows player-body collision
 * 12. dynamic body with both linearVelocity and angularVelocity
 * 13. static body ignores linearVelocity and angularVelocity
 *
 * Run with: npx tsx tests/body-physics.test.ts
 */

import {
    PhysicsEngine,
    MapBodyDef,
    SCALE,
} from "../src/core/physics-engine";

// Test counters
let testsPassed = 0;
let testsFailed = 0;

/**
 * Test result helper
 */
function test(name: string, passed: boolean, details?: string): void {
    if (passed) {
        console.log("+ " + name);
        testsPassed++;
    } else {
        console.log("X " + name + (details ? ": " + details : ""));
        testsFailed++;
    }
}

// ─── linearDamping Tests ──────────────────────────────────────────────

/**
 * Test 1: linearDamping=0 body slides farther than linearDamping=5
 */
function testLinearDampingDifference(): void {
    console.log("\n--- Test 1: linearDamping slows movement ---");

    const engine = new PhysicsEngine();

    const noDamping: MapBodyDef = {
        name: "noDamp",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        linearDamping: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    const highDamping: MapBodyDef = {
        name: "highDamp",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        linearDamping: 5,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(noDamping);
    engine.addBody(highDamping);

    const bodyMap = engine.getBodyMap();
    const noDampBody = bodyMap.get("noDamp");
    const highDampBody = bodyMap.get("highDamp");

    // Apply same rightward impulse to both
    // @ts-ignore — box2d has no type declarations
    const b2Vec2 = require('box2d').b2Vec2;
    noDampBody.ApplyImpulse(new b2Vec2(5, 0), noDampBody.GetPosition());
    highDampBody.ApplyImpulse(new b2Vec2(5, 0), highDampBody.GetPosition());

    // Step 30 ticks
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    const noDampX = noDampBody.GetPosition().x;
    const highDampX = highDampBody.GetPosition().x;

    test(
        "linearDamping=0 body slides farther than linearDamping=5",
        noDampX > highDampX,
        `noDampX=${noDampX.toFixed(4)}, highDampX=${highDampX.toFixed(4)}`
    );

    engine.destroy();
}

/**
 * Test 2: linearDamping defaults to 0 when not specified
 */
function testLinearDampingDefault(): void {
    console.log("\n--- Test 2: linearDamping defaults to 0 ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "defaultBody",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("defaultBody");

    test(
        "bodyDef.linearDamping is 0 when not specified",
        b2Body.m_linearDamping === 0,
        `m_linearDamping=${b2Body.m_linearDamping}`
    );

    // Verify by applying impulse and checking it moves freely
    // @ts-ignore — box2d has no type declarations
    const b2Vec2 = require('box2d').b2Vec2;
    b2Body.ApplyImpulse(new b2Vec2(2, 0), b2Body.GetPosition());

    engine.tick();

    const velX = b2Body.GetLinearVelocity().x;
    test(
        "Body with default damping moves freely after impulse",
        velX > 0,
        `velX=${velX.toFixed(4)}`
    );

    engine.destroy();
}

// ─── angularDamping Tests ─────────────────────────────────────────────

/**
 * Test 3: angularDamping=0 body spins longer than angularDamping=5
 */
function testAngularDampingDifference(): void {
    console.log("\n--- Test 3: angularDamping slows rotation ---");

    const engine = new PhysicsEngine();

    const noDamping: MapBodyDef = {
        name: "noAngDamp",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        angularDamping: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    const highDamping: MapBodyDef = {
        name: "highAngDamp",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        angularDamping: 5,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(noDamping);
    engine.addBody(highDamping);

    const bodyMap = engine.getBodyMap();
    const noDampBody = bodyMap.get("noAngDamp");
    const highDampBody = bodyMap.get("highAngDamp");

    // Apply same torque to both
    noDampBody.ApplyTorque(10);
    highDampBody.ApplyTorque(10);

    // Step 60 ticks
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const noDampAngVel = Math.abs(noDampBody.GetAngularVelocity());
    const highDampAngVel = Math.abs(highDampBody.GetAngularVelocity());

    test(
        "angularDamping=0 body retains higher angular velocity than angularDamping=5",
        noDampAngVel > highDampAngVel,
        `noDampAngVel=${noDampAngVel.toFixed(6)}, highDampAngVel=${highDampAngVel.toFixed(6)}`
    );

    engine.destroy();
}

/**
 * Test 4: angularDamping defaults to 0 when not specified
 */
function testAngularDampingDefault(): void {
    console.log("\n--- Test 4: angularDamping defaults to 0 ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "defaultAngBody",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("defaultAngBody");

    test(
        "bodyDef.angularDamping is 0 when not specified",
        b2Body.m_angularDamping === 0,
        `m_angularDamping=${b2Body.m_angularDamping}`
    );

    engine.destroy();
}

// ─── linearVelocity Tests ─────────────────────────────────────────────

/**
 * Test 5: linearVelocity gives body initial momentum
 */
function testLinearVelocityMomentum(): void {
    console.log("\n--- Test 5: linearVelocity gives initial momentum ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "movingBody",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        linearVelocity: { x: 5, y: 0 },
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    engine.tick();

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("movingBody");
    const posX = b2Body.GetPosition().x;

    test(
        "body with linearVelocity={x:5,y:0} moves right after 1 tick",
        posX > 0,
        `posX=${posX.toFixed(6)}`
    );

    engine.destroy();
}

/**
 * Test 6: body without linearVelocity starts stationary
 */
function testNoLinearVelocityStationary(): void {
    console.log("\n--- Test 6: body without linearVelocity starts stationary ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "staticVelBody",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    engine.tick();

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("staticVelBody");
    const posX = b2Body.GetPosition().x;

    test(
        "body without linearVelocity has no horizontal movement",
        Math.abs(posX) < 0.0001,
        `posX=${posX.toFixed(8)}`
    );

    engine.destroy();
}

/**
 * Test 7: linearVelocity with y component
 */
function testLinearVelocityYComponent(): void {
    console.log("\n--- Test 7: linearVelocity with y component ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "upwardBody",
        type: "circle",
        x: 0, y: 0,
        radius: 10,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        linearVelocity: { x: 0, y: -10 },
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    engine.tick();

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("upwardBody");
    const posY = b2Body.GetPosition().y;

    test(
        "body with linearVelocity={x:0,y:-10} moves up (posY < 0)",
        posY < 0,
        `posY=${posY.toFixed(6)}`
    );

    engine.destroy();
}

// ─── angularVelocity Tests ────────────────────────────────────────────

/**
 * Test 8: angularVelocity gives body initial spin
 */
function testAngularVelocitySpin(): void {
    console.log("\n--- Test 8: angularVelocity gives initial spin ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "spinningBody",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        angularVelocity: 5,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    engine.tick();

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("spinningBody");
    const angVel = b2Body.GetAngularVelocity();

    test(
        "body with angularVelocity=5 has positive angular velocity after 1 tick",
        angVel > 0,
        `angularVel=${angVel.toFixed(6)}`
    );

    engine.destroy();
}

/**
 * Test 9: body without angularVelocity has zero initial spin
 */
function testNoAngularVelocityStationary(): void {
    console.log("\n--- Test 9: body without angularVelocity has zero spin ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "noSpinBody",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    engine.tick();

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("noSpinBody");
    const angVel = b2Body.GetAngularVelocity();

    test(
        "body without angularVelocity has zero initial spin",
        Math.abs(angVel) < 0.0001,
        `angularVel=${angVel.toFixed(8)}`
    );

    engine.destroy();
}

// ─── collidesWithPlayers Tests ─────────────────────────────────────────

/**
 * Test 10: collidesWithPlayers=false prevents player-body collision
 */
function testCollidesWithPlayersFalse(): void {
    console.log("\n--- Test 10: collidesWithPlayers=false prevents collision ---");

    const engine = new PhysicsEngine();

    // Floor at y=100 (in pixels), collidesWithPlayers=false
    const floor: MapBodyDef = {
        name: "ghostFloor",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        collides: { g1: true, g2: true, g3: true, g4: true },
        collidesWithPlayers: false,
    };

    engine.addBody(floor);

    // Add player just above the floor
    engine.addPlayer(0, 0, 95);

    // Step 30 ticks with gravity — player should fall through
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    // Player should have fallen through the floor (y > 100 + some margin)
    test(
        "Player falls through floor with collidesWithPlayers=false",
        state.y > 110,
        `playerY=${state.y.toFixed(2)} (expected > 110, fell through floor at y=100)`
    );

    engine.destroy();
}

/**
 * Test 11: collidesWithPlayers=true (default) allows player-body collision
 */
function testCollidesWithPlayersDefault(): void {
    console.log("\n--- Test 11: collidesWithPlayers=true allows collision ---");

    const engine = new PhysicsEngine();

    // Floor at y=100, collidesWithPlayers not set (defaults to true)
    const floor: MapBodyDef = {
        name: "solidFloor",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        collides: { g1: true, g2: true, g3: true, g4: true },
    };

    engine.addBody(floor);

    // Add player just above the floor
    engine.addPlayer(0, 0, 95);

    // Step 30 ticks with gravity — player should be stopped by floor
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    // Player should be stopped by the floor, staying near y=100
    // Allow some tolerance for player radius + physics settling
    test(
        "Player is stopped by floor with default collidesWithPlayers",
        state.y <= 105,
        `playerY=${state.y.toFixed(2)} (expected <= 105, stopped by floor at y=100)`
    );

    engine.destroy();
}

// ─── Edge Cases ───────────────────────────────────────────────────────

/**
 * Test 12: dynamic body with both linearVelocity and angularVelocity
 */
function testCombinedVelocities(): void {
    console.log("\n--- Test 12: Combined linearVelocity and angularVelocity ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "comboBody",
        type: "rect",
        x: 0, y: 0,
        width: 40, height: 20,
        static: false,
        density: 1,
        friction: 0,
        restitution: 0,
        linearVelocity: { x: 3, y: 0 },
        angularVelocity: 2,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    // Step 10 ticks
    for (let i = 0; i < 10; i++) {
        engine.tick();
    }

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("comboBody");
    const posX = b2Body.GetPosition().x;
    const angVel = b2Body.GetAngularVelocity();

    test(
        "Body with both velocities has moved right",
        posX > 0,
        `posX=${posX.toFixed(4)}`
    );

    test(
        "Body with both velocities is spinning",
        Math.abs(angVel) > 0.001,
        `angularVel=${angVel.toFixed(6)}`
    );

    engine.destroy();
}

/**
 * Test 13: static body ignores linearVelocity and angularVelocity
 */
function testStaticIgnoresVelocities(): void {
    console.log("\n--- Test 13: static body ignores velocities ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "staticBody",
        type: "rect",
        x: 50, y: 50,
        width: 40, height: 20,
        static: true,
        linearVelocity: { x: 10, y: 10 },
        angularVelocity: 10,
        collides: { g1: false, g2: false, g3: false, g4: false },
    };

    engine.addBody(body);

    const bodyMap = engine.getBodyMap();
    const b2Body = bodyMap.get("staticBody");
    const initialX = b2Body.GetPosition().x;
    const initialY = b2Body.GetPosition().y;
    const initialAngle = b2Body.GetAngle();

    // Step 10 ticks
    for (let i = 0; i < 10; i++) {
        engine.tick();
    }

    const finalX = b2Body.GetPosition().x;
    const finalY = b2Body.GetPosition().y;
    const finalAngle = b2Body.GetAngle();
    const angVel = b2Body.GetAngularVelocity();

    test(
        "Static body x position unchanged",
        Math.abs(finalX - initialX) < 0.0001,
        `initialX=${initialX.toFixed(4)}, finalX=${finalX.toFixed(4)}`
    );

    test(
        "Static body y position unchanged",
        Math.abs(finalY - initialY) < 0.0001,
        `initialY=${initialY.toFixed(4)}, finalY=${finalY.toFixed(4)}`
    );

    test(
        "Static body angle unchanged",
        Math.abs(finalAngle - initialAngle) < 0.0001,
        `initialAngle=${initialAngle.toFixed(4)}, finalAngle=${finalAngle.toFixed(4)}`
    );

    test(
        "Static body has zero angular velocity",
        Math.abs(angVel) < 0.0001,
        `angularVel=${angVel.toFixed(8)}`
    );

    engine.destroy();
}

// ─── Run All Tests ────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   BODY PHYSICS TEST SUITE");
    console.log("========================================");

    testLinearDampingDifference();
    testLinearDampingDefault();
    testAngularDampingDifference();
    testAngularDampingDefault();
    testLinearVelocityMomentum();
    testNoLinearVelocityStationary();
    testLinearVelocityYComponent();
    testAngularVelocitySpin();
    testNoAngularVelocityStationary();
    testCollidesWithPlayersFalse();
    testCollidesWithPlayersDefault();
    testCombinedVelocities();
    testStaticIgnoresVelocities();

    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
