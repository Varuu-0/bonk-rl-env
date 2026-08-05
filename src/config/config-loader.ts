/**
 * config-loader.ts — Layered configuration system
 *
 * Resolution order (highest priority wins):
 *   1. CLI flags          (--port/-p, --telemetry, --profile[--level]/-l, --debug, --max-runtime)
 *   2. Environment vars   (PORT, TEST_MODE, MANIFOLD_TELEMETRY, MANIFOLD_*)
 *   3. config.json file   (project root, optional)
 *   4. Built-in defaults  (hardcoded below)
 *
 * Zero dependencies — uses only Node.js built-ins (fs, path, os).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Type Definitions ──────────────────────────────────────────────────────

export interface ServerConfig {
    port: number;
    bindAddress: string;
    zmqBacklog: number;
    maxRuntimeSeconds: number;
    shutdownTimeoutMs: number;
}

export interface PhysicsConfig {
    ticksPerSecond: number;
    solverIterations: number;
    scale: number;
    gravityX: number;
    gravityY: number;
    enableSleeping: boolean;
    worldAabbExtent: number;
}

export interface PlayerConfig {
    radius: number;
    friction: number;
    restitution: number;
    moveForce: number;
    heavyMassMultiplier: number;
}

export interface GrappleConfig {
    maxDistance: number;
    jointFrequencyHz: number;
    jointDampingRatio: number;
}

export interface ArenaConfig {
    defaultHalfWidth: number;
    defaultHalfHeight: number;
    boundsMargin: number;
}

export interface EnvironmentConfig {
    numOpponents: number;
    maxTicks: number;
    randomOpponent: boolean;
    randomOppMoveProb: number;
    randomOppUpProb: number;
    randomOppDownProb: number;
    randomOppHeavyProb: number;
    randomOppGrappleProb: number;
    frameSkip: number;
    seed: number;
    defaultMapPath: string;
    aiPlayerId: number;
}

export interface RewardConfig {
    killReward: number;
    deathPenalty: number;
    timePenalty: number;
}

export interface WorkerPoolConfig {
    numWorkers: number;
    maxWorkers: number;
    useSharedMemory: boolean;
    ringBufferSize: number;
    messageTimeoutMs: number;
    stepTimeoutMs: number;
}

export interface IpcConfig {
    socketType: string;
    serialization: string;
    tcpKeepalive: number;
    sndHwm: number;
    rcvHwm: number;
    lingerMs: number;
}

export interface TelemetryConfig {
    enabled: boolean;
    profileLevel: 'minimal' | 'standard' | 'detailed';
    debugLevel: 'none' | 'error' | 'verbose';
    outputFormat: 'console' | 'file' | 'both';
    dashboardPort: number;
    reportIntervalMs: number;
    retentionDays: number;
    hookPhysicsMethods: boolean;
    memoryRecordInterval: number;
    workerSnapshotInterval: number;
}

export interface LoggingConfig {
    level: 'debug' | 'info' | 'warn' | 'error';
    timestamps: boolean;
    colorize: boolean;
}

export interface BenchmarkConfig {
    steps: number;
    warmupSteps: number;
    timeoutMs: number;
    scalingEnvCounts: number[];
}

export interface TestConfig {
    timeoutMs: number;
    retryCount: number;
    bailOnFailure: boolean;
}

export interface PythonConfig {
    clientPort: number;
    numEnvs: number;
    connectionDelaySec: number;
    obsDim: number;
    actionSpaceSize: number;
}

export interface AppConfig {
    server: ServerConfig;
    physics: PhysicsConfig;
    player: PlayerConfig;
    grapple: GrappleConfig;
    arena: ArenaConfig;
    environment: EnvironmentConfig;
    reward: RewardConfig;
    workerPool: WorkerPoolConfig;
    ipc: IpcConfig;
    telemetry: TelemetryConfig;
    logging: LoggingConfig;
    benchmark: BenchmarkConfig;
    test: TestConfig;
    python: PythonConfig;
}

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ─── Built-in Defaults ─────────────────────────────────────────────────────

const DEFAULTS: AppConfig = {
    server: {
        port: 5555,
        bindAddress: '127.0.0.1',
        zmqBacklog: 100,
        maxRuntimeSeconds: 0,
        shutdownTimeoutMs: 10000,
    },
    physics: {
        ticksPerSecond: 30,
        solverIterations: 2,
        scale: 30.0,
        gravityX: 0.0,
        gravityY: 20.0,
        enableSleeping: true,
        worldAabbExtent: 1000.0,
    },
    player: {
        radius: 0.4,
        // Verified live 2026-07-29 disc fixture (DEOBFUSCATION §38.6):
        // friction 0.001337, restitution 0.95. Density is derived by the
        // engine as 1/(pi*r^2) so the disc mass is exactly 1 — there is no
        // standalone density default.
        friction: 0.001337,
        restitution: 0.95,
        moveForce: 30.0,
        // The engine applies `moveForce` as a constant per-tick force, then
        // ×0.7 for heavy (DEOBFUSCATION §35.5; the native radius^2 scale is
        // the disc mass ratio, pinned to 1 by the verified mass-1 fixture, so
        // no per-ppm factor is applied). At the mass-1 fixture the native base
        // (12) cannot lift the disc against gravity 20 (#234); this default
        // base (30) is the smallest round value above the heavy-lift
        // threshold `20 / 0.7 ≈ 28.57`, so pure "up" ascends (net −10 m/s²)
        // and even up+heavy ascends (net −1 m/s²).
        heavyMassMultiplier: 0.7,
    },
    grapple: {
        // Verified native grapple (DEOBFUSCATION §32): target window is a
        // QueryAABB ±10 world units with center-to-surface distance < 10;
        // joint tuning is swingF = 2 Hz / swingD = 0 with a 0.01 Hz slack
        // branch; the literal 500 is the a1a energy threshold, not a reach.
        // The invented slingshot impulse was removed with the mechanic.
        maxDistance: 10.0,
        jointFrequencyHz: 2.0,
        jointDampingRatio: 0.0,
    },
    arena: {
        defaultHalfWidth: 25.0,
        defaultHalfHeight: 20.0,
        boundsMargin: 5.0,
    },
    environment: {
        numOpponents: 1,
        maxTicks: 900,
        randomOpponent: true,
        randomOppMoveProb: 0.2,
        randomOppUpProb: 0.15,
        randomOppDownProb: 0.1,
        randomOppHeavyProb: 0.05,
        randomOppGrappleProb: 0.05,
        frameSkip: 1,
        seed: 0,
        defaultMapPath: 'maps/bonk_WDB__No_Mapshake__716916.json',
        aiPlayerId: 0,
    },
    reward: {
        killReward: 1.0,
        deathPenalty: -1.0,
        timePenalty: -0.001,
    },
    workerPool: {
        numWorkers: 0,
        maxWorkers: 8,
        useSharedMemory: true,
        ringBufferSize: 16,
        messageTimeoutMs: 30000,
        stepTimeoutMs: 5000,
    },
    ipc: {
        socketType: 'ROUTER',
        serialization: 'json',
        tcpKeepalive: 0,
        sndHwm: 1000,
        rcvHwm: 1000,
        lingerMs: 1000,
    },
    telemetry: {
        enabled: false,
        profileLevel: 'standard',
        debugLevel: 'none',
        outputFormat: 'console',
        dashboardPort: 3001,
        reportIntervalMs: 5000,
        retentionDays: 7,
        hookPhysicsMethods: true,
        memoryRecordInterval: 1000,
        workerSnapshotInterval: 5000,
    },
    logging: {
        level: 'info',
        timestamps: true,
        colorize: true,
    },
    benchmark: {
        steps: 2000,
        warmupSteps: 200,
        timeoutMs: 600000,
        scalingEnvCounts: [1, 2, 4, 8, 16],
    },
    test: {
        timeoutMs: 60000,
        retryCount: 0,
        bailOnFailure: false,
    },
    python: {
        clientPort: 5555,
        numEnvs: 1,
        connectionDelaySec: 0.1,
        obsDim: 14,
        actionSpaceSize: 64,
    },
};

// ─── Deep Merge Utility ────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function deepMerge<T extends Record<string, any>>(base: T, override: DeepPartial<T>): T {
    const result: Record<string, any> = { ...base };
    for (const key of Object.keys(override)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const overrideVal = (override as Record<string, any>)[key];
        if (overrideVal === undefined || overrideVal === null) continue;
        if (isPlainObject(result[key]) && isPlainObject(overrideVal)) {
            result[key] = deepMerge(result[key], overrideVal);
        } else {
            result[key] = overrideVal;
        }
    }
    return result as T;
}

// ─── Environment Config Merge ───────────────────────────────────────────────

/**
 * snake_case → camelCase aliases accepted by BonkEnvironment (the documented
 * Python-client keys). When an override supplies the snake_case alias, it is
 * resolved into the camelCase slot so the injected camelCase default can
 * never shadow the alias (#204).
 */
