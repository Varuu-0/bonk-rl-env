/**
 * port-manager.ts — Port allocation module for spawnable environments
 *
 * Provides sequential port allocation in a configurable range to avoid
 * port collisions when spawning multiple RL environments.
 *
 * Collision avoidance works on two layers (issue #432):
 *  - Process-wide coordination: every instance registers its claims in a
 *    module-level registry (weakly referencing the owner), so
 *    independently constructed allocators (e.g. two default EnvManagers,
 *    or an EnvManager alongside standalone BonkEnvs on the global
 *    singleton) can never hand out the same port within one process, and
 *    managers discarded without releaseAll() stop poisoning their ports
 *    once garbage-collected.
 *  - OS probing: allocateAvailable() binds candidate ports on 127.0.0.1
 *    with throwaway net.Servers (in parallel batches) before committing,
 *    so ports already held by unrelated processes are skipped instead of
 *    failing later at bind time. This also covers cross-process
 *    collisions for callers that use the probe path.
 */

import * as net from 'net';

// Minimal WeakRef typing: tsconfig targets es2020 (WeakRef landed in
// ES2021), while the runtime floor (Node >= 20) always provides it.
declare const WeakRef: new <T extends object>(target: T) => { deref(): T | undefined };

// Process-wide registry of ports currently claimed by any PortManager
// instance, keyed by port with a weak reference to the owning instance.
// Allocation and reservation consult it in addition to each instance's
// own set; release()/releaseAll() remove only the calling instance's own
// claims. The weak value ensures a manager discarded without releaseAll()
// cannot poison its ports for the process lifetime: once the owner is
// garbage-collected, the next registry read reclaims the port (#432).
const globallyClaimedPorts: Map<number, { deref(): PortManager | undefined }> = new Map();

// Candidates are probed in parallel batches of this size so worst-case
// allocation stays bounded instead of O(range x probe latency) (#432).
const ALLOCATION_PROBE_BATCH = 20;

/**
 * Resolve the live owner of a claimed port, purging entries whose owner
 * was garbage-collected without releaseAll().
 * @returns The owning PortManager, or undefined when the port is free
 */
function claimOwner(port: number): PortManager | undefined {
  const ref = globallyClaimedPorts.get(port);
  if (!ref) {
    return undefined;
  }
  const owner = ref.deref();
  if (!owner) {
    globallyClaimedPorts.delete(port);
    return undefined;
  }
  return owner;
}

export interface PortManagerOptions {
  /** Starting port number (default: 6000) */
  startPort?: number;
  /** Ending port number (default: 7000) */
  endPort?: number;
}

export class PortManager {
  private startPort: number;
  private endPort: number;
  private allocatedPorts: Set<number> = new Set();
  private currentPort: number;

  constructor(options: PortManagerOptions = {}) {
    this.startPort = options.startPort ?? 6000;
    this.endPort = options.endPort ?? 7000;

    if (this.startPort < 1 || this.startPort > 65535 || this.endPort < 1 || this.endPort > 65535) {
      throw new Error(`Invalid port range: ${this.startPort}-${this.endPort}`);
    }

    if (this.startPort >= this.endPort) {
      throw new Error(`Start port must be less than end port: ${this.startPort} >= ${this.endPort}`);
    }

    this.currentPort = this.startPort;
  }

  /**
   * Allocate the next available port in the range.
   * Uses simple sequential allocation with wraparound. A port is only
   * handed out when neither this instance nor any other PortManager in
   * this process has claimed it (issue #432); OS-level availability is
   * not probed here — see {@link allocateAvailable} for the probed path.
   * @returns The allocated port number
   * @throws Error if no ports are available
   */
  allocate(): number {
    const startSearch = this.currentPort;

    // Try to find an available port
    while (true) {
      if (!this.allocatedPorts.has(this.currentPort) && !claimOwner(this.currentPort)) {
        const allocated = this.currentPort;
        this.claim(allocated);

        // Move to next port with wraparound
        this.currentPort++;
        if (this.currentPort > this.endPort) {
          this.currentPort = this.startPort;
        }

        return allocated;
      }

      // Move to next port with wraparound
      this.currentPort++;
      if (this.currentPort > this.endPort) {
        this.currentPort = this.startPort;
      }

      // We've wrapped around and checked all ports
      if (this.currentPort === startSearch) {
        throw new Error(`No available ports in range ${this.startPort}-${this.endPort}`);
      }
    }
  }

