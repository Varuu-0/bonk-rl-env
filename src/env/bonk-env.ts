/**
 * bonk-env.ts — RL Environment abstraction for spawnable Bonk simulations
 *
 * This class represents a single Bonk simulation instance. Each environment
 * runs its own worker pool and can be controlled independently for parallel
 * RL training.
 */

import { WorkerPool, type ResultOwnershipOptions } from '../core/worker-pool';
import { PortManager, getGlobalPortManager } from '../utils/port-manager';
import { getConfig, mergeEngineSections, resolveEnvironmentConfig } from '../config/config-loader';
import { IpcBridge } from '../ipc/ipc-bridge';

export interface BonkEnvConfig {
  /** Number of environments to create internally (default: 1) */
  numEnvs?: number;
  /** Configuration for the environment */
  config?: Record<string, any>;
  /** Whether to use shared memory for IPC (default: auto-detect) */
  useSharedMemory?: boolean;
  /** Port manager instance to use (optional) */
  portManager?: PortManager;
  /** Port number for this environment (optional, for IPC server mode) */
  port?: number;
  /** If true, start an IPC server for external connections */
  enableIpcServer?: boolean;
}

export interface StepResult {
  observation: any;
  reward: number;
  done: boolean;
  truncated: boolean;
  /** Terminal (natural-death) flag normalized by the worker pool (#391). */
  terminated: boolean;
  info: Record<string, any>;
}

export class BonkEnv {
  /** Unique identifier for this environment */
  public readonly id: string;

  /** Port number this environment is running on (if IPC server enabled) */
  public port: number;

  private pool: WorkerPool | null = null;
  private bridge: IpcBridge | null = null;
  private portManager: PortManager;
  private isRunning: boolean = false;
  // True while THIS env holds the reservation for this.port.
  // PortManager.isAllocated() only tracks Set membership, not ownership:
  // after a failed start releases the reservation, another env can be
  // allocated the same port, so membership alone cannot decide whether a
  // retry may reuse this.port (issue #267 review).
  private portReserved: boolean = false;
  // Non-null while a start() is in flight. Doubles as the "starting" state
  // guard (a second start() rejects with "already starting") and lets stop()
  // await the in-flight start instead of tearing the pool/port out from under
  // it. Cleared in the wrapper's finally once the attempt settles, so a
  // failed start can be retried (issue #267).
  private startPromise: Promise<void> | null = null;
  private config: BonkEnvConfig;
  private static instanceCount: number = 0;

  constructor(config: BonkEnvConfig = {}) {
    this.id = `env-${++BonkEnv.instanceCount}`;
    this.config = config;

    // Use provided port manager or get global one
    this.portManager = config.portManager ?? getGlobalPortManager();

    // Get port from config or allocate one
    if (config.port) {
      // Use provided port and reserve it
      this.port = config.port;
      this.portManager.reserve(this.port);
    } else {
      // Allocate a unique port
      this.port = this.portManager.allocate();
    }
    this.portReserved = true;
  }

  /**
   * Start the environment.
   * Initializes the worker pool (and optionally starts IPC server).
   * @returns Promise that resolves when the environment is started
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error(`Environment ${this.id} is already running`);
    }
    if (this.startPromise) {
      throw new Error(`Environment ${this.id} is already starting`);
    }

    // A failed prior start released the port reserved in the constructor
    // (teardownFailedStart), so a retry must re-claim it before binding.
    // If the port was handed to another env in the meantime, allocate a
    // fresh one instead of binding a port the PortManager no longer
    // considers ours (issue #267 review).
    this.reservePortForStart();

    // Assign startPromise before the first await so a second overlapping
    // start() call rejects immediately instead of spawning its own worker
    // pool and (in IPC mode) bridge that would fight this call for
    // this.pool/this.bridge/this.port (issue #267).
    const startPromise = this.performStart();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  /**
   * Re-claims the port allocated in the constructor. The reservation is
   * released when a start attempt fails, so a retry must reserve it again
   * before spawning anything; if the port was allocated to another env in
   * the meantime, allocate a fresh port for this env. The early return is
   * keyed on this env's own portReserved flag — isAllocated() would see the
   * other env's claim and wrongly keep a foreign port (issue #267 review).
   */
  private reservePortForStart(): void {
    if (this.portReserved) {
      return;
    }
    try {
      this.portManager.reserve(this.port);
      this.portReserved = true;
    } catch {
      // The port was handed to another env after we released it; take a
      // fresh one instead of binding a port we no longer own.
      this.port = this.portManager.allocate();
      this.portReserved = true;
    }
  }

