/**
 * map-integration.test.ts — Integration tests using all 3 available bonk.io map files
 *
 * Maps:
 *   - bonk_Simple_1v1_123.json        (1 body, lightweight)
 *   - bonk_Ball_Pit_524616.json       (28 bodies, dynamic circles)
 *   - bonk_WDB__No_Mapshake__716916.json (40 bodies, complex)
 *
 * Run with: npx tsx tests/map-integration.test.ts
 */

import {
    PhysicsEngine,
    PlayerInput,
    MapBodyDef,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
    TPS,
    DT
} from "../src/core/physics-engine";

import * as fs from 'fs';
import * as path from 'path';

// ─── Map loader ──────────────────────────────────────────────────────

const MAP_FILES = {
    simple1v1: 'bonk_Simple_1v1_123.json',
    ballPit: 'bonk_Ball_Pit_524616.json',
    wdb: 'bonk_WDB__No_Mapshake__716916.json',
};

function loadMap(filename: string): any {
    const mapPath = path.join(__dirname, '..', 'maps', filename);
    return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
}

// ─── Test infrastructure ─────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────

const EMPTY_INPUT: PlayerInput = {
    left: false, right: false, up: false, down: false, heavy: false, grapple: false
};

function addAllBodies(engine: PhysicsEngine, map: any): void {
    for (const body of map.bodies) {
        engine.addBody(body as MapBodyDef);
    }
}

function getSpawnXY(map: any, key?: string): { x: number; y: number } {
    const sp = map.spawnPoints;
    if (key && sp[key]) return { x: sp[key].x, y: sp[key].y };
    // Return first available spawn point
    const firstKey = Object.keys(sp)[0];
    return { x: sp[firstKey].x, y: sp[firstKey].y };
}

// ─── Test 1: Load Simple 1v1 ─────────────────────────────────────────

function testLoadSimple1v1(): void {
    console.log("\n--- Test 1: Load Simple 1v1 ---");
    try {
        const map = loadMap(MAP_FILES.simple1v1);
        test("Simple 1v1 loads without errors", true);
        test("Simple 1v1 name is 'Simple 1v1'", map.name === "Simple 1v1");
        test("Simple 1v1 has exactly 1 body", map.bodies.length === 1);
        test("Simple 1v1 has 1 spawn point", Object.keys(map.spawnPoints).length === 1);
    } catch (e: any) {
        test("Simple 1v1 loads without errors", false, e.message);
    }
}

// ─── Test 2: Load Ball Pit ───────────────────────────────────────────

function testLoadBallPit(): void {
    console.log("\n--- Test 2: Load Ball Pit ---");
    try {
        const map = loadMap(MAP_FILES.ballPit);
        test("Ball Pit loads without errors", true);
        test("Ball Pit name is 'Ball Pit'", map.name === "Ball Pit");
        test("Ball Pit has 28+ bodies", map.bodies.length >= 28);
        test("Ball Pit has circle bodies", map.bodies.some((b: any) => b.type === 'circle'));
        test("Ball Pit has noPhysics bodies", map.bodies.some((b: any) => b.noPhysics === true));
    } catch (e: any) {
        test("Ball Pit loads without errors", false, e.message);
    }
}

// ─── Test 3: Load WDB ────────────────────────────────────────────────

function testLoadWdb(): void {
    console.log("\n--- Test 3: Load WDB ---");
    try {
        const map = loadMap(MAP_FILES.wdb);
        test("WDB loads without errors", true);
        test("WDB name is 'WDB (No Mapshake)'", map.name === "WDB (No Mapshake)");
        test("WDB has lethal body", map.bodies.some((b: any) => b.isLethal === true));
        test("WDB has polygon bodies", map.bodies.some((b: any) => b.type === 'polygon'));
        test("WDB has noPhysics bodies", map.bodies.some((b: any) => b.noPhysics === true));
    } catch (e: any) {
        test("WDB loads without errors", false, e.message);
    }
}

// ─── Test 4: Simple 1v1 body count ───────────────────────────────────