  /**
   * Allocate the next port that is both unclaimed by any PortManager in
   * this process and actually bindable on 127.0.0.1 right now. Every
   * candidate is probed with a throwaway TCP listener before it is
   * committed, so ports held by unrelated processes — including other
   * processes of a multi-process deployment — are skipped instead of
   * being handed out to fail later at bind time (issue #432).
   *
   * Candidates are probed in parallel batches to keep worst-case
   * allocation bounded, and a probe-passing candidate is committed only
   * after re-checking the registry with no intervening await: a
   * synchronous allocate()/reserve() (or a concurrent prober) may claim
   * the port while the probes are in flight, and the single-threaded
   * re-check-then-claim block makes the commit atomic against them.
   *
   * The probe closes its listener before returning, leaving a small
   * check-then-bind window; callers that bind immediately after
   * allocation make practical race-free use of it.
   * @returns The allocated port number
   * @throws Error if no probe-passing port exists in the range
   */
  async allocateAvailable(): Promise<number> {
    const totalPorts = this.endPort - this.startPort + 1;
    const candidates: number[] = [];
    let candidate = this.currentPort;
    for (let i = 0; i < totalPorts; i++) {
      candidates.push(candidate);
      candidate = candidate === this.endPort ? this.startPort : candidate + 1;
    }

    for (let offset = 0; offset < candidates.length; offset += ALLOCATION_PROBE_BATCH) {
      const batch = candidates
        .slice(offset, offset + ALLOCATION_PROBE_BATCH)
        .filter((port) => !this.allocatedPorts.has(port) && !claimOwner(port));

      const probed = await Promise.all(
        batch.map(async (port) => ((await PortManager.isPortAvailable(port)) ? port : -1)),
      );

      for (const port of probed) {
        if (port === -1) {
          continue;
        }
        // Re-check with no intervening await: JS runs this block
        // atomically, so a sync allocator that raced the probe either
        // already claimed the port (visible here) or cannot interleave
        // with the claim below (#432 review).
        if (this.allocatedPorts.has(port) || claimOwner(port)) {
          continue;
        }
        this.claim(port);
        this.currentPort = port === this.endPort ? this.startPort : port + 1;
        return port;
      }
    }

    throw new Error(`No available ports in range ${this.startPort}-${this.endPort}`);
  }

  /**
   * Reserve a specific port without allocating from the pool.
   * @param port The port to reserve
   * @throws Error if port is already allocated by this instance or by
   *   another PortManager in this process (issue #432)
   */
  reserve(port: number): void {
    if (this.allocatedPorts.has(port)) {
      throw new Error(`Port ${port} is already allocated`);
    }
    const owner = claimOwner(port);
    if (owner !== undefined && owner !== this) {
      throw new Error(`Port ${port} is already allocated by another PortManager`);
    }
    this.claim(port);
  }

  /**
   * Release a previously allocated port. Only this instance's own claim
   * is removed; another manager's claim of the same port is untouched.
   * @param port The port to release
   */
  release(port: number): void {
    if (this.allocatedPorts.delete(port)) {
      const ref = globallyClaimedPorts.get(port);
      if (ref && ref.deref() === this) {
        globallyClaimedPorts.delete(port);
      }
    }
  }

  /**
   * Check if a specific port is currently allocated by this instance.
   * Cross-instance claims live only in the process-wide registry and are
   * not reflected here.
   * @param port The port to check
   * @returns true if allocated by this instance, false otherwise
   */
  isAllocated(port: number): boolean {
    return this.allocatedPorts.has(port);
  }

  /**
   * Get the number of currently allocated ports.
   * @returns Count of allocated ports
   */
  getAllocatedCount(): number {
    return this.allocatedPorts.size;
  }

  /**
   * Check if a port is available (not in use by the system).
   * @param port The port to check
   * @returns true if available, false otherwise
   */
  static async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          // Some other error - assume port is not usable
          resolve(false);
        }
      });

      server.once('listening', () => {
        server.close(() => resolve(true));
      });

      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Find an available port in the system (any port).
   * @param preferredStart Preferred starting port
   * @returns An available port number
   */
  static async findAvailablePort(preferredStart: number = 6000): Promise<number> {
    for (let port = preferredStart; port <= 65535; port++) {
      if (await PortManager.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports found');
  }

  /**
   * Release all allocated ports.
   */
  releaseAll(): void {
    for (const port of this.allocatedPorts) {
      const ref = globallyClaimedPorts.get(port);
      if (ref && ref.deref() === this) {
        globallyClaimedPorts.delete(port);
      }
    }
    this.allocatedPorts.clear();
    this.currentPort = this.startPort;
  }

  /**
   * Record a port as claimed by this instance and by the process-wide
   * registry (via a weak reference) so sibling allocators skip it while
   * this instance lives (#432).
   */
  private claim(port: number): void {
    this.allocatedPorts.add(port);
    globallyClaimedPorts.set(port, new WeakRef(this));
  }
}

// Singleton instance for global use
let globalPortManager: PortManager | null = null;

/**
 * Get or create the global PortManager instance.
 * @param options Options for the port manager
 * @returns The global PortManager instance
 */
export function getGlobalPortManager(options?: PortManagerOptions): PortManager {
  if (!globalPortManager) {
    globalPortManager = new PortManager(options);
  }
  return globalPortManager;
}

/**
 * Reset the global PortManager instance.
 * Useful for testing.
 */
export function resetGlobalPortManager(): void {
  if (globalPortManager) {
    globalPortManager.releaseAll();
    globalPortManager = null;
  }
}
