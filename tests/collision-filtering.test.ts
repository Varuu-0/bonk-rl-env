/**
 * collision-filtering.test.ts — Test suite for collision filtering (collides.g1-g4)
 *
 * Tests:
 *  1. Default collision (no collides property) — blocks all players
 *  2. collides.g1: false — player 0 passes through
 *  3. collides.g2: false — player 1 passes through
 *  4. collides.g1: false — player 1 is blocked
 *  5. collides.g2: false — player 0 is blocked
 *  6. All collides false — both players pass through
 *  7. All collides true — both players blocked
 *  8. Only g1 true — player 0 blocked, player 1 passes
 *  9. Only g2 true — player 1 blocked, player 0 passes
 * 10. g1+g2 true — both players blocked
 * 11. g3/g4 groups — neither player blocked (no player uses g3/g4)
 * 12. Player 0 category is 0x0002 (g1)
 * 13. Player 1 category is 0x0004 (g2)
 * 14. Team barrier: g1-only barrier blocks g1, passes g2
 * 15. Team barrier: g2-only barrier blocks g2, passes g1
 * 16. Dynamic body with collides filtering
 * 17. Multiple bodies with different collides settings
 *
 * Run with: npx tsx tests/collision-filtering.test.ts
 */

import {
    PhysicsEngine,
    PlayerInput,
    MapBodyDef,
    SCALE,
    DT,
    TPS,
} from "../src/core/physics-engine";

// Test counters
let testsPassed = 0;
let testsFailed = 0;

