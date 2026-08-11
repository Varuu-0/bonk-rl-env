/**
 * map-adapter.test.ts — Vitest unit tests for normalizeMap().
 */

import { describe, it, expect } from 'vitest';
import { normalizeMap } from '../../src/core/map-adapter';

describe('normalizeMap', () => {
    describe('internal MapDef pass-through', () => {
        it('preserves spawnPoints/capZones/joints when the bodies array is omitted (#273)', () => {
            const spawnOnly = {
                name: 'SpawnOnly',
                spawnPoints: {
                    team_blue: { x: 111, y: 222 },
                    team_red: { x: 333, y: 444 },
                },
                capZones: [
                    { index: 0, owner: '', type: 1, fixture: 'plat_0', shapeType: 'rect' },
                ],
                joints: [
                    { type: 'rv', name: 'j0', bodyA: 'plat_0', bodyB: 'plat_1' },
                ],
            };
            const out = normalizeMap(spawnOnly as any);
            expect(out.spawnPoints).toEqual(spawnOnly.spawnPoints);
            expect(out.capZones).toEqual(spawnOnly.capZones);
            expect(out.joints).toEqual(spawnOnly.joints);
            // Omitted `bodies` defaults to [] so downstream loops are safe.
            expect(out.bodies).toEqual([]);
        });

        it('passes through a MapDef with an explicit empty bodies array unchanged', () => {
            const md = {
                name: 'SpawnOnly',
                spawnPoints: { team_blue: { x: 1, y: 2 }, team_red: { x: 3, y: 4 } },
                bodies: [],
            };
            const out = normalizeMap(md as any);
            expect(out.spawnPoints).toEqual(md.spawnPoints);
            expect(out.bodies).toEqual([]);
        });

        it('passes through a MapDef with bodies unchanged', () => {
            const md = {
                name: 'M',
                spawnPoints: { team_blue: { x: 1, y: 2 } },
                bodies: [
                    {
                        name: 'b0', type: 'rect', x: 0, y: 0, width: 10, height: 10, static: true,
                        collides: { g1: true, g2: true, g3: false, g4: false },
                    },
                ],
            };
            const out = normalizeMap(md as any);
            expect(out.bodies).toEqual(md.bodies);
            expect(out.spawnPoints).toEqual(md.spawnPoints);
        });
    });

    describe('exported bonk format detection', () => {
        it('still normalizes the real exported format (spawns[] + flat bodies)', () => {
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;
            expect(out.bodies.length).toBe(1);
            expect(out.spawnPoints.team_blue).toEqual({ x: 0, y: 0 });
        });

        it('still detects flat bodies via collidesGroup1 markers', () => {
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true, collidesGroup1: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;
            expect(out.bodies.length).toBe(1);
            expect((out.bodies[0] as any).collides.g1).toBe(true);
        });
    });
});