export const ENVIRONMENT_KEY_ALIASES: Array<[string, string]> = [
    ['frame_skip', 'frameSkip'],
    ['num_opponents', 'numOpponents'],
    ['max_ticks', 'maxTicks'],
    ['random_opponent', 'randomOpponent'],
];

/**
 * Merge a per-env override over the environment defaults with snake_case
 * alias resolution. If the override supplies a snake_case alias
 * (frame_skip, num_opponents, max_ticks, random_opponent), its value is
 * resolved into the camelCase slot, so the base's (default) camelCase value
 * can never shadow the alias while every declared-required environment field
 * stays defined. An override that supplies the camelCase key directly is
 * always kept as-is and takes precedence.
 */
export function mergeEnvironmentConfig(
    base: Record<string, any>,
    override: Record<string, any>,
): Record<string, any> {
    const merged = deepMerge(base, override);
    for (const [snake, camel] of ENVIRONMENT_KEY_ALIASES) {
        const snakeVal = override[snake];
        const camelVal = override[camel];
        // Resolve the snake alias unless the override supplies an explicit
        // camelCase value. deepMerge already skips null/undefined overrides
        // as absent, so a null camelCase key must not block resolution.
        if (snakeVal != null && camelVal == null) {
            merged[camel] = snakeVal;
        }
    }
    return merged;
}