  /**
   * Verifies that this env's port is actually free on the OS before
   * anything binds or advertises it, relocating via a probed allocation
   * when another process already holds it (issue #432). The replacement
   * port is claimed before the old one is released so the swap is atomic
   * from every allocator's point of view; this.portReserved continues to
   * cover the new port.
   *
   * The guard deliberately mirrors the constructor's truthiness check so
   * an explicitly configured port and a falsy `port: 0` (which the
   * constructor treats as "allocate") are classified identically.
   * Explicitly configured truthy ports are respected as-is: a caller who
   * names a port gets that port's fate, including a loud EADDRINUSE on
   * bind (#223).
   *
   * The probe is a point-in-time check on loopback (the bridge's default
   * bind address). It runs once before the worker spawn and again right
   * before the IPC bridge binds, so a port taken over during the
   * multi-second spawn is relocated at the last moment and the residual
   * check-to-bind window is milliseconds, not seconds. A bridge configured
   * to bind a non-default address is not covered by the loopback probe —
   * a genuine late EADDRINUSE still surfaces through the #223 start()
   * rejection/teardown path instead of being masked.
   */
  private async ensureUsablePort(): Promise<void> {
    if (this.config.port) {
      return;
    }
    if (await PortManager.isPortAvailable(this.port)) {
      return;
    }
    console.warn(`[BonkEnv:${this.id}] Port ${this.port} is held by another process; reallocating`);
    const replacement = await this.portManager.allocateAvailable();
    this.portManager.release(this.port);
    this.port = replacement;
  }

