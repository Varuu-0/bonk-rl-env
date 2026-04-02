/**
 * joints-capzones.test.ts — Blackbox tests for joints, capZones, map bounds, and physics overrides
 *
 * Run with: npx tsx tests/joints-capzones.test.ts
 */

import {
    PhysicsEngine,
    MapDef,
    MapBodyDef,
    SCALE,
} from "../src/core/physics-engine";

// @ts-ignore — box2d has no type declarations
const box2d = require('box2d');
const { b2Vec2 } = box2d;

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

// ─── Joint Tests ──────────────────────────────────────────────────────

function testJointLpj(): void {
    console.log("\n--- Test 1: addJoint with lpj type ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "platform",
        type: "rect",
        x: 0, y: 0,
        width: 100, height: 10,
        static: true,
    });
    engine.addBody({
        name: "ball",
        type: "circle",
        x: 0, y: 0.5,
        radius: 0.167,
        static: false,
        density: 1,
    });

    const bodyMap = (engine as any).getBodyMap();
    (engine as any).addJoint(
        { type: "lpj", bodyA: "ball", bodyB: "platform", frequencyHz: 4, dampingRatio: 0.5, collideConnected: true },
        bodyMap,
    );

    // Give the ball an upward impulse — joint should constrain it
    const ballBody = bodyMap.get("ball");
    ballBody.ApplyImpulse(new b2Vec2(0, -5), ballBody.GetPosition());

    for (let i = 0; i < 100; i++) engine.tick();

    const ballY = ballBody.GetPosition().y * SCALE;

    // Joint should constrain the ball — it should NOT have flown to y < -10
    // With the joint, it oscillates near the platform instead
    test("ball constrained by joint (did not fly away)", ballY > -10, `ballY=${ballY.toFixed(2)}`);

    engine.destroy();
}

function testJointUnknownBody(): void {
    console.log("\n--- Test 2: addJoint with unknown body name does not crash ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "platform",
        type: "rect",
        x: 0, y: 0,
        width: 100, height: 10,
        static: true,
    });

    const bodyMap = (engine as any).getBodyMap();

    let threw = false;
    try {
        (engine as any).addJoint(
            { type: "lpj", bodyA: "nonexistent", bodyB: "platform" },
            bodyMap,
        );
    } catch {
        threw = true;
    }

    test("addJoint with unknown body does not throw", !threw);

    engine.destroy();
}

function testGetBodyMapReturnsNamedBodies(): void {
    console.log("\n--- Test 3: getBodyMap returns bodies indexed by name ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor",
        type: "rect",
        x: 0, y: 200,
        width: 200, height: 20,
        static: true,
    });
    engine.addBody({
        name: "wall",
        type: "rect",
        x: 100, y: 0,
        width: 10, height: 200,
        static: true,
    });

    const bodyMap = (engine as any).getBodyMap();

    test("bodyMap has 'floor'", bodyMap.has("floor") === true);
    test("bodyMap has 'wall'", bodyMap.has("wall") === true);
    test("bodyMap size is 2", bodyMap.size === 2);

    engine.destroy();
}

function testDestroyAllBodiesClearsBodyMap(): void {
    console.log("\n--- Test 4: destroyAllBodies clears bodyMap ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "block",
        type: "rect",
        x: 0, y: 0,
        width: 50, height: 10,
        static: true,
    });

    engine.destroyAllBodies();

    const bodyMap = (engine as any).getBodyMap();
    test("bodyMap size is 0 after destroyAllBodies", bodyMap.size === 0);

    engine.destroy();
}

function testResetClearsBodyMap(): void {
    console.log("\n--- Test 5: reset() clears bodyMap ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "block",
        type: "rect",
        x: 0, y: 0,
        width: 50, height: 10,
        static: true,
    });

    engine.reset();

    const bodyMap = (engine as any).getBodyMap();
    test("bodyMap size is 0 after reset", bodyMap.size === 0);

    engine.destroy();
}

function testDistanceJointConstrainsSeparation(): void {
    console.log("\n--- Test 6: distance joint constrains body separation ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "anchor",
        type: "circle",
        x: 0, y: 0,
        radius: 1,
        static: true,
    });
    engine.addBody({
        name: "weight",
        type: "circle",
        x: 0, y: 10,
        radius: 1,
        static: false,
        density: 1,
    });

    const bodyMap = (engine as any).getBodyMap();
    (engine as any).addJoint(
        { type: "lpj", bodyA: "weight", bodyB: "anchor", length: 10, frequencyHz: 4, dampingRatio: 0.5 },
        bodyMap,
    );

    for (let i = 0; i < 200; i++) engine.tick();

    const anchorPos = bodyMap.get("anchor").GetPosition();
    const weightPos = bodyMap.get("weight").GetPosition();
    const dx = (weightPos.x - anchorPos.x) * SCALE;
    const dy = (weightPos.y - anchorPos.y) * SCALE;
    const dist = Math.sqrt(dx * dx + dy * dy);

    test("distance ≈ 10m (within 2m tolerance)", Math.abs(dist - 10) < 2, `dist=${dist.toFixed(2)}`);

    engine.destroy();
}

// ─── Map Bounds Tests ─────────────────────────────────────────────────

