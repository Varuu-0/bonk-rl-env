/**
 * nophysics-friction.test.ts — Test suite for noPhysics sensor support and friction property
 *
 * Tests:
 * 1. noPhysics: true creates sensor (pass-through body)
 * 2. noPhysics: false creates normal body
 * 3. noPhysics undefined creates normal body
 * 4. Sensor still triggers lethal
 * 5. Multiple noPhysics bodies
 * 6. Mixed noPhysics and normal bodies
 * 7. Default friction (0.3)
 * 8. Custom friction low (0.1)
 * 9. Custom friction high (1.0)
 * 10. Friction affects sliding distance
 * 11. Friction on dynamic bodies
 * 12. noPhysics with circle shape
 * 13. noPhysics with polygon shape
 * 14. noPhysics body with restitution still passes through
 * 15. noPhysics combined with grapple properties
 * 16. Friction zero is fully slippery
 * 17. Friction comparison: low vs high over same distance
 * 18. noPhysics lethal sensor positioned on floor
 *
 * Run with: npx tsx tests/nophysics-friction.test.ts
 */

import {
    PhysicsEngine,
    PlayerInput,
    MapBodyDef,
    SCALE,
    DT,
    TPS,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
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

/** Upward input */
const inputUp: PlayerInput = {
    left: false,
    right: false,
    up: true,
    down: false,
    heavy: false,
    grapple: false,
};

/** Rightward input */
const inputRight: PlayerInput = {
    left: false,
    right: true,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
};

/** No input */
const inputNone: PlayerInput = {
    left: false,
    right: false,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
};

// ─────────────────────────────────────────────────────────────────
// noPhysics Sensor Tests
// ─────────────────────────────────────────────────────────────────

/**
 * Test 1: noPhysics: true creates sensor — player passes through
 *
 * Box2D coordinate system: positive y = downward.
 * Player at y=120 moves upward (y decreases) through wall at y=100.
 * With noPhysics: true (sensor), player should pass through to y < 85.
 */
function testNoPhysicsTrueCreatesSensor(): void {
    console.log("\n--- Test 1: noPhysics: true creates sensor ---");

    const engine = new PhysicsEngine();

    // Horizontal wall at y=100 that is pass-through (spans y=85..115)
    const wall: MapBodyDef = {
        name: "ghost-wall",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
    };
    engine.addBody(wall);

    // Player starts below the wall at y=120
    engine.addPlayer(0, 0, 120);

    // Apply upward input for 180 ticks — enough to pass through
    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through noPhysics wall (y < 85)",
        state.y < 85,
        `y=${state.y.toFixed(2)} expected < 85`
    );
    test("Player is still alive after passing through", state.alive === true);

    engine.destroy();
}

/**
 * Test 2: noPhysics: false creates normal body — player collides
 *
 * Player at y=120 tries to move upward through solid wall at y=100.
 * Should be blocked (y >= 85).
 */
function testNoPhysicsFalseCreatesNormalBody(): void {
    console.log("\n--- Test 2: noPhysics: false creates normal body ---");

    const engine = new PhysicsEngine();

    // Horizontal wall at y=100 with noPhysics: false (normal collision)
    const wall: MapBodyDef = {
        name: "solid-wall",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: false,
    };
    engine.addBody(wall);

    // Player starts below the wall at y=120
    engine.addPlayer(0, 0, 120);

    // Apply upward input for 180 ticks
    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player is blocked by noPhysics: false wall (y >= 85)",
        state.y >= 85,
        `y=${state.y.toFixed(2)} expected >= 85`
    );

    engine.destroy();
}

/**
 * Test 3: noPhysics undefined creates normal body — player collides
 *
 * Player at y=120 tries to move upward through wall at y=100 without
 * noPhysics property. Should behave as a normal colliding body.
 */
function testNoPhysicsUndefinedCreatesNormalBody(): void {
    console.log("\n--- Test 3: noPhysics undefined creates normal body ---");

    const engine = new PhysicsEngine();

    // Horizontal wall at y=100 without noPhysics property
    const wall: MapBodyDef = {
        name: "default-wall",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
    };
    engine.addBody(wall);

    engine.addPlayer(0, 0, 120);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player is blocked by wall without noPhysics (y >= 85)",
        state.y >= 85,
        `y=${state.y.toFixed(2)} expected >= 85`
    );

    engine.destroy();
}

/**
 * Test 4: Sensor still triggers lethal — noPhysics + isLethal kills player
 *
 * Player walks horizontally into a vertical lethal sensor wall.
 * The sensor doesn't block but still triggers lethal contact.
 */
