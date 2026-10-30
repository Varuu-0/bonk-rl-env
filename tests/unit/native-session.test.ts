import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createNativeSession, type NativeStaticArena, type NativeSessionPlayer } from '../../src/core/native-session';
import {
  type ClassicPhysics,
  type ClassicPhysicsOptions,
  type ClassicPhysicsWorld,
  type PhysicsDisc,
  type PhysicsPlatform,
} from '../../src/core/classic-physics';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ROOT = process.cwd();
const oraclePaths = {
  rawPath: path.join(ROOT, '.deobf/alpha2s.raw.js'),
  physicsPath:
    process.env.BOX2D_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/Box2DModuleGJMod.js'),
  trigPath: process.env.SAFETRIG_REFERENCE_FILE || path.join(ROOT, '.local-artifacts/native-reference/SafeTrig.js'),
};
const nativeSupplied = Object.values(oraclePaths).every((file) => existsSync(file));

const spawn = (x: number, y: number, xv = 0, yv = 0) => ({
  x,
  y,
  xv,
  yv,
  priority: 0,
  ffa: true,
  red: true,
  blue: true,
  green: false,
  yellow: false,
});
const arena = (settings: Partial<NativeStaticArena['settings']> = {}): NativeStaticArena => ({
  ppm: 12,
  settings: { respawn: false, noCollision: false, fly: false, quality: 1, ...settings },
  spawns: [spawn(10, 10), spawn(20, 20), spawn(30, 30)],
  platforms: [],
});
const players = (...ids: number[]): NativeSessionPlayer[] => ids.map((id) => ({ id, team: 1 }));
const disc = (id: number): PhysicsDisc => ({
  id,
  x: id * 10,
  y: id * 10,
  xv: id,
  yv: -id,
  sx: id * 10,
  sy: id * 10,
  sxv: id,
  syv: -id,
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

interface Call {
  discs: readonly PhysicsDisc[];
  options: ClassicPhysicsOptions;
}
function fakeBackend(step: (call: Call) => Partial<ClassicPhysicsWorld>) {
  const calls: Call[] = [];
  const backend: ClassicPhysics = {
    stepWorld(discs, _platforms, _inputs, options) {
      const call = { discs: discs.map((entry) => ({ ...entry })), options };
      calls.push(call);
      const output = step(call);
      return {
        discs: (output.discs ?? call.discs).map((entry) => ({ ...entry })),
        platforms: output.platforms ?? [],
        deaths: output.deaths ?? [],
        projectiles: [],
      };
    },
    step(discs, platforms, inputs, options) {
      return this.stepWorld(discs, platforms, inputs, options).discs;
    },
    stepDetailed(discs, platforms, inputs, options) {
      return this.stepWorld(discs, platforms, inputs, options);
    },
    dispose: vi.fn(),
  };
  return { calls, backend };
}

function twoPlayerSession(overrides: Partial<Parameters<typeof createNativeSession>[0]> = {}) {
  return createNativeSession({ arena: arena(), players: players(2, 7), seed: 1, ...overrides });
}

describe('native static Classic session', () => {
  it('retains sparse player/disc/score slots, spectators and pure frozen observations', () => {
    const session = createNativeSession({
      arena: arena(),
      seed: 1,
      players: [
        { id: 0, team: 0 },
        { id: 2, team: 1 },
        { id: 7, team: 1 },
        { id: 9, team: 1, spectator: true },
      ],
    });
    try {
      const state = session.getState();
      expect(state.ftu).toBe(90);
      expect(state.fte).toBe(-1);
      expect(state.rc).toBe(0);
      expect(state.rl).toBe(0);
      expect(state.discs[1]).toBeUndefined();
      expect(state.discs[2]?.id).toBe(2);
      expect(state.discs[7]?.id).toBe(7);
      expect(state.discs[9]).toBeUndefined();
      expect(state.players[0]?.team).toBe(0);
      expect(state.scores[0]).toBe(0);
      expect(state.scores[2]).toBe(0);
      expect(state.scores[7]).toBe(0);
      expect(state.scores[9]).toBe(0);
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.discs[2])).toBe(true);
      expect(session.getState()).not.toBe(state);
      expect(session.getState().discs[2]).toEqual(state.discs[2]);
    } finally {
      session.dispose();
    }
  });

  it('uses entry ftu alone for the solver gate and counts native rl independently', () => {
    const { calls, backend } = fakeBackend(({ discs, options }) => ({
      discs: discs.map((entry) => ({ ...entry, y: entry.y + (options.simulate ? 1 : 0) })),
    }));
    const session = createNativeSession({
      arena: arena(),
      players: players(0, 1),
      seed: 1,
      countdownTicks: 5,
      physicsFactory: () => backend,
    });
    try {
      const sequence = Array.from({ length: 7 }, () => session.step());
      expect(calls.map((call) => call.options.simulate)).toEqual([false, false, false, false, false, false, true]);
      expect(sequence.map((state) => state.ftu)).toEqual([4, 3, 2, 1, 0, -1, -1]);
      expect(sequence.map((state) => state.rl)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(sequence[5].phase).toBe('active');
      expect(sequence[6].phase).toBe('active');
    } finally {
      session.dispose();
    }
  });

  it('scores the surviving sparse ID on the death tick and simulates throughout result', () => {
    let tick = 0;
    const { calls, backend } = fakeBackend(({ discs, options }) => {
      tick++;
      return {
        discs: discs.map((entry) => ({
          ...entry,
          y: entry.y + (options.simulate ? 1 : 0),
          alive: tick === 1 ? entry.id !== 2 : entry.alive,
        })),
        deaths: tick === 1 ? [{ id: 2, cause: 'out-of-world' as const }] : [],
      };
    });
    const session = createNativeSession({
      arena: arena(),
      players: players(2, 7),
      seed: 1,
      physicsFactory: () => backend,
    });
    try {
      const ended = session.stepWithEvents();
      expect(ended.state.fte).toBe(90);
      expect(ended.state.scores[7]).toBe(1);
      expect(ended.state.lscr).toBe(7);
      expect(ended.state.discs[2]?.alive).toBe(false);
      expect(ended.state.discs[7]?.alive).toBe(true);
      expect(ended.events.roundResult).toEqual({ winner: 7, draw: false, score: 1 });
      expect(ended.state.discDeaths).toEqual([expect.objectContaining({ i: 2, f: 0, m: 4 })]);
      const next = session.stepWithEvents();
      expect(next.state.fte).toBe(89);
      expect(calls[1].options.simulate).toBe(false); // entry ftu=89, not fte=90
      expect(next.state.discDeaths[0].f).toBe(1);
      expect(next.events.roundResult).toBeNull();
      for (let i = 0; i < 89; i++) session.step();
      const boundary = session.getState();
      expect(boundary.fte).toBe(0);
      expect(boundary.rc).toBe(0);
      const rollover = session.stepWithEvents();
      expect(rollover.events.newRound).toBe(true);
      expect(rollover.state.rc).toBe(1);
      expect(rollover.state.rl).toBe(0);
      expect(rollover.state.ftu).toBe(90);
      expect(rollover.state.fte).toBe(-1);
      expect(rollover.state.lscr).toBe(7);
      expect(rollover.state.lastRoundResult).toEqual({ winner: 7, draw: false, score: 1 });
      expect(rollover.state.roundResult).toBeNull();
      expect(rollover.state.scores[7]).toBe(1);
      expect(calls).toHaveLength(91); // no solver on createNewState rollover
    } finally {
      session.dispose();
    }
  });

  it('omits eliminated static discs from later backend steps without demanding their inputs', () => {
    let first = true;
    const { calls, backend } = fakeBackend(({ discs }) => {
      const deaths = first ? [{ id: 2, cause: 'lethal-contact' as const, x: 20, y: 20, xv: 2, yv: -2 }] : [];
      first = false;
      return {
        discs: discs.map((entry) => ({ ...entry, alive: deaths.length ? entry.id !== 2 : entry.alive })),
        deaths,
      };
    });
    const session = createNativeSession({
      arena: arena(),
      players: players(2, 7),
      seed: 1,
      physicsFactory: () => backend,
    });
    try {
      session.step({ 2: 0, 7: 0 });
      expect(session.getState().discs[2]?.alive).toBe(false);
      session.step({ 7: 0 });
      expect(calls[1].discs.map((entry) => entry.id)).toEqual([7]);
      expect(Object.keys(calls[1].options)).not.toContain('knownPlayerIds');
    } finally {
      session.dispose();
    }
  });

  it('marks the match complete at the score limit without treating fte as a physics gate', () => {
    let tick = 0;
    const { calls, backend } = fakeBackend(({ discs }) => ({
      discs: discs.map((entry) => ({ ...entry, y: entry.y + 1, alive: tick === 0 ? entry.id !== 2 : entry.alive })),
      deaths: tick++ === 0 ? [{ id: 2, cause: 'lethal-contact' as const }] : [],
    }));
    const session = createNativeSession({
      arena: arena(),
      players: players(2, 7),
      seed: 1,
      roundsToWin: 1,
      physicsFactory: () => backend,
    });
    try {
      expect(session.step().matchComplete).toBe(true);
      expect(session.getState().phase).toBe('round-result');
      const y = session.getState().discs[7]!.y;
      const state = session.step();
      expect(state.fte).toBe(90);
      expect(state.discs[7]!.y).toBe(y);
      expect(calls).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('keeps all-out FFA draws and solo-team draws distinct from wins', () => {
    for (const ids of [[2, 7], [2]]) {
      const { backend } = fakeBackend(({ discs }) => ({
        discs: discs.map((entry) => ({ ...entry, alive: false })),
        deaths: discs.map((entry) => ({ id: entry.id, cause: 'lethal-contact' as const })),
      }));
      const session = createNativeSession({
        arena: arena(),
        players: players(...ids),
        seed: 1,
        physicsFactory: () => backend,
      });
      try {
        const state = session.step();
        expect(state.fte).toBe(90);
        expect(state.roundResult).toEqual({ winner: null, draw: true, score: null });
        expect(state.lscr).toBe(-1);
        expect(Array.from(state.scores).filter((entry) => entry !== undefined)).toEqual(ids.map(() => 0));
      } finally {
        session.dispose();
      }
    }
  });

  it('awards a team score when one team remains and accepts multiple fixtures sharing a static body', () => {
    let first = true;
    const { backend } = fakeBackend(({ discs }) => {
      const deaths = first ? [{ id: 3, cause: 'lethal-contact' as const }] : [];
      first = false;
      return {
        discs: discs.map((entry) => ({ ...entry, alive: deaths.length ? entry.id !== 3 : entry.alive })),
        deaths,
      };
    });
    const staticArena = {
      ...arena(),
      platforms: [
        {
          id: 0,
          bodyId: 4,
          shape: 'box' as const,
          x: 1,
          y: 2,
          width: 10,
          height: 1,
          angle: 0,
          color: 0,
          friction: 0.5,
          restitution: 0.8,
          lethal: false,
        },
        {
          id: 1,
          bodyId: 4,
          shape: 'circle' as const,
          x: 1,
          y: 2,
          radius: 1,
          angle: 0,
          color: 0,
          friction: 0.5,
          restitution: 0.8,
          lethal: false,
        },
      ],
    };
    const session = createNativeSession({
      arena: staticArena,
      seed: 1,
      teamsEnabled: true,
      players: [
        { id: 2, team: 2 },
        { id: 3, team: 3 },
        { id: 8, team: 2 },
      ],
      physicsFactory: () => backend,
    });
    try {
      const state = session.step();
      first = false;
      expect(state.fte).toBe(90);
      expect(state.scores[2]).toBe(1);
      expect(state.winner).toBe(2);
      expect(state.roundResult).toEqual({ winner: 2, draw: false, score: 1 });
      const second = session.step();
      expect(second.scores[2]).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it('rejects unsupported maps, capture metadata, non-Classic inputs and transform divergence', () => {
    expect(() => twoPlayerSession({ arena: { ...arena(), physics: {} } as never })).toThrow(/native physics states/);
    expect(() => twoPlayerSession({ arena: { ...arena(), capZones: [{}] } as never })).toThrow(/cap zones/);
    expect(() => twoPlayerSession({ arena: { ...arena(), spawns: [{ x: 0 }] as never } })).toThrow(/spawn/);
    const badBody = {
      ...arena(),
      platforms: [
        {
          id: 0,
          bodyId: 0,
          shape: 'box' as const,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          angle: 0,
          color: 0,
          friction: 0.5,
          restitution: 0.5,
          lethal: false,
        },
        {
          id: 1,
          bodyId: 0,
          shape: 'box' as const,
          x: 1,
          y: 0,
          width: 1,
          height: 1,
          angle: 0,
          color: 0,
          friction: 0.5,
          restitution: 0.5,
          lethal: false,
        },
      ],
    };
    expect(() => twoPlayerSession({ arena: badBody })).toThrow(/shared body/);
    const session = twoPlayerSession();
    try {
      expect(() => session.step({ 2: 32 })).toThrow(/0, 31/);
      expect(() => session.step({ 99: 0 })).toThrow(/unknown player/);
      expect(session.getState().rl).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('supplies dense default physics carriers for sparse IDs without densifying players', () => {
    const { calls, backend } = fakeBackend(({ discs }) => ({ discs: discs.map((entry) => ({ ...entry })) }));
    const session = createNativeSession({
      arena: arena(),
      seed: 1,
      players: [
        { id: 3, team: 1, balance: 20 },
        { id: 19, team: 1 },
      ],
      physicsFactory: () => backend,
    });
    try {
      session.step();
      expect(calls[0].options.balances?.[0]).toBe(0);
      expect(calls[0].options.balances?.[3]).toBe(20);
      expect(calls[0].options.balances?.[19]).toBe(0);
      expect(calls[0].options.teams?.[3]).toBe(1);
      expect(session.getState().discs[3]?.id).toBe(3);
      expect(session.getState().discs[19]?.id).toBe(19);
    } finally {
      session.dispose();
    }
  });

  it('restores spawn in the same step while retaining a separate death record', () => {
    const { backend } = fakeBackend(({ discs }) => ({
      discs: discs.map((entry) => (entry.id === 2 ? { ...entry, x: -70, y: 30, xv: 9, yv: 11, alive: false } : entry)),
      deaths: [{ id: 2, cause: 'out-of-world' as const, x: -70, y: 30, xv: 9, yv: 11 }],
    }));
    const session = createNativeSession({
      arena: arena({ respawn: true }),
      players: players(2, 7),
      seed: 1,
      physicsFactory: () => backend,
    });
    try {
      const { state, events } = session.stepWithEvents();
      const restored = state.discs[2]!;
      expect([restored.x, restored.y, restored.xv, restored.yv]).toEqual([
        restored.sx,
        restored.sy,
        restored.sxv,
        restored.syv,
      ]);
      expect(restored.alive).toBe(true);
      expect(restored.ni).toBe(true);
      expect(events.respawns).toEqual([2]);
      expect(state.discDeaths).toHaveLength(1);
      expect(state.discDeaths[0]).toMatchObject({ i: 2, m: 4, f: 0 });
      // At ppm=12 this OOB body clamps to x=1/12; using the restored spawn
      // would report x=10 and derive a downward rather than horizontal launch.
      expect(state.discDeaths[0].x).toBeCloseTo(1 / 12, 12);
      expect(state.discDeaths[0].y).toBe(30);
      expect(state.discDeaths[0].xv).toBe(20);
      expect(state.discDeaths[0].yv).toBe(0);
      expect(state.fte).toBe(-1); // native respawn keeps both entrants alive
    } finally {
      session.dispose();
    }
  });

  it('uses un-respawned backend death motion while restoring the live disc immediately', () => {
    const { backend } = fakeBackend(({ discs }) => ({
      discs: discs.map((entry) =>
        entry.id === 2
          ? { ...entry, x: entry.sx!, y: entry.sy!, xv: entry.sxv!, yv: entry.syv!, alive: true, ni: true }
          : entry,
      ),
      deaths: [{ id: 2, cause: 'lethal-contact' as const, x: 70, y: 60, xv: 9, yv: -11 }],
    }));
    const session = createNativeSession({
      arena: arena({ respawn: true }),
      players: players(2, 7),
      seed: 1,
      physicsFactory: () => backend,
    });
    try {
      const { state, events } = session.stepWithEvents();
      expect(state.discs[2]).toMatchObject({ x: 10, y: 10, xv: 0, yv: 0, alive: true, ni: true });
      expect(events.respawns).toEqual([2]);
      expect(events.deaths).toEqual([{ i: 2, x: 70, y: 60, xv: 9, yv: -11, f: 0, m: 1 }]);
      expect(state.discDeaths).toEqual(events.deaths);
    } finally {
      session.dispose();
    }
  });

  it('uses the default 90-tick countdown on rollover even for a testing initial round', () => {
    let first = true;
    const { backend } = fakeBackend(({ discs }) => {
      const deaths = first ? [{ id: 2, cause: 'lethal-contact' as const }] : [];
      first = false;
      return {
        discs: discs.map((entry) => ({ ...entry, alive: deaths.length ? entry.id !== 2 : entry.alive })),
        deaths,
      };
    });
    const session = createNativeSession({
      arena: arena(),
      players: players(2, 7),
      seed: 1,
      countdownTicks: 5,
      physicsFactory: () => backend,
    });
    try {
      session.step();
      for (let i = 0; i < 90; i++) session.step();
      expect(session.step().ftu).toBe(90);
    } finally {
      session.dispose();
    }
  });

  it('freezes a completed match without advancing physics or accepting further input', () => {
    const { backend } = fakeBackend(({ discs }) => ({
      discs: discs.map((entry) => ({ ...entry, alive: entry.id !== 2 })),
      deaths: [{ id: 2, cause: 'lethal-contact' }],
    }));
    const session = createNativeSession({
      arena: arena(),
      players: players(2, 7),
      seed: 1,
      roundsToWin: 1,
      physicsFactory: () => backend,
    });
    try {
      session.step();
      expect(session.getState().matchComplete).toBe(true);
      const completed = session.getState();
      expect(session.step({ 7: -1 })).toEqual(completed);
    } finally {
      session.dispose();
    }
  });
});

describe('original native differential (pinned local oracle)', () => {
  it.runIf(nativeSupplied)('matches original spawn state and static-arena round lifecycle', () => {
    const { createOracle } = require(path.join(ROOT, 'validation/native/raw-physics-oracle.cjs')) as {
      createOracle: (paths: typeof oraclePaths) => {
        createNewState: (...args: any[]) => any;
        step: (...args: any[]) => any;
        dispose: () => void;
      };
    };
    const { localPlatforms } = require(path.join(ROOT, 'validation/native/compare-classic-native.cjs')) as {
      localPlatforms: (native: any) => PhysicsPlatform[];
    };
    const oracle = createOracle(oraclePaths);
    const map = JSON.parse(readFileSync(path.join(ROOT, 'maps/training-platform.json'), 'utf8'));
    map.s.re = false;
    const roster: NativeSessionPlayer[] = [
      { id: 0, team: 1 },
      { id: 1, team: 1 },
    ];
    const nativeRoster = [
      { id: 0, team: 1 },
      { id: 1, team: 1 },
    ];
    map.spawns = map.spawns.map((entry: any, index: number) =>
      index === 0 ? { ...entry, y: 250 / map.physics.ppm } : entry,
    );
    const settings = { ga: 'b', mo: 'b', tea: false, bal: [0, 0], map, gt: 2, wl: 3, q: false, maps: [] };
    let native = oracle.createNewState(nativeRoster, map, 1, false, null, settings, true);
    native.rc = 0;
    const localArena: NativeStaticArena = {
      ppm: map.physics.ppm,
      settings: { respawn: false, noCollision: false, fly: false, quality: 1 },
      spawns: map.spawns.map((entry: any) => ({
        x: (entry.x + 365) / map.physics.ppm,
        y: (entry.y + 250) / map.physics.ppm,
        xv: entry.xv / map.physics.ppm,
        yv: entry.yv / map.physics.ppm,
        priority: entry.priority,
        ffa: entry.f,
        red: entry.r,
        blue: entry.b,
        green: entry.gr,
        yellow: entry.ye,
      })),
      platforms: localPlatforms(native),
    };
    const session = createNativeSession({ arena: localArena, players: roster, seed: 1, countdownTicks: 60 });
    const compare = (label: string) => {
      const state = session.getState();
      expect({
        label,
        ftu: state.ftu,
        fte: state.fte,
        rl: state.rl,
        rc: state.rc,
        lscr: state.lscr,
        seed: state.seed,
      }).toEqual({
        label,
        ftu: native.ftu,
        fte: native.fte,
        rl: native.rl,
        rc: native.rc,
        lscr: native.lscr,
        seed: native.seed,
      });
      expect(Array.from(state.scores)).toEqual(Array.from(native.scores));
      expect(state.discDeaths).toEqual(native.discDeaths);
      for (const id of [0, 1]) {
        const actual = state.discs[id];
        const expected = native.discs[id];
        if (!expected) {
          expect(actual).toBeUndefined();
          continue;
        }
        expect(actual?.alive).toBe(true);
        for (const [field, nativeField] of [
          ['x', 'x'],
          ['y', 'y'],
          ['xv', 'xv'],
          ['yv', 'yv'],
          ['angle', 'a'],
          ['angularVelocity', 'av'],
          ['energy', 'a1a'],
        ]) {
          expect(actual?.[field as keyof PhysicsDisc], `${label} disc ${id} ${field}`).toBeCloseTo(
            expected[nativeField],
            9,
          );
        }
      }
    };
    try {
      compare('spawn');
      // Native resolves the out-of-world spawn even on the first frozen
      // countdown tick. fte=90 does not gate the surviving disc's later motion.
      session.step();
      native = oracle.step(native, [{}, {}], null, 30, settings, 1, false, undefined);
      compare('death and score');
      session.step();
      native = oracle.step(native, [{}, {}], null, 30, settings, 1, false, undefined);
      compare('result countdown');
      for (let i = 0; i < 89; i++) {
        session.step();
        native = oracle.step(native, [{}, {}], null, 30, settings, 1, false, undefined);
      }
      compare('fte zero');
      session.step();
      native = oracle.step(native, [{}, {}], null, 30, settings, 1, false, undefined);
      compare('native createNewState rollover');
    } finally {
      session.dispose();
      oracle.dispose();
    }
  });
});
