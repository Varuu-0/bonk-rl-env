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
 *    once garbage-collected. The static findAvailablePort() helper obeys
 *    the same discipline: it skips claimed ports and commits its choice
 *    on behalf of the process through a hidden claimant (issue #468).
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

/**
 * Yield the next candidate port on demand — the prober pulls only the
 * batch it needs, so no scan path materializes a full-range array.
 * Wraps around within [startPort, endPort] starting at `from`, checking
 * each of the `count` ports exactly once (allocateAvailable's order).
 */
function* wraparoundCandidates(from: number, startPort: number, endPort: number, count: number): Iterator<number> {
  let port = from;
  for (let i = 0; i < count; i++) {
    yield port;
    port = port === endPort ? startPort : port + 1;
  }
}

/**
 * Yield candidates ascending from `from` through `to` inclusive
 * (findAvailablePort's order).
 */
function* ascendingCandidates(from: number, to: number): Iterator<number> {
  for (let port = from; port <= to; port++) {
    yield port;
  }
}

// Hidden claimant for choices committed by the static findAvailablePort()
// helper (issue #468): the helper is a class-level operation with no
// instance of its own, so its commit needs an owner that lives for the
// process lifetime. Kept separate from globalPortManager so the exported
// singleton's options stay caller-controlled; a reserving manager adopts
// these claims, and they otherwise stay occupied for the process lifetime.
let foundPortOwner: PortManager | null = null;

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
   * Probe a lazily generated candidate sequence in parallel batches of
   * ALLOCATION_PROBE_BATCH and commit the first port that is unclaimed
   * and actually bindable. `isClaimed` filters each batch before probing
   * and is re-checked after probing; the re-check and `commit` run with
   * no intervening await, so the single-threaded block is atomic against
   * racing synchronous allocators and concurrent probers (#432, #468).
   * @param candidates On-demand candidate ports (pulled batch by batch)
   * @param isClaimed Whether a port is already claimed anywhere in the
   *   process (own instance and registry)
   * @param commit Commit the chosen port synchronously; runs only for a
   *   candidate that passed the probe and the await-free re-check
   * @returns The committed port, or undefined when candidates run out
   */
  private static async probeAndCommit(
    candidates: Iterator<number>,
    isClaimed: (port: number) => boolean,
    commit: (port: number) => void,
  ): Promise<number | undefined> {
    while (true) {
      // Pull one batch worth of candidates; stop at sequence end.
      const window: number[] = [];
      while (window.length < ALLOCATION_PROBE_BATCH) {
        const step = candidates.next();
        if (step.done) {
          break;
        }
        window.push(step.value);
      }
      if (window.length === 0) {
        return undefined;
      }

      const batch = window.filter((port) => !isClaimed(port));

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
        // with the commit below (#432 review).
        if (isClaimed(port)) {
          continue;
        }
        commit(port);
        return port;
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
    const allocated = await PortManager.probeAndCommit(
      wraparoundCandidates(this.currentPort, this.startPort, this.endPort, this.endPort - this.startPort + 1),
      (port) => this.allocatedPorts.has(port) || claimOwner(port) !== undefined,
      (port) => {
        this.claim(port);
        this.currentPort = port === this.endPort ? this.startPort : port + 1;
      },
    );

    if (allocated === undefined) {
      throw new Error(`No available ports in range ${this.startPort}-${this.endPort}`);
    }
    return allocated;
  }

  /**
   * Reserve a specific port without allocating from the pool. A choice
   * handed out by the static findAvailablePort() helper is an advisory
   * process-owned claim (issue #468): a reserving manager adopts it —
   * dropping the hidden claimant's now-stale own entry — so a found port
   * can be claimed — and released — through the caller's own instance.
   * @param port The port to reserve
   * @throws Error if port is already allocated by this instance or by
   *   another PortManager in this process (issue #432)
   */
  reserve(port: number): void {
    if (this.allocatedPorts.has(port)) {
      throw new Error(`Port ${port} is already allocated`);
    }
    const helper = foundPortOwner;
    const owner = claimOwner(port);
    if (owner !== undefined && owner !== this && owner !== helper) {
      throw new Error(`Port ${port} is already allocated by another PortManager`);
    }
    if (helper !== null && owner === helper) {
      // Adopting the helper's claim: drop its stale entry so the hidden
      // claimant's own set does not drift or grow without bound (#468).
      helper.allocatedPorts.delete(port);
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
   * Find an available port in the system (any port). A port is only
   * returned when no PortManager in this process has claimed it and the
   * system itself holds no listener on it (issue #468). The choice is
   * committed to the process-wide registry before returning — on behalf
   * of the process through a hidden claimant — so the next allocator,
   * instance or helper, never hands the same port out twice. The commit
   * is ownership on behalf of the process: reserve() on a caller-owned
   * manager adopts it so a found port can be claimed — and released —
   * through the caller's own instance, and released ports return to the
   * pool for every allocator. Callers that skip reserve() should bind
   * the port immediately; a committed claim that is never bound nor
   * adopted stays occupied for the process lifetime.
   * @param preferredStart Preferred starting port
   * @returns An available port number
   * @throws Error if no available port exists
   */
  static async findAvailablePort(preferredStart: number = 6000): Promise<number> {
    // Port 0 would make the OS assign an ephemeral port, so the returned
    // number would not be the bound one; candidates start at 1.
    const found = await PortManager.probeAndCommit(
      ascendingCandidates(Math.max(1, preferredStart), 65535),
      (port) => claimOwner(port) !== undefined,
      (port) => PortManager.commitFoundPort(port),
    );

    if (found === undefined) {
      throw new Error('No available ports found');
    }
    return found;
  }

  /**
   * Commit a static-helper choice to the process-wide registry on
   * behalf of the process (issue #468). The helper is a class-level
   * operation with no instance of its own, so its claims live on a
   * hidden claimant kept separate from getGlobalPortManager() so the
   * exported singleton's options stay caller-controlled; reserving
   * managers adopt the claim via {@link reserve}.
   */
  private static commitFoundPort(port: number): void {
    if (!foundPortOwner) {
      foundPortOwner = new PortManager({ startPort: 1, endPort: 65535 });
    }
    foundPortOwner.claim(port);
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
