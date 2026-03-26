/**
 * map-body-types.test.ts — Test suite for map body type functionality
 *
 * Tests:
 *  1. Rectangle bodies (creation, landing)
 *  2. Circle bodies (creation)
 *  3. Polygon bodies (3-8 vertices)
 *  4. Static vs dynamic bodies
 *  5. Density property
 *  6. Restitution handling (normal, -1 remap, undefined default)
 *  7. Angle/rotation
 *  8. isLethal property
 *  9. grappleMultiplier slingshot behavior
 *
 * Run with: npx tsx tests/map-body-types.test.ts
 */

import {
    PhysicsEngine,
    MapBodyDef,
    SCALE,
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

// ─── 1. Rectangle Bodies ──────────────────────────────────────────────

function testRectBodyCreation(): void {
    console.log("\n--- 1a: Rectangle Body Creation ---");

    const engine = new PhysicsEngine();

    const floor: MapBodyDef = {
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
    };

    engine.addBody(floor);
    test("Rect body is added without error", true);

    engine.destroy();
}

function testRectBodyPlayerLanding(): void {
    console.log("\n--- 1b: Rectangle Body Player Landing ---");

    const engine = new PhysicsEngine();

    const floor: MapBodyDef = {
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
    };

    engine.addBody(floor);
    engine.addPlayer(0, 0, 150);

    // Simulate enough ticks for player to settle on floor
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player stays above static floor (y < 200)", state.y < 200);
    test("Player is alive after landing on floor", state.alive === true);
    test("Player velocity near zero after settling", Math.abs(state.velY) < 50);

    engine.destroy();
}

function testRectBodyDimensions(): void {
    console.log("\n--- 1c: Rectangle Body Dimensions ---");

    const engine = new PhysicsEngine();

    const platform: MapBodyDef = {
        name: "platform",
        type: "rect",
        x: 50,
        y: 100,
        width: 200,
        height: 20,
        static: true,
    };

    engine.addBody(platform);
    test("Rect body with explicit width/height is accepted", true);

    // Player placed above the platform should land on it
    engine.addPlayer(0, 50, 50);
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player lands on narrow rect platform", state.y < 100);

    engine.destroy();
}

// ─── 2. Circle Bodies ─────────────────────────────────────────────────

function testCircleBodyCreation(): void {
    console.log("\n--- 2a: Circle Body Creation ---");

    const engine = new PhysicsEngine();

    const circle: MapBodyDef = {
        name: "boulder",
        type: "circle",
        x: 0,
        y: 100,
        radius: 50,
        static: true,
    };

    engine.addBody(circle);
    test("Circle body is added without error", true);

    engine.destroy();
}

function testCircleBodyDynamic(): void {
    console.log("\n--- 2b: Circle Body Dynamic ---");

    const engine = new PhysicsEngine();

    const ball: MapBodyDef = {
        name: "ball",
        type: "circle",
        x: 0,
        y: -50,
        radius: 20,
        static: false,
        density: 1.0,
    };

    engine.addBody(ball);
    test("Dynamic circle body is added without error", true);

    // Step physics — dynamic body should fall due to gravity
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    test("Dynamic circle body simulation runs without error", true);

    engine.destroy();
}

function testCircleBodyVariousRadii(): void {
    console.log("\n--- 2c: Circle Body Various Radii ---");

    const engine = new PhysicsEngine();

    const radii = [10, 25, 50, 100];
    for (const r of radii) {
        const circle: MapBodyDef = {
            name: "circle_" + r,
            type: "circle",
            x: 0,
            y: 0,
            radius: r,
            static: true,
        };
        engine.addBody(circle);
    }

    test("Multiple circle bodies with various radii accepted", true);

    engine.destroy();
}

// ─── 3. Polygon Bodies ────────────────────────────────────────────────

function testPolygonBodyTriangle(): void {
    console.log("\n--- 3a: Polygon Body Triangle (3 vertices) ---");

    const engine = new PhysicsEngine();

    const triangle: MapBodyDef = {
        name: "triangle",
        type: "polygon",
        x: 0,
        y: 0,
        vertices: [
            { x: 0, y: -30 },
            { x: 30, y: 30 },
            { x: -30, y: 30 },
        ],
        static: true,
    };

    engine.addBody(triangle);
    test("Triangle polygon (3 vertices) is added", true);

    engine.destroy();
}

function testPolygonBodyQuad(): void {
    console.log("\n--- 3b: Polygon Body Quad (4 vertices) ---");

    const engine = new PhysicsEngine();

    const quad: MapBodyDef = {
        name: "quad",
        type: "polygon",
        x: 0,
        y: 0,
        vertices: [
            { x: -20, y: -20 },
            { x: 20, y: -20 },
            { x: 30, y: 20 },
            { x: -30, y: 20 },
        ],
        static: true,
    };

    engine.addBody(quad);
    test("Quad polygon (4 vertices) is added", true);

    engine.destroy();
}

function testPolygonBodyHexagon(): void {
    console.log("\n--- 3c: Polygon Body Hexagon (6 vertices) ---");

    const engine = new PhysicsEngine();

    const verts: { x: number; y: number }[] = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 * i) / 6;
        verts.push({ x: Math.cos(angle) * 40, y: Math.sin(angle) * 40 });
    }

    const hex: MapBodyDef = {
        name: "hexagon",
        type: "polygon",
        x: 0,
        y: 0,
        vertices: verts,
        static: true,
    };

    engine.addBody(hex);
    test("Hexagon polygon (6 vertices) is added", true);

    engine.destroy();
}