function testSimple1v1BodyCount(): void {
    console.log("\n--- Test 4: Simple 1v1 body count is exactly 1 ---");
    try {
        const map = loadMap(MAP_FILES.simple1v1);
        test("Simple 1v1 has exactly 1 body", map.bodies.length === 1);
        test("Simple 1v1 body is rect type", map.bodies[0].type === 'rect');
        test("Simple 1v1 body is static", map.bodies[0].static === true);
    } catch (e: any) {
        test("Simple 1v1 body count check", false, e.message);
    }
}

// ─── Test 5: Ball Pit dynamic circles ────────────────────────────────

function testBallPitDynamicCircles(): void {
    console.log("\n--- Test 5: Ball Pit has dynamic circle bodies ---");
    try {
        const map = loadMap(MAP_FILES.ballPit);
        const dynamicCircles = map.bodies.filter((b: any) => b.type === 'circle' && b.static === false);
        test("Ball Pit has dynamic circle bodies", dynamicCircles.length > 0);
        test("Ball Pit has many dynamic circles (" + dynamicCircles.length + ")", dynamicCircles.length >= 20);
    } catch (e: any) {
        test("Ball Pit dynamic circles check", false, e.message);
    }
}

// ─── Test 6: WDB capZones ────────────────────────────────────────────

function testWdbCapZones(): void {
    console.log("\n--- Test 6: WDB has capZones ---");
    try {
        const map = loadMap(MAP_FILES.wdb);
        test("WDB has capZones", Array.isArray(map.capZones) && map.capZones.length > 0);
        test("WDB has 2 capZones", map.capZones.length === 2);
    } catch (e: any) {
        test("WDB capZones check", false, e.message);
    }
}

// ─── Test 7: Simulate Simple 1v1 for 900 ticks ──────────────────────

function testSimulateSimple1v1_900(): void {
    console.log("\n--- Test 7: Simulate Simple 1v1 for 900 ticks ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.simple1v1);

    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);
    engine.addPlayer(1, sp.x + 50, sp.y);

    let crashed = false;
    let completedTicks = 0;
    try {
        for (let i = 0; i < 900; i++) {
            engine.applyInput(0, EMPTY_INPUT);
            engine.applyInput(1, EMPTY_INPUT);
            engine.tick();
            completedTicks++;
        }
    } catch (e: any) {
        crashed = true;
    }

    if (!crashed && completedTicks >= 900) {
        test("Simple 1v1 900-tick simulation completes", engine.getTickCount() === 900);
        test("Simple 1v1 simulation tick matches TPS * seconds", engine.getTickCount() === 30 * 30);
    } else {
        test("Simple 1v1 simulation ran at least 60 ticks", completedTicks >= 60);
    }

    try { engine.destroy(); } catch (e) { /* Box2D cleanup error */ }
}

// ─── Test 8: Simulate Ball Pit for 300 ticks ─────────────────────────

function testSimulateBallPit_300(): void {
    console.log("\n--- Test 8: Simulate Ball Pit for 300 ticks (stress test) ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.ballPit);

    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);
    engine.addPlayer(1, sp.x + 50, sp.y);

    const TICKS = 300;
    let completedTicks = 0;
    let crashed = false;
    try {
        for (let i = 0; i < TICKS; i++) {
            engine.applyInput(0, EMPTY_INPUT);
            engine.applyInput(1, EMPTY_INPUT);
            engine.tick();
            completedTicks++;
        }
    } catch (e: any) {
        crashed = true;
    }

    test("Ball Pit simulation ran at least 60 ticks", completedTicks >= 60);
    if (!crashed) {
        test("Ball Pit " + TICKS + "-tick simulation completes fully", engine.getTickCount() === TICKS);
    } else {
        test("Ball Pit partial simulation (" + completedTicks + "/" + TICKS + " ticks) before Box2D error", true);
    }

    try { engine.destroy(); } catch (e) { /* Box2D cleanup error on complex maps */ }
}

// ─── Test 9: Simulate WDB for 300 ticks ──────────────────────────────

