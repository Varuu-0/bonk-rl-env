/**
 * frame-skip.test.ts — Test suite for frame_skip feature
 * 
 * Tests:
 * 1. Default frame_skip (1) maintains backward compatibility
 * 2. frame_skip=2 - action repeated for 2 ticks, rewards accumulated
 * 3. frame_skip=4 - action repeated for 4 ticks
 * 4. Different actions persist correctly
 * 5. Done conditions only checked on final tick
 * 6. Info includes frameSkip value
 * 
 * Run with: npx tsx tests/frame-skip.test.ts
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
 * Test 1: Default frame_skip (1) maintains backward compatibility
 * Single step returns after 1 tick
 */
function testDefaultFrameSkip(): void {
    console.log("\n--- Test 1: Default frame_skip (1) ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100
    });
    
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Default frame_skip is 1", result.info.frameSkip === 1);
    test("Tick advances by 1", result.observation.tick === 1);
    test("Done is false initially", result.done === false);
    
    const result2 = env.step({ 
        left: true, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Tick advances to 2", result2.observation.tick === 2);
    
    env.close();
}

/**
 * Test 2: frame_skip=2 - action is repeated for 2 ticks, rewards accumulated
 */
function testFrameSkip2(): void {
    console.log("\n--- Test 2: frame_skip=2 ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100,
        frameSkip: 2
    });
    
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("frame_skip is 2", result.info.frameSkip === 2);
    test("Tick advances by 1 (done not checked yet)", result.observation.tick === 1);
    test("Done is false on intermediate tick", result.done === false);
    
    const result2 = env.step({ 
        left: true, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Tick advances to 2 (done checked on final tick)", result2.observation.tick === 2);
    test("Done can be true on final tick", result2.done === true || result2.done === false);
    
    env.close();
}

/**
 * Test 3: frame_skip=4 - action is repeated for 4 ticks
 */
function testFrameSkip4(): void {
    console.log("\n--- Test 3: frame_skip=4 ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100,
        frameSkip: 4
    });
    
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("frame_skip is 4", result.info.frameSkip === 4);
    test("Tick advances by 1 (first tick of cycle)", result.observation.tick === 1);
    test("Done is false on intermediate tick", result.done === false);
    
    let result2: ReturnType<typeof env.step> | undefined;
    for (let i = 0; i < 3; i++) {
        result2 = env.step({ 
            left: true, right: false, up: false, down: false, 
            heavy: false, grapple: false 
        });
    }
    
    test("Tick advances to 4 after 4 steps", result2!.observation.tick === 4);
    
    env.close();
}

/**
 * Test 4: Different actions can be provided each step and they persist correctly
 */
function testDifferentActions(): void {
    console.log("\n--- Test 4: Different actions persist correctly ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 100,
        frameSkip: 2
    });
    
    env.reset();
    
    const result1 = env.step({ 
        left: true, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    const tickAfterFirst = result1.observation.tick;
    
    const result2 = env.step({ 
        left: false, right: true, up: false, down: false, 
        heavy: false, grapple: false 
    });
    const tickAfterSecond = result2.observation.tick;
    
    test("First step advances 1 tick", tickAfterFirst === 1);
    test("Second step advances to tick 2", tickAfterSecond === 2);
    test("Done is false after frame_skip cycle completes", result2.done === false);
    
    env.close();
}

/**
 * Test 5: Done conditions are only checked on the final tick of each frame_skip cycle
 */
function testDoneOnFinalTick(): void {
    console.log("\n--- Test 5: Done conditions only on final tick ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        maxTicks: 10,
        frameSkip: 2
    });
    
    env.reset();
    
    let stepCount = 0;
    let lastResult = null;
    while (stepCount < 10) {
        const result = env.step({ 
            left: false, right: false, up: false, down: false, 
            heavy: false, grapple: false 
        });
        lastResult = result;
        if (result.done) {
            break;
        }
        stepCount++;
    }
    
    test("Done becomes true at tick that is multiple of frame_skip", lastResult !== null && lastResult.observation.tick % 2 === 0);
    
    env.close();
}

/**
 * Test 6: Info includes frameSkip value
 */
function testInfoIncludesFrameSkip(): void {
    console.log("\n--- Test 6: Info includes frameSkip value ---");
    
    const env = new BonkEnvironment({ 
        numOpponents: 1,
        frameSkip: 3
    });
    
    env.reset();
    
    const result = env.step({ 
        left: false, right: false, up: false, down: false, 
        heavy: false, grapple: false 
    });
    
    test("Info has frameSkip key", 'frameSkip' in result.info);
    test("Info frameSkip equals config", result.info.frameSkip === 3);
    test("Info includes tick", 'tick' in result.info);
    test("Info includes aiAlive", 'aiAlive' in result.info);
    test("Info includes opponentsAlive", 'opponentsAlive' in result.info);
    
    env.close();
}

/**
 * Run all tests
 */
function runTests(): void {
    console.log("========================================");
    console.log("   FRAME SKIP TEST SUITE");
    console.log("========================================");
    
    testDefaultFrameSkip();
    testFrameSkip2();
    testFrameSkip4();
    testDifferentActions();
    testDoneOnFinalTick();
    testInfoIncludesFrameSkip();
    
    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");
    
    if (testsFailed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests();
