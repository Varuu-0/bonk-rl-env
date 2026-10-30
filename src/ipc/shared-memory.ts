/**
 * SharedMemoryManager - Zero-Copy IPC using SharedArrayBuffer
 */

import { MAX_OPPONENTS, numOpponentsError } from '../core/opponent-capacity';
import {
  NATIVE_CAP_ZONE_FIELDS,
  SHARED_NATIVE_CAP_ZONE_FLOATS,
  assertNativeCapZones,
  sharedInfoFloatsPerEnv,
} from './native-info-codec';

export const SHARED_INFO_FLOATS_PER_ENV = 7;
export class SharedMemoryManager {
  private observationFloats: number;
  private infoFloats: number;
  private nativeCapZoneCapacity: number;
  private buffer: SharedArrayBuffer;
  private views: {
    actions: Uint8Array;
    observations: Float32Array;
    terminalObservations: Float32Array;
    hasTerminalObs: Uint8Array;
    rewards: Float32Array;
    dones: Uint8Array;
    truncated: Uint8Array;
    terminated: Uint8Array;
    ticks: Uint32Array;
    info: Float32Array;
  };
  private seeds: Uint32Array;
  private control: {
    stepCounter: Int32Array;
    workerReady: Int32Array;
    mainReady: Int32Array;
    actionSlotIndex: Int32Array;
    command: Int32Array; // 0=step, 1=reset, 2=shutdown
    completed: Int32Array;
  };

  private numEnvs: number;
  private ringSize: number;
  private actionRingMask: number;
  private currentActionSlot: number = 0;
  private ownsBuffer: boolean = false;