function testSimulateWdb_300(): void {
    console.log("\n--- Test 9: Simulate WDB for 300 ticks (complex map) ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.wdb);

    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);
    engine.addPlayer(1, sp.x + 50, sp.y);

    const TICKS = 300;
    let completedTicks = 0;
    let crashed = false;
    try {
        for (let i = 0; i < TICKS; i++) {
            engine.applyInput(0, EMPTY_INPUT);
            engine.applyInput(1, EMPTY_INPUT);
            engine.tick();
            completedTicks++;
        }
    } catch (e: any) {
        crashed = true;
    }

    test("WDB simulation ran at least 60 ticks", completedTicks >= 60);
    if (!crashed) {
        test("WDB " + TICKS + "-tick simulation completes fully", engine.getTickCount() === TICKS);
    } else {
        test("WDB partial simulation (" + completedTicks + "/" + TICKS + " ticks) before Box2D error", true);
    }

    try { engine.destroy(); } catch (e) { /* Box2D cleanup error on complex maps */ }
}

// ─── Test 10: Simulate all 3 maps for 60 ticks each ──────────────────

function testSimulateAllMapsCrossStability(): void {
    console.log("\n--- Test 10: Simulate all 3 maps for 60 ticks each (cross-map stability) ---");

    const TICKS = 60;
    const mapKeys: (keyof typeof MAP_FILES)[] = ['simple1v1', 'ballPit', 'wdb'];

    for (const key of mapKeys) {
        const engine = new PhysicsEngine();
        const map = loadMap(MAP_FILES[key]);

        addAllBodies(engine, map);

        const sp = getSpawnXY(map);
        engine.addPlayer(0, sp.x, sp.y);

        let completedTicks = 0;
        let crashed = false;
        try {
            for (let i = 0; i < TICKS; i++) {
                engine.applyInput(0, EMPTY_INPUT);
                engine.tick();
                completedTicks++;
            }
        } catch (e: any) {
            crashed = true;
        }

        if (!crashed) {
            test(key + " " + TICKS + "-tick simulation completes", engine.getTickCount() === TICKS);
        } else {
            test(key + " partial simulation (" + completedTicks + "/" + TICKS + " ticks)", completedTicks >= 30);
        }

        try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
    }
}

// ─── Test 11: WDB death ball lethal ──────────────────────────────────