// ─── Config File Loader ────────────────────────────────────────────────────

function findConfigFile(): string | null {
    const candidates = [
        path.resolve(process.cwd(), 'config.json'),
        path.resolve(process.cwd(), 'config.json5'),
        path.resolve(process.cwd(), '.config', 'config.json'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function loadConfigFile(filePath: string): Partial<AppConfig> | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            console.warn(`[Config] ${filePath} is not a JSON object, ignoring`);
            return null;
        }
        return parsed as Partial<AppConfig>;
    } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        console.warn(`[Config] Failed to parse ${filePath}: ${err.message}`);
        return null;
    }
}

// ─── Environment Variable Overrides ────────────────────────────────────────

function applyEnvOverrides(config: AppConfig): AppConfig {
    const env = process.env;

    // Server
    if (env.PORT !== undefined) {
        const v = parseInt(env.PORT, 10);
        if (!isNaN(v) && v >= 1 && v <= 65535) config.server.port = v;
    }
    if (env.BIND_ADDRESS !== undefined) {
        config.server.bindAddress = env.BIND_ADDRESS;
    }
    if (env.MAX_RUNTIME !== undefined) {
        const v = parseInt(env.MAX_RUNTIME, 10);
        if (!isNaN(v) && v >= 0) config.server.maxRuntimeSeconds = v;
    }

    // Telemetry
    if (env.MANIFOLD_TELEMETRY !== undefined) {
        const v = env.MANIFOLD_TELEMETRY.toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes') {
            config.telemetry.enabled = true;
        } else if (v === 'false' || v === '0' || v === 'no') {
            config.telemetry.enabled = false;
        }
    }
    if (env.MANIFOLD_TELEMETRY_OUTPUT !== undefined) {
        const v = env.MANIFOLD_TELEMETRY_OUTPUT;
        if (v === 'console' || v === 'file' || v === 'both') config.telemetry.outputFormat = v;
    }
    if (env.MANIFOLD_PROFILE !== undefined) {
        const v = env.MANIFOLD_PROFILE;
        if (v === 'minimal' || v === 'standard' || v === 'detailed') config.telemetry.profileLevel = v;
    }
    if (env.MANIFOLD_DEBUG !== undefined) {
        const v = env.MANIFOLD_DEBUG;
        if (v === 'none' || v === 'error' || v === 'verbose') config.telemetry.debugLevel = v;
    }

    // Test mode
    if (env.TEST_MODE === '1') {
        config.server.maxRuntimeSeconds = Math.min(config.server.maxRuntimeSeconds || 2, 2);
        config.logging.level = 'warn';
    }

    // Worker pool
    if (env.NUM_WORKERS !== undefined) {
        const v = parseInt(env.NUM_WORKERS, 10);
        if (!isNaN(v) && v >= 0) config.workerPool.numWorkers = v;
    }
    if (env.USE_SHARED_MEMORY !== undefined) {
        const v = env.USE_SHARED_MEMORY.toLowerCase();
        config.workerPool.useSharedMemory = v !== 'false' && v !== '0' && v !== 'no';
    }

    // Environment
    if (env.DEFAULT_MAP_PATH !== undefined) {
        config.environment.defaultMapPath = env.DEFAULT_MAP_PATH;
    }
    if (env.SEED !== undefined) {
        const v = parseInt(env.SEED, 10);
        if (!isNaN(v) && v >= 0) config.environment.seed = v;
    }
    // AI player slot (documented surface, config.example.json: range 0-7).
    // The slot must also be within [0, numOpponents]; that interplay is
    // validated by BonkEnvironment at construction.
    if (env.AI_PLAYER_ID !== undefined) {
        const v = parseInt(env.AI_PLAYER_ID, 10);
        if (!isNaN(v) && v >= 0 && v <= 7) config.environment.aiPlayerId = v;
    }
    // Opponent random-policy probabilities (documented env vars)
    const oppProbEnvVars: Array<[string, keyof EnvironmentConfig]> = [
        ['RANDOM_OPP_MOVE_PROB', 'randomOppMoveProb'],
        ['RANDOM_OPP_UP_PROB', 'randomOppUpProb'],
        ['RANDOM_OPP_DOWN_PROB', 'randomOppDownProb'],
        ['RANDOM_OPP_HEAVY_PROB', 'randomOppHeavyProb'],
        ['RANDOM_OPP_GRAPPLE_PROB', 'randomOppGrappleProb'],
    ];
    for (const [envVar, key] of oppProbEnvVars) {
        const rawValue = env[envVar];
        if (rawValue !== undefined) {
            const v = parseFloat(rawValue);
            if (!isNaN(v) && v >= 0 && v <= 1) (config.environment as any)[key] = v;
        }
    }

    return config;
}