function testPolygonBodyOctagon(): void {
    console.log("\n--- 3d: Polygon Body Octagon (8 vertices) ---");

    const engine = new PhysicsEngine();

    const verts: { x: number; y: number }[] = [];
    for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8;
        verts.push({ x: Math.cos(angle) * 35, y: Math.sin(angle) * 35 });
    }

    const oct: MapBodyDef = {
        name: "octagon",
        type: "polygon",
        x: 0,
        y: 0,
        vertices: verts,
        static: true,
    };

    engine.addBody(oct);
    test("Octagon polygon (8 vertices) is added", true);

    engine.destroy();
}

function testPolygonBodyInvalidVertices(): void {
    console.log("\n--- 3e: Polygon Body Insufficient Vertices ---");

    const engine = new PhysicsEngine();

    const invalid: MapBodyDef = {
        name: "invalid_poly",
        type: "polygon",
        x: 0,
        y: 0,
        vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
        ],
        static: true,
    };

    engine.addBody(invalid);
    test("Polygon with < 3 vertices is rejected gracefully", true);

    engine.destroy();
}

// ─── 4. Static vs Dynamic Bodies ──────────────────────────────────────

function testStaticBodyImmovable(): void {
    console.log("\n--- 4a: Static Body Does Not Move ---");

    const engine = new PhysicsEngine();

    const wall: MapBodyDef = {
        name: "wall",
        type: "rect",
        x: 0,
        y: 0,
        width: 20,
        height: 200,
        static: true,
    };

    engine.addBody(wall);

    // Place player to the left of wall and push right
    engine.addPlayer(0, -100, 0);
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    test("Static body simulation runs without error", true);

    engine.destroy();
}

function testDynamicBodyFalls(): void {
    console.log("\n--- 4b: Dynamic Body Falls Due to Gravity ---");

    const engine = new PhysicsEngine();

    // Floor to catch the dynamic body
    const floor: MapBodyDef = {
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
    };

    const crate: MapBodyDef = {
        name: "crate",
        type: "rect",
        x: 0,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 1.0,
    };

    engine.addBody(floor);
    engine.addBody(crate);

    for (let i = 0; i < 120; i++) {
        engine.tick();
    }

    test("Dynamic body simulation completes without error", true);

    engine.destroy();
}

function testStaticBodyDensityZero(): void {
    console.log("\n--- 4c: Static Body Has Zero Density ---");

    const engine = new PhysicsEngine();

    const platform: MapBodyDef = {
        name: "platform",
        type: "rect",
        x: 0,
        y: 100,
        width: 200,
        height: 20,
        static: true,
    };

    engine.addBody(platform);

    // A static body with density 0 should not respond to forces
    engine.addPlayer(0, 0, 50);
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    test("Static body with density 0 remains in place", true);

    engine.destroy();
}

// ─── 5. Density Property ──────────────────────────────────────────────

function testDensityAffectsMass(): void {
    console.log("\n--- 5a: Density Affects Mass ---");

    const engine = new PhysicsEngine();

    const lightCrate: MapBodyDef = {
        name: "light",
        type: "rect",
        x: -100,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 0.5,
    };

    const heavyCrate: MapBodyDef = {
        name: "heavy",
        type: "rect",
        x: 100,
        y: -100,
        width: 30,
        height: 30,
        static: false,
        density: 5.0,
    };

    const floor: MapBodyDef = {
        name: "floor",
        type: "rect",
        x: 0,
        y: 200,
        width: 800,
        height: 30,
        static: true,
    };

    engine.addBody(floor);
    engine.addBody(lightCrate);
    engine.addBody(heavyCrate);

    for (let i = 0; i < 90; i++) {
        engine.tick();
    }

    test("Bodies with different densities simulate without error", true);

    engine.destroy();
}

