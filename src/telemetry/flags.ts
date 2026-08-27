/**
 * CLI Flag Parser for Telemetry System
 *
 * Parses command-line arguments to configure telemetry settings.
 * Supports both boolean flags and value flags with aliases.
 *
 * Zero-allocation: No objects created during flag parsing.
 * Uses process.argv directly without external dependencies.
 */

import { TelemetryFlags } from '../types/index.d';

/**
 * Default telemetry flags - all disabled for maximum performance.
 */
const DEFAULT_FLAGS: TelemetryFlags = {
  enableTelemetry: false,
  profileLevel: 'standard',
  debugLevel: 'none',
  outputFormat: 'console',
  dashboardPort: 3001,
  reportInterval: 5000,
  retentionDays: 7,
};

/**
 * Tracks which telemetry flag keys were EXPLICITLY provided via CLI args or env vars.
 * Populated by parseFlags() and applyEnvOverrides(); consumed by mergeConfigWithFlags().
 */
let _explicitFlagKeys: Set<string> = new Set();

/**
 * Strictly parse a whole-string integer from an env/CLI value — the local
 * mirror of config-loader.ts's parseInteger() (INTEGER_NUMERIC_RE +
 * Number.isSafeInteger). Used for the documented RETENTION_DAYS knob so
 * "30abc" is rejected on the controller path exactly like the server path,
 * without importing the whole config-loader into worker bundles (#459
 * review).
 */