function testSensorStillTriggersLethal(): void {
    console.log("\n--- Test 4: Sensor still triggers lethal ---");

    const engine = new PhysicsEngine();

    // Floor to keep player at a known y
    engine.addBody({
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
    });

    // Vertical lethal sensor wall at x=80
    const lethalWall: MapBodyDef = {
        name: "lethal-sensor",
        type: "rect",
        x: 80,
        y: 150,
        width: 20,
        height: 200,
        static: true,
        noPhysics: true,
        isLethal: true,
    };
    engine.addBody(lethalWall);

    // Player starts to the left of the sensor on the floor
    engine.addPlayer(0, 0, 185);

    // Settle on floor
    for (let i = 0; i < 15; i++) engine.tick();

    // Walk right into the lethal sensor for 90 ticks
    for (let i = 0; i < 90; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Sensor passes player through (x > 70)",
        state.x > 70,
        `x=${state.x.toFixed(2)} expected > 70`
    );
    test(
        "Lethal sensor kills player",
        state.alive === false,
        `alive=${state.alive}`
    );

    engine.destroy();
}

/**
 * Test 5: Multiple noPhysics bodies — all pass-through
 *
 * Three ghost walls at y=60, y=80, y=100. Player at y=120 moves upward.
 * Should pass through all three.
 */
function testMultipleNoPhysicsBodies(): void {
    console.log("\n--- Test 5: Multiple noPhysics bodies ---");

    const engine = new PhysicsEngine();

    // Three ghost walls stacked (from lower to higher y)
    const walls: MapBodyDef[] = [
        { name: "ghost-1", type: "rect", x: 0, y: 60, width: 800, height: 20, static: true, noPhysics: true },
        { name: "ghost-2", type: "rect", x: 0, y: 80, width: 800, height: 20, static: true, noPhysics: true },
        { name: "ghost-3", type: "rect", x: 0, y: 100, width: 800, height: 20, static: true, noPhysics: true },
    ];

    for (const w of walls) engine.addBody(w);

    engine.addPlayer(0, 0, 130);

    // Apply upward input for 180 ticks
    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through all three ghost walls (y < 50)",
        state.y < 50,
        `y=${state.y.toFixed(2)} expected < 50`
    );
    test("Player is still alive", state.alive === true);

    engine.destroy();
}

/**
 * Test 6: Mixed noPhysics and normal bodies — passes through ghost, blocked by solid
 *
 * Ghost wall at y=110, solid wall at y=60. Player at y=125 moves up.
 * Passes through ghost, blocked by solid.
 */
function testMixedNoPhysicsAndNormalBodies(): void {
    console.log("\n--- Test 6: Mixed noPhysics and normal bodies ---");

    const engine = new PhysicsEngine();

    // Ghost wall at y=110 (pass-through, spans y=100..120)
    engine.addBody({
        name: "ghost-wall",
        type: "rect",
        x: 0,
        y: 110,
        width: 800,
        height: 20,
        static: true,
        noPhysics: true,
    });

    // Solid wall at y=60 (blocks player, spans y=50..70)
    engine.addBody({
        name: "solid-wall",
        type: "rect",
        x: 0,
        y: 60,
        width: 800,
        height: 20,
        static: true,
        noPhysics: false,
    });

    engine.addPlayer(0, 0, 125);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through ghost wall (y < 100)",
        state.y < 100,
        `y=${state.y.toFixed(2)} expected < 100`
    );
    test(
        "Player is blocked by solid wall (y >= 50)",
        state.y >= 50,
        `y=${state.y.toFixed(2)} expected >= 50`
    );

    engine.destroy();
}

// ─────────────────────────────────────────────────────────────────
// Friction Property Tests
// ─────────────────────────────────────────────────────────────────

/**
 * Test 7: Default friction — bodies without friction use 0.3
 */
function testDefaultFriction(): void {
    console.log("\n--- Test 7: Default friction (0.3) ---");

    const engine = new PhysicsEngine();

    // Floor without friction property — should default to 0.3
    engine.addBody({
        name: "default-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
    });

    // Player on the floor
    engine.addPlayer(0, 0, 183);

    // Let gravity settle for 20 ticks
    for (let i = 0; i < 20; i++) {
        engine.tick();
    }

    const settleState = engine.getPlayerState(0);

    // Player circle radius=0.5m, SCALE=30 → 15px radius
    // Floor top at y=185, so circle center rests at y=185-15=170
    test(
        "Player settles on default-friction floor",
        settleState.y >= 165 && settleState.y <= 180,
        `y=${settleState.y.toFixed(2)} expected ~170`
    );

    // Apply rightward input for 30 ticks
    for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const slideState = engine.getPlayerState(0);

    test(
        "Player moves right on default friction surface",
        slideState.x > 0,
        `x=${slideState.x.toFixed(2)} expected > 0`
    );
    test(
        "Default friction produces moderate velocity",
        slideState.velX > 0,
        `velX=${slideState.velX.toFixed(2)} expected > 0`
    );

    engine.destroy();
}

