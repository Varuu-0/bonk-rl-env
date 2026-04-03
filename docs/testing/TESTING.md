# Testing Guide — bonk-rl-env

This project uses **Vitest** for TypeScript tests and **pytest** for Python tests.

## Quick Start

```sh
# Run all TypeScript tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode (TDD)
npm run test:watch

# Run Python tests
cd python && pytest
cd python && pytest --cov=.
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm test` | Run all Vitest tests |
| `npm run test:watch` | Watch mode for TDD |
| `npm run test:coverage` | Run with coverage report |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:e2e` | E2E tests (longer timeout) |
| `npm run test:security` | Security tests |
| `npm run test:perf` | Performance tests |
| `npm run test:all` | All tests including E2E and security |
| `npm run typecheck` | TypeScript type checking |

## Test File Organization

```
tests/
├── unit/              # Isolated unit tests (fast, no I/O)
├── integration/       # Integration tests (multiple modules, real deps)
├── e2e/               # End-to-end tests (full pipeline, longer timeout)
├── security/          # Security-focused tests
├── perf/              # Performance and benchmark tests
├── property/          # Property-based tests (fast-check)
└── utils/             # Shared test utilities
    ├── test-helpers.ts
    └── map-loader.ts
```

### Naming Convention

Test files mirror source structure with `.test.ts` suffix:

```
src/engine/physics.ts        →  tests/unit/engine/physics.test.ts
src/server/game-server.ts    →  tests/integration/server/game-server.test.ts
src/client/index.ts          →  tests/e2e/client/client-flow.test.ts
```

## Writing Vitest Tests

Globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`) are enabled — no imports needed.

### Basic Test

```typescript
describe('PhysicsEngine', () => {
  it('applies gravity to player velocity', () => {
    const engine = new PhysicsEngine({ gravity: 0.5 })
    const player = createPlayer({ y: 100 })

    engine.update(player, 1)

    expect(player.vy).toBe(0.5)
  })
})
```

### Async Test

```typescript
describe('GameServer', () => {
  it('accepts player connections', async () => {
    const server = new GameServer({ port: 0 })
    await server.start()

    const client = await connectToServer(server.port)

    expect(client.connected).toBe(true)
    await server.stop()
  })
})
```

### Parameterized Tests

```typescript
describe.each([
  { input: 0, expected: 0 },
  { input: 1, expected: 1 },
  { input: 5, expected: 120 },
])('factorial($input)', ({ input, expected }) => {
  it(`returns ${expected}`, () => {
    expect(factorial(input)).toBe(expected)
  })
})
```

### Property-Based Testing (fast-check)

```typescript
import fc from 'fast-check'

describe('reward function', () => {
  it('always returns non-negative values', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -1000, max: 1000 }),
        fc.float({ min: -1000, max: 1000 }),
        (x, y) => computeReward(x, y) >= 0
      )
    )
  })
})
```

### Mocking

```typescript
import { vi } from 'vitest'

describe('MapLoader', () => {
  it('handles missing files gracefully', () => {
    vi.mock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT') }),
    }))

    const loader = new MapLoader()
    expect(() => loader.load('nonexistent.json')).toThrow()
  })
})
```

## Shared Test Utilities

### `tests/utils/test-helpers.ts`

Common factories, assertions, and setup helpers:

```typescript
import { createPlayer, createBall, createPhysicsWorld } from './utils/test-helpers'

describe('CollisionSystem', () => {
  it('detects player-ball collision', () => {
    const player = createPlayer({ x: 0, y: 0 })
    const ball = createBall({ x: 5, y: 5 })
    const world = createPhysicsWorld([player, ball])

    const collisions = world.detectCollisions()
    expect(collisions).toHaveLength(1)
  })
})
```

### `tests/utils/map-loader.ts`

Helper for loading test maps:

```typescript
import { loadTestMap } from './utils/map-loader'

describe('GameEngine', () => {
  it('runs on default map', () => {
    const map = loadTestMap('default')
    const engine = new GameEngine(map)

    expect(engine.state).toBe('running')
  })
})
```

## pytest (Python)

```sh
# Run all Python tests
cd python && pytest

# With coverage
cd python && pytest --cov=.

# Verbose output
cd python && pytest -v

# Run specific test file
cd python && pytest tests/test_reward.py
```

### Writing pytest Tests

```python
def test_reward_positive_for_progress():
    reward = compute_reward(distance=10, time=5)
    assert reward > 0
```

```python
@pytest.mark.parametrize("input,expected", [
    (0, 0),
    (1, 1),
    (5, 120),
])
def test_factorial(input, expected):
    assert factorial(input) == expected
```

## Coverage Goals

| Module | Target | Current |
|--------|--------|---------|
| `src/engine/` | 90% | — |
| `src/server/` | 85% | — |
| `src/client/` | 80% | — |
| `src/rewards/` | 95% | — |
| `src/utils/` | 90% | — |
| **Overall** | **85%** | **—** |

Generate coverage report:

```sh
npm run test:coverage
```

## Debugging Tips

### Run a Single Test File

```sh
npx vitest run tests/unit/engine/physics.test.ts
```

### Run Tests Matching a Pattern

```sh
npx vitest run -t "gravity"
```

### Debug with Node Inspector

```sh
node --inspect-brk node_modules/vitest/vitest.mjs run
```

Then open `chrome://inspect` in Chrome and attach.

### Verbose Output

```sh
npx vitest run --reporter=verbose
```

### Watch Specific Files

```sh
npx vitest tests/unit/engine/physics.test.ts
```

### Skip Flaky Tests Temporarily

```typescript
it.skip('known flaky test', () => { ... })
```

### Focus on One Test

```typescript
it.only('critical path', () => { ... })
```

### Environment Variables

```sh
DEBUG=vitest:* npm test
```

### Common Issues

| Problem | Solution |
|---------|----------|
| Test timeout | Use `it('...', { timeout: 10000 }, () => { ... })` |
| Port already in use | Use port `0` for auto-assignment, or unique ports per test |
| Stale mocks | Run `npx vitest --clearCache` |
| Missing globals | Check `vitest.config.ts` has `globals: true` |
