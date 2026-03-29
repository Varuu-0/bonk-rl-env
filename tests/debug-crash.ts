import { BonkEnvironment } from '../src/core/environment';
import * as fs from 'fs';
import * as path from 'path';

const mapPath = path.join(__dirname, '..', 'maps', 'bonk_WDB__No_Mapshake__716916.json');
const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

console.log('Map bodies count:', mapData.bodies?.length);

console.log('Creating env with WDB map...');
const env = new BonkEnvironment({ mapData, numOpponents: 1 });
console.log('Reset 1...');
env.reset();
console.log('Stepping...');
for (let i = 0; i < 10; i++) {
    env.step(Math.floor(Math.random() * 64));
}
console.log('Reset 2 (this is where crash likely happens)...');
env.reset();
console.log('Done!');
env.close();