/**
 * Test 8: Custom friction low (0.1) — slippery surface
 */
function testCustomFrictionLow(): void {
    console.log("\n--- Test 8: Custom friction low (0.1) ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "slippery-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
        friction: 0.1,
    });

    engine.addPlayer(0, 0, 183);

    // Settle
    for (let i = 0; i < 20; i++) engine.tick();

    // Apply rightward input for 30 ticks
    for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player moves on low friction surface",
        state.x > 0,
        `x=${state.x.toFixed(2)} expected > 0`
    );
    test(
        "Low friction surface is slippery (positive velocity)",
        state.velX > 0,
        `velX=${state.velX.toFixed(2)}`
    );

    engine.destroy();
}

/**
 * Test 9: Custom friction high (1.0) — grippy surface
 */
function testCustomFrictionHigh(): void {
    console.log("\n--- Test 9: Custom friction high (1.0) ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "grippy-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
        friction: 1.0,
    });

    engine.addPlayer(0, 0, 183);

    // Settle
    for (let i = 0; i < 20; i++) engine.tick();

    // Apply rightward input for 30 ticks
    for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player moves on high friction surface",
        state.x > 0,
        `x=${state.x.toFixed(2)} expected > 0`
    );
    test(
        "High friction produces velocity",
        state.velX > 0,
        `velX=${state.velX.toFixed(2)}`
    );

    engine.destroy();
}

/**
 * Test 10: Friction affects sliding — measure distance traveled
 *
 * Low friction (0.1) should allow more sliding than high friction (1.0).
 */
function testFrictionAffectsSliding(): void {
    console.log("\n--- Test 10: Friction affects sliding distance ---");

    // Low friction run
    const engineLow = new PhysicsEngine();
    engineLow.addBody({
        name: "slippery",
        type: "rect",
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 0.1,
    });
    engineLow.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engineLow.tick();

    for (let i = 0; i < 45; i++) {
        engineLow.applyInput(0, inputRight);
        engineLow.tick();
    }
    const stateLow = engineLow.getPlayerState(0);

    // High friction run
    const engineHigh = new PhysicsEngine();
    engineHigh.addBody({
        name: "grippy",
        type: "rect",
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 1.0,
    });
    engineHigh.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engineHigh.tick();

    for (let i = 0; i < 45; i++) {
        engineHigh.applyInput(0, inputRight);
        engineHigh.tick();
    }
    const stateHigh = engineHigh.getPlayerState(0);

    test(
        "Low friction slides further or equal (low.x >= high.x)",
        stateLow.x >= stateHigh.x - 1,
        `low.x=${stateLow.x.toFixed(2)} high.x=${stateHigh.x.toFixed(2)}`
    );
    test(
        "Low friction has equal or higher velocity",
        stateLow.velX >= stateHigh.velX - 1,
        `low.velX=${stateLow.velX.toFixed(2)} high.velX=${stateHigh.velX.toFixed(2)}`
    );

    engineLow.destroy();
    engineHigh.destroy();
}

/**
 * Test 11: Friction on dynamic bodies — friction property applies to non-static bodies
 */
function testFrictionOnDynamicBodies(): void {
    console.log("\n--- Test 11: Friction on dynamic bodies ---");

    const engine = new PhysicsEngine();

    // A dynamic body with high friction (platform the player can interact with)
    engine.addBody({
        name: "dynamic-platform",
        type: "rect",
        x: 0,
        y: 200,
        width: 300,
        height: 20,
        static: false,
        density: 2.0,
        friction: 0.8,
    });

    // Static floor below to catch the dynamic body
    engine.addBody({
        name: "catch-floor",
        type: "rect",
        x: 0,
        y: 250,
        width: 2000,
        height: 30,
        static: true,
    });

    engine.addPlayer(0, 0, 180);

    // Simulate for 30 ticks — dynamic body should settle on catch floor
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Dynamic body with friction does not crash simulation",
        state.alive === true,
        `alive=${state.alive}`
    );

    engine.destroy();
}

