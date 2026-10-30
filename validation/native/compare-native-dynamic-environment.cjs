'use strict';

// Public BonkEnvironment dynamic Classic observations versus the pinned original.
// Expected values come only from original createNewState/Physics.step. Episode
// termination and terminal holds are policy boundaries, never native round resets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOracle } = require('./raw-physics-oracle.cjs');
const { scenario, inputsFor } = require('./compare-dynamic-classic-native.cjs');

const ROOT = path.resolve(__dirname, '../..');
const TOLERANCE = 1e-9;
const INPUT_FIELDS = ['left', 'right', 'up', 'down', 'action', 'action2'];
const SCENARIOS = [
  'moving-platform',
  'lethal-moving-fixture',
  'disc-contact',
  'timed-capture',
  'instant-goal',
  'out-of-bounds',
];
const LOCAL_FILES = [
  'src/core/environment.ts',
  'src/core/native-map-session.ts',
  'src/core/native-map-codec.ts',
  'src/core/native-map-state.ts',
  'src/core/native-session.ts',
  'src/core/native-spawns.ts',
  'src/core/native-classic-world.ts',
  'src/core/native-world.ts',
  'src/core/safe-trig.ts',
  'validation/native/compare-dynamic-classic-native.cjs',
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const bits = (value) => Object.fromEntries(INPUT_FIELDS.map((field, index) => [field, (value & (1 << index)) !== 0]));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const phase = (native) => (native.fte >= 0 ? 'round-result' : native.ftu === -1 ? 'active' : 'countdown');

function publicMap(name, quality = 1) {
  const map = scenario(name);
  // The core oracle accepts minimal metadata; strict public raw JSON requires
  // these inert database/presentation fields as well.
  Object.assign(map.m, {
    authid: -1,
    date: '',
    rxid: 0,
    rxn: '',
    rxa: '',
    rxdb: 1,
    cr: [],
    pub: false,
    mo: 'b',
  });
  map.s.pq = quality;
  return map;
}

function publicConfig(name, overrides = {}) {
  return {
    mapData: publicMap(name),
    numOpponents: 1,
    seed: 1,
    randomOpponent: false,
    oppGrappleProb: 0,
    // Native public teams are AI blue (3), opponent red (2). Unlike FFA scores,
    // these are also the scoreBlue/scoreRed values exposed by StepResult.info.
    teamsEnabled: true,
    // Keep episode truncation beyond the native rollover tested by long cases.
    maxTicks: 10000,
    countdownTicks: 5,
    ...overrides,
  };
}

function settingsFor(map) {
  return { ga: 'b', mo: 'b', tea: true, bal: [0, 0], map, gt: 2, wl: 3, q: false, maps: [] };
}

function effectiveInputs(name, tick, frameSkip) {
  // FrameSkip1 is exactly the core comparator schedule. Larger windows expose
  // the input at their first tick and retain it on both original and public sides.
  return inputsFor(name, Math.floor((tick - 1) / frameSkip) * frameSkip + 1);
}

function expectedPresentation(native, previous, id) {
  const death = native.discDeaths.find((entry) => entry.i === id && entry.f === 0);
  const disc = native.discs[id] ?? previous.discs[id];
  if (!death && !disc) return null;
  return {
    x: (death?.x ?? disc.x) * native.physics.ppm - 365,
    y: (death?.y ?? disc.y) * native.physics.ppm - 250,
    xv: (death?.xv ?? disc.xv) * native.physics.ppm,
    yv: (death?.yv ?? disc.yv) * native.physics.ppm,
    a: disc?.a ?? 0,
    av: disc?.av ?? 0,
    heavy: disc?.a1 === true,
    alive: death ? false : disc !== undefined && disc !== null,
    death: death ?? null,
  };
}

function observationView(observation, id) {
  return id === 0
    ? {
        x: observation.playerX,
        y: observation.playerY,
        xv: observation.playerVelX,
        yv: observation.playerVelY,
        a: observation.playerAngle,
        av: observation.playerAngularVel,
        heavy: observation.playerIsHeavy,
        alive: observation.playerAlive,
      }
    : {
        x: observation.opponents[0]?.x,
        y: observation.opponents[0]?.y,
        xv: observation.opponents[0]?.velX,
        yv: observation.opponents[0]?.velY,
        heavy: observation.opponents[0]?.isHeavy,
        alive: observation.opponents[0]?.alive,
      };
}

function flatObservation(observation) {
  return [
    observation.playerX,
    observation.playerY,
    observation.playerVelX,
    observation.playerVelY,
    observation.playerAngle,
    observation.playerAngularVel,
    observation.playerIsHeavy ? 1 : 0,
    observation.opponents[0].x,
    observation.opponents[0].y,
    observation.opponents[0].velX,
    observation.opponents[0].velY,
    observation.opponents[0].isHeavy ? 1 : 0,
    observation.opponents[0].alive ? 1 : 0,
    observation.arenaHalfWidth,
    observation.arenaHalfHeight,
    observation.tick,
  ];
}

function runScenario(paths, name, options = {}) {
  const { BonkEnvironment } = require('../../src/core/environment.ts');
  const oracle = createOracle(paths);
  const quality = options.quality ?? 1;
  const frameSkip = options.frameSkip ?? 1;
  const maxTicks = options.maxTicks ?? 320;
  const map = publicMap(name, quality);
  const roster = [
    { id: 0, team: 3 },
    { id: 1, team: 2 },
  ];
  const settings = settingsFor(map);
  let env;
  const report = {
    name: `${name}-q${quality}-fs${frameSkip}`,
    scenario: name,
    quality,
    frameSkip,
    ids: [0, 1],
    seed: 1,
    countdownTicks: 5,
    maxTicks,
    ticks: 0,
    calls: 0,
    frames: 0,
    pass: true,
    status: 'PASS',
    requestedNativeTicks: maxTicks,
    comparedNativeTicks: 0,
    originalOnlyHoldTicks: 0,
    comparisons: 0,
    numericComparisons: 0,
    discreteComparisons: 0,
    maxError: 0,
    maxErrorByField: {},
    firstMismatch: null,
    mismatches: [],
    localRepairOrReseeds: 0,
    coverageFailures: [],
    coverage: {
      simulatedTicks: 0,
      resultTicks: 0,
      rollovers: 0,
      postRolloverSimulationTicks: 0,
      postRolloverCountdowns: [],
      postRolloverNativeTicks: 0,
      movingMapTicks: 0,
      discMapContacts: 0,
      nativePhases: { countdown: 0, active: 0, 'round-result': 0 },
      discDiscContacts: 0,
      captureProgressTicks: 0,
      respawnTicks: 0,
      removedDiscTicks: 0,
      deathPresentations: 0,
      removedOpponentDeaths: 0,
      removedPlayerDeaths: 0,
      deathCauses: { 1: 0, 3: 0, 4: 0 },
      fastObservationCalls: 0,
      nativeInfoCalls: 0,
      terminalTicks: 0,
      terminalHoldCalls: 0,
      truncationTicks: 0,
      eliminationTicks: 0,
      terminalResetChecks: 0,
      frameSkipActionWindows: 0,
      resetChecks: 0,
    },
  };
  function mismatch(entry) {
    report.pass = false;
    report.status = 'FAIL';
    if (report.firstMismatch === null) report.firstMismatch = entry;
    if (report.mismatches.length < 20) report.mismatches.push(entry);
  }
  function compare(expected, actual, field) {
    report.comparisons++;
    if (typeof expected === 'number') {
      report.numericComparisons++;
      const error = typeof actual === 'number' ? Math.abs(expected - actual) : NaN;
      if (!Number.isFinite(error)) {
        mismatch({ tick: report.ticks, call: report.calls, field, native: expected, actual, error: 'non-finite' });
        return;
      }
      report.maxError = Math.max(report.maxError, error);
      const key = field.split('.').slice(0, 2).join('.');
      report.maxErrorByField[key] = Math.max(report.maxErrorByField[key] || 0, error);
      if (error > TOLERANCE)
        mismatch({ tick: report.ticks, call: report.calls, field, native: expected, actual, error });
      return;
    }
    report.discreteComparisons++;
    if (!Object.is(expected, actual))
      mismatch({ tick: report.ticks, call: report.calls, field, native: expected, actual });
  }

  try {
    let native = oracle.createNewState(roster, clone(map), 1, true, null, settings, true);
    native.rc = 0;
    assert.equal(native.ftu, 5, 'Original testing countdown must match the public test seam');
    env = new BonkEnvironment(
      publicConfig(name, {
        mapData: clone(map),
        maxTicks,
        frameSkip,
        ...(options.config ?? {}),
      }),
    );
    let observation = env.reset();
    let info = null;
    let result = null;
    let previous = native;
    let terminalPolicy = null;
    let heldNative = null;
    let heldPrevious = null;
    let heldObservation = null;
    let heldInfo = null;
    let previousMapX = native.physics.bodies[0]?.p[0];
    let lastAIInput = 0;

    function check(nativeState, previousState, policy = null, terminalHold = false) {
      report.frames++;
      // While the public episode is frozen, the original may be at a later
      // round. Public tick fields remain pinned to the terminal decision.
      const publicTick = terminalHold ? policy.tick : report.ticks;
      if (info) report.comparedNativeTicks = publicTick;
      compare(publicTick, observation.tick, 'observation.tick');
      compare(365, observation.arenaHalfWidth, 'observation.arenaHalfWidth');
      compare(250, observation.arenaHalfHeight, 'observation.arenaHalfHeight');
      compare(1, observation.opponents.length, 'observation.opponents.length');
      let liveOpponents = 0;
      for (const id of [0, 1]) {
        const expected = expectedPresentation(nativeState, previousState, id);
        compare(expected !== null, observationView(observation, id).x !== undefined, `discs[${id}].presentation`);
        if (!expected) continue;
        const actual = observationView(observation, id);
        for (const field of id === 0 ? ['x', 'y', 'xv', 'yv', 'a', 'av'] : ['x', 'y', 'xv', 'yv']) {
          let actualValue = actual[field];
          if (options.perturb && report.ticks === 1 && id === 0 && field === 'xv') actualValue += 1e-6;
          compare(expected[field], actualValue, `discs[${id}].${field}`);
        }
        compare(expected.heavy, actual.heavy, `discs[${id}].heavy`);
        // Public Observation has no playerAlive field; native liveness is in info.
        if (expected.death || nativeState.discs[id]) {
          if (id === 1) compare(expected.alive, actual.alive, `discs[${id}].alive`);
        }
        if (id === 1 && expected?.alive) liveOpponents++;
        if (expected.death && !terminalHold) {
          report.coverage.deathPresentations++;
          report.coverage.deathCauses[expected.death.m]++;
        }
        if (!nativeState.discs[id] && !terminalHold) report.coverage.removedDiscTicks++;
      }
      const fast = Array.from(env.getObservationFast());
      const flat = flatObservation(observation);
      compare(flat.length, fast.length, 'fastObservation.length');
      for (let index = 0; index < flat.length; index++) {
        compare(Math.fround(flat[index]), fast[index], `fastObservation[${index}]`);
      }
      report.coverage.fastObservationCalls++;
      if (info) {
        compare(publicTick, info.tick, 'info.tick');
        compare(true, info.native, 'info.native');
        compare('b', info.nativeMode, 'info.nativeMode');
        compare(phase(nativeState), info.nativePhase, 'info.nativePhase');
        compare(nativeState.rl, info.nativeRoundTick, 'info.nativeRoundTick');
        compare(expectedPresentation(nativeState, previousState, 0)?.alive === true, info.aiAlive, 'info.aiAlive');
        compare(liveOpponents, info.opponentsAlive, 'info.opponentsAlive');
        compare(frameSkip, info.frameSkip, 'info.frameSkip');
        compare(result.done && !env.isTerminalHoldActive(), info.autoResetAfter, 'info.autoResetAfter');
        compare(policy?.type === 'elimination', info.terminated, 'info.terminated');
        compare(policy?.type === 'elimination', result.terminated, 'policy.terminated');
        compare(policy !== null, result.done, 'policy.done');
        compare(publicTick >= maxTicks, result.truncated, 'policy.truncated');
        compare(nativeState.scores[3] ?? 0, info.scoreBlue, 'info.scoreBlue');
        compare(nativeState.scores[2] ?? 0, info.scoreRed, 'info.scoreRed');
        compare(false, Object.hasOwn(info, 'nativeCapZoneCapacity'), 'info.capacityOnlyInStaticInfo');
        compare(nativeState.capZones.length, info.nativeCapZones.length, 'info.nativeCapZones.length');
        for (let index = 0; index < nativeState.capZones.length; index++) {
          const expectedZone = nativeState.capZones[index];
          const actualZone = info.nativeCapZones[index];
          for (const field of ['ty', 'p', 'l', 'i', 'o', 'ot', 'f']) {
            compare(expectedZone[field], actualZone?.[field], `info.nativeCapZones[${index}].${field}`);
          }
        }
        compare(policy !== null, Object.hasOwn(info, 'terminal_observation'), 'info.terminalObservation.present');
        if (policy)
          compare(JSON.stringify(observation), JSON.stringify(info.terminal_observation), 'info.terminalObservation');
        report.coverage.nativeInfoCalls++;
      }
      if (nativeState.ftu === -1 && !terminalHold) report.coverage.simulatedTicks++;
      if (nativeState.fte >= 0 && !terminalHold) report.coverage.resultTicks++;
      report.coverage.nativePhases[phase(nativeState)]++;
      if (!terminalHold && nativeState.capZones.some((zone) => zone.p > 0 || zone.f !== -1))
        report.coverage.captureProgressTicks++;
    }

    check(native, native);
    const resetObservation = env.reset();
    compare(JSON.stringify(observation), JSON.stringify(resetObservation), 'reset.observation');
    compare(
      JSON.stringify(flatObservation(observation)),
      JSON.stringify(Array.from(env.getObservationFast())),
      'reset.fastObservation',
    );
    const staticInfo = env.getStaticInfo();
    compare(map.capZones.length, staticInfo.nativeCapZoneCapacity, 'staticInfo.nativeCapZoneCapacity');
    compare(true, staticInfo.native, 'staticInfo.native');
    compare('b', staticInfo.nativeMode, 'staticInfo.nativeMode');
    compare(false, Object.hasOwn(staticInfo, 'nativeCapZones'), 'staticInfo.liveCapZonesExcluded');
    report.coverage.resetChecks++;
    let terminalHoldTarget = 0;
    let terminalResetDone = false;
    for (
      let call = 1;
      (report.ticks < maxTicks || report.calls < terminalHoldTarget || (terminalPolicy && !terminalResetDone)) &&
      report.firstMismatch === null;
      call++
    ) {
      report.calls = call;
      const nativeTick = report.ticks + 1;
      previous = native;
      const scheduled = effectiveInputs(name, nativeTick, frameSkip);
      const aiInput = (nativeTick - 1) % frameSkip === 0 ? scheduled[0] : lastAIInput;
      if ((nativeTick - 1) % frameSkip === 0) {
        lastAIInput = aiInput;
        report.coverage.frameSkipActionWindows++;
      }
      const opponentInput = 0; // randomOpponent=false is the public policy contract.
      const nativeInputs = { 0: bits(aiInput), 1: bits(opponentInput) };
      const priorRound = native.rc;
      native = oracle.stepWithContactObserver(native, nativeInputs, null, 30, settings, 1, false, undefined);
      report.ticks = nativeTick;
      const contacts = oracle.consumeContactObservations();
      for (const contact of contacts) {
        const types = [contact.bodyA, contact.bodyB];
        if (types.includes('disc') && types.includes('phys')) report.coverage.discMapContacts++;
        if (types[0] === 'disc' && types[1] === 'disc') report.coverage.discDiscContacts++;
      }
      for (const death of native.discDeaths) {
        if (death.f !== 0) continue;
        if (!native.discs[death.i]) {
          if (death.i === 0) report.coverage.removedPlayerDeaths++;
          if (death.i === 1) report.coverage.removedOpponentDeaths++;
        }
        if (death.m !== 3 && native.discs[death.i]?.ni) report.coverage.respawnTicks++;
      }
      if (native.rc !== priorRound) {
        report.coverage.rollovers++;
        report.coverage.postRolloverCountdowns.push(native.ftu);
      } else if (native.rc > 0 && previous.ftu === -1) report.coverage.postRolloverSimulationTicks++;
      if (native.physics.bodies[0] && native.physics.bodies[0].p[0] !== previousMapX) report.coverage.movingMapTicks++;
      previousMapX = native.physics.bodies[0]?.p[0];

      if (native.rc > 0) report.coverage.postRolloverNativeTicks++;
      if (terminalPolicy) {
        // Count the independent original advancement before check() pins all
        // public values to the held terminal presentation.
        report.originalOnlyHoldTicks++;
        result = env.step(0);
        observation = result.observation;
        info = result.info;
        report.coverage.terminalHoldCalls++;
        compare(0, result.reward, 'policy.hold.reward');
        compare(JSON.stringify(heldObservation), JSON.stringify(observation), 'policy.hold.observationFrozen');
        compare(
          JSON.stringify(heldObservation.opponents[0]),
          JSON.stringify(observation.opponents[0]),
          'policy.hold.opponentFrozen',
        );
        compare(heldInfo.tick, info.tick, 'policy.hold.infoTickFrozen');
        compare(heldInfo.nativeRoundTick, info.nativeRoundTick, 'policy.hold.roundTickFrozen');
        compare(heldInfo.nativePhase, info.nativePhase, 'policy.hold.phaseFrozen');
        compare(
          JSON.stringify(heldInfo.nativeCapZones),
          JSON.stringify(info.nativeCapZones),
          'policy.hold.capZonesFrozen',
        );
        // Check the original terminal presentation once more while the original
        // independently advances toward its next round above.
        check(heldNative, heldPrevious, terminalPolicy, true);
        if (report.ticks >= maxTicks && report.calls >= terminalHoldTarget && !terminalResetDone) {
          const reset = env.reset();
          compare(JSON.stringify(resetObservation), JSON.stringify(reset), 'policy.resetAfterTerminal');
          compare(0, reset.tick, 'policy.resetTick');
          compare(false, env.isTerminalHoldActive(), 'policy.resetHoldReleased');
          terminalResetDone = true;
          report.coverage.terminalResetChecks++;
        }
      } else {
        result = env.step(aiInput);
        observation = result.observation;
        info = result.info;
        const elimination = [0, 1].some((id) => {
          const visible = expectedPresentation(native, previous, id);
          return !visible?.alive && !native.discs[id]?.ni;
        });
        if (result.done) {
          terminalPolicy = { type: elimination ? 'elimination' : 'truncation', tick: nativeTick };
          report.coverage.terminalTicks++;
          if (terminalPolicy.type === 'elimination') report.coverage.eliminationTicks++;
          else report.coverage.truncationTicks++;
        }
        check(native, previous, terminalPolicy);
        if (terminalPolicy) {
          heldNative = native;
          heldPrevious = previous;
          heldObservation = observation;
          heldInfo = info;
          // At minimum cover the complete current action window and an additional
          // held call; long runs also hold through the original's rollover.
          terminalHoldTarget = Math.max(report.calls + frameSkip + 1, maxTicks);
        }
      }
    }
    if (!options.perturb) {
      const c = report.coverage;
      if (report.ticks === 0) report.coverageFailures.push('no native ticks');
      if (c.nativePhases.countdown === 0 || c.nativePhases.active === 0)
        report.coverageFailures.push('countdown/active phases absent');
      if (c.fastObservationCalls !== report.frames)
        report.coverageFailures.push('fast observation not checked on every public frame');
      if (c.nativeInfoCalls !== report.frames - 1)
        report.coverageFailures.push('native info not checked on every step/hold');
      if (c.simulatedTicks === 0) report.coverageFailures.push('no simulated native ticks');
      if (
        name === 'moving-platform' &&
        (c.movingMapTicks === 0 || c.discMapContacts === 0 || c.removedOpponentDeaths === 0)
      )
        report.coverageFailures.push('moving map/contact/removed-opponent presentation coverage absent');
      if (name === 'lethal-moving-fixture' && (c.deathCauses[1] === 0 || c.respawnTicks === 0))
        report.coverageFailures.push('moving lethal respawn coverage absent');
      if (name === 'disc-contact' && c.discDiscContacts === 0)
        report.coverageFailures.push('disc contact coverage absent');
      if (
        name === 'timed-capture' &&
        (c.captureProgressTicks === 0 ||
          c.deathCauses[3] === 0 ||
          c.removedDiscTicks === 0 ||
          c.removedPlayerDeaths === 0)
      )
        report.coverageFailures.push('capture progress/removed-player presentation coverage absent');
      if (
        name === 'instant-goal' &&
        (c.deathCauses[3] === 0 || c.removedDiscTicks === 0 || c.removedPlayerDeaths === 0 || c.resultTicks === 0)
      )
        report.coverageFailures.push('instant goal/removed-player presentation coverage absent');
      if (name === 'out-of-bounds' && (c.deathCauses[4] === 0 || c.respawnTicks === 0))
        report.coverageFailures.push('OOB respawn coverage absent');
      if (['moving-platform', 'disc-contact'].includes(name) && report.ticks >= 320) {
        if (
          c.rollovers === 0 ||
          c.postRolloverSimulationTicks === 0 ||
          c.terminalTicks === 0 ||
          c.postRolloverNativeTicks === 0 ||
          c.resultTicks === 0
        )
          report.coverageFailures.push('native rollover and separate terminal-policy boundary not covered');
        if (c.postRolloverCountdowns.some((ftu) => ftu !== 90))
          report.coverageFailures.push('post-rollover countdown is not native 90');
      }
      if (['timed-capture', 'instant-goal'].includes(name) && maxTicks >= 240) {
        if (c.rollovers === 0 || c.postRolloverSimulationTicks === 0 || c.postRolloverNativeTicks === 0)
          report.coverageFailures.push('original-only rollover after terminal hold not covered');
        if (c.postRolloverCountdowns.some((ftu) => ftu !== 90))
          report.coverageFailures.push('post-rollover countdown is not native 90');
      }
      if (['lethal-moving-fixture', 'out-of-bounds'].includes(name) && maxTicks >= 240) {
        if (c.truncationTicks === 0 || c.terminalHoldCalls === 0 || c.terminalResetChecks === 0)
          report.coverageFailures.push('respawn truncation/hold/reset not covered');
      }
      if (
        ['timed-capture', 'instant-goal'].includes(name) &&
        (c.terminalTicks === 0 || c.terminalHoldCalls === 0 || c.terminalResetChecks === 0 || c.resultTicks === 0)
      )
        report.coverageFailures.push('elimination terminal hold/reset not covered');
      if (frameSkip > 1 && c.frameSkipActionWindows === 0)
        report.coverageFailures.push('frame-skip action window absent');
      for (const failure of report.coverageFailures)
        mismatch({ tick: report.ticks, field: 'coverage', actual: failure });
    }
    report.terminalPolicy = terminalPolicy;
    report.originalProvenance = oracle.provenance;
    report.pass = report.firstMismatch === null;
    report.status = report.pass ? 'PASS' : 'FAIL';
    return report;
  } catch (error) {
    report.pass = false;
    report.status = 'ERROR';
    report.error = { message: error.message, stack: error.stack };
    if (!report.firstMismatch)
      report.firstMismatch = { tick: report.ticks, call: report.calls, error: error.stack || String(error) };
    return report;
  } finally {
    env?.close();
    oracle.dispose();
  }
}

function parseArguments(argv, env = process.env, cwd = process.cwd()) {
  const values = {
    raw: env.BONK_RAW_REFERENCE_FILE,
    box2d: env.BOX2D_REFERENCE_FILE,
    trig: env.SAFETRIG_REFERENCE_FILE,
  };
  const options = { ticks: 320, output: null, negativeControl: false, scenarioNames: [], help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--negative-control') {
      options.negativeControl = true;
      continue;
    }
    const key = { '--raw': 'raw', '--box2d': 'box2d', '--safe-trig': 'trig' }[arg];
    if (key) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${arg} requires a file path`);
      values[key] = value;
      continue;
    }
    if (['--ticks', '--out', '--scenario'].includes(arg)) {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `${arg} requires a value`);
      if (arg === '--ticks') {
        options.ticks = Number(value);
        assert(
          Number.isSafeInteger(options.ticks) && options.ticks >= 1 && options.ticks <= 3600,
          '--ticks must be in [1,3600]',
        );
      } else if (arg === '--out') options.output = path.resolve(cwd, value);
      else {
        assert(SCENARIOS.includes(value), `Unknown scenario ${value}`);
        options.scenarioNames.push(value);
      }
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  assert(
    values.box2d && values.trig,
    'Required: --box2d <file> --safe-trig <file> (or reference path environment variables)',
  );
  return {
    paths: {
      rawPath: path.resolve(cwd, values.raw || path.join(ROOT, '.deobf/alpha2s.raw.js')),
      physicsPath: path.resolve(cwd, values.box2d),
      trigPath: path.resolve(cwd, values.trig),
    },
    ...options,
  };
}

function compareNativeDynamicEnvironment(paths, options = {}) {
  const definitions = [];
  for (const quality of [1, 2])
    for (const name of SCENARIOS) definitions.push({ name, quality, frameSkip: 1, maxTicks: options.ticks ?? 320 });
  // Repeat the long moving/respawn/contact cases through the public action-hold
  // seam. FrameSkip3 has its own rollover/truncation/terminal-hold coverage.
  for (const name of ['moving-platform', 'lethal-moving-fixture', 'out-of-bounds'])
    definitions.push({ name, quality: 1, frameSkip: 3, maxTicks: options.ticks ?? 320 });
  const selected = definitions.filter(
    (entry) => !options.scenarioNames?.length || options.scenarioNames.includes(entry.name),
  );
  const results = selected.map((entry) => runScenario(paths, entry.name, entry));
  let negativeControl = null;
  if (options.negativeControl) {
    negativeControl = runScenario(paths, 'moving-platform', { quality: 1, frameSkip: 1, maxTicks: 1, perturb: true });
    negativeControl.name = 'negative-control-injected-public-player-xv-error';
    negativeControl.injectedError = 1e-6;
    negativeControl.detected =
      negativeControl.firstMismatch?.field === 'discs[0].xv' && negativeControl.firstMismatch.error > TOLERANCE;
    negativeControl.pass = negativeControl.detected;
    negativeControl.status = negativeControl.pass ? 'PASS' : 'FAIL';
    delete negativeControl.error;
  }
  return {
    schema: 'bonk-rl-env.native-public-dynamic-environment-differential',
    version: 1,
    pass: results.every((result) => result.pass) && (!negativeControl || negativeControl.pass),
    tolerance: TOLERANCE,
    bitParityClaimed: false,
    originalOnlyExpectedValues: true,
    localRepairOrReseeds: 0,
    scope:
      'Actual dense public BonkEnvironment reset/step/getObservationFast and native info versus pinned original dynamic Classic createNewState/step. Moving maps, contacts, timed capture, instant goal, sparse removed-disc death presentation, immediate respawn, native rollover, and frameSkip1/3 are checked on every call. Elimination/truncation terminal holds are a separate public policy: the frozen terminal presentation is checked, not subsequent native simulation. Direct worker/batch transports and reward values are outside this comparator.',
    provenance: {
      rawClientSha256: digest(paths.rawPath),
      modifiedBox2DSha256: digest(paths.physicsPath),
      safeTrigSha256: digest(paths.trigPath),
      localFiles: Object.fromEntries(LOCAL_FILES.map((file) => [file, digest(path.join(ROOT, file))])),
    },
    ticksPerScenario: options.ticks ?? 320,
    scenarios: results,
    negativeControl,
    totals: {
      scenarios: results.length,
      ticks: results.reduce((sum, result) => sum + result.ticks, 0),
      publicCalls: results.reduce((sum, result) => sum + result.calls, 0),
      frames: results.reduce((sum, result) => sum + result.frames, 0),
      comparisons: results.reduce((sum, result) => sum + result.comparisons, 0),
      numericComparisons: results.reduce((sum, result) => sum + result.numericComparisons, 0),
      discreteComparisons: results.reduce((sum, result) => sum + result.discreteComparisons, 0),
      maximumAbsoluteError: results.reduce((maximum, result) => Math.max(maximum, result.maxError), 0),
    },
  };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(
      'Usage: npx tsx validation/native/compare-native-dynamic-environment.cjs --box2d <file> --safe-trig <file> [--scenario name] [--ticks n] [--negative-control] [--out new-report.json]',
    );
    return { help: true };
  }
  for (const file of Object.values(options.paths))
    assert(fs.statSync(file).isFile(), `Missing native dependency ${file}`);
  const report = compareNativeDynamicEnvironment(options.paths, options);
  if (options.output) {
    assert(!fs.existsSync(options.output), `Output already exists: ${options.output}`);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(
    JSON.stringify(
      {
        pass: report.pass,
        totals: report.totals,
        failures: report.scenarios
          .filter((entry) => !entry.pass)
          .map((entry) => ({
            name: entry.name,
            error: entry.error,
            firstMismatch: entry.firstMismatch,
            coverageFailures: entry.coverageFailures,
          })),
        negativeControlDetected: report.negativeControl?.detected,
      },
      null,
      2,
    ),
  );
  return report;
}

module.exports = {
  SCENARIOS,
  TOLERANCE,
  publicMap,
  publicConfig,
  runScenario,
  parseArguments,
  compareNativeDynamicEnvironment,
  main,
};
if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (!report.help && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
