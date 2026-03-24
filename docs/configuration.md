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
  mo: 'b'  // Mode
}
```

## Restrictions

| Type | Options |
|:-----|:--------|
| Chat | maxChatMessageLength: 300 |
| Username | noDuplicates, noEmptyNames, maxLength: 32 |
| Level | minLevel, maxLevel, onlyAllowNumbers |
| Rate Limits | joining, chatting, readying, changingTeams |

## Python Requirements

```
pyzmq>=25.0.0
gymnasium>=0.29.0
numpy>=1.24.0
```

Optional (visualization): pandas, matplotlib, pillow

## Telemetry

For CLI flags and environment variables, see [Telemetry](./telemetry.md).

## See Also
- [Telemetry](./telemetry.md) - Full telemetry documentation
- [Physics Constants](./typescript/src/core/physics-engine.md)
