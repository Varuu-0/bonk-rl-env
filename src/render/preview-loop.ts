import { BonkEnvironment } from '../core/environment';
import type { StepResult } from '../core/environment';

export interface PreviewFrameStep<T> {
  result: StepResult;
  frame: T | null;
  episodeEnded: boolean;
  reset: boolean;
}

/**
 * Drive a direct environment with the worker pool's terminal auto-reset
 * semantics. The terminal frame is rendered once, later reports in the
 * frame-skip hold are consumed without rendering, and reset happens only after
 * the renderer has read the ended episode's state.
 */
export function createPreviewFrameStepper<T>(env: BonkEnvironment, renderFrame: () => T): () => PreviewFrameStep<T> {
  let terminalFrameServed = false;

  return () => {
    const result = env.step(0);
    const episodeEnded = result.done && !terminalFrameServed;
    const frame = !result.done || episodeEnded ? renderFrame() : null;
    let reset = false;

    if (result.done) {
      terminalFrameServed = true;
      if (!env.isTerminalHoldActive()) {
        env.reset();
        terminalFrameServed = false;
        reset = true;
      }
    } else {
      terminalFrameServed = false;
    }

    return { result, frame, episodeEnded, reset };
  };
}
