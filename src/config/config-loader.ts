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

/**
 * Default cap for concurrent per-client worker-pool sessions (see
 * ServerConfig.maxClientSessions). Shared with IpcBridge so the bridge's
 * missing-cap fallback can never drift from the loader default.
 */
export const DEFAULT_MAX_CLIENT_SESSIONS = 32;
const MAX_ZMQ_OPTION = 0x7fffffff;
const MAX_RING_BUFFER_SIZE = 1 << 20;

/**
 * Validation bounds for the environment-section scalars wired from the
 * documented env/CLI surfaces (#413). The loader stays dependency-free, so
 * these mirror their runtime contracts instead of importing them:
 *
 *   - frameSkip [1, MAX_FRAME_SKIP]: the #393 contract BonkEnvironment
 *     enforces at construction (src/core/environment.ts).
 *   - maxTicks >= 1: the positive-integer truncation guard (#266), also in
 *     src/core/environment.ts.
 *   - numOpponents [0, MAX_NUM_OPPONENTS]: the documented
 *     config.example.json range (native bonk.io caps rooms at 8 players);
 *     the engine's broader capacity bound lives in
 *     src/core/opponent-capacity.ts.
 */
const MAX_FRAME_SKIP = 100;
const MAX_NUM_OPPONENTS = 7;

