import { PhysicsEngine } from '../src/core/physics-engine';
import * as fs from 'fs';
import * as path from 'path';

const mapPath = path.join(__dirname, '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

// List all polygon bodies and vertex counts
const polyBodies = mapData.bodies.filter((b: any) => b.type === 'polygon');
console.log('=== Polygon Bodies ===');
for (const b of polyBodies) {
    console.log(`  "${b.name}": ${b.vertices.length} vertices, noPhysics=${b.noPhysics}, static=${b.static}`);
    for (const v of b.vertices) {
        console.log(`    (${v.x}, ${v.y})`);
    }
}

// Test all bodies, find exact crash tick
console.log('\n=== Full map, finding exact crash tick ===');
{
    const engine = new PhysicsEngine();
    try {
        for (const b of mapData.bodies) engine.addBody(b);
        engine.addPlayer(0, mapData.spawnPoints.team_red.x, mapData.spawnPoints.team_red.y);
        for (let t = 0; t < 10000; t++) {
            engine.tick();
            if ((t + 1) % 50 === 0) console.log(`  tick ${t + 1} OK`);
        }
        console.log('OK: 10000 ticks');
    } catch (e: any) {
        console.log(`CRASH at ~tick: ${e.message}`);
        console.log('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
    }
    try { engine.destroy(); } catch {}
}

// Confirm: player-only crash tick
console.log('\n=== Player-only, finding exact crash tick ===');
{
    const engine = new PhysicsEngine();
    try {
        engine.addPlayer(0, mapData.spawnPoints.team_red.x, mapData.spawnPoints.team_red.y);
        for (let t = 0; t < 10000; t++) {
            engine.tick();
            if ((t + 1) % 50 === 0) console.log(`  tick ${t + 1} OK`);
        }
        console.log('OK: 10000 ticks');
    } catch (e: any) {
        console.log(`CRASH at ~tick: ${e.message}`);
    }
    try { engine.destroy(); } catch {}
}

console.log('\nDone!');
