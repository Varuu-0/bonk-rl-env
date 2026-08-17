# .githooks

Custom Git hooks for DSP (Data Structure Protocol) maintenance and local CI/CD quality enforcement.

| File | Description |
|------|-------------|
| `pre-commit` | DSP consistency checks, then Tier 1 local CI (staged-file prettier, webscript IDs, ruff, `tsc --noEmit`, unit tests) |
| `pre-push` | Full DSP graph integrity check, then Tier 2 local CI (full prettier vs origin/main, all Vitest suites, pytest, typecheck) |
| `dsp-agent-review.ps1` | PowerShell script to generate DSP review context for agent-assisted review |
| `dsp-agent-review.sh` | Bash script to generate DSP review context for agent-assisted review |
| `dsp-check-staged.ps1` | PowerShell script to check staged files against the DSP graph |
| `dsp-check-staged.sh` | Bash script to check staged files against the DSP graph |
| `install-hooks.ps1` | PowerShell installer to copy hooks into `.git/hooks/` |
| `install-hooks.sh` | Bash installer to copy hooks into `.git/hooks/` |

## Installation

### Bash / macOS / Linux

```bash
./.githooks/install-hooks.sh
```

### PowerShell / Windows

```powershell
.\.githooks\install-hooks.ps1
```

## Configuration

Hooks are controlled via environment variables:

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `DSP_PRECOMMIT_MODE` | `warn`, `block` | `warn` | Whether pre-commit should block on DSP errors |
| `DSP_SKIP_PATTERNS` | glob patterns | `*.md,*.txt,*.json,...` | File patterns to skip in DSP checks |
| `LOCAL_CI_SKIP` | `0`, `1` | `0` | Set to `1` to skip the local CI tiers entirely |

Both hooks can also be bypassed per-invocation with `git commit --no-verify` / `git push --no-verify`.
