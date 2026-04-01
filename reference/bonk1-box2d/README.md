# bonk1-box2d

Original ActionScript 3 source code from the Bonk.io game engine, including the Box2D physics library. This is the complete AS3 project that shipped with Bonk 1 (the predecessor to bonk.io).

## Subdirectories

| Directory | Description |
|-----------|-------------|
| `Source/Box2D/` | Box2D physics engine source (AS3 port of Box2D v2.1 alpha) |
| `Examples/` | Example implementations including TestBed demos and benchmarks |
| `Docs/` | Box2D API documentation (ASDoc-generated HTML reference) |
| `Build/` | FlashDevelop project build configuration |

The `Source/Box2D/` directory contains the core physics modules:

| Subdirectory | Contents |
|--------------|----------|
| `Collision/` | Broadphase, collision detection, and shape primitives |
| `Common/` | Math utilities (`b2Vec2`, `b2Math`, `b2Settings`) |
| `Dynamics/` | World, body, joint, and contact solvers |

A custom Bonk.io-specific file `b2ChazSafeTrig.as` exists at the `Source/Box2D/` root.

## Purpose

This directory exists as **reference material only**. It serves to:

- **Verify original physics behavior** — understand how the game computes forces, resolves collisions, and integrates positions
- **Check constants** — confirm exact values for gravity, velocity iterations, position iterations, sleep thresholds, and other `b2Settings` constants used in production
- **Debug edge cases** — when the RL environment produces unexpected physics, compare against the original implementation to identify divergences

## Warning

**This code is NOT compiled or used by the RL environment.** It is purely reference material.

The RL environment (`src/`, `python/`) reimplements the physics simulation independently. The ActionScript code here cannot be directly executed — it requires Adobe Flash/AIR toolchain and is archived for historical accuracy only.
