# docs/

Documentation for the Bonk RL Environment — a high-performance headless Bonk.io simulation engine for reinforcement learning. Covers the TypeScript physics engine, Python Gymnasium client, IPC architecture, telemetry, and benchmarks.

## Key Documents

| Document | Description |
|:---------|:------------|
| [index.md](index.md) | Quick links, getting started, test suite, module reference, action/observation space |
| [configuration.md](configuration.md) | Setup, environment config (TypeScript & Python), env variables, restrictions |
| [telemetry.md](telemetry.md) | CLI flags, profile levels, debug output, dashboard, performance characteristics |
| [reward-functions.md](reward-functions.md) | Custom reward function classes (Navigation, Composite, Curiosity), Gymnasium/RLlib integration |
| [PERFORMANCE.md](PERFORMANCE.md) | Benchmark results, scaling analysis, bottleneck breakdown, optimization history |

Additional documents:

| Document | Description |
|:---------|:------------|
| [roadmap.md](roadmap.md) | Project roadmap and planned features |
| [workflow.md](workflow.md) | Development workflow and conventions |
| [deprecated.md](deprecated.md) | Legacy features and migration notes |
| [priority-recommendation.md](priority-recommendation.md) | Recommended development priorities |

## Subdirectories

| Directory | Description |
|:----------|:------------|
| [typescript/](typescript/) | TypeScript engine module docs — core physics, IPC, telemetry, tests |
| [python/](python/) | Python client module docs — Gymnasium env, utilities, benchmarks, tests |

## Documentation Conventions

- Each directory contains a `README.md` with a table of its contents and descriptions.
- Module docs mirror the source tree structure (e.g., `docs/typescript/src/core/` maps to `src/core/`).
- All module docs follow a consistent format: overview, API outline (classes, methods, parameters), usage examples, and see-also links.
- Code snippets use TypeScript or Python syntax highlighting and include type annotations.
- Performance figures reference measurements from the [PERFORMANCE.md](PERFORMANCE.md) report.
