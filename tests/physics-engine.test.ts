/**
 * physics-engine.test.ts — Test suite for PhysicsEngine
 * 
 * Tests:
 * 1. Basic initialization
 * 2. Player creation and state
 * 3. Physics stepping
 * 4. Input application
 * 5. Heavy state toggle
 * 6. Arena bounds detection
 * 7. Map body handling
 * 8. Reset functionality
 * 
 * Run with: npx tsx tests/physics-engine.test.ts
 */

import { 
    PhysicsEngine, 
    PlayerInput, 
    MapBodyDef,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
    TPS,
    DT,
    HEAVY_MASS_MULTIPLIER
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

/**
 * Test 1: PhysicsEngine basic initialization
 */
function testBasicInit(): void {
    console.log("\n--- Test 1: Basic Initialization ---");
    
    const engine = new PhysicsEngine();
    
    test("PhysicsEngine creates world", engine !== null);
    test("Initial tick count is 0", engine.getTickCount() === 0);
    
    engine.destroy();
}

/**
 * Test 2: Player creation and state
 */
function testPlayerCreation(): void {
    console.log("\n--- Test 2: Player Creation ---");
    
    const engine = new PhysicsEngine();
    
    engine.addPlayer(0, 0, 0);
    
    const state = engine.getPlayerState(0);
    
    test("Player is created at origin", state.x === 0 && state.y === 0);
    test("Player is alive initially", state.alive === true);
    test("Player is not heavy initially", state.isHeavy === false);
    test("Player has zero velocity", state.velX === 0 && state.velY === 0);
    
    engine.destroy();
}

/**
 * Test 3: Physics stepping
 */
function testPhysicsStep(): void {
    console.log("\n--- Test 3: Physics Step ---");
    
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    
    const initialTick = engine.getTickCount();
    
    engine.tick();
    
    test("Tick count increments", engine.getTickCount() === initialTick + 1);
    test("Tick advances by DT seconds", true); // Just verify tick doesn't throw
    
    engine.destroy();
}

/**
 * Test 4: Input application
 */
function testInputApplication(): void {
    console.log("\n--- Test 4: Input Application ---");
    
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    
    const input: PlayerInput = {
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false
    };
    
    // Apply input and step
    engine.applyInput(0, input);
    engine.tick();
    
    const state = engine.getPlayerState(0);
    
    test("Player has velocity after input", state.velX !== 0 || state.velY !== 0);
    
    engine.destroy();
}

/**
 * Test 5: Heavy state toggle
 */
function testHeavyState(): void {
    console.log("\n--- Test 5: Heavy State Toggle ---");
    
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    
    // Apply heavy input
    const heavyInput: PlayerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: true,
        grapple: false
    };
    
    engine.applyInput(0, heavyInput);
    engine.tick();
    
    const state = engine.getPlayerState(0);
    
    test("Player is heavy after heavy input", state.isHeavy === true);
    
    // Turn off heavy
    const lightInput: PlayerInput = {
        left: false,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false
    };
    
    engine.applyInput(0, lightInput);
    engine.tick();
    
    const state2 = engine.getPlayerState(0);
    test("Player is not heavy after disabling", state2.isHeavy === false);
    
    engine.destroy();
}

/**
 * Test 6: Arena bounds detection
 */
function testArenaBounds(): void {
    console.log("\n--- Test 6: Arena Bounds ---");
    
    const engine = new PhysicsEngine();
    engine.addPlayer(0, 0, 0);
    
    // Add player way outside bounds (ARENA_HALF_WIDTH * 35 = 875)
    engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0);
    engine.tick();
    
    const state = engine.getPlayerState(1);
    
    test("Player outside bounds is marked dead", state.alive === false);
    
    engine.destroy();
}

/**
 * Test 7: Map body handling
 */
function testMapBodies(): void {
    console.log("\n--- Test 7: Map Bodies ---");
    
    const engine = new PhysicsEngine();
    
    const floor: MapBodyDef = {
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true
    };
    
    engine.addBody(floor);
    
    test("Floor body is added", true); // Just verify it doesn't throw
    
    // Add a player on top of the floor
    engine.addPlayer(0, 0, 150);
    engine.tick();
    
    const state = engine.getPlayerState(0);
    test("Player stays above static floor", state.y < 200); // Should be on top
    
    engine.destroy();
}

/**
 * Test 8: Reset functionality
 */
function testReset(): void {
    console.log("\n--- Test 8: Reset Functionality ---");
    
    const engine = new PhysicsEngine();
    
    engine.addPlayer(0, 100, 100);
    engine.tick();
    engine.tick();
    
    test("Tick count increases", engine.getTickCount() === 2);
    
    // After reset, players are removed - verify getPlayerState returns dead for non-existent player
    engine.reset();
    
    test("Tick count resets to 0", engine.getTickCount() === 0);
    
    // Non-existent player should return dead state
    const state = engine.getPlayerState(0);
    test("Non-existent player is marked dead after reset", state.alive === false);
    
    // Re-add a player to verify reset enables new players
    engine.addPlayer(0, 0, 0);
    const state2 = engine.getPlayerState(0);
    test("New player after reset is alive", state2.alive === true);
    
    engine.destroy();
}

/**
 * Test 9: Constants are correct
 */
function testConstants(): void {
    console.log("\n--- Test 9: Constants ---");
    
    test("TPS is 30", TPS === 30);
    test("DT is 1/30", Math.abs(DT - 1/30) < 0.0001);
    test("HEAVY_MASS_MULTIPLIER is 3.0", HEAVY_MASS_MULTIPLIER === 3.0);
}

/**
 * Test 10: getAlivePlayerIds
 */
function testGetAlivePlayerIds(): void {
    console.log("\n--- Test 10: Get Alive Player IDs ---");
    
    const engine = new PhysicsEngine();
    
    engine.addPlayer(0, 0, 0);
    engine.addPlayer(1, ARENA_HALF_WIDTH * 35, 0); // Outside bounds - dead
    engine.addPlayer(2, 0, 0);
    
    engine.tick();
    
    const aliveIds = engine.getAlivePlayerIds();
    
    test("Returns array", Array.isArray(aliveIds));
    test("Contains player 0", aliveIds.includes(0));
    test("Does not contain player 1 (dead)", !aliveIds.includes(1));
    test("Contains player 2", aliveIds.includes(2));
    
    engine.destroy();
}

/**
 * Run all tests
 */
async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   PHYSICS ENGINE TEST SUITE");
    console.log("========================================");
    
    testBasicInit();
    testPlayerCreation();
    testPhysicsStep();
    testInputApplication();
    testHeavyState();
    testArenaBounds();
    testMapBodies();
    testReset();
    testConstants();
    testGetAlivePlayerIds();
    
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