export interface ServerConfig {
  port: number;
  bindAddress: string;
  zmqBacklog: number;
  maxRuntimeSeconds: number;
  shutdownTimeoutMs: number;
  /**
   * Maximum number of concurrent per-client worker-pool sessions. Bounds
   * worker accumulation from clients that disconnect without sending a
   * session `close` (issue #193); a new client `init` beyond the cap is
   * rejected loudly instead of silently evicting an existing session.
   */
  maxClientSessions: number;
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
    maxClientSessions: DEFAULT_MAX_CLIENT_SESSIONS,
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
export function mergeEnvironmentConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
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

/** The engine-tuning sections of AppConfig (physics/arena/player). */
export interface EngineTuningSections {
  /** The loader default solverIterations is omitted when it was not authored. */
  physics: Omit<PhysicsConfig, 'solverIterations'> & { solverIterations?: number };
  arena: ArenaConfig;
  player: PlayerConfig;
}

/**
 * snake_case → camelCase aliases accepted for the engine-tuning sections (the
 * documented Python-client spelling). When an override supplies the snake_case
 * alias, it is resolved into the camelCase slot so the injected camelCase
 * default can never shadow the alias (mirrors ENVIRONMENT_KEY_ALIASES, #204).
 */
const PHYSICS_KEY_ALIASES: Array<[string, string]> = [
  ['ticks_per_second', 'ticksPerSecond'],
  ['solver_iterations', 'solverIterations'],
  ['gravity_x', 'gravityX'],
  ['gravity_y', 'gravityY'],
  ['enable_sleeping', 'enableSleeping'],
  ['world_aabb_extent', 'worldAabbExtent'],
];
const ARENA_KEY_ALIASES: Array<[string, string]> = [
  ['default_half_width', 'defaultHalfWidth'],
  ['default_half_height', 'defaultHalfHeight'],
  ['bounds_margin', 'boundsMargin'],
];
const PLAYER_KEY_ALIASES: Array<[string, string]> = [
  ['move_force', 'moveForce'],
  ['heavy_mass_multiplier', 'heavyMassMultiplier'],
];

/** Deep-merge one tuning section with snake_case → camelCase alias resolution. */
function mergeTuningSection(
  base: Record<string, any>,
  override: Record<string, any>,
  aliases: Array<[string, string]>,
): Record<string, any> {
  const merged = deepMerge(base, override);
  for (const [snake, camel] of aliases) {
    const snakeVal = override[snake];
    const camelVal = override[camel];
    // Resolve the snake alias unless the override supplies an explicit
    // camelCase value (deepMerge skips null/undefined overrides as absent).
    if (snakeVal != null && camelVal == null) {
      merged[camel] = snakeVal;
    }
  }
  return merged;
}

/**
 * Resolve the engine-tuning sections for a spawn request by deep-merging the
 * caller's per-env overrides over the resolved config defaults. The result is
 * forwarded (via the worker pool / IPC bridge) to BonkEnvironment, which hands
 * the values to PhysicsEngine — so values set in config.json, env vars, CLI
 * flags, or the Python client's spawn config actually reach the simulation
 * (issue #217). The built-in solverIterations value is omitted unless it was
 * explicitly authored, allowing the map's native `pq` quality gate to choose
 * the engine default (issue #325). Overrides that are not plain objects (e.g.
 * null) are ignored, proto-polluting keys are skipped by deepMerge, and
 * snake_case sub-keys (gravity_y, move_force, ...) are resolved into their
 * camelCase slots.
 */
export function mergeEngineSections(override: Record<string, any> = {}): EngineTuningSections {
  const physicsOverride = isPlainObject(override.physics) ? override.physics : {};
  const physics = mergeTuningSection(getConfig().physics as any, physicsOverride, PHYSICS_KEY_ALIASES) as Omit<
    PhysicsConfig,
    'solverIterations'
  > & { solverIterations?: number };
  const hasPerEnvSolverOverride =
    (Object.prototype.hasOwnProperty.call(physicsOverride, 'solverIterations') &&
      physicsOverride.solverIterations != null) ||
    (Object.prototype.hasOwnProperty.call(physicsOverride, 'solver_iterations') &&
      physicsOverride.solver_iterations != null);
  if (!hasPerEnvSolverOverride && !physicsProvenance(getConfig()).has('solverIterations')) {
    delete physics.solverIterations;
  }

  return {
    physics,
    arena: mergeTuningSection(
      getConfig().arena as any,
      isPlainObject(override.arena) ? override.arena : {},
      ARENA_KEY_ALIASES,
    ) as ArenaConfig,
    player: mergeTuningSection(
      getConfig().player as any,
      isPlainObject(override.player) ? override.player : {},
      PLAYER_KEY_ALIASES,
    ) as PlayerConfig,
  };
}

/**
 * Build the complete per-worker environment config: the loader's environment
 * section merged with the caller's per-env/client overrides, plus the reward
 * section attached under `reward` (killReward, deathPenalty, timePenalty).
 * The reward section is the single source for the documented reward-shaping
 * surfaces (config.json, KILL_REWARD/DEATH_PENALTY/TIME_PENALTY env vars,
 * --kill-reward/--death-penalty/--time-penalty CLI flags); attaching it here
 * lets BonkEnvironment apply the configured weights on every worker-init path
 * (IpcBridge init, BonkEnv.start) instead of leaving calculateReward's
 * hardcoded literals in place (#220). A caller-supplied `reward` object wins
 * per key over the loader defaults.
 */
export function resolveEnvironmentConfig(override: Record<string, any> = {}): Record<string, any> {
  const merged = mergeEnvironmentConfig(getConfig().environment as any, override);
  const overrideReward = isPlainObject(override.reward) ? (override.reward as Record<string, any>) : {};
  merged.reward = { ...getConfig().reward, ...overrideReward };
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

// ─── Config Value Parsing ──────────────────────────────────────────────────

// Accepts only full decimal / scientific-notation numerics: an optional sign,
// an integer and/or fraction part, and an optional digit-bearing exponent.
// Deliberately excludes JS non-decimal numeric literals ("0x10", "0b101",
// "0o17") so a config value can never be parsed from a base-N literal.
const DECIMAL_NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_NUMERIC_RE = /^[+-]?\d+$/;

/**
 * Strictly parse a finite float from a CLI/env string.
 *
 * Unlike `parseFloat`, this requires the entire string to be a full decimal or
 * scientific-notation numeric and the result to be finite: `"10abc"`→null
 * (parseFloat would yield 10), `"1e999"` / `"Infinity"`→null
 * (parseFloat/Number yield Infinity), `""`→null. Non-decimal JS literals such
 * as `"0x10"` and `"0b101"` are also rejected. Only whole, finite decimal
 * numbers pass, so garbage can never become a config value.
 */
function parseFiniteFloat(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (trimmed === '' || !DECIMAL_NUMERIC_RE.test(trimmed)) return null;
  const v = Number(trimmed);
  return Number.isFinite(v) ? v : null;
}

/**
 * Strictly parse an integer from a CLI/env string. Newly wired numeric
 * surfaces use this helper so values such as "32abc" cannot silently change
 * runtime configuration.
 */
function parseInteger(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!INTEGER_NUMERIC_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse a CLI/env integer exactly as the loader historically did with
 * `parseInt(value, 10)`: the leading integer portion is taken and any trailing
 * garbage is ignored. Pre-existing surfaces (NUM_WORKERS, --workers/-w) keep
 * this lenient contract so documented values such as "2abc" or "2.5" keep
 * parsing instead of silently falling back to defaults.
 */
function parseLegacyInteger(rawValue: string): number | null {
  const value = parseInt(rawValue.trim(), 10);
  return Number.isNaN(value) ? null : value;
}

function isPowerOfTwo(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 2 && value <= MAX_RING_BUFFER_SIZE && Number.isInteger(Math.log2(value))
  );
}

function normalizeIntegerConfigValue(
  raw: unknown,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = typeof raw === 'string' ? parseInteger(raw) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function normalizeResolvedConfig(config: AppConfig): AppConfig {
  if (!isPlainObject(config.server)) config.server = { ...DEFAULTS.server };
  if (!isPlainObject(config.workerPool)) config.workerPool = { ...DEFAULTS.workerPool };
  if (!isPlainObject(config.ipc)) config.ipc = { ...DEFAULTS.ipc };

  config.server.zmqBacklog = normalizeIntegerConfigValue(
    config.server.zmqBacklog,
    DEFAULTS.server.zmqBacklog,
    1,
    MAX_ZMQ_OPTION,
  );
  config.workerPool.maxWorkers = normalizeIntegerConfigValue(
    config.workerPool.maxWorkers,
    DEFAULTS.workerPool.maxWorkers,
    1,
    MAX_ZMQ_OPTION,
  );
  const ringBufferSize = normalizeIntegerConfigValue(
    config.workerPool.ringBufferSize,
    DEFAULTS.workerPool.ringBufferSize,
    2,
    MAX_RING_BUFFER_SIZE,
  );
  config.workerPool.ringBufferSize = isPowerOfTwo(ringBufferSize) ? ringBufferSize : DEFAULTS.workerPool.ringBufferSize;
  config.workerPool.messageTimeoutMs = normalizeIntegerConfigValue(
    config.workerPool.messageTimeoutMs,
    DEFAULTS.workerPool.messageTimeoutMs,
    100,
    MAX_ZMQ_OPTION,
  );
  config.workerPool.stepTimeoutMs = normalizeIntegerConfigValue(
    config.workerPool.stepTimeoutMs,
    DEFAULTS.workerPool.stepTimeoutMs,
    100,
    MAX_ZMQ_OPTION,
  );
  config.ipc.tcpKeepalive = normalizeIntegerConfigValue(config.ipc.tcpKeepalive, DEFAULTS.ipc.tcpKeepalive, 0, 1);
  config.ipc.sndHwm = normalizeIntegerConfigValue(config.ipc.sndHwm, DEFAULTS.ipc.sndHwm, 0, MAX_ZMQ_OPTION);
  config.ipc.rcvHwm = normalizeIntegerConfigValue(config.ipc.rcvHwm, DEFAULTS.ipc.rcvHwm, 0, MAX_ZMQ_OPTION);
  config.ipc.lingerMs = normalizeIntegerConfigValue(config.ipc.lingerMs, DEFAULTS.ipc.lingerMs, 0, MAX_ZMQ_OPTION);
  if (!['ROUTER', 'DEALER', 'REP', 'REQ'].includes(config.ipc.socketType)) {
    config.ipc.socketType = DEFAULTS.ipc.socketType;
  }
  if (!['json', 'msgpack'].includes(config.ipc.serialization)) {
    config.ipc.serialization = DEFAULTS.ipc.serialization;
  }

  // Environment-section gating (#413): the same bounds the env-var/CLI
  // layers enforce, applied to every authoring surface (config.json,
  // including snake_case aliases resolved by mergeEnvironmentConfig) so an
  // invalid value cannot fail differently per surface. Invalid values keep
  // the documented default here; per-spawn overrides that bypass the loader
  // remain validated at the BonkEnvironment boundary (#393/#266/#392).
  if (!isPlainObject(config.environment)) config.environment = { ...DEFAULTS.environment };
  config.environment.frameSkip = normalizeIntegerConfigValue(
    config.environment.frameSkip,
    DEFAULTS.environment.frameSkip,
    1,
    MAX_FRAME_SKIP,
  );
  config.environment.maxTicks = normalizeIntegerConfigValue(
    config.environment.maxTicks,
    DEFAULTS.environment.maxTicks,
    1,
    MAX_ZMQ_OPTION,
  );
  config.environment.numOpponents = normalizeIntegerConfigValue(
    config.environment.numOpponents,
    DEFAULTS.environment.numOpponents,
    0,
    MAX_NUM_OPPONENTS,
  );
  const randomOpponent: unknown = config.environment.randomOpponent;
  if (typeof randomOpponent === 'number') {
    // 0/1 are the numeric spellings of the env-var booleans; anything else
    // is unrecognized and keeps the documented default.
    config.environment.randomOpponent =
      randomOpponent === 0 ? false : randomOpponent === 1 ? true : DEFAULTS.environment.randomOpponent;
  } else if (typeof randomOpponent === 'string') {
    // A string like "false" is truthy in JS and would keep the policy
    // enabled downstream (#413 review); normalize the documented spellings
    // and fall back to the default for anything unrecognized.
    const t = randomOpponent.trim().toLowerCase();
    config.environment.randomOpponent =
      t === 'false' || t === '0' || t === 'no'
        ? false
        : t === 'true' || t === '1' || t === 'yes'
          ? true
          : DEFAULTS.environment.randomOpponent;
  } else if (typeof randomOpponent !== 'boolean') {
    config.environment.randomOpponent = DEFAULTS.environment.randomOpponent;
  }
  return config;
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
  if (env.ZMQ_BACKLOG !== undefined) {
    const v = parseInteger(env.ZMQ_BACKLOG);
    if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) config.server.zmqBacklog = v;
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
  // Documented telemetry env vars (config.example.json): DASHBOARD_PORT and
  // REPORT_INTERVAL_MS were parsed by neither config-loader nor flags.ts, so
  // the dashboard port and report interval were silently ignored (issue #237).
  if (env.DASHBOARD_PORT !== undefined) {
    const v = parseInt(env.DASHBOARD_PORT, 10);
    if (!isNaN(v) && v > 0 && v < 65536) config.telemetry.dashboardPort = v;
  }
  if (env.REPORT_INTERVAL_MS !== undefined) {
    const v = parseInt(env.REPORT_INTERVAL_MS, 10);
    if (!isNaN(v) && v > 0) config.telemetry.reportIntervalMs = v;
  }

  // Test mode
  if (env.TEST_MODE === '1') {
    config.server.maxRuntimeSeconds = Math.min(config.server.maxRuntimeSeconds || 2, 2);
    config.logging.level = 'warn';
  }

  // Worker pool
  if (env.NUM_WORKERS !== undefined) {
    const v = parseLegacyInteger(env.NUM_WORKERS);
    if (v !== null && v >= 0) config.workerPool.numWorkers = v;
  }
  if (env.USE_SHARED_MEMORY !== undefined) {
    const v = env.USE_SHARED_MEMORY.toLowerCase();
    config.workerPool.useSharedMemory = v !== 'false' && v !== '0' && v !== 'no';
  }
  if (env.MAX_WORKERS !== undefined) {
    const v = parseInteger(env.MAX_WORKERS);
    if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) config.workerPool.maxWorkers = v;
  }
  if (env.RING_BUFFER_SIZE !== undefined) {
    const v = parseInteger(env.RING_BUFFER_SIZE);
    if (v !== null && isPowerOfTwo(v)) config.workerPool.ringBufferSize = v;
  }
  if (env.MESSAGE_TIMEOUT_MS !== undefined) {
    const v = parseInteger(env.MESSAGE_TIMEOUT_MS);
    if (v !== null && v >= 100 && v <= MAX_ZMQ_OPTION) config.workerPool.messageTimeoutMs = v;
  }
  if (env.STEP_TIMEOUT_MS !== undefined) {
    const v = parseInteger(env.STEP_TIMEOUT_MS);
    if (v !== null && v >= 100 && v <= MAX_ZMQ_OPTION) config.workerPool.stepTimeoutMs = v;
  }

  // IPC transport
  if (env.SOCKET_TYPE !== undefined) {
    const v = env.SOCKET_TYPE;
    if (v === 'ROUTER' || v === 'DEALER' || v === 'REP' || v === 'REQ') config.ipc.socketType = v;
  }
  if (env.SERIALIZATION !== undefined) {
    const v = env.SERIALIZATION;
    if (v === 'json' || v === 'msgpack') config.ipc.serialization = v;
  }
  if (env.TCP_KEEPALIVE !== undefined) {
    const v = parseInteger(env.TCP_KEEPALIVE);
    if (v === 0 || v === 1) config.ipc.tcpKeepalive = v;
  }
  if (env.SND_HWM !== undefined) {
    const v = parseInteger(env.SND_HWM);
    if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) config.ipc.sndHwm = v;
  }
  if (env.RCV_HWM !== undefined) {
    const v = parseInteger(env.RCV_HWM);
    if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) config.ipc.rcvHwm = v;
  }
  if (env.LINGER_MS !== undefined) {
    const v = parseInteger(env.LINGER_MS);
    if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) config.ipc.lingerMs = v;
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
  // Core episode/scaling scalars (documented surfaces, config.example.json:
  // FRAME_SKIP / MAX_TICKS / NUM_OPPONENTS / RANDOM_OPPONENT). These were
  // documented but never read, so training runs silently executed with the
  // defaults while env-var authors believed otherwise (#413). Invalid
  // values are rejected like every sibling surface above: the documented
  // default is kept instead of propagating garbage into the simulation.
  if (env.FRAME_SKIP !== undefined) {
    const v = parseInteger(env.FRAME_SKIP);
    if (v !== null && v >= 1 && v <= MAX_FRAME_SKIP) config.environment.frameSkip = v;
  }
  if (env.MAX_TICKS !== undefined) {
    const v = parseInteger(env.MAX_TICKS);
    // MAX_ZMQ_OPTION is the repo's loose loader-side sanity cap: an
    // extra-zero typo (90000000000) must not create effectively
    // never-truncating episodes with no wall-clock backstop (#413 review).
    if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) config.environment.maxTicks = v;
  }
  if (env.NUM_OPPONENTS !== undefined) {
    const v = parseInteger(env.NUM_OPPONENTS);
    if (v !== null && v >= 0 && v <= MAX_NUM_OPPONENTS) config.environment.numOpponents = v;
  }
  if (env.RANDOM_OPPONENT !== undefined) {
    // Trim like parseInteger: dotenv/--env-file values on Windows can carry
    // a trailing CRLF, which would otherwise match neither branch and
    // silently leave the policy enabled (#413 review).
    const v = env.RANDOM_OPPONENT.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') {
      config.environment.randomOpponent = true;
    } else if (v === 'false' || v === '0' || v === 'no') {
      config.environment.randomOpponent = false;
    }
  }
  // Reward shaping (documented env vars: KILL_REWARD / DEATH_PENALTY / TIME_PENALTY).
  // Weight semantics (#220): killReward is a signed delta added on a kill
  // (positive rewards killing, negative discourages it). DEATH_PENALTY and
  // TIME_PENALTY are non-positive deltas — a "penalty" reduces reward, so a
  // positive value would reward the very event it names and is rejected
  // (falls back to the default). All values must be fully parsed and finite;
  // Infinity/NaN/partial garbage are ignored.
  const rewardEnvVars: Array<[string, keyof RewardConfig]> = [
    ['KILL_REWARD', 'killReward'],
    ['DEATH_PENALTY', 'deathPenalty'],
    ['TIME_PENALTY', 'timePenalty'],
  ];
  for (const [envVar, key] of rewardEnvVars) {
    const rawValue = env[envVar];
    if (rawValue !== undefined) {
      const v = parseFiniteFloat(rawValue);
      const isPenalty = key !== 'killReward';
      if (v !== null && (!isPenalty || v <= 0)) (config.reward as any)[key] = v;
    }
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

  // Physics (documented physics.* surfaces, issue #217). Every parsed float
  // must be finite: parseFloat accepts 'Infinity'/'1e999', which would
  // otherwise propagate NaN/infinite values into the simulation.
  if (env.TICKS_PER_SECOND !== undefined) {
    const v = parseInt(env.TICKS_PER_SECOND, 10);
    if (!isNaN(v) && v >= 1 && v <= 240) config.physics.ticksPerSecond = v;
  }
  if (env.SOLVER_ITERATIONS !== undefined) {
    applySolverIterations(config, parseInt(env.SOLVER_ITERATIONS, 10));
  }
  if (env.PHYSICS_SCALE !== undefined) {
    const v = parseFloat(env.PHYSICS_SCALE);
    if (Number.isFinite(v) && v > 0) config.physics.scale = v;
  }
  if (env.GRAVITY_X !== undefined) {
    const v = parseFloat(env.GRAVITY_X);
    if (Number.isFinite(v)) config.physics.gravityX = v;
  }
  if (env.GRAVITY_Y !== undefined) {
    const v = parseFloat(env.GRAVITY_Y);
    if (Number.isFinite(v)) config.physics.gravityY = v;
  }
  if (env.ENABLE_SLEEPING !== undefined) {
    const v = env.ENABLE_SLEEPING.toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') {
      config.physics.enableSleeping = true;
    } else if (v === 'false' || v === '0' || v === 'no') {
      config.physics.enableSleeping = false;
    }
  }
  if (env.WORLD_AABB_EXTENT !== undefined) {
    const v = parseFloat(env.WORLD_AABB_EXTENT);
    if (Number.isFinite(v) && v >= 100) config.physics.worldAabbExtent = v;
  }

  // Arena (documented arena.* surfaces)
  if (env.ARENA_HALF_WIDTH !== undefined) {
    const v = parseFloat(env.ARENA_HALF_WIDTH);
    if (Number.isFinite(v) && v >= 1) config.arena.defaultHalfWidth = v;
  }
  if (env.ARENA_HALF_HEIGHT !== undefined) {
    const v = parseFloat(env.ARENA_HALF_HEIGHT);
    if (Number.isFinite(v) && v >= 1) config.arena.defaultHalfHeight = v;
  }
  if (env.ARENA_BOUNDS_MARGIN !== undefined) {
    const v = parseFloat(env.ARENA_BOUNDS_MARGIN);
    if (Number.isFinite(v) && v >= 0) config.arena.boundsMargin = v;
  }

  // Player movement (documented player.* surfaces)
  if (env.PLAYER_MOVE_FORCE !== undefined) {
    const v = parseFloat(env.PLAYER_MOVE_FORCE);
    if (Number.isFinite(v) && v >= 0.01) config.player.moveForce = v;
  }
  if (env.PLAYER_HEAVY_MASS_MULTIPLIER !== undefined) {
    const v = parseFloat(env.PLAYER_HEAVY_MASS_MULTIPLIER);
    if (Number.isFinite(v) && v > 0) config.player.heavyMassMultiplier = v;
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

      case '--bind-address':
        if (next) {
          config.server.bindAddress = next;
          i++;
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

      case '--zmq-backlog':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) {
            config.server.zmqBacklog = v;
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

      case '--report-interval-ms':
        if (next) {
          const v = parseInt(next, 10);
          if (!isNaN(v) && v > 0) {
            config.telemetry.reportIntervalMs = v;
            i++;
          }
        }
        break;

      case '--workers':
      case '--num-workers':
      case '-w':
        if (next) {
          const v = parseLegacyInteger(next);
          if (v !== null && v >= 0) {
            config.workerPool.numWorkers = v;
            i++;
          }
        }
        break;

      case '--max-workers':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) {
            config.workerPool.maxWorkers = v;
            i++;
          }
        }
        break;

      case '--ring-buffer-size':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && isPowerOfTwo(v)) {
            config.workerPool.ringBufferSize = v;
            i++;
          }
        }
        break;

      case '--message-timeout-ms':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 100 && v <= MAX_ZMQ_OPTION) {
            config.workerPool.messageTimeoutMs = v;
            i++;
          }
        }
        break;

      case '--step-timeout-ms':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 100 && v <= MAX_ZMQ_OPTION) {
            config.workerPool.stepTimeoutMs = v;
            i++;
          }
        }
        break;

      case '--no-shared-mem':
        config.workerPool.useSharedMemory = false;
        break;

      case '--use-shared-memory':
        config.workerPool.useSharedMemory = true;
        break;

      case '--socket-type':
        if (next) {
          if (next === 'ROUTER' || next === 'DEALER' || next === 'REP' || next === 'REQ') {
            config.ipc.socketType = next;
            i++;
          }
        }
        break;

      case '--serialization':
        if (next) {
          if (next === 'json' || next === 'msgpack') {
            config.ipc.serialization = next;
            i++;
          }
        }
        break;

      case '--tcp-keepalive':
        if (next) {
          const v = parseInteger(next);
          if (v === 0 || v === 1) {
            config.ipc.tcpKeepalive = v;
            i++;
          }
        }
        break;

      case '--snd-hwm':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) {
            config.ipc.sndHwm = v;
            i++;
          }
        }
        break;

      case '--rcv-hwm':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) {
            config.ipc.rcvHwm = v;
            i++;
          }
        }
        break;

      case '--linger-ms':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 0 && v <= MAX_ZMQ_OPTION) {
            config.ipc.lingerMs = v;
            i++;
          }
        }
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
      // Documented spelling (config.example.json: _doc_defaultMapPath);
      // only the undocumented --map alias was wired before (#413).
      case '--default-map-path':
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

      case '--frame-skip':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 1 && v <= MAX_FRAME_SKIP) {
            config.environment.frameSkip = v;
            i++;
          }
        }
        break;

      case '--max-ticks':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 1 && v <= MAX_ZMQ_OPTION) {
            config.environment.maxTicks = v;
            i++;
          }
        }
        break;

      case '--num-opponents':
        if (next) {
          const v = parseInteger(next);
          if (v !== null && v >= 0 && v <= MAX_NUM_OPPONENTS) {
            config.environment.numOpponents = v;
            i++;
          }
        }
        break;

      case '--no-random-opponent':
        config.environment.randomOpponent = false;
        break;

      case '--random-opponent':
        // Bare flag enables the random policy (--telemetry style). An
        // explicit boolean token is consumed so `--random-opponent
        // false` disables it instead of enabling the policy and
        // silently dropping "false" as an unknown argument (#413).
        // Common negative spellings are part of the false-set so a token
        // like "off" cannot invert the user's intent (#413 review).
        if (next) {
          const t = next.toLowerCase();
          if (t === 'true' || t === '1' || t === 'yes') {
            config.environment.randomOpponent = true;
            i++;
          } else if (t === 'false' || t === '0' || t === 'no' || t === 'off' || t === 'disable') {
            config.environment.randomOpponent = false;
            i++;
          } else {
            config.environment.randomOpponent = true;
          }
        } else {
          config.environment.randomOpponent = true;
        }
        break;

      case '--ticks-per-second':
        if (next) {
          const v = parseInt(next, 10);
          if (!isNaN(v) && v >= 1 && v <= 240) {
            config.physics.ticksPerSecond = v;
            i++;
          }
        }
        break;

      case '--solver-iterations':
        if (next) {
          if (applySolverIterations(config, parseInt(next, 10))) {
            i++;
          }
        }
        break;

      case '--scale':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v > 0) {
            config.physics.scale = v;
            i++;
          }
        }
        break;

      case '--gravity-x':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v)) {
            config.physics.gravityX = v;
            i++;
          }
        }
        break;

      case '--gravity-y':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v)) {
            config.physics.gravityY = v;
            i++;
          }
        }
        break;

      case '--enable-sleeping':
        config.physics.enableSleeping = true;
        break;

      case '--disable-sleeping':
        config.physics.enableSleeping = false;
        break;

      case '--world-aabb-extent':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v >= 100) {
            config.physics.worldAabbExtent = v;
            i++;
          }
        }
        break;

      case '--arena-half-width':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v >= 1) {
            config.arena.defaultHalfWidth = v;
            i++;
          }
        }
        break;

      case '--arena-half-height':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v >= 1) {
            config.arena.defaultHalfHeight = v;
            i++;
          }
        }
        break;

      case '--arena-bounds-margin':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v >= 0) {
            config.arena.boundsMargin = v;
            i++;
          }
        }
        break;

      case '--player-move-force':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v >= 0.01) {
            config.player.moveForce = v;
            i++;
          }
        }
        break;

      case '--player-heavy-mass-multiplier':
        if (next) {
          const v = parseFloat(next);
          if (Number.isFinite(v) && v > 0) {
            config.player.heavyMassMultiplier = v;
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
              case '--random-opp-move-prob':
                config.environment.randomOppMoveProb = v;
                break;
              case '--random-opp-up-prob':
                config.environment.randomOppUpProb = v;
                break;
              case '--random-opp-down-prob':
                config.environment.randomOppDownProb = v;
                break;
              case '--random-opp-heavy-prob':
                config.environment.randomOppHeavyProb = v;
                break;
              case '--random-opp-grapple-prob':
                config.environment.randomOppGrappleProb = v;
                break;
            }
            i++;
          }
        }
        break;

      case '--kill-reward':
      case '--death-penalty':
      case '--time-penalty':
        if (next) {
          // Reward weights are signed floats (negative penalties are
          // the documented defaults). Only fully-parsed finite values
          // are applied; --death-penalty/--time-penalty must be
          // non-positive (a positive penalty would reward the very
          // event it names) and are otherwise ignored (#220).
          const v = parseFiniteFloat(next);
          const isPenalty = arg !== '--kill-reward';
          if (v !== null && (!isPenalty || v <= 0)) {
            switch (arg) {
              case '--kill-reward':
                config.reward.killReward = v;
                break;
              case '--death-penalty':
                config.reward.deathPenalty = v;
                break;
              case '--time-penalty':
                config.reward.timePenalty = v;
                break;
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
 * Symbol key carrying the physics provenance Set on each resolved AppConfig.
 *
 * The marker is attached non-enumerably so it never survives a deepMerge
 * spread or reaches IPC serialization, and non-configurably so a
 * delete-then-reassign cannot re-create it as enumerable. It tracks the
 * physics keys authored by config.json, environment variables, or CLI flags
 * for THAT resolution pass: the built-in solverIterations default is retained
 * in AppConfig for compatibility, but is not an explicit per-environment
 * override (#325). Binding provenance to the config object itself keeps it
 * coupled to the cached config — a module-global set could silently drift from
 * the config it describes and make mergeEngineSections output depend on load
 * history.
 *
 * Exported so tests can verify the marker's non-enumerable, non-configurable
 * descriptor contract without iterating unrelated own symbols (#325).
 */
export const PHYSICS_PROVENANCE = Symbol('physics-provenance');

function physicsProvenance(config: AppConfig): Set<string> {
  const holder = config as AppConfig & { [PHYSICS_PROVENANCE]?: Set<string> };
  if (holder[PHYSICS_PROVENANCE] === undefined) {
    const set = new Set<string>();
    // Non-enumerable so a deepMerge spread never copies it by reference
    // (a plain assignment would make it enumerable and the guarantee in
    // the docstring above would only hold by call ordering). Also
    // non-configurable: a delete-then-reassign would otherwise re-create
    // the property via plain assignment as enumerable, silently
    // un-enforcing the guarantee.
    Object.defineProperty(holder, PHYSICS_PROVENANCE, {
      value: set,
      enumerable: false,
      writable: true,
      configurable: false,
    });
  }
  return holder[PHYSICS_PROVENANCE] as Set<string>;
}

/**
 * Record physics keys explicitly authored by a config.json `physics` object.
 * Both the camelCase key and the documented snake_case alias count as
 * explicit: a config.json authoring `solver_iterations` is accepted via
 * PHYSICS_KEY_ALIASES and must survive the mergeEngineSections delete just
 * like `solverIterations`.
 */
function recordExplicitPhysicsKeys(config: AppConfig, physics: unknown): void {
  if (!isPlainObject(physics)) return;
  if (
    (Object.prototype.hasOwnProperty.call(physics, 'solverIterations') && physics.solverIterations != null) ||
    (Object.prototype.hasOwnProperty.call(physics, 'solver_iterations') && physics.solver_iterations != null)
  ) {
    physicsProvenance(config).add('solverIterations');
  }
}

/**
 * Apply a solverIterations value parsed from the SOLVER_ITERATIONS env var or
 * the --solver-iterations CLI flag. The [1,64] range gate and the provenance
 * registration live together so the two authoring sources can never drift
 * (#325). Returns true when the value was applied (the CLI parser consumes the
 * flag's value only then).
 */
function applySolverIterations(config: AppConfig, v: number): boolean {
  if (isNaN(v) || v < 1 || v > 64) return false;
  config.physics.solverIterations = v;
  physicsProvenance(config).add('solverIterations');
  return true;
}

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
      // deepMerge spreads enumerable keys, so provenance must be recorded
      // on the merged object (it does not survive the spread).
      recordExplicitPhysicsKeys(config, fileConfig.physics);
      if (isPlainObject(fileConfig.physics)) {
        // Resolve snake_case aliases against the injected camelCase
        // defaults so a config.json `solver_iterations`/`ticks_per_second`
        // is not shadowed by the always-present camelCase default
        // (mirrors the environment section, #204/#325).
        config.physics = mergeTuningSection(
          config.physics as any,
          fileConfig.physics as any,
          PHYSICS_KEY_ALIASES,
        ) as PhysicsConfig;
      }
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
        recordExplicitPhysicsKeys(config, fileConfig.physics);
        if (isPlainObject(fileConfig.physics)) {
          config.physics = mergeTuningSection(
            config.physics as any,
            fileConfig.physics as any,
            PHYSICS_KEY_ALIASES,
          ) as PhysicsConfig;
        }
        if (isPlainObject(fileConfig.environment)) {
          config.environment = mergeEnvironmentConfig(
            config.environment as any,
            fileConfig.environment as any,
          ) as EnvironmentConfig;
        }
      }
    }
  }

  // Normalize config-file values before the later layers consume their
  // sections, then normalize once more after env/CLI precedence is applied.
  config = normalizeResolvedConfig(config);

  // Layer 3: environment variables
  config = applyEnvOverrides(config);

  // Layer 4: CLI flags
  config = parseCliFlags(config);

  // Normalize the final resolved values, including env/CLI overrides.
  config = normalizeResolvedConfig(config);

  // Resolve numWorkers=0 to actual CPU count. Sanitize every configured
  // value to a positive integer so a misconfigured workerPool can never
  // silently disable the pool or defer a NaN/float to the WorkerPool runtime
  // guard: non-numeric maxWorkers falls back to the CPU count, and negative,
  // non-numeric, or fractional numWorkers clamp/floor to >= 1 (#269).
  if (config.workerPool.numWorkers === 0) {
    config.workerPool.numWorkers = Number.isFinite(config.workerPool.maxWorkers)
      ? Math.max(1, Math.min(os.cpus().length, Math.max(1, Math.floor(config.workerPool.maxWorkers))))
      : Math.max(1, os.cpus().length);
  } else if (!Number.isFinite(config.workerPool.numWorkers) || config.workerPool.numWorkers < 1) {
    config.workerPool.numWorkers = 1;
  } else if (!Number.isInteger(config.workerPool.numWorkers)) {
    config.workerPool.numWorkers = Math.max(1, Math.floor(config.workerPool.numWorkers));
  }

  cachedConfig = config;
  return config;
}

/**
 * Reset the cached config. Primarily used for testing. The config-bound
 * physics provenance dies with the cached object, so a subsequent load always
 * starts from a clean pass.
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