  constructor(
    numEnvs: number,
    ringSize: number = 16,
    existingBuffer?: SharedArrayBuffer,
    numOpponents: number = 1,
    nativeCapZoneCapacity: number = 0,
  ) {
    this.numEnvs = numEnvs;
    if (ringSize < 2 || (ringSize & (ringSize - 1)) !== 0) {
      throw new Error(`SharedMemoryManager: ringSize must be a power of 2 (got ${ringSize})`);
    }
    this.ringSize = ringSize;
    this.actionRingMask = ringSize - 1;

    // Per-env observation record: 7 player floats, 6 floats per opponent,
    // 2 arena floats, 1 tick. The first opponent keeps the legacy offsets
    // 7-12 and arena/tick stay at 13-15, so the default single-opponent
    // layout is byte-identical to the old fixed 16-float record; extra
    // opponents append 6-float blocks after the tick (offsets 16+).
    this.observationFloats = SharedMemoryManager.floatsPerEnv(numOpponents);
    this.nativeCapZoneCapacity = nativeCapZoneCapacity;
    this.infoFloats = sharedInfoFloatsPerEnv(nativeCapZoneCapacity);

    const align8 = (n: number) => (n + 7) & ~7;
    const actionBytes = align8(numEnvs * ringSize);
    const obsBytes = align8(numEnvs * this.observationFloats * 4);
    const terminalObsBytes = align8(numEnvs * this.observationFloats * 4);
    const hasTerminalObsBytes = align8(numEnvs * 1);
    const rewardBytes = align8(numEnvs * 4);
    const doneBytes = align8(numEnvs * 1);
    const truncatedBytes = align8(numEnvs * 1);
    const terminatedBytes = align8(numEnvs * 1);
    const tickBytes = align8(numEnvs * 4);
    const seedBytes = align8(numEnvs * 4);
    // Per-env dynamic step-info floats: aiAlive, opponentsAlive,
    // scoreBlue, scoreRed, native flag, nativeRoundTick, nativePhase
    // (0=legacy, 1=countdown, 2=active, 3=round-result, 4=match-result).
    // Native mode is constant for an environment's lifetime and transported
    // in static init info. Each authored capture zone appends seven floats in
    // {ty,p,l,i,o,ot,f} order; zero capacity retains the seven-float layout.
    const infoBytes = align8(numEnvs * this.infoFloats * 4);
    const controlBytes = 64; // Reserve plenty

    const totalBytes =
      actionBytes +
      obsBytes +
      terminalObsBytes +
      hasTerminalObsBytes +
      rewardBytes +
      doneBytes +
      truncatedBytes +
      terminatedBytes +
      tickBytes +
      seedBytes +
      infoBytes +
      controlBytes;

    if (existingBuffer) {
      if (existingBuffer.byteLength !== totalBytes) {
        throw new Error(
          `SharedMemoryManager: incompatible buffer size ${existingBuffer.byteLength}; expected ${totalBytes} for this info/observation layout`,
        );
      }
      this.buffer = existingBuffer;
      this.ownsBuffer = false;
    } else {
      this.buffer = new SharedArrayBuffer(totalBytes);
      this.ownsBuffer = true;
    }

    let offset = 0;
    this.views = {
      actions: new Uint8Array(this.buffer, offset, numEnvs * ringSize),
      observations: null as any,
      terminalObservations: null as any,
      hasTerminalObs: null as any,
      rewards: null as any,
      dones: null as any,
      truncated: null as any,
      terminated: null as any,
      ticks: null as any,
      info: null as any,
    };
    offset = align8(offset + actionBytes);

    this.views.observations = new Float32Array(this.buffer, offset, numEnvs * this.observationFloats);
    offset = align8(offset + obsBytes);

    this.views.terminalObservations = new Float32Array(this.buffer, offset, numEnvs * this.observationFloats);
    offset = align8(offset + terminalObsBytes);

    this.views.hasTerminalObs = new Uint8Array(this.buffer, offset, numEnvs);
    offset = align8(offset + hasTerminalObsBytes);

    this.views.rewards = new Float32Array(this.buffer, offset, numEnvs);
    offset = align8(offset + rewardBytes);

    this.views.dones = new Uint8Array(this.buffer, offset, numEnvs);
    offset = align8(offset + doneBytes);

    this.views.truncated = new Uint8Array(this.buffer, offset, numEnvs);
    offset = align8(offset + truncatedBytes);

    this.views.terminated = new Uint8Array(this.buffer, offset, numEnvs);
    offset = align8(offset + terminatedBytes);

    this.views.ticks = new Uint32Array(this.buffer, offset, numEnvs);
    offset = align8(offset + tickBytes);

    this.seeds = new Uint32Array(this.buffer, offset, numEnvs);
    offset = align8(offset + seedBytes);

    this.views.info = new Float32Array(this.buffer, offset, numEnvs * this.infoFloats);
    offset = align8(offset + infoBytes);

    this.control = {
      stepCounter: new Int32Array(this.buffer, offset, 1),
      workerReady: new Int32Array(this.buffer, offset + 4, 1),
      mainReady: new Int32Array(this.buffer, offset + 8, 1),
      actionSlotIndex: new Int32Array(this.buffer, offset + 12, 1),
      command: new Int32Array(this.buffer, offset + 16, 1),
      completed: new Int32Array(this.buffer, offset + 20, 1),
    };

    if (!existingBuffer) {
      this.reset();
    }
  }

  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined';
  }

  /**
   * Canonical numOpponents normalization shared by every SAB layout
   * participant (manager, worker, pool, environment). null/undefined/NaN
   * and other non-finite values fall back to the documented default of 1
   * (matching the historical `numOpponents ?? 1` semantics); a finite
   * number is floored and clamped to >= 0 so the environment's spawned
   * opponent count always matches the SAB record size. Finite values above
   * MAX_OPPONENTS are rejected with a labeled error (#392): the bundled
   * Box2D broadphase pair table (4096 slots) is exhausted by the quadratic
   * pairs from co-located disc spawns long before such counts work, and an
   * unvalidated value used to crash deep inside the physics library with an
   * opaque TypeError.
   */
  static normalizeNumOpponents(value: unknown): number {
    const n = Number(value);
    if (value == null || !Number.isFinite(n)) return 1;
    const normalized = Math.max(0, Math.floor(n));
    if (normalized > MAX_OPPONENTS) {
      throw numOpponentsError(normalized);
    }
    return normalized;
  }

  /**
   * Floats per environment in the shared-memory observation record:
   * 7 player + 6 * numOpponents + 2 arena + 1 tick.
   */
  static floatsPerEnv(numOpponents: unknown = 1): number {
    return 16 + 6 * Math.max(0, SharedMemoryManager.normalizeNumOpponents(numOpponents) - 1);
  }

  getObservationFloats(): number {
    return this.observationFloats;
  }

  getInfoFloats(): number {
    return this.infoFloats;
  }

  getNativeCapZoneCapacity(): number {
    return this.nativeCapZoneCapacity;
  }

  static calculateBufferSize(
    numEnvs: number,
    ringSize: number = 16,
    numOpponents: number = 1,
    nativeCapZoneCapacity: number = 0,
  ): number {
    const align8 = (n: number) => (n + 7) & ~7;
    const floats = SharedMemoryManager.floatsPerEnv(numOpponents);
    const infoFloats = sharedInfoFloatsPerEnv(nativeCapZoneCapacity);
    return (
      align8(numEnvs * ringSize) +
      align8(numEnvs * floats * 4) +
      align8(numEnvs * floats * 4) +
      align8(numEnvs * 1) +
      align8(numEnvs * 4) +
      align8(numEnvs * 1) +
      align8(numEnvs * 1) +
      align8(numEnvs * 1) +
      align8(numEnvs * 4) +
      align8(numEnvs * 4) +
      align8(numEnvs * infoFloats * 4) +
      64
    );
  }

  getBuffer() {
    return this.buffer;
  }
  getNumEnvs() {
    return this.numEnvs;
  }

  writeActions(actions: Uint8Array) {
    const slot = this.currentActionSlot;
    this.views.actions.set(actions, slot * this.numEnvs);
    Atomics.store(this.control.actionSlotIndex, 0, slot);
    this.currentActionSlot = (this.currentActionSlot + 1) & this.actionRingMask;
    // Signal that new actions are available
    Atomics.store(this.control.workerReady, 0, 1);
    Atomics.notify(this.control.workerReady, 0, 1);
  }

  writeActionsQuiet(actions: Uint8Array) {
    const slot = this.currentActionSlot;
    this.views.actions.set(actions, slot * this.numEnvs);
    Atomics.store(this.control.actionSlotIndex, 0, slot);
    this.currentActionSlot = (this.currentActionSlot + 1) & this.actionRingMask;
    // Does NOT signal — caller must call sendCommand separately
  }

  writeSeeds(seeds: number[]) {
    // Fill every slot first so environments beyond a short seed list get
    // the no-seed sentinel (0) instead of silently replaying whatever the
    // previous batch wrote. Without this, a partial reset would re-run the
    // previous batch's seeds for the tail environments.
    this.seeds.fill(0);
    this.seeds.set(seeds.slice(0, this.numEnvs));
  }

  readSeeds(): Uint32Array {
    return this.seeds;
  }

  /**
   * Step metadata reuses the per-lane seed words after reset has consumed
   * them. Every step writes every lane before publishing results; the next
   * reset overwrites the whole region through writeSeeds().
   */
  writeAutoResetAfter(envIndex: number, autoResetAfter: boolean) {
    this.seeds[envIndex] = autoResetAfter ? 1 : 0;
  }

  sendCommand(cmd: number) {
    Atomics.store(this.control.command, 0, cmd);
    Atomics.store(this.control.workerReady, 0, 1);
    Atomics.notify(this.control.workerReady, 0, 1);
  }

  readCommand(): number {
    return Atomics.load(this.control.command, 0);
  }

  signalWorkerReady() {
    Atomics.store(this.control.workerReady, 0, 1);
    Atomics.notify(this.control.workerReady, 0, 1);
  }

  signalMainReady() {
    Atomics.store(this.control.mainReady, 0, 1);
    Atomics.notify(this.control.mainReady, 0, 1);
  }

  getCompleted(): Int32Array {
    return this.control.completed;
  }

  signalCompleted(): void {
    Atomics.add(this.control.completed, 0, 1);
    Atomics.notify(this.control.completed, 0, 1);
  }

  waitForResults(timeout: number = Infinity) {
    const res = Atomics.wait(this.control.mainReady, 0, 0, timeout === Infinity ? undefined : timeout);
    this.consumeResultsSignal();
    return res;
  }

  isResultsReady() {
    return Atomics.load(this.control.mainReady, 0) === 1;
  }
  consumeResultsSignal() {
    Atomics.store(this.control.mainReady, 0, 0);
  }

  readResults() {
    return {
      observations: this.views.observations,
      terminalObservations: this.views.terminalObservations,
      hasTerminalObs: this.views.hasTerminalObs,
      rewards: this.views.rewards,
      dones: this.views.dones,
      truncated: this.views.truncated,
      terminated: this.views.terminated,
      ticks: this.views.ticks,
      info: this.views.info,
      autoResetAfter: this.seeds,
    };
  }

  writeObservation(envIndex: number, obs: number[] | Float32Array) {
    this.views.observations.set(obs, envIndex * this.observationFloats);
  }

  writeTerminalObservation(envIndex: number, obs: number[] | Float32Array) {
    this.views.terminalObservations.set(obs, envIndex * this.observationFloats);
  }

  writeHasTerminalObs(envIndex: number, has: number) {
    this.views.hasTerminalObs[envIndex] = has;
  }

  writeReward(envIndex: number, reward: number) {
    this.views.rewards[envIndex] = reward;
  }
  writeDone(envIndex: number, done: number) {
    this.views.dones[envIndex] = done;
  }
  writeTruncated(envIndex: number, truncated: number) {
    this.views.truncated[envIndex] = truncated;
  }
  writeTerminated(envIndex: number, terminated: number) {
    this.views.terminated[envIndex] = terminated;
  }
  writeTick(envIndex: number, tick: number) {
    this.views.ticks[envIndex] = tick;
  }

  /**
   * Writes the seven base dynamic fields. Capture records use the same
   * computed per-env stride but are written separately after validation.
   */
  writeInfo(envIndex: number, values: number[] | Float32Array) {
    if (values.length !== SHARED_INFO_FLOATS_PER_ENV) {
      throw new Error(`SharedMemoryManager: expected ${SHARED_INFO_FLOATS_PER_ENV} info floats, got ${values.length}`);
    }
    this.views.info.set(values, envIndex * this.infoFloats);
  }

  writeNativeCapZones(envIndex: number, value: unknown) {
    const zones = assertNativeCapZones(value, this.nativeCapZoneCapacity);
    const base = envIndex * this.infoFloats + SHARED_INFO_FLOATS_PER_ENV;
    for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex++) {
      const zone = zones[zoneIndex];
      const offset = base + zoneIndex * SHARED_NATIVE_CAP_ZONE_FLOATS;
      for (let field = 0; field < NATIVE_CAP_ZONE_FIELDS.length; field++) {
        this.views.info[offset + field] = zone[NATIVE_CAP_ZONE_FIELDS[field]];
      }
    }
  }

  incrementStepCounter() {
    return Atomics.add(this.control.stepCounter, 0, 1);
  }

  waitForActions(timeout: number = Infinity) {
    return Atomics.wait(this.control.workerReady, 0, 0, timeout === Infinity ? undefined : timeout);
  }

  signalWorkerConsumed() {
    Atomics.store(this.control.workerReady, 0, 0);
  }

  /** Check if there are new actions waiting for the worker to consume */
  hasNewActions(): boolean {
    return Atomics.load(this.control.workerReady, 0) === 1;
  }

  readActionSlot() {
    return Atomics.load(this.control.actionSlotIndex, 0) & this.actionRingMask;
  }

  getActionsView(slot: number) {
    return this.views.actions.subarray(slot * this.numEnvs, (slot + 1) * this.numEnvs);
  }

  readActions(slot: number) {
    return this.views.actions.subarray(slot * this.numEnvs, (slot + 1) * this.numEnvs);
  }

  reset() {
    this.views.actions.fill(0);
    this.views.observations.fill(0);
    this.views.terminalObservations.fill(0);
    this.views.hasTerminalObs.fill(0);
    this.views.rewards.fill(0);
    this.views.dones.fill(0);
    this.views.truncated.fill(0);
    this.views.terminated.fill(0);
    this.views.ticks.fill(0);
    this.seeds.fill(0);
    this.views.info.fill(0);
    Atomics.store(this.control.stepCounter, 0, 0);
    Atomics.store(this.control.workerReady, 0, 0);
    Atomics.store(this.control.mainReady, 0, 0);
    Atomics.store(this.control.actionSlotIndex, 0, 0);
    Atomics.store(this.control.command, 0, 0);
    Atomics.store(this.control.completed, 0, 0);
    this.currentActionSlot = 0;
  }

  getControl() {
    return this.control;
  }

  dispose() {
    if (this.ownsBuffer) this.buffer = null as any;
    this.views = null as any;
    this.control = null as any;
    this.seeds = null as any;
  }
}
