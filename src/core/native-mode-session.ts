/**
 * Mode-scoped native Classic sessions on a normalized static arena.
 *
 * Match ownership remains in createNativeSession: this additive wrapper only
 * carries native mode initialization, six-bit controls and Arrow projectiles
 * across the existing ClassicPhysics factory/frame seam. It does not implement
 * countdown, elimination, scoring, result timing or round rollover rules.
 */
import {
  createClassicPhysics,
  type ClassicPhysics,
  type ClassicPhysicsFrame,
  type ClassicPhysicsOptions,
  type ClassicPhysicsWorld,
  type PhysicsDisc,
  type PhysicsPlatform,
  type PhysicsProjectile,
} from './classic-physics';
import {
  createNativeSession,
  type NativeSession,
  type NativeSessionEvents,
  type NativeSessionOptions,
  type NativeSessionSnapshot,
  type NativeSessionStep,
  type NativeSessionArena,
  type NativeStaticArena,
} from './native-session';

export type NativeClassicMode = 'b' | 'ar' | 'ard' | 'v' | 'sp' | 'bs';
export type NativeModeProjectile = PhysicsProjectile;

export interface NativeModeSessionOptions extends Omit<NativeSessionOptions, 'arena' | 'dynamicWorldFactory' | 'mode'> {
  readonly arena: NativeSessionArena;
  /** Native gameSettings.mo. Classic remains the default. */
  readonly mode?: NativeClassicMode;
}

/** A NativeSessionSnapshot plus the native auxiliary projectile table. */
export interface NativeModeSessionSnapshot extends NativeSessionSnapshot {
  readonly projectiles: readonly (NativeModeProjectile | undefined)[];
}

export interface NativeModeSessionStep extends Omit<NativeSessionStep, 'state'> {
  readonly state: NativeModeSessionSnapshot;
}

export interface NativeModeSession extends Omit<NativeSession, 'getState' | 'step' | 'stepWithEvents'> {
  getState(): NativeModeSessionSnapshot;
  step(inputs?: Readonly<Record<number, number>>): NativeModeSessionSnapshot;
  stepWithEvents(inputs?: Readonly<Record<number, number>>): NativeModeSessionStep;
}

const MODES: readonly NativeClassicMode[] = ['b', 'ar', 'ard', 'v', 'sp', 'bs'];
const CANONICAL_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const INITIAL_ENERGY: Readonly<Record<NativeClassicMode, number>> = {
  b: 1000,
  ar: 750,
  ard: 500,
  v: 1000,
  sp: 1000,
  bs: 1000,
};

function invalid(reason: string): never {
  throw new Error(`Invalid native mode session input: ${reason}`);
}

function ownData(value: object, key: PropertyKey, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor))
    invalid(`${label}.${String(key)} must be an own data property`);
  return descriptor.value;
}

function cloneProjectiles(projectiles: readonly (PhysicsProjectile | undefined)[]): (PhysicsProjectile | undefined)[] {
  return projectiles.map((projectile) => (projectile === undefined ? undefined : Object.freeze({ ...projectile })));
}

/**
 * Construct a strict native session with an optional native disc mode.
 * Inputs are integers in [0, 63]; bit 5 is native action2. The base session
 * still validates roster membership and receives only its masked view.
 * Modes sp and bs may use a dynamic unified-world arena; Arrow, Death Arrow
 * and VTOL mechanics are not implemented in that world, so those modes
 * require a static arena and dynamic arenas are rejected loudly.
 */
