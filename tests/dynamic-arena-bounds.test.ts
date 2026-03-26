/**
 * dynamic-arena-bounds.test.ts — Test suite for dynamic arena kill bounds
 * 
 * Tests:
 *  1. Default bounds with no bodies
 *  2. Bounds calculated from single body
 *  3. Bounds calculated from multiple bodies
 *  4. Bounds include 5m margin beyond body extents
 *  5. Player dies outside dynamic bounds
 *  6. Player survives inside dynamic bounds
 *  7. Large map bounds (WDB-style)
 *  8. Asymmetric bounds (bodies on one side)
 *  9. Bounds recalculate on each addBody
 * 10. Reset preserves bound recalculation
 * 11. Rect body with height affects arena half-height
 * 12. Negative coordinate bodies expand bounds correctly
 * 
 * Run with: npx tsx tests/dynamic-arena-bounds.test.ts
 */

import {
    PhysicsEngine,
    MapBodyDef,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
    SCALE
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

/**
 * Test 1: Default bounds with no map bodies
 * Without any bodies, arenaHalfWidth/arenaHalfHeight stay at defaults (25m / 20m).
 * A player at the edge of default bounds should die; one at center should live.
 */
function testDefaultBoundsNoBodies(): void {
    console.log("\n--- Test 1: Default Bounds (No Bodies) ---");

    const engine = new PhysicsEngine();

    // Player at origin — well within default 25m x 20m bounds
    engine.addPlayer(0, 0, 0);
    // Player just outside default horizontal bound (25m = 750px, so 760px > 750px)
    engine.addPlayer(1, ARENA_HALF_WIDTH * SCALE + 10, 0);

    engine.tick();

    const center = engine.getPlayerState(0);
    const outside = engine.getPlayerState(1);

    test("Center player alive with no map bodies", center.alive === true);
    test("Player outside default bounds is dead", outside.alive === false);

    engine.destroy();
}

/**
 * Test 2: Bounds expand for a single body
 * Adding one body should cause calculateArenaBounds to set larger bounds.
 */
function testSingleBodyBounds(): void {
    console.log("\n--- Test 2: Single Body Bounds ---");

    const engine = new PhysicsEngine();

    const body: MapBodyDef = {
        name: "platform",
        type: "rect",
        x: 0,
        y: 0,
        width: 300,
        height: 30,
        static: true
    };
    engine.addBody(body);

    // Player within the expanded bounds should survive
    engine.addPlayer(0, 50, 0);
    engine.tick();

    const state = engine.getPlayerState(0);
    test("Player near single body is alive", state.alive === true);

    engine.destroy();
}

/**
 * Test 3: Bounds expand to contain multiple bodies
 * With bodies at different positions, bounds should cover all of them.
 */
function testMultipleBodiesBounds(): void {
    console.log("\n--- Test 3: Multiple Bodies Bounds ---");

    const engine = new PhysicsEngine();

    // Two bodies far apart on X axis
    engine.addBody({
        name: "left", type: "rect",
        x: -300, y: 0, width: 100, height: 30, static: true
    });
    engine.addBody({
        name: "right", type: "rect",
        x: 300, y: 0, width: 100, height: 30, static: true
    });

    // Player between them — should be inside bounds
    engine.addPlayer(0, 0, 0);
    engine.tick();

    const state = engine.getPlayerState(0);
    test("Player between multiple bodies is alive", state.alive === true);

    engine.destroy();
}

/**
 * Test 4: 5m margin beyond body extents
 * calculateArenaBounds uses a fixed 50/SCALE (~1.67m) extent estimate per body
 * plus a 5m margin. Verify the margin keeps nearby players alive.
 */
function testFiveMetreMargin(): void {
    console.log("\n--- Test 4: Five Metre Margin ---");

    const engine = new PhysicsEngine();

    // Body at origin — estimated extent ~1.67m, plus 5m margin → ~6.67m half-width
    engine.addBody({
        name: "center", type: "rect",
        x: 0, y: 0, width: 100, height: 30, static: true
    });

    // Player at 5m (150px) — within margin
    engine.addPlayer(0, 5 * SCALE, 0);
    engine.tick();

    const inside = engine.getPlayerState(0);
    test("Player within 5m margin is alive", inside.alive === true);

    engine.destroy();
}

/**
 * Test 5: Player dies outside dynamic bounds
 * After adding a body, a player far beyond the expanded bounds should die.
 */
function testPlayerDiesOutsideDynamicBounds(): void {
    console.log("\n--- Test 5: Player Dies Outside Dynamic Bounds ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "small", type: "rect",
        x: 0, y: 0, width: 100, height: 30, static: true
    });

    // Player way outside — at x=900px (30m). 
    // Bounds from body at 0: max(0+1.67, |0-1.67|)+5 = 6.67m. 30m >> 6.67m.
    engine.addPlayer(0, 900, 0);
    engine.tick();

    const state = engine.getPlayerState(0);
    test("Player outside dynamic bounds is dead", state.alive === false);

    engine.destroy();
}