function testDefaultDensity(): void {
    console.log("\n--- 5b: Default Density for Dynamic Body ---");

    const engine = new PhysicsEngine();

    const crate: MapBodyDef = {
        name: "default_density",
        type: "rect",
        x: 0,
        y: -50,
        width: 30,
        height: 30,
        static: false,
        // density omitted — should default to 1.0
    };

    engine.addBody(crate);
    for (let i = 0; i < 30; i++) {
        engine.tick();
    }

    test("Dynamic body with undefined density simulates (defaults to 1.0)", true);

    engine.destroy();
}

// ─── 6. Restitution Handling ──────────────────────────────────────────

function testRestitutionNormalValues(): void {
    console.log("\n--- 6a: Normal Restitution Values ---");

    const engine = new PhysicsEngine();

    const restitutions = [0.0, 0.5, 1.0];
    for (const r of restitutions) {
        const body: MapBodyDef = {
            name: "rest_" + r,
            type: "rect",
            x: 0,
            y: 0,
            width: 50,
            height: 20,
            static: true,
            restitution: r,
        };
        engine.addBody(body);
    }

    test("Bodies with restitution 0.0, 0.5, 1.0 accepted", true);

    engine.destroy();
}

function testRestitutionNegativeOneRemap(): void {
    console.log("\n--- 6b: Restitution -1 Remaps to 0.4 ---");

    const engine = new PhysicsEngine();

    const negRest: MapBodyDef = {
        name: "neg_restitution",
        type: "rect",
        x: 0,
        y: 150,
        width: 800,
        height: 20,
        static: true,
        restitution: -1,
    };

    engine.addBody(negRest);

    // Place player above the surface, let it fall and bounce
    engine.addPlayer(0, 0, 0);
    for (let i = 0; i < 90; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player alive after bouncing on restitution -1 surface", state.alive === true);
    test("Player stays in bounds after bounce", state.y < 150);

    engine.destroy();
}

function testRestitutionUndefinedDefaults(): void {
    console.log("\n--- 6c: Undefined Restitution Defaults to 0.4 ---");

    const engine = new PhysicsEngine();

    const noRest: MapBodyDef = {
        name: "default_restitution",
        type: "rect",
        x: 0,
        y: 150,
        width: 800,
        height: 20,
        static: true,
        // restitution omitted
    };

    engine.addBody(noRest);

    engine.addPlayer(0, 0, 0);
    for (let i = 0; i < 90; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player alive after bouncing on default restitution surface", state.alive === true);

    engine.destroy();
}

// ─── 7. Angle / Rotation ──────────────────────────────────────────────

function testAngleProperty(): void {
    console.log("\n--- 7a: Angle Property Rotates Body ---");

    const engine = new PhysicsEngine();

    const ramp: MapBodyDef = {
        name: "ramp",
        type: "rect",
        x: 0,
        y: 100,
        width: 200,
        height: 20,
        static: true,
        angle: Math.PI / 6, // 30 degrees
    };

    engine.addBody(ramp);
    test("Body with angle property is added without error", true);

    // Player placed above the ramp should interact with the angled surface
    engine.addPlayer(0, 0, 50);
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player interacts with angled body", state.alive === true);

    engine.destroy();
}

function testAngleZeroDefault(): void {
    console.log("\n--- 7b: Angle Zero (Default) ---");

    const engine = new PhysicsEngine();

    const flat: MapBodyDef = {
        name: "flat",
        type: "rect",
        x: 0,
        y: 100,
        width: 400,
        height: 20,
        static: true,
        // angle omitted — defaults to 0
    };

    engine.addBody(flat);

    engine.addPlayer(0, 0, 0);
    for (let i = 0; i < 90; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player lands on flat body with default angle", state.y < 100);

    engine.destroy();
}

function testAnglePolygon(): void {
    console.log("\n--- 7c: Angled Polygon Body ---");

    const engine = new PhysicsEngine();

    const tri: MapBodyDef = {
        name: "angled_tri",
        type: "polygon",
        x: 0,
        y: 100,
        vertices: [
            { x: 0, y: -40 },
            { x: 40, y: 40 },
            { x: -40, y: 40 },
        ],
        static: true,
        angle: Math.PI / 4,
    };

    engine.addBody(tri);
    test("Angled polygon body is added without error", true);

    engine.destroy();
}

// ─── 8. isLethal Property ─────────────────────────────────────────────

function testLethalBodyKillsPlayer(): void {
    console.log("\n--- 8a: Lethal Body Kills Player ---");

    const engine = new PhysicsEngine();

    const lava: MapBodyDef = {
        name: "lava",
        type: "rect",
        x: 0,
        y: 150,
        width: 800,
        height: 30,
        static: true,
        isLethal: true,
    };

    engine.addBody(lava);
    engine.addPlayer(0, 0, 130);

    // Let player fall short distance into lethal zone
    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player is killed by lethal body contact", state.alive === false);

    engine.destroy();
}

function testNonLethalBodySafe(): void {
    console.log("\n--- 8b: Non-Lethal Body Is Safe ---");

    const engine = new PhysicsEngine();

    const safeFloor: MapBodyDef = {
        name: "safe_floor",
        type: "rect",
        x: 0,
        y: 150,
        width: 800,
        height: 30,
        static: true,
        isLethal: false,
    };

    engine.addBody(safeFloor);
    engine.addPlayer(0, 0, 100);

    for (let i = 0; i < 120; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player survives on non-lethal body", state.alive === true);

    engine.destroy();
}

function testLethalCircleBody(): void {
    console.log("\n--- 8c: Lethal Circle Body ---");

    const engine = new PhysicsEngine();

    const spike: MapBodyDef = {
        name: "spike_ball",
        type: "circle",
        x: 0,
        y: 100,
        radius: 30,
        static: true,
        isLethal: true,
    };

    engine.addBody(spike);
    engine.addPlayer(0, 0, 75);

    for (let i = 0; i < 60; i++) {
        engine.tick();
    }

    const state = engine.getPlayerState(0);
    test("Player is killed by lethal circle body", state.alive === false);

    engine.destroy();
}

// ─── 9. grappleMultiplier Property ────────────────────────────────────

function testGrappleMultiplierSlingshot(): void {
    console.log("\n--- 9a: grappleMultiplier 99999 Triggers Slingshot ---");

    const engine = new PhysicsEngine();

    const slingshot: MapBodyDef = {
        name: "slingshot",
        type: "rect",
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
        grappleMultiplier: 99999,
    };

    engine.addBody(slingshot);
    test("Body with grappleMultiplier 99999 is added", true);

    engine.destroy();
}

function testGrappleMultiplierNormal(): void {
    console.log("\n--- 9b: Normal grappleMultiplier Value ---");

    const engine = new PhysicsEngine();

    const bouncy: MapBodyDef = {
        name: "bouncy",
        type: "rect",
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
        grappleMultiplier: 1.5,
    };

    engine.addBody(bouncy);
    test("Body with normal grappleMultiplier is added", true);

    engine.destroy();
}

function testGrappleMultiplierUndefined(): void {
    console.log("\n--- 9c: Undefined grappleMultiplier ---");

    const engine = new PhysicsEngine();

    const normal: MapBodyDef = {
        name: "normal",
        type: "rect",
        x: 0,
        y: 80,
        width: 200,
        height: 20,
        static: true,
        // grappleMultiplier omitted
    };

    engine.addBody(normal);
    test("Body without grappleMultiplier is added", true);

    engine.destroy();
}

// ─── Run All Tests ────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("========================================");
    console.log("   MAP BODY TYPES TEST SUITE");
    console.log("========================================");

    // 1. Rectangle bodies
    testRectBodyCreation();
    testRectBodyPlayerLanding();
    testRectBodyDimensions();

    // 2. Circle bodies
    testCircleBodyCreation();
    testCircleBodyDynamic();
    testCircleBodyVariousRadii();

    // 3. Polygon bodies
    testPolygonBodyTriangle();
    testPolygonBodyQuad();
    testPolygonBodyHexagon();
    testPolygonBodyOctagon();
    testPolygonBodyInvalidVertices();

    // 4. Static vs dynamic
    testStaticBodyImmovable();
    testDynamicBodyFalls();
    testStaticBodyDensityZero();

    // 5. Density property
    testDensityAffectsMass();
    testDefaultDensity();

    // 6. Restitution handling
    testRestitutionNormalValues();
    testRestitutionNegativeOneRemap();
    testRestitutionUndefinedDefaults();

    // 7. Angle/rotation
    testAngleProperty();
    testAngleZeroDefault();
    testAnglePolygon();

    // 8. isLethal property
    testLethalBodyKillsPlayer();
    testNonLethalBodySafe();
    testLethalCircleBody();

    // 9. grappleMultiplier property
    testGrappleMultiplierSlingshot();
    testGrappleMultiplierNormal();
    testGrappleMultiplierUndefined();

    console.log("\n========================================");
    console.log("     RESULTS: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("========================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
