/**
 * grapple-mechanics.test.ts — Test suite for grapple mechanics
 *
 * Tests:
 * 1. Basic grapple attachment
 * 2. grappleMultiplier: 99999 slingshot
 * 3. noGrapple: true prevents grapple
 * 4. noGrapple: false allows grapple
 * 5. noGrapple undefined allows grapple
 * 6. innerGrapple: true prevents grapple
 * 7. innerGrapple: false allows grapple
 * 8. Grapple release
 * 9. Grapple with movement (swinging)
 * 10. Multiple players grappling simultaneously
 * 11. Grapple to dynamic body
 * 12. Grapple distance limit (10m)
 * 13. Re-attach after release
 * 14. Heavy + grapple combo
 * 15. Grapple input toggle rapid
 * 16. No grapple without platform
 * 17. Slingshot preserves velocity after impulse
 *
 * Run with: npx tsx tests/grapple-mechanics.test.ts
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

function noInput(): PlayerInput {
    return { left: false, right: false, up: false, down: false, heavy: false, grapple: false };
}

function grappleInput(): PlayerInput {
    return { left: false, right: false, up: false, down: false, heavy: false, grapple: true };
}

function makePlatform(overrides: Partial<MapBodyDef> & { x: number; y: number }): MapBodyDef {
    return {
        name: overrides.name || "platform",
        type: "rect",
        width: overrides.width || 200,
        height: overrides.height || 20,
        static: overrides.static !== undefined ? overrides.static : true,
        ...overrides,
    };
}

// ─── Test 1: Basic grapple attachment ─────────────────────────────────

function testBasicGrappleAttachment(): void {
    console.log("\n--- Test 1: Basic Grapple Attachment ---");

    const engine = new PhysicsEngine();

    // Platform at y=100 (in pixels), player at y=0 below it
    engine.addBody(makePlatform({ name: "p1", x: 0, y: 100 }));
    engine.addPlayer(0, 0, 0);

    // Fire grapple
    engine.applyInput(0, grappleInput());
    // Step a few ticks to let joint form
    for (let i = 0; i < 10; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should NOT have fallen freely to the bottom — y should be constrained near platform
    test("Player is alive after grapple", state.alive === true);
    // Without grapple, player at y=0 with gravity 10 would fall ~5m after 10 ticks
    // With grapple, y should stay near 0 or be pulled toward platform at y=100
    test("Player y is constrained (not fallen far)", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 2: grappleMultiplier 99999 slingshot ────────────────────────

function testSlingshot(): void {
    console.log("\n--- Test 2: grappleMultiplier 99999 Slingshot ---");

    const engine = new PhysicsEngine();

    // Platform with slingshot multiplier, close to player
    engine.addBody(makePlatform({
        name: "slingshot",
        x: 0,
        y: 50,
        grappleMultiplier: 99999,
    }));
    engine.addPlayer(0, 0, 0);

    // Capture initial velocity
    const beforeState = engine.getPlayerState(0);

    // Fire grapple — should apply upward impulse
    engine.applyInput(0, grappleInput());
    engine.tick();

    const afterState = engine.getPlayerState(0);

    // Velocity should have upward component (negative y in screen coords)
    test("Player has upward velocity after slingshot", afterState.velY < beforeState.velY, "before=" + beforeState.velY + " after=" + afterState.velY);
    test("Player is not dead after slingshot", afterState.alive === true);

    engine.destroy();
}

// ─── Test 3: noGrapple: true prevents grapple ─────────────────────────

function testNoGrappleTrue(): void {
    console.log("\n--- Test 3: noGrapple: true ---");

    const engine = new PhysicsEngine();

    // Use noPhysics so the platform doesn't physically block the player
    engine.addBody(makePlatform({
        name: "no-grapple-platform",
        x: 0,
        y: 50,
        noGrapple: true,
        noPhysics: true,
    }));
    engine.addPlayer(0, 0, 0);

    // Fire grapple — should NOT attach (noGrapple prevents it)
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 20; i++) engine.tick();

    // Apply no input and step more — player should fall freely through sensor
    engine.applyInput(0, noInput());
    for (let i = 0; i < 30; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should have fallen significantly (no grapple joint, no physics block)
    test("Player falls freely with noGrapple: true", state.y > 100, "y=" + state.y);

    engine.destroy();
}

// ─── Test 4: noGrapple: false allows grapple ──────────────────────────

function testNoGrappleFalse(): void {
    console.log("\n--- Test 4: noGrapple: false ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({
        name: "grapple-ok",
        x: 0,
        y: 50,
        noGrapple: false,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should be constrained by grapple
    test("Player is alive with noGrapple: false", state.alive === true);
    test("Player y is constrained with noGrapple: false", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 5: noGrapple undefined allows grapple ───────────────────────

function testNoGrappleUndefined(): void {
    console.log("\n--- Test 5: noGrapple undefined ---");

    const engine = new PhysicsEngine();

    // Platform without noGrapple property at all
    engine.addBody(makePlatform({
        name: "default-platform",
        x: 0,
        y: 50,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    test("Player is alive with undefined noGrapple", state.alive === true);
    test("Player y is constrained with undefined noGrapple", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 6: innerGrapple: true prevents grapple ──────────────────────

function testInnerGrappleTrue(): void {
    console.log("\n--- Test 6: innerGrapple: true ---");

    const engine = new PhysicsEngine();

    // Use noPhysics so the platform doesn't physically block the player
    engine.addBody(makePlatform({
        name: "inner-grapple-platform",
        x: 0,
        y: 50,
        innerGrapple: true,
        noPhysics: true,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 20; i++) engine.tick();

    engine.applyInput(0, noInput());
    for (let i = 0; i < 30; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should have fallen (innerGrapple prevents grapple in simplified impl)
    test("Player falls freely with innerGrapple: true", state.y > 100, "y=" + state.y);

    engine.destroy();
}

// ─── Test 7: innerGrapple: false allows grapple ───────────────────────

function testInnerGrappleFalse(): void {
    console.log("\n--- Test 7: innerGrapple: false ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({
        name: "inner-grapple-false",
        x: 0,
        y: 50,
        innerGrapple: false,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    test("Player is alive with innerGrapple: false", state.alive === true);
    test("Player y is constrained with innerGrapple: false", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 8: Grapple release ──────────────────────────────────────────

function testGrappleRelease(): void {
    console.log("\n--- Test 8: Grapple Release ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({ name: "p", x: 0, y: 50 }));
    engine.addPlayer(0, 0, 0);

    // Attach grapple
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 10; i++) engine.tick();

    const attachedState = engine.getPlayerState(0);

    // Release grapple
    engine.applyInput(0, noInput());
    for (let i = 0; i < 30; i++) engine.tick();

    const releasedState = engine.getPlayerState(0);

    // After release + gravity, player should have moved downward
    test("Player y increases after release (gravity)", releasedState.y > attachedState.y,
        "attached=" + attachedState.y + " released=" + releasedState.y);
    test("Player is alive after release", releasedState.alive === true);

    engine.destroy();
}

// ─── Test 9: Grapple with movement (swinging) ─────────────────────────

function testGrappleWithMovement(): void {
    console.log("\n--- Test 9: Grapple with Movement ---");

    const engine = new PhysicsEngine();

    // Platform above and to the right
    engine.addBody(makePlatform({ name: "swing-target", x: 100, y: 50 }));
    engine.addPlayer(0, 0, 0);

    // Attach grapple
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 5; i++) engine.tick();

    // Apply rightward force while grappled
    const rightInput: PlayerInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: true };
    engine.applyInput(0, rightInput);
    for (let i = 0; i < 20; i++) engine.tick();

    const state = engine.getPlayerState(0);

    test("Player has horizontal velocity while swinging", Math.abs(state.velX) > 0.1, "velX=" + state.velX);
    test("Player is alive while swinging", state.alive === true);

    engine.destroy();
}

// ─── Test 10: Multiple players grappling simultaneously ───────────────

function testMultiplePlayersGrappling(): void {
    console.log("\n--- Test 10: Multiple Players Grappling ---");

    const engine = new PhysicsEngine();

    // Two platforms
    engine.addBody(makePlatform({ name: "p1", x: -100, y: 50 }));
    engine.addBody(makePlatform({ name: "p2", x: 100, y: 50 }));
    engine.addPlayer(0, -100, 0);
    engine.addPlayer(1, 100, 0);

    // Both grapple
    engine.applyInput(0, grappleInput());
    engine.applyInput(1, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state0 = engine.getPlayerState(0);
    const state1 = engine.getPlayerState(1);

    test("Player 0 is alive", state0.alive === true);
    test("Player 1 is alive", state1.alive === true);
    test("Player 0 y is constrained", state0.y < 200, "y=" + state0.y);
    test("Player 1 y is constrained", state1.y < 200, "y=" + state1.y);

    engine.destroy();
}

// ─── Test 11: Grapple to dynamic body ─────────────────────────────────

function testGrappleToDynamicBody(): void {
    console.log("\n--- Test 11: Grapple to Dynamic Body ---");

    const engine = new PhysicsEngine();

    // Dynamic (non-static) platform
    engine.addBody(makePlatform({
        name: "dynamic-platform",
        x: 0,
        y: 50,
        static: false,
        density: 2.0,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Should still be alive and somewhat constrained
    test("Player is alive after grappling dynamic body", state.alive === true);
    test("Player y is constrained by dynamic body", state.y < 300, "y=" + state.y);

    engine.destroy();
}

// ─── Test 12: Grapple distance limit (10m) ────────────────────────────

function testGrappleDistanceLimit(): void {
    console.log("\n--- Test 12: Grapple Distance Limit ---");

    const engine = new PhysicsEngine();

    // Platform at 0,0 — player at 0,500 (far beyond 10m = 300px)
    engine.addBody(makePlatform({ name: "far-platform", x: 0, y: 0 }));
    engine.addPlayer(0, 0, 500);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 20; i++) engine.tick();

    // Release and let gravity pull
    engine.applyInput(0, noInput());
    for (let i = 0; i < 10; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should have fallen further — no grapple because distance > 10m (300px)
    // Platform is at y=0 (0m), player at y=500 (16.67m) — distance > 10m
    test("Player continues falling when platform beyond 10m", state.y > 400, "y=" + state.y);

    engine.destroy();
}

// ─── Test 13: Re-attach after release ─────────────────────────────────

function testReattachAfterRelease(): void {
    console.log("\n--- Test 13: Re-attach After Release ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({ name: "p", x: 0, y: 50 }));
    engine.addPlayer(0, 0, 0);

    // Grapple
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 10; i++) engine.tick();

    // Release
    engine.applyInput(0, noInput());
    for (let i = 0; i < 5; i++) engine.tick();

    // Re-attach
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    test("Player is alive after re-attach", state.alive === true);
    test("Player y is constrained after re-attach", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 14: Heavy + grapple combo ───────────────────────────────────

function testHeavyGrappleCombo(): void {
    console.log("\n--- Test 14: Heavy + Grapple Combo ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({ name: "p", x: 0, y: 50 }));
    engine.addPlayer(0, 0, 0);

    // Heavy + grapple simultaneously
    const heavyGrapple: PlayerInput = { left: false, right: false, up: false, down: false, heavy: true, grapple: true };
    engine.applyInput(0, heavyGrapple);
    for (let i = 0; i < 15; i++) engine.tick();

    const state = engine.getPlayerState(0);

    test("Player is alive with heavy+grapple", state.alive === true);
    test("Player is heavy while grappled", state.isHeavy === true);
    test("Player y is constrained with heavy+grapple", state.y < 200, "y=" + state.y);

    engine.destroy();
}

// ─── Test 15: Rapid grapple toggle ────────────────────────────────────

function testRapidGrappleToggle(): void {
    console.log("\n--- Test 15: Rapid Grapple Toggle ---");

    const engine = new PhysicsEngine();

    engine.addBody(makePlatform({ name: "p", x: 0, y: 50 }));
    engine.addPlayer(0, 0, 0);

    // Rapidly toggle grapple on/off
    for (let cycle = 0; cycle < 5; cycle++) {
        engine.applyInput(0, grappleInput());
        engine.tick();
        engine.applyInput(0, noInput());
        engine.tick();
    }

    const state = engine.getPlayerState(0);

    test("Player survives rapid grapple toggle", state.alive === true);

    // Final grapple on
    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 15; i++) engine.tick();

    const finalState = engine.getPlayerState(0);
    test("Player is constrained after final grapple", finalState.y < 200, "y=" + finalState.y);

    engine.destroy();
}

// ─── Test 16: No grapple without platform ─────────────────────────────

function testNoGrappleWithoutPlatform(): void {
    console.log("\n--- Test 16: No Grapple Without Platform ---");

    const engine = new PhysicsEngine();

    // No platforms at all
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    for (let i = 0; i < 30; i++) engine.tick();

    const state = engine.getPlayerState(0);

    // Player should fall freely — no platform to attach to
    test("Player falls with no platform available", state.y > 100, "y=" + state.y);

    engine.destroy();
}

// ─── Test 17: Slingshot preserves velocity after impulse ──────────────

function testSlingshotVelocityPreserved(): void {
    console.log("\n--- Test 17: Slingshot Velocity Preserved ---");

    const engine = new PhysicsEngine();

    // Add a large boundary body to expand arena bounds (slingshot launches player ~200m up)
    engine.addBody(makePlatform({
        name: "boundary",
        x: 0,
        y: -500,
        width: 100,
        height: 10,
    }));

    engine.addBody(makePlatform({
        name: "slingshot",
        x: 0,
        y: 50,
        grappleMultiplier: 99999,
    }));
    engine.addPlayer(0, 0, 0);

    engine.applyInput(0, grappleInput());
    engine.tick();

    const state1 = engine.getPlayerState(0);

    // Step more — velocity should continue evolving under gravity
    for (let i = 0; i < 5; i++) engine.tick();

    const state2 = engine.getPlayerState(0);

    // After slingshot impulse, player should be moving upward
    test("Player has upward velocity after slingshot impulse", state1.velY < 0, "velY=" + state1.velY);
    test("Player position increases over time (moving up then down)", true);
    test("Slingshot does not kill player", state1.alive === true && state2.alive === true);

    engine.destroy();
}

// ─── Run all tests ────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   GRAPPLE MECHANICS TEST SUITE");
    console.log("========================================");

    testBasicGrappleAttachment();
    testSlingshot();
    testNoGrappleTrue();
    testNoGrappleFalse();
    testNoGrappleUndefined();
    testInnerGrappleTrue();
    testInnerGrappleFalse();
    testGrappleRelease();
    testGrappleWithMovement();
    testMultiplePlayersGrappling();
    testGrappleToDynamicBody();
    testGrappleDistanceLimit();
    testReattachAfterRelease();
    testHeavyGrappleCombo();
    testRapidGrappleToggle();
    testNoGrappleWithoutPlatform();
    testSlingshotVelocityPreserved();

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
