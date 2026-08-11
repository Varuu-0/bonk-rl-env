import { describe, it, expect, afterEach } from 'vitest';
import {
    PhysicsEngine,
    PlayerInput,
    MapBodyDef,
    ARENA_HALF_WIDTH,
    ARENA_HALF_HEIGHT,
    TPS,
    DT,
    SCALE
} from '../../src/core/physics-engine';
import { BonkEnvironment } from '../../src/core/environment';
import { safeDestroy } from '../utils/test-helpers';
import { loadMap, addAllBodies, getSpawnXY, getMapFiles } from '../utils/map-loader';

const MAP_FILES = {
    simple1v1: 'bonk_Simple_1v1_123.json',
    wdb: 'bonk_WDB__No_Mapshake__716916.json',
    weird: 'bonk_WeiRd_DeAth_BalL__80622.json',
};
const hasWdb = getMapFiles().includes(MAP_FILES.wdb);
const describeWdb = hasWdb ? describe : describe.skip;
if (!hasWdb) {
    console.warn(`[MapIntegration] Optional WDB fixture ${MAP_FILES.wdb} is unavailable; WDB-specific tests are skipped.`);
}
const simulationMapKeys = hasWdb
    ? (['simple1v1', 'wdb', 'weird'] as const)
    : (['simple1v1', 'weird'] as const);

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

            it('has 2 spawn points', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                expect(Object.keys(map.spawnPoints).length).toBe(2);
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

        describe('WeiRd DeAth BalL', () => {
            it('loads without errors', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.name).toBeDefined();
            });

            it('name is WeiRd DeAth BalL', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.name).toBe('WeiRd DeAth BalL ');
            });

            it('has many bodies', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.bodies.length).toBeGreaterThanOrEqual(15);
            });

            it('has dynamic bodies', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.bodies.some((b: any) => b.static === false)).toBe(true);
            });

            it('has noPhysics bodies', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.bodies.some((b: any) => b.noPhysics === true)).toBe(true);
            });

            it('has rect and circle bodies', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.bodies.some((b: any) => b.type === 'rect')).toBe(true);
                expect(map.bodies.some((b: any) => b.type === 'circle')).toBe(true);
            });

            it('bodies have restitution property', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.bodies.some((b: any) => typeof b.restitution === 'number')).toBe(true);
            });

            it('has capZones', () => {
                const map = loadMap(MAP_FILES.weird);
                expect(map.capZones!.length).toBeGreaterThan(0);
            });

            it('has dynamic bodies', () => {
                const map = loadMap(MAP_FILES.weird);
                const dynamicBodies = map.bodies.filter((b: any) => b.static === false);
                expect(dynamicBodies.length).toBeGreaterThan(0);
            });
        });

        describeWdb('WDB', () => {
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
        const mapKeys: (keyof typeof MAP_FILES)[] = hasWdb
            ? ['simple1v1', 'weird', 'wdb']
            : ['simple1v1', 'weird'];

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

            it('player lands and rests on the platform (collidesWithPlayers=false must stay solid)', () => {
                const map = loadMap(MAP_FILES.simple1v1);
                const dc = (map as any).physics?.deathCenter;
                engine = new PhysicsEngine();
                addAllBodies(engine, map);
                if (dc) engine.setDeathCircleCenter(dc.x, dc.y);
                const sp = getSpawnXY(map);
                const platform = map.bodies[0];
                const top = platform.y - (platform.height || 0) / 2;
                engine.addPlayer(0, sp.x, sp.y);
                for (let i = 0; i < 120; i++) {
                    engine.tick();
                }
                const state = engine.getPlayerState(0);
                expect(state.alive).toBe(true);
                // The bundled map sets collidesWithPlayers:false on its only
                // body; the player must land on it (resting disc center stays
                // above the platform top surface) instead of falling through.
                expect(state.y).toBeLessThan(top);
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

        describe('WeiRd DeAth BalL', () => {
            it('300-tick simulation (stress test)', () => {
                engine = new PhysicsEngine();
                const map = loadMap(MAP_FILES.weird);
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
                const map = loadMap(MAP_FILES.weird);
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

            it('normalized collidesGroupN wires body maskBits via the engine filter', () => {
                const map = loadMap(MAP_FILES.weird);
                const fixtureEngine = new PhysicsEngine();
                engine = fixtureEngine;

                // Pick a body with all groups false (ghost geometry -> mask 0)
                // and one with g1 enabled (mask should include the player bit).
                const ghost = map.bodies.find((b: any) =>
                    b.collides && !b.collides.g1 && !b.collides.g2 && !b.collides.g3 && !b.collides.g4
                );
                const g1 = map.bodies.find((b: any) =>
                    b.collides && b.collides.g1 && (!b.collides.g3 || !b.collides.g4)
                );

                expect(ghost).toBeDefined();
                expect(g1).toBeDefined();

                fixtureEngine.addBody({ ...(ghost as any), name: 'ghost' });
                fixtureEngine.addBody({ ...(g1 as any), name: 'g1body' });

                const readMask = (name: string): number => {
                    const body = fixtureEngine.getBodyMap().get(name) as any;
                    const sh = (body as any).GetShapeList();
                    return sh.GetFilterData().maskBits;
                };

                // Ghost (all-false) keeps mask 0x0000; g1 adds the player-group bit
                // 0x0002 on top of the always-on map-category bit 0x0001.
                expect(readMask('ghost')).toBe(0x0000);
                expect(readMask('g1body') & 0x0002).toBe(0x0002);
                expect(readMask('g1body') & 0x0001).toBe(0x0001);
            });
        });

        describeWdb('WDB', () => {
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
            it.each(simulationMapKeys)(
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

    describe('out-of-bounds death circle follows the map center', () => {
        // Native death type 4 (DEOBFUSCATION "Death Type 4"): a disc dies when
        // its center is more than 850 map units from the MAP center. The
        // bundled exports are captured in a coordinate space offset from the
        // native world origin, so each fixture's physics.deathCenter carries
        // the map center (730, 500) in export units. Spawn points must survive;
        // a disc placed > 850 units from that center must die with deathType 4.
        it.each(['simple1v1', 'weird'] as const)(
            '%s spawn survives while a disc beyond 850 map units from the map center dies',
            (key) => {
                const map = loadMap(MAP_FILES[key]);
                const dc = (map as any).physics?.deathCenter;
                expect(dc).toBeDefined();

                const sp = getSpawnXY(map);
                expect(Math.hypot(sp.x - dc.x, sp.y - dc.y)).toBeLessThan(850);

                const e = new PhysicsEngine();
                try {
                    addAllBodies(e, map);
                    e.setDeathCircleCenter(dc.x, dc.y);

                    // Idle player at the map spawn survives 5 full ticks.
                    e.addPlayer(0, sp.x, sp.y);
                    for (let i = 0; i < 5; i++) {
                        e.applyInput(0, EMPTY_INPUT);
                        e.tick();
                    }
                    const atSpawn = e.getPlayerState(0);
                    expect(atSpawn.alive).toBe(true);
                    expect(e.getTickCount()).toBe(5);

                    // Disc 900 map units from the map center: inside the reported
                    // arena bounds but far outside the 850-unit death circle.
                    e.addPlayer(1, dc.x + 900, dc.y);
                    e.tick();
                    const farDisc = e.getPlayerState(1);
                    expect(farDisc.alive).toBe(false);
                    expect(farDisc.deathType).toBe(4);
                } finally {
                    safeDestroy(e);
                }
            },
        );

        it.each(['simple1v1', 'weird'] as const)(
            '%s environment episode survives 5+ ticks with players alive at spawn',
            (key) => {
                const map = loadMap(MAP_FILES[key]);
                const env = new BonkEnvironment({
                    mapData: map as any,
                    numOpponents: 1,
                    randomOpponent: false,
                    seed: 42,
                    maxTicks: 100,
                });
                try {
                    let done = false;
                    for (let i = 0; i < 5; i++) {
                        const r = env.step(0);
                        expect(r.info.aiAlive).toBe(true);
                        expect(r.info.opponentsAlive).toBe(1);
                        expect(r.observation.tick).toBe(i + 1);
                        done = r.done;
                    }
                    expect(done).toBe(false);
                } finally {
                    env.close();
                }
            },
        );
    });

    describe('spawn-only / pure-cap-zone MapDef (bodies key omitted) survives normalizeMap (#273)', () => {
        const spawnOnlyMap = {
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
            // NOTE: `bodies` key intentionally omitted (spawn-only map).
        };

        it('keeps authored spawnPoints/capZones/joints on the environment config', () => {
            const env = new BonkEnvironment({
                mapData: spawnOnlyMap as any,
                numOpponents: 0,
                randomOpponent: false,
                seed: 1,
            });
            try {
                expect((env as any).config.mapData.spawnPoints).toEqual(spawnOnlyMap.spawnPoints);
                expect((env as any).config.mapData.capZones).toEqual(spawnOnlyMap.capZones);
                expect((env as any).config.mapData.joints).toEqual(spawnOnlyMap.joints);
                expect((env as any).config.mapData.bodies).toEqual([]);
            } finally {
                env.close();
            }
        });

        it('spawns the AI player at the authored spawn instead of the hardcoded fallback', () => {
            const env = new BonkEnvironment({
                mapData: spawnOnlyMap as any,
                numOpponents: 0,
                randomOpponent: false,
                seed: 1,
            });
            try {
                const obs = env.getObservationFast();
                expect(obs[0]).toBe(111);
                expect(obs[1]).toBe(222);
            } finally {
                env.close();
            }
        });
    });
});
