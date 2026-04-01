# Telemetry System

## Overview

The Manifold Server includes a comprehensive telemetry system for monitoring performance, debugging issues, and analyzing simulation behavior. The system is designed with a **zero-overhead default** - telemetry is disabled by default and only activates when explicitly enabled.

---

## Quick Start

```bash
# Enable telemetry with default settings
npx tsx src/main.ts --telemetry

# Enable with standard profiling
npx tsx src/main.ts -t --profile standard

# Enable with detailed debug output
npx tsx src/main.ts -t --profile detailed --debug verbose
```

---

## Flag-Based Activation

### CLI Flags

| Flag | Alias | Description | Default |
|:-----|:------|:------------|:--------|
| `--telemetry` | `-t` | Master switch to enable telemetry | `false` |
| `--profile` | `-p` | Profiling detail level | `standard` |
| `--debug` | `-d` | Debug output level | `none` |
| `--output` | `-o` | Output format | `console` |
| `--dashboard-port` | — | HTTP port for telemetry dashboard | `3001` |
| `--report-interval` | — | Milliseconds between telemetry reports | `5000` |
| `--retention` | — | Days to retain telemetry data files | `7` |

### Profile Levels

| Level | Overhead | Use Case |
|:------|:---------|:---------|
| `minimal` | <1% | Basic timing information only |
| `standard` | 2-5% | Per-worker statistics (recommended) |
| `detailed` | 5-15% | Full debug information |

### Debug Levels

| Level | Description |
|:------|:------------|
| `none` | No debug output |
| `error` | Errors and warnings only |
| `verbose` | Full debug output |

### Output Formats

| Format | Description |
|:-------|:------------|
| `console` | Print to stdout |
| `file` | Write to JSONL files |
| `both` | Console and file |

---

## Environment Variables

### Supported Variables

| Variable | Values | Description |
|:---------|:-------|:------------|
| `MANIFOLD_TELEMETRY` | `true`, `false`, `1`, `0`, `yes`, `no` | Enable/disable telemetry |
| `MANIFOLD_TELEMETRY_OUTPUT` | `console`, `file`, `both` | Output format |
| `MANIFOLD_PROFILE` | `minimal`, `standard`, `detailed` | Profile level |
| `MANIFOLD_DEBUG` | `none`, `error`, `verbose` | Debug level |

### Precedence Order

1. Environment variables (highest)
2. CLI flags
3. Config file settings
4. Default values (lowest)

---

## Usage Examples

### Basic Usage

```bash
# Enable telemetry with default settings
npx tsx src/main.ts --telemetry

# Short flag form
npx tsx src/main.ts -t
```

### Production Monitoring

```bash
# Enable with standard profiling, output to file
npx tsx src/main.ts -t --profile standard --output file

# With custom dashboard port
npx tsx src/main.ts -t --dashboard-port 8080

# Less frequent reports for high-throughput scenarios
npx tsx src/main.ts -t --report-interval 10000
```

### Debugging Issues

```bash
# Enable verbose debug output
npx tsx src/main.ts -t --debug verbose

# Detailed profiling with console output
npx tsx src/main.ts -t --profile detailed --output console

# Both console and file for comprehensive debugging
npx tsx src/main.ts -t --profile detailed --debug verbose --output both
```

### Environment Variable Usage

```bash
# Enable via environment variable (useful for containers)
export MANIFOLD_TELEMETRY=true
export MANIFOLD_PROFILE=standard
npx tsx src/main.ts

# Docker example
docker run -e MANIFOLD_TELEMETRY=true -e MANIFOLD_DEBUG=error manifold-server
```

---

## Performance Characteristics

| Profile Level | Overhead | Use Case |
|:-------------|:---------|:----------|
| Disabled | **0%** | Production, maximum performance |
| `minimal` | <1% | Lightweight monitoring |
| `standard` | 2-5% | Production monitoring, troubleshooting |
| `detailed` | 5-15% | Debugging, development |

### Zero-Overhead Default

When `--telemetry` is not specified:
- No telemetry objects are allocated
- No timing hooks are installed
- No IPC messages are sent for metrics
- The simulation runs at full native speed

### Performance Tips

1. **Use `minimal` profile** for production monitoring with minimal impact
2. **Increase `--report-interval`** to 10000+ ms for high-throughput workloads
3. **Use file output** (`--output file`) for detailed profiling to avoid console I/O overhead
4. **Disable debug** (`--debug none`) in production to eliminate debug string generation

---

## Backward Compatibility

The telemetry system is fully backward compatible:

- **Default behavior unchanged**: Telemetry is opt-in; existing deployments continue to work without modification
- **Graceful degradation**: Invalid flag values fall back to defaults with a warning
- **No breaking changes**: All existing CLI arguments and environment variables continue to work

---

## Configuration File (Legacy)

While CLI flags are recommended, you can also configure telemetry in `config.ts`:

```typescript
const config = {
  telemetry: {
    enabled: false,       // Default off
    outputFormat: 'console',
    retentionDays: 7,
    dashboardPort: 3001,
    reportInterval: 5000,
  }
};
```

---

## Dashboard

When enabled, a telemetry dashboard is available at `http://localhost:3001` (or custom port).

Features:
- Real-time performance metrics
- Worker statistics
- Memory usage
- Tick rate monitoring

---

## Profiling Metrics

### Physics Metrics

| Metric | Type | Description |
|:-------|:-----|:------------|
| `PHYSICS_TICK` | timing | Physics simulation time |
| `RAYCAST_CALL` | timing | Grapple raycast time |
| `COLLISION_RESOLVE` | timing | Collision detection time |

### System Metrics

| Metric | Type | Description |
|:-------|:-----|:------------|
| `JSON_PARSE` | timing | JSON parsing time |
| `ZMQ_SEND` | timing | ZeroMQ send time |
| `active_joints` | gauge | Active grapple joints |

### Counters

| Counter | Description |
|:--------|:------------|
| `collision_events` | Total collision events |
| `collision_lethal` | Lethal collisions |
| `death_out_of_bounds` | Out of bounds deaths |
| `grapple_fire` | Grapple fires |

---

### See Also

- [Flags Reference](./typescript/src/telemetry/flags.md) - CLI flag documentation
- [Profiler](./typescript/src/telemetry/profiler.md) - Profiling internals
- [Configuration](./configuration.md) - Configuration options
