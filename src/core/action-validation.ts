import type { PlayerInput } from './physics-engine';

/**
 * The six discrete input fields of a PlayerInput action, in bit order:
 * left=1, right=2, up=4, down=8, heavy=16, grapple=32. The single source of
 * truth for the encoded-action layout: the bit flags and validation range
 * below derive from it, and the encoders/decoders consume the same table, so
 * a future field change cannot leave transports hardcoding a stale width
 * (issue #330).
 */
export const ACTION_FIELDS: ReadonlyArray<keyof PlayerInput> = ['left', 'right', 'up', 'down', 'heavy', 'grapple'];

/**
 * The number of bits used by the action encoders/decoders, which caps the
 * encoded action space at [0, 63]. Derived from ACTION_FIELDS so the width
 * always matches the shared bit table.
 */
export const ACTION_ENCODING_BITS = ACTION_FIELDS.length;

/**
 * Bit flag for each ACTION_FIELDS entry (left=1, right=2, up=4, down=8,
 * heavy=16, grapple=32). Shared with the encoders/decoders so every transport
 * applies the exact bit layout validated here.
 */
export const ACTION_BIT_FLAGS: ReadonlyArray<number> = ACTION_FIELDS.map((_, index) => 1 << index);

/**
 * The encoded-action range cap shared with every consumer of the Discrete(64)
 * byte space ([0, 63]): the native-trace parser validates recorded bytes
 * against it and the transports validate live actions against it, so a future
 * field change cannot leave a stale bound behind (issue #450).
 */
export const MAX_ENCODED_ACTION = (1 << ACTION_ENCODING_BITS) - 1;

/**
 * Encodes a validated PlayerInput object into its shared six-bit number using
 * ACTION_BIT_FLAGS, so every transport (WorkerPool shared-memory and
 * message-passing) applies the exact bit layout validated here.
 */
export function encodePlayerInput(action: PlayerInput): number {
  let encoded = 0;
  for (let i = 0; i < ACTION_ENCODING_BITS; i++) {
    if (action[ACTION_FIELDS[i]]) encoded |= ACTION_BIT_FLAGS[i];
  }
  return encoded;
}

/**
 * Decodes a shared six-bit encoded action number back into a PlayerInput
 * object, mirroring encodePlayerInput (issue #330).
 */
export function decodeEncodedAction(bits: number): PlayerInput {
  const decoded: PlayerInput = {
    left: false,
    right: false,
    up: false,
    down: false,
    heavy: false,
    grapple: false,
  };
  for (let i = 0; i < ACTION_ENCODING_BITS; i++) {
    decoded[ACTION_FIELDS[i]] = !!(bits & ACTION_BIT_FLAGS[i]);
  }
  return decoded;
}

/**
 * Validates an `Action` (PlayerInput | number) and throws a labeled
 * `Invalid action: ...` error for every malformed shape, so every transport
 * (direct BonkEnvironment.step, WorkerPool shared-memory and message-passing,
 * and the IPC bridge) rejects the same input identically instead of silently
 * executing a different/no-op action (issue #278).
 *
 * A conforming value is either:
 *   - an integer encoded number in [0, 63], or
 *   - a plain object whose own enumerable keys are exactly the six
 *     PlayerInput fields, each present field boolean, with at least one field
 *     set; missing fields default to false.
 *
 * Arrays, empty objects, unknown/typo'd field names, non-boolean field
 * values, non-objects, null, undefined, and non-finite numbers (NaN,
 * ±Infinity) are rejected.
 */
export function assertValidAction(action: unknown): asserts action is PlayerInput | number {
  if (typeof action === 'number') {
    if (!Number.isFinite(action)) {
      throw new Error(`Invalid action: expected a finite encoded number, got ${String(action)}`);
    }
    if (!Number.isInteger(action) || action < 0 || action > MAX_ENCODED_ACTION) {
      throw new Error(`Invalid action: expected an encoded action in [0, ${MAX_ENCODED_ACTION}], got ${action}`);
    }
    return;
  }
  if (action === null || typeof action !== 'object') {
    throw new Error(
      `Invalid action: expected a PlayerInput object or an encoded number, got ${action === null ? 'null' : typeof action}`,
    );
  }
  if (Array.isArray(action)) {
    throw new Error('Invalid action: expected a PlayerInput object, got array');
  }
  const record = action as Record<string, unknown>;
  let hasField = false;
  for (const field of ACTION_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    hasField = true;
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid action: field "${field}" must be boolean, got ${typeof value}`);
    }
  }
  const unknownKey = Object.keys(record).find((key) => !ACTION_FIELDS.includes(key as keyof PlayerInput));
  if (unknownKey !== undefined) {
    throw new Error(`Invalid action: unknown field "${unknownKey}" (expected only ${ACTION_FIELDS.join(', ')})`);
  }
  if (!hasField) {
    throw new Error('Invalid action: expected a PlayerInput object, got no recognized boolean action fields');
  }
}