/**
 * Test 6: Player survives inside dynamic bounds
 * After adding a body, a player near that body should remain alive.
 */
function testPlayerSurvivesInsideDynamicBounds(): void {
    console.log("\n--- Test 6: Player Survives Inside Dynamic Bounds ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 100, width: 600, height: 30, static: true
    });

    // Player right on top of the body
    engine.addPlayer(0, 0, 80);
    engine.tick();

    const state = engine.getPlayerState(0);
    test("Player on body stays alive", state.alive === true);

    engine.destroy();
}

/**
 * Test 7: Large map bounds (WDB-style ~1825px wide body)
 * A wide floor far from origin should expand bounds significantly.
 * Player within should survive; player beyond should die.
 */
function testLargeMapBounds(): void {
    console.log("\n--- Test 7: Large Map Bounds (WDB-style) ---");

    const engine = new PhysicsEngine();

    // WDB-like floor: 1825px wide, offset to x=1000px
    engine.addBody({
        name: "wdb-floor", type: "rect",
        x: 1000, y: 0, width: 1825, height: 30, static: true
    });

    // Body center at 1000/30 = 33.33m. Extent estimate: 50/30=1.67m.
    // minX = 33.33-1.67 = 31.67, maxX = 33.33+1.67 = 35.0
    // halfWidth = max(31.67, 35.0) + 5 = 40.0m = 1200px

    // Player at 900px (30m) — within 40m half-width
    engine.addPlayer(0, 900, 0);
    // Player at 1250px (41.67m) — outside 40m half-width
    engine.addPlayer(1, 1250, 0);

    engine.tick();

    const inside = engine.getPlayerState(0);
    const outside = engine.getPlayerState(1);

    test("Player within large map bounds is alive", inside.alive === true);
    test("Player outside large map bounds is dead", outside.alive === true ? false : true);

    engine.destroy();
}

/**
 * Test 8: Asymmetric bounds — bodies only on one side of origin
 * Bounds should still expand to cover the far body.
 */
function testAsymmetricBounds(): void {
    console.log("\n--- Test 8: Asymmetric Bounds ---");

    const engine = new PhysicsEngine();

    // Body only on the right side
    engine.addBody({
        name: "right-only", type: "rect",
        x: 600, y: 0, width: 200, height: 30, static: true
    });

    // Center at 600/30 = 20m. Extent: 1.67m.
    // maxX = 21.67, minX = 18.33 → halfWidth = max(18.33, 21.67)+5 = 26.67m

    // Player at 720px (24m) — within 26.67m
    engine.addPlayer(0, 720, 0);
    // Player at -10px (-0.33m) — within 26.67m
    engine.addPlayer(1, -10, 0);

    engine.tick();

    const right = engine.getPlayerState(0);
    const left = engine.getPlayerState(1);

    test("Player near right-side body is alive", right.alive === true);
    test("Player on opposite side is alive", left.alive === true);

    engine.destroy();
}

/**
 * Test 9: Bounds recalculate on each addBody
 * Each addBody call invokes calculateArenaBounds, progressively expanding bounds.
 * Add a small body first, then a far body — the second should widen bounds.
 */
function testBoundsRecalculateOnAddBody(): void {
    console.log("\n--- Test 9: Bounds Recalculate on Each addBody ---");

    const engine = new PhysicsEngine();

    // First body near origin
    engine.addBody({
        name: "near", type: "rect",
        x: 0, y: 0, width: 100, height: 30, static: true
    });

    // At this point halfWidth ≈ 6.67m. Player at 500px (16.67m) would be dead.
    engine.addPlayer(0, 500, 0);
    engine.tick();

    const beforeState = engine.getPlayerState(0);
    test("Player outside initial bounds is dead", beforeState.alive === false);

    // Now add a far body — this recalculates bounds wider
    engine.addBody({
        name: "far", type: "rect",
        x: 800, y: 0, width: 200, height: 30, static: true
    });

    // New engine to test the recalculated bounds apply to new players
    const engine2 = new PhysicsEngine();
    engine2.addBody({
        name: "near", type: "rect",
        x: 0, y: 0, width: 100, height: 30, static: true
    });
    engine2.addBody({
        name: "far", type: "rect",
        x: 800, y: 0, width: 200, height: 30, static: true
    });

    // After both bodies: center at 800/30=26.67m. halfWidth = 26.67+1.67+5 = 33.33m
    // Player at 500px (16.67m) is now within bounds.
    engine2.addPlayer(0, 500, 0);
    engine2.tick();

    const afterState = engine2.getPlayerState(0);
    test("Player within recalculated bounds is alive", afterState.alive === true);

    engine.destroy();
    engine2.destroy();
}

