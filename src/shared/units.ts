/**
 * Shared simulation timing units.
 *
 * Only the evidenced fixed tick rate is declared here. Physics constants stay
 * out of this module until their values are verified.
 */

/** bonk.io runs at 30 ticks per second. */
export const TPS = 30;
export const DT = 1 / TPS;
