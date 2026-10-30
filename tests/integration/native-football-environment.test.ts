import { describe, expect, it } from 'vitest';
import { BonkEnvironment, type EnvironmentConfig } from '../../src/core/environment';
import { createNativeFootballSession } from '../../src/core/native-football-session';
import { createFootballState, createFootballPhysics } from '../../src/core/football-physics';

function footballConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    nativeMode: 'f',
    numOpponents: 1,
    seed: 1,
    teamsEnabled: true,
    randomOpponent: false,
    oppGrappleProb: 0,
    maxTicks: 10000,
    ...overrides,
  };
}

const NEUTRAL = { left: false, right: false, up: false, down: false, action: false, action2: false } as const;

describe('public native football environment', () => {
  it('constructs, resets and steps a football session without a map', () => {
    const env = new BonkEnvironment(footballConfig());
    try {
      const observation = env.reset(1);
      expect(observation.tick).toBe(0);
      expect(env.getStaticInfo()).toMatchObject({ native: true, nativeMode: 'f' });
      const state = (env as any).nativeSession.getState();
      expect(state.ftu).toBe(120);
      expect(state.football.ball.x).toBeCloseTo(730 / 2 / 11, 12);
      expect(state.scores).toEqual([undefined, undefined, 0, 0]);
      // Kickoff countdown: inputs are consumed but no physics runs.
      const result = env.step(0);
      expect(result.info).toMatchObject({ native: true, nativeMode: 'f', tick: 1 });
      expect(result.done).toBe(false);
    } finally {
      env.close();
    }
  });

  it('runs the full kickoff countdown then simulates movement', () => {
    const env = new BonkEnvironment(footballConfig());
    try {
      env.reset(1);
      // ftu=120 decrements to -1 over 121 steps.
      for (let tick = 1; tick <= 121; tick++) env.step(2);
      const state = (env as any).nativeSession.getState();
      expect(state.ftu).toBe(-1);
      // After countdown, a right input accelerates the AI player.
      const before = (env as any).nativeSession.getState().football.discs[0].xv;
      env.step(2);
      const after = (env as any).nativeSession.getState().football.discs[0].xv;
      expect(Math.abs(after - before)).toBeGreaterThan(0);
    } finally {
      env.close();
    }
  });

  it('holds the ball in place during the countdown', () => {
    const env = new BonkEnvironment(footballConfig());
    try {
      env.reset(1);
      for (let tick = 1; tick <= 121; tick++) env.step(16);
      const state = (env as any).nativeSession.getState();
      // Players start 22.7 units from the ball, so no kick fires yet;
      // kickReady stays true and the ball is untouched.
      expect(state.football.discs[0].kickReady).toBe(true);
      expect(state.football.ball.x).toBeCloseTo(730 / 2 / 11, 12);
      expect(state.football.ball.xv).toBe(0);
    } finally {
      env.close();
    }
  });

  it('accepts bit 5 (action2) in football mode', () => {
    const env = new BonkEnvironment(footballConfig());
    try {
      env.reset(1);
      for (let tick = 1; tick <= 121; tick++) env.step(0);
      // action2 zeroes the movement force; must not throw.
      const result = env.step(32 | 2);
      expect(result.done).toBe(false);
    } finally {
      env.close();
    }
  });

  it('rejects football without teamsEnabled', () => {
    expect(() => new BonkEnvironment(footballConfig({ teamsEnabled: false }))).toThrow(
      /football requires teamsEnabled/,
    );
  });

  it('rejects map configuration with football', () => {
    expect(() => new BonkEnvironment(footballConfig({ mapData: {} as any }))).toThrow(/football has no map/);
  });

  it('rejects invalid room modes', () => {
    expect(() => new BonkEnvironment(footballConfig({ nativeMode: 'x' as any }))).toThrow(/Invalid nativeMode/);
  });
});