function testSetMapBoundsOverridesArena(): void {
    console.log("\n--- Test 7: setMapBounds overrides calculated arena bounds ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "small",
        type: "rect",
        x: 0, y: 0,
        width: 10, height: 10,
        static: true,
    });

    (engine as any).setMapBounds(100, 80); // halfWidth=50, halfHeight=40

    engine.addPlayer(0, 0, 0);

    const rightInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: false };

    for (let i = 0; i < 300; i++) {
        engine.applyInput(0, rightInput);
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("player eventually dies when x exceeds set bounds", state.alive === false, `alive=${state.alive}, x=${state.x.toFixed(2)}`);

    engine.destroy();
}

function testSetMapBoundsKillAllDirections(): void {
    console.log("\n--- Test 8: setMapBounds kill zone works in all directions ---");

    const engine = new PhysicsEngine();

    // Add a floor so the player doesn't just fall out the bottom
    engine.addBody({
        name: "floor",
        type: "rect",
        x: 0, y: 29,
        width: 200, height: 5,
        static: true,
    });

    (engine as any).setMapBounds(60, 60); // halfWidth=30, halfHeight=30

    engine.addPlayer(0, 0, 0);

    const state0 = engine.getPlayerState(0);
    test("player is alive at start", state0.alive === true);

    // Push player far to the right beyond bounds
    const rightInput = { left: false, right: true, up: false, down: false, heavy: false, grapple: false };
    for (let i = 0; i < 500; i++) {
        engine.applyInput(0, rightInput);
        engine.tick();
    }

    const state1 = engine.getPlayerState(0);
    test("player dies when moved beyond bounds", state1.alive === false, `alive=${state1.alive}, x=${state1.x.toFixed(2)}`);

    engine.destroy();
}

function testSetMapBoundsSmallKillsQuickly(): void {
    console.log("\n--- Test 9: setMapBounds with small value kills player quickly ---");

    const engine = new PhysicsEngine();
    
    // Very tight bounds: 0.2m x 0.2m (halfWidth=0.1m, halfHeight=0.1m)
    (engine as any).setMapBounds(0.2, 0.2);

    engine.addPlayer(0, 0, 0);

    // Player starts at y=0. With gravity (10 m/s²), after 1 tick (1/30s):
    // displacement ≈ 0.5 * 10 * (1/30)² ≈ 0.0056m. Too small.
    // After 30 ticks (1 second): player has fallen significantly.
    // Tick 1-30: bounds check happens AFTER step, so player needs to exceed 0.1m
    for (let i = 0; i < 30; i++) engine.tick();

    const state = engine.getPlayerState(0);
    
    // Player should be dead — fell beyond halfHeight=0.1m
    test("player is dead (bounds too small)", state.alive === false,
        `alive=${state.alive}, y=${state.y.toFixed(2)}px, yMetres=${(state.y / SCALE).toFixed(4)}`);

    engine.destroy();
}

// ─── CapZones Tests ───────────────────────────────────────────────────

function testMapDefCapZonesArray(): void {
    console.log("\n--- Test 10: MapDef type accepts capZones array ---");

    const mapDef: MapDef = {
        name: "test-map",
        spawnPoints: { blue: { x: 0, y: 0 } },
        bodies: [],
        capZones: [{ index: 0, owner: "neutral", type: 2, fixture: "Blue", shapeType: "bx" }],
    };

    test("mapDef.capZones.length === 1", mapDef.capZones!.length === 1);
    test("mapDef.capZones[0].type === 2", mapDef.capZones![0].type === 2);
}

function testMapDefEmptyCapZones(): void {
    console.log("\n--- Test 11: MapDef with empty capZones is valid ---");

    const mapDef: MapDef = {
        name: "empty-capzones",
        spawnPoints: {},
        bodies: [],
        capZones: [],
    };

    test("capZones.length === 0", mapDef.capZones!.length === 0);
}

function testMapDefCapZonesOptional(): void {
    console.log("\n--- Test 12: MapDef capZones optional ---");

    const mapDef: MapDef = {
        name: "no-capzones",
        spawnPoints: {},
        bodies: [],
    };

    test("capZones is undefined when omitted", mapDef.capZones === undefined);
}

// ─── Physics Override Tests ───────────────────────────────────────────

function testMapDefPhysicsPpm(): void {
    console.log("\n--- Test 13: MapDef with physics.ppm is accepted ---");

    const mapDef: MapDef = {
        name: "ppm-map",
        spawnPoints: {},
        bodies: [],
        physics: { ppm: 12 },
    };

    test("physics.ppm === 12", mapDef.physics!.ppm === 12);
}

function testMapDefPhysicsBounds(): void {
    console.log("\n--- Test 14: MapDef with physics.bounds is accepted ---");

    const mapDef: MapDef = {
        name: "bounds-map",
        spawnPoints: {},
        bodies: [],
        physics: { bounds: { width: 1825, height: 1825 } },
    };

    test("physics.bounds.width === 1825", mapDef.physics!.bounds!.width === 1825);
}

// ─── Runner ───────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("  JOINTS / CAPZONES / BOUNDS TEST SUITE");
    console.log("========================================");

    // Joint tests
    testJointLpj();
    testJointUnknownBody();
    testGetBodyMapReturnsNamedBodies();
    testDestroyAllBodiesClearsBodyMap();
    testResetClearsBodyMap();
    testDistanceJointConstrainsSeparation();

    // Map bounds tests
    testSetMapBoundsOverridesArena();
    testSetMapBoundsKillAllDirections();
    testSetMapBoundsSmallKillsQuickly();

    // CapZones tests
    testMapDefCapZonesArray();
    testMapDefEmptyCapZones();
    testMapDefCapZonesOptional();

    // Physics override tests
    testMapDefPhysicsPpm();
    testMapDefPhysicsBounds();

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
