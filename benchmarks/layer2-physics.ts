/**
 * Layer 2: Raw Physics Engine Throughput
 *
 * Isolates the Box2D physics engine by calling PhysicsEngine.tick()
 * in a tight loop with minimal overhead — no observation extraction,
 * no reward calculation, no environment wrapper. This measures the
 * pure simulation cost.
 *
 * Layer: 2 — Physics
 * Run:   npx tsx benchmarks/layer2-physics.ts
 */

import { PhysicsEngine, PlayerInput } from '../src/core/physics-engine';
import {
    BenchmarkResult,
    BenchmarkSuite,
    createSuite,
    recordResult,
    finalizeSuite,
    emitSuite,
    formatSuiteSummary,
} from '../src/utils/bench-report';

const STEPS = 2_000;
const WARMUP = 50;

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

function benchPhysicsTick(): BenchmarkResult {
    const engine = new PhysicsEngine();
    engine.addBody({ name: 'floor', type: 'rect', x: 0, y: 200, width: 800, height: 30, static: true });
    engine.addBody({ name: 'left', type: 'rect', x: -500, y: 0, width: 30, height: 600, static: true });
    engine.addBody({ name: 'right', type: 'rect', x: 500, y: 0, width: 30, height: 600, static: true });
    engine.addPlayer(0, -200, -100);
    engine.addPlayer(1, 200, -100);

    for (let i = 0; i < WARMUP; i++) {
        engine.applyInput(0, randomInput());
        engine.applyInput(1, randomInput());
        engine.tick();
    }

    const start = performance.now();
    for (let i = 0; i < STEPS; i++) {
        const action = Math.floor(Math.random() * 64);
        engine.applyInput(0, {
            left: !!(action & 1), right: !!(action & 2),
            up: !!(action & 4), down: !!(action & 8),
            heavy: !!(action & 16), grapple: !!(action & 32),
        });
        engine.applyInput(1, randomInput());
        engine.tick();
    }
    const elapsed = performance.now() - start;
    const tps = STEPS / (elapsed / 1000);
    const usPerTick = (elapsed / STEPS) * 1000;

    return {
        layer: 2,
        name: 'PhysicsEngine.tick() (2 players, applyInput + tick)',
        passed: tps > 15_000,
        status: tps > 15_000 ? 'PASS' : 'FAIL',
        durationMs: elapsed,
        metrics: [
            { label: 'TPS', value: Math.round(tps), unit: 'steps/sec' },
            { label: 'Avg tick time', value: +usPerTick.toFixed(1), unit: 'us' },
            { label: 'Steps', value: STEPS, unit: '' },
        ],
    };
}

function main(): void {
    const suiteStart = performance.now();
    const suite = createSuite(2, 'Raw Physics', 'Box2D physics engine tick throughput (isolated)');

    recordResult(suite, benchPhysicsTick());

    finalizeSuite(suite, performance.now() - suiteStart);
    console.log(formatSuiteSummary(suite));
    emitSuite(suite, 'benchmarks/results/layer2.json');
    process.exit(suite.failed > 0 || suite.errored > 0 ? 1 : 0);
}

main();
