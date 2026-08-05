/**
 * config-loader-physics-surfaces.test.ts — Issue #217 regression coverage for
 * the documented physics/arena/player configuration surfaces.
 *
 * The config-loader now resolves the documented env vars and CLI flags for the
 * physics.*, arena.* and player.* sections, so a value set in config.json, via
 * GRAVITY_Y / PLAYER_MOVE_FORCE / ... or via --gravity-y / --player-move-force
 * actually lands in AppConfig (and therefore reaches the engine — see
 * tests/integration/physics-config-consumed.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resetConfig, mergeEngineSections } from '../../src/config/config-loader';

describe('config-loader physics/arena/player surfaces (#217)', () => {
    const testDir = path.join(__dirname, '..', 'fixtures', 'config-loader-physics-' + process.pid);
    const configPath = path.join(testDir, 'config.json');
    const envKeys = [
        'TICKS_PER_SECOND', 'SOLVER_ITERATIONS', 'PHYSICS_SCALE',
        'GRAVITY_X', 'GRAVITY_Y', 'ENABLE_SLEEPING', 'WORLD_AABB_EXTENT',
        'ARENA_HALF_WIDTH', 'ARENA_HALF_HEIGHT', 'ARENA_BOUNDS_MARGIN',
        'PLAYER_MOVE_FORCE', 'PLAYER_HEAVY_MASS_MULTIPLIER',
    ];
    let savedEnv: Record<string, string | undefined>;
    let savedArgv: string[];

    beforeEach(() => {
        savedEnv = {};
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete (process.env as any)[key];
        }
        savedArgv = [...process.argv];
        process.argv = ['node', 'script.js'];
        resetConfig();
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
    });

    afterEach(() => {
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) {
                delete (process.env as any)[key];
            } else {
                process.env[key] = savedEnv[key]!;
            }
        }
        process.argv = savedArgv;
        resetConfig();
        // Remove the per-run fixture directory so no untracked dirs leak.
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('environment variable overrides', () => {
        it('TICKS_PER_SECOND overrides physics.ticksPerSecond', () => {
            process.env.TICKS_PER_SECOND = '60';
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(60);
        });

        it('TICKS_PER_SECOND rejects values outside [1,240]', () => {
            process.env.TICKS_PER_SECOND = '0';
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(30);

            resetConfig();
            process.env.TICKS_PER_SECOND = '301';
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(30);

            resetConfig();
            process.env.TICKS_PER_SECOND = 'abc';
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(30);
        });

        it('SOLVER_ITERATIONS overrides physics.solverIterations', () => {
            process.env.SOLVER_ITERATIONS = '12';
            expect(loadConfig(testDir).physics.solverIterations).toBe(12);
        });

        it('PHYSICS_SCALE overrides physics.scale', () => {
            process.env.PHYSICS_SCALE = '45';
            expect(loadConfig(testDir).physics.scale).toBe(45);
        });

        it('PHYSICS_SCALE rejects non-positive values', () => {
            process.env.PHYSICS_SCALE = '0';
            expect(loadConfig(testDir).physics.scale).toBe(30);
        });

        it('GRAVITY_X and GRAVITY_Y override physics gravity', () => {
            process.env.GRAVITY_X = '3';
            process.env.GRAVITY_Y = '12';
            const cfg = loadConfig(testDir);
            expect(cfg.physics.gravityX).toBe(3);
            expect(cfg.physics.gravityY).toBe(12);
        });

        it('GRAVITY_Y accepts negative values (upward gravity)', () => {
            process.env.GRAVITY_Y = '-5';
            expect(loadConfig(testDir).physics.gravityY).toBe(-5);
        });

        it('invalid GRAVITY_Y is ignored', () => {
            process.env.GRAVITY_Y = 'abc';
            expect(loadConfig(testDir).physics.gravityY).toBe(20);
        });

        it('ENABLE_SLEEPING=false disables sleeping', () => {
            process.env.ENABLE_SLEEPING = 'false';
            expect(loadConfig(testDir).physics.enableSleeping).toBe(false);
        });

        it('ENABLE_SLEEPING=0 disables sleeping', () => {
            process.env.ENABLE_SLEEPING = '0';
            expect(loadConfig(testDir).physics.enableSleeping).toBe(false);
        });

        it('ENABLE_SLEEPING=true keeps sleeping enabled', () => {
            process.env.ENABLE_SLEEPING = 'true';
            expect(loadConfig(testDir).physics.enableSleeping).toBe(true);
        });

        it('WORLD_AABB_EXTENT overrides physics.worldAabbExtent', () => {
            process.env.WORLD_AABB_EXTENT = '2000';
            expect(loadConfig(testDir).physics.worldAabbExtent).toBe(2000);
        });

        it('WORLD_AABB_EXTENT rejects values below the documented 100 minimum', () => {
            process.env.WORLD_AABB_EXTENT = '10';
            expect(loadConfig(testDir).physics.worldAabbExtent).toBe(1000);
        });

        it('ARENA_HALF_WIDTH and ARENA_HALF_HEIGHT override arena defaults', () => {
            process.env.ARENA_HALF_WIDTH = '40';
            process.env.ARENA_HALF_HEIGHT = '32';
            const cfg = loadConfig(testDir);
            expect(cfg.arena.defaultHalfWidth).toBe(40);
            expect(cfg.arena.defaultHalfHeight).toBe(32);
        });

        it('ARENA_BOUNDS_MARGIN overrides arena.boundsMargin', () => {
            process.env.ARENA_BOUNDS_MARGIN = '2';
            expect(loadConfig(testDir).arena.boundsMargin).toBe(2);
        });

        it('ARENA_BOUNDS_MARGIN accepts zero', () => {
            process.env.ARENA_BOUNDS_MARGIN = '0';
            expect(loadConfig(testDir).arena.boundsMargin).toBe(0);
        });

        it('PLAYER_MOVE_FORCE overrides player.moveForce', () => {
            process.env.PLAYER_MOVE_FORCE = '45';
            expect(loadConfig(testDir).player.moveForce).toBe(45);
        });

        it('PLAYER_HEAVY_MASS_MULTIPLIER overrides player.heavyMassMultiplier', () => {
            process.env.PLAYER_HEAVY_MASS_MULTIPLIER = '0.5';
            expect(loadConfig(testDir).player.heavyMassMultiplier).toBe(0.5);
        });

        it('non-finite values (Infinity, 1e999) are rejected', () => {
            process.env.GRAVITY_Y = 'Infinity';
            expect(loadConfig(testDir).physics.gravityY).toBe(20);

            resetConfig();
            process.env.PHYSICS_SCALE = '1e999';
            expect(loadConfig(testDir).physics.scale).toBe(30);

            resetConfig();
            process.env.WORLD_AABB_EXTENT = 'Infinity';
            expect(loadConfig(testDir).physics.worldAabbExtent).toBe(1000);

            resetConfig();
            process.env.PLAYER_MOVE_FORCE = 'Infinity';
            expect(loadConfig(testDir).player.moveForce).toBe(30);

            resetConfig();
            process.env.ARENA_HALF_WIDTH = 'Infinity';
            expect(loadConfig(testDir).arena.defaultHalfWidth).toBe(25);
        });

        it('ENABLE_SLEEPING only accepts the explicit boolean tokens', () => {
            process.env.ENABLE_SLEEPING = 'maybe';
            expect(loadConfig(testDir).physics.enableSleeping).toBe(true);

            resetConfig();
            process.env.ENABLE_SLEEPING = '';
            expect(loadConfig(testDir).physics.enableSleeping).toBe(true);
        });
    });

    describe('CLI flag overrides', () => {
        it('--ticks-per-second sets ticksPerSecond', () => {
            process.argv = ['node', 'script.js', '--ticks-per-second', '60'];
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(60);
        });

        it('--solver-iterations sets solverIterations', () => {
            process.argv = ['node', 'script.js', '--solver-iterations', '12'];
            expect(loadConfig(testDir).physics.solverIterations).toBe(12);
        });

        it('--scale sets physics.scale', () => {
            process.argv = ['node', 'script.js', '--scale', '45'];
            expect(loadConfig(testDir).physics.scale).toBe(45);
        });

        it('--gravity-x and --gravity-y set gravity components', () => {
            process.argv = ['node', 'script.js', '--gravity-x', '3', '--gravity-y', '12'];
            const cfg = loadConfig(testDir);
            expect(cfg.physics.gravityX).toBe(3);
            expect(cfg.physics.gravityY).toBe(12);
        });

        it('--enable-sleeping enables sleeping', () => {
            process.argv = ['node', 'script.js', '--enable-sleeping'];
            expect(loadConfig(testDir).physics.enableSleeping).toBe(true);
        });

        it('--disable-sleeping disables sleeping', () => {
            process.argv = ['node', 'script.js', '--disable-sleeping'];
            expect(loadConfig(testDir).physics.enableSleeping).toBe(false);
        });

        it('--world-aabb-extent sets worldAabbExtent', () => {
            process.argv = ['node', 'script.js', '--world-aabb-extent', '2000'];
            expect(loadConfig(testDir).physics.worldAabbExtent).toBe(2000);
        });

        it('--arena-half-width / --arena-half-height set arena defaults', () => {
            process.argv = ['node', 'script.js', '--arena-half-width', '40', '--arena-half-height', '32'];
            const cfg = loadConfig(testDir);
            expect(cfg.arena.defaultHalfWidth).toBe(40);
            expect(cfg.arena.defaultHalfHeight).toBe(32);
        });

        it('--arena-bounds-margin sets boundsMargin', () => {
            process.argv = ['node', 'script.js', '--arena-bounds-margin', '2'];
            expect(loadConfig(testDir).arena.boundsMargin).toBe(2);
        });

        it('--player-move-force sets player.moveForce', () => {
            process.argv = ['node', 'script.js', '--player-move-force', '45'];
            expect(loadConfig(testDir).player.moveForce).toBe(45);
        });

        it('--player-heavy-mass-multiplier sets player.heavyMassMultiplier', () => {
            process.argv = ['node', 'script.js', '--player-heavy-mass-multiplier', '0.5'];
            expect(loadConfig(testDir).player.heavyMassMultiplier).toBe(0.5);
        });

        it('missing values are ignored', () => {
            process.argv = ['node', 'script.js', '--ticks-per-second'];
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(30);
        });

        it('invalid values are ignored', () => {
            process.argv = ['node', 'script.js', '--ticks-per-second', '0', '--player-move-force', '0'];
            expect(loadConfig(testDir).physics.ticksPerSecond).toBe(30);
            expect(loadConfig(testDir).player.moveForce).toBe(30);
        });

        it('non-finite CLI values are ignored', () => {
            process.argv = ['node', 'script.js', '--scale', 'Infinity', '--gravity-y', '1e999'];
            const cfg = loadConfig(testDir);
            expect(cfg.physics.scale).toBe(30);
            expect(cfg.physics.gravityY).toBe(20);
        });
    });

    describe('priority order', () => {
        it('config.json physics < env vars < CLI flags', () => {
            fs.writeFileSync(configPath, JSON.stringify({ physics: { gravityY: 8 } }));
            process.env.GRAVITY_Y = '9';
            const cfg = loadConfig(testDir);
            expect(cfg.physics.gravityY).toBe(9);

            resetConfig();
            process.argv = ['node', 'script.js', '--gravity-y', '10'];
            expect(loadConfig(testDir).physics.gravityY).toBe(10);
        });
    });

    describe('mergeEngineSections', () => {
        it('resolves overrides over the resolved config defaults', () => {
            process.env.GRAVITY_Y = '11';
            process.env.PLAYER_MOVE_FORCE = '55';
            const sections = mergeEngineSections({ arena: { boundsMargin: 1 } });
            expect(sections.physics.gravityY).toBe(11);
            expect(sections.physics.ticksPerSecond).toBe(30); // untouched default
            expect(sections.arena.boundsMargin).toBe(1);
            expect(sections.arena.defaultHalfWidth).toBe(25); // untouched default
            expect(sections.player.moveForce).toBe(55);
        });

        it('ignores non-plain-object override sections', () => {
            const sections = mergeEngineSections({ physics: null, arena: 'junk', player: 42 });
            expect(sections.physics.gravityY).toBe(20);
            expect(sections.arena.boundsMargin).toBe(5);
            expect(sections.player.moveForce).toBe(30);
        });

        it('resolves snake_case sub-keys (the documented Python-client spelling)', () => {
            const sections = mergeEngineSections({
                physics: { gravity_y: 5, ticks_per_second: 60, solver_iterations: 10 },
                arena: { default_half_width: 40, bounds_margin: 1 },
                player: { move_force: 45, heavy_mass_multiplier: 0.5 },
            });
            expect(sections.physics.gravityY).toBe(5);
            expect(sections.physics.ticksPerSecond).toBe(60);
            expect(sections.physics.solverIterations).toBe(10);
            expect(sections.physics.gravityX).toBe(0); // untouched default
            expect(sections.arena.defaultHalfWidth).toBe(40);
            expect(sections.arena.defaultHalfHeight).toBe(20);
            expect(sections.arena.boundsMargin).toBe(1);
            expect(sections.player.moveForce).toBe(45);
            expect(sections.player.heavyMassMultiplier).toBe(0.5);
        });

        it('an explicit camelCase override wins over the snake_case alias', () => {
            const sections = mergeEngineSections({ physics: { gravity_y: 5, gravityY: 7 } });
            expect(sections.physics.gravityY).toBe(7);
        });
    });
});