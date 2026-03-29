import { PhysicsEngine } from '../src/core/physics-engine';
import * as fs from 'fs';
import * as path from 'path';

const mapPath = path.join(__dirname, '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

console.log('Map has', mapData.bodies.length, 'bodies');
console.log('Static bodies:', mapData.bodies.filter((b: any) => b.static).length);
console.log('Dynamic bodies:', mapData.bodies.filter((b: any) => !b.static).length);
console.log('Lethal bodies:', mapData.bodies.filter((b: any) => b.isLethal).length);
console.log('noPhysics bodies:', mapData.bodies.filter((b: any) => b.noPhysics).length);

const engine = new PhysicsEngine();

// Add all bodies
for (const body of mapData.bodies) {
    try {
        engine.addBody(body);
    } catch (e: any) {
        console.log('Failed to add body:', body.name, e.message);
    }
}

// Add players
engine.addPlayer(0, mapData.spawnPoints.team_red.x, mapData.spawnPoints.team_red.y);
engine.addPlayer(1, mapData.spawnPoints.team_red.x + 50, mapData.spawnPoints.team_red.y);

console.log('Running 10 ticks...');
for (let i = 0; i < 10; i++) {
    engine.applyInput(0, { left: false, right: true, up: false, down: false, heavy: false, grapple: false });
    engine.applyInput(1, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
    engine.tick();
}
console.log('Ticks done. Player 0:', engine.getPlayerState(0));

console.log('Calling reset()...');
try {
    engine.reset();
    console.log('Reset succeeded');
} catch (e: any) {
    console.log('Reset FAILED:', e.message);
    console.log('Stack:', e.stack);
}

console.log('Re-adding bodies after reset...');
let reAddCrashed = false;
try {
    for (const body of mapData.bodies) {
        engine.addBody(body);
    }
    engine.addPlayer(0, mapData.spawnPoints.team_red.x, mapData.spawnPoints.team_red.y);
    engine.addPlayer(1, mapData.spawnPoints.team_red.x + 50, mapData.spawnPoints.team_red.y);
} catch (e: any) {
    console.log('Re-add FAILED:', e.message);
    reAddCrashed = true;
}

if (!reAddCrashed) {
    console.log('Running 10 more ticks after reset...');
    try {
        for (let i = 0; i < 10; i++) {
            engine.applyInput(0, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
            engine.applyInput(1, { left: false, right: false, up: false, down: false, heavy: false, grapple: false });
            engine.tick();
        }
        console.log('Post-reset ticks succeeded');
    } catch (e: any) {
        console.log('Post-reset tick FAILED:', e.message);
    }
}

console.log('Calling destroy()...');
try {
    engine.destroy();
    console.log('Destroy succeeded');
} catch (e: any) {
    console.log('Destroy FAILED:', e.message);
}

console.log('Done!');
