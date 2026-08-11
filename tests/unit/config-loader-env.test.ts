import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, resetConfig, getConfig, getSection, getDefaults, resolveEnvironmentConfig } from '../../src/config/config-loader';

describe('config-loader env vars and CLI', () => {
    const testDir = path.join(__dirname, '..', 'fixtures', 'config-env-test-' + process.pid);
    const configPath = path.join(testDir, 'config.json');
    const envKeys = [
        'PORT', 'BIND_ADDRESS', 'MAX_RUNTIME', 'NUM_WORKERS', 'SEED',
        'DEFAULT_MAP_PATH', 'USE_SHARED_MEMORY', 'MANIFOLD_TELEMETRY',
        'MANIFOLD_TELEMETRY_OUTPUT', 'MANIFOLD_PROFILE', 'MANIFOLD_DEBUG',
        'DASHBOARD_PORT', 'REPORT_INTERVAL_MS', 'TEST_MODE', 'AI_PLAYER_ID',
        'RANDOM_OPP_MOVE_PROB', 'RANDOM_OPP_UP_PROB', 'RANDOM_OPP_DOWN_PROB',
        'RANDOM_OPP_HEAVY_PROB', 'RANDOM_OPP_GRAPPLE_PROB',
        'KILL_REWARD', 'DEATH_PENALTY', 'TIME_PENALTY',
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
        if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
    });

    // ─── Environment Variable Overrides ──────────────────────────────────

    describe('environment variable overrides', () => {
        it('PORT overrides default port', () => {
            process.env.PORT = '8080';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(8080);
        });

        it('BIND_ADDRESS overrides default bind address', () => {
            process.env.BIND_ADDRESS = '0.0.0.0';
            const cfg = loadConfig(testDir);
            expect(cfg.server.bindAddress).toBe('0.0.0.0');
        });

        it('MAX_RUNTIME overrides default max runtime', () => {
            process.env.MAX_RUNTIME = '120';
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(120);
        });

        it('MAX_RUNTIME accepts zero', () => {
            process.env.MAX_RUNTIME = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('NUM_WORKERS overrides default num workers', () => {
            process.env.NUM_WORKERS = '4';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(4);
        });

        it('SEED overrides default seed', () => {
            process.env.SEED = '42';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(42);
        });

        it('DEFAULT_MAP_PATH overrides default map path', () => {
            process.env.DEFAULT_MAP_PATH = 'maps/custom_map.json';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.defaultMapPath).toBe('maps/custom_map.json');
        });

        it('AI_PLAYER_ID overrides the default AI player slot', () => {
            process.env.AI_PLAYER_ID = '3';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(3);
        });

        it('invalid AI_PLAYER_ID (negative) is ignored', () => {
            process.env.AI_PLAYER_ID = '-1';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(0);
        });

        it('invalid AI_PLAYER_ID (non-numeric) is ignored', () => {
            process.env.AI_PLAYER_ID = 'abc';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(0);
        });

        it('invalid AI_PLAYER_ID (out of the 0-7 player-slot range) is ignored', () => {
            process.env.AI_PLAYER_ID = '9';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(0);
        });

        it('RANDOM_OPP_MOVE_PROB overrides the opponent move probability', () => {
            process.env.RANDOM_OPP_MOVE_PROB = '0.9';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.randomOppMoveProb).toBe(0.9);
        });

        it('all five RANDOM_OPP_*_PROB env vars override their probabilities', () => {
            process.env.RANDOM_OPP_MOVE_PROB = '0.91';
            process.env.RANDOM_OPP_UP_PROB = '0.82';
            process.env.RANDOM_OPP_DOWN_PROB = '0.73';
            process.env.RANDOM_OPP_HEAVY_PROB = '0.64';
            process.env.RANDOM_OPP_GRAPPLE_PROB = '0.55';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.randomOppMoveProb).toBe(0.91);
            expect(cfg.environment.randomOppUpProb).toBe(0.82);
            expect(cfg.environment.randomOppDownProb).toBe(0.73);
            expect(cfg.environment.randomOppHeavyProb).toBe(0.64);
            expect(cfg.environment.randomOppGrappleProb).toBe(0.55);
        });

        it('RANDOM_OPP_MOVE_PROB rejects values outside [0,1]', () => {
            process.env.RANDOM_OPP_MOVE_PROB = '1.5';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.randomOppMoveProb).toBe(0.2);

            delete process.env.RANDOM_OPP_MOVE_PROB;
            process.env.RANDOM_OPP_MOVE_PROB = '-0.1';
            resetConfig();
            expect(loadConfig(testDir).environment.randomOppMoveProb).toBe(0.2);

            delete process.env.RANDOM_OPP_MOVE_PROB;
            process.env.RANDOM_OPP_MOVE_PROB = 'abc';
            resetConfig();
            expect(loadConfig(testDir).environment.randomOppMoveProb).toBe(0.2);
        });

        it('KILL_REWARD/DEATH_PENALTY/TIME_PENALTY override the reward defaults', () => {
            process.env.KILL_REWARD = '10';
            process.env.DEATH_PENALTY = '-5';
            process.env.TIME_PENALTY = '-0.5';
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(10);
            expect(cfg.reward.deathPenalty).toBe(-5);
            expect(cfg.reward.timePenalty).toBe(-0.5);
        });

        it('reward env vars only override the keys that are provided', () => {
            process.env.KILL_REWARD = '10';
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(10);
            expect(cfg.reward.deathPenalty).toBe(-1.0);
            expect(cfg.reward.timePenalty).toBe(-0.001);
        });

        it('non-numeric reward env vars are ignored', () => {
            process.env.KILL_REWARD = 'abc';
            process.env.TIME_PENALTY = '';
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(1.0);
            expect(cfg.reward.timePenalty).toBe(-0.001);
        });

        it('reward env vars reject non-finite and partially-parsed values', () => {
            process.env.KILL_REWARD = '1e999';
            loadConfig(testDir);
            expect(getConfig().reward.killReward).toBe(1.0);

            resetConfig();
            process.env.KILL_REWARD = 'Infinity';
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.env.KILL_REWARD = '10abc';
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.env.DEATH_PENALTY = '   ';
            expect(loadConfig(testDir).reward.deathPenalty).toBe(-1.0);
        });

        it('reward env vars reject non-decimal JS numeric literals', () => {
            for (const bad of ['0x10', '0b101', '0o17', '0x1F']) {
                resetConfig();
                process.env.KILL_REWARD = bad;
                expect(loadConfig(testDir).reward.killReward).toBe(1.0);
            }

            resetConfig();
            process.env.TIME_PENALTY = '0x10';
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);
        });

        it('reward env vars accept full decimal and scientific notation', () => {
            resetConfig();
            process.env.KILL_REWARD = '2';
            expect(loadConfig(testDir).reward.killReward).toBe(2.0);

            resetConfig();
            process.env.KILL_REWARD = '.5';
            expect(loadConfig(testDir).reward.killReward).toBe(0.5);

            resetConfig();
            process.env.KILL_REWARD = '1e2';
            expect(loadConfig(testDir).reward.killReward).toBe(100.0);
        });

        it('reward penalty env vars reject positive (reward-inverting) values', () => {
            process.env.DEATH_PENALTY = '5';
            const cfg = loadConfig(testDir);
            expect(cfg.reward.deathPenalty).toBe(-1.0);

            resetConfig();
            process.env.TIME_PENALTY = '0.5';
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);

            resetConfig();
            process.env.DEATH_PENALTY = '0';
            expect(loadConfig(testDir).reward.deathPenalty).toBe(0);
        });

        it('USE_SHARED_MEMORY=true sets useSharedMemory to true', () => {
            process.env.USE_SHARED_MEMORY = 'true';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(true);
        });

        it('USE_SHARED_MEMORY=false sets useSharedMemory to false', () => {
            process.env.USE_SHARED_MEMORY = 'false';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(false);
        });

        it('USE_SHARED_MEMORY=0 sets useSharedMemory to false', () => {
            process.env.USE_SHARED_MEMORY = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(false);
        });

        it('USE_SHARED_MEMORY=no sets useSharedMemory to false', () => {
            process.env.USE_SHARED_MEMORY = 'no';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(false);
        });

        it('USE_SHARED_MEMORY=yes sets useSharedMemory to true', () => {
            process.env.USE_SHARED_MEMORY = 'yes';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(true);
        });

        it('MANIFOLD_TELEMETRY=true enables telemetry', () => {
            process.env.MANIFOLD_TELEMETRY = 'true';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('MANIFOLD_TELEMETRY=1 enables telemetry', () => {
            process.env.MANIFOLD_TELEMETRY = '1';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('MANIFOLD_TELEMETRY=yes enables telemetry', () => {
            process.env.MANIFOLD_TELEMETRY = 'yes';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('MANIFOLD_TELEMETRY=false disables telemetry', () => {
            process.env.MANIFOLD_TELEMETRY = 'false';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(false);
        });

        it('invalid MANIFOLD_TELEMETRY does not override config.json', () => {
            fs.writeFileSync(configPath, JSON.stringify({ telemetry: { enabled: true } }));
            process.env.MANIFOLD_TELEMETRY = 'maybe';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('MANIFOLD_TELEMETRY_OUTPUT sets output format', () => {
            process.env.MANIFOLD_TELEMETRY_OUTPUT = 'file';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('file');
        });

        it('MANIFOLD_TELEMETRY_OUTPUT rejects invalid value', () => {
            process.env.MANIFOLD_TELEMETRY_OUTPUT = 'xml';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('console');
        });

        it('MANIFOLD_PROFILE sets profile level', () => {
            process.env.MANIFOLD_PROFILE = 'detailed';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('detailed');
        });

        it('MANIFOLD_PROFILE rejects invalid value', () => {
            process.env.MANIFOLD_PROFILE = 'extreme';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('standard');
        });

        it('MANIFOLD_DEBUG sets debug level', () => {
            process.env.MANIFOLD_DEBUG = 'verbose';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('verbose');
        });

        it('MANIFOLD_DEBUG rejects invalid value', () => {
            process.env.MANIFOLD_DEBUG = 'trace';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('none');
        });

        it('DASHBOARD_PORT overrides the dashboard port', () => {
            process.env.DASHBOARD_PORT = '8081';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(8081);
        });

        it('DASHBOARD_PORT rejects invalid values', () => {
            process.env.DASHBOARD_PORT = '70000';
            expect(loadConfig(testDir).telemetry.dashboardPort).toBe(3001);
            resetConfig();
            process.env.DASHBOARD_PORT = 'abc';
            expect(loadConfig(testDir).telemetry.dashboardPort).toBe(3001);
        });

        it('REPORT_INTERVAL_MS overrides the report interval', () => {
            process.env.REPORT_INTERVAL_MS = '750';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.reportIntervalMs).toBe(750);
        });

        it('REPORT_INTERVAL_MS rejects invalid values', () => {
            process.env.REPORT_INTERVAL_MS = '0';
            expect(loadConfig(testDir).telemetry.reportIntervalMs).toBe(5000);
            resetConfig();
            process.env.REPORT_INTERVAL_MS = 'abc';
            expect(loadConfig(testDir).telemetry.reportIntervalMs).toBe(5000);
        });

        it('TEST_MODE=1 caps maxRuntimeSeconds to 2', () => {
            process.env.TEST_MODE = '1';
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBeLessThanOrEqual(2);
            expect(cfg.logging.level).toBe('warn');
        });

        it('TEST_MODE=0 does not trigger test mode', () => {
            process.env.TEST_MODE = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.logging.level).toBe('info');
        });

        it('invalid PORT (non-numeric) is ignored', () => {
            process.env.PORT = 'abc';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('invalid PORT (zero) is ignored', () => {
            process.env.PORT = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('invalid PORT (negative) is ignored', () => {
            process.env.PORT = '-1';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('invalid PORT (too high) is ignored', () => {
            process.env.PORT = '70000';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('invalid NUM_WORKERS (negative) is ignored', () => {
            process.env.NUM_WORKERS = '-1';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThan(0);
        });

        it('invalid NUM_WORKERS (non-numeric) is ignored', () => {
            process.env.NUM_WORKERS = 'abc';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThan(0);
        });

        it('invalid SEED (negative) is ignored', () => {
            process.env.SEED = '-5';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('invalid SEED (non-numeric) is ignored', () => {
            process.env.SEED = 'abc';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('multiple env vars can be set simultaneously', () => {
            process.env.PORT = '9090';
            process.env.BIND_ADDRESS = '0.0.0.0';
            process.env.NUM_WORKERS = '2';
            process.env.SEED = '123';
            process.env.MANIFOLD_TELEMETRY = 'true';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(9090);
            expect(cfg.server.bindAddress).toBe('0.0.0.0');
            expect(cfg.workerPool.numWorkers).toBe(2);
            expect(cfg.environment.seed).toBe(123);
            expect(cfg.telemetry.enabled).toBe(true);
        });
    });

    // ─── CLI Flag Overrides ──────────────────────────────────────────────

    describe('CLI flag overrides', () => {
        it('--port sets server port', () => {
            process.argv = ['node', 'script.js', '--port', '3000'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(3000);
        });

        it('-p sets server port (short form)', () => {
            process.argv = ['node', 'script.js', '-p', '3000'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(3000);
        });

        it('--bind-address sets server bind address', () => {
            process.argv = ['node', 'script.js', '--bind-address', '0.0.0.0'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.bindAddress).toBe('0.0.0.0');
        });

        it('missing value for --bind-address is ignored', () => {
            process.argv = ['node', 'script.js', '--bind-address'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.bindAddress).toBe('127.0.0.1');
        });

        it('CLI --bind-address overrides env BIND_ADDRESS', () => {
            process.env.BIND_ADDRESS = '10.0.0.1';
            process.argv = ['node', 'script.js', '--bind-address', '0.0.0.0'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.bindAddress).toBe('0.0.0.0');
        });

        it('--max-runtime sets max runtime', () => {
            process.argv = ['node', 'script.js', '--max-runtime', '60'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(60);
        });

        it('--telemetry enables telemetry', () => {
            process.argv = ['node', 'script.js', '--telemetry'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('-t enables telemetry (short form)', () => {
            process.argv = ['node', 'script.js', '-t'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('--profile sets profile level and enables telemetry', () => {
            process.argv = ['node', 'script.js', '--profile', 'detailed'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('detailed');
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('--profile-level sets profile level and enables telemetry', () => {
            process.argv = ['node', 'script.js', '--profile-level', 'detailed'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('detailed');
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('-l sets profile level (short form)', () => {
            process.argv = ['node', 'script.js', '-l', 'minimal'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('minimal');
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('--profile rejects invalid value', () => {
            process.argv = ['node', 'script.js', '--profile', 'extreme'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('standard');
            expect(cfg.telemetry.enabled).toBe(false);
        });

        it('--debug sets debug level', () => {
            process.argv = ['node', 'script.js', '--debug', 'verbose'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('verbose');
        });

        it('-d sets debug level (short form)', () => {
            process.argv = ['node', 'script.js', '-d', 'error'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('error');
        });

        it('--debug rejects invalid value', () => {
            process.argv = ['node', 'script.js', '--debug', 'trace'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('none');
        });

        it('--output sets output format', () => {
            process.argv = ['node', 'script.js', '--output', 'both'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('both');
        });

        it('-o sets output format (short form)', () => {
            process.argv = ['node', 'script.js', '-o', 'file'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('file');
        });

        it('--output rejects invalid value', () => {
            process.argv = ['node', 'script.js', '--output', 'xml'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('console');
        });

        it('--dashboard-port sets dashboard port', () => {
            process.argv = ['node', 'script.js', '--dashboard-port', '4000'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(4000);
        });

        it('--dashboard-port rejects zero', () => {
            process.argv = ['node', 'script.js', '--dashboard-port', '0'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(3001);
        });

        it('--dashboard-port rejects negative', () => {
            process.argv = ['node', 'script.js', '--dashboard-port', '-1'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(3001);
        });

        it('--report-interval-ms sets the report interval', () => {
            process.argv = ['node', 'script.js', '--report-interval-ms', '250'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.reportIntervalMs).toBe(250);
        });

        it('--report-interval-ms rejects zero and missing values', () => {
            process.argv = ['node', 'script.js', '--report-interval-ms', '0'];
            expect(loadConfig(testDir).telemetry.reportIntervalMs).toBe(5000);
            resetConfig();
            process.argv = ['node', 'script.js', '--report-interval-ms'];
            expect(loadConfig(testDir).telemetry.reportIntervalMs).toBe(5000);
        });

        it('--workers sets num workers', () => {
            process.argv = ['node', 'script.js', '--workers', '4'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(4);
        });

        it('-w sets num workers (short form)', () => {
            process.argv = ['node', 'script.js', '-w', '2'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(2);
        });

        it('--workers rejects negative value', () => {
            process.argv = ['node', 'script.js', '--workers', '-1'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThan(0);
        });

        it('--no-shared-mem disables shared memory', () => {
            process.argv = ['node', 'script.js', '--no-shared-mem'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.useSharedMemory).toBe(false);
        });

        it('--seed sets environment seed', () => {
            process.argv = ['node', 'script.js', '--seed', '99'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(99);
        });

        it('-s sets environment seed (short form)', () => {
            process.argv = ['node', 'script.js', '-s', '77'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(77);
        });

        it('--seed rejects negative value', () => {
            process.argv = ['node', 'script.js', '--seed', '-1'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('--map sets default map path', () => {
            process.argv = ['node', 'script.js', '--map', 'maps/test.json'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.defaultMapPath).toBe('maps/test.json');
        });

        it('--random-opp-move-prob sets the opponent move probability', () => {
            process.argv = ['node', 'script.js', '--random-opp-move-prob', '0.9'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.randomOppMoveProb).toBe(0.9);
        });

        it('all five --random-opp-*-prob CLI flags set their probabilities', () => {
            process.argv = [
                'node', 'script.js',
                '--random-opp-move-prob', '0.91',
                '--random-opp-up-prob', '0.82',
                '--random-opp-down-prob', '0.73',
                '--random-opp-heavy-prob', '0.64',
                '--random-opp-grapple-prob', '0.55',
            ];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.randomOppMoveProb).toBe(0.91);
            expect(cfg.environment.randomOppUpProb).toBe(0.82);
            expect(cfg.environment.randomOppDownProb).toBe(0.73);
            expect(cfg.environment.randomOppHeavyProb).toBe(0.64);
            expect(cfg.environment.randomOppGrappleProb).toBe(0.55);
        });

        it('--random-opp-move-prob rejects values outside [0,1] and missing values', () => {
            process.argv = ['node', 'script.js', '--random-opp-move-prob', '1.5'];
            expect(loadConfig(testDir).environment.randomOppMoveProb).toBe(0.2);

            resetConfig();
            process.argv = ['node', 'script.js', '--random-opp-move-prob', '-0.5'];
            expect(loadConfig(testDir).environment.randomOppMoveProb).toBe(0.2);

            resetConfig();
            process.argv = ['node', 'script.js', '--random-opp-move-prob'];
            expect(loadConfig(testDir).environment.randomOppMoveProb).toBe(0.2);
        });

        it('--kill-reward/--death-penalty/--time-penalty set the reward weights', () => {
            process.argv = [
                'node', 'script.js',
                '--kill-reward', '10',
                '--death-penalty', '-5',
                '--time-penalty', '-0.5',
            ];
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(10);
            expect(cfg.reward.deathPenalty).toBe(-5);
            expect(cfg.reward.timePenalty).toBe(-0.5);
        });

        it('invalid or missing --kill-reward values are ignored', () => {
            process.argv = ['node', 'script.js', '--kill-reward', 'abc'];
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--kill-reward'];
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--time-penalty'];
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);
        });

        it('CLI reward flags override reward env vars', () => {
            process.env.KILL_REWARD = '5';
            process.env.TIME_PENALTY = '-0.05';
            process.argv = ['node', 'script.js', '--kill-reward', '10', '--time-penalty', '-0.5'];
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(10);
            expect(cfg.reward.timePenalty).toBe(-0.5);
        });

        it('CLI reward flags reject non-finite and partially-parsed values', () => {
            process.argv = ['node', 'script.js', '--kill-reward', '1e999'];
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--kill-reward', '10abc'];
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--time-penalty', 'Infinity'];
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);
        });

        it('CLI reward flags reject non-decimal JS numeric literals', () => {
            process.argv = ['node', 'script.js', '--kill-reward', '0x10'];
            expect(loadConfig(testDir).reward.killReward).toBe(1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--time-penalty', '0b101'];
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);
        });

        it('CLI reward flags accept full decimal and scientific notation', () => {
            process.argv = ['node', 'script.js', '--kill-reward', '1e2', '--time-penalty', '-0.5'];
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(100.0);
            expect(cfg.reward.timePenalty).toBe(-0.5);
        });

        it('CLI penalty flags reject positive (reward-inverting) values', () => {
            process.argv = ['node', 'script.js', '--death-penalty', '5'];
            expect(loadConfig(testDir).reward.deathPenalty).toBe(-1.0);

            resetConfig();
            process.argv = ['node', 'script.js', '--time-penalty', '0.5'];
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.001);

            resetConfig();
            process.argv = ['node', 'script.js', '--time-penalty', '-0.5'];
            expect(loadConfig(testDir).reward.timePenalty).toBe(-0.5);
        });

        it('--verbose enables telemetry, sets debug verbose, and logging debug', () => {
            process.argv = ['node', 'script.js', '--verbose'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
            expect(cfg.telemetry.debugLevel).toBe('verbose');
            expect(cfg.logging.level).toBe('debug');
        });

        it('missing value for --port is ignored', () => {
            process.argv = ['node', 'script.js', '--port'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('missing value for --workers is ignored', () => {
            process.argv = ['node', 'script.js', '--workers'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThan(0);
        });

        it('missing value for --seed is ignored', () => {
            process.argv = ['node', 'script.js', '--seed'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('missing value for --map is ignored', () => {
            process.argv = ['node', 'script.js', '--map'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.defaultMapPath).toBe('maps/bonk_WDB__No_Mapshake__716916.json');
        });

        it('--ai-player-id sets the AI player slot', () => {
            process.argv = ['node', 'script.js', '--ai-player-id', '2'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(2);
        });

        it('--ai-player-id rejects negative and out-of-range values', () => {
            process.argv = ['node', 'script.js', '--ai-player-id', '-1'];
            expect(loadConfig(testDir).environment.aiPlayerId).toBe(0);

            resetConfig();
            process.argv = ['node', 'script.js', '--ai-player-id', '8'];
            expect(loadConfig(testDir).environment.aiPlayerId).toBe(0);

            resetConfig();
            process.argv = ['node', 'script.js', '--ai-player-id', 'abc'];
            expect(loadConfig(testDir).environment.aiPlayerId).toBe(0);
        });

        it('missing value for --ai-player-id is ignored', () => {
            process.argv = ['node', 'script.js', '--ai-player-id'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.aiPlayerId).toBe(0);
        });

        it('missing value for --profile is ignored', () => {
            process.argv = ['node', 'script.js', '--profile'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.profileLevel).toBe('standard');
        });

        it('missing value for --debug is ignored', () => {
            process.argv = ['node', 'script.js', '--debug'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.debugLevel).toBe('none');
        });

        it('missing value for --output is ignored', () => {
            process.argv = ['node', 'script.js', '--output'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.outputFormat).toBe('console');
        });

        it('missing value for --dashboard-port is ignored', () => {
            process.argv = ['node', 'script.js', '--dashboard-port'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(3001);
        });

        it('missing value for --max-runtime is ignored', () => {
            process.argv = ['node', 'script.js', '--max-runtime'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('invalid port value via CLI is ignored', () => {
            process.argv = ['node', 'script.js', '--port', 'abc'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('unknown flags are ignored without error', () => {
            process.argv = ['node', 'script.js', '--unknown-flag', 'value'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('multiple CLI flags can be combined', () => {
            process.argv = ['node', 'script.js', '--port', '7070', '-w', '3', '--seed', '42', '-t'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(7070);
            expect(cfg.workerPool.numWorkers).toBe(3);
            expect(cfg.environment.seed).toBe(42);
            expect(cfg.telemetry.enabled).toBe(true);
        });
    });

    // ─── Validation ──────────────────────────────────────────────────────

    describe('validation', () => {
        it('port 1 is accepted', () => {
            process.env.PORT = '1';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(1);
        });

        it('port 65535 is accepted', () => {
            process.env.PORT = '65535';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(65535);
        });

        it('port 0 is rejected', () => {
            process.env.PORT = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('port 65536 is rejected', () => {
            process.env.PORT = '65536';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('CLI port 1 is accepted', () => {
            process.argv = ['node', 'script.js', '--port', '1'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(1);
        });

        it('CLI port 65535 is accepted', () => {
            process.argv = ['node', 'script.js', '--port', '65535'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(65535);
        });

        it('CLI port 0 is rejected', () => {
            process.argv = ['node', 'script.js', '--port', '0'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('CLI max-runtime 0 is rejected', () => {
            process.argv = ['node', 'script.js', '--max-runtime', '0'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('CLI max-runtime negative is rejected', () => {
            process.argv = ['node', 'script.js', '--max-runtime', '-10'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('env MAX_RUNTIME 0 is accepted', () => {
            process.env.MAX_RUNTIME = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('env MAX_RUNTIME negative is rejected', () => {
            process.env.MAX_RUNTIME = '-5';
            const cfg = loadConfig(testDir);
            expect(cfg.server.maxRuntimeSeconds).toBe(0);
        });

        it('numWorkers 0 is accepted via env (resolved to CPU count later)', () => {
            process.env.NUM_WORKERS = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(Math.min(os.cpus().length, 8));
        });

        it('numWorkers negative via env is rejected', () => {
            process.env.NUM_WORKERS = '-1';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(Math.min(os.cpus().length, 8));
        });

        it('seed 0 is accepted', () => {
            process.env.SEED = '0';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('seed negative is rejected', () => {
            process.env.SEED = '-1';
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(0);
        });

        it('dashboard-port 65535 is accepted', () => {
            process.argv = ['node', 'script.js', '--dashboard-port', '65535'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(65535);
        });

        it('dashboard-port 65536 is rejected', () => {
            process.argv = ['node', 'script.js', '--dashboard-port', '65536'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.dashboardPort).toBe(3001);
        });
    });

    // ─── getConfig Cache ─────────────────────────────────────────────────

    describe('getConfig cache', () => {
        it('getConfig returns same reference on repeated calls', () => {
            const cfg1 = loadConfig(testDir);
            const cfg2 = getConfig();
            expect(cfg1).toBe(cfg2);
        });

        it('getConfig without prior loadConfig triggers loadConfig', () => {
            const cfg = getConfig();
            expect(cfg.server.port).toBe(5555);
        });

        it('after resetConfig, getConfig returns a new config', () => {
            const cfg1 = loadConfig(testDir);
            resetConfig();
            const cfg2 = getConfig();
            expect(cfg1).not.toBe(cfg2);
        });
    });

    // ─── getSection ──────────────────────────────────────────────────────

    describe('getSection', () => {
        it('getSection returns server subsection', () => {
            const section = getSection('server');
            expect(section.port).toBe(5555);
            expect(section.bindAddress).toBe('127.0.0.1');
        });

        it('getSection returns physics subsection', () => {
            const section = getSection('physics');
            expect(section.ticksPerSecond).toBe(30);
            expect(section.gravityY).toBe(20.0);
        });

        it('getSection returns telemetry subsection', () => {
            const section = getSection('telemetry');
            expect(section.enabled).toBe(false);
            expect(section.profileLevel).toBe('standard');
        });

        it('getSection returns workerPool subsection', () => {
            const section = getSection('workerPool');
            expect(section.maxWorkers).toBe(8);
            expect(section.useSharedMemory).toBe(true);
        });

        it('getSection returns environment subsection', () => {
            const section = getSection('environment');
            expect(section.numOpponents).toBe(1);
            expect(section.seed).toBe(0);
        });

        it('getSection returns reward subsection', () => {
            const section = getSection('reward');
            expect(section.killReward).toBe(1.0);
            expect(section.deathPenalty).toBe(-1.0);
            expect(section.timePenalty).toBe(-0.001);
        });

        it('getSection reflects env overrides', () => {
            process.env.PORT = '9999';
            const section = getSection('server');
            expect(section.port).toBe(9999);
        });
    });

    // ─── Deep Merge ──────────────────────────────────────────────────────

    describe('deep merge', () => {
        it('partial config.json merges at top level', () => {
            resetConfig();
            fs.writeFileSync(configPath, JSON.stringify({ server: { port: 7777 } }));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(7777);
            expect(cfg.server.bindAddress).toBe('127.0.0.1');
            expect(cfg.physics.ticksPerSecond).toBe(30);
        });

        it('partial config.json merges at nested level', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                physics: { gravityY: 20.0 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.physics.gravityY).toBe(20.0);
            expect(cfg.physics.ticksPerSecond).toBe(30);
            expect(cfg.physics.enableSleeping).toBe(true);
        });

        it('deep merge at multiple nesting levels', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                server: { port: 8888 },
                physics: { gravityY: 15.0, solverIterations: 10 },
                telemetry: { enabled: true, profileLevel: 'detailed' },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(8888);
            expect(cfg.server.bindAddress).toBe('127.0.0.1');
            expect(cfg.physics.gravityY).toBe(15.0);
            expect(cfg.physics.solverIterations).toBe(10);
            expect(cfg.physics.ticksPerSecond).toBe(30);
            expect(cfg.telemetry.enabled).toBe(true);
            expect(cfg.telemetry.profileLevel).toBe('detailed');
            expect(cfg.telemetry.debugLevel).toBe('none');
        });

        it('config.json snake_case frame_skip resolves into the injected frameSkip slot', () => {
            fs.writeFileSync(configPath, JSON.stringify({ environment: { frame_skip: 4 } }));
            const cfg = loadConfig(testDir);
            expect((cfg.environment as any).frameSkip).toBe(4);
            expect((cfg.environment as any).frame_skip).toBe(4);
            expect(cfg.environment.numOpponents).toBe(1);
            expect(cfg.environment.maxTicks).toBe(900);
        });

        it('config.json snake_case num_opponents/max_ticks/random_opponent resolve into their slots', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                environment: { num_opponents: 0, max_ticks: 5, random_opponent: false },
            }));
            const cfg = loadConfig(testDir);
            expect((cfg.environment as any).numOpponents).toBe(0);
            expect((cfg.environment as any).num_opponents).toBe(0);
            expect((cfg.environment as any).maxTicks).toBe(5);
            expect((cfg.environment as any).max_ticks).toBe(5);
            expect((cfg.environment as any).randomOpponent).toBe(false);
            expect((cfg.environment as any).random_opponent).toBe(false);
        });

        it('config.json explicit camelCase keys are kept alongside snake_case aliases', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                environment: { frameSkip: 2, frame_skip: 4 },
            }));
            const cfg = loadConfig(testDir);
            expect((cfg.environment as any).frameSkip).toBe(2);
            expect((cfg.environment as any).frame_skip).toBe(4);
        });

        it('config.json array values replace defaults', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                benchmark: { scalingEnvCounts: [1, 2, 3] },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.benchmark.scalingEnvCounts).toEqual([1, 2, 3]);
            expect(cfg.benchmark.steps).toBe(2000);
        });

        it('config.json reward section merges over the reward defaults', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                reward: { killReward: 3, timePenalty: -0.01 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(3);
            expect(cfg.reward.deathPenalty).toBe(-1.0);
            expect(cfg.reward.timePenalty).toBe(-0.01);
        });

        it('config.json reward values are overridden by reward env vars', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                reward: { killReward: 3 },
            }));
            process.env.KILL_REWARD = '8';
            const cfg = loadConfig(testDir);
            expect(cfg.reward.killReward).toBe(8);
        });

        it('null values in config.json are skipped', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                server: null,
                physics: { gravityY: 25.0 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
            expect(cfg.physics.gravityY).toBe(25.0);
        });

        it('undefined values in config.json are skipped', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                server: { port: undefined },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('invalid JSON in config.json is handled gracefully', () => {
            resetConfig();
            fs.writeFileSync(configPath, 'not valid json{{{');
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });

        it('non-object JSON in config.json is ignored', () => {
            fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(5555);
        });
    });

    // ─── numWorkers Auto-Resolution ──────────────────────────────────────

    describe('numWorkers auto-resolution', () => {
        it('numWorkers=0 resolves to min(cpuCount, maxWorkers)', () => {
            const cfg = loadConfig(testDir);
            const expected = Math.min(os.cpus().length, 8);
            expect(cfg.workerPool.numWorkers).toBe(expected);
        });

        it('numWorkers=0 with lower maxWorkers resolves to maxWorkers', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { maxWorkers: 2 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(2);
        });

        it('explicit numWorkers is not overridden by auto-resolution', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { numWorkers: 4 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(4);
        });

        it('env NUM_WORKERS=4 prevents auto-resolution', () => {
            process.env.NUM_WORKERS = '4';
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(4);
        });

        it('CLI --workers=3 prevents auto-resolution', () => {
            process.argv = ['node', 'script.js', '--workers', '3'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(3);
        });

        it('maxWorkers=0 cannot resolve the auto-detect to 0 (#269)', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { maxWorkers: 0 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThanOrEqual(1);
        });

        it('maxWorkers=0 with numWorkers=0 resolves to at least 1 (#269)', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { numWorkers: 0, maxWorkers: 0 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThanOrEqual(1);
        });

        it('a negative maxWorkers cannot resolve the auto-detect to 0 (#269)', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { numWorkers: 0, maxWorkers: -2 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThanOrEqual(1);
        });

        it('a negative numWorkers in config.json is clamped to >= 1 (#269)', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                workerPool: { numWorkers: -1 },
            }));
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBeGreaterThanOrEqual(1);
        });
    });

    // ─── Priority Order ──────────────────────────────────────────────────

    describe('priority order', () => {
        it('defaults < config.json', () => {
            fs.writeFileSync(configPath, JSON.stringify({ server: { port: 6000 } }));
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(6000);
        });

        it('config.json < env vars', () => {
            fs.writeFileSync(configPath, JSON.stringify({ server: { port: 6000 } }));
            process.env.PORT = '7000';
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(7000);
        });

        it('env vars < CLI flags', () => {
            process.env.PORT = '7000';
            process.argv = ['node', 'script.js', '--port', '8000'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(8000);
        });

        it('full priority chain: defaults < config.json < env < CLI', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                server: { port: 6000 },
                workerPool: { numWorkers: 2 },
            }));
            process.env.PORT = '7000';
            process.env.NUM_WORKERS = '3';
            process.argv = ['node', 'script.js', '--port', '9000'];
            const cfg = loadConfig(testDir);
            expect(cfg.server.port).toBe(9000);
            expect(cfg.workerPool.numWorkers).toBe(3);
            expect(cfg.server.bindAddress).toBe('127.0.0.1');
        });

        it('CLI telemetry overrides env telemetry', () => {
            process.env.MANIFOLD_TELEMETRY = 'false';
            process.argv = ['node', 'script.js', '--telemetry'];
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('env telemetry overrides config.json telemetry', () => {
            fs.writeFileSync(configPath, JSON.stringify({
                telemetry: { enabled: false },
            }));
            process.env.MANIFOLD_TELEMETRY = 'true';
            const cfg = loadConfig(testDir);
            expect(cfg.telemetry.enabled).toBe(true);
        });

        it('CLI workers override env workers', () => {
            process.env.NUM_WORKERS = '2';
            process.argv = ['node', 'script.js', '--workers', '5'];
            const cfg = loadConfig(testDir);
            expect(cfg.workerPool.numWorkers).toBe(5);
        });

        it('CLI seed overrides env seed', () => {
            process.env.SEED = '100';
            process.argv = ['node', 'script.js', '--seed', '200'];
            const cfg = loadConfig(testDir);
            expect(cfg.environment.seed).toBe(200);
        });
    });

    // ─── resolveEnvironmentConfig ──────────────────────────────────────────

    describe('resolveEnvironmentConfig', () => {
        it('attaches the loader reward defaults to the worker env config', () => {
            loadConfig(testDir);
            const merged = resolveEnvironmentConfig({});
            expect(merged.numOpponents).toBe(1);
            expect(merged.seed).toBe(0);
            expect(merged.reward.killReward).toBe(1.0);
            expect(merged.reward.deathPenalty).toBe(-1.0);
            expect(merged.reward.timePenalty).toBe(-0.001);
        });

        it('propagates loader reward env vars to the worker env config', () => {
            process.env.KILL_REWARD = '7';
            process.env.TIME_PENALTY = '-0.05';
            loadConfig(testDir);
            const merged = resolveEnvironmentConfig({});
            expect(merged.reward.killReward).toBe(7);
            expect(merged.reward.deathPenalty).toBe(-1.0);
            expect(merged.reward.timePenalty).toBe(-0.05);
        });

        it('a caller-supplied reward object wins per key over loader defaults', () => {
            process.env.KILL_REWARD = '7';
            loadConfig(testDir);
            const merged = resolveEnvironmentConfig({ reward: { timePenalty: -0.02 } });
            expect(merged.reward.killReward).toBe(7);
            expect(merged.reward.timePenalty).toBe(-0.02);
        });

        it('still resolves environment snake_case aliases alongside reward', () => {
            loadConfig(testDir);
            const merged = resolveEnvironmentConfig({ frame_skip: 4 });
            expect(merged.frameSkip).toBe(4);
            expect(merged.reward.killReward).toBe(1.0);
        });
    });

    // ─── getDefaults ─────────────────────────────────────────────────────

    describe('getDefaults', () => {
        it('documents verified native physics values in config.example.json', () => {
            const examplePath = path.resolve(__dirname, '..', '..', 'config.example.json');
            const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

            expect(example.physics.gravityY).toBe(20);
            expect(example.physics.solverIterations).toBe(2);
            expect(example.physics.positionIterations).toBeUndefined();
            expect(example.player.friction).toBe(0.001337);
            expect(example.player.restitution).toBe(0.95);
            expect(example.player.moveForce).toBe(30);
            expect(example.grapple.maxDistance).toBe(10);
            expect(example.grapple.jointFrequencyHz).toBe(2);
            expect(example.grapple.jointDampingRatio).toBe(0);
        });

        it('returns the default config object', () => {
            const defaults = getDefaults();
            expect(defaults.server.port).toBe(5555);
            expect(defaults.physics.ticksPerSecond).toBe(30);
            expect(defaults.telemetry.enabled).toBe(false);
            expect(defaults.workerPool.maxWorkers).toBe(8);
        });

        it('defaults match the verified native player/grapple values (C2 re-audit)', () => {
            const defaults = getDefaults();
            expect(defaults.player.friction).toBe(0.001337);
            expect(defaults.player.restitution).toBe(0.95);
            expect(defaults.player.moveForce).toBe(30.0);
            expect((defaults.player as any).density).toBeUndefined();
            expect(defaults.grapple.maxDistance).toBe(10.0);
            expect(defaults.grapple.jointFrequencyHz).toBe(2.0);
            expect(defaults.grapple.jointDampingRatio).toBe(0.0);
            expect((defaults.grapple as any).slingshotImpulse).toBeUndefined();
        });

        it('returns same reference on repeated calls', () => {
            const d1 = getDefaults();
            const d2 = getDefaults();
            expect(d1).toBe(d2);
        });

        it('is not affected by loadConfig', () => {
            process.env.PORT = '9999';
            loadConfig(testDir);
            const defaults = getDefaults();
            expect(defaults.server.port).toBe(5555);
        });
    });
});