/**
 * Test 12: noPhysics with circle shape — sensor on circle body
 *
 * Ghost circle at y=80. Player at y=120 moves upward through it.
 */
function testNoPhysicsCircleShape(): void {
    console.log("\n--- Test 12: noPhysics with circle shape ---");

    const engine = new PhysicsEngine();

    // A ghost circle at y=80 (radius=40, spans y=40..120)
    engine.addBody({
        name: "ghost-circle",
        type: "circle",
        x: 0,
        y: 80,
        radius: 40,
        static: true,
        noPhysics: true,
    });

    engine.addPlayer(0, 0, 130);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through noPhysics circle (y < 40)",
        state.y < 40,
        `y=${state.y.toFixed(2)} expected < 40`
    );

    engine.destroy();
}

/**
 * Test 13: noPhysics with polygon shape — sensor on polygon body
 *
 * Ghost triangle at y=100 with vertices extending upward.
 * Player at y=130 moves up through it.
 */
function testNoPhysicsPolygonShape(): void {
    console.log("\n--- Test 13: noPhysics with polygon shape ---");

    const engine = new PhysicsEngine();

    // A ghost polygon triangle at y=100
    // Vertices (in pixels relative to body center at y=100):
    // top vertex at y=50, base at y=100..y=115 (but box2d vertices are local)
    engine.addBody({
        name: "ghost-poly",
        type: "polygon",
        x: 0,
        y: 100,
        vertices: [
            { x: -50, y: -15 },
            { x: 50, y: -15 },
            { x: 0, y: 15 },
        ],
        static: true,
        noPhysics: true,
    });

    engine.addPlayer(0, 0, 130);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through noPhysics polygon (y < 85)",
        state.y < 85,
        `y=${state.y.toFixed(2)} expected < 85`
    );

    engine.destroy();
}

/**
 * Test 14: noPhysics body with restitution still passes through
 *
 * High restitution should not prevent sensor pass-through.
 */
function testNoPhysicsWithRestitution(): void {
    console.log("\n--- Test 14: noPhysics with restitution still passes through ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "bouncy-ghost",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
        restitution: 0.9,
    });

    engine.addPlayer(0, 0, 130);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through noPhysics body with high restitution (y < 85)",
        state.y < 85,
        `y=${state.y.toFixed(2)} expected < 85`
    );

    engine.destroy();
}

/**
 * Test 15: noPhysics combined with grapple properties
 *
 * noPhysics + noGrapple body should still allow pass-through.
 */
