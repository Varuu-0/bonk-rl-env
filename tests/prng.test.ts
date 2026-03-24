/**
 * prng.test.ts — Test suite for PRNG
 * 
 * Tests:
 * 1. Basic random generation
 * 2. Determinism with same seed
 * 3. Different seeds produce different sequences
 * 4. nextInt range validation
 * 5. nextInt correct range
 * 6. setSeed resets state
 * 
 * Run with: npx tsx tests/prng.test.ts
 */

import { PRNG } from "../src/core/prng";

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
 * Test 1: Basic random generation
 */
function testBasicRandom(): void {
    console.log("\n--- Test 1: Basic Random ---");
    
    const prng = new PRNG(12345);
    const values: number[] = [];
    
    for (let i = 0; i < 100; i++) {
        values.push(prng.next());
    }
    
    test("Generates numbers in [0,1)", values.every(v => v >= 0 && v < 1));
    test("Generates varied values", new Set(values).size > 1);
}

/**
 * Test 2: Determinism with same seed
 */
function testDeterminism(): void {
    console.log("\n--- Test 2: Determinism ---");
    
    const prng1 = new PRNG(42);
    const prng2 = new PRNG(42);
    
    const seq1: number[] = [];
    const seq2: number[] = [];
    
    for (let i = 0; i < 100; i++) {
        seq1.push(prng1.next());
        seq2.push(prng2.next());
    }
    
    const identical = seq1.every((v, i) => v === seq2[i]);
    test("Same seed produces identical sequences", identical);
}

/**
 * Test 3: Different seeds produce different sequences
 */
function testDifferentSeeds(): void {
    console.log("\n--- Test 3: Different Seeds ---");
    
    const prng1 = new PRNG(100);
    const prng2 = new PRNG(200);
    
    const seq1: number[] = [];
    const seq2: number[] = [];
    
    for (let i = 0; i < 100; i++) {
        seq1.push(prng1.next());
        seq2.push(prng2.next());
    }
    
    // At least some values should differ
    const different = seq1.some((v, i) => v !== seq2[i]);
    test("Different seeds produce different sequences", different);
}

/**
 * Test 4: nextInt range validation
 */
function testNextIntValidation(): void {
    console.log("\n--- Test 4: nextInt Validation ---");
    
    const prng = new PRNG(123);
    
    let threw = false;
    try {
        prng.nextInt(5, 2); // min > max - should throw
    } catch (e) {
        threw = true;
    }
    
    test("Throws when min > max", threw);
}

/**
 * Test 5: nextInt correct range
 */
function testNextIntRange(): void {
    console.log("\n--- Test 5: nextInt Range ---");
    
    const prng = new PRNG(12345);
    
    // Test many calls to ensure all are in range
    const results: number[] = [];
    for (let i = 0; i < 1000; i++) {
        results.push(prng.nextInt(5, 10));
    }
    
    const allInRange = results.every(v => v >= 5 && v <= 10);
    test("All values in range [5,10]", allInRange);
    
    // Check min and max are possible
    const hasMin = results.includes(5);
    const hasMax = results.includes(10);
    test("Can produce minimum value (5)", hasMin);
    test("Can produce maximum value (10)", hasMax);
}

/**
 * Test 6: setSeed resets state
 */
function testSetSeed(): void {
    console.log("\n--- Test 6: setSeed ---");
    
    const prng = new PRNG(100);
    
    const before = prng.next();
    prng.setSeed(100);
    const after = prng.next();
    
    test("setSeed(100) after next() produces same as next() after seed 100", before === after);
}

/**
 * Test 7: Edge cases
 */
function testEdgeCases(): void {
    console.log("\n--- Test 7: Edge Cases ---");
    
    const prng = new PRNG(123);
    
    // Test with negative numbers
    const neg = prng.nextInt(-10, -5);
    test("Handles negative range min", neg >= -10 && neg <= -5);
    
    // Test with single value range
    const single = prng.nextInt(5, 5);
    test("Single value range returns that value", single === 5);
}

/**
 * Run all tests
 */
function runTests(): void {
    console.log("========================================");
    console.log("   PRNG TEST SUITE");
    console.log("========================================");
    
    testBasicRandom();
    testDeterminism();
    testDifferentSeeds();
    testNextIntValidation();
    testNextIntRange();
    testSetSeed();
    testEdgeCases();
    
    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");
    
    if (testsFailed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests();
