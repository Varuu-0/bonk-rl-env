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
