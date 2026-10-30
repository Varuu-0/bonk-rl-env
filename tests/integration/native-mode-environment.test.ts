import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BonkEnvironment, type EnvironmentConfig } from '../../src/core/environment';
import type { NativeMap } from '../../src/core/native-map-codec';
import { createNativeMapModeSession } from '../../src/core/native-map-session';

const training = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../maps/training-platform.json'), 'utf8'),
) as NativeMap;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function config(
  mode: 'b' | 'ar' | 'ard' | 'v' | 'sp' | 'bs',
  overrides: Partial<EnvironmentConfig> = {},
): EnvironmentConfig {
  return {
    mapData: clone(training),
    nativeMode: mode,
    numOpponents: 1,
    seed: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    countdownTicks: 60,
    maxTicks: 10000,
    ...overrides,
  };
}

describe('public explicit native room modes', () => {
  it.each([
    ['ar', 750],
    ['ard', 500],
    ['v', 1000],
  ] as const)('%s uses room mode independently of map m.mo and resets it', (mode, energy) => {
    const env = new BonkEnvironment(config(mode));
    try {
      expect(env.getStaticInfo()).toMatchObject({ native: true, nativeMode: mode });
      for (let reset = 0; reset < 2; reset++) {
        env.reset(1);
        expect((env as any).nativeSession.getState().discs.map((disc: any) => disc.energy)).toEqual([energy, energy]);
        expect(env.step(0).info).toMatchObject({ native: true, nativeMode: mode, tick: 1, nativeRoundTick: 1 });
      }
    } finally {
      env.close();
    }
  });

  it('treats map targeting m.mo as display metadata that never selects or overrides room mode', () => {
    // Native evidence: m.mo is read only by the map-list UI (readable
    // :27591/:27693/:28030/:28159/:28292), serialization (:11269/:11525) and
    // the editor (:33953/:37079). Physics mode comes solely from room
    // gameSettings.mo (:5017/:28978/:29448/:5112). A map authored for another
    // mode therefore runs under any room mode.
    const map = clone(training);
    map.m.mo = 'ard';
    for (const mode of ['b', 'ar', 'ard', 'v', 'sp', 'bs'] as const) {
      const env = new BonkEnvironment(config(mode, { mapData: map }));
      try {
        expect(env.getStaticInfo()).toMatchObject({ native: true, nativeMode: mode });
        env.reset(1);
        const result = env.step(0);
        expect(result.info.nativeMode).toBe(mode);
      } finally {
        env.close();
      }
    }
  });

  it('runs sp and bs on dynamic maps through the unified world and rejects ar/ard/v dynamic maps', () => {
    const map = clone(training);
    map.physics.bodies[0]!.s.type = 'd';
    // sp/bs: dynamic map is routed to the unified dynamic world with the room
    // mode threaded into dynamicWorld.step (native step reads gameSettings.mo
    // from the settings argument, readable :7221).
    for (const mode of ['sp', 'bs'] as const) {
      const env = new BonkEnvironment(config(mode, { mapData: map }));
      try {
        expect(env.getStaticInfo()).toMatchObject({ native: true, nativeMode: mode });
        env.reset(1);
        const result = env.step(0);
        expect(result.info.nativeMode).toBe(mode);
      } finally {
        env.close();
      }
    }
    // ar/ard/v: dynamic mechanics would silently drop mode mechanics, so
    // construction rejects the combination loudly.
    for (const mode of ['ar', 'ard', 'v'] as const) {
      expect(() => new BonkEnvironment(config(mode, { mapData: map }))).toThrow(/requires a static arena/i);
    }
  });

  it('rejects non-Classic dynamic mechanics at the static boundary', () => {
    const map = clone(training);
    map.physics.bodies[0]!.s.type = 'd';
    expect(() => createNativeMapModeSession({ map, players: [{ id: 0, team: 1 }], seed: 1, mode: 'ar' })).toThrow(
      /body type|dynamic|moving/i,
    );
    expect(() => new BonkEnvironment(config('v', { mapData: map }))).toThrow(/body type|dynamic|moving/i);
    const dynamicClassic = new BonkEnvironment(config('b', { mapData: map }));
    dynamicClassic.close();
  });

  it('rejects invalid room modes and bit 5 outside Arrow/Grapple/Football modes', () => {
    expect(() => new BonkEnvironment(config('b', { nativeMode: 'x' as any }))).toThrow(/Invalid nativeMode/);
    for (const mode of ['b', 'v'] as const) {
      const env = new BonkEnvironment(config(mode));
      try {
        expect(() => env.step(32)).toThrow(/Unsupported native Classic action/);
        expect((env as any).nativeSnapshot.tick).toBe(0);
      } finally {
        env.close();
      }
    }
  });

  it('accepts Arrow action2 and preserves projectiles across public reset boundaries', () => {
    const env = new BonkEnvironment(config('ar'));
    try {
      for (let tick = 1; tick <= 270; tick++) {
        const result = env.step(tick <= 260 ? 32 : 0);
        expect(result.info.nativeMode).toBe('ar');
        if (tick === 261) expect((env as any).nativeSession.getState().projectiles).toHaveLength(1);
      }
      expect((env as any).nativeSession.getState().projectiles).toHaveLength(1);
      env.reset(1);
      expect((env as any).nativeSession.getState().projectiles).toHaveLength(0);
      expect((env as any).nativeSession.getState().discs.map((disc: any) => disc.energy)).toEqual([750, 750]);
    } finally {
      env.close();
    }
  });

  it('never silently falls back to the legacy engine for non-Classic native modes', () => {
    // Regression (adversarial audit D5): nativeMode ar/ard/v/sp/bs with a
    // legacy MapDef or the default legacy map must throw instead of silently
    // running the legacy PhysicsEngine with the requested mode ignored.
    const legacyMap = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../maps/bonk_WDB__No_Mapshake__716916.json'), 'utf8'),
    );
    for (const mode of ['ar', 'ard', 'v', 'sp', 'bs'] as const) {
      // Legacy mapData
      expect(() => new BonkEnvironment({ nativeMode: mode, mapData: legacyMap, numOpponents: 1, seed: 1 })).toThrow(
        /requires a native map|not a native map|Legacy maps are only supported/i,
      );
      // No map at all (would fall back to the default legacy WDB map)
      expect(() => new BonkEnvironment({ nativeMode: mode, numOpponents: 1, seed: 1 })).toThrow(
        /requires a native map|no map was configured|Legacy maps are only supported/i,
      );
    }
    // Classic mode still accepts the legacy default map (documented behavior).
    const classic = new BonkEnvironment({ nativeMode: 'b', numOpponents: 1, seed: 1 });
    classic.close();
    // Football mode rejects maps (existing contract) but needs no map.
    const football = new BonkEnvironment({
      nativeMode: 'f',
      teamsEnabled: true,
      numOpponents: 1,
      seed: 1,
      oppGrappleProb: 0,
      randomOpponent: false,
    });
    football.close();
  });
});
