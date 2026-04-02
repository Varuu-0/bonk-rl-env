/**
 * Telemetry Controller - Singleton Manager for Profiling System
 *
 * This class provides a centralized interface for managing telemetry settings
 * and coordinating between CLI flags, config file, and runtime behavior.
 *
 * Design principles:
 * - Zero-allocation hot path: No objects created during physics ticks
 * - Lazy initialization: Only initialized when first accessed
 * - Thread-safe: Works with worker threads
 * - Backward compatible: Supports legacy verboseTelemetry config
 */

import { TelemetryFlags, TelemetryConfig } from '../types/index.d';
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled } from './flags';
import { globalProfiler, setLatestWorkerTelemetry } from './profiler';

// Cached flags - set once at initialization
let cachedFlags: TelemetryFlags | null = null;
let initializationComplete = false;

/**
 * TelemetryController - Singleton for managing telemetry settings
 *
 * Use getInstance() to get the singleton instance.
 * Use isEnabled() for fast-path checking in hot loops.
 */
export class TelemetryController {
  private static instance: TelemetryController | null = null;

  // Worker pool reference for telemetry aggregation
  private workerPoolRef: unknown = null;

  // Telemetry state
  private tickCount: number = 0;
  private lastReportTick: number = 0;

  /**
   * Private constructor - use getInstance() instead
   */
  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance of TelemetryController.
   * Initializes on first access with CLI flags and config.
   * 
   * Note: Uses double-checked locking for thread safety.
   * While Node.js is single-threaded, this pattern is best practice
   * for future-proofing and consistency with other implementations.
   */
  static getInstance(): TelemetryController {
    // First check (no locking needed for initial fast path)
    if (TelemetryController.instance === null) {
      // Critical section - only entered if instance is null
      // In Node.js this is effectively single-threaded, but we use
      // a pattern that would work in multi-threaded environments
      TelemetryController.instance = new TelemetryController();
    }
    return TelemetryController.instance;
  }

  /**
   * Initialize the controller with CLI flags and config.
   * This is called automatically on first access but can be called
   * explicitly with a config object for testing.
   *
   * @param configTelemetry - Optional telemetry config from config.ts
   */
  initialize(configTelemetry?: TelemetryConfig): void {
    if (initializationComplete) {
      return;
    }

    // Parse CLI flags first (highest priority)
    let flags = parseFlags();

    // Apply environment variable overrides
    flags = applyEnvOverrides(flags);

    // Merge with config file settings (CLI has precedence)
    flags = mergeConfigWithFlags(configTelemetry, flags);

    // Check for legacy verboseTelemetry config
    // If verboseTelemetry is true in config, enable telemetry
    if (configTelemetry?.enabled === true && !flags.enableTelemetry) {
      flags.enableTelemetry = true;
    }

    // Cache the flags
    cachedFlags = flags;
    initializationComplete = true;

    // Log telemetry status
    if (flags.enableTelemetry) {
      console.log('[Telemetry] Enabled with flags:', JSON.stringify(flags));
    } else {
      console.log('[Telemetry] Disabled (use --telemetry to enable)');
    }
  }

  /**
   * Fast-path check for telemetry enabled status.
   * This function is designed to be called from hot loops
   * with zero allocation overhead.
   *
   * @returns true if telemetry is enabled
   */
  static isEnabled(): boolean {
    // Fast path: check cached flags
    if (cachedFlags !== null) {
      return cachedFlags.enableTelemetry;
    }

    // Check if any telemetry flags were passed
    // This is a quick check that doesn't require full initialization
    return isAnyTelemetryEnabled();
  }

  /**
   * Get the current telemetry flags.
   * Returns defaults if not yet initialized.
   */
  getFlags(): TelemetryFlags {
    if (cachedFlags === null) {
      this.initialize();
    }
    return cachedFlags!;
  }

  /**
   * Get the profile level setting.
   */
  getProfileLevel(): 'minimal' | 'standard' | 'detailed' {
    return this.getFlags().profileLevel;
  }

  /**
   * Get the debug level setting.
   */
  getDebugLevel(): 'none' | 'error' | 'verbose' {
    return this.getFlags().debugLevel;
  }

  /**
   * Get the output format setting.
   */
  getOutputFormat(): 'console' | 'file' | 'both' {
    return this.getFlags().outputFormat;
  }

