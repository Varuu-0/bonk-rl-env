'use strict';

/**
 * Opt-in integration fault injection, loaded into real WorkerPool threads via
 * NODE_OPTIONS by native-worker-failure-recreation.test.ts. It never changes
 * repository production modules. Only worker.ts's BonkEnvironment is wrapped;
 * the marked action exits that native worker from inside its active step.
 */
const Module = require('node:module');
const path = require('node:path');

const workerPath = path.resolve(__dirname, '../../src/core/worker.ts');
const originalLoad = Module._load;
let installed = false;

Module._load = function loadWithNativeCrashInjection(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (!installed && request === './environment' && parent?.filename && path.resolve(parent.filename) === workerPath) {
    const originalStep = loaded.BonkEnvironment.prototype.step;
    loaded.BonkEnvironment.prototype.step = function stepWithInjectedCrash(action) {
      if (action === 47) {
        const fs = require('node:fs');
        fs.writeSync(2, '[reliability] injected native worker crash\n');
        process.exit(86);
      }
      return originalStep.call(this, action);
    };
    installed = true;
  }
  return loaded;
};
