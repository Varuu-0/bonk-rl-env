import { PhysicsEngine, PlayerInput } from '../src/core/physics-engine';
import { BonkEnvironment } from '../src/core/environment';

const STEPS = 2000;
const WARMUP = 50;

// Benchmark 1: Raw PhysicsEngine
console.log('=== RAW PHYSICS ENGINE BENCHMARK (2000 steps) ===');
const engine = new PhysicsEngine();
engine.addBody({ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true });
engine.addBody({ name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true });
engine.addBody({ name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true });
engine.addPlayer(0, -200, -100);
engine.addPlayer(1, 200, -100);

function randomInput(): PlayerInput {
  return {
    left: Math.random() > 0.5,
    right: Math.random() > 0.5,
    up: Math.random() > 0.5,
    down: Math.random() > 0.5,
    heavy: Math.random() > 0.5,
    grapple: Math.random() > 0.5,
  };
}

// Warmup
for (let i = 0; i < WARMUP; i++) {
  engine.applyInput(0, randomInput());
  engine.applyInput(1, randomInput());
  engine.tick();
}

const physStart = performance.now();
for (let i = 0; i < STEPS; i++) {
  const action = Math.floor(Math.random() * 64);
  engine.applyInput(0, {
    left: !!(action & 1),
    right: !!(action & 2),
    up: !!(action & 4),
    down: !!(action & 8),
    heavy: !!(action & 16),
    grapple: !!(action & 32),
  });
  engine.applyInput(1, randomInput());
  engine.tick();
}
const physEnd = performance.now();
const physElapsed = physEnd - physStart;
const physTPS = STEPS / (physElapsed / 1000);

console.log(`  Steps: ${STEPS}`);
console.log(`  Duration: ${physElapsed.toFixed(2)} ms`);
console.log(`  TPS: ${physTPS.toFixed(0)}`);
console.log(`  Avg tick time: ${(physElapsed / STEPS * 1000).toFixed(1)} us`);
console.log();

// Benchmark 2: BonkEnvironment (full Gymnasium API)
console.log('=== BONK ENVIRONMENT BENCHMARK (2000 steps) ===');
const env = new BonkEnvironment({ numOpponents: 1 });
env.reset();

// Warmup
for (let i = 0; i < WARMUP; i++) {
  env.step(Math.floor(Math.random() * 64));
}

const envStart = performance.now();
for (let i = 0; i < STEPS; i++) {
  env.step(Math.floor(Math.random() * 64));
}
const envEnd = performance.now();
const envElapsed = envEnd - envStart;
const envSPS = STEPS / (envElapsed / 1000);

console.log(`  Steps: ${STEPS}`);
console.log(`  Duration: ${envElapsed.toFixed(2)} ms`);
console.log(`  SPS: ${envSPS.toFixed(0)}`);
console.log(`  Avg step time: ${(envElapsed / STEPS * 1000).toFixed(1)} us`);
console.log();

// Summary
console.log('=== SUMMARY ===');
console.log(`Physics Engine TPS: ${physTPS.toFixed(0)}`);
console.log(`Environment SPS: ${envSPS.toFixed(0)}`);
console.log(`Env overhead vs raw physics: ${((1 - envSPS / physTPS) * 100).toFixed(1)}%`);