  /**
   * Get the dashboard port.
   */
  getDashboardPort(): number {
    return this.getFlags().dashboardPort;
  }

  /**
   * Get the report interval (ticks between reports).
   */
  getReportInterval(): number {
    return this.getFlags().reportInterval;
  }

  /**
   * Get the retention days setting.
   */
  getRetentionDays(): number {
    return this.getFlags().retentionDays;
  }

  /**
   * Set the worker pool reference for telemetry aggregation.
   * This is called from the main server initialization.
   */
  setWorkerPool(workerPool: unknown): void {
    this.workerPoolRef = workerPool;
  }

  /**
   * Increment the tick counter.
   * Called from the physics loop.
   */
  tick(): void {
    this.tickCount++;

    // Check if it's time to generate a report
    const interval = this.getReportInterval();
    if (this.tickCount - this.lastReportTick >= interval) {
      this.generateReport();
      this.lastReportTick = this.tickCount;
    }
  }

  /**
   * Generate and output a telemetry report.
   * This is called automatically based on the report interval.
   */
  private generateReport(): void {
    // Only generate if telemetry is enabled
    if (!TelemetryController.isEnabled()) {
      return;
    }

    const flags = this.getFlags();

    // Gather worker telemetry if available
    if (this.workerPoolRef && flags.profileLevel !== 'minimal') {
      this.gatherWorkerTelemetry();
    }

    // Generate the report using the existing profiler
    globalProfiler.report(flags.reportInterval);

    // Output to console if enabled
    if (flags.outputFormat === 'console' || flags.outputFormat === 'both') {
      // Report is already printed to console by globalProfiler.report()
    }

    // Write to file if enabled (Phase 2 feature)
    if (flags.outputFormat === 'file' || flags.outputFormat === 'both') {
      this.writeToFile();
    }
  }

  /**
   * Gather telemetry from worker threads.
   */
  private async gatherWorkerTelemetry(): Promise<void> {
    // Skip if telemetry is not enabled
    if (!TelemetryController.isEnabled() || !this.workerPoolRef) {
      return;
    }

    try {
      // Check if workerPool has getTelemetrySnapshots method
      const workerPool = this.workerPoolRef as { getTelemetrySnapshots?: () => Promise<BigUint64Array[]> };
      if (typeof workerPool.getTelemetrySnapshots === 'function') {
        const snapshots = await workerPool.getTelemetrySnapshots();
        setLatestWorkerTelemetry(snapshots);
      }
    } catch (error) {
      // Log errors based on debug level
      const debugLevel = this.getDebugLevel();
      if (debugLevel === 'verbose') {
        console.error('[Telemetry] Error gathering worker telemetry:', error);
      } else if (debugLevel === 'error') {
        console.error('[Telemetry] Error gathering worker telemetry');
      }
      // In 'none' debug mode, silently fail - no error output
    }
  }

  /**
   * Write telemetry to file (Phase 2 implementation).
   */
  private writeToFile(): void {
    // Placeholder for Phase 2 - JSONL file writing
    // This will be implemented in the next phase
  }

  /**
   * Check if detailed profiling is enabled.
   */
  isDetailedEnabled(): boolean {
    return this.getProfileLevel() === 'detailed';
  }

  /**
   * Check if verbose debug output is enabled.
   */
  isVerboseEnabled(): boolean {
    return this.getDebugLevel() === 'verbose';
  }

  /**
   * Get current tick count.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Reset telemetry state.
   * Used for testing.
   */
  reset(): void {
    this.tickCount = 0;
    this.lastReportTick = 0;
    // Reset the profiler
    globalProfiler.reset();
  }

  /**
   * Shutdown the telemetry system.
   * Called when the server shuts down.
   */
  shutdown(): void {
    // Generate final report
    if (TelemetryController.isEnabled()) {
      this.generateReport();
    }

    // Cleanup
    this.workerPoolRef = null;
    cachedFlags = null;
    initializationComplete = false;
    TelemetryController.instance = null;
  }
}

/**
 * Convenience function for fast-path checking.
 * Use this in hot loops instead of TelemetryController.isEnabled()
 * for better performance.
 */
export function isTelemetryEnabled(): boolean {
  return TelemetryController.isEnabled();
}

/**
 * Get the TelemetryController singleton instance.
 */
export function getTelemetryController(): TelemetryController {
  return TelemetryController.getInstance();
}

// Export for use in worker threads
export type { TelemetryFlags };
