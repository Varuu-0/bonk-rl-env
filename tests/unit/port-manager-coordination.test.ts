/**
 * Cross-instance coordination and OS probing for PortManager (#432).
 *
 * Independently constructed allocators share the process-wide registry, so
 * two default managers can never hand out the same port, and the probed
 * allocation path skips ports held by unrelated processes. The static
 * findAvailablePort() helper obeys the same discipline (#468): it skips
 * registry-claimed candidates, commits its choice, and released ports
 * return to the pool.
 *
 * Port scoping: the default-range tests deliberately exercise the real
 * default 6000-7000 range — that is the headline #432 scenario. Cross-FILE
 * contention with other suites is impossible (each vitest fork gets its
 * own module registry) and cross-PROCESS contention is made harmless by
 * the OS probe, since assertions are relative (distinctness, not absolute
 * port numbers). The explicit sub-ranges below sit between other suites'
 * fixed ranges to keep even deliberate blocker listeners collision-free.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'net';
import { PortManager } from '../../src/utils/port-manager';
import { EnvManager } from '../../src/env/env-manager';

// Explicit sub-ranges sit between other suites' fixed ranges (6600 end of
// env-manager.test.ts, 7000 start of the next suite) to keep even the
// deliberate blocker listeners here collision-free.
const BASE = 6650;

const createdManagers: PortManager[] = [];
const openServers: net.Server[] = [];

function makeManager(options?: { startPort?: number; endPort?: number }): PortManager {
  const manager = new PortManager(options);
  createdManagers.push(manager);
  return manager;
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    openServers.push(server);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  while (openServers.length > 0) {
    await closeServer(openServers.pop() as net.Server);
  }
  for (const manager of createdManagers) {
    manager.releaseAll();
  }
  createdManagers.length = 0;
});

describe('PortManager cross-instance coordination (#432)', () => {
  it('two default managers never hand out the same port', () => {
    const first = makeManager();
    const second = makeManager();

    const p1 = first.allocate();
    const p2 = second.allocate();

    expect(p1).toBeGreaterThanOrEqual(6000);
    expect(p2).not.toBe(p1);
  });

  it('a second manager skips ports claimed by the first', () => {
    const first = makeManager({ startPort: BASE, endPort: BASE + 10 });
    const second = makeManager({ startPort: BASE, endPort: BASE + 10 });

    const p1 = first.allocate();
    expect(second.allocate()).toBe(p1 + 1);
  });

  it('release makes a port available to other managers', () => {
    const first = makeManager({ startPort: BASE + 20, endPort: BASE + 30 });
    const second = makeManager({ startPort: BASE + 20, endPort: BASE + 30 });

    const p1 = first.allocate();
    first.release(p1);

    expect(second.allocate()).toBe(p1);
  });

  it('reserve rejects a port claimed by another manager', () => {
    const first = makeManager({ startPort: BASE + 40, endPort: BASE + 50 });
    const second = makeManager({ startPort: BASE + 40, endPort: BASE + 50 });

    const p1 = first.allocate();
    expect(() => second.reserve(p1)).toThrow('already allocated by another PortManager');
    // Same-instance double reservation keeps its original error.
    expect(() => first.reserve(p1)).toThrow(`Port ${p1} is already allocated`);
  });

  it('explicit custom ranges still allocate sequentially from their base', () => {
    const manager = makeManager({ startPort: BASE + 60, endPort: BASE + 70 });
    expect(manager.allocate()).toBe(BASE + 60);
    expect(manager.allocate()).toBe(BASE + 61);
  });

  it('exhaustion across sibling allocators surfaces a clean allocation error', () => {
    const first = makeManager({ startPort: BASE + 80, endPort: BASE + 82 });
    const second = makeManager({ startPort: BASE + 80, endPort: BASE + 82 });

    first.allocate();
    first.allocate();
    first.allocate();
    expect(() => second.allocate()).toThrow(`No available ports in range ${BASE + 80}-${BASE + 82}`);
  });

  it("release by a foreign manager leaves the owner's claim intact", () => {
    const first = makeManager({ startPort: BASE + 70, endPort: BASE + 80 });
    const second = makeManager({ startPort: BASE + 70, endPort: BASE + 80 });

    const p1 = first.allocate();
    expect(() => second.release(p1)).not.toThrow();

    expect(first.isAllocated(p1)).toBe(true);
    // The registry claim survived, so the second manager must not be
    // handed the port either.
    expect(second.allocate()).not.toBe(p1);
  });
});

describe('PortManager.allocateAvailable OS probe (#432)', () => {
  it('returns the first bindable candidate when all are free', async () => {
    const manager = makeManager({ startPort: BASE + 100, endPort: BASE + 110 });
    await expect(manager.allocateAvailable()).resolves.toBe(BASE + 100);
  });

  it('skips a port occupied by an unrelated process', async () => {
    const manager = makeManager({ startPort: BASE + 120, endPort: BASE + 130 });
    const blocker = await occupy(BASE + 120);

    try {
      await expect(manager.allocateAvailable()).resolves.toBe(BASE + 121);
      expect(manager.isAllocated(BASE + 120)).toBe(false);
      expect(manager.isAllocated(BASE + 121)).toBe(true);
    } finally {
      await closeServer(blocker);
      const idx = openServers.indexOf(blocker);
      if (idx !== -1) openServers.splice(idx, 1);
    }
  });

  it('never returns a port claimed by another manager even when OS-free', async () => {
    const first = makeManager({ startPort: BASE + 140, endPort: BASE + 150 });
    const second = makeManager({ startPort: BASE + 140, endPort: BASE + 150 });

    first.allocate();

    await expect(second.allocateAvailable()).resolves.toBe(BASE + 141);
  });

  it('throws when every candidate is unusable', async () => {
    const start = BASE + 160;
    const end = BASE + 162;
    const manager = makeManager({ startPort: start, endPort: end });

    const blockers: net.Server[] = [];
    for (let port = start; port <= end; port++) {
      blockers.push(await occupy(port));
    }

    try {
      await expect(manager.allocateAvailable()).rejects.toThrow(`No available ports in range ${start}-${end}`);
      expect(manager.getAllocatedCount()).toBe(0);
    } finally {
      for (const blocker of blockers) {
        await closeServer(blocker);
        const idx = openServers.indexOf(blocker);
        if (idx !== -1) openServers.splice(idx, 1);
      }
    }
  });
});

describe('PortManager.allocateAvailable concurrency (#432 review)', () => {
  it('overlapping probed allocations return distinct ports', async () => {
    const first = makeManager({ startPort: BASE + 220, endPort: BASE + 230 });
    const second = makeManager({ startPort: BASE + 220, endPort: BASE + 230 });

    // Resolve every probe as free, but keep both allocators suspended on
    // their first batch so they scan the same candidates before either
    // commits: without the no-await re-check both would claim the first
    // candidate.
    const spy = vi.spyOn(PortManager, 'isPortAvailable').mockResolvedValue(true);

    try {
      const [p1, p2] = await Promise.all([first.allocateAvailable(), second.allocateAvailable()]);
      expect(p1).not.toBe(p2);
      expect(first.isAllocated(p1)).toBe(true);
      expect(second.isAllocated(p2)).toBe(true);
      expect(second.isAllocated(p1)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('overlapping probed allocations on one manager return distinct ports', async () => {
    const manager = makeManager({ startPort: BASE + 240, endPort: BASE + 250 });

    const spy = vi.spyOn(PortManager, 'isPortAvailable').mockResolvedValue(true);

    try {
      const [p1, p2] = await Promise.all([manager.allocateAvailable(), manager.allocateAvailable()]);
      expect(p1).not.toBe(p2);
      expect(manager.getAllocatedCount()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PortManager.findAvailablePort registry discipline (#468)', () => {
  // Committed helper choices linger for this file's process lifetime (the
  // helper's hidden claimant is never released), so every test below gets
  // its own slice of 6950-6999 — above the cross-instance bands above and
  // below the next suite's fixed 7000 range.
  const HELPER_BASE = 6950;

  it('never returns a port claimed by another manager even when OS-free', async () => {
    const first = makeManager({ startPort: HELPER_BASE, endPort: HELPER_BASE + 9 });
    const p1 = first.allocate();

    // p1 is only registry-claimed — no socket is bound there — so a
    // registry-blind probe would hand it straight back.
    await expect(PortManager.findAvailablePort(HELPER_BASE)).resolves.not.toBe(p1);
  });

  it('a manager never receives a port the helper already handed out', async () => {
    const handed = await PortManager.findAvailablePort(HELPER_BASE + 10);

    const second = makeManager({ startPort: HELPER_BASE + 10, endPort: HELPER_BASE + 18 });
    expect(second.allocate()).not.toBe(handed);
  });

  it('successive helper calls return distinct ports', async () => {
    const p1 = await PortManager.findAvailablePort(HELPER_BASE + 20);
    const p2 = await PortManager.findAvailablePort(HELPER_BASE + 20);

    expect(p1).not.toBe(p2);
  });

  it('released ports become available to the helper again', async () => {
    const first = makeManager({ startPort: HELPER_BASE + 30, endPort: HELPER_BASE + 38 });
    const p1 = first.allocate();

    await expect(PortManager.findAvailablePort(HELPER_BASE + 30)).resolves.not.toBe(p1);

    first.releaseAll();

    await expect(PortManager.findAvailablePort(HELPER_BASE + 30)).resolves.toBe(p1);
  });

  it('a caller-owned manager can adopt the helper claim with reserve', async () => {
    const handed = await PortManager.findAvailablePort(HELPER_BASE + 40);

    const owner = makeManager({ startPort: HELPER_BASE + 40, endPort: HELPER_BASE + 48 });
    owner.reserve(handed);

    expect(owner.isAllocated(handed)).toBe(true);

    owner.releaseAll();

    await expect(PortManager.findAvailablePort(HELPER_BASE + 40)).resolves.toBe(handed);
  });

  it('still skips a port occupied by an unrelated process', async () => {
    const blocker = await occupy(HELPER_BASE + 50);

    try {
      await expect(PortManager.findAvailablePort(HELPER_BASE + 50)).resolves.not.toBe(HELPER_BASE + 50);
    } finally {
      await closeServer(blocker);
      const idx = openServers.indexOf(blocker);
      if (idx !== -1) openServers.splice(idx, 1);
    }
  });

  it('overlapping helper calls return distinct ports', async () => {
    // Keep both calls suspended on the first candidate so they scan the
    // same candidates before either commits: without the no-await
    // re-check both would hand out the first candidate.
    const spy = vi.spyOn(PortManager, 'isPortAvailable').mockResolvedValue(true);

    try {
      const [p1, p2] = await Promise.all([
        PortManager.findAvailablePort(HELPER_BASE + 60),
        PortManager.findAvailablePort(HELPER_BASE + 60),
      ]);
      expect(p1).not.toBe(p2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('EnvManager shared PortManager (#432)', () => {
  it('uses a caller-provided instance without claiming ownership', async () => {
    const shared = makeManager({ startPort: BASE + 180, endPort: BASE + 190 });
    const manager = new EnvManager({ portManager: shared });

    expect(manager.getPortManager()).toBe(shared);

    const external = shared.allocate();
    await manager.shutdownAll();

    // shutdown must not release claims owned by other users of the
    // shared allocator.
    expect(shared.isAllocated(external)).toBe(true);
  });

  it('still releases its own allocator on shutdown', async () => {
    const manager = new EnvManager({
      portManager: { startPort: BASE + 200, endPort: BASE + 210 },
    });
    const own = manager.getPortManager();
    own.allocate();

    await manager.shutdownAll();

    expect(own.getAllocatedCount()).toBe(0);
  });
});
