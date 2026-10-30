/** Native dynamic-info codec shared by both ends of the worker transport. */

export const SHARED_NATIVE_CAP_ZONE_FLOATS = 7;
export const NATIVE_CAP_ZONE_FIELDS = ['ty', 'p', 'l', 'i', 'o', 'ot', 'f'] as const;

export type SharedNativePhase = 'countdown' | 'active' | 'round-result' | 'match-result';
export interface SharedNativeCapZone {
  ty: number;
  p: number;
  l: number;
  i: number;
  o: number;
  ot: number;
  f: number;
}

export function sharedInfoFloatsPerEnv(nativeCapZoneCapacity: number = 0): number {
  if (!Number.isSafeInteger(nativeCapZoneCapacity) || nativeCapZoneCapacity < 0) {
    throw new Error(
      `SharedMemoryManager: nativeCapZoneCapacity must be a nonnegative safe integer, got ${nativeCapZoneCapacity}`,
    );
  }
  return 7 + SHARED_NATIVE_CAP_ZONE_FLOATS * nativeCapZoneCapacity;
}

export function encodeNativePhase(phase: unknown): number {
  switch (phase) {
    case 'countdown':
      return 1;
    case 'active':
      return 2;
    case 'round-result':
      return 3;
    case 'match-result':
      return 4;
    default:
      throw new Error(`SharedMemoryManager: unsupported nativePhase ${String(phase)}`);
  }
}

export function decodeNativePhase(code: number): SharedNativePhase {
  switch (code) {
    case 1:
      return 'countdown';
    case 2:
      return 'active';
    case 3:
      return 'round-result';
    case 4:
      return 'match-result';
    default:
      throw new Error(`SharedMemoryManager: unsupported nativePhase code ${code}`);
  }
}

/** Validate the complete public native capture graph before transporting it. */
export function assertNativeCapZones(value: unknown, capacity: number): readonly SharedNativeCapZone[] {
  if (!Array.isArray(value) || value.length !== capacity) {
    throw new Error(
      `SharedMemoryManager: expected ${capacity} native cap zones, got ${Array.isArray(value) ? value.length : typeof value}`,
    );
  }
  for (let zoneIndex = 0; zoneIndex < value.length; zoneIndex++) {
    const zone = value[zoneIndex];
    if (zone === null || typeof zone !== 'object' || Array.isArray(zone)) {
      throw new Error(`SharedMemoryManager: nativeCapZones[${zoneIndex}] must be an object`);
    }
    const keys = Object.keys(zone);
    if (
      keys.length !== NATIVE_CAP_ZONE_FIELDS.length ||
      NATIVE_CAP_ZONE_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(zone, field))
    ) {
      throw new Error(
        `SharedMemoryManager: nativeCapZones[${zoneIndex}] must contain exactly {${NATIVE_CAP_ZONE_FIELDS.join(',')}}`,
      );
    }
    for (const field of NATIVE_CAP_ZONE_FIELDS) {
      if (typeof zone[field] !== 'number' || !Number.isFinite(zone[field])) {
        throw new Error(`SharedMemoryManager: nativeCapZones[${zoneIndex}].${field} must be finite`);
      }
    }
  }
  return value;
}
