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

    describe('native/structured export hardening (#307 review)', () => {
        it('classifies merged native+flat physicsBodies as native via markers, not x/y absence', () => {
            // A programmatic export may carry both a structured body (`position`
            // + `fixtures`) and flat `x`/`y` on the same object. Discriminating
            // native by the ABSENCE of `x` was fragile and would treat this as
            // flat, dropping the fixture grouping this PR relies on.
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'merged',
                        position: { x: 0, y: 0 },
                        x: 50,
                        y: 60,
                        type: 'd',
                        typeName: 'dynamic',
                        fixtureIndices: [0, 1],
                        fixtures: [
                            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: -40, y: 0 }, angle: 0, width: 20, height: 10 } },
                            { fixtureIndex: 1, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 40, y: 0 }, angle: 0, width: 20, height: 10 } },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies).toHaveLength(2);
            expect(out.bodies[0].nativeBody?.index).toBe(0);
            expect(out.bodies[1].nativeBody?.index).toBe(0);
        });

        it('does not let an empty fixtureIndices list shadow populated fixtures', () => {
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'b',
                        type: 's',
                        typeName: 'static',
                        position: { x: 0, y: 0 },
                        fixtureIndices: [],
                        fixtures: [
                            null,
                            { fixtureIndex: 7, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 10, height: 10 } },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies).toHaveLength(1);
            // The single fixture still flattens (its own fixtureIndex wins and
            // the null placeholder at position 0 is filtered before any
            // array-position fallback), and its shape geometry survives.
            expect(out.bodies[0].nativeBody?.index).toBe(0);
            expect(out.bodies[0].width).toBe(10);
        });

        it('keeps unknown-shape fixtures as aliases but never degrades them to a 0x0 rect', () => {
            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (m: unknown) => warnings.push(String(m));
            try {
                const out = normalizeMap({
                    physicsBodies: [
                        {
                            index: 0,
                            name: 'weird',
                            type: 's',
                            typeName: 'static',
                            position: { x: 0, y: 0 },
                            fixtureIndices: [0],
                            fixtures: [
                                { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'xx', typeName: 'weird', center: { x: 0, y: 0 }, angle: 0 } },
                            ],
                        },
                    ],
                    spawns: [{ x: 0, y: 0, blue: true, red: true }],
                } as any) as any;
                expect(out.bodies).toHaveLength(1);
                expect(out.bodies[0].type).toBeUndefined();
                expect(warnings.join('\n')).toMatch(/unsupported shape type/i);
            } finally {
                console.warn = origWarn;
            }
        });

        it('keeps shape-less fixture aliases so cap zones resolve their platform name', () => {
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'cap platform',
                        type: 's',
                        typeName: 'static',
                        position: { x: 0, y: 0 },
                        fixtureIndices: [0],
                        fixtures: [{ fixtureIndex: 0, name: 'Unnamed Shape', shape: null }],
                    },
                ],
                capZones: [{ index: 0, fixtureIndex: 0 }],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // The shape-less fixture is NOT dropped: its alias survives so the
            // cap zone resolves a real platform name instead of an empty one.
            expect(out.bodies).toHaveLength(1);
            expect(out.bodies[0].name).toBe('cap platform');
            expect(out.capZones[0].fixture).toBe('cap platform');
        });

        it('flattens polygon vertices into world space so deathCenter matches the geometry', () => {
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'poly',
                        type: 's',
                        typeName: 'static',
                        position: { x: 100, y: 50 },
                        angle: 0.5,
                        fixtureIndices: [0],
                        fixtures: [
                            {
                                fixtureIndex: 0,
                                name: 'Unnamed Shape',
                                shape: {
                                    type: 'po', typeName: 'polygon', center: { x: 0, y: 0 }, angle: 0.25, scale: 1,
                                    vertices: [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 30 }],
                                },
                            },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            const vertices = out.bodies[0].vertices as { x: number; y: number }[];
            expect(vertices).toHaveLength(3);
            // Vertices must carry the body position (world coords), not be
            // shape-local — a local vertex set would sit far left of x=100.
            expect(Math.min(...vertices.map((v) => v.x))).toBeGreaterThan(50);
            expect(Math.min(...vertices.map((v) => v.y))).toBeGreaterThan(20);
            // deathCenter is the AABB midpoint of the world-space vertices.
            const minX = Math.min(...vertices.map((v) => v.x));
            const maxX = Math.max(...vertices.map((v) => v.x));
            const minY = Math.min(...vertices.map((v) => v.y));
            const maxY = Math.max(...vertices.map((v) => v.y));
            expect(out.physics.deathCenter).toEqual({
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
            });
        });

        it('emits the rotated world center for native-fixture bodies so sensors align', () => {
            const angle = Math.PI / 4;
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'rot',
                        type: 's',
                        typeName: 'static',
                        position: { x: 100, y: 50 },
                        angle,
                        fixtureIndices: [0],
                        fixtures: [
                            { fixtureIndex: 0, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 100, y: 0 }, angle: 0, width: 20, height: 10 } },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // The un-rotated exporter view would emit 200/50; the shape's true
            // world center is 100 + rotate((100,0), 45°).
            expect(out.bodies[0].x).toBeCloseTo(100 + 100 * Math.cos(angle), 5);
            expect(out.bodies[0].y).toBeCloseTo(50 + 100 * Math.sin(angle), 5);
        });

        it('groups a flat fixture under its true native owner when bodyIndex points elsewhere', () => {
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 1, fixtureIndex: 9, name: 'Unnamed Shape', type: 'rect', x: 0, y: 0, width: 10, height: 10, static: false },
                    { bodyIndex: 1, fixtureIndex: 8, name: 'Unnamed Shape', type: 'rect', x: 0, y: 100, width: 10, height: 10, static: false },
                    { bodyIndex: 2, fixtureIndex: 10, name: 'Unnamed Shape', type: 'rect', x: 0, y: 200, width: 200, height: 10, static: true },
                ],
                physicsBodies: [
                    {
                        index: 1,
                        name: 'bodyA',
                        type: 'd',
                        typeName: 'dynamic',
                        position: { x: 0, y: 100 },
                        fixtureIndices: [8],
                        fixtures: [
                            { fixtureIndex: 8, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 10, height: 10 } },
                        ],
                    },
                    {
                        index: 2,
                        name: 'bodyB',
                        type: 'd',
                        typeName: 'dynamic',
                        position: { x: 0, y: 0 },
                        fixtureIndices: [9, 10],
                        fixtures: [
                            { fixtureIndex: 9, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 10, height: 10 } },
                            { fixtureIndex: 10, name: 'Unnamed Shape', shape: { type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 200, height: 10 } },
                        ],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
                physicsJoints: [{ type: 'rv', bodyA: 2, bodyB: 1 }],
            } as any) as any;

            // bodies[0] claims bodyIndex 1, but its fixture 9 belongs to native
            // body 2 — the fixture owner wins so grouping/joints stay correct.
            expect(out.bodies[0].nativeBody?.index).toBe(2);
            expect(out.bodies[1].nativeBody?.index).toBe(1);
            expect(out.bodies[2].nativeBody?.index).toBe(2);
            // A joint to native body 2 must resolve to ITS first alias.
            expect(out.joints[0].bodyA).toBe('bodyB#9');
        });
    });
});
