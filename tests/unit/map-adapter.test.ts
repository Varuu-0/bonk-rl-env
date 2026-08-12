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

        it('preserves authored data when bodies is explicitly null (#273)', () => {
            const spawnOnly = {
                name: 'SpawnOnly',
                spawnPoints: { team_blue: { x: 111, y: 222 }, team_red: { x: 333, y: 444 } },
                capZones: [
                    { index: 0, owner: '', type: 1, fixture: 'plat_0', shapeType: 'rect' },
                ],
                joints: [
                    { type: 'rv', name: 'j0', bodyA: 'plat_0', bodyB: 'plat_1' },
                ],
                bodies: null,
            };
            const out = normalizeMap(spawnOnly as any);
            expect(out.spawnPoints).toEqual(spawnOnly.spawnPoints);
            expect(out.capZones).toEqual(spawnOnly.capZones);
            expect(out.joints).toEqual(spawnOnly.joints);
            expect(out.bodies).toEqual([]);
        });

        it('preserves authored spawnPoints/capZones/joints for bodies: [null] (#273)', () => {
            // A corrupt/placeholder bodies array (valid JSON) is treated as
            // internal so authored data survives; the null entries are dropped
            // and the empty remainder reaches the environment safely.
            const out = normalizeMap({
                name: 'SpawnOnly',
                spawnPoints: { team_blue: { x: 111, y: 222 }, team_red: { x: 333, y: 444 } },
                capZones: [
                    { index: 0, owner: '', type: 1, fixture: 'plat_0', shapeType: 'rect' },
                ],
                joints: [
                    { type: 'rv', name: 'j0', bodyA: 'plat_0', bodyB: 'plat_1' },
                ],
                bodies: [null],
            } as any);
            expect(out.spawnPoints).toEqual({ team_blue: { x: 111, y: 222 }, team_red: { x: 333, y: 444 } });
            expect(out.capZones).toEqual([
                { index: 0, owner: '', type: 1, fixture: 'plat_0', shapeType: 'rect' },
            ]);
            expect(out.joints).toEqual([
                { type: 'rv', name: 'j0', bodyA: 'plat_0', bodyB: 'plat_1' },
            ]);
            expect(out.bodies).toEqual([]);
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

        it('exporter path filters null bodies before conversion (#273)', () => {
            // No `spawnPoints` marker, so this is the real exported format even
            // though `bodies` mixes a null placeholder with a flat body. The
            // null entry must be filtered before toBodyDef (which would throw),
            // and the remaining flat body converts normally.
            const out = normalizeMap({
                bodies: [
                    null,
                    { bodyIndex: 1, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true, collidesGroup1: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;
            expect(out.bodies.length).toBe(1);
            expect(out.bodies[0].name).toBe('wall');
            expect((out.bodies[0] as any).collides.g1).toBe(true);
            expect(out.spawnPoints.team_blue).toEqual({ x: 0, y: 0 });
        });

        it('keeps fixture aliases unique and resolves joints to the first fixture of each native body (#307)', () => {
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'rect', x: -50, y: 0, width: 20, height: 10, static: false },
                    { bodyIndex: 0, fixtureIndex: 1, name: 'Unnamed Shape', type: 'rect', x: 50, y: 0, width: 20, height: 10, static: false },
                    { bodyIndex: 1, fixtureIndex: 2, name: 'Unnamed Shape', type: 'rect', x: 0, y: 100, width: 200, height: 10, static: true },
                ],
                physicsBodies: [
                    {
                        index: 0,
                        name: 'compound',
                        type: 'd',
                        typeName: 'dynamic',
                        position: { x: 0, y: 0 },
                        fixtureIndices: [0, 1],
                        fixtures: [
                            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: -50, y: 0 }, angle: 0, width: 20, height: 10 } },
                            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 50, y: 0 }, angle: 0, width: 20, height: 10 } },
                        ],
                    },
                    {
                        index: 1,
                        name: 'anchor',
                        type: 's',
                        typeName: 'static',
                        position: { x: 0, y: 100 },
                        fixtureIndices: [2],
                        fixtures: [
                            { fixtureIndex: 2, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 200, height: 10 } },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
                physicsJoints: [{ type: 'lpj', bodyA: 0, bodyB: -1 }],
            } as any) as any;

            expect(out.bodies.map((body: any) => body.name)).toEqual([
                'compound#0', 'compound#1', 'anchor',
            ]);
            expect(out.bodies[0].nativeBody.index).toBe(0);
            expect(out.bodies[1].nativeBody.index).toBe(0);
            expect(out.joints[0].bodyA).toBe('compound#0');
            expect(out.joints[0].isGround).toBe(true);
        });
    });
});
