# Configuration Guide

## config.ts

The main configuration file is at the project root: `config.ts`

## Basic Settings

| Option | Default | Description |
|:-------|:--------|:------------|
| `port` | 5555 | ZeroMQ IPC port |
| `roomNameOnStartup` | "Manifold Server" | Default room name |
| `maxPlayers` | 12 | Maximum players |

## Game Settings

```typescript
{
  map: 'encoded_map_string',
  gt: 2,   // Game time (minutes)
  wl: 3,   // Win limit
  q: false, // Quick play
  mo: 'b'  // Mode: 'b'=classic, 'f'=football
}
```

## Environment Configuration

### TypeScript (Worker Pool)

```typescript
// In src/core/worker-pool.ts
await pool.init(numEnvs, {
  frameSkip: 1,        // Ticks to hold each action
  numOpponents: 1,    // Number of AI opponents
  maxTicks: 900,      // Max ticks per episode
  randomOpponent: true, // Use random opponent policy
  seed: undefined,   // Random seed
}, useSharedMemory);
```

### Python (Client)

```python
from bonk_env import BonkVecEnv

env = BonkVecEnv(
    num_envs=32,      # Number of parallel environments
    port=5555,       # ZeroMQ port
    config={
        'frame_skip': 1,
        'num_opponents': 1,
        'max_ticks': 900,
        'random_opponent': True,
    }
)
```

## Restrictions

| Type | Options |
|:-----|:--------|
| Chat | maxChatMessageLength: 300 |
| Username | noDuplicates, noEmptyNames, maxLength: 32 |
| Level | minLevel, maxLevel, onlyAllowNumbers |
| Rate Limits | joining, chatting, readying, changingTeams |

## Running Tests

The test suite is integrated into npm scripts:

```bash
# Run all tests (default)
npm test

# Interactive runner with menu
npm run test:runner

# List available tests
npm run test:list

# Individual test categories
npm run test:physics    # Physics engine
npm run test:prng       # PRNG
npm run test:env        # Environment
npm run test:frameskip  # Frame skip
npm run test:shared     # Shared memory
npm run test:shutdown   # Shutdown handlers
npm run test:telemetry  # Telemetry
npm run test:manager    # Env manager
```

## Python Requirements

```
pyzmq>=25.0.0
gymnasium>=0.29.0
numpy>=1.24.0
stable-baselines3>=2.0.0
```

Optional (visualization): pandas, matplotlib, pillow

## Environment Variables

| Variable | Default | Description |
|:---------|:--------|:------------|
| PORT | 5555 | IPC bridge port |
| MANIFOLD_TELEMETRY | false | Enable telemetry |
| MANIFOLD_PROFILE | standard | Profile level |

## Telemetry

For CLI flags and environment variables, see [Telemetry](./telemetry.md).

## See Also

- [Telemetry](./telemetry.md) - Full telemetry documentation
- [Physics Constants](./typescript/src/core/physics-engine.md)
