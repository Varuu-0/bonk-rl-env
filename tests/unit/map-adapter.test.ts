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

        it('converts exported polygon vertices to body-local coordinates (#318)', () => {
            const out = normalizeMap({
                bodies: [
                    {
                        bodyIndex: 0,
                        name: 'exported-triangle',
                        type: 'polygon',
                        x: 300,
                        y: 200,
                        angle: 0,
                        vertices: [
                            { x: 300, y: 150 },
                            { x: 350, y: 200 },
                            { x: 300, y: 250 },
                        ],
                        static: true,
                    },
                    { bodyIndex: 1, name: 'rect', type: 'rect', x: 25, y: 40, width: 20, height: 10, static: true },
                    { bodyIndex: 2, name: 'circle', type: 'circle', x: -25, y: -40, radius: 8, static: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].vertices).toEqual([
                { x: 0, y: -50 },
                { x: 50, y: 0 },
                { x: 0, y: 50 },
            ]);
            expect(out.bodies[1]).toMatchObject({ x: 25, y: 40, width: 20, height: 10 });
            expect(out.bodies[2]).toMatchObject({ x: -25, y: -40, radius: 8 });
            // The center includes all three fixtures: polygon [300..350,
            // 150..250], rect [15..35, 35..45], and circle [-33..-17,
            // -48..-32]. Polygon bounds must be reconstructed from its body
            // transform after normalization rather than from local vertices.
            expect(out.physics.deathCenter).toEqual({ x: 158.5, y: 101 });
        });

        it('inverts the body rotation when converting absolute polygon vertices (#318, #344)', () => {
            const out = normalizeMap({
                bodies: [
                    {
                        bodyIndex: 0,
                        name: 'rotated-triangle',
                        type: 'polygon',
                        x: 300,
                        y: 200,
                        angle: Math.PI / 2,
                        vertexFrame: 'absolute',
                        vertices: [
                            { x: 300, y: 150 },
                            { x: 350, y: 200 },
                            { x: 300, y: 250 },
                        ],
                        static: true,
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // abs - pos = [{0,-50},{50,0},{0,50}]; R(-90°)·(dx,dy) = (dy,-dx).
            const local = out.bodies[0].vertices;
            const expectedLocal = [
                { x: -50, y: 0 },
                { x: 0, y: -50 },
                { x: 50, y: 0 },
            ];
            expect(local).toHaveLength(expectedLocal.length);
            expectedLocal.forEach((e, i) => {
                expect(local[i].x).toBeCloseTo(e.x, 10);
                expect(local[i].y).toBeCloseTo(e.y, 10);
            });
            // Reconstructing world bounds as pos + R(90°)·local reproduces the
            // authored absolute vertices [300..350, 150..250] → (325, 200).
            expect(out.physics.deathCenter).toEqual({ x: 325, y: 200 });
        });

        it('computes polygon world bounds when the origin lies outside the hull (#344)', () => {
            const out = normalizeMap({
                bodies: [
                    {
                        bodyIndex: 0,
                        name: 'offset-poly',
                        type: 'polygon',
                        x: 100,
                        y: 100,
                        angle: 0,
                        vertices: [
                            { x: 120, y: 110 },
                            { x: 170, y: 110 },
                            { x: 170, y: 160 },
                            { x: 120, y: 160 },
                        ],
                        static: true,
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // The local frame is [20..70, 10..60]; the body origin (0,0) lies
            // outside the hull, so a naive local-vertex bound would collapse.
            expect(out.bodies[0].vertices).toEqual([
                { x: 20, y: 10 },
                { x: 70, y: 10 },
                { x: 70, y: 60 },
                { x: 20, y: 60 },
            ]);
            // World bounds [120..170, 110..160] → deathCenter (145, 135).
            expect(out.physics.deathCenter).toEqual({ x: 145, y: 135 });
        });

        it('does not shift already body-local polygon vertices declared via vertexFrame (#344)', () => {
            const out = normalizeMap({
                bodies: [
                    {
                        bodyIndex: 0,
                        name: 'local-poly',
                        type: 'polygon',
                        x: 300,
                        y: 200,
                        angle: 0,
                        vertexFrame: 'local',
                        vertices: [
                            { x: 0, y: -50 },
                            { x: 50, y: 0 },
                            { x: 0, y: 50 },
                        ],
                        static: true,
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // Body-local vertices pass through unshifted; world bounds still
            // reconstruct from the body transform ([300..350, 150..250] → (325, 200)).
            expect(out.bodies[0].vertices).toEqual([
                { x: 0, y: -50 },
                { x: 50, y: 0 },
                { x: 0, y: 50 },
            ]);
            expect(out.physics.deathCenter).toEqual({ x: 325, y: 200 });
        });
    });
});