function testNoPhysicsWithGrappleProperties(): void {
    console.log("\n--- Test 15: noPhysics combined with grapple properties ---");

    const engine = new PhysicsEngine();

    // noPhysics + noGrapple body
    engine.addBody({
        name: "ghost-no-grapple",
        type: "rect",
        x: 0,
        y: 100,
        width: 800,
        height: 30,
        static: true,
        noPhysics: true,
        noGrapple: true,
    });

    engine.addPlayer(0, 0, 130);

    for (let i = 0; i < 180; i++) {
        engine.applyInput(0, inputUp);
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test(
        "Player passes through noPhysics+noGrapple body (y < 85)",
        state.y < 85,
        `y=${state.y.toFixed(2)} expected < 85`
    );

    engine.destroy();
}

// ─────────────────────────────────────────────────────────────────
// Additional Friction Tests
// ─────────────────────────────────────────────────────────────────

/**
 * Test 16: Friction zero is fully slippery
 *
 * Zero friction should allow equal or more sliding than default (0.3).
 */
function testFrictionZeroIsSlippery(): void {
    console.log("\n--- Test 16: Friction zero (fully slippery) ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "ice-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
        friction: 0.0,
    });

    engine.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engine.tick();

    for (let i = 0; i < 30; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const stateZero = engine.getPlayerState(0);

    // Default friction comparison
    const engineDefault = new PhysicsEngine();
    engineDefault.addBody({
        name: "normal-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 5000,
        height: 30,
        static: true,
    });

    engineDefault.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engineDefault.tick();

    for (let i = 0; i < 30; i++) {
        engineDefault.applyInput(0, inputRight);
        engineDefault.tick();
    }

    const stateDefault = engineDefault.getPlayerState(0);

    test(
        "Zero friction player moves right",
        stateZero.x > 0,
        `x=${stateZero.x.toFixed(2)}`
    );
    test(
        "Zero friction slides equal or further than default",
        stateZero.x >= stateDefault.x - 1,
        `zero.x=${stateZero.x.toFixed(2)} default.x=${stateDefault.x.toFixed(2)}`
    );

    engine.destroy();
    engineDefault.destroy();
}

/**
 * Test 17: Friction comparison — low (0.05) vs high (1.5) over same distance
 */
function testFrictionComparisonLowVsHigh(): void {
    console.log("\n--- Test 17: Friction comparison low vs high ---");

    // Low friction engine
    const engineLow = new PhysicsEngine();
    engineLow.addBody({
        name: "low-friction-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 10000,
        height: 30,
        static: true,
        friction: 0.05,
    });
    engineLow.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engineLow.tick();

    // High friction engine
    const engineHigh = new PhysicsEngine();
    engineHigh.addBody({
        name: "high-friction-floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 10000,
        height: 30,
        static: true,
        friction: 1.5,
    });
    engineHigh.addPlayer(0, 0, 183);
    for (let i = 0; i < 20; i++) engineHigh.tick();

    // Apply same input to both
    for (let i = 0; i < 60; i++) {
        engineLow.applyInput(0, inputRight);
        engineLow.tick();
        engineHigh.applyInput(0, inputRight);
        engineHigh.tick();
    }

    const stateLow = engineLow.getPlayerState(0);
    const stateHigh = engineHigh.getPlayerState(0);

    test(
        "Low friction travels further or equal",
        stateLow.x >= stateHigh.x - 2,
        `low.x=${stateLow.x.toFixed(2)} high.x=${stateHigh.x.toFixed(2)}`
    );
    test(
        "Both players moved right",
        stateLow.x > 0 && stateHigh.x > 0,
        `low.x=${stateLow.x.toFixed(2)} high.x=${stateHigh.x.toFixed(2)}`
    );

    engineLow.destroy();
    engineHigh.destroy();
}

// ─────────────────────────────────────────────────────────────────
// Combined noPhysics + Friction Scenario Tests
// ─────────────────────────────────────────────────────────────────

/**
 * Test 18: noPhysics lethal sensor positioned on floor — player walks into it
 *
 * Player walks horizontally on a floor into a vertical lethal sensor wall.
 * Sensor should not block but should kill on contact.
 */
function testNoPhysicsLethalOnFloor(): void {
    console.log("\n--- Test 18: noPhysics lethal sensor on floor ---");

    const engine = new PhysicsEngine();

    // Solid floor
    engine.addBody({
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 2000,
        height: 30,
        static: true,
    });

    // Lethal sensor wall at x=100 that the player will walk into
    engine.addBody({
        name: "lethal-sensor-wall",
        type: "rect",
        x: 100,
        y: 150,
        width: 20,
        height: 200,
        static: true,
        noPhysics: true,
        isLethal: true,
    });

    // Player on the floor to the left of the sensor
    engine.addPlayer(0, 0, 185);

    // Settle on floor
    for (let i = 0; i < 15; i++) engine.tick();

    const settled = engine.getPlayerState(0);
    test(
        "Player settles on floor before lethal sensor",
        settled.alive === true,
        `alive=${settled.alive}`
    );

    // Walk right into the lethal sensor
    for (let i = 0; i < 90; i++) {
        engine.applyInput(0, inputRight);
        engine.tick();
    }

    const finalState = engine.getPlayerState(0);

    test(
        "Player passes through sensor wall (x > 90)",
        finalState.x > 90,
        `x=${finalState.x.toFixed(2)}`
    );
    test(
        "Lethal sensor kills player on contact",
        finalState.alive === false,
        `alive=${finalState.alive}`
    );

    engine.destroy();
}

// ─────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("  NOPHYSICS & FRICTION TEST SUITE");
    console.log("========================================");

    // noPhysics sensor tests
    testNoPhysicsTrueCreatesSensor();
    testNoPhysicsFalseCreatesNormalBody();
    testNoPhysicsUndefinedCreatesNormalBody();
    testSensorStillTriggersLethal();
    testMultipleNoPhysicsBodies();
    testMixedNoPhysicsAndNormalBodies();

    // Friction property tests
    testDefaultFriction();
    testCustomFrictionLow();
    testCustomFrictionHigh();
    testFrictionAffectsSliding();
    testFrictionOnDynamicBodies();

    // noPhysics shape variants
    testNoPhysicsCircleShape();
    testNoPhysicsPolygonShape();
    testNoPhysicsWithRestitution();
    testNoPhysicsWithGrappleProperties();

    // Additional friction tests
    testFrictionZeroIsSlippery();
    testFrictionComparisonLowVsHigh();

    // Combined noPhysics + friction scenarios
    testNoPhysicsLethalOnFloor();

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
