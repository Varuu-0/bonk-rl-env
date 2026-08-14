import * as fs from 'fs';
import * as path from 'path';
import { normalizeMap } from './src/core/map-adapter';

const root = process.cwd();
const mapPath = path.join(root, 'maps', 'bonk_WDB__no_nothing__1232248.json');
const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const out: any = normalizeMap(raw);
console.log('deathCenter=', JSON.stringify(out.physics?.deathCenter ?? null));
const polys = (out.bodies ?? []).filter((b: any) => b.type === 'polygon');
console.log('polygonCount=', polys.length);
for (const p of polys) {
    console.log('poly', p.name, 'x=', p.x, 'y=', p.y, 'angle=', p.angle, 'verts=', JSON.stringify(p.vertices?.slice(0, 3)));
}
const rects = (out.bodies ?? []).filter((b: any) => b.type === 'rect' && (b.angle ?? 0) !== 0);
console.log('rotatedRectCount=', rects.length);
const joints = out.joints ?? [];
console.log('jointCount=', joints.length);
console.log('spawns=', JSON.stringify(out.spawnPoints));