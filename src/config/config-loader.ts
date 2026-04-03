/**
 * config-loader.ts — Layered configuration system
 *
 * Resolution order (highest priority wins):
 *   1. CLI flags          (--port, --telemetry, --profile, --debug, --max-runtime)
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
    density: number;
    friction: number;
    restitution: number;
    moveForce: number;
    heavyMassMultiplier: number;
}

export interface GrappleConfig {
    maxDistance: number;
    jointFrequencyHz: number;
    jointDampingRatio: number;
    slingshotImpulse: number;
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
        solverIterations: 5,
        scale: 30.0,
        gravityX: 0.0,
        gravityY: 10.0,
        enableSleeping: true,
        worldAabbExtent: 1000.0,
    },
    player: {
        radius: 0.5,
        density: 1.0,
        friction: 0.3,
        restitution: 0.5,
        moveForce: 8.0,
        heavyMassMultiplier: 3.0,
    },
    grapple: {
        maxDistance: 10.0,
        jointFrequencyHz: 4.0,
        jointDampingRatio: 0.5,
        slingshotImpulse: 50.0,
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

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
    const result: Record<string, any> = { ...base };
    for (const key of Object.keys(override)) {
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
        config.telemetry.enabled = v === 'true' || v === '1' || v === 'yes';
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
        }
    } else {
        // Try to find config.json anywhere in the search list
        const found = findConfigFile();
        if (found) {
            const fileConfig = loadConfigFile(found);
            if (fileConfig) {
                config = deepMerge(config, fileConfig);
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
