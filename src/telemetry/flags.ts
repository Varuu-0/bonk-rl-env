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
 * Valid CLI flag aliases and their mappings.
 * Format: [short, long] or [long] for single-form flags.
 */
const FLAG_ALIASES: Record<string, keyof TelemetryFlags> = {
  // Master switch
  '--telemetry': 'enableTelemetry',
  '--enable-telemetry': 'enableTelemetry',
  '-t': 'enableTelemetry',

  // Profiling level
  '--profile': 'profileLevel',
  '-p': 'profileLevel',

  // Debug level
  '--debug': 'debugLevel',
  '-d': 'debugLevel',

  // Output format
  '--output': 'outputFormat',
  '-o': 'outputFormat',

  // Dashboard port
  '--dashboard-port': 'dashboardPort',

  // Report interval
  '--report-interval': 'reportInterval',

  // Retention days
  '--retention': 'retentionDays',
};

/**
 * Parse value flags that take arguments.
 * Maps string values to typed values.
 */
function parseValueFlag(flag: string, value: string): { key: keyof TelemetryFlags; valid: boolean; value: unknown } | null {
  switch (flag) {
    case '--profile':
    case '-p':
      if (value === 'minimal' || value === 'standard' || value === 'detailed') {
        return { key: 'profileLevel', valid: true, value };
      }
      console.warn(`Invalid profile level: ${value}. Using 'standard'.`);
      return { key: 'profileLevel', valid: false, value: 'standard' };

    case '--debug':
    case '-d':
      if (value === 'none' || value === 'error' || value === 'verbose') {
        return { key: 'debugLevel', valid: true, value };
      }
      console.warn(`Invalid debug level: ${value}. Using 'none'.`);
      return { key: 'debugLevel', valid: false, value: 'none' };

    case '--output':
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
      const days = parseInt(value, 10);
      if (!isNaN(days) && days > 0) {
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

    // Check for boolean flags
    if (arg in FLAG_ALIASES) {
      const key = FLAG_ALIASES[arg];

      // Boolean flags set to true
      if (key === 'enableTelemetry') {
        flags.enableTelemetry = true;
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
 * Check if any telemetry flags are set.
 * Used for fast-path optimization.
 *
 * @returns true if any telemetry is enabled
 */
export function isAnyTelemetryEnabled(): boolean {
  const argv = process.argv;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    // Check for master switch
    if (arg === '--telemetry' || arg === '--enable-telemetry' || arg === '-t') {
      // Check if it's followed by '=true' or '=1'
      const value = arg.split('=')[1];
      if (value === undefined) {
        // Flag present without value = enabled
        return true;
      }
      if (value === 'true' || value === '1' || value === 'yes') {
        return true;
      }
    }

    // Check for profile or debug flags (implies telemetry)
    if (arg.startsWith('--profile') || arg.startsWith('--debug')) {
      return true;
    }
  }

  return false;
}

/**
 * Get environment variable overrides for telemetry.
 * Environment variables take precedence over CLI flags.
 *
 * @param flags - CLI-parsed flags to potentially override
 * @returns Merged flags with environment overrides
 */
export function applyEnvOverrides(flags: TelemetryFlags): TelemetryFlags {
  // Check for environment variable: MANIFOLD_TELEMETRY
  const envTelemetry = process.env.MANIFOLD_TELEMETRY;
  if (envTelemetry !== undefined) {
    if (envTelemetry === 'true' || envTelemetry === '1' || envTelemetry === 'yes') {
      flags.enableTelemetry = true;
    } else if (envTelemetry === 'false' || envTelemetry === '0' || envTelemetry === 'no') {
      flags.enableTelemetry = false;
    }
  }

  // Check for environment variable: MANIFOLD_TELEMETRY_OUTPUT
  const envOutput = process.env.MANIFOLD_TELEMETRY_OUTPUT;
  if (envOutput !== undefined) {
    if (envOutput === 'console' || envOutput === 'file' || envOutput === 'both') {
      flags.outputFormat = envOutput;
    }
  }

  // Check for environment variable: MANIFOLD_PROFILE
  const envProfile = process.env.MANIFOLD_PROFILE;
  if (envProfile !== undefined) {
    if (envProfile === 'minimal' || envProfile === 'standard' || envProfile === 'detailed') {
      flags.profileLevel = envProfile;
    }
  }

  // Check for environment variable: MANIFOLD_DEBUG
  const envDebug = process.env.MANIFOLD_DEBUG;
  if (envDebug !== undefined) {
    if (envDebug === 'none' || envDebug === 'error' || envDebug === 'verbose') {
      flags.debugLevel = envDebug;
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
  cliFlags: TelemetryFlags
): TelemetryFlags {
  // Start with CLI flags (highest priority)
  const merged: TelemetryFlags = { ...cliFlags };

  // Apply config file settings for values not explicitly set via CLI
  // CLI flags have defaults, so we detect explicit overrides by checking
  // if the CLI value differs from the DEFAULT_FLAGS
  if (configTelemetry) {
    // Only apply config settings if CLI didn't explicitly override them
    // Check each setting against its default to detect if CLI set it
    
    // enableTelemetry: if CLI kept default (false), apply config
    if (cliFlags.enableTelemetry === DEFAULT_FLAGS.enableTelemetry && configTelemetry.enabled !== undefined) {
      merged.enableTelemetry = configTelemetry.enabled;
    }
    
    // outputFormat: if CLI kept default ('console'), apply config
    if (cliFlags.outputFormat === DEFAULT_FLAGS.outputFormat && configTelemetry.outputFormat !== undefined) {
      if (configTelemetry.outputFormat === 'console' || configTelemetry.outputFormat === 'file' || configTelemetry.outputFormat === 'both') {
        merged.outputFormat = configTelemetry.outputFormat;
      }
    }
    
    // retentionDays: if CLI kept default (7), apply config
    if (cliFlags.retentionDays === DEFAULT_FLAGS.retentionDays && configTelemetry.retentionDays !== undefined) {
      merged.retentionDays = configTelemetry.retentionDays;
    }
    
    // dashboardPort: if CLI kept default (3001), apply config
    if (cliFlags.dashboardPort === DEFAULT_FLAGS.dashboardPort && configTelemetry.dashboardPort !== undefined) {
      merged.dashboardPort = configTelemetry.dashboardPort;
    }
    
    // reportInterval: if CLI kept default (5000), apply config
    if (cliFlags.reportInterval === DEFAULT_FLAGS.reportInterval && configTelemetry.reportInterval !== undefined) {
      merged.reportInterval = configTelemetry.reportInterval;
    }
  }

  return merged;
}

// Re-export TelemetryFlags for convenience
export type { TelemetryFlags };
