# Test Documentation

## Overview

The test suite consists of **336 tests** across **12 suites**, all passing. Tests cover physics simulation, environment lifecycle, grapple mechanics, collision filtering, map integration, and more. Three JSON map files are used for integration tests.

## Maps Directory

| File | Description |
|------|-------------|
| `maps/bonk_Simple_1v1_123.json` | Minimal 1v1 map — 1 static rect platform |
| `maps/bonk_Ball_Pit_524616.json` | Dynamic circle bodies (28), sensor, collision filtering |
| `maps/bonk_WDB__No_Mapshake__716916.json` | Complex map — lethal deathball, polygons, noPhysics sensors, noGrapple, bouncers, team barriers, dynamic ramps |

## Test Suites

| # | File | Tests | Map Used | Purpose |
|---|------|-------|----------|---------|
| 1 | `physics-engine.test.ts` | 25 | None (programmatic) | Raw physics: circles, polygons, sensor, collision filtering, arena bounds, lethal, addBody, grapple |
| 2 | `frame-skip.test.ts` | 22 | Default WDB (loaded internally) | Frame-skip (1,2,3,4,6,8), terminal/truncation drain, seed determinism, reward semantics |
| 3 | `bonk-env.test.ts` | 24 | Default WDB (loaded internally) | BonkEnvironment: action encoding (64 actions), observation (14 floats), seeding, maxTicks, frame-skip passthrough |
| 4 | `prng.test.ts` | 11 | None | PRNG determinism, spawn points, opponent input generation, distribution |
| 5 | `env-manager.test.ts` | 24 | Default WDB (loaded internally) | EnvManager: sync/async modes, shared memory ops, seedAll, parallel operations |
| 6 | `shared-memory.ts` | 7 | None (SharedArrayBuffer) | SharedMemoryManager: observations, actions, seeds, round-trip, Atomics signals |
| 7 | `grapple-mechanics.test.ts` | 34 | None (programmatic) | Grapple: attachment, release, slingshot (99999), noGrapple, innerGrapple, heavy+grapple, dynamic body grapple, distance limit |
| 8 | `dynamic-arena-bounds.test.ts` | 19 | None (programmatic) | Arena bounds: default, single/multiple bodies, 5m margin, asymmetric, recalculation, tall bodies, negative coords |
| 9 | `collision-filtering.test.ts` | 33 | None (programmatic) | Collision filtering: g1/g2/g3/g4 groups, team barriers, dynamic bodies, category bits, direction independence |
| 10 | `map-body-types.test.ts` | 34 | None (programmatic) | Body types: rect, circle, polygon (3-8 verts), static/dynamic, density, restitution (-1/0/0.5/1.0), angle, isLethal, grappleMultiplier |
| 11 | `nophysics-friction.test.ts` | 31 | None (programmatic) | noPhysics sensors: pass-through, lethal sensors, mixed bodies, circle/polygon sensors. Friction: 0/0.1/0.3/0.8/1.0/1.5 |
| 12 | `map-integration.test.ts` | 72 | Simple 1v1, Ball Pit, WDB | Map loading, cross-map simulations (900/300/60 ticks), death ball, bouncer, noPhysics, polygons, spawn, collision filtering, body structure validation |

## Benchmarks

| File | Purpose |
|------|---------|
| `benchmarks/quick-2000-step.ts` | Quick 2000-step throughput benchmark |
| `benchmarks/step-throughput-40k.ts` | 40,000-step throughput benchmark |

## Run Commands

Run individual test suites:

```bash
npx ts-node tests/physics-engine.test.ts
npx ts-node tests/frame-skip.test.ts
npx ts-node tests/bonk-env.test.ts
npx ts-node tests/prng.test.ts
npx ts-node tests/env-manager.test.ts
npx ts-node tests/shared-memory.ts
npx ts-node tests/grapple-mechanics.test.ts
npx ts-node tests/dynamic-arena-bounds.test.ts
npx ts-node tests/collision-filtering.test.ts
npx ts-node tests/map-body-types.test.ts
npx ts-node tests/nophysics-friction.test.ts
npx ts-node tests/map-integration.test.ts
```

Run benchmarks:

```bash
npx ts-node benchmarks/quick-2000-step.ts
npx ts-node benchmarks/step-throughput-40k.ts
```
