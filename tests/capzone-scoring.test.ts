/**
 * capzone-scoring.test.ts — Blackbox tests for capZone scoring and team system
 *
 * Tests:
 * 1-3:   Team assignment (setPlayerTeam / getPlayerTeam)
 * 4-5:   CapZone sensor creation (addCapZone)
 * 6-11:  Scoring detection (getTeamScored, destroyAllBodies, reset)
 * 12-13: Environment integration (BonkEnvironment with capZones)
 *
 * Run with: npx tsx tests/capzone-scoring.test.ts
 */

import {
    PhysicsEngine,
    MapDef,
    MapBodyDef,
    SCALE,
} from "../src/core/physics-engine";
import { BonkEnvironment } from "../src/core/environment";

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

// ─── Team Assignment ──────────────────────────────────────────────────

function testSetPlayerTeamBlue(): void {
    console.log("\n--- Test 1: setPlayerTeam assigns blue to player 0 ---");

    const engine = new PhysicsEngine();
    engine.setPlayerTeam(0, 'blue');

    test("getPlayerTeam(0) === 'blue'", engine.getPlayerTeam(0) === 'blue');

    engine.destroy();
}

function testSetPlayerTeamRed(): void {
    console.log("\n--- Test 2: setPlayerTeam assigns red to player 1 ---");

    const engine = new PhysicsEngine();
    engine.setPlayerTeam(1, 'red');

    test("getPlayerTeam(1) === 'red'", engine.getPlayerTeam(1) === 'red');

    engine.destroy();
}

function testGetPlayerTeamUnassigned(): void {
    console.log("\n--- Test 3: getPlayerTeam returns undefined for unassigned player ---");

    const engine = new PhysicsEngine();

    test("getPlayerTeam(99) === undefined", engine.getPlayerTeam(99) === undefined);

    engine.destroy();
}

// ─── CapZone Sensor ───────────────────────────────────────────────────

function testAddCapZoneSingle(): void {
    console.log("\n--- Test 4: addCapZone creates a sensor body without crashing ---");

    const engine = new PhysicsEngine();
    let threw = false;
    try {
        engine.addCapZone(
            { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
            0, 100, 200, 50,
        );
    } catch {
        threw = true;
    }

    test("addCapZone does not throw", !threw);

    engine.destroy();
}

function testAddCapZoneMultiple(): void {
    console.log("\n--- Test 5: addCapZone multiple zones ---");

    const engine = new PhysicsEngine();
    let threw = false;
    try {
        engine.addCapZone(
            { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
            0, -100, 200, 50,
        );
        engine.addCapZone(
            { index: 1, owner: 'neutral', type: 3, fixture: 'Red', shapeType: 'bx' },
            0, 300, 200, 50,
        );
    } catch {
        threw = true;
    }

    test("addCapZone multiple does not throw", !threw);

    engine.destroy();
}

// ─── Scoring Detection ────────────────────────────────────────────────

/**
 * Helper: create a dynamic ball body with isBall flag in userData.
 * This is the body type that triggers capZone scoring.
 */
function addBall(engine: PhysicsEngine, x: number, y: number, vx: number, vy: number): void {
    const def: any = {
        name: "ball",
        type: "circle",
        x, y,
        radius: 5,
        static: false,
        density: 1,
        linearVelocity: { x: vx, y: vy },
        restitution: 0,
        friction: 0,
        isBall: true,
    };
    engine.addBody(def);
}

function testBallEntersType2Zone(): void {
    console.log("\n--- Test 6: ball entering type 2 zone triggers blue score ---");

    const engine = new PhysicsEngine();

    // Floor far below — does not overlap with sensor
    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 500, width: 800, height: 30,
        static: true,
    });

    // Blue goal sensor at y=190, tall enough for ball to enter
    engine.addCapZone(
        { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
        0, 190, 200, 100,
    );

    // Ball starting above the zone, falling down
    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 100; i++) engine.tick();

    const result = engine.getTeamScored();
    test("getTeamScored() === 'blue'", result === 'blue', `got: ${result}`);

    engine.destroy();
}

function testBallEntersType3Zone(): void {
    console.log("\n--- Test 7: ball entering type 3 zone triggers red score ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 500, width: 800, height: 30,
        static: true,
    });

    // Red goal sensor (type 3)
    engine.addCapZone(
        { index: 0, owner: 'neutral', type: 3, fixture: 'Red', shapeType: 'bx' },
        0, 190, 200, 100,
    );

    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 100; i++) engine.tick();

    const result = engine.getTeamScored();
    test("getTeamScored() === 'red'", result === 'red', `got: ${result}`);

    engine.destroy();
}