/**
 * Test 10: Reset clears bodies but preserves recalculation on re-add
 * After reset(), platformBodies is empty → bounds revert to defaults.
 * Adding new bodies recalculates fresh.
 */
function testResetPreservesRecalculation(): void {
    console.log("\n--- Test 10: Reset Preserves Bound Recalculation ---");

    const engine = new PhysicsEngine();

    // Add a far body and a player inside its bounds
    engine.addBody({
        name: "far", type: "rect",
        x: 500, y: 0, width: 200, height: 30, static: true
    });
    engine.addPlayer(0, 550, 0);
    engine.tick();

    const beforeReset = engine.getPlayerState(0);
    test("Player alive before reset", beforeReset.alive === true);

    // Reset — destroys all bodies, platformBodies = []
    engine.reset();

    // Add a body near origin after reset
    engine.addBody({
        name: "small", type: "rect",
        x: 0, y: 0, width: 100, height: 30, static: true
    });

    // Bounds should now be small again (~6.67m half-width)
    // Player at 500px (16.67m) should die
    engine.addPlayer(0, 500, 0);
    engine.tick();

    const afterReset = engine.getPlayerState(0);
    test("Player outside post-reset bounds is dead", afterReset.alive === false);

    engine.destroy();
}

/**
 * Test 11: Tall body expands arena half-height
 * A body with large vertical extent should increase the kill zone vertically.
 */
function testTallBodyExpandsHeight(): void {
    console.log("\n--- Test 11: Tall Body Expands Height ---");

    const engine = new PhysicsEngine();

    // Tall vertical platform at y=200
    engine.addBody({
        name: "wall", type: "rect",
        x: 0, y: 600, width: 30, height: 300, static: true
    });

    // Center at 600/30 = 20m. Extent estimate: 1.67m.
    // maxY = 21.67 → halfHeight = 21.67 + 5 = 26.67m
    // Player at y=600px (20m) should be alive
    engine.addPlayer(0, 0, 600);
    // Player at y=850px (28.33m) should be dead (>26.67m)
    engine.addPlayer(1, 0, 850);

    engine.tick();

    const inside = engine.getPlayerState(0);
    const outside = engine.getPlayerState(1);

    test("Player within vertical bounds is alive", inside.alive === true);
    test("Player outside vertical bounds is dead", outside.alive === false);

    engine.destroy();
}

/**
 * Test 12: Negative coordinate bodies expand bounds correctly
 * Bodies on the negative side should also be covered by bounds.
 */
function testNegativeCoordinateBodies(): void {
    console.log("\n--- Test 12: Negative Coordinate Bodies ---");

    const engine = new PhysicsEngine();

    // Body far on the negative X side
    engine.addBody({
        name: "left-platform", type: "rect",
        x: -600, y: 0, width: 200, height: 30, static: true
    });

    // Center at -600/30 = -20m. Extent: 1.67m.
    // minX = -21.67 → halfWidth = max(|-21.67|, |-18.33|) + 5 = 26.67m

    // Player at -720px (-24m) — within 26.67m
    engine.addPlayer(0, -720, 0);
    // Player at -850px (-28.33m) — outside 26.67m
    engine.addPlayer(1, -850, 0);

    engine.tick();

    const inside = engine.getPlayerState(0);
    const outside = engine.getPlayerState(1);

    test("Player near negative body is alive", inside.alive === true);
    test("Player beyond negative bounds is dead", outside.alive === false);

    engine.destroy();
}

/**
 * Run all tests
 */
async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("  DYNAMIC ARENA BOUNDS TEST SUITE");
    console.log("========================================");

    testDefaultBoundsNoBodies();
    testSingleBodyBounds();
    testMultipleBodiesBounds();
    testFiveMetreMargin();
    testPlayerDiesOutsideDynamicBounds();
    testPlayerSurvivesInsideDynamicBounds();
    testLargeMapBounds();
    testAsymmetricBounds();
    testBoundsRecalculateOnAddBody();
    testResetPreservesRecalculation();
    testTallBodyExpandsHeight();
    testNegativeCoordinateBodies();

    console.log("\n========================================");
    console.log("  RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