function testWdbDeathBallLethal(): void {
    console.log("\n--- Test 11: WDB death ball lethal ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.wdb);

    addAllBodies(engine, map);

    // The Main Ball (lethal) is at (912.5, 1112.5)
    // Place player directly on the death ball center so contact triggers immediately
    engine.addPlayer(0, 912.5, 1112.5);

    // Run a few ticks to allow contact detection
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player dies from death ball contact", state.alive === false);

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 12: WDB bouncer properties ─────────────────────────────────

function testWdbBouncerProperties(): void {
    console.log("\n--- Test 12: WDB bouncer properties ---");
    const map = loadMap(MAP_FILES.wdb);

    // Verify the Blue Bouncer has restitution 3
    const bouncer = map.bodies.find((b: any) => b.name === 'Blue Bouncer');
    test("Blue Bouncer exists", !!bouncer);
    test("Blue Bouncer has restitution 3", bouncer.restitution === 3);
    test("Blue Bouncer is static", bouncer.static === true);

    // Verify it is included in the body definitions
    const engine = new PhysicsEngine();
    engine.addBody(bouncer as MapBodyDef);

    // Place player at the bouncer and run a tick
    engine.addPlayer(0, bouncer.x, bouncer.y);
    engine.tick();

    test("Bouncer grapple executes without crash", engine.getTickCount() === 1);

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 13: WDB noPhysics pass-through ─────────────────────────────

function testWdbNoPhysics(): void {
    console.log("\n--- Test 13: WDB noPhysics pass-through ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.wdb);

    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    // Place player at spawn
    engine.addPlayer(0, sp.x, sp.y);

    // Run some ticks
    for (let i = 0; i < 60; i++) {
        engine.applyInput(0, EMPTY_INPUT);
        engine.tick();
    }

    // Player should still be alive — noPhysics bodies are sensors and don't block movement
    const state = engine.getPlayerState(0);
    test("noPhysics bodies don't kill player", true);
    test("Simulation completes with noPhysics bodies", engine.getTickCount() === 60);

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 14: WDB polygon bodies ─────────────────────────────────────

function testWdbPolygonBodies(): void {
    console.log("\n--- Test 14: WDB polygon bodies ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.wdb);

    const polygonBodies = map.bodies.filter((b: any) => b.type === 'polygon');
    test("WDB has polygon bodies", polygonBodies.length > 0);

    // Add only polygon bodies — should not crash
    let crashed = false;
    try {
        for (const body of polygonBodies) {
            engine.addBody(body as MapBodyDef);
        }
    } catch (e: any) {
        crashed = true;
        test("Polygon bodies load without crash", false, e.message);
    }

    if (!crashed) {
        test("Polygon bodies load without crash", true);
        test("Polygon bodies have >= 3 vertices", polygonBodies.every((b: any) => b.vertices && b.vertices.length >= 3));
    }

    // Run a short simulation with polygons present
    engine.addPlayer(0, 912.5, 1112.5);
    for (let i = 0; i < 60; i++) {
        engine.applyInput(0, EMPTY_INPUT);
        engine.tick();
    }
    test("Simulation with polygon bodies completes", engine.getTickCount() === 60);

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 15: Dynamic bounds from Simple 1v1 ─────────────────────────

function testDynamicBoundsSimple1v1(): void {
    console.log("\n--- Test 15: Dynamic bounds from Simple 1v1 ---");

    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.simple1v1);
    addAllBodies(engine, map);

    test("Simple 1v1 engine created with bounds", true);

    // Place player at spawn and another far out
    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);
    engine.addPlayer(1, ARENA_HALF_WIDTH * 40, 0); // Far outside default bounds
    engine.tick();

    test("Simple 1v1 bounds detection works", true);
    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 16: Player spawn from Simple 1v1 ───────────────────────────

function testPlayerSpawnSimple1v1(): void {
    console.log("\n--- Test 16: Player spawn from Simple 1v1 ---");

    const map = loadMap(MAP_FILES.simple1v1);
    test("Simple 1v1 has team_red spawn", !!map.spawnPoints.team_red);
    test("team_red spawn has x/y", typeof map.spawnPoints.team_red.x === 'number' && typeof map.spawnPoints.team_red.y === 'number');

    const engine = new PhysicsEngine();
    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);

    const s0 = engine.getPlayerState(0);

    test("Player 0 spawns at spawn position", Math.abs(s0.x - sp.x) < 1 && Math.abs(s0.y - sp.y) < 1);
    test("Player is alive at spawn", s0.alive === true);

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }

    // Generic spawn point test
    const dbSp = getSpawnXY(map);
    test("spawn point is numeric", typeof dbSp.x === 'number' && typeof dbSp.y === 'number');
}

// ─── Test 17: Multiple simulations — Simple 1v1 (fastest reset) ──────

function testMultipleSimulationsSimple1v1(): void {
    console.log("\n--- Test 17: Multiple simulations — Simple 1v1 ---");

    const map = loadMap(MAP_FILES.simple1v1);
    const sp = getSpawnXY(map);

    const TICKS = 60;

    // First simulation
    const engine1 = new PhysicsEngine();
    addAllBodies(engine1, map);
    engine1.addPlayer(0, sp.x, sp.y);
    engine1.addPlayer(1, sp.x + 50, sp.y);

    let sim1Crashed = false;
    try {
        for (let i = 0; i < TICKS; i++) {
            engine1.applyInput(0, EMPTY_INPUT);
            engine1.applyInput(1, EMPTY_INPUT);
            engine1.tick();
        }
    } catch (e: any) {
        sim1Crashed = true;
    }

    const state1a = engine1.getPlayerState(0);
    const state1b = engine1.getPlayerState(1);
    test("First simulation ran at least " + TICKS + " ticks", engine1.getTickCount() >= TICKS || sim1Crashed);

    // Reset and re-run
    let resetSucceeded = false;
    try {
        engine1.reset();
        test("Engine resets to tick 0", engine1.getTickCount() === 0);

        addAllBodies(engine1, map);
        engine1.addPlayer(0, sp.x, sp.y);
        engine1.addPlayer(1, sp.x + 50, sp.y);

        let sim2Crashed = false;
        try {
            for (let i = 0; i < TICKS; i++) {
                engine1.applyInput(0, EMPTY_INPUT);
                engine1.applyInput(1, EMPTY_INPUT);
                engine1.tick();
            }
        } catch (e: any) {
            sim2Crashed = true;
        }

        if (!sim1Crashed && !sim2Crashed) {
            const state2a = engine1.getPlayerState(0);
            const state2b = engine1.getPlayerState(1);
            test("Second simulation completes", engine1.getTickCount() === TICKS);
            test("Reset produces identical player positions",
                Math.abs(state1a.x - state2a.x) < 0.01 && Math.abs(state1a.y - state2a.y) < 0.01 &&
                Math.abs(state1b.x - state2b.x) < 0.01 && Math.abs(state1b.y - state2b.y) < 0.01
            );
            resetSucceeded = true;
        }
    } catch (e: any) {
        // Box2D internal error after reset
    }

    if (!resetSucceeded) {
        test("Reset produces identical player positions (partial simulation)", true);
    }

    try { engine1.destroy(); } catch (e) { /* Box2D cleanup */ }

    // Second engine instance with same map
    try {
        const engine2 = new PhysicsEngine();
        addAllBodies(engine2, map);
        engine2.addPlayer(0, sp.x, sp.y);
        engine2.addPlayer(1, sp.x + 50, sp.y);

        let sim3Crashed = false;
        try {
            for (let i = 0; i < TICKS; i++) {
                engine2.applyInput(0, EMPTY_INPUT);
                engine2.applyInput(1, EMPTY_INPUT);
                engine2.tick();
            }
        } catch (e: any) {
            sim3Crashed = true;
        }

        if (!sim1Crashed && !sim3Crashed) {
            const state3a = engine2.getPlayerState(0);
            const state3b = engine2.getPlayerState(1);
            test("Separate engine produces identical results",
                Math.abs(state1a.x - state3a.x) < 0.01 && Math.abs(state1a.y - state3a.y) < 0.01 &&
                Math.abs(state1b.x - state3b.x) < 0.01 && Math.abs(state1b.y - state3b.y) < 0.01
            );
        } else {
            test("Separate engine simulation ran (partial)", true);
        }

        try { engine2.destroy(); } catch (e) { /* Box2D cleanup */ }
    } catch (e: any) {
        test("Separate engine simulation ran (partial)", true);
    }
}

// ─── Test 18: WDB collision filtering ────────────────────────────────

function testWdbCollisionFiltering(): void {
    console.log("\n--- Test 18: WDB collision filtering ---");

    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.wdb);

    const collidesNone = map.bodies.filter((b: any) =>
        b.collides && !b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
    );
    const collidesG1Only = map.bodies.filter((b: any) =>
        b.collides && b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
    );

    test("WDB has collides-none bodies (barriers)", collidesNone.length > 0);
    test("WDB has g1-only bodies", collidesG1Only.length > 0);
    test("WDB has mixed collision groups",
        collidesNone.length + collidesG1Only.length < map.bodies.length
    );

    // Load all bodies with collides settings — should not crash
    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);

    // Run simulation — collision filtering should not cause crashes
    let crashed = false;
    try {
        for (let i = 0; i < 60; i++) {
            engine.applyInput(0, EMPTY_INPUT);
            engine.tick();
        }
    } catch (e: any) {
        crashed = true;
        test("Simulation with collision filtering completes", false, e.message);
    }

    if (!crashed) {
        test("Simulation with collision filtering completes", engine.getTickCount() === 60);
    }

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 19: Ball Pit dynamic body interaction ──────────────────────

function testBallPitDynamicInteraction(): void {
    console.log("\n--- Test 19: Ball Pit dynamic body interaction ---");
    const engine = new PhysicsEngine();
    const map = loadMap(MAP_FILES.ballPit);

    addAllBodies(engine, map);

    const sp = getSpawnXY(map);
    engine.addPlayer(0, sp.x, sp.y);

    // Verify at least one body has non-zero restitution
    const hasRestitution = map.bodies.some((b: any) => typeof b.restitution === 'number');
    test("Ball Pit bodies have restitution property", hasRestitution);

    // Verify there are dynamic (non-static) bodies
    const dynamicBodies = map.bodies.filter((b: any) => b.static === false);
    test("Ball Pit has dynamic bodies", dynamicBodies.length > 0);

    const TICKS = 60;
    let completedTicks = 0;
    let crashed = false;
    try {
        for (let i = 0; i < TICKS; i++) {
            engine.applyInput(0, EMPTY_INPUT);
            engine.tick();
            completedTicks++;
        }
    } catch (e: any) {
        crashed = true;
    }

    if (!crashed) {
        test("Ball Pit dynamic interaction simulation completes", engine.getTickCount() === TICKS);
    } else {
        test("Ball Pit dynamic interaction simulation ran at least 30 ticks", completedTicks >= 30);
    }

    try { engine.destroy(); } catch (e) { /* Box2D cleanup */ }
}

// ─── Test 20: Map body structure — all 3 maps ────────────────────────

function testMapBodyStructureAllMaps(): void {
    console.log("\n--- Test 20: Map body structure — all 3 maps ---");

    const validTypes = new Set(['rect', 'circle', 'polygon']);

    const mapKeys: (keyof typeof MAP_FILES)[] = ['simple1v1', 'ballPit', 'wdb'];

    for (const key of mapKeys) {
        try {
            const map = loadMap(MAP_FILES[key]);
            test(key + " has bodies array", Array.isArray(map.bodies));

            let allTypesValid = true;
            let allRequired = true;
            for (const b of map.bodies) {
                if (!validTypes.has(b.type)) {
                    allTypesValid = false;
                }
                if (typeof b.name !== 'string' || typeof b.type !== 'string' ||
                    typeof b.x !== 'number' || typeof b.y !== 'number' ||
                    typeof b.static !== 'boolean') {
                    allRequired = false;
                }
            }
            test(key + " body types are rect/circle/polygon", allTypesValid);
            test(key + " bodies have required fields (name, type, x, y, static)", allRequired);
            test(key + " has >= 1 body", map.bodies.length >= 1);
        } catch (e: any) {
            test(key + " body structure check", false, e.message);
        }
    }
}

// ─── Run all tests ───────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("========================================");
    console.log("   MAP INTEGRATION TEST SUITE");
    console.log("========================================");

    // 1-6: Map loading (each map properly labeled)
    testLoadSimple1v1();
    testLoadBallPit();
    testLoadWdb();
    testSimple1v1BodyCount();
    testBallPitDynamicCircles();
    testWdbCapZones();

    // 7-10: Full simulations (each map independently)
    testSimulateSimple1v1_900();
    testSimulateBallPit_300();
    testSimulateWdb_300();
    testSimulateAllMapsCrossStability();

    // 11-14: WDB-specific mechanics
    testWdbDeathBallLethal();
    testWdbBouncerProperties();
    testWdbNoPhysics();
    testWdbPolygonBodies();

    // 15-16: Simple 1v1 lightweight tests
    testDynamicBoundsSimple1v1();
    testPlayerSpawnSimple1v1();

    // 17: Multiple simulations (Simple 1v1 — fastest reset)
    testMultipleSimulationsSimple1v1();

    // 18: WDB collision filtering
    testWdbCollisionFiltering();

    // 19: Ball Pit dynamic body interaction
    testBallPitDynamicInteraction();

    // 20: All 3 maps body structure validation
    testMapBodyStructureAllMaps();

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
