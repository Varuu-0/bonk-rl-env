/**
 * physics-fidelity-p4-respawn-replay.test.ts — P4 differential validation:
 * revival-tick input ordering in compareTrace (#430).
 *
 * On respawn-enabled maps (`settings.re`), a disc that dies is queued for the
 * #339 deferred respawn and returns to its spawn at the START of the following
 * tick. The engine/native input contract (BonkEnvironment.step() since #409)
 * drains the queued respawn BEFORE applying the tick's inputs, so the
 * revival-tick action reaches the freshly revived disc. compareTrace must
 * replay recorded bytes in that same order: applied-before-drain, the engine's
 * applyInput alive-guard silently swallows the revival-tick byte and the replay
 * diverges from both the native client and the environment itself.
 *
 * Kept as a sibling of physics-fidelity-p4.test.ts so the revival-ordering
 * regression stays isolated from unrelated comparator coverage.
 */
import { describe, it, expect } from 'vitest';
import { BonkEnvironment } from '../../src/core/environment';
import { normalizeMap } from '../../src/core/map-adapter';
import { NativeTraceRecorder } from '../../src/core/differential';
import { compareTrace } from '../../src/core/differential/replay-comparator';
import type { NativeDiscState } from '../../src/core/differential/capture-recorder';
import type { NativeTrace } from '../../src/core/differential/native-trace';

describe('P4: differential validation — revival-tick input order on respawn maps (#430)', () => {
  it('honors the revival-tick input byte during trace replay', () => {
    // Lethal-floor arena: the disc spawns high above a full-width lethal strip,
    // dies on contact, and is queued for the #339 deferred respawn. The trace
    // records several death→revival cycles with a non-zero (RIGHT=2) input
    // byte held throughout, so every revival tick carries an input that must
    // reach the freshly revived disc. The recording driver uses the engine's
    // #409 ordering (processRespawns → applyInput → tick), which is what
    // BonkEnvironment.step() — and the native client — do; compareTrace must
    // replay in that same order or the alive-guard swallows the revival-tick
    // byte and the replay diverges from the recording.
    const rawMap: any = {
      bodies: [{ name: 'hazard', type: 'rect', x: 0, y: -20, width: 1200, height: 10, static: true, isLethal: true }],
      spawns: [{ x: -200, y: -300, blue: true, red: true }],
      settings: { re: true },
    };
    const TICKS = 120;
    const RIGHT = 2;
    const mapDef: any = normalizeMap(rawMap);
    const env = new BonkEnvironment({
      numOpponents: 0,
      seed: 7,
      mapData: mapDef,
      randomOpponent: false,
      maxTicks: TICKS + 8,
    } as any);
    const physics: any = (env as any).physics;
    env.reset(7);

    // Round-start spawn state, captured before the first tick (same contract
    // as recordSimTrace in physics-fidelity-p4.test.ts).
    const spawnBody = physics.playerBodies?.get(0);
    const pos = spawnBody?.GetPosition();
    const spawns = [{ id: 0, x: (pos?.x ?? 0) * physics.scale, y: (pos?.y ?? 0) * physics.scale }];
    const rec = new NativeTraceRecorder({
      map: rawMap,
      settings: { re: true },
      players: [{ id: 0, team: 1 }],
      spawns,
    });

    for (let t = 0; t < TICKS; t++) {
      physics.processRespawns(); // drain-before-input (#409 order)
      physics.applyInput(0, { left: false, right: true, up: false, down: false, heavy: false, grapple: false });
      physics.tick();

      const body = physics.playerBodies?.get(0);
      let disc: NativeDiscState | undefined;
      if (body && physics.playerAlive.get(0)) {
        const p = body.GetPosition();
        const v = body.GetLinearVelocity();
        disc = {
          x: p.x * physics.scale,
          y: p.y * physics.scale,
          xv: v.x * physics.scale,
          yv: v.y * physics.scale,
          a: body.GetAngle(),
          av: body.GetAngularVelocity(),
        };
      }
      rec.push({ t, discs: [disc], inputs: { 0: RIGHT } });
    }
    const respawnTrace: NativeTrace = rec.toTrace();
    env.close();

    // The scenario must actually exercise death→revival cycles: at least one
    // absent-disc (death-agreement) tick followed by a present-disc revival
    // tick, otherwise the assertions below would be vacuous.
    let deaths = 0;
    let revivals = 0;
    let firstRevivalIndex = -1;
    respawnTrace.ticks.forEach((tick, i) => {
      const present = tick.discs[0] != null;
      const prevPresent = i > 0 && respawnTrace.ticks[i - 1].discs[0] != null;
      if (!present && prevPresent) deaths++;
      if (present && i > 0 && !prevPresent) {
        revivals++;
        if (firstRevivalIndex === -1) firstRevivalIndex = i;
      }
    });
    expect(deaths).toBeGreaterThan(0);
    expect(revivals).toBeGreaterThan(0);
    expect(firstRevivalIndex).toBeGreaterThan(0);
    expect(respawnTrace.ticks[firstRevivalIndex].inputs?.[0]).toBe(RIGHT);

    const verdict = compareTrace(respawnTrace, {
      seed: 7,
      tolerances: { position: 0.02, velocity: 0.02, angle: 0.01, angularVelocity: 0.01 },
    });
    // A faithful replay reproduces the recorded trajectory exactly — only
    // possible when the revival-tick byte reached the revived disc.
    expect(verdict.pass).toBe(true);
    expect(verdict.ticksOutsideTolerance).toBe(0);
    expect(verdict.worst.dx).toBeLessThan(1e-6);
    expect(verdict.worst.dvx).toBeLessThan(1e-6);
    // Pin the revival tick itself: its compared velocity row must match the
    // recording (the recorded RIGHT impulse landed on the revived disc), not
    // the neutral-input trajectory an apply-before-drain driver produces
    // (~30 map-units/s of missing velocity).
    const revivalRow = verdict.perTick[firstRevivalIndex].compared.find((r) => r.id === 0);
    expect(revivalRow).toBeDefined();
    expect(revivalRow!.dvx).toBeLessThan(0.02);
  });
});
