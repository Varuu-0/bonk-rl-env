import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createNativeModeSession } from '../../src/core/native-mode-session';
import type {
  ClassicPhysics,
  ClassicPhysicsOptions,
  PhysicsDisc,
  PhysicsPlatform,
  PhysicsProjectile,
} from '../../src/core/classic-physics';
import type { NativeStaticArena, NativeSessionPlayer } from '../../src/core/native-session';

const spawn = (x: number, y: number) => ({
  x,
  y,
  xv: 0,
  yv: 0,
  priority: 0,
  ffa: true,
  red: true,
  blue: true,
  green: false,
  yellow: false,
});
const arena = (): NativeStaticArena => ({
  ppm: 12,
  settings: { respawn: false, noCollision: false, fly: false, quality: 1 },
  spawns: [spawn(10, 10), spawn(20, 20)],
  platforms: [],
});
const players = (): NativeSessionPlayer[] => [
  { id: 2, team: 1 },
  { id: 7, team: 1 },
];
const disc = (id: number, x: number, y: number): PhysicsDisc => ({
  id,
  x,
  y,
  xv: 0,
  yv: 0,
  sx: x,
  sy: y,
  sxv: 0,
  syv: 0,
  angle: 0,
  angularVelocity: 0,
  radius: 1,
  energy: 1000,
  heavy: false,
  alive: true,
  lhid: -1,
  lht: 0,
  ni: false,
  ds: 0,
  da: 270,
  vt: 0,
});
const arrow = (overrides: Partial<PhysicsProjectile> = {}): PhysicsProjectile => ({
  x: 11,
  y: 10,
  xv: 30,
  yv: 0,
  a: 0,
  av: 0,
  fte: 150,
  did: 2,
  type: 'arrow',
  team: 1,
  ...overrides,
});

interface Call {
  discs: readonly PhysicsDisc[];
  inputs: Readonly<Record<number, number>>;
  options: ClassicPhysicsOptions;
  projectiles: readonly (PhysicsProjectile | undefined)[];
}
interface BackendStep {
  mutate?: (disc: PhysicsDisc) => PhysicsDisc;
  projectiles?: readonly (PhysicsProjectile | undefined)[];
  deaths?: { id: number; cause: 'lethal-contact' | 'arrow' | 'out-of-world' | 'capture' }[];
}
function fakeBackend(step: (call: Call) => BackendStep = () => ({})) {
  const calls: Call[] = [];
  const backend: ClassicPhysics = {
    stepWorld(discs, _platforms: readonly PhysicsPlatform[], inputs, options, frame) {
      const call: Call = {
        discs: discs.map((entry) => ({ ...entry })),
        inputs: { ...inputs },
        options,
        projectiles: (frame?.projectiles ?? []).map((entry) => entry && { ...entry }),
      };
      calls.push(call);
      const output = step(call);
      return {
        discs: call.discs.map((entry) => output.mutate?.({ ...entry }) ?? { ...entry }),
        platforms: [],
        deaths: output.deaths ?? [],
        projectiles: output.projectiles ?? [],
      };
    },
    step(discs, platforms, inputs, options, frame) {
      return this.stepWorld(discs, platforms, inputs, options, frame).discs;
    },
    stepDetailed(discs, platforms, inputs, options, frame) {
      return this.stepWorld(discs, platforms, inputs, options, frame);
    },
    dispose: vi.fn(),
  };
  return { backend, calls };
}
function create(overrides: Partial<Parameters<typeof createNativeModeSession>[0]> = {}) {
  return createNativeModeSession({ arena: arena(), players: players(), seed: 1, ...overrides });
}

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();

interface FirstChargeReport {
  pass: boolean;
  originalOnlyExpectedValues: boolean;
  freshCreateNewStateEveryScenario: boolean;
  totals: { maximumAbsoluteError: number; coverageFailures: number; localRepairOrReseeds: number };
  scenarios: {
    pass: boolean;
    firstMismatch: unknown;
    coverage: {
      firstChargeSourceState: {
        tick: number;
        roundTick: number;
        input: number;
        disc: { energy: number; ds: number; xv: number };
      };
      firstChargeResultState: {
        tick: number;
        roundTick: number;
        disc: { energy: number; ds: number; da: number; xv: number };
      };
      releases: number[];
    };
  }[];
}

