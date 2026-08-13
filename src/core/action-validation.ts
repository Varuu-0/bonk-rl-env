import type { PlayerInput } from './physics-engine';

/**
 * The six discrete input fields of a PlayerInput action.
 */
const PLAYER_INPUT_FIELDS: Array<keyof PlayerInput> = [
    'left',
    'right',
    'up',
    'down',
    'heavy',
    'grapple',
];

/**
 * The number of bits used by the action encoders/decoders
 * (left=1, right=2, up=4, down=8, heavy=16, grapple=32), which caps the
 * encoded action space at [0, 63]. Kept in lockstep with the bit flags the
 * encoders/decoders apply so the validation range cannot drift from the
 * transport encoding (issue #330).
 */
export const ACTION_ENCODING_BITS = 6;

const MAX_ENCODED_ACTION = (1 << ACTION_ENCODING_BITS) - 1;

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
            throw new Error(
                `Invalid action: expected a finite encoded number, got ${String(action)}`,
            );
        }
        if (!Number.isInteger(action) || action < 0 || action > MAX_ENCODED_ACTION) {
            throw new Error(
                `Invalid action: expected an encoded action in [0, ${MAX_ENCODED_ACTION}], got ${action}`,
            );
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
    for (const field of PLAYER_INPUT_FIELDS) {
        const value = record[field];
        if (value === undefined) continue;
        hasField = true;
        if (typeof value !== 'boolean') {
            throw new Error(
                `Invalid action: field "${field}" must be boolean, got ${typeof value}`,
            );
        }
    }
    const unknownKey = Object.keys(record).find(
        key => !PLAYER_INPUT_FIELDS.includes(key as keyof PlayerInput),
    );
    if (unknownKey !== undefined) {
        throw new Error(
            `Invalid action: unknown field "${unknownKey}" (expected only ${PLAYER_INPUT_FIELDS.join(', ')})`,
        );
    }
    if (!hasField) {
        throw new Error('Invalid action: expected a PlayerInput object, got no recognized boolean action fields');
    }
}
