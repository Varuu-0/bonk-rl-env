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
import { parseFlags, applyEnvOverrides, mergeConfigWithFlags, isAnyTelemetryEnabled, getExplicitFlagKeys } from './flags';
import { globalProfiler } from './profiler';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

// Cached flags - set once at initialization
let cachedFlags: TelemetryFlags | null = null;
let initializationComplete = false;

/**
 * Cached result of the first argv scan. Once the controller is initialized
 * this is unused (cachedFlags takes over), but the fallback path must not
 * rescan process.argv on every physics tick when no one has initialized the
 * controller (issue #237).
 */
let fallbackEnabled: boolean | null = null;

/** Physics tick rate assumed when converting the ms report interval to ticks. */
const DEFAULT_TICKS_PER_SECOND = 30;

interface TelemetryFileEntry {
  timestamp: string;
  tick: number;
  report: string;
}

/**
 * Resolve the JSONL telemetry output path for the given date.
 * Reports are appended to telemetry/telemetry-YYYYMMDD.jsonl under the
 * process working directory.
 */
export function getTelemetryFilePath(date: Date = new Date()): string {
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
  return path.join(process.cwd(), 'telemetry', `telemetry-${stamp}.jsonl`);
}

/**
 * TelemetryController - Singleton for managing telemetry settings
 *
 * Use getInstance() to get the singleton instance.
 * Use isEnabled() for fast-path checking in hot loops.
 */
export class TelemetryController {
  private static instance: TelemetryController | null = null;

