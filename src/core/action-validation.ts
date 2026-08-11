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
 * Validates an `Action` (PlayerInput | number) and throws a labeled
 * `Invalid action: ...` error for every malformed shape, so every transport
 * (direct BonkEnvironment.step, WorkerPool shared-memory and message-passing,
 * and the IPC bridge) rejects the same input identically instead of silently
 * executing a different/no-op action (issue #278).
 *
 * A conforming value is either:
 *   - a finite encoded number (the documented contract is an integer in
 *     [0, 63]; the out-of-range integer rejection is covered separately by
 *     issue #261, and finite non-integer numbers remain accepted for backward
 *     compatibility with the pinned input-validation behavior), or
 *   - a plain object whose present fields are booleans with at least one
 *     field set; missing fields default to false.
 *
 * Arrays, empty objects, non-boolean field values, non-objects, null,
 * undefined, and non-finite numbers (NaN, ±Infinity) are rejected.
 */
export function assertValidAction(action: unknown): asserts action is PlayerInput | number {
    if (typeof action === 'number') {
        if (!Number.isFinite(action)) {
            throw new Error(
                `Invalid action: expected a finite encoded number, got ${String(action)}`,
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
    if (!hasField) {
        throw new Error('Invalid action: expected a PlayerInput object with a boolean field, got an empty object');
    }
}
