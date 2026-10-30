import { describe, expect, it } from 'vitest';
import { dealNativeSpawns, type NativeSpawn } from '../../src/core/native-spawns';

const spawn = (priority: number, overrides: Partial<NativeSpawn> = {}): NativeSpawn => ({
  x: 10 + priority,
  y: 20 + priority,
  xv: priority + 0.25,
  yv: -priority - 0.5,
  priority,
  ffa: true,
  red: true,
  blue: true,
  green: false,
  yellow: false,
  ...overrides,
});

describe('native spawn dealing', () => {
  it('matches native sparse-ID ranking, dealing, velocity and seed arithmetic', () => {
    const result = dealNativeSpawns({
      seed: 7,
      players: [
        { id: 1, team: 1 },
        { id: 3, team: 1 },
        { id: 6, team: 1 },
      ],
      spawns: [spawn(0), spawn(1), spawn(2)],
    });
    // Independently calculated from the original's (seed*7)%101 stream. The
    // final assignment repeats the highest-priority spawn rather than consuming it.
    expect(result.seed).toBe(90);
    expect(result.assignments.map((entry) => entry.playerId)).toEqual([1, 3, 6]);
    expect(result.assignments.map((entry) => entry.spawnIndex)).toEqual([2, 0, 1]);
    expect(result.assignments.map(({ x, y, xv, yv }) => [x, y, xv, yv])).toEqual([
      [12, 22, 2.25, -2.5],
      [10, 20, 0.25, -0.5],
      [11, 21, 1.25, -1.5],
    ]);
  });

  it('does not compact sparse IDs or confuse a spectator with an active player', () => {
    const result = dealNativeSpawns({
      seed: 1,
      players: [
        { id: 0, team: 0 },
        { id: 2, team: 2 },
        { id: 5, team: 3, spectator: true },
        { id: 9, team: 1 },
      ],
      spawns: [spawn(3)],
      teamsEnabled: true,
    });
    expect(result.assignments.map((entry) => entry.playerId)).toEqual([2]);
    expect(result.assignments[0].x).toBe(13);
  });

  it('applies green/yellow fallback only when no authored team spawn exists', () => {
    const base = { ffa: false, red: true, blue: false, green: false, yellow: false };
    const fallback = dealNativeSpawns({
      seed: 1,
      players: [
        { id: 4, team: 4 },
        { id: 7, team: 5 },
      ],
      spawns: [spawn(2, base)],
    });
    expect(fallback.assignments.map((entry) => entry.playerId)).toEqual([4]);
    const explicit = dealNativeSpawns({
      seed: 1,
      players: [
        { id: 4, team: 4 },
        { id: 7, team: 5 },
      ],
      spawns: [spawn(2, base), spawn(3, { ffa: false, red: false, blue: true, green: true, yellow: true })],
    });
    expect(explicit.assignments.map((entry) => entry.spawnIndex)).toEqual([1, 1]);
  });

  it('keeps the source /9 retry stream and native original round-seed behavior testable', () => {
    const first = dealNativeSpawns({
      seed: 1,
      players: [
        { id: 0, team: 1 },
        { id: 1, team: 1 },
      ],
      spawns: [spawn(0), spawn(0)],
    });
    const second = dealNativeSpawns({
      seed: first.seed,
      players: [
        { id: 0, team: 1 },
        { id: 1, team: 1 },
      ],
      spawns: [spawn(0), spawn(0)],
    });
    expect(second.seed).not.toBe(first.seed);
    expect(first.assignments).toHaveLength(2);
  });

  it('rejects pixel-unit legacy spawn keys and unspawnable active rosters loudly', () => {
    expect(() =>
      dealNativeSpawns({ seed: 1, players: [{ id: 0, team: 1 }], spawns: [{ ...spawn(0), f: true } as never] }),
    ).toThrow(/unsupported field/);
    expect(() =>
      dealNativeSpawns({
        seed: 1,
        players: [{ id: 0, team: 3 }],
        spawns: [spawn(0, { ffa: false, red: true, blue: false })],
      }),
    ).toThrow(/no active player/);
  });
});
