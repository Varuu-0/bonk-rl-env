/**
 * shared-memory.ts — Test suite for SharedMemoryManager
 * 
 * Tests:
 * 1. SharedArrayBuffer support check
 * 2. Action ring buffer read/write
 * 3. Worker synchronization (hasNewActions / signalWorkerConsumed)
 * 4. Results signaling (reward + done)
 * 5. Ring buffer slot advancement
 * 
 * Run with: npx tsx tests/shared-memory.ts
 */

import { SharedMemoryManager } from '../src/ipc/shared-memory';

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
 * Array equality helper
 */
function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Test 1: SharedArrayBuffer support
 */
function testSupport(): boolean {
    console.log("\n--- Group 1: Support Check ---");

    const supported = SharedMemoryManager.isSupported();
    test("SharedArrayBuffer is supported", supported);
    return supported;
}

/**
 * Test 2: Action ring buffer read/write
 */
function testActionRingBuffer(shm: SharedMemoryManager): void {
    console.log("\n--- Group 2: Action Ring Buffer ---");

    const actions = new Uint8Array([1, 2, 4, 8]);
    shm.writeActions(actions);

    const slot = shm.readActionSlot();
    const readActions = shm.readActions(slot);
    console.log("Read actions from slot " + slot + ": " + readActions);
    test("Action ring buffer read/write", arraysEqual(Array.from(readActions), [1, 2, 4, 8]), "Expected [1,2,4,8], got [" + Array.from(readActions) + "]");
}

/**
 * Test 3: Worker synchronization
 */
function testWorkerSync(shm: SharedMemoryManager): void {
    console.log("\n--- Group 3: Worker Synchronization ---");

    test("Worker detects new actions", shm.hasNewActions() === true);
    shm.signalWorkerConsumed();
    test("Worker consumed actions clears flag", shm.hasNewActions() === false);
}

/**
 * Test 4: Results signaling
 */
function testResultsSignaling(shm: SharedMemoryManager): void {
    console.log("\n--- Group 4: Results Signaling ---");

    shm.writeReward(0, 1.5);
    shm.writeDone(0, 1);
    shm.signalMainReady();

    const results = shm.readResults();
    console.log("Read reward: " + results.rewards[0] + ", done: " + results.dones[0]);
    test("Reward value matches", results.rewards[0] === 1.5);
    test("Done flag matches", results.dones[0] === 1);
}

/**
 * Test 5: Ring buffer slot advancement
 */
function testSlotAdvancement(shm: SharedMemoryManager): void {
    console.log("\n--- Group 5: Ring Buffer Advancement ---");

    const prevSlot = shm.readActionSlot();
    const ringSize = 16;

    const actions2 = new Uint8Array([16, 32, 1, 2]);
    shm.writeActions(actions2);
    const slot2 = shm.readActionSlot();
    console.log("Advanced to slot: " + slot2);
    test("Slot advances correctly", slot2 === (prevSlot + 1) % ringSize, "Expected " + ((prevSlot + 1) % ringSize) + ", got " + slot2);
}

/**
 * Run all tests
 */
function runTests(): void {
    console.log("========================================");
    console.log("   SHARED MEMORY IPC TEST SUITE");
    console.log("========================================");

    const supported = testSupport();
    if (!supported) {
        console.log("\n========================================");
        console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
        console.log("========================================");

        if (testsFailed > 0) {
            process.exit(1);
        }
        return;
    }

    const numEnvs = 4;
    const ringSize = 16;
    const shm = new SharedMemoryManager(numEnvs, ringSize);

    testActionRingBuffer(shm);
    testWorkerSync(shm);
    testResultsSignaling(shm);
    testSlotAdvancement(shm);

    shm.dispose();

    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests();
