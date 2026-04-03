# Contributing to Tests — bonk-rl-env

This guide covers conventions and best practices for writing tests in this project.

## Test Naming Conventions

### `describe` Blocks

Name after the module, class, or function under test:

```typescript
describe('PhysicsEngine', () => { ... })
describe('computeReward()', () => { ... })
describe('GameServer.start()', () => { ... })
```

### `it` Blocks

Describe behavior in present tense, starting with a verb:

```typescript
// Good
it('applies gravity to player velocity')
it('returns zero when distance is zero')
it('throws when map file is missing')

// Bad
it('should apply gravity')        // Remove "should"
it('gravity test')                // Too vague
it('applies gravity correctly')   // "correctly" adds no information
```

### Nested Describes

Group by scenario or method:

```typescript
describe('PhysicsEngine', () => {
  describe('update()', () => {
    it('applies gravity')
    it('caps velocity at max speed')
  })

  describe('reset()', () => {
    it('clears all velocities')
    it('restores initial positions')
  })
})
```

## Mocking Guidelines

### When to Mock

| Scenario | Strategy |
|----------|----------|
| File system access | Mock `fs` module |
| Network requests | Mock HTTP client or use nock |
| External APIs | Mock response objects |
| Timers | Use `vi.useFakeTimers()` |
| Console output | Spy on `console.log`, `console.error` |

### When NOT to Mock

| Scenario | Strategy |
|----------|----------|
| Physics calculations | Use real instances — determinism is critical |
| Math/reward functions | Use real instances — verify exact values |
| State transitions | Use real instances — test actual behavior |
| Config loading | Mock `fs` only, not the config parser |

### Physics Tests

Always use real physics instances. The physics engine is deterministic and fast:

```typescript
// Good — real physics
it('bounces ball off wall', () => {
  const world = createPhysicsWorld()
  const ball = createBall({ x: 0, vx: 10 })
  world.add(ball)
  world.update(1)
  expect(ball.vx).toBe(-10)
})
```

### Config Tests

Mock the file system, not the config logic:

```typescript
// Good — mock fs, test real parsing
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('{"gravity": 0.5}'),
}))

it('parses config correctly', () => {
  const config = loadConfig('test.json')
  expect(config.gravity).toBe(0.5)
})
```

## E2E Test Guidelines

E2E tests exercise the full pipeline. They are slower and more fragile than unit tests.

### Rules

1. **Self-contained** — each test sets up its own server, client, and state
2. **Unique ports** — use port `0` for auto-assignment or generate unique ports
3. **Cleanup in `afterAll`** — always stop servers, close connections, remove temp files
4. **Longer timeout** — use `{ timeout: 30000 }` for E2E tests
5. **No shared state** — tests must be independent and order-independent

### Template

```typescript
describe('E2E: Game Flow', () => {
  let server: GameServer
  let port: number

  beforeAll(async () => {
    server = new GameServer({ port: 0 })
    await server.start()
    port = server.port
  })

  afterAll(async () => {
    await server.stop()
  })

  it('completes a full game round', async () => {
    const client = await connectToServer(port)
    await client.joinGame()
    await client.playRound()
    expect(client.result).toBeDefined()
  }, { timeout: 30000 })
})
```

## Performance Test Guidelines

Performance tests track trends, not absolute values. Tolerances must be wide.

### Rules

1. **Wide tolerance** — use ±20% or more. Hardware varies.
2. **Track trends** — compare against baseline, not fixed thresholds
3. **Warm up** — run a few iterations before measuring
4. **Average multiple runs** — reduce noise with statistical aggregation
5. **Skip in CI by default** — run on demand or in scheduled jobs

### Template

```typescript
describe('Performance: Physics Update', () => {
  it('handles 1000 entities within tolerance', () => {
    const world = createPhysicsWorld()
    for (let i = 0; i < 1000; i++) {
      world.add(createBall())
    }

    // Warm up
    for (let i = 0; i < 10; i++) world.update(1)

    const start = performance.now()
    for (let i = 0; i < 100; i++) world.update(1)
    const elapsed = performance.now() - start

    const baseline = 50 // ms, adjust based on actual measurements
    const tolerance = 0.20 // ±20%

    expect(elapsed).toBeLessThan(baseline * (1 + tolerance))
  })
})
```

## Code Review Checklist for Test PRs

Before submitting a PR with test changes, verify:

### Structure
- [ ] Test file is in the correct directory (`unit/`, `integration/`, `e2e/`, etc.)
- [ ] File name follows convention: `<module>.test.ts`
- [ ] `describe` blocks use module/class names
- [ ] `it` blocks describe behavior in present tense

### Quality
- [ ] Tests are deterministic (no flaky timing or randomness without seeds)
- [ ] Each test is independent (no shared mutable state between tests)
- [ ] Assertions are specific (not just `expect(result).toBeTruthy()`)
- [ ] Error cases are tested alongside happy paths

### Mocking
- [ ] Physics and math functions use real instances
- [ ] File system and network calls are properly mocked
- [ ] Mocks are cleaned up after each test

### E2E
- [ ] Server is started on a unique port
- [ ] `afterAll` cleans up all resources
- [ ] Timeout is set appropriately
- [ ] Test is self-contained

### Performance
- [ ] Tolerance is wide enough (±20% minimum)
- [ ] Warm-up iterations are included
- [ ] Multiple runs are averaged

### Coverage
- [ ] New code has corresponding tests
- [ ] Edge cases are covered (empty input, boundary values, errors)
- [ ] Coverage target is met for the affected module