  /**
   * Body of a start() attempt. Runs with this.startPromise already set, so
   * the failure path must NOT call the public stop() — stop() awaits the
   * in-flight start() and would deadlock. Teardown goes through
   * teardownFailedStart() instead.
   */
  private async performStart(): Promise<void> {
    try {
      // Verify/relocate the advertised port against the OS before spawning
      // workers or binding (issue #432): a port held by an unrelated
      // process must be skipped here rather than discovered as an opaque
      // ZMQ bind failure after pool.init() has already spawned workers.
      await this.ensureUsablePort();

      console.log(`[BonkEnv:${this.id}] Starting on port ${this.port}`);
      // Create worker pool
      const pool = new WorkerPool();
      this.pool = pool;

      // Initialize the worker pool with the configured number of envs,
      // forwarding the per-env config over the global defaults so configured
      // environment, reward, and engine-tuning values all reach the workers.
      const useSharedMemory = this.config.useSharedMemory ?? getConfig().workerPool.useSharedMemory;
      const override = this.config.config ?? {};
      const envConfig = resolveEnvironmentConfig(override);
      const engineSections = mergeEngineSections(override);
      await pool.init(this.config.numEnvs ?? 1, { ...envConfig, ...engineSections }, useSharedMemory);

      // When IPC server mode is requested (enableIpcServer), bind an
      // IpcBridge to this.port so external clients can connect. start()
      // does not resolve until the Router socket is actually bound, so
      // isActive() can never report success before the advertised port is
      // reachable. A bind failure (e.g. EADDRINUSE) rejects start() instead
      // of silently completing (issue #223).
      if (this.config.enableIpcServer === true) {
        // Re-probe right before the bind: the first probe ran before the
        // multi-second worker spawn, so re-verify now and relocate if the
        // port was taken over in the meantime — this shrinks the residual
        // check-to-bind window to milliseconds (issue #432).
        await this.ensureUsablePort();
        const bridge = new IpcBridge({ server: { port: this.port } });
        this.bridge = bridge;
        // Serve the env's own worker pool so external clients share
        // its numEnvs/config/useSharedMemory instead of spawning a
        // second set of default-config workers (no double workers,
        // env config forwarded).
        bridge.adoptPool(pool, this.config.numEnvs ?? 1, {
          config: envConfig,
          useSharedMemory,
          // If the adopted pool fails after init, the bridge closes
          // it and rebuilds a fresh pool for IPC clients; this env's
          // own pool reference is then orphaned on the dead pool, so
          // say so loudly instead of leaving direct step()/reset()
          // callers puzzled by "worker pool is closed" failures.
          onHostPoolFailed: () => {
            console.warn(
              `[BonkEnv:${this.id}] Adopted worker pool failed; the IPC bridge rebuilt a fresh pool for IPC clients. Direct step()/reset()/getPool() on this env target the dead pool until the env is restarted.`,
            );
          },
        });
        // start() keeps the serve loop alive until close(); bind
        // failures surface through bridge.ready, so await ready
        // rather than the serve promise.
        const serve = bridge.start();
        serve.catch(() => {
          /* bind failures surface via bridge.ready */
        });
        await bridge.ready;
        // The server is the only consumer of the shared pool while IPC
        // mode is on, so when it shuts down (e.g. a client sends
        // `close` with shutdown:true) tear the environment down too:
        // isActive() must not report success for a dead service and
        // the reserved port must not outlive the listener. The handler
        // is guarded on this exact bridge instance so a stale serve
        // loop from a previous stop()/start() cycle cannot tear down a
        // freshly restarted env, and a normal env.stop() (which nulls
        // this.bridge) doesn't trigger a redundant teardown.
        // A rejection handler is required on this chain: `serve.then`
        // returns a separate promise, and on a bind failure (EADDRINUSE)
        // `serve` rejects so this returned promise would reject with no
        // consumer — an unhandled rejection that terminates the process
        // on Node >=20 (`unhandled-rejections=throw`) even though
        // `await bridge.ready` above makes start() reject cleanly for
        // the caller (#252). Bind failures surface via bridge.ready, so
        // the rejection handler is an intentional no-op that does not
        // disturb the normal-shutdown lifecycle branch.
        void serve.then(
          () => {
            if (this.bridge === bridge) void this.stop();
          },
          () => {
            /* bind failures surface via bridge.ready */
          },
        );
        console.log(`[BonkEnv:${this.id}] IPC server bound to port ${this.port}`);
      }

      this.isRunning = true;
      console.log(`[BonkEnv:${this.id}] Started successfully`);
    } catch (error) {
      // init() can spawn workers and, in IPC mode, bind the socket
      // before rejecting. Release everything this attempt created and
      // the constructor's port reservation so a retry re-acquires it.
      await this.teardownFailedStart();
      throw error;
    }
  }

  /**
   * Releases the pool, bridge, and port reservation a failed start attempt
   * created. Runs while this.startPromise is still set, so it must not go
   * through the public stop() (which awaits the in-flight start and would
   * deadlock).
   */
  private async teardownFailedStart(): Promise<void> {
    if (this.bridge) {
      try {
        await this.bridge.close();
      } catch (error) {
        console.error(`[BonkEnv:${this.id}] Error closing IPC bridge after failed start:`, error);
      }
      this.bridge = null;
    }
    if (this.pool) {
      try {
        await this.pool.close();
      } catch (error) {
        console.error(`[BonkEnv:${this.id}] Error closing worker pool after failed start:`, error);
      }
      this.pool = null;
    }
    this.isRunning = false;
    if (this.portReserved) {
      this.portManager.release(this.port);
      this.portReserved = false;
    }
    console.log(`[BonkEnv:${this.id}] Start failed; resources released`);
  }

