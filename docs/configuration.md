# Configuration Guide

## Overview

This document describes the configuration options available in the Manifold Server project.

## Configuration File

**Location**: `config.ts`

---

## Server Configuration

### Basic Settings

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `port` | `number` | `5555` | IPC bridge port (ZeroMQ) |
| `useHttps` | `boolean` | `false` | Enable HTTPS |
| `roomNameOnStartup` | `string` | `"Manifold Server"` | Default room name |
| `roomPasswordOnStartup` | `string` | `null` | Room password (null = none) |
| `maxPlayers` | `number` | `12` | Maximum players |
| `autoAssignHost` | `boolean` | `true` | Auto-assign host |
| `timeStampFormat` | `string` | `"YYYY-MM-DD hh:mm:ss UTCZ"` | Chat log timestamp format |

### Default Game Settings

```typescript
defaultGameSettings: {
  map: 'encoded_map_string',
  gt: 2,           // Game time (minutes)
  wl: 3,           // Win limit
  q: false,        // Quick play
  tl: false,       // Team lock
  tea: false,      // Auto-teams
  ga: 'b',         // Game area
  mo: 'b',         // Mode
  bal: []          // Balancers
}
```

---

## Telemetry Configuration

### Options

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `enabled` | `boolean` | `false` | Enable telemetry |
| `outputFormat` | `'console' \| 'file' \| 'both'` | `'console'` | Output destination |
| `retentionDays` | `number` | `7` | Data retention in days |
| `dashboardPort` | `number` | `3001` | Dashboard HTTP port |
| `reportInterval` | `number` | `5000` | Report interval (ticks) |

### Deprecated Options

| Option | Status | Replacement |
|:-------|:-------|:-----------|
| `verboseTelemetry` | **Deprecated** | Use CLI flag `--telemetry` |

---

## Restrictions Configuration

### Chat Settings

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `maxChatMessageLength` | `number` | `300` | Max message length |

### Username Restrictions

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `noDuplicates` | `boolean` | `true` | Prevent duplicate names |
| `noEmptyNames` | `boolean` | `true` | Prevent empty names |
| `maxLength` | `number` | `32` | Max username length |
| `disallowRegex` | `RegExp` | `/[^A-Za-z0-9_ ]/` | Forbidden characters |

### Level Restrictions

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `minLevel` | `number` | `0` | Minimum level |
| `maxLevel` | `number` | `999` | Maximum level |
| `onlyAllowNumbers` | `boolean` | `true` | Numbers only |
| `censorLevels` | `boolean` | `false` | Hide levels |

### Rate Limits

| Limit | Amount | Timeframe | Restore |
|:------|:-------|:----------|:--------|
| `joining` | 5 | 10s | 60s |
| `chatting` | 7 | 10s | 10s |
| `readying` | 20 | 5s | 30s |
| `changingTeams` | 4 | 0.5s | 1s |
| `changingMode` | 2 | 1s | 1s |
| `changingMap` | 2 | 2s | 2s |
| `startGameCountdown` | 5 | 1s | 2s |
| `startingEndingGame` | 10 | 5s | 5s |
| `transferringHost` | 5 | 10s | 60s |

---

## Environment Variables

### Telemetry

| Variable | Values | Description |
|:---------|:-------|:------------|
| `MANIFOLD_TELEMETRY` | `true`, `false` | Enable telemetry |
| `MANIFOLD_PROFILE` | `minimal`, `standard`, `detailed` | Profile level |
| `MANIFOLD_DEBUG` | `none`, `error`, `verbose` | Debug level |
| `MANIFOLD_TELEMETRY_OUTPUT` | `console`, `file`, `both` | Output format |

---

## CLI Flags

### Telemetry Flags

| Flag | Alias | Description | Default |
|:-----|:------|:------------|:--------|
| `--telemetry` | `-t` | Enable telemetry | `false` |
| `--profile` | `-p` | Profile level | `standard` |
| `--debug` | `-d` | Debug level | `none` |
| `--output` | `-o` | Output format | `console` |
| `--dashboard-port` | - | Dashboard port | `3001` |
| `--report-interval` | - | Report interval | `5000` |
| `--retention` | - | Retention days | `7` |

---

## Python Environment Configuration

### Requirements

```
pyzmq>=25.0.0
gymnasium>=0.29.0
numpy>=1.24.0
```

### Optional Dependencies

For visualization:
```
pandas
matplotlib
pillow
```

For training:
```
stable-baselines3
torch
```

---

## Setup Instructions

### Node.js Setup

```bash
# Install dependencies
npm install
npm install zeromq@6

# Start the server
npx tsx src/main.ts

# Start with telemetry
npx tsx src/main.ts --telemetry --profile detailed
```

### Python Setup

```bash
# Install dependencies
pip install -r requirements.txt

# Test connection
python python/tests/test_env.py

# Run benchmark
python python/benchmarks/benchmark.py
```

---

## Project-Specific Notes

### Port Configuration

- **Default ZMQ port**: `5555` (for Python communication)
- **Default HTTP port**: `3000` (for telemetry dashboard)
- **Telemetry dashboard port**: `3001`

### Worker Configuration

- Default workers: CPU core count (max 8)
- Override: Pass `numWorkers` to `WorkerPool` constructor

### Map Configuration

Maps are loaded from JSON files in the `maps/` directory.

---

### See Also

- [Telemetry System](./telemetry.md) - Detailed telemetry documentation
- [Flags](./flags.md) - CLI flag reference
- [Telemetry Flags](./typescript/src/telemetry/flags.md) - CLI flag reference
