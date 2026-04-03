import * as fs from 'fs';
import * as path from 'path';
import { PhysicsEngine, MapBodyDef } from '../../src/core/physics-engine';

export interface MapDef {
  name: string;
  spawnPoints: Record<string, { x: number; y: number }>;
  bodies: MapBodyDef[];
  capZones?: Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scoreBlue?: boolean;
    scoreRed?: boolean;
  }>;
  joints?: Array<{ bodyA: string; bodyB: string }>;
  physics?: {
    ppm?: number;
    bounds?: { halfWidth: number; halfHeight: number };
  };
}

export function loadMap(filename: string): MapDef {
  const filePath = path.join(process.cwd(), 'maps', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function addAllBodies(engine: PhysicsEngine, map: MapDef): void {
  for (const body of map.bodies) {
    engine.addBody(body);
  }
}

export function getSpawnXY(
  map: MapDef,
  key?: string,
): { x: number; y: number } {
  const keys = Object.keys(map.spawnPoints);
  const spawnKey = key || keys[0];
  return map.spawnPoints[spawnKey] || { x: 0, y: 0 };
}

export function getMapFiles(): string[] {
  const mapsDir = path.join(process.cwd(), 'maps');
  try {
    return fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}