function parseStrictInteger(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Returns the set of explicitly-provided flag keys from the last parseFlags()/applyEnvOverrides() run.
 */
export function getExplicitFlagKeys(): Set<string> {
  return _explicitFlagKeys;
}

/**
 * Valid CLI flag aliases and their mappings.
 * Format: [short, long] or [long] for single-form flags.
 */
const FLAG_ALIASES: Record<string, keyof TelemetryFlags> = {
  // Master switch
  '--telemetry': 'enableTelemetry',
  '--enable-telemetry': 'enableTelemetry',
  // Documented long form (config.example.json, issue #459)
  '--telemetry-enabled': 'enableTelemetry',
  '-t': 'enableTelemetry',

  // Profiling level
  // NOTE: `-p` is deliberately NOT an alias here — it belongs to `--port` in
  // config-loader. Use `-l` (or `--profile-level`) instead, so the two parsers
  // never read the same short flag with different meanings (issue #184).
  '--profile': 'profileLevel',
  '--profile-level': 'profileLevel',
  '-l': 'profileLevel',

  // Debug level
  '--debug': 'debugLevel',
  // Documented long form (config.example.json, issue #459)
  '--debug-level': 'debugLevel',
  '-d': 'debugLevel',

  // Output format
  '--output': 'outputFormat',
  // Documented long form (config.example.json, issue #459)
  '--output-format': 'outputFormat',
  '-o': 'outputFormat',

  // Dashboard port
  '--dashboard-port': 'dashboardPort',

  // Report interval
  '--report-interval': 'reportInterval',

  // Retention days
  '--retention': 'retentionDays',
  // Documented long form (config.example.json, issue #459)
  '--retention-days': 'retentionDays',
};

/**
 * Parse value flags that take arguments.
 * Maps string values to typed values.
 */
function parseValueFlag(flag: string, value: string): { key: keyof TelemetryFlags; valid: boolean; value: unknown } | null {
  switch (flag) {
    case '--profile':
    case '--profile-level':
    case '-l':
      if (value === 'minimal' || value === 'standard' || value === 'detailed') {
        return { key: 'profileLevel', valid: true, value };
      }
      console.warn(`Invalid profile level: ${value}. Using 'standard'.`);
      return { key: 'profileLevel', valid: false, value: 'standard' };

    case '--debug':
    case '--debug-level':
    case '-d':
      if (value === 'none' || value === 'error' || value === 'verbose') {
        return { key: 'debugLevel', valid: true, value };
      }
      console.warn(`Invalid debug level: ${value}. Using 'none'.`);
      return { key: 'debugLevel', valid: false, value: 'none' };

    case '--output':
    case '--output-format':
    case '-o':
      if (value === 'console' || value === 'file' || value === 'both') {
        return { key: 'outputFormat', valid: true, value };
      }
      console.warn(`Invalid output format: ${value}. Using 'console'.`);
      return { key: 'outputFormat', valid: false, value: 'console' };

    case '--dashboard-port':
      const port = parseInt(value, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        return { key: 'dashboardPort', valid: true, value: port };
      }
      console.warn(`Invalid dashboard port: ${value}. Using 3001.`);
      return { key: 'dashboardPort', valid: false, value: 3001 };

    case '--report-interval':
      const interval = parseInt(value, 10);
      if (!isNaN(interval) && interval > 0) {
        return { key: 'reportInterval', valid: true, value: interval };
      }
      console.warn(`Invalid report interval: ${value}. Using 5000.`);
      return { key: 'reportInterval', valid: false, value: 5000 };

    case '--retention':
    case '--retention-days':
      // Same strict integer contract as config-loader's RETENTION_DAYS knob,
      // so '30abc' can never become 30 on one layer and 7 on the other
      // (#459 review).
      const days = parseStrictInteger(value);
      if (days !== null && days > 0) {
        return { key: 'retentionDays', valid: true, value: days };
      }
      console.warn(`Invalid retention days: ${value}. Using 7.`);
      return { key: 'retentionDays', valid: false, value: 7 };

    default:
      return null;
  }
}

/**
 * Parse CLI arguments and return TelemetryFlags.
 *
 * This function is designed for zero-allocation - it uses
 * a pre-allocated flags object and only creates new values
 * when explicitly set by the user.
 *
 * @returns Parsed TelemetryFlags with defaults applied
 */
export function parseFlags(): TelemetryFlags {
  // Reset explicit keys tracking
  _explicitFlagKeys = new Set();

  // Start with defaults - no allocation needed
  const flags: TelemetryFlags = {
    enableTelemetry: DEFAULT_FLAGS.enableTelemetry,
    profileLevel: DEFAULT_FLAGS.profileLevel,
    debugLevel: DEFAULT_FLAGS.debugLevel,
    outputFormat: DEFAULT_FLAGS.outputFormat,
    dashboardPort: DEFAULT_FLAGS.dashboardPort,
    reportInterval: DEFAULT_FLAGS.reportInterval,
    retentionDays: DEFAULT_FLAGS.retentionDays,
  };

  // Get raw argv - no allocation
  const argv = process.argv;
  const argc = argv.length;

  // Parse arguments
  for (let i = 2; i < argc; i++) {
    const arg = argv[i];

    // Skip non-flag arguments
    if (!arg.startsWith('-')) {
      continue;
    }

    // Documented master switch with an inline value (#459 review): honor
    // --telemetry-enabled=true/false exactly like isAnyTelemetryEnabled()'s
    // fast path, instead of silently skipping the '='-joined token and
    // letting the fallback and this parser disagree on the same argv.
    if (arg.startsWith('--telemetry-enabled=')) {
      const value = arg.slice('--telemetry-enabled='.length).toLowerCase();
      if (value === 'true' || value === '1' || value === 'yes') {
        flags.enableTelemetry = true;
        _explicitFlagKeys.add('enableTelemetry');
      } else if (value === 'false' || value === '0' || value === 'no') {
        flags.enableTelemetry = false;
        _explicitFlagKeys.add('enableTelemetry');
      }
      continue;
    }

    // Check for boolean flags
    if (arg in FLAG_ALIASES) {
      const key = FLAG_ALIASES[arg];

      // Boolean flags set to true
      if (key === 'enableTelemetry') {
        flags.enableTelemetry = true;
        _explicitFlagKeys.add('enableTelemetry');
      }
      // Value flags need the next argument
      else if (
        key === 'profileLevel' ||
        key === 'debugLevel' ||
        key === 'outputFormat' ||
        key === 'dashboardPort' ||
        key === 'reportInterval' ||
        key === 'retentionDays'
      ) {
        // Check if there's a next argument
        if (i + 1 < argc) {
          const nextArg = argv[i + 1];
          // Only use it if it doesn't look like another flag
          if (!nextArg.startsWith('-')) {
            const result = parseValueFlag(arg, nextArg);
            if (result) {
              if (result.valid) {
                _explicitFlagKeys.add(result.key);
              }
              // Use type-safe property assignments instead of `as any`
              switch (result.key) {
                case 'profileLevel':
                  flags.profileLevel = result.value as 'minimal' | 'standard' | 'detailed';
                  break;
                case 'debugLevel':
                  flags.debugLevel = result.value as 'none' | 'error' | 'verbose';
                  break;
                case 'outputFormat':
                  flags.outputFormat = result.value as 'console' | 'file' | 'both';
                  break;
                case 'dashboardPort':
                  flags.dashboardPort = result.value as number;
                  break;
                case 'reportInterval':
                  flags.reportInterval = result.value as number;
                  break;
                case 'retentionDays':
                  flags.retentionDays = result.value as number;
                  break;
              }
              if (result.valid && (result.key === 'profileLevel' || result.key === 'debugLevel')) {
                flags.enableTelemetry = true;
                _explicitFlagKeys.add('enableTelemetry');
              }
              i++; // Skip the value argument
            }
          }
        }
      }
    }
  }

  return flags;
}

/**
 * Check if any telemetry activation is requested.
 * Used for fast-path optimization.
 *
 * Mirrors the CLI + env activation surface that parseFlags() +
 * applyEnvOverrides() resolve inside initialize(), so workers and embedded
 * consumers — which never call initialize() and never load config.json —
 * honor MANIFOLD_PROFILE / MANIFOLD_DEBUG / MANIFOLD_TELEMETRY (and their
 * documented config.example.json spellings TELEMETRY_ENABLED / PROFILE_LEVEL /
 * DEBUG_LEVEL, issue #459) the same way
 * the standalone server does on its CLI/env path (issue #389):
 * - The explicit MANIFOLD_TELEMETRY master switch wins over everything,
 *   including argv flags, exactly like applyEnvOverrides().
 * - A valid MANIFOLD_PROFILE / MANIFOLD_DEBUG selection implies telemetry,
 *   exactly like the equivalent --profile/--debug CLI flags.
 * The config-file layer (config telemetry.enabled, reportIntervalMs, ...) is
 * an initialize()-path concern and is intentionally not consulted here.
 *
 * @returns true if any telemetry is enabled
 */
export function isAnyTelemetryEnabled(): boolean {
  // Environment activation is evaluated first so an explicit master switch
  // always wins over argv, matching the initialize() pipeline where env
  // overrides CLI flags. MANIFOLD_TELEMETRY is matched case-insensitively,
  // exactly like config-loader.ts, so uppercase values (TRUE/NO/...) mean the
  // same thing on the server path and on this fallback path.
  const envTelemetry = process.env.MANIFOLD_TELEMETRY;
  if (envTelemetry !== undefined) {
    const telemetryValue = envTelemetry.toLowerCase();
    if (telemetryValue === 'true' || telemetryValue === '1' || telemetryValue === 'yes') {
      return true;
    }
    if (telemetryValue === 'false' || telemetryValue === '0' || telemetryValue === 'no') {
      return false;
    }
  }

  // Documented master switch (config.example.json, issue #459), evaluated
  // after MANIFOLD_TELEMETRY so the established name wins when both are set.
  // Matched case-insensitively and trimmed so a CRLF-carrying value from an
  // env file means the same thing here as in config-loader.ts (#459 review).
  const envTelemetryEnabled = process.env.TELEMETRY_ENABLED;
  if (envTelemetryEnabled !== undefined) {
    const telemetryValue = envTelemetryEnabled.trim().toLowerCase();
    if (telemetryValue === 'true' || telemetryValue === '1' || telemetryValue === 'yes') {
      return true;
    }
    if (telemetryValue === 'false' || telemetryValue === '0' || telemetryValue === 'no') {
      return false;
    }
  }

  // Selecting a profile level implies telemetry, exactly like the CLI
  // --profile/-l flags in parseFlags() (issue #385).
  const envProfile = process.env.MANIFOLD_PROFILE;
  if (envProfile === 'minimal' || envProfile === 'standard' || envProfile === 'detailed') {
    return true;
  }

  // Documented spelling (config.example.json, issue #459), evaluated after
  // MANIFOLD_PROFILE so the established name wins when both are set. Trimmed
  // like config-loader.ts so a CRLF-carrying env value resolves identically
  // on both paths (#459 review).
  const envProfileLevel = process.env.PROFILE_LEVEL;
  if (envProfileLevel !== undefined && ['minimal', 'standard', 'detailed'].includes(envProfileLevel.trim())) {
    return true;
  }

  // Selecting a debug level implies telemetry, exactly like the CLI
  // --debug/-d flags in parseFlags() (issue #385).
  const envDebug = process.env.MANIFOLD_DEBUG;
  if (envDebug === 'none' || envDebug === 'error' || envDebug === 'verbose') {
    return true;
  }

  // Documented spelling (config.example.json, issue #459), evaluated after
  // MANIFOLD_DEBUG so the established name wins when both are set. Trimmed
  // like config-loader.ts (#459 review).
  const envDebugLevel = process.env.DEBUG_LEVEL;
  if (envDebugLevel !== undefined && ['none', 'error', 'verbose'].includes(envDebugLevel.trim())) {
    return true;
  }

  const argv = process.argv;

  // Master-switch tokens resolve last-wins across the full argv list,
  // exactly like parseFlags()/parseCliFlags() apply them in token order
  // (#459 review): a bare master switch enables, an inline
  // --telemetry-enabled=<value> sets the value, and a later token overrides
  // an earlier one, so the fast path can never disagree with the
  // initialize() resolution on the same argv.
  let masterSwitchEnabled = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    // Check for master switch
    if (arg === '--telemetry' || arg === '--enable-telemetry' || arg === '--telemetry-enabled' || arg === '-t') {
      // Flag present without value = enabled
      masterSwitchEnabled = true;
      continue;
    }
    if (arg.startsWith('--telemetry-enabled=')) {
      const value = arg.slice('--telemetry-enabled='.length).toLowerCase();
      if (value === 'true' || value === '1' || value === 'yes') {
        masterSwitchEnabled = true;
      } else if (value === 'false' || value === '0' || value === 'no') {
        masterSwitchEnabled = false;
      }
      // A garbage inline value does not touch the switch, exactly like
      // parseFlags() leaves the default in place for that token.
      continue;
    }

    // Keep the fast path exactly aligned with parseFlags(): only the
    // space-separated, valid-value forms imply telemetry.
    const nextArg = argv[i + 1];
    if ((arg === '--profile' || arg === '--profile-level' || arg === '-l') &&
        (nextArg === 'minimal' || nextArg === 'standard' || nextArg === 'detailed')) {
      return true;
    }
    if ((arg === '--debug' || arg === '--debug-level' || arg === '-d') &&
        (nextArg === 'none' || nextArg === 'error' || nextArg === 'verbose')) {
      return true;
    }
  }

  return masterSwitchEnabled;
}