  /**
   * Stop the environment and release resources.
   * @returns Promise that resolves when the environment is stopped
   */
  async stop(): Promise<void> {
    // A start() may be in flight (worker spawn and IPC bind can take
    // seconds). Tearing down now would close the pool being initialized,
    // null it, and release the port underneath the in-flight start(),
    // leaving isRunning=true with a dead pool. Wait for the in-flight
    // start to settle first: on success we stop the now-running env, on
    // failure the attempt already released its own resources (issue #267
    // review).
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // The in-flight start failed and already cleaned up after itself.
      }
    }

    if (!this.pool && !this.bridge) {
      // Release only while this env still holds the reservation. After a
      // failed start the port was already released (and may have been
      // re-allocated to another env); releasing unconditionally here
      // would delete that other env's claim (issue #267 review).
      if (this.portReserved) {
        this.portManager.release(this.port);
        this.portReserved = false;
      }
      console.log(`[BonkEnv:${this.id}] Already stopped`);
      return;
    }

    console.log(`[BonkEnv:${this.id}] Stopping...`);

    try {
      if (this.bridge) {
        await this.bridge.close();
      }
    } catch (error) {
      console.error(`[BonkEnv:${this.id}] Error closing IPC bridge:`, error);
    } finally {
      this.bridge = null;
    }

    try {
      await this.pool?.close();
    } catch (error) {
      console.error(`[BonkEnv:${this.id}] Error during shutdown:`, error);
    } finally {
      this.pool = null;
      this.isRunning = false;
      if (this.portReserved) {
        this.portManager.release(this.port);
        this.portReserved = false;
      }
      console.log(`[BonkEnv:${this.id}] Stopped`);
    }
  }

  /**
   * Reset the environment to initial state.
   * @param seeds Optional seeds, one per internal environment of this env's
   *   pool. A seed list must cover every internal environment: a short list
   *   would otherwise silently leave the tail environments on an arbitrary
   *   RNG stream (issue #230).
   * @param options Result ownership mode; caller-owned by default
   * @returns Initial observation(s), one per internal environment
   */
  async reset(seeds?: number[], options?: ResultOwnershipOptions): Promise<any> {
    if (!this.isRunning || !this.pool) {
      throw new Error(`Environment ${this.id} is not running`);
    }

    // The low-level pool intentionally tolerates a short seed list (#183,
    // tail environments reset unseeded) — a documented escape hatch for
    // direct pool/getPool() users, pinned by worker-pool-stale-seeds. The
    // BonkEnv wrapper enforces its own exact-count contract instead (#230)
    // so callers of the public wrapper API can never silently lose seeds;
    // the IPC/Python client is unaffected because it always sends exactly
    // num_envs seeds.
    const numEnvs = this.getNumEnvs();
    if (seeds !== undefined) {
      if (!Array.isArray(seeds)) {
        throw new Error(`Invalid seed batch: expected an array of seeds, got ${typeof seeds}`);
      }
      if (seeds.length !== numEnvs) {
        const received = seeds.length;
        throw new Error(
          `Invalid seed batch: expected ${numEnvs} seed${numEnvs === 1 ? '' : 's'} for ${numEnvs} environment${numEnvs === 1 ? '' : 's'} in ${this.id}, got ${received}`,
        );
      }
    }

    return this.pool.reset(seeds, options);
  }

  /**
   * Take a step in the environment with the given action(s).
   * @param actions Action(s) to apply, one per internal environment
   * @param options Result ownership mode; caller-owned by default
   * @returns Step results, one per internal environment, containing observation, reward, done, truncated, info
   */
  async step(actions: any[], options?: ResultOwnershipOptions): Promise<StepResult[]> {
    if (!this.isRunning || !this.pool) {
      throw new Error(`Environment ${this.id} is not running`);
    }

    return this.pool.step(actions, options);
  }

  /**
   * Check if the environment is currently running.
   * @returns true if running, false otherwise
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get the worker pool instance (for advanced usage).
   * @returns The WorkerPool instance or null if not running
   */
  getPool(): WorkerPool | null {
    return this.pool;
  }

  /**
   * Get the number of internal environments managed by this env's worker
   * pool. Matches the configured numEnvs (default: 1), which is exactly the
   * count the pool is initialized with, so callers can size batch
   * action/seed lists for this BonkEnv.
   * @returns Number of internal environments in the worker pool
   */
  getNumEnvs(): number {
    return this.config.numEnvs ?? 1;
  }

  /**
   * Wait for the environment to be ready.
   * @returns Promise that resolves when ready
   */
  async ready(): Promise<void> {
    if (!this.isRunning) {
      throw new Error(`Environment ${this.id} is not running`);
    }
  }
}

/**
 * Create a new BonkEnv instance with the given configuration.
 * @param config Environment configuration
 * @returns A new BonkEnv instance (not started)
 */
export function createBonkEnv(config?: BonkEnvConfig): BonkEnv {
  return new BonkEnv(config);
}
