// Numeric contract observed in the pinned public SafeTrig dependency: round the
// result (not the angle) at 1e-7 precision. Keep Math.round's signed-zero behavior.
const round = (value: number): number => Math.round(value * 10_000_000) / 10_000_000;

export const safeSin = (angle: number): number => round(Math.sin(angle));
export const safeCos = (angle: number): number => round(Math.cos(angle));
export const safeTan = (angle: number): number => round(Math.tan(angle));
export const safeASin = (value: number): number => round(Math.asin(value));
export const safeACos = (value: number): number => round(Math.acos(value));
export const safeATan = (value: number): number => round(Math.atan(value));
export const safeATan2 = (y: number, x: number): number => round(Math.atan2(y, x));