// ─── CLI Flag Overrides ────────────────────────────────────────────────────

function parseCliFlags(config: AppConfig): AppConfig {
    const argv = process.argv;
    const argc = argv.length;

    for (let i = 2; i < argc; i++) {
        const arg = argv[i];
        const next = i + 1 < argc ? argv[i + 1] : undefined;

        switch (arg) {
            case '--port':
            case '-p':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v >= 1 && v <= 65535) {
                        config.server.port = v;
                        i++;
                    }
                }
                break;

            case '--max-runtime':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v > 0) {
                        config.server.maxRuntimeSeconds = v;
                        i++;
                    }
                }
                break;

            case '--telemetry':
            case '-t':
                config.telemetry.enabled = true;
                break;

            case '--profile':
            case '--profile-level':
            case '-l':
                if (next) {
                    if (next === 'minimal' || next === 'standard' || next === 'detailed') {
                        config.telemetry.profileLevel = next;
                        config.telemetry.enabled = true;
                        i++;
                    }
                }
                break;

            case '--debug':
            case '-d':
                if (next) {
                    if (next === 'none' || next === 'error' || next === 'verbose') {
                        config.telemetry.debugLevel = next;
                        i++;
                    }
                }
                break;

            case '--output':
            case '-o':
                if (next) {
                    if (next === 'console' || next === 'file' || next === 'both') {
                        config.telemetry.outputFormat = next;
                        i++;
                    }
                }
                break;

            case '--dashboard-port':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v > 0 && v < 65536) {
                        config.telemetry.dashboardPort = v;
                        i++;
                    }
                }
                break;

            case '--workers':
            case '-w':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v >= 0) {
                        config.workerPool.numWorkers = v;
                        i++;
                    }
                }
                break;

            case '--no-shared-mem':
                config.workerPool.useSharedMemory = false;
                break;

            case '--seed':
            case '-s':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v >= 0) {
                        config.environment.seed = v;
                        i++;
                    }
                }
                break;

            case '--map':
                if (next) {
                    config.environment.defaultMapPath = next;
                    i++;
                }
                break;

            case '--ai-player-id':
                if (next) {
                    const v = parseInt(next, 10);
                    if (!isNaN(v) && v >= 0 && v <= 7) {
                        config.environment.aiPlayerId = v;
                        i++;
                    }
                }
                break;

            case '--random-opp-move-prob':
            case '--random-opp-up-prob':
            case '--random-opp-down-prob':
            case '--random-opp-heavy-prob':
            case '--random-opp-grapple-prob':
                if (next) {
                    const v = parseFloat(next);
                    if (!isNaN(v) && v >= 0 && v <= 1) {
                        switch (arg) {
                            case '--random-opp-move-prob': config.environment.randomOppMoveProb = v; break;
                            case '--random-opp-up-prob': config.environment.randomOppUpProb = v; break;
                            case '--random-opp-down-prob': config.environment.randomOppDownProb = v; break;
                            case '--random-opp-heavy-prob': config.environment.randomOppHeavyProb = v; break;
                            case '--random-opp-grapple-prob': config.environment.randomOppGrappleProb = v; break;
                        }
                        i++;
                    }
                }
                break;

            case '--verbose':
                config.telemetry.enabled = true;
                config.telemetry.debugLevel = 'verbose';
                config.logging.level = 'debug';
                break;

            default:
                break;
        }
    }

    return config;
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Cached config singleton */
let cachedConfig: AppConfig | null = null;

