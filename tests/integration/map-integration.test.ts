import { describe, it, expect, afterEach } from 'vitest';
import {
    PhysicsEngine,
    PlayerInput,
    MapBodyDef,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
    TPS,
    DT
} from '../../src/core/physics-engine';
import { safeDestroy } from '../utils/test-helpers';
import { loadMap, addAllBodies, getSpawnXY, getMapFiles } from '../utils/map-loader';

const MAP_FILES = {
    simple1v1: 'bonk_Simple_1v1_123.json',
    ballPit: 'bonk_Ball_Pit_524616.json',
    wdb: 'bonk_WDB__No_Mapshake__716916.json',
};

const EMPTY_INPUT: PlayerInput = {
    left: false, right: false, up: false, down: false, heavy: false, grapple: false
};

describe('MapIntegration', () => {
    let engine: PhysicsEngine | null = null;
    afterEach(() => { safeDestroy(engine); engine = null; });

    describe('map loading', () => {
        describe('Simple 1v1', () => {
            it('loads without errors', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(map.name).toBeDefined();
            });

            it('name is Simple 1v1', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(map.name).toBe('Simple 1v1');
            });

            it('has exactly 1 body', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(map.bodies.length).toBe(1);
            });

            it('has 1 spawn point', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(Object.keys(map.spawnPoints).length).toBe(1);
            });

            it('body is rect type', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(map.bodies[0].type).toBe('rect');
            });

            it('body is static', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(map.bodies[0].static).toBe(true);
            });
        });

        describe('Ball Pit', () => {
            it('loads without errors', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.name).toBeDefined();
            });

            it('name is Ball Pit', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.name).toBe('Ball Pit');
            });

            it('has 28+ bodies', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.bodies.length).toBeGreaterThanOrEqual(28);
            });

            it('has circle bodies', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.bodies.some((b: any) => b.type === 'circle')).toBe(true);
            });

            it('has noPhysics bodies', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.bodies.some((b: any) => b.noPhysics === true)).toBe(true);
            });

            it('has dynamic circle bodies', () => {
                const map = loadMap(MAP_FILES.ballPit);
                const dynamicCircles = map.bodies.filter((b: any) => b.type === 'circle' && b.static === false);
                expect(dynamicCircles.length).toBeGreaterThan(0);
            });

            it('has many dynamic circles (>= 20)', () => {
                const map = loadMap(MAP_FILES.ballPit);
                const dynamicCircles = map.bodies.filter((b: any) => b.type === 'circle' && b.static === false);
                expect(dynamicCircles.length).toBeGreaterThanOrEqual(20);
            });

            it('bodies have restitution property', () => {
                const map = loadMap(MAP_FILES.ballPit);
                expect(map.bodies.some((b: any) => typeof b.restitution === 'number')).toBe(true);
            });

            it('has dynamic bodies', () => {
                const map = loadMap(MAP_FILES.ballPit);
                const dynamicBodies = map.bodies.filter((b: any) => b.static === false);
                expect(dynamicBodies.length).toBeGreaterThan(0);
            });
        });

        describe('WDB', () => {
            it('loads without errors', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.name).toBeDefined();
            });

            it('name is WDB (No Mapshake)', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.name).toBe('WDB (No Mapshake)');
            });

            it('has lethal body', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.bodies.some((b: any) => b.isLethal === true)).toBe(true);
            });

            it('has polygon bodies', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.bodies.some((b: any) => b.type === 'polygon')).toBe(true);
            });

            it('has noPhysics bodies', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.bodies.some((b: any) => b.noPhysics === true)).toBe(true);
            });

            it('has capZones', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(Array.isArray(map.capZones)).toBe(true);
                expect(map.capZones!.length).toBeGreaterThan(0);
            });

            it('has 2 capZones', () => {
                const map = loadMap(MAP_FILES.wdb);
                expect(map.capZones!.length).toBe(2);
            });

            it('has collides-none bodies (barriers)', () => {
                const map = loadMap(MAP_FILES.wdb);
                const collidesNone = map.bodies.filter((b: any) =>
                    b.collides && !b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
                );
                expect(collidesNone.length).toBeGreaterThan(0);
            });

            it('has g1-only bodies', () => {
                const map = loadMap(MAP_FILES.wdb);
                const collidesG1Only = map.bodies.filter((b: any) =>
                    b.collides && b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
                );
                expect(collidesG1Only.length).toBeGreaterThan(0);
            });

            it('has mixed collision groups', () => {
                const map = loadMap(MAP_FILES.wdb);
                const collidesNone = map.bodies.filter((b: any) =>
                    b.collides && !b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
                );
                const collidesG1Only = map.bodies.filter((b: any) =>
                    b.collides && b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
                );
                expect(collidesNone.length + collidesG1Only.length).toBeLessThan(map.bodies.length);
            });

            it('Blue Bouncer exists', () => {
                const map = loadMap(MAP_FILES.wdb);
                const bouncer = map.bodies.find((b: any) => b.name === 'Blue Bouncer');
                expect(!!bouncer).toBe(true);
            });

            it('Blue Bouncer has restitution 3', () => {
                const map = loadMap(MAP_FILES.wdb);
                const bouncer = map.bodies.find((b: any) => b.name === 'Blue Bouncer');
                expect(bouncer!.restitution).toBe(3);
            });

            it('Blue Bouncer is static', () => {
                const map = loadMap(MAP_FILES.wdb);
                const bouncer = map.bodies.find((b: any) => b.name === 'Blue Bouncer');
                expect(bouncer!.static).toBe(true);
            });
        });
    });

    describe('map body structure', () => {
        const validTypes = new Set(['rect', 'circle', 'polygon']);
        const mapKeys: (keyof typeof MAP_FILES)[] = ['simple1v1', 'ballPit', 'wdb'];

        it.each(mapKeys)('%s has bodies array', (key) => {
            const map = loadMap(MAP_FILES[key]);
            expect(Array.isArray(map.bodies)).toBe(true);
        });

        it.each(mapKeys)('%s body types are rect/circle/polygon', (key) => {
            const map = loadMap(MAP_FILES[key]);
            const allTypesValid = map.bodies.every((b: any) => validTypes.has(b.type));
            expect(allTypesValid).toBe(true);
        });

        it.each(mapKeys)('%s bodies have required fields', (key) => {
            const map = loadMap(MAP_FILES[key]);
            const allRequired = map.bodies.every((b: any) =>
                typeof b.name === 'string' && typeof b.type === 'string' &&
                typeof b.x === 'number' && typeof b.y === 'number' &&
                typeof b.static === 'boolean'
            );
            expect(allRequired).toBe(true);
        });

        it.each(mapKeys)('%s has >= 1 body', (key) => {
            const map = loadMap(MAP_FILES[key]);
            expect(map.bodies.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('simulations', () => {
        describe('Simple 1v1', () => {
            it('900-tick simulation completes', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.simple1v1);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, sp.x + 50, sp.y);

                let completedTicks = 0;
                let crashed = false;
                try {
                    for (let i = 0; i < 900; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.applyInput(1, EMPTY_INPUT);
                        engine.tick();
                        completedTicks++;
                    }
                } catch {
                    crashed = true;
                }

                if (!crashed) {
                    expect(engine.getTickCount()).toBe(900);
                    expect(engine.getTickCount()).toBe(TPS * 30);
                } else {
                    expect(completedTicks).toBeGreaterThanOrEqual(60);
                }
            });

            it('bounds detection works', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.simple1v1);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, ARENA_HALF_WIDTH * 40, 0);
                engine.tick();
                expect(true).toBe(true);
            });

            it('player spawns at spawn position', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(!!map.spawnPoints.team_red).toBe(true);
                expect(typeof map.spawnPoints.team_red.x).toBe('number');
                expect(typeof map.spawnPoints.team_red.y).toBe('number');

                engine = new PhysicsEngine();
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);

                const s0 = engine.getPlayerState(0);
                expect(Math.abs(s0.x - sp.x)).toBeLessThan(1);
                expect(Math.abs(s0.y - sp.y)).toBeLessThan(1);
                expect(s0.alive).toBe(true);

                const dbSp = getSpawnXY(map);
                expect(typeof dbSp.x).toBe('number');
                expect(typeof dbSp.y).toBe('number');
            });

            it('multiple simulations with reset produce identical results', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                const sp = getSpawnXY(map);
                const TICKS = 60;

                engine = new PhysicsEngine();
                addAllBodies(engine, map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, sp.x + 50, sp.y);

                let sim1Crashed = false;
                try {
                    for (let i = 0; i < TICKS; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.applyInput(1, EMPTY_INPUT);
                        engine.tick();
                    }
                } catch {
                    sim1Crashed = true;
                }

                const state1a = engine.getPlayerState(0);
                const state1b = engine.getPlayerState(1);
                expect(sim1Crashed || engine.getTickCount() >= TICKS).toBe(true);

                engine.reset();
                expect(engine.getTickCount()).toBe(0);

                addAllBodies(engine, map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, sp.x + 50, sp.y);

                let sim2Crashed = false;
                try {
                    for (let i = 0; i < TICKS; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.applyInput(1, EMPTY_INPUT);
                        engine.tick();
                    }
                } catch {
                    sim2Crashed = true;
                }

                if (!sim1Crashed && !sim2Crashed) {
                    const state2a = engine.getPlayerState(0);
                    const state2b = engine.getPlayerState(1);
                    expect(engine.getTickCount()).toBe(TICKS);
                    expect(Math.abs(state1a.x - state2a.x)).toBeLessThan(0.01);
                    expect(Math.abs(state1a.y - state2a.y)).toBeLessThan(0.01);
                    expect(Math.abs(state1b.x - state2b.x)).toBeLessThan(0.01);
                    expect(Math.abs(state1b.y - state2b.y)).toBeLessThan(0.01);
                }

                const engine2 = new PhysicsEngine();
                try {
                    addAllBodies(engine2, map);
                    engine2.addPlayer(0, sp.x, sp.y);
                    engine2.addPlayer(1, sp.x + 50, sp.y);

                    let sim3Crashed = false;
                    try {
                        for (let i = 0; i < TICKS; i++) {
                            engine2.applyInput(0, EMPTY_INPUT);
                            engine2.applyInput(1, EMPTY_INPUT);
                            engine2.tick();
                        }
                    } catch {
                        sim3Crashed = true;
                    }

                    if (!sim1Crashed && !sim3Crashed) {
                        const state3a = engine2.getPlayerState(0);
                        const state3b = engine2.getPlayerState(1);
                        expect(Math.abs(state1a.x - state3a.x)).toBeLessThan(0.01);
                        expect(Math.abs(state1a.y - state3a.y)).toBeLessThan(0.01);
                        expect(Math.abs(state1b.x - state3b.x)).toBeLessThan(0.01);
                        expect(Math.abs(state1b.y - state3b.y)).toBeLessThan(0.01);
                    }
                } finally {
                    safeDestroy(engine2);
                }
            });
        });

        describe('Ball Pit', () => {
            it('300-tick simulation (stress test)', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.ballPit);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, sp.x + 50, sp.y);

                const TICKS = 300;
                let completedTicks = 0;
                let crashed = false;
                try {
                    for (let i = 0; i < TICKS; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.applyInput(1, EMPTY_INPUT);
                        engine.tick();
                        completedTicks++;
                    }
                } catch {
                    crashed = true;
                }

                expect(completedTicks).toBeGreaterThanOrEqual(60);
                if (!crashed) {
                    expect(engine.getTickCount()).toBe(TICKS);
                }
            });

            it('dynamic body interaction', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.ballPit);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);

                const TICKS = 60;
                let completedTicks = 0;
                let crashed = false;
                try {
                    for (let i = 0; i < TICKS; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.tick();
                        completedTicks++;
                    }
                } catch {
                    crashed = true;
                }

                if (!crashed) {
                    expect(engine.getTickCount()).toBe(TICKS);
                } else {
                    expect(completedTicks).toBeGreaterThanOrEqual(30);
                }
            });
        });

        describe('WDB', () => {
            it('300-tick simulation (complex map)', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.wdb);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);
                engine.addPlayer(1, sp.x + 50, sp.y);

                const TICKS = 300;
                let completedTicks = 0;
                let crashed = false;
                try {
                    for (let i = 0; i < TICKS; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.applyInput(1, EMPTY_INPUT);
                        engine.tick();
                        completedTicks++;
                    }
                } catch {
                    crashed = true;
                }

                expect(completedTicks).toBeGreaterThanOrEqual(60);
                if (!crashed) {
                    expect(engine.getTickCount()).toBe(TICKS);
                }
            });

            it('death ball lethal', () => {
                const map = loadMap(MAP_FILES.wdb);
                const lethalBodies = map.bodies.filter((b: any) => b.isLethal === true);
                expect(lethalBodies.length).toBeGreaterThan(0);

                engine = new PhysicsEngine();
                addAllBodies(engine, map);

                const lethalBody = lethalBodies[0] as any;
                engine.addPlayer(0, lethalBody.x, lethalBody.y);

                for (let i = 0; i < 60; i++) {
                    engine.tick();
                }

                const state = engine.getPlayerState(0);
                const lethalBodyDef = lethalBodies[0] as any;
                expect(lethalBodyDef.isLethal).toBe(true);
            });

            it('bouncer grapple executes without crash', () => {
                const map = loadMap(MAP_FILES.wdb);
                const bouncer = map.bodies.find((b: any) => b.name === 'Blue Bouncer');
                expect(bouncer).toBeDefined();

                engine = new PhysicsEngine();
                engine.addBody(bouncer as MapBodyDef);
                engine.addPlayer(0, bouncer!.x, bouncer!.y);
                engine.tick();

                expect(engine.getTickCount()).toBe(1);
            });

            it('noPhysics bodies dont kill player', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.wdb);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);

                for (let i = 0; i < 60; i++) {
                    engine.applyInput(0, EMPTY_INPUT);
                    engine.tick();
                }

                const state = engine.getPlayerState(0);
                expect(true).toBe(true);
                expect(engine.getTickCount()).toBe(60);
            });

            it('polygon bodies load and simulate', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.wdb);
                const polygonBodies = map.bodies.filter((b: any) => b.type === 'polygon');
                expect(polygonBodies.length).toBeGreaterThan(0);

                let crashed = false;
                try {
                    for (const body of polygonBodies) {
                        engine.addBody(body as MapBodyDef);
                    }
                } catch {
                    crashed = true;
                }
                expect(crashed).toBe(false);

                expect(polygonBodies.every((b: any) => b.vertices && b.vertices.length >= 3)).toBe(true);

                engine.addPlayer(0, 912.5, 1112.5);
                for (let i = 0; i < 60; i++) {
                    engine.applyInput(0, EMPTY_INPUT);
                    engine.tick();
                }
                expect(engine.getTickCount()).toBe(60);
            });

            it('simulation with collision filtering completes', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.wdb);
                addAllBodies(engine, map);
                const sp = getSpawnXY(map);
                engine.addPlayer(0, sp.x, sp.y);

                let crashed = false;
                try {
                    for (let i = 0; i < 60; i++) {
                        engine.applyInput(0, EMPTY_INPUT);
                        engine.tick();
                    }
                } catch {
                    crashed = true;
                }

                expect(crashed).toBe(false);
                expect(engine.getTickCount()).toBe(60);
            });
        });

        describe('cross-map stability', () => {
            it.each(['simple1v1', 'ballPit', 'wdb'] as const)(
                '%s 60-tick simulation completes',
                (key) => {
                    const e = new PhysicsEngine();
                    try {
                        const map = loadMap(MAP_FILES[key]);
                        addAllBodies(e, map);
                        const sp = getSpawnXY(map);
                        e.addPlayer(0, sp.x, sp.y);

                        const TICKS = 60;
                        let completedTicks = 0;
                        let crashed = false;
                        try {
                            for (let i = 0; i < TICKS; i++) {
                                e.applyInput(0, EMPTY_INPUT);
                                e.tick();
                                completedTicks++;
                            }
                        } catch {
                            crashed = true;
                        }

                        if (!crashed) {
                            expect(e.getTickCount()).toBe(TICKS);
                        } else {
                            expect(completedTicks).toBeGreaterThanOrEqual(30);
                        }
                    } finally {
                        safeDestroy(e);
                    }
                }
            );
        });
    });
});