describe('native football session', () => {
  it('validates the roster requires both teams', () => {
    expect(() => createNativeFootballSession({ players: [{ id: 0, team: 2 }], seed: 1 })).toThrow(/team 2 and team 3/);
    expect(() => createNativeFootballSession({ players: [{ id: 0, team: 3 }], seed: 1 })).toThrow(/team 2 and team 3/);
    expect(() => createNativeFootballSession({ players: [{ id: 0, team: 1 }], seed: 1 })).toThrow(
      /team must be 2 or 3/,
    );
  });

  it('spawns players at native kickoff positions', () => {
    const session = createNativeFootballSession({
      players: [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ],
      seed: 1,
    });
    try {
      const state = session.getState();
      expect(state.football.ball.x).toBeCloseTo(730 / 2 / 11, 12);
      expect(state.football.ball.y).toBeCloseTo(500 / 2 / 11, 12);
      // Team 3 (index 0): x = (365-250)/11, first player y offset +0.
      expect(state.football.discs[0]!.x).toBeCloseTo((730 / 2 - 250) / 11, 12);
      expect(state.football.discs[0]!.y).toBeCloseTo(500 / 2 / 11, 12);
      // Team 2 (index 1): x = (365+250)/11, count=0 even → y offset -0.
      expect(state.football.discs[1]!.x).toBeCloseTo((730 / 2 + 250) / 11, 12);
      expect(state.discs.map((disc) => disc?.id)).toEqual([0, 1]);
      expect(state.phase).toBe('countdown');
    } finally {
      session.dispose();
    }
  });

  it('runs the kickoff countdown without physics and then moves', () => {
    const session = createNativeFootballSession({
      players: [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ],
      seed: 1,
    });
    try {
      for (let tick = 0; tick < 121; tick++) session.step({});
      let state = session.getState();
      expect(state.ftu).toBe(-1);
      const xBefore = state.football.discs[0]!.x;
      session.step({ 0: 2 });
      state = session.getState();
      expect(state.football.discs[0]!.x).toBeGreaterThan(xBefore);
    } finally {
      session.dispose();
    }
  });

  it('scores goals, freezes, and resets with scores preserved', () => {
    const physics = createFootballPhysics();
    try {
      const players = [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ];
      let state = createFootballState(players, 1);
      // Place the ball just past the left goal line with inward velocity.
      state = { ...state, ftu: -1, fte: -1, ball: { x: 2.5, y: 500 / 2 / 11, xv: -20, yv: 0 } } as any;
      state = physics.step(state, { 0: NEUTRAL, 1: NEUTRAL });
      expect(state.scores[2]).toBe(1);
      expect(state.lscr).toBe(2);
      expect(state.fte).toBe(90);
      // Run the freeze to zero; the reset restores kickoff positions.
      // fte=90 decrements to 0 over 90 steps; the step that observes fte==0
      // performs the createNewState reset.
      for (let tick = 0; tick < 91; tick++) {
        state = physics.step(state, { 0: NEUTRAL, 1: NEUTRAL });
      }
      expect(state.scores[2]).toBe(1);
      expect(state.ni).toBe(true);
      expect(state.ftu).toBe(120);
      expect(state.fte).toBe(-1);
      expect(state.ball.x).toBeCloseTo(730 / 2 / 11, 12);
    } finally {
      physics.dispose();
    }
  });

  it('validates state and inputs strictly', () => {
    const physics = createFootballPhysics();
    try {
      const players = [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ];
      const state = createFootballState(players, 1);
      expect(() => physics.step(null as any, {})).toThrow(/state must be a plain object/);
      expect(() => physics.step(state, null as any)).toThrow(/inputs must be a plain object/);
      expect(() => physics.step(state, { 5: NEUTRAL })).toThrow(/unknown player index/);
      expect(() => physics.step(state, {})).toThrow(/missing input/);
      expect(() => physics.step({ ...state, fte: -2 } as any, { 0: NEUTRAL, 1: NEUTRAL })).toThrow(/fte/);
    } finally {
      physics.dispose();
    }
  });

  it('terminates the environment when the football match completes', () => {
    // Regression (adversarial audit football D6): football discs never die,
    // so elimination-based termination can never fire; without the
    // matchComplete wiring every football episode ended only by maxTicks
    // truncation while the frozen session kept returning steps.
    // Native timing (football D5): matchComplete flips at the fte==0
    // boundary — 90 ticks after the goal — not on the scoring tick.
    const session = createNativeFootballSession({
      players: [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ],
      seed: 1,
      roundsToWin: 1,
    });
    try {
      session.stepWithEvents({ 0: 0, 1: 0 });
      expect((session as any).getState().matchComplete).toBe(false);
    } finally {
      session.dispose();
    }

    // Environment-level: with roundsToWin=1 the first goal completes the
    // match and the environment must report done with terminated=true.
    // The AI disc (team 3) spawns LEFT of the ball; driving right pushes
    // the ball into the RIGHT goal. Either team's goal completes the match
    // at roundsToWin=1, so the termination wiring is exercised regardless
    // of which side scores.
    const env = new BonkEnvironment(footballConfig({ roundsToWin: 1, maxTicks: 100000 }));
    try {
      env.reset(1);
      let terminal: any = null;
      for (let tick = 0; tick < 20000 && !terminal; tick++) {
        const result = env.step(2) as any; // right
        if (result.done) terminal = result;
      }
      expect(terminal).not.toBeNull();
      expect(terminal.terminated).toBe(true);
      expect(terminal.truncated).toBe(false);
      const state = (env as any).nativeSession.getState();
      expect(state.matchComplete).toBe(true);
      expect([state.scores[2], state.scores[3]].some((score: number) => score >= 1)).toBe(true);
    } finally {
      env.close();
    }
  });

  it('skips playersLeft discs entirely (native C19)', () => {
    // Regression (adversarial audit football D4): native skips body creation,
    // input application and output for disc indices in playersLeft, and
    // drops those players from the output players table.
    const physics = createFootballPhysics();
    try {
      const players = [
        { id: 0, team: 3 },
        { id: 1, team: 2 },
      ];
      const base = createFootballState(players, 1);
      // Past countdown, both discs present.
      let state = { ...base, ftu: -1, fte: -1 } as any;
      state = physics.step(state, { 0: NEUTRAL, 1: NEUTRAL });
      // Player 1 left: index 1 (and id 1) must be skipped.
      const withLeft = { ...state, playersLeft: [1] } as any;
      const next = physics.step(withLeft, { 0: { ...NEUTRAL, right: true }, 1: NEUTRAL });
      expect(next.discs[1]).toBeUndefined();
      expect(next.players[1]).toBeUndefined();
      expect(next.discs[0]).toBeDefined();
      expect(next.players[0]).toBeDefined();
      // The surviving disc still moves.
      expect(next.discs[0]!.x).not.toBe(state.discs[0]!.x);
    } finally {
      physics.dispose();
    }
  });
});