/**
 * Load configuration from all sources, applying layered resolution.
 *
 * Call order:
 *   1. Start with built-in defaults
 *   2. Deep-merge config.json (if found)
 *   3. Apply environment variable overrides
 *   4. Apply CLI flag overrides (highest priority)
 *
 * @param projectRoot  Optional project root override (default: cwd)
 * @returns Fully resolved AppConfig
 */
export function loadConfig(projectRoot?: string): AppConfig {
    if (cachedConfig !== null) {
        return cachedConfig;
    }

    // Layer 1: defaults
    let config: AppConfig = JSON.parse(JSON.stringify(DEFAULTS));

    // Layer 2: config.json
    const root = projectRoot || process.cwd();
    const configPath = path.resolve(root, 'config.json');
    if (fs.existsSync(configPath)) {
        const fileConfig = loadConfigFile(configPath);
        if (fileConfig) {
            config = deepMerge(config, fileConfig);
            if (isPlainObject(fileConfig.environment)) {
                // Resolve snake_case aliases against the injected camelCase
                // defaults so a config.json `frame_skip`/`num_opponents`/
                // `max_ticks`/`random_opponent` is not shadowed by the
                // always-present camelCase default (#204).
                config.environment = mergeEnvironmentConfig(
                    config.environment as any,
                    fileConfig.environment as any,
                ) as EnvironmentConfig;
            }
        }
    } else {
        // Try to find config.json anywhere in the search list
        const found = findConfigFile();
        if (found) {
            const fileConfig = loadConfigFile(found);
            if (fileConfig) {
                config = deepMerge(config, fileConfig);
                if (isPlainObject(fileConfig.environment)) {
                    config.environment = mergeEnvironmentConfig(
                        config.environment as any,
                        fileConfig.environment as any,
                    ) as EnvironmentConfig;
                }
            }
        }
    }

    // Layer 3: environment variables
    config = applyEnvOverrides(config);

    // Layer 4: CLI flags
    config = parseCliFlags(config);

    // Resolve numWorkers=0 to actual CPU count
    if (config.workerPool.numWorkers === 0) {
        config.workerPool.numWorkers = Math.min(os.cpus().length, config.workerPool.maxWorkers);
    }

    cachedConfig = config;
    return config;
}

/**
 * Reset the cached config. Primarily used for testing.
 */
export function resetConfig(): void {
    cachedConfig = null;
}

/**
 * Get the cached config without re-loading. Returns defaults if not yet loaded.
 */
export function getConfig(): AppConfig {
    if (cachedConfig === null) {
        return loadConfig();
    }
    return cachedConfig;
}

/**
 * Get a typed sub-section of the config.
 * @example getSection('physics')
 */
export function getSection<K extends keyof AppConfig>(section: K): AppConfig[K] {
    return getConfig()[section];
}

/**
 * Export defaults for reference or reset.
 */
export function getDefaults(): Readonly<AppConfig> {
    return DEFAULTS;
}
