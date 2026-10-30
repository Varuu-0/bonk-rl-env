/**
 * Pure player-input contract shared by the game core, codecs and consumers.
 *
 * Kept free of physics/backend imports so input producers and transports do not
 * need the physics implementation.
 */
export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  heavy: boolean;
  grapple: boolean;
}
