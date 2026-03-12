# Flags Module

## Overview

The `flags` module provides CLI flag-based telemetry configuration for the Manifold Server.

## Module: `src.telemetry.flags`

**Source File**: `src/telemetry/flags.ts`

---

## API Outline

### Constants

| Flag | Alias | Description | Default |
|:-----|:------|:------------|:--------|
| `--telemetry` | `-t` | Enable telemetry | `false` |
| `--profile` | `-p` | Profile level | `standard` |
| `--debug` | `-d` | Debug level | `none` |
| `--output` | `-o` | Output format | `console` |
| `--dashboard-port` | - | Dashboard HTTP port | `3001` |
| `--report-interval` | - | Report interval (ms) | `5000` |
| `--retention` | - | Data retention (days) | `7` |

### Profile Levels

| Level | Description |
|:------|:------------|
| `minimal` | Basic timing - minimal overhead |
| `standard` | Per-worker statistics - recommended |
| `detailed` | Full debug information |

### Debug Levels

| Level | Description |
|:------|:------------|
| `none` | No debug output |
| `error` | Errors and warnings |
| `verbose` | Full debug output |

### Output Formats

| Format | Description |
|:-------|:------------|
| `console` | Print to console |
| `file` | Write to file |
| `both` | Console and file |

---

### Environment Variables

| Variable | Values | Description |
|:---------|:-------|:------------|
| `MANIFOLD_TELEMETRY` | `true`, `false` | Enable/disable |
| `MANIFOLD_PROFILE` | `minimal`, `standard`, `detailed` | Profile level |
| `MANIFOLD_DEBUG` | `none`, `error`, `verbose` | Debug level |
| `MANIFOLD_TELEMETRY_OUTPUT` | `console`, `file`, `both` | Output format |

---

### Precedence Order

1. Environment variables (highest)
2. CLI flags
3. Config file
4. Defaults (lowest)

---

### Usage Examples

```bash
# Basic usage
npx tsx src/main.ts --telemetry

# Standard profile with file output
npx tsx src/main.ts -t --profile standard --output file

# Detailed profiling
npx tsx src/main.ts -t --profile detailed --debug verbose

# Environment variables
export MANIFOLD_TELEMETRY=true
export MANIFOLD_PROFILE=standard
npx tsx src/main.ts
```

---

### See Also

- [Telemetry Controller](telemetry-controller.md) - Telemetry management
- [Profiler](profiler.md) - Performance profiling