  // Telemetry state
  private tickCount: number = 0;
  private lastReportTick: number = 0;
  private reportInFlight: boolean = false;
  private dashboardServer: http.Server | null = null;
  private dashboardListened: boolean = false;

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
   * Called once during server startup so the parsed flags are cached and the
   * documented config surfaces (reportIntervalMs, dashboardPort, outputFormat)
   * take effect (issue #237).
   *
   * @param configTelemetry - Optional telemetry config from config.ts
   * @param ticksPerSecond - Physics tick rate used to convert the millisecond
   *   report interval into the tick-based report window (default 30).
   */
  initialize(configTelemetry?: Partial<TelemetryConfig>, ticksPerSecond: number = DEFAULT_TICKS_PER_SECOND): void {
    if (initializationComplete) {
      return;
    }

    // Parse CLI flags first (highest priority)
    let flags = parseFlags();

    // Apply environment variable overrides
    flags = applyEnvOverrides(flags);

    // Merge with config file settings (CLI has precedence)
    flags = mergeConfigWithFlags(configTelemetry, flags, getExplicitFlagKeys());

    // Check for legacy verboseTelemetry config
    // If verboseTelemetry is true in config, enable telemetry
    if (configTelemetry?.enabled === true && !flags.enableTelemetry) {
      flags.enableTelemetry = true;
    }

    // Convert the documented millisecond report interval into a tick window
    // unless the CLI set the tick-based --report-interval explicitly.
    if (configTelemetry?.reportIntervalMs !== undefined && !getExplicitFlagKeys().has('reportInterval')) {
      flags.reportInterval = Math.max(1, Math.round((configTelemetry.reportIntervalMs / 1000) * ticksPerSecond));
    }

    // Cache the flags
    cachedFlags = flags;
    fallbackEnabled = null;
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

    // Fallback: scan argv at most once and cache the result so the hot path
    // never rescans process.argv on every physics tick (issue #237).
    if (fallbackEnabled === null) {
      fallbackEnabled = isAnyTelemetryEnabled();
    }
    return fallbackEnabled;
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
   * Update telemetry flags by merging new values.
   * Only provided flags are updated; others remain unchanged.
   */
  updateFlags(flags: Partial<TelemetryFlags>): void {
    const current = this.getFlags();
    cachedFlags = { ...current, ...flags };
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
   * Increment the tick counter and report whether the configured interval has
   * been reached. Entry bookkeeping replaces per-tick reporting so the driver
   * (the IPC bridge) can emit reports without blocking the step path.
   *
   * @returns true when a report is due at the configured interval
   */
  tick(): boolean {
    this.tickCount++;

    // Skip interval bookkeeping entirely when telemetry is disabled.
    if (!TelemetryController.isEnabled()) {
      return false;
    }

    return this.tickCount - this.lastReportTick >= this.getReportInterval();
  }

  /**
   * Emit a telemetry report immediately. The caller is responsible for having
   * gathered worker telemetry (setLatestWorkerTelemetry) beforehand, so this
   * stays synchronous and can never block the IPC step reply (issues #185,
   * #229, #245).
   *
   * @returns true when a report was emitted
   */
  reportNow(force: boolean = false): boolean {
    if (!TelemetryController.isEnabled() || this.reportInFlight) {
      return false;
    }

    this.reportInFlight = true;
    try {
      this.emitReport(this.getFlags(), force);
      this.lastReportTick = this.tickCount;
      return true;
    } catch (error) {
      // Do not retry emission here: an emit failure must not create a
      // duplicate report after a successfully gathered snapshot.
      console.warn('[Telemetry] Failed to generate report:', error);
      return false;
    } finally {
      this.reportInFlight = false;
    }
  }

  /**
   * Emit the profiler report and optional file output.
   *
   * When `force` is true (the shutdown final report) the console report is
   * emitted even if the current profiler window is incomplete, so shutdown
   * is never a silent no-op in console mode (issue #237).
   */
  private emitReport(flags: TelemetryFlags, force: boolean): void {
    const consoleOutput = flags.outputFormat === 'console' || flags.outputFormat === 'both';
    const fileOutput = flags.outputFormat === 'file' || flags.outputFormat === 'both';

    // Capture the current window before the console report resets the buffer.
    const reportText = globalProfiler.formatReport();

    if (consoleOutput) {
      globalProfiler.report(flags.reportInterval, force);
    } else {
      // File-only mode: advance the reporting window without console output.
      globalProfiler.reset();
    }

    if (fileOutput) {
      this.writeToFile({
        timestamp: new Date().toISOString(),
        tick: this.tickCount,
        report: reportText,
      });
    }
  }

  /**
   * Write telemetry to a JSONL file under telemetry/telemetry-YYYYMMDD.jsonl.
   */
  private writeToFile(entry: TelemetryFileEntry): void {
    const filePath = getTelemetryFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  }

  /**
   * Start the telemetry dashboard HTTP server on the configured port.
   * Serves the current controller state as JSON. Binding failure (e.g. a
   * busy port) is non-fatal and only logged.
   */
  startDashboard(port: number): void {
    this.closeDashboard();
    this.dashboardListened = false;
    try {
      const server = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          enabled: TelemetryController.isEnabled(),
          tick: this.tickCount,
          profileLevel: this.getProfileLevel(),
          debugLevel: this.getDebugLevel(),
          outputFormat: this.getOutputFormat(),
          reportInterval: this.getReportInterval(),
          retentionDays: this.getRetentionDays(),
        }));
      });
      server.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.warn(`[Telemetry] Dashboard port ${port} is already in use; dashboard disabled`);
        } else {
          console.warn('[Telemetry] Dashboard server error:', (err as Error).message);
        }
      });
      server.once('listening', () => {
        this.dashboardListened = true;
        console.log(`[Telemetry] Dashboard listening on http://127.0.0.1:${port}`);
      });
      server.listen(port, '127.0.0.1');
      this.dashboardServer = server;
    } catch (error) {
      console.warn('[Telemetry] Failed to start dashboard:', (error as Error).message);
    }
  }

  /**
   * Close the dashboard HTTP server. Shutdown can race the async `listening`
   * event, so the server must be closed and the pending listener detached
   * regardless of whether it has finished binding — otherwise the port stays
   * held open and the server instance leaks (issue #237).
   */
  private closeDashboard(): void {
    const server = this.dashboardServer;
    this.dashboardServer = null;
    this.dashboardListened = false;
    if (!server) return;
    try {
      // Detach the pending 'listening' handler so a late event cannot
      // re-mark this (now shutdown) server as live, then force-close active
      // connections and the server itself.
      server.removeAllListeners('listening');
      server.closeAllConnections?.();
      server.close();
    } catch {
      // Server already closed or never fully bound.
    }
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
    this.reportInFlight = false;
    // Reset the profiler
    globalProfiler.reset();
  }

  /**
   * Shutdown the telemetry system.
   * Called when the server shuts down.
   */
  shutdown(): void {
    // Generate final report. Force the emission so a shutdown over a short
    // and otherwise-incomplete profiler window is not a silent no-op in
    // console mode (issue #237).
    if (TelemetryController.isEnabled()) {
      this.reportNow(true);
    }

    // Cleanup
    this.closeDashboard();
    cachedFlags = null;
    fallbackEnabled = null;
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
