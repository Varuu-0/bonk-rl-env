import { createBox2D } from '../vendor/box2d';
import * as SafeTrig from './safe-trig';

/** Each game owns a module instance, including all Box2D static flags/scratch. */
export function createBackend() {
  return createBox2D(SafeTrig);
}
