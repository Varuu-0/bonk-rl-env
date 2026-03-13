/**
 * env-manager.test.ts — Test suite for spawnable environments
 *
 * Tests:
 * 1. Port manager allocation and release
 * 2. Multiple environments can start
 * 3. Ports are unique
 * 4. Environments reset independently
 * 5. Shutdown cleans all environments
 *
 * Run with: npx tsx tests/env-manager.test.ts
 */

import { PortManager } from "../src/utils/port-manager";
import { BonkEnv } from "../src/env/bonk-env";
import { EnvManager } from "../src/env/env-manager";

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
 * Test 1: Port Manager - Basic allocation
 */
async function testPortManagerAllocation(): Promise<void> {
    console.log("\n--- Test 1: Port Manager Allocation ---");
    
    const pm = new PortManager({ startPort: 6000, endPort: 6005 });
    
    const port1 = pm.allocate();
    test("Allocates port in range", port1 >= 6000 && port1 <= 6005);
    
    const port2 = pm.allocate();
    test("Allocates different port", port1 !== port2);
    
    const port3 = pm.allocate();
    test("Allocates third unique port", port3 !== port1 && port3 !== port2);
    
    test("Allocated count is 3", pm.getAllocatedCount() === 3);
    
    pm.release(port1);
    test("Released port decreases count", pm.getAllocatedCount() === 2);
    
    const portReallocated = pm.allocate();
    test("Can reallocate released port", !pm.isAllocated(port1) || portReallocated === port1);
    
    test("Reallocation restores count", pm.getAllocatedCount() === 3);
    
    pm.releaseAll();
    test("ReleaseAll clears all ports", pm.getAllocatedCount() === 0);
}

/**
 * Test 2: Port Manager - Range limits
 */
async function testPortManagerLimits(): Promise<void> {
    console.log("\n--- Test 2: Port Manager Range Limits ---");
    
    const pm = new PortManager({ startPort: 6000, endPort: 6002 });
    
    const p1 = pm.allocate();
    const p2 = pm.allocate();
    const p3 = pm.allocate();
    
    test("Allocates up to range limit (3 ports)", p3 !== undefined);
    
    let threw = false;
    try {
        pm.allocate();
    } catch (e) {
        threw = true;
    }
    test("Throws when no ports available", threw);
    
    pm.releaseAll();
}

/**
 * Test 3: Port Manager - Port availability check
 */
async function testPortAvailability(): Promise<void> {
    console.log("\n--- Test 3: Port Availability Check ---");
    
    const available = await PortManager.isPortAvailable(59999);
    test("Can check if port is available", typeof available === "boolean");
}
/**
 * Test 4: Multiple environments can start
 */
async function testMultipleEnvsStart(): Promise<void> {
    console.log("\n--- Test 4: Multiple Environments Start ---");
    
    const manager = new EnvManager({
        portManager: { startPort: 6100, endPort: 6200 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
    });
    
    try {
        const envs = await manager.createPool(2);
        test("Creates 2 environments", envs.length === 2);
        
        const allRunning = envs.every(e => e.isActive());
        test("All environments are running", allRunning);
        
        await manager.shutdownAll();
    } catch (error) {
        test("Creates 2 environments", false);
        await manager.shutdownAll();
    }
}

/**
 * Test 5: Ports are unique
 */
async function testUniquePorts(): Promise<void> {
    console.log("\n--- Test 5: Unique Ports ---");
    
    const manager = new EnvManager({
        portManager: { startPort: 6200, endPort: 6300 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
    });
    
    try {
        const envs = await manager.createPool(4);
        
        const ports = envs.map(e => e.port);
        const uniquePorts = new Set(ports);
        
        test("All ports are unique", uniquePorts.size === ports.length);
        
        const allInRange = ports.every(p => p >= 6200 && p <= 6300);
        test("All ports in expected range", allInRange);
        
        await manager.shutdownAll();
    } catch (error) {
        test("All ports are unique", false);
        await manager.shutdownAll();
    }
}

/**
 * Test 6: Environment reset
 */
async function testEnvReset(): Promise<void> {
    console.log("\n--- Test 6: Environment Reset ---");
    
    const manager = new EnvManager({
        portManager: { startPort: 6300, endPort: 6400 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
    });
    
    try {
        const envs = await manager.createPool(2);
        
        const seeds = [123, 456];
        const obs = await manager.resetAll(seeds);
        
        test("Reset returns observations", obs !== undefined && obs.length > 0);
        
        await manager.shutdownAll();
    } catch (error) {
        test("Reset returns observations", false);
        await manager.shutdownAll();
    }
}
/**
 * Test 7: Clean shutdown
 */
async function testCleanShutdown(): Promise<void> {
    console.log("\n--- Test 7: Clean Shutdown ---");
    
    const manager = new EnvManager({
        portManager: { startPort: 6400, endPort: 6500 },
        defaultEnvConfig: { numEnvs: 1, useSharedMemory: false }
    });
    
    try {
        const envs = await manager.createPool(3);
        test("Created 3 envs before shutdown", envs.length === 3);
        
        await manager.shutdownAll();
        
        test("Manager reports 0 environments after shutdown", manager.getEnvCount() === 0);
        
        let threw = false;
        try {
            await manager.createEnv();
        } catch (e) {
            threw = true;
        }
        test("Cannot create env after shutdown", threw);
    } catch (error) {
        test("Created 3 envs before shutdown", false);
        await manager.shutdownAll();
    }
}

/**
 * Test 8: Single BonkEnv creation
 */
async function testSingleEnvCreation(): Promise<void> {
    console.log("\n--- Test 8: Single BonkEnv Creation ---");
    
    const pm = new PortManager({ startPort: 6500, endPort: 6600 });
    const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager: pm
    });
    
    test("Environment has ID", env.id.startsWith("env-"));
    test("Environment has port assigned", env.port >= 6500 && env.port <= 6600);
    test("Environment is not active initially", !env.isActive());
    
    await env.start();
    test("Environment is active after start", env.isActive());
    
    await env.stop();
    test("Environment is not active after stop", !env.isActive());
    
    pm.releaseAll();
}

/**
 * Run all tests
 */
async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   ENV MANAGER TEST SUITE");
    console.log("========================================");
    
    await testPortManagerAllocation();
    await testPortManagerLimits();
    await testPortAvailability();
    await testMultipleEnvsStart();
    await testUniquePorts();
    await testEnvReset();
    await testCleanShutdown();
    await testSingleEnvCreation();
    
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