function testGetTeamScoredNoScoring(): void {
    console.log("\n--- Test 8: getTeamScored returns null when no scoring ---");

    const engine = new PhysicsEngine();

    // No capZones — just a ball falling
    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 200, width: 800, height: 30,
        static: true,
    });
    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 30; i++) engine.tick();

    test("getTeamScored() === null", engine.getTeamScored() === null);

    engine.destroy();
}

function testGetTeamScoredResetsAfterReading(): void {
    console.log("\n--- Test 9: getTeamScored resets after reading ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 500, width: 800, height: 30,
        static: true,
    });

    engine.addCapZone(
        { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
        0, 190, 200, 100,
    );

    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 100; i++) engine.tick();

    const first = engine.getTeamScored();
    const second = engine.getTeamScored();

    test("first read returns 'blue'", first === 'blue', `got: ${first}`);
    test("second read returns null", second === null, `got: ${second}`);

    engine.destroy();
}

function testDestroyAllBodiesClearsScoring(): void {
    console.log("\n--- Test 10: destroyAllBodies clears scoring state ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 500, width: 800, height: 30,
        static: true,
    });

    engine.addCapZone(
        { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
        0, 190, 200, 100,
    );

    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 100; i++) engine.tick();

    engine.destroyAllBodies();

    test("getTeamScored() === null after destroyAllBodies", engine.getTeamScored() === null);

    engine.destroy();
}

function testResetClearsScoring(): void {
    console.log("\n--- Test 11: reset() clears scoring state ---");

    const engine = new PhysicsEngine();

    engine.addBody({
        name: "floor", type: "rect",
        x: 0, y: 500, width: 800, height: 30,
        static: true,
    });

    engine.addCapZone(
        { index: 0, owner: 'neutral', type: 2, fixture: 'Blue', shapeType: 'bx' },
        0, 190, 200, 100,
    );

    addBall(engine, 0, 50, 0, 0);

    for (let i = 0; i < 100; i++) engine.tick();

    engine.reset();

    test("getTeamScored() === null after reset", engine.getTeamScored() === null);

    engine.destroy();
}

// ─── Environment Integration ──────────────────────────────────────────

function testBonkEnvWithCapZones(): void {
    console.log("\n--- Test 12: BonkEnvironment with capZones map includes capZones in step info ---");

    const mapData: MapDef = {
        name: "capzone-test",
        spawnPoints: {
            team_blue: { x: -200, y: -100 },
            team_red: { x: 200, y: -100 },
        },
        bodies: [
            { name: "floor", type: "rect", x: 0, y: 200, width: 800, height: 30, static: true },
        ],
        capZones: [
            { index: 0, owner: 'neutral', type: 2, fixture: 'floor', shapeType: 'bx' },
        ],
    };

    const env = new BonkEnvironment({ mapData, numOpponents: 0 });
    const result = env.step(0);

    test("result.info.capZones is defined", result.info.capZones !== undefined);
    test("result.info.capZones.length === 1", result.info.capZones.length === 1);
    test("result.info.capZones[0].type === 2", result.info.capZones[0].type === 2);

    env.close();
}

function testBonkEnvWithoutCapZones(): void {
    console.log("\n--- Test 13: BonkEnvironment without capZones still works ---");

    const mapData: MapDef = {
        name: "no-capzone-test",
        spawnPoints: {
            team_blue: { x: -200, y: -100 },
            team_red: { x: 200, y: -100 },
        },
        bodies: [
            { name: "floor", type: "rect", x: 0, y: 200, width: 800, height: 30, static: true },
        ],
    };

    const env = new BonkEnvironment({ mapData, numOpponents: 0 });

    let threw = false;
    try {
        for (let i = 0; i < 10; i++) env.step(0);
    } catch {
        threw = true;
    }

    test("stepping without capZones does not crash", !threw);
    test("info.capZones is []", JSON.stringify(env.step(0).info.capZones) === '[]');

    env.close();
}

// ─── Runner ───────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("  CAPZONE SCORING TEST SUITE");
    console.log("========================================");

    // Team assignment
    testSetPlayerTeamBlue();
    testSetPlayerTeamRed();
    testGetPlayerTeamUnassigned();

    // CapZone sensor
    testAddCapZoneSingle();
    testAddCapZoneMultiple();

    // Scoring detection
    testBallEntersType2Zone();
    testBallEntersType3Zone();
    testGetTeamScoredNoScoring();
    testGetTeamScoredResetsAfterReading();
    testDestroyAllBodiesClearsScoring();
    testResetClearsScoring();

    // Environment integration
    testBonkEnvWithCapZones();
    testBonkEnvWithoutCapZones();

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