function test(name: string, passed: boolean, details?: string): void {
    if (passed) {
        console.log("+ " + name);
        testsPassed++;
    } else {
        console.log("X " + name + (details ? ": " + details : ""));
        testsFailed++;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────

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

const NO_INPUT: PlayerInput = {
    left: false,
    right: false,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
};

/**
 * Create a vertical wall at (wallX, 0) with the given collides settings.
 * The wall is tall enough that a player cannot go around it.
 */
function makeWall(wallX: number, collides?: MapBodyDef["collides"]): MapBodyDef {
    return {
        name: "wall",
        type: "rect",
        x: wallX,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides,
    };
}

/**
 * Run a collision test:
 *  1. Place player at startX
 *  2. Add wall at wallX
 *  3. Apply input for several ticks
 *  4. Return final player X position
 */
function runCollisionScenario(
    playerId: number,
    startX: number,
    wallX: number,
    input: PlayerInput,
    collides?: MapBodyDef["collides"],
    ticks: number = 60
): { finalX: number; engine: PhysicsEngine } {
    const engine = new PhysicsEngine();
    engine.addPlayer(playerId, startX, 0);
    engine.addBody(makeWall(wallX, collides));

    for (let i = 0; i < ticks; i++) {
        engine.applyInput(playerId, input);
        engine.tick();
    }

    const state = engine.getPlayerState(playerId);
    return { finalX: state.x, engine };
}

// ─── Tests ────────────────────────────────────────────────────────────

function testDefaultCollisionBlocksAllPlayers(): void {
    console.log("\n--- Test 1: Default collision (no collides property) ---");

    // Player 0: should be blocked by wall with no collides filter
    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT);
        test(
            "Player 0 blocked by default wall",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    // Player 1: should also be blocked
    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT);
        test(
            "Player 1 blocked by default wall",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testCollidesG1False_Player0Passes(): void {
    console.log("\n--- Test 2: collides.g1=false — player 0 passes through ---");

    const collides = { g1: false, g2: true, g3: true, g4: true };
    const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);

    test(
        "Player 0 passes through wall with g1=false",
        finalX > 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testCollidesG2False_Player1Passes(): void {
    console.log("\n--- Test 3: collides.g2=false — player 1 passes through ---");

    const collides = { g1: true, g2: false, g3: true, g4: true };
    const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);

    test(
        "Player 1 passes through wall with g2=false",
        finalX > 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testCollidesG1False_Player1Blocked(): void {
    console.log("\n--- Test 4: collides.g1=false — player 1 is still blocked ---");

    const collides = { g1: false, g2: true, g3: true, g4: true };
    const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);

    test(
        "Player 1 blocked by wall with g1=false (g2 still true)",
        finalX < 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testCollidesG2False_Player0Blocked(): void {
    console.log("\n--- Test 5: collides.g2=false — player 0 is still blocked ---");

    const collides = { g1: true, g2: false, g3: true, g4: true };
    const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);

    test(
        "Player 0 blocked by wall with g2=false (g1 still true)",
        finalX < 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testAllCollidesFalse_BothPlayersPass(): void {
    console.log("\n--- Test 6: All collides false — both players pass through ---");

    const collides = { g1: false, g2: false, g3: false, g4: false };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 passes through wall with all collides false",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 passes through wall with all collides false",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testAllCollidesTrue_BothPlayersBlocked(): void {
    console.log("\n--- Test 7: All collides true — both players blocked ---");

    const collides = { g1: true, g2: true, g3: true, g4: true };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 blocked by wall with all collides true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 blocked by wall with all collides true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testOnlyG1True(): void {
    console.log("\n--- Test 8: Only g1 true — player 0 blocked, player 1 passes ---");

    const collides = { g1: true, g2: false, g3: false, g4: false };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 blocked when only g1=true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 passes when only g1=true",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testOnlyG2True(): void {
    console.log("\n--- Test 9: Only g2 true — player 1 blocked, player 0 passes ---");

    const collides = { g1: false, g2: true, g3: false, g4: false };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 passes when only g2=true",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 blocked when only g2=true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testG1G2BothTrue(): void {
    console.log("\n--- Test 10: g1+g2 true — both players blocked ---");

    const collides = { g1: true, g2: true, g3: false, g4: false };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 blocked when g1+g2=true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 blocked when g1+g2=true",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testG3G4Only_NeitherPlayerBlocked(): void {
    console.log("\n--- Test 11: Only g3/g4 true — no player uses g3/g4, both pass ---");

    const collides = { g1: false, g2: false, g3: true, g4: true };

    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 0 passes when only g3/g4=true",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides);
        test(
            "Player 1 passes when only g3/g4=true",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testPlayer0CategoryBits(): void {
    console.log("\n--- Test 12: Player 0 collision category is 0x0002 (g1) ---");

    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);

    // Access internal body to check filter — we verify indirectly via collision behavior.
    // Player 0 (g1, 0x0002) should collide with a body that has g1=true.
    const collides_g1_true = { g1: true, g2: false, g3: false, g4: false };
    const { finalX } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, collides_g1_true);
    test(
        "Player 0 (category 0x0002) collides with g1=true body",
        finalX < 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testPlayer1CategoryBits(): void {
    console.log("\n--- Test 13: Player 1 collision category is 0x0004 (g2) ---");

    const engine = new PhysicsEngine();
    engine.addPlayer(1, 0, 0);

    // Player 1 (g2, 0x0004) should collide with a body that has g2=true.
    const collides_g2_true = { g1: false, g2: true, g3: false, g4: false };
    const { finalX } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, collides_g2_true);
    test(
        "Player 1 (category 0x0004) collides with g2=true body",
        finalX < 50,
        `finalX=${finalX.toFixed(2)}`
    );
    engine.destroy();
}

function testTeamBarrierG1(): void {
    console.log("\n--- Test 14: G1 team barrier — blocks g1, passes g2 ---");

    const g1Barrier = { g1: true, g2: false, g3: false, g4: false };

    // Player 0 (g1) should be blocked
    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, g1Barrier);
        test(
            "G1 barrier blocks player 0",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    // Player 1 (g2) should pass through
    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, g1Barrier);
        test(
            "G1 barrier lets player 1 pass",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testTeamBarrierG2(): void {
    console.log("\n--- Test 15: G2 team barrier — blocks g2, passes g1 ---");

    const g2Barrier = { g1: false, g2: true, g3: false, g4: false };

    // Player 1 (g2) should be blocked
    {
        const { finalX, engine } = runCollisionScenario(1, 0, 50, RIGHT_INPUT, g2Barrier);
        test(
            "G2 barrier blocks player 1",
            finalX < 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }

    // Player 0 (g1) should pass through
    {
        const { finalX, engine } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, g2Barrier);
        test(
            "G2 barrier lets player 0 pass",
            finalX > 50,
            `finalX=${finalX.toFixed(2)}`
        );
        engine.destroy();
    }
}

function testDynamicBodyWithCollides(): void {
    console.log("\n--- Test 16: Dynamic body with collides filtering ---");

    const engine = new PhysicsEngine();

    // Add a dynamic body (non-static) with collides filter
    const dynamicBody: MapBodyDef = {
        name: "dynamic_block",
        type: "rect",
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

    // Player 0 should pass through (g1=false)
    for (let i = 0; i < 60; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test(
        "Player 0 passes through dynamic body with g1=false",
        state.x > 50,
        `finalX=${state.x.toFixed(2)}`
    );

    engine.destroy();
}

function testMultipleBodiesDifferentCollides(): void {
    console.log("\n--- Test 17: Multiple bodies with different collides settings ---");

    const engine = new PhysicsEngine();

    // Wall at x=30: only blocks g1
    engine.addBody({
        name: "g1_wall",
        type: "rect",
        x: 30,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: true, g2: false, g3: false, g4: false },
    });

    // Wall at x=70: only blocks g2
    engine.addBody({
        name: "g2_wall",
        type: "rect",
        x: 70,
        y: 0,
        width: 20,
        height: 2000,
        static: true,
        collides: { g1: false, g2: true, g3: false, g4: false },
    });

    engine.addPlayer(0, 0, 0);
    engine.addPlayer(1, 0, 0);

    // Move both players right for 90 ticks
    for (let i = 0; i < 90; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.applyInput(1, RIGHT_INPUT);
        engine.tick();
    }

    const p0 = engine.getPlayerState(0);
    const p1 = engine.getPlayerState(1);

    // Player 0 (g1): blocked by first wall at x=30, passes through second wall at x=70
    test(
        "Player 0 blocked by g1 wall at x=30",
        p0.x < 35,
        `finalX=${p0.x.toFixed(2)}`
    );

    // Player 1 (g2): passes through first wall at x=30, blocked by second wall at x=70
    test(
        "Player 1 passes through g1 wall at x=30",
        p1.x > 35,
        `finalX=${p1.x.toFixed(2)}`
    );

    test(
        "Player 1 blocked by g2 wall at x=70",
        p1.x < 75,
        `finalX=${p1.x.toFixed(2)}`
    );

    engine.destroy();
}

function testCollidesUndefinedVsExplicitTrue(): void {
    console.log("\n--- Test 18: Undefined collides behaves same as all-true ---");

    // No collides property (undefined) — should block everything
    const { finalX: noFilter } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, undefined);

    // Explicit all-true — should also block everything
    const { finalX: allTrue } = runCollisionScenario(0, 0, 50, RIGHT_INPUT, {
        g1: true,
        g2: true,
        g3: true,
        g4: true,
    });

    test(
        "No collides property blocks player 0",
        noFilter < 50,
        `finalX=${noFilter.toFixed(2)}`
    );
    test(
        "All-true collides blocks player 0",
        allTrue < 50,
        `finalX=${allTrue.toFixed(2)}`
    );
}

function testPlayerMovesFreelyWithoutWall(): void {
    console.log("\n--- Test 19: Player moves freely when no wall present ---");

    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);

    for (let i = 0; i < 60; i++) {
        engine.applyInput(0, RIGHT_INPUT);
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test(
        "Player 0 moves right past x=50 without any wall",
        state.x > 50,
        `finalX=${state.x.toFixed(2)}`
    );

    engine.destroy();
}

function testOppositeDirectionCollision(): void {
    console.log("\n--- Test 20: Collision filtering works in opposite direction ---");

    const collides = { g1: true, g2: false, g3: false, g4: false };

    // Player 0 moving LEFT into a wall on the left
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    engine.addBody(makeWall(-50, collides));

    for (let i = 0; i < 60; i++) {
        engine.applyInput(0, LEFT_INPUT);
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test(
        "Player 0 blocked moving left into g1 wall",
        state.x > -50,
        `finalX=${state.x.toFixed(2)}`
    );

    // Player 1 moving left should pass through
    const engine2 = new PhysicsEngine();
    engine2.addPlayer(1, 0, 0);
    engine2.addBody(makeWall(-50, collides));

    for (let i = 0; i < 60; i++) {
        engine2.applyInput(1, LEFT_INPUT);
        engine2.tick();
    }

    const state2 = engine2.getPlayerState(1);
    test(
        "Player 1 passes through g1 wall moving left",
        state2.x < -50,
        `finalX=${state2.x.toFixed(2)}`
    );

    engine.destroy();
    engine2.destroy();
}

// ─── Main ─────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   COLLISION FILTERING TEST SUITE");
    console.log("========================================");

    testDefaultCollisionBlocksAllPlayers();
    testCollidesG1False_Player0Passes();
    testCollidesG2False_Player1Passes();
    testCollidesG1False_Player1Blocked();
    testCollidesG2False_Player0Blocked();
    testAllCollidesFalse_BothPlayersPass();
    testAllCollidesTrue_BothPlayersBlocked();
    testOnlyG1True();
    testOnlyG2True();
    testG1G2BothTrue();
    testG3G4Only_NeitherPlayerBlocked();
    testPlayer0CategoryBits();
    testPlayer1CategoryBits();
    testTeamBarrierG1();
    testTeamBarrierG2();
    testDynamicBodyWithCollides();
    testMultipleBodiesDifferentCollides();
    testCollidesUndefinedVsExplicitTrue();
    testPlayerMovesFreelyWithoutWall();
    testOppositeDirectionCollision();

    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