/**
 * Get environment variable overrides for telemetry.
 * Environment variables take precedence over CLI flags.
 *
 * @param flags - CLI-parsed flags to potentially override
 * @returns Merged flags with environment overrides
 */
export function applyEnvOverrides(flags: TelemetryFlags): TelemetryFlags {
  // Documented env names (config.example.json, issue #459). The level/format
  // selectors are applied BEFORE their MANIFOLD_* counterparts so the
  // established MANIFOLD_* names keep winning when both spellings are set.
  // The TELEMETRY_ENABLED master switch is applied after the level selectors
  // (an explicit switch beats an implied activation) but before
  // MANIFOLD_TELEMETRY (the established master switch still wins).
  // Values are trimmed so a CRLF-carrying env-file value resolves identically
  // to config-loader.ts (#459 review).
  const envOutputFormat = process.env.OUTPUT_FORMAT;
  if (envOutputFormat !== undefined) {
    const outputFormat = envOutputFormat.trim();
    if (outputFormat === 'console' || outputFormat === 'file' || outputFormat === 'both') {
      flags.outputFormat = outputFormat;
      _explicitFlagKeys.add('outputFormat');
    }
  }

  const envProfileLevel = process.env.PROFILE_LEVEL;
  if (envProfileLevel !== undefined) {
    const profileLevel = envProfileLevel.trim();
    if (profileLevel === 'minimal' || profileLevel === 'standard' || profileLevel === 'detailed') {
      flags.profileLevel = profileLevel;
      // Selecting a profile level implies telemetry, exactly like the CLI
      // --profile-level flag and the MANIFOLD_PROFILE override below.
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  const envDebugLevel = process.env.DEBUG_LEVEL;
  if (envDebugLevel !== undefined) {
    const debugLevel = envDebugLevel.trim();
    if (debugLevel === 'none' || debugLevel === 'error' || debugLevel === 'verbose') {
      flags.debugLevel = debugLevel;
      // Selecting a debug level implies telemetry, exactly like the CLI
      // --debug-level flag and the MANIFOLD_DEBUG override below.
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  // Documented retention window (config.example.json, issue #459). Parsed
  // with the same strict whole-string integer contract as config-loader.ts
  // so "30abc" is rejected on both paths instead of silently becoming 30
  // here and 7 there (#459 review).
  const envRetentionDays = process.env.RETENTION_DAYS;
  if (envRetentionDays !== undefined) {
    const days = parseStrictInteger(envRetentionDays);
    if (days !== null && days >= 1) {
      flags.retentionDays = days;
      _explicitFlagKeys.add('retentionDays');
    }
  }

  // Check for environment variable: MANIFOLD_TELEMETRY_OUTPUT
  const envOutput = process.env.MANIFOLD_TELEMETRY_OUTPUT;
  if (envOutput !== undefined) {
    if (envOutput === 'console' || envOutput === 'file' || envOutput === 'both') {
      flags.outputFormat = envOutput;
      _explicitFlagKeys.add('outputFormat');
    }
  }

  // Check for environment variable: MANIFOLD_PROFILE
  const envProfile = process.env.MANIFOLD_PROFILE;
  if (envProfile !== undefined) {
    if (envProfile === 'minimal' || envProfile === 'standard' || envProfile === 'detailed') {
      flags.profileLevel = envProfile;
      // Selecting a profile level implies telemetry, exactly like the CLI
      // --profile/-l flags in parseFlags() (issue #385).
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  // Check for environment variable: MANIFOLD_DEBUG
  const envDebug = process.env.MANIFOLD_DEBUG;
  if (envDebug !== undefined) {
    if (envDebug === 'none' || envDebug === 'error' || envDebug === 'verbose') {
      flags.debugLevel = envDebug;
      // Selecting a debug level implies telemetry, exactly like the CLI
      // --debug/-d flags in parseFlags() (issue #385).
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  // Check for environment variable: TELEMETRY_ENABLED — the documented
  // spelling of the MANIFOLD_TELEMETRY master switch (config.example.json,
  // issue #459). Applied after the level selectors (an explicit switch beats
  // an implied activation) but before MANIFOLD_TELEMETRY so the established
  // master switch still wins when both spellings are set.
  const envTelemetryEnabled = process.env.TELEMETRY_ENABLED;
  if (envTelemetryEnabled !== undefined) {
    // Trimmed so a CRLF-carrying env-file value resolves identically to
    // config-loader.ts (#459 review).
    const telemetryValue = envTelemetryEnabled.trim().toLowerCase();
    if (telemetryValue === 'true' || telemetryValue === '1' || telemetryValue === 'yes') {
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    } else if (telemetryValue === 'false' || telemetryValue === '0' || telemetryValue === 'no') {
      flags.enableTelemetry = false;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  // Check for environment variable: MANIFOLD_TELEMETRY. Applied after the
  // level selectors so an explicit master-switch value always wins over the
  // implied activation above (issue #385). Matched case-insensitively so it
  // means the same thing here and in config-loader.ts (and therefore in the
  // un-initialized fallback of isAnyTelemetryEnabled()).
  const envTelemetry = process.env.MANIFOLD_TELEMETRY;
  if (envTelemetry !== undefined) {
    const telemetryValue = envTelemetry.toLowerCase();
    if (telemetryValue === 'true' || telemetryValue === '1' || telemetryValue === 'yes') {
      flags.enableTelemetry = true;
      _explicitFlagKeys.add('enableTelemetry');
    } else if (telemetryValue === 'false' || telemetryValue === '0' || telemetryValue === 'no') {
      flags.enableTelemetry = false;
      _explicitFlagKeys.add('enableTelemetry');
    }
  }

  return flags;
}

/**
 * Merge configuration file settings with CLI flags.
 * CLI flags take precedence over config file.
 *
 * @param configTelemetry - Telemetry config from config.ts
 * @param cliFlags - Parsed CLI flags
 * @returns Merged TelemetryFlags
 */
export function mergeConfigWithFlags(
  configTelemetry: { enabled?: boolean; outputFormat?: string; retentionDays?: number; dashboardPort?: number; reportInterval?: number } | undefined,
  cliFlags: TelemetryFlags,
  explicitKeys?: Set<string>
): TelemetryFlags {
  // Start with CLI flags (highest priority)
  const merged: TelemetryFlags = { ...cliFlags };

  // Helper: determine if a key was explicitly set via CLI/env.
  // When explicitKeys is provided (from parseFlags/applyEnvOverrides), use it directly.
  // When not provided (e.g. manually constructed cliFlags in tests), fall back
  // to comparing the CLI value against the default.
  const notExplicit = (key: string, cliValue: unknown, defaultVal: unknown): boolean => {
    if (explicitKeys && explicitKeys.size > 0) return !explicitKeys.has(key);
    return cliValue === defaultVal;
  };

  // Apply config file settings for values not explicitly set via CLI
  if (configTelemetry) {
    // Only apply config settings if CLI didn't explicitly override them
    
    // enableTelemetry: if not explicitly set, apply config
    if (notExplicit('enableTelemetry', cliFlags.enableTelemetry, DEFAULT_FLAGS.enableTelemetry) && configTelemetry.enabled !== undefined) {
      merged.enableTelemetry = configTelemetry.enabled;
    }
    
    // outputFormat: if not explicitly set, apply config
    if (notExplicit('outputFormat', cliFlags.outputFormat, DEFAULT_FLAGS.outputFormat) && configTelemetry.outputFormat !== undefined) {
      if (configTelemetry.outputFormat === 'console' || configTelemetry.outputFormat === 'file' || configTelemetry.outputFormat === 'both') {
        merged.outputFormat = configTelemetry.outputFormat;
      }
    }
    
    // retentionDays: if not explicitly set, apply config
    if (notExplicit('retentionDays', cliFlags.retentionDays, DEFAULT_FLAGS.retentionDays) && configTelemetry.retentionDays !== undefined) {
      merged.retentionDays = configTelemetry.retentionDays;
    }
    
    // dashboardPort: if not explicitly set, apply config
    if (notExplicit('dashboardPort', cliFlags.dashboardPort, DEFAULT_FLAGS.dashboardPort) && configTelemetry.dashboardPort !== undefined) {
      merged.dashboardPort = configTelemetry.dashboardPort;
    }
    
    // reportInterval: if not explicitly set, apply config
    if (notExplicit('reportInterval', cliFlags.reportInterval, DEFAULT_FLAGS.reportInterval) && configTelemetry.reportInterval !== undefined) {
      merged.reportInterval = configTelemetry.reportInterval;
    }
  }

  return merged;
}

// Re-export TelemetryFlags for convenience
export type { TelemetryFlags };