describe('native mode static session', () => {
  it('preserves the NativeSession API and adds detached frozen mode snapshots', () => {
    const { backend, calls } = fakeBackend(() => ({ projectiles: [arrow()] }));
    const session = create({ mode: 'ar', physicsFactory: () => backend });
    try {
      const initial = session.getState();
      expect(initial).toMatchObject({ ftu: 90, fte: -1, rl: 0, rc: 0, projectiles: [] });
      expect(initial.discs[2]?.energy).toBe(750);
      expect(initial.discs[7]?.energy).toBe(750);
      expect(initial).not.toHaveProperty('mode');
      expect(Object.keys(initial)).toEqual(expect.arrayContaining(Object.keys(createNativeModeSessionShape())));
      const state = session.step({ 2: 63 });
      expect(calls[0].options.mode).toBe('ar');
      expect(calls[0].inputs).toEqual({ 2: 63, 7: 0 });
      expect(state.projectiles).toEqual([arrow()]);
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.projectiles)).toBe(true);
      expect(Object.isFrozen(state.projectiles[0])).toBe(true);
      expect(session.getState().projectiles).toEqual(state.projectiles);
      expect(session.getState().projectiles).not.toBe(state.projectiles);
      expect(session.getState().projectiles[0]).not.toBe(state.projectiles[0]);
      expect(typeof session.getEvents).toBe('function');
      expect(typeof session.dispose).toBe('function');
    } finally {
      session.dispose();
    }
  });

  it('initializes all native mode energies on creation and native rollover', () => {
    for (const [mode, energy] of [
      ['b', 1000],
      ['ar', 750],
      ['ard', 500],
      ['v', 1000],
    ] as const) {
      // Use a deterministic first-step backend for rollover coverage.
      const { backend } = fakeBackend();
      let first = true;
      const rolloverBackend: ClassicPhysics = {
        ...backend,
        stepWorld(discs, platforms, inputs, options, frame) {
          const world = backend.stepWorld(discs, platforms, inputs, options, frame);
          if (first) {
            first = false;
            return {
              ...world,
              discs: world.discs.map((entry) => ({ ...entry, alive: entry.id !== 7 })),
              deaths: [{ id: 7, cause: mode === 'ard' ? 'arrow' : 'lethal-contact' }],
            };
          }
          return world;
        },
      };
      const session = create({ mode, roundsToWin: 3, physicsFactory: () => rolloverBackend });
      try {
        expect(session.getState().discs[2]?.energy).toBe(energy);
        session.step();
        for (let tick = 0; tick < 90; tick++) session.step();
        const rolled = session.step();
        expect(rolled.rc).toBe(1);
        expect(rolled.rl).toBe(0);
        expect(rolled.projectiles).toEqual([]);
        expect(rolled.discs[2]?.energy).toBe(energy);
        expect(rolled.discs[7]?.energy).toBe(energy);
      } finally {
        session.dispose();
      }
    }
  });

  it('retains projectiles between calls and clears them exactly on rollover', () => {
    let first = true;
    const { backend, calls } = fakeBackend(({ projectiles }) => ({
      projectiles: first ? [arrow()] : projectiles.map((entry) => entry && { ...entry, fte: entry.fte - 1 }),
      mutate: (entry) => ({ ...entry, alive: first ? entry.id !== 7 : entry.alive }),
      deaths: first ? [{ id: 7, cause: 'arrow' }] : [],
    }));
    const session = create({ mode: 'ard', countdownTicks: 5, physicsFactory: () => backend });
    try {
      const ended = session.stepWithEvents();
      first = false;
      expect(ended.state.fte).toBe(90);
      expect(ended.state.roundResult).toEqual({ winner: 2, draw: false, score: 1 });
      expect(ended.events.deaths[0]).toMatchObject({ i: 7, m: 1 });
      expect(ended.state.projectiles).toHaveLength(1);
      session.step();
      expect(calls[1].projectiles).toEqual([arrow()]);
      expect(session.getState().projectiles[0]?.fte).toBe(149);
      for (let tick = 0; tick < 89; tick++) session.step();
      const before = session.getState();
      expect(before.fte).toBe(0);
      expect(before.projectiles).toHaveLength(1);
      const rolled = session.stepWithEvents();
      expect(rolled.events.newRound).toBe(true);
      expect(rolled.state.projectiles).toEqual([]);
      expect(rolled.state.lastRoundResult).toEqual({ winner: 2, draw: false, score: 1 });
      expect(calls).toHaveLength(91);
    } finally {
      session.dispose();
    }
  });

  it('omits controls for eliminated discs and preserves the score', () => {
    let first = true;
    const { backend, calls } = fakeBackend(() => {
      const deaths = first ? [{ id: 7, cause: 'lethal-contact' as const }] : [];
      first = false;
      return { mutate: (entry) => ({ ...entry, alive: !deaths.length || entry.id !== 7 }), deaths };
    });
    const session = create({ physicsFactory: () => backend });
    try {
      session.step();
      const result = session.step({ 2: 4, 7: 63 });
      expect(result.discs[7]).toBeUndefined();
      expect(result.fte).toBe(89);
      expect(result.scores[2]).toBe(1);
      expect(calls[1].inputs).toEqual({ 2: 4 });
    } finally {
      session.dispose();
    }
  });

  it('preserves native dangling last-hit attribution through solver and snapshots', () => {
    let first = true;
    const { backend, calls } = fakeBackend(({ discs }) => {
      const deaths = first ? [{ id: 7, cause: 'lethal-contact' as const }] : [];
      first = false;
      return {
        mutate: (entry) => ({
          ...entry,
          alive: entry.id !== 7 || !deaths.length,
          lhid: entry.id === 2 ? 7 : -1,
          lht: 120,
        }),
        deaths,
      };
    });
    const session = create({ physicsFactory: () => backend });
    try {
      session.step();
      expect(session.getState().discs[2]?.lhid).toBe(7);
      const state = session.step();
      expect(calls[1].discs[0].lhid).toBe(7);
      expect(state.scores[2]).toBe(1);
      expect(state.roundResult).toEqual({ winner: 2, draw: false, score: 1 });
    } finally {
      session.dispose();
    }
  });

  it('accepts six-bit action2 but rejects invalid controls before advancing', () => {
    const { backend, calls } = fakeBackend();
    const session = create({ mode: 'ar', physicsFactory: () => backend });
    try {
      session.step({ 2: 32 });
      expect(calls).toHaveLength(1);
      expect(calls[0].inputs[2]).toBe(32);
      for (const value of [-1, 64, 1.5, Number.NaN]) {
        expect(() => session.step({ 2: value })).toThrow(/0, 63/);
      }
      expect(() => session.step({ 99: 0 })).toThrow(/unknown player/);
      expect(() => session.step({ '02': 0 } as unknown as Record<number, number>)).toThrow(/canonical decimal/);
      expect(session.getState().rl).toBe(1);
      expect(calls).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('preserves original right force on the full-energy first Arrow charge tick', () => {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.join(ROOT, 'validation/native/compare-native-mode-session.cjs'),
        '--raw',
        process.env.BONK_RAW_REFERENCE_FILE || path.join(ROOT, '.deobf/alpha2s.raw.js'),
        '--box2d',
        process.env.BOX2D_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/Box2DModuleGJMod.js'),
        '--safe-trig',
        process.env.SAFETRIG_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/SafeTrig.js'),
        '--regression',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout || result.stderr) as FirstChargeReport;
    expect(report.originalOnlyExpectedValues).toBe(true);
    expect(report.freshCreateNewStateEveryScenario).toBe(true);
    expect(report.totals).toMatchObject({ maximumAbsoluteError: 0, coverageFailures: 0, localRepairOrReseeds: 0 });
    expect(report.scenarios).toHaveLength(1);
    const scenario = report.scenarios[0];
    expect(scenario.pass, JSON.stringify(scenario.firstMismatch)).toBe(true);
    const source = scenario.coverage.firstChargeSourceState;
    const after = scenario.coverage.firstChargeResultState;
    expect(source).toMatchObject({ tick: 118, roundTick: 117, input: 34 });
    expect(source.disc).toMatchObject({ energy: 1000, ds: 0, xv: 0 });
    expect(after).toMatchObject({ tick: 118, roundTick: 118 });
    expect(after.disc).toMatchObject({ energy: 1000, ds: 1, da: 275 });
    expect(after.disc.xv).toBeCloseTo(0.3998666666666667, 14);
    expect(scenario.coverage.releases).toEqual([130]);
  }, 60_000);

  it('rejects dynamic arenas for non-sp/bs modes and unsupported modes without changing lifecycle rules', () => {
    expect(() => create({ mode: 'football' as never })).toThrow(/mode/);
    // A dynamic unified-world arena only carries sp/bs mechanics; every other
    // mode is rejected before the base session validates the arena itself.
    expect(() => create({ arena: { ...arena(), physics: {} } as never })).toThrow(/dynamic unified-world arena/);
    expect(() => create({ arena: { ...arena(), physics: {} } as never, mode: 'ar' })).toThrow(
      /dynamic unified-world arena/,
    );
    expect(() => create({ arena: { ...arena(), physics: {} } as never, mode: 'v' })).toThrow(
      /dynamic unified-world arena/,
    );
    expect(() => create({ arena: { ...arena(), capZones: [{}] } as never })).toThrow(/cap zones/);
  });

  it('does not eagerly validate ignored input on completed or rollover-only calls', () => {
    let first = true;
    const { backend, calls } = fakeBackend(() => {
      const deaths = first ? [{ id: 7, cause: 'arrow' as const }] : [];
      first = false;
      return { mutate: (entry) => ({ ...entry, alive: entry.id !== 7 }), deaths };
    });
    const session = create({ mode: 'ard', roundsToWin: 3, physicsFactory: () => backend });
    try {
      session.step();
      for (let tick = 0; tick < 90; tick++) session.step();
      const before = session.getState();
      expect(session.step({ 2: 999 }).rc).toBe(1);
      expect(calls).toHaveLength(91);
      expect(before.fte).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('disposes idempotently and preserves the base disposed-session error', () => {
    const { backend } = fakeBackend();
    const session = create({ physicsFactory: () => backend });
    session.dispose();
    session.dispose();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    expect(() => session.step()).toThrow(/disposed/);
  });
});

function createNativeModeSessionShape() {
  return {
    tick: 0,
    roundTick: 0,
    seed: 0,
    ftu: 0,
    fte: 0,
    rl: 0,
    rc: 0,
    lscr: 0,
    winner: null,
    draw: false,
    scores: [],
    players: [],
    discs: [],
    platforms: [],
    discDeaths: [],
    phase: 'countdown',
    matchComplete: false,
    roundResult: null,
    lastRoundResult: null,
    projectiles: [],
  };
}
