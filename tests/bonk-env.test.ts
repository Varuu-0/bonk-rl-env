/**
 * bonk-env.test.ts — Test suite for BonkEnvironment
 * 
 * Tests:
 * 1. Basic initialization
 * 2. Reset returns observation
 * 3. Step advances simulation
 * 4. Done conditions
 * 5. Truncation after max ticks
 * 6. Action decoding
 * 7. Reward calculation
 * 
 * Run with: npx tsx tests/bonk-env.test.ts
 */

import { BonkEnvironment } from "../src/core/environment";

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
 * Test 1: Basic initialization
 */
function testBasicInit(): void {
    console.log("\n--- Test 1: Basic Initialization ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    
    test("Creates environment", env !== null);
    
    env.close();
}

/**
 * Test 2: Reset returns observation
 */
function testReset(): void {
    console.log("\n--- Test 2: Reset ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    
    const obs = env.reset();
    
    test("Reset returns observation", obs !== null);
    test("Observation has playerX", 'playerX' in obs);
    test("Observation has playerY", 'playerY' in obs);
    test("Observation has opponents", 'opponents' in obs);
    test("Observation has arenaHalfWidth", 'arenaHalfWidth' in obs);
    test("Observation has tick", 'tick' in obs);
    test("Tick starts at 0", obs.tick === 0);
    
    env.close();
}

/**
 * Test 3: Step advances simulation
 */
function testStep(): void {
    console.log("\n--- Test 3: Step ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    env.reset();
    
    const result = env.step({ 
        left: false, 
        right: false, 
        up: false, 
        down: false, 
        heavy: false, 
        grapple: false 
    });
    
    test("Step returns result", result !== null);
    test("Result has observation", 'observation' in result);
    test("Result has reward", 'reward' in result);
    test("Result has done", 'done' in result);
    test("Result has truncated", 'truncated' in result);
    test("Result has info", 'info' in result);
    test("Tick increases", result.observation.tick === 1);
    
    env.close();
}

/**
 * Test 4: Done conditions work correctly
 */
function testDoneConditions(): void {
    console.log("\n--- Test 4: Done Conditions ---");
    
    // Create env with very low max ticks to force truncation
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 5
    });
    
    env.reset();
    
    let done = false;
    let steps = 0;
    
    while (!done && steps < 20) {
        const result = env.step({ 
            left: false, right: false, up: false, down: false, 
            heavy: false, grapple: false 
        });
        done = result.done;
        steps++;
    }
    
    test("Episode completes within maxTicks", done === true);
    
    env.close();
}

/**
 * Test 5: Truncation after max ticks
 */
function testTruncation(): void {
    console.log("\n--- Test 5: Truncation ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 10 // Very short max ticks
    });
    
    env.reset();
    
    let done = false;
    let truncated = false;
    let steps = 0;
    
    while (!done && steps < 20) {
        const result = env.step({ 
            left: false, right: false, up: false, down: false, 
            heavy: false, grapple: false 
        });
        done = result.done;
        truncated = result.truncated;
        steps++;
    }
    
    test("Eventually truncates due to maxTicks", truncated === true);
    
    env.close();
}

/**
 * Test 6: Action decoding - object form
 */
function testActionDecodingObject(): void {
    console.log("\n--- Test 6: Action Decoding (Object) ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    env.reset();
    
    const result = env.step({
        left: true,
        right: false,
        up: false,
        down: false,
        heavy: false,
        grapple: false
    });
    
    test("Accepts PlayerInput object", result !== null);
    
    env.close();
}

/**
 * Test 7: Action decoding - number form
 */
function testActionDecodingNumber(): void {
    console.log("\n--- Test 7: Action Decoding (Number) ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    env.reset();
    
    // Action = 1 means left=true (bit 0)
    const result = env.step(1);
    
    test("Accepts number action", result !== null);
    
    env.close();
}

/**
 * Test 8: Reward structure
 */
function testReward(): void {
    console.log("\n--- Test 8: Reward Structure ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100
    });
    
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Reward is a number", typeof result.reward === 'number');
    test("Reward is finite", Number.isFinite(result.reward));
    
    env.close();
}

/**
 * Test 9: Info includes tick
 */
function testInfoTick(): void {
    console.log("\n--- Test 9: Info includes tick ---");
    
    const env = new BonkEnvironment({ numOpponents: 1 });
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Info has tick", 'tick' in result.info);
    test("Info tick is number", typeof result.info.tick === 'number');
    
    env.close();
}

/**
 * Test 10: Multiple steps produce cumulative rewards
 */
function testCumulativeRewards(): void {
    console.log("\n--- Test 10: Cumulative Rewards ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100
    });
    
    env.reset();
    
    let totalReward = 0;
    for (let i = 0; i < 10; i++) {
        const result = env.step({ 
            left: false, right: false, up: false, down: false, 
            heavy: false, grapple: false 
        });
        totalReward += result.reward;
    }
    
    // Rewards should accumulate (time penalty is -0.001 per step)
    test("Cumulative reward is negative due to time penalty", totalReward < 0);
    
    env.close();
}

/**
 * Run all tests
 */
function runTests(): void {
    console.log("========================================");
    console.log("   BONK ENVIRONMENT TEST SUITE");
    console.log("========================================");
    
    testBasicInit();
    testReset();
    testStep();
    testDoneConditions();
    testTruncation();
    testActionDecodingObject();
    testActionDecodingNumber();
    testReward();
    testInfoTick();
    testCumulativeRewards();
    
    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");
    
    if (testsFailed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests();