export function createNativeModeSession(options: NativeModeSessionOptions): NativeModeSession {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    invalid('options must be a plain object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) invalid('options must be a plain object');

  const mode = Object.prototype.hasOwnProperty.call(options, 'mode') ? ownData(options, 'mode', 'options') : 'b';
  if (typeof mode !== 'string' || !MODES.includes(mode as NativeClassicMode))
    invalid('options.mode must be b, ar, ard, v, sp or bs');
  const nativeMode = mode as NativeClassicMode;
  if ('physics' in options.arena && nativeMode !== 'sp' && nativeMode !== 'bs') {
    invalid(
      `options.arena is a dynamic unified-world arena, which only supports modes sp and bs (mode ${JSON.stringify(nativeMode)} mechanics are not implemented in the dynamic world)`,
    );
  }
  const suppliedFactory = Object.prototype.hasOwnProperty.call(options, 'physicsFactory')
    ? ownData(options, 'physicsFactory', 'options')
    : createClassicPhysics;
  if (typeof suppliedFactory !== 'function') invalid('options.physicsFactory must be a function');

  let currentInputs: Readonly<Record<number, number>> = {};
  let projectiles: (PhysicsProjectile | undefined)[] = [];
  let pendingProjectiles: (PhysicsProjectile | undefined)[] = [];
  let physicsAdvanced = false;
  let freshRound = true;

  // Preserve property descriptors so the delegated strict validator sees the
  // same accessors, symbols and unknown fields as a direct native session.
  const baseOptions = Object.create(prototype) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(options)) {
    if (key === 'mode' || key === 'physicsFactory') continue;
    Object.defineProperty(baseOptions, key, Object.getOwnPropertyDescriptor(options, key)!);
  }
  // The unified dynamic world reads the room mode itself (native step reads
  // gameSettings.mo from the settings argument, readable :7221), so sp and bs
  // dynamic arenas receive the mode directly.
  if ('physics' in options.arena && (nativeMode === 'sp' || nativeMode === 'bs')) {
    Object.defineProperty(baseOptions, 'mode', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: nativeMode,
    });
  }
  Object.defineProperty(baseOptions, 'physicsFactory', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: (): ClassicPhysics => {
      const backend = (suppliedFactory as () => ClassicPhysics)();
      if (
        backend === null ||
        typeof backend !== 'object' ||
        typeof backend.stepWorld !== 'function' ||
        typeof backend.dispose !== 'function'
      ) {
        if (backend !== null && typeof backend === 'object') backend.dispose?.();
        invalid('options.physicsFactory must return a ClassicPhysics implementation');
      }
      const stepWorld = (
        discs: readonly PhysicsDisc[],
        platforms: readonly PhysicsPlatform[],
        _maskedInputs: Readonly<Record<number, number>>,
        physicsOptions: ClassicPhysicsOptions,
        _frame?: ClassicPhysicsFrame,
      ): ClassicPhysicsWorld => {
        // Native fresh-round energy (4712-4717): only ar (750) and ard (500)
        // override the default 1000; b, v, sp and bs all spawn at 1000.
        const initializedDiscs =
          freshRound && nativeMode !== 'b' && nativeMode !== 'v' && nativeMode !== 'sp' && nativeMode !== 'bs'
            ? discs.map((disc) => ({ ...disc, energy: INITIAL_ENERGY[nativeMode] }))
            : discs;
        const world = backend.stepWorld(
          initializedDiscs,
          platforms,
          currentInputs,
          { ...physicsOptions, mode: nativeMode },
          { projectiles },
        );
        if (world.projectiles !== undefined && !Array.isArray(world.projectiles))
          invalid('physicsFactory returned a non-array projectile table');
        if (nativeMode !== 'ar' && nativeMode !== 'ard' && (world.projectiles?.length ?? 0) > 0)
          invalid('projectiles require Arrow or Death Arrow mode');
        pendingProjectiles = cloneProjectiles(world.projectiles ?? []);
        physicsAdvanced = true;
        return world;
      };
      return {
        stepWorld,
        step(discs, platforms, inputs, physicsOptions, frame) {
          return stepWorld(discs, platforms, inputs, physicsOptions, frame).discs;
        },
        stepDetailed: stepWorld,
        dispose(): void {
          backend.dispose();
        },
      };
    },
  });

  const session: NativeSession = createNativeSession(baseOptions as unknown as NativeSessionOptions);

  function snapshot(base: NativeSessionSnapshot = session.getState()): NativeModeSessionSnapshot {
    const discs =
      freshRound && nativeMode !== 'b' && nativeMode !== 'v' && nativeMode !== 'sp' && nativeMode !== 'bs'
        ? base.discs.map((disc) =>
            disc === undefined ? undefined : Object.freeze({ ...disc, energy: INITIAL_ENERGY[nativeMode] }),
          )
        : base.discs;
    return Object.freeze({
      ...base,
      discs: Object.freeze(discs),
      projectiles: Object.freeze(cloneProjectiles(projectiles)),
    });
  }

  function normalizeInputs(
    inputs: Readonly<Record<number, number>> | undefined,
    base: NativeSessionSnapshot,
  ): {
    masked: Readonly<Record<number, number>>;
    full: Readonly<Record<number, number>>;
  } {
    const raw = inputs ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('inputs must be a plain object');
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) invalid('inputs must be a plain object');
    if (Object.getOwnPropertySymbols(raw).length > 0) invalid('inputs must not have symbol fields');
    const masked: Record<number, number> = {};
    const validated: Record<number, number> = {};
    for (const key of Object.getOwnPropertyNames(raw)) {
      if (!CANONICAL_DECIMAL_ID.test(key))
        invalid(`inputs key ${JSON.stringify(key)} is not a canonical decimal player ID`);
      const id = Number(key);
      if (!base.players[id]) invalid(`inputs contains unknown player ${key}`);
      const value = ownData(raw, key, 'inputs');
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 63)
        invalid(`inputs[${key}] must be an integer in [0, 63]`);
      validated[id] = value;
      masked[id] = value & 31;
    }
    const live: Record<number, number> = {};
    for (const disc of base.discs) {
      if (disc?.alive) live[disc.id] = validated[disc.id] ?? 0;
    }
    return { masked, full: live };
  }

  function stepWithEvents(inputs: Readonly<Record<number, number>> = {}): NativeModeSessionStep {
    const entry = session.getState();
    // Native ignores the input object on these no-solver branches. Preserve
    // that ordering rather than eagerly rejecting an otherwise unused value.
    const ignoresInputs = entry.matchComplete || entry.fte === 0;
    const normalized = ignoresInputs ? null : normalizeInputs(inputs, entry);
    currentInputs = normalized?.full ?? {};
    physicsAdvanced = false;
    pendingProjectiles = [];
    // Grapple mode on a dynamic arena carries bit 5 (action2) into the unified
    // world, which validates it for sp itself; every other path keeps the
    // masked five-bit view the base session has always validated.
    const dynamicSp = 'physics' in options.arena && nativeMode === 'sp';
    const result = session.stepWithEvents(ignoresInputs ? inputs : dynamicSp ? normalized!.full : normalized!.masked);
    if (result.events.newRound) {
      projectiles = [];
      freshRound = true;
    } else if (physicsAdvanced) {
      projectiles = pendingProjectiles;
      freshRound = false;
    }
    pendingProjectiles = [];
    return Object.freeze({ state: snapshot(result.state), events: result.events });
  }

  return Object.freeze({
    getState: () => snapshot(),
    getEvents: (): NativeSessionEvents => session.getEvents(),
    step(inputs: Readonly<Record<number, number>> = {}): NativeModeSessionSnapshot {
      return stepWithEvents(inputs).state;
    },
    stepWithEvents,
    dispose(): void {
      session.dispose();
    },
  });
}
