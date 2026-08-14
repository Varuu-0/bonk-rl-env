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

        it('preserves native body render order as render-only provenance', () => {
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 4, name: 'background', type: 'rect', x: 0, y: 0, width: 100, height: 100, static: true },
                    { bodyIndex: 0, name: 'wall', type: 'rect', x: 0, y: 0, width: 40, height: 10, static: true },
                ],
                bodyRenderOrder: [0, 4],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;
            expect(out.bodyRenderOrder).toEqual([0, 4]);
            expect(out.bodies.map((body: any) => body.renderBodyIndex)).toEqual([4, 0]);
        });

        it('retains native shape transforms for rendering flattened fixtures', () => {
            const out = normalizeMap({
                physicsBodies: [
                    { position: { x: 30, y: -500 }, angle: 0.25 },
                ],
                physicsShapes: [
                    {
                        type: 'po',
                        center: { x: 4, y: -2 },
                        angle: 0.5,
                        scale: 1.5,
                        vertices: [{ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 0, y: -3 }],
                    },
                ],
                bodies: [
                    {
                        bodyIndex: 0,
                        fixtureIndex: 0,
                        shapeIndex: 0,
                        name: 'Signature',
                        type: 'polygon',
                        x: 0,
                        y: 0,
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].renderShape).toEqual({
                type: 'polygon',
                bodyPosition: { x: 30, y: -500 },
                bodyAngle: 0.25,
                center: { x: 4, y: -2 },
                angle: 0.5,
                width: undefined,
                height: undefined,
                radius: undefined,
                vertices: [{ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 0, y: -3 }],
                scale: 1.5,
            });
        });

        it('retains render shapes when fallback physicsBodies has null placeholders', () => {
            const out = normalizeMap({
                physicsBodies: [
                    null,
                    {
                        fixtureIndex: 0,
                        shapeIndex: 0,
                        name: 'Signature',
                        type: 'polygon',
                        x: 0,
                        y: 0,
                        position: { x: 30, y: -500 },
                        angle: 0.25,
                    },
                ],
                physicsShapes: [
                    {
                        type: 'po',
                        center: { x: 4, y: -2 },
                        angle: 0.5,
                        scale: 1.5,
                        vertices: [{ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 0, y: -3 }],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies).toHaveLength(1);
            expect(out.bodies[0].renderShape).toMatchObject({
                type: 'polygon',
                bodyPosition: { x: 30, y: -500 },
                bodyAngle: 0.25,
                center: { x: 4, y: -2 },
                angle: 0.5,
                scale: 1.5,
            });
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

        it('combines the absolute-frame rotation inverse with the exporter scale bake (#344 review)', () => {
            // vertexFrame: 'absolute' + angle + scale must convert in ONE step:
            // R(-angle)·((v - pos)·scale). Baking scale without the rotation
            // inverse would leave rotated polygons double-rotated; rotating
            // without baking scale would drop the exporter's shape scale.
            const out = normalizeMap({
                bodies: [
                    {
                        bodyIndex: 0,
                        fixtureIndex: 0,
                        name: 'rot-scaled-triangle',
                        type: 'polygon',
                        x: 100,
                        y: 50,
                        angle: Math.PI / 2,
                        vertexFrame: 'absolute',
                        scale: 2,
                        vertices: [
                            { x: 100, y: 25 },
                            { x: 150, y: 50 },
                            { x: 100, y: 75 },
                        ],
                        static: true,
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // abs - pos = [{0,-25},{50,0},{0,25}]; ×2 = [{0,-50},{100,0},{0,50}];
            // R(-90°)·(dx,dy) = (dy,-dx).
            const local = out.bodies[0].vertices;
            const expectedLocal = [
                { x: -50, y: 0 },
                { x: 0, y: -100 },
                { x: 50, y: 0 },
            ];
            expect(local).toHaveLength(expectedLocal.length);
            expectedLocal.forEach((e, i) => {
                expect(local[i].x).toBeCloseTo(e.x, 10);
                expect(local[i].y).toBeCloseTo(e.y, 10);
            });
            // Reconstructing world bounds as pos + R(90°)·local reproduces the
            // SCALED authored absolute vertices: (v - pos) × scale, rotated
            // back to world = [100..200, 0..100] → (150, 50).
            expect(out.physics.deathCenter).toEqual({ x: 150, y: 50 });
        });

        it('does not rebase exporter-absolute vertices a second time after normalizeMap (#344 review)', () => {
            // Re-normalizing an already-normalized output must be a no-op for
            // polygon vertices: the first pass converted absolute→body-local,
            // so the second pass must recognize the shape-local frame and
            // leave the vertices untouched (no -placement·scale double shift).
            const raw = {
                bodies: [
                    {
                        bodyIndex: 0,
                        fixtureIndex: 0,
                        name: 'local-poly',
                        type: 'polygon',
                        x: 300,
                        y: 200,
                        angle: 0.5,
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
            } as any;
            const once = normalizeMap(raw);
            const twice = normalizeMap(once as any);
            expect(twice.bodies[0].vertices).toEqual(once.bodies[0].vertices);
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

        it('falls back to the raw fixture array position for index-less fixtures after null slots', () => {
            // The index-less fixture at raw position 1 must resolve
            // physicsFixtures[1] — the physicsFixtures index convention — not
            // position 0, which a filtered-array fallback would select.
            const out = normalizeMap({
                physicsBodies: [
                    {
                        index: 0,
                        name: 'b',
                        type: 's',
                        typeName: 'static',
                        position: { x: 0, y: 0 },
                        fixtures: [
                            null,
                            { name: 'Unnamed Shape' },
                        ],
                    },
                ],
                physicsFixtures: [
                    { index: 0, name: 'Unnamed Shape', shapeIndex: 0, collidesGroup1: true },
                    { index: 1, name: 'Unnamed Shape', shapeIndex: 1, collidesGroup1: true },
                ],
                physicsShapes: [
                    { index: 0, type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 10, height: 10 },
                    { index: 1, type: 'bx', typeName: 'rect', center: { x: 0, y: 0 }, angle: 0, width: 30, height: 10 },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies).toHaveLength(1);
            expect(out.bodies[0].nativeBody?.index).toBe(0);
            expect(out.bodies[0].width).toBe(30);
        });

        it('treats position-keyed bodies without fixtures as flat instead of silently dropping them', () => {
            const out = normalizeMap({
                physicsBodies: [
                    { index: 0, name: 'wall', type: 'rect', bodyType: 'static', position: { x: 100, y: 200 }, width: 40, height: 10 },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies).toHaveLength(1);
            expect(out.bodies[0].name).toBe('wall');
            expect(out.bodies[0].x).toBe(100);
            expect(out.bodies[0].y).toBe(200);
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

        it('keeps flattened polygon vertices shape-local (scaled) while deathCenter rotates by def.angle', () => {
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
                                    type: 'po', typeName: 'polygon', center: { x: 0, y: 0 }, angle: 0.25, scale: 2,
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
            // Vertices stay shape-local so getCapZoneSensorSize can rotate them
            // about fixtureDef.x without an extra translation/rotation — and
            // the authored shape.scale (2) is baked into the vertices, not
            // dropped.
            expect(vertices[0]).toEqual({ x: -40, y: 0 });
            expect(vertices[1]).toEqual({ x: 40, y: 0 });
            expect(vertices[2]).toEqual({ x: 0, y: 60 });
            expect(out.bodies[0].x).toBe(100);
            expect(out.bodies[0].y).toBe(50);
            // deathCenter = AABB of (x,y) + R(def.angle)·v — an unrotated AABB
            // would center the circle at (100, 80) instead of the true
            // geometry (def.angle = 0.5 + 0.25 = 0.75).
            const angle = 0.75;
            const rot = (v: { x: number; y: number }) => ({
                x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
                y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
            });
            const xs = vertices.map((v) => 100 + rot(v).x);
            const ys = vertices.map((v) => 50 + rot(v).y);
            expect(out.physics.deathCenter).toEqual({
                x: (Math.min(...xs) + Math.max(...xs)) / 2,
                y: (Math.min(...ys) + Math.max(...ys)) / 2,
            });
            expect(out.physics.deathCenter.x).toBeCloseTo(94.185, 3);
            expect(out.physics.deathCenter.y).toBeCloseTo(58.318, 3);
        });

        it('rebases exporter-flat world-baked polygon vertices to shape-local (scaled) so sensors and deathCenter share one convention', () => {
            // The real exporter (mapexporter.js:518-521) bakes bodyPos +
            // center into every polygon vertex and emits scale separately.
            // normalizeMap must rebase them onto def.x/y and bake the scale in
            // (world vertex = def.x/y + R(def.angle)·(scaled v)) — otherwise
            // the cap-zone sensor AABB and the derived-fixture polygon both
            // double-transform and drop flat.scale.
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'polygon', x: 100, y: 50, angle: 0.25, scale: 2, vertices: [{ x: 80, y: 50 }, { x: 120, y: 50 }, { x: 100, y: 90 }], static: true },
                ],
                physicsBodies: [
                    {
                        index: 0,
                        name: 'body',
                        type: 's',
                        typeName: 'static',
                        position: { x: 100, y: 50 },
                        angle: 0.25,
                        fixtureIndices: [0],
                        fixtures: [],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            const vertices = out.bodies[0].vertices as { x: number; y: number }[];
            expect(vertices).toEqual([
                { x: -40, y: 0 },
                { x: 40, y: 0 },
                { x: 0, y: 80 },
            ]);
            expect(out.bodies[0].x).toBe(100);
            expect(out.bodies[0].y).toBe(50);
            expect(out.bodies[0].angle).toBe(0.25);
        });

        it('rebases a position-keyed exporter-flat polygon about its position, not (0,0) (#307 review)', () => {
            // toBodyDef places a flat body without x/y at body.position, so
            // the rebase must resolve the bake center the same way — a
            // position-keyed polygon rebased about (0,0) would shift every
            // vertex by -position·scale.
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'polygon', position: { x: 100, y: 50 }, angle: 0.25, scale: 2, vertices: [{ x: 80, y: 50 }, { x: 120, y: 50 }, { x: 100, y: 90 }], static: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].x).toBe(100);
            expect(out.bodies[0].y).toBe(50);
            expect(out.bodies[0].vertices).toEqual([
                { x: -40, y: 0 },
                { x: 40, y: 0 },
                { x: 0, y: 80 },
            ]);
        });

        it('rebases a one-sided wedge exporter polygon near the origin despite the distance signature (#307 review)', () => {
            // The bake center (10,0) is near the world origin and the wedge
            // extends toward -x, so the vertices' greatest distance from the
            // bake center (50) exceeds their greatest distance from the world
            // origin (40) — a distance heuristic reads that as "shape-local"
            // and skips the rebase, leaving the world-baked vertices
            // double-offset with `scale` dropped. With the structured
            // hierarchy present the flat view is unambiguously the exporter's,
            // so the rebase must still run.
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'polygon', x: 10, y: 0, angle: 0.25, scale: 2, vertices: [{ x: -40, y: 0 }, { x: 10, y: 10 }, { x: 10, y: -10 }], static: true },
                ],
                physicsBodies: [
                    {
                        index: 0,
                        name: 'body',
                        type: 's',
                        typeName: 'static',
                        position: { x: 10, y: 0 },
                        angle: 0.25,
                        fixtureIndices: [0],
                        fixtures: [],
                    },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].vertices).toEqual([
                { x: -100, y: 0 },
                { x: 0, y: 20 },
                { x: 0, y: -20 },
            ]);
            expect(out.bodies[0].x).toBe(10);
            expect(out.bodies[0].y).toBe(0);
        });

        it('does not count flat (non-native) physicsBodies entries as structured, so legacy shape-local polygons stay unrebased (#307 review)', () => {
            // A legacy map carries BOTH a hand-authored shape-local polygon in
            // bodies[] and a position-keyed flat physicsBodies entry. The flat
            // physicsBodies entry must NOT flip the hasStructured gate — it is
            // not the exporter hierarchy — or the shape-local polygon would be
            // rebased about (300,200) and corrupted.
            const out = normalizeMap({
                bodies: [
                    { name: 'poly', type: 'polygon', x: 300, y: 200, vertices: [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 30 }], static: true },
                ],
                physicsBodies: [
                    { index: 0, name: 'wall', type: 'rect', bodyType: 'static', position: { x: 0, y: 0 }, width: 40, height: 10 },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].vertices).toEqual([
                { x: -20, y: 0 },
                { x: 20, y: 0 },
                { x: 0, y: 30 },
            ]);
            expect(out.physics.deathCenter).toEqual({ x: 300, y: 215 });
        });

        it('rebases a flat-only exporter wedge polygon near the origin via its exporter identity keys (#307 review)', () => {
            // No structured hierarchy at all — but the flat body carries the
            // exporter's identity keys (bodyIndex/fixtureIndex), so it came
            // from the exporter flat view and its vertices ARE world-baked.
            // The old distance fallback misclassified this near-origin wedge
            // (greatest distance from the bake center exceeds the greatest
            // distance from the world origin) and skipped the rebase, leaving
            // the vertices double-offset with `scale` dropped.
            const out = normalizeMap({
                bodies: [
                    { bodyIndex: 0, fixtureIndex: 0, name: 'Unnamed Shape', type: 'polygon', x: 10, y: 0, angle: 0.25, scale: 2, vertices: [{ x: -40, y: 0 }, { x: 10, y: 10 }, { x: 10, y: -10 }], static: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].vertices).toEqual([
                { x: -100, y: 0 },
                { x: 0, y: 20 },
                { x: 0, y: -20 },
            ]);
            expect(out.bodies[0].x).toBe(10);
        });

        it('leaves hand-authored shape-local flat polygons unrebased so the legacy placement survives (#307 review)', () => {
            // A hand-authored flat polygon follows the legacy convention
            // (world = def.x/y + R(angle)·v) with vertices around the shape's
            // own origin. The exporter-style rebase would silently shift it
            // by -def.x·scale, so the world-baked discriminator must skip it.
            const out = normalizeMap({
                bodies: [
                    { name: 'poly', type: 'polygon', x: 300, y: 200, vertices: [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 30 }], static: true },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            expect(out.bodies[0].vertices).toEqual([
                { x: -20, y: 0 },
                { x: 20, y: 0 },
                { x: 0, y: 30 },
            ]);
            // deathCenter reads the vertices as shape-local about def.x/y.
            expect(out.physics.deathCenter).toEqual({ x: 300, y: 215 });
        });

        it('keeps an object carrying both x and an empty fixtures list as a flat body (#307 review)', () => {
            const out = normalizeMap({
                physicsBodies: [
                    { index: 0, name: 'wall', type: 'rect', bodyType: 'static', x: 100, y: 200, width: 40, height: 10, fixtures: [] },
                ],
                spawns: [{ x: 0, y: 0, blue: true, red: true }],
            } as any) as any;

            // An empty fixtures list is a stray structured key on a flat body,
            // not a native body — flattening it to nothing would drop it.
            expect(out.bodies).toHaveLength(1);
            expect(out.bodies[0].name).toBe('wall');
            expect(out.bodies[0].x).toBe(100);
            expect(out.bodies[0].y).toBe(200);
            expect(out.bodies[0].width).toBe(40);
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

        it('preserves exported bounds in map-pixel units for downstream conversion (#320)', () => {
            const out = normalizeMap({
                physics: { ppm: 12, boundsWidth: 730, boundsHeight: 500 },
                bodies: [
                    { bodyIndex: 0, name: 'floor', type: 'rect', x: 0, y: 200, width: 900, height: 20, static: true },
                ],
                spawns: [{ x: -100, y: -50, blue: true }, { x: 100, y: -50, red: true }],
            } as any);

            expect(out.physics?.bounds).toEqual({ width: 730, height: 500 });
        });
    });
});
